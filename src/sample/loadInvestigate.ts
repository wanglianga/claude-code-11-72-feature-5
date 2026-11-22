/**
 * 调查资料包装载：从 /sample/investigate 拉取 CSV，浏览器内校验 SHA-256，
 * 读数/状态并入主数据集，登记簿记录写入 invRegistry（保留全部版本）。
 * 自报更正批次与拓扑修订单独提供导入入口，触发旧版本撤销与旧评分撤销。
 */

import { sha256Hex } from './csv';
import { mergeDataset, parseReadings, parseStates } from './ingest';
import {
  applyCorrection,
  applyTopologyRevision,
  emptyRegistry,
  parseEventProfiles,
  parsePumpSwitches,
  parseRainfall,
  parseSelfReports,
  parseSources,
} from '../investigate/registry';
import type { Dataset, IntakeFile } from '../domain/types';
import type { InvestigationRegistry, InvestigateManifest } from '../investigate/types';
import { putBatch, putReadingsInChunks, putRegistryRecords, registryToRecords, setMeta, INVESTIGATE_KEY } from '../db/db';
import type { LoadProgress } from './loadSample';

export async function fetchInvestigateManifest(): Promise<InvestigateManifest> {
  const res = await fetch('/sample/investigate/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取调查资料包清单（HTTP ${res.status}）`);
  return (await res.json()) as InvestigateManifest;
}

async function fetchText(fileName: string): Promise<{ text: string; size: number }> {
  const res = await fetch(`/sample/investigate/${encodeURIComponent(fileName)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取 ${fileName}（HTTP ${res.status}）`);
  const text = await res.text();
  return { text, size: new TextEncoder().encode(text).byteLength };
}

export interface LoadedInvestigate {
  dataset: Dataset;
  registry: InvestigationRegistry;
  manifest: InvestigateManifest;
  fingerprintMatches: { fileName: string; expected: string; actual: string; ok: boolean }[];
  warnings: string[];
}

function intakeOf(meta: InvestigateManifest['baseFiles'][number], sha: string, size: number, ingestedBy: string, extra?: { accepted?: number; rejected?: number; reasons?: string[] }): IntakeFile {
  return {
    fileId: `file:investigate/${meta.fileName}:${sha.slice(0, 16)}`,
    fileName: `investigate/${meta.fileName}`,
    sha256: sha,
    sizeBytes: size,
    kind: meta.kind,
    receivedAt: Date.parse(meta.receivedAt),
    rowCount: meta.rowCount,
    acceptedRows: extra?.accepted ?? meta.rowCount,
    rejectedRows: extra?.rejected ?? 0,
    rejectedReasons: extra?.reasons ?? [],
    note: meta.note,
    ingestedAt: Date.now(),
    ingestedBy,
    sample: true,
  };
}

/** 装载调查资料包基础文件（不含自报更正与拓扑修订，二者单独导入） */
export async function loadInvestigatePack(
  base: Dataset,
  onProgress: (p: LoadProgress) => void,
  ingestedBy = '调查员',
): Promise<LoadedInvestigate> {
  const manifest = await fetchInvestigateManifest();
  const warnings: string[] = [];
  const fingerprintMatches: LoadedInvestigate['fingerprintMatches'] = [];
  let dataset = base;
  let registry = emptyRegistry();
  const total = manifest.baseFiles.length + 1;
  let done = 0;

  const files: IntakeFile[] = [];
  const newStates: Dataset['states'] = [];
  for (const meta of manifest.baseFiles) {
    onProgress({ step: `读取 ${meta.fileName}`, done, total });
    const { text, size } = await fetchText(meta.fileName);
    const sha = await sha256Hex(text);
    const ok = sha === meta.sha256;
    fingerprintMatches.push({ fileName: meta.fileName, expected: meta.sha256, actual: sha, ok });
    if (!ok) warnings.push(`${meta.fileName} 指纹与清单不一致`);
    const fileId = `file:investigate/${meta.fileName}:${sha.slice(0, 16)}`;

    if (meta.kind === 'READINGS') {
      const parsed = parseReadings(text, { fileId, kind: 'READINGS', receivedAt: Date.parse(meta.receivedAt) }, dataset.instruments, dataset.bindings);
      dataset = mergeDataset(dataset, { readings: parsed.readings });
      files.push(intakeOf(meta, sha, size, ingestedBy, { accepted: parsed.readings.length, rejected: parsed.rejected, reasons: parsed.errors.slice(0, 20) }));
      await putReadingsInChunks(parsed.readings);
    } else if (meta.kind === 'STATE_LOG') {
      const parsed = parseStates(text);
      dataset = mergeDataset(dataset, { states: parsed.states });
      newStates.push(...parsed.states);
      files.push(intakeOf(meta, sha, size, ingestedBy, { reasons: parsed.errors }));
    } else {
      files.push(intakeOf(meta, sha, size, ingestedBy));
      if (meta.kind === 'SOURCE_REGISTRY') {
        const parsed = parseSources(text);
        registry = { ...registry, sources: [...registry.sources, ...parsed.sources] };
        if (parsed.errors.length > 0) warnings.push(...parsed.errors);
      } else if (meta.kind === 'RAINFALL') {
        const parsed = parseRainfall(text);
        registry = { ...registry, rainfall: [...registry.rainfall, ...parsed.rainfall] };
        if (parsed.errors.length > 0) warnings.push(...parsed.errors);
      } else if (meta.kind === 'PUMP_SWITCH') {
        const parsed = parsePumpSwitches(text);
        registry = { ...registry, pumpSwitches: [...registry.pumpSwitches, ...parsed.pumpSwitches] };
        if (parsed.errors.length > 0) warnings.push(...parsed.errors);
      } else if (meta.kind === 'SELF_REPORT') {
        const parsed = parseSelfReports(text);
        registry = { ...registry, selfReports: [...registry.selfReports, ...parsed.selfReports] };
        if (parsed.errors.length > 0) warnings.push(...parsed.errors);
      } else if (meta.kind === 'EVENT_PROFILE') {
        const parsed = parseEventProfiles(text);
        registry = { ...registry, eventProfiles: [...registry.eventProfiles, ...parsed.eventProfiles] };
        if (parsed.errors.length > 0) warnings.push(...parsed.errors);
      }
    }
    done += 1;
  }

  onProgress({ step: '写入本地库', done, total });
  dataset = mergeDataset(dataset, { files });
  await putBatch({ files, states: newStates });
  await putRegistryRecords(registryToRecords(registry));
  await setMeta(INVESTIGATE_KEY, true);
  onProgress({ step: '完成', done: total, total });
  return { dataset, registry, manifest, fingerprintMatches, warnings };
}

export interface CorrectionResult {
  registry: InvestigationRegistry;
  revokedIds: string[];
  fingerprint: { expected: string; actual: string; ok: boolean };
  file: IntakeFile;
}

/** 导入自报更正批次：撤销其取代的旧批次（按版本撤销旧评分由调用方继续处理） */
export async function importSelfReportCorrection(
  current: InvestigationRegistry,
  ingestedBy = '调查员',
): Promise<CorrectionResult> {
  const manifest = await fetchInvestigateManifest();
  const meta = manifest.correctionFile;
  const { text, size } = await fetchText(meta.fileName);
  const sha = await sha256Hex(text);
  const parsed = parseSelfReports(text);
  if (parsed.selfReports.length === 0) throw new Error('更正批次为空或解析失败');
  const batch = parsed.selfReports[0];
  const { registry, revokedIds } = applyCorrection(current, batch);
  await putRegistryRecords(registryToRecords({ ...emptyRegistry(), selfReports: [batch, ...registry.selfReports.filter((b) => revokedIds.includes(b.recordId))] }));
  const file = intakeOf(meta, sha, size, ingestedBy);
  await putBatch({ files: [file] });
  return { registry, revokedIds, fingerprint: { expected: meta.sha256, actual: sha, ok: sha === meta.sha256 }, file };
}

export interface TopologyResult {
  registry: InvestigationRegistry;
  revokedIds: string[];
  fingerprint: { expected: string; actual: string; ok: boolean };
  file: IntakeFile;
}

/** 导入拓扑修订：撤销被取代的来源版本（已关闭调查不改写，由调用方保证） */
export async function importTopologyRevision(
  current: InvestigationRegistry,
  ingestedBy = '调查员',
): Promise<TopologyResult> {
  const manifest = await fetchInvestigateManifest();
  const meta = manifest.topologyFile;
  const { text, size } = await fetchText(meta.fileName);
  const sha = await sha256Hex(text);
  const parsed = parseSources(text);
  if (parsed.sources.length === 0) throw new Error('拓扑修订为空或解析失败');
  const { registry, revokedIds } = applyTopologyRevision(current, parsed.sources);
  await putRegistryRecords(
    registryToRecords({
      ...emptyRegistry(),
      sources: [...parsed.sources, ...registry.sources.filter((s) => revokedIds.includes(s.recordId))],
    }),
  );
  const file = intakeOf(meta, sha, size, ingestedBy);
  await putBatch({ files: [file] });
  return { registry, revokedIds, fingerprint: { expected: meta.sha256, actual: sha, ok: sha === meta.sha256 }, file };
}
