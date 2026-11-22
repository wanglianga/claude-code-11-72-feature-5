/**
 * Node 侧调查资料包装载：直接读 CSV 并复用浏览器同一套解析器
 * （src/sample/ingest.ts 与 src/investigate/registry.ts），
 * 确保“脚本核验”和“界面导入”走同一条解析路径。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeDataset, parseReadings, parseStates } from '../src/sample/ingest';
import {
  emptyRegistry,
  parseEventProfiles,
  parsePumpSwitches,
  parseRainfall,
  parseSelfReports,
  parseSources,
} from '../src/investigate/registry';
import type { Binding, Dataset, Instrument } from '../src/domain/types';
import type { InvestigationRegistry, InvestigateManifest } from '../src/investigate/types';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface InvestigatePack {
  datasetPatch: Pick<Dataset, 'readings' | 'states' | 'files'>;
  registry: InvestigationRegistry;
  correction: InvestigationRegistry['selfReports'];
  topology: InvestigationRegistry['sources'];
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
  errors: string[];
}

/** 读数解析依赖基础样例的仪表台账与绑定，由调用方传入（与浏览器装载顺序一致） */
export function parseInvestigatePack(
  dir: string,
  manifest: InvestigateManifest,
  base: { instruments: Instrument[]; bindings: Binding[] },
): InvestigatePack {
  const fingerprints: InvestigatePack['fingerprints'] = [];
  const errors: string[] = [];
  let dataset: Dataset = {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
  };
  let registry = emptyRegistry();
  let correction: InvestigatePack['correction'] = [];
  let topology: InvestigatePack['topology'] = [];

  const readEntry = (meta: InvestigateManifest['baseFiles'][number]) => {
    const text = readFileSync(resolve(dir, meta.fileName), 'utf8');
    const actual = sha256File(resolve(dir, meta.fileName));
    fingerprints.push({ fileName: meta.fileName, expected: meta.sha256, actual, ok: actual === meta.sha256 });
    return { text, fileId: `file:investigate/${meta.fileName}:${actual.slice(0, 16)}`, receivedAt: Date.parse(meta.receivedAt) };
  };

  for (const meta of manifest.baseFiles) {
    const { text, fileId, receivedAt } = readEntry(meta);
    if (meta.kind === 'READINGS') {
      const parsed = parseReadings(text, { fileId, kind: 'READINGS', receivedAt }, base.instruments, base.bindings);
      dataset = mergeDataset(dataset, { readings: parsed.readings });
      errors.push(...parsed.errors);
    } else if (meta.kind === 'STATE_LOG') {
      const parsed = parseStates(text);
      dataset = mergeDataset(dataset, { states: parsed.states });
      errors.push(...parsed.errors);
    } else if (meta.kind === 'SOURCE_REGISTRY') {
      const parsed = parseSources(text);
      registry = { ...registry, sources: [...registry.sources, ...parsed.sources] };
      errors.push(...parsed.errors);
    } else if (meta.kind === 'RAINFALL') {
      const parsed = parseRainfall(text);
      registry = { ...registry, rainfall: [...registry.rainfall, ...parsed.rainfall] };
      errors.push(...parsed.errors);
    } else if (meta.kind === 'PUMP_SWITCH') {
      const parsed = parsePumpSwitches(text);
      registry = { ...registry, pumpSwitches: [...registry.pumpSwitches, ...parsed.pumpSwitches] };
      errors.push(...parsed.errors);
    } else if (meta.kind === 'SELF_REPORT') {
      const parsed = parseSelfReports(text);
      registry = { ...registry, selfReports: [...registry.selfReports, ...parsed.selfReports] };
      errors.push(...parsed.errors);
    } else if (meta.kind === 'EVENT_PROFILE') {
      const parsed = parseEventProfiles(text);
      registry = { ...registry, eventProfiles: [...registry.eventProfiles, ...parsed.eventProfiles] };
      errors.push(...parsed.errors);
    }
  }

  {
    const { text } = readEntry(manifest.correctionFile);
    const parsed = parseSelfReports(text);
    correction = parsed.selfReports;
    errors.push(...parsed.errors);
  }
  {
    const { text } = readEntry(manifest.topologyFile);
    const parsed = parseSources(text);
    topology = parsed.sources;
    errors.push(...parsed.errors);
  }

  return {
    datasetPatch: { readings: dataset.readings, states: dataset.states, files: dataset.files },
    registry,
    correction,
    topology,
    fingerprints,
    errors,
  };
}
