/**
 * IndexedDB 本地库（离线分析台）
 *
 * 对象仓库：
 *  meta        键值：schema 版本、样例导入标记、上次打开的点位/日期
 *  intake      接入账（文件指纹、行数、接收时刻、接受/拒绝）
 *  plants / points / instruments / calibrations / states / bindings
 *  readings    原始与对齐后的读数（按 pointCode + dayKey 建索引）
 *  declarations 已出具申报版本（FILED，不可改写）
 *  recalc       重算候选（只引用锁定来源窗口）
 *  audits      操作审计
 */

import { openDB, IDBPDatabase, DBSchema } from 'idb';
import type {
  Binding,
  Calibration,
  Declaration,
  Instrument,
  IntakeFile,
  OutfallPoint,
  Plant,
  Reading,
  RecalcCandidate,
  StatePeriod,
} from '../domain/types';
import type {
  CandidateAssessment,
  Delivery,
  Investigation,
  InvestigationRegistry,
  OutfallEvent,
} from '../investigate/types';

export interface AuditEntry {
  auditId: string;
  at: number;
  actor: string;
  action: string;
  detail: string;
  refIds: string[];
}

/** 登记簿记录包装：kind 区分记录类型，recordId 含版本（如 SRC-B@v1、SR-A-v2） */
export interface RegistryRecordWrapper {
  recordId: string;
  kind: 'SOURCE' | 'RAINFALL' | 'PUMP_SWITCH' | 'SELF_REPORT' | 'EVENT_PROFILE';
  record: unknown;
}

interface StoreSchema extends DBSchema {
  meta: { key: string; value: unknown };
  intake: { key: string; value: IntakeFile; indexes: { 'by-kind': FileKind } };
  plants: { key: string; value: Plant };
  points: { key: string; value: OutfallPoint; indexes: { 'by-plant': string } };
  instruments: { key: string; value: Instrument; indexes: { 'by-point': string } };
  calibrations: { key: string; value: Calibration; indexes: { 'by-instrument': string } };
  states: { key: string; value: StatePeriod; indexes: { 'by-instrument': string } };
  bindings: { key: string; value: Binding; indexes: { 'by-point': string } };
  readings: {
    key: string;
    value: Reading;
    indexes: { 'by-point-day': string; 'by-instrument': string; 'by-file': string };
  };
  declarations: { key: string; value: Declaration; indexes: { 'by-point-day': string } };
  recalc: { key: string; value: RecalcCandidate; indexes: { 'by-declaration': string; 'by-point-day': string } };
  audits: { key: string; value: AuditEntry };
  invRegistry: { key: string; value: RegistryRecordWrapper; indexes: { 'by-kind': string } };
  invEvents: { key: string; value: OutfallEvent };
  invCandidates: { key: string; value: CandidateAssessment; indexes: { 'by-event': string } };
  invInvestigations: { key: string; value: Investigation; indexes: { 'by-event': string } };
  invDeliveries: { key: string; value: Delivery; indexes: { 'by-event': string } };
}

type FileKind = IntakeFile['kind'];

export const DB_NAME = 'outfall-review';
export const DB_VERSION = 2;
export const SCHEMA_KEY = 'schemaVersion';
export const SAMPLE_KEY = 'sampleImported';
export const INVESTIGATE_KEY = 'investigateImported';

export type ReviewDB = IDBPDatabase<StoreSchema>;

let dbPromise: Promise<ReviewDB> | null = null;

export function getDb(): Promise<ReviewDB> {
  if (!dbPromise) {
    dbPromise = openDB<StoreSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('meta');
          const intake = db.createObjectStore('intake', { keyPath: 'fileId' });
          intake.createIndex('by-kind', 'kind');
          db.createObjectStore('plants', { keyPath: 'plantId' });
          const points = db.createObjectStore('points', { keyPath: 'pointCode' });
          points.createIndex('by-plant', 'plantId');
          const instruments = db.createObjectStore('instruments', { keyPath: 'instrumentId' });
          instruments.createIndex('by-point', 'pointCode');
          const calibrations = db.createObjectStore('calibrations', { keyPath: 'calibrationId' });
          calibrations.createIndex('by-instrument', 'instrumentId');
          const states = db.createObjectStore('states', { keyPath: 'stateId' });
          states.createIndex('by-instrument', 'instrumentId');
          const bindings = db.createObjectStore('bindings', { keyPath: 'bindingId' });
          bindings.createIndex('by-point', 'pointCode');
          const readings = db.createObjectStore('readings', { keyPath: 'readingId' });
          readings.createIndex('by-point-day', 'dayKey');
          readings.createIndex('by-instrument', 'instrumentId');
          readings.createIndex('by-file', 'sourceFileId');
          const declarations = db.createObjectStore('declarations', { keyPath: 'declarationId' });
          declarations.createIndex('by-point-day', 'day');
          const recalc = db.createObjectStore('recalc', { keyPath: 'candidateId' });
          recalc.createIndex('by-declaration', 'declarationId');
          recalc.createIndex('by-point-day', 'day');
          db.createObjectStore('audits', { keyPath: 'auditId' });
        }
        if (oldVersion < 2) {
          // 事件调查：登记簿（版本化）、事件、候选评估、处置板、交付
          const invRegistry = db.createObjectStore('invRegistry', { keyPath: 'recordId' });
          invRegistry.createIndex('by-kind', 'kind');
          db.createObjectStore('invEvents', { keyPath: 'eventId' });
          const invCandidates = db.createObjectStore('invCandidates', { keyPath: 'candidateId' });
          invCandidates.createIndex('by-event', 'eventId');
          const invInvestigations = db.createObjectStore('invInvestigations', { keyPath: 'investigationId' });
          invInvestigations.createIndex('by-event', 'eventId');
          const invDeliveries = db.createObjectStore('invDeliveries', { keyPath: 'deliveryId' });
          invDeliveries.createIndex('by-event', 'eventId');
        }
      },
      blocked() {
        console.warn('IndexedDB 升级被其他标签页阻塞');
      },
    });
  }
  return dbPromise;
}

export async function isSampleImported(): Promise<boolean> {
  const db = await getDb();
  return Boolean(await db.get('meta', SAMPLE_KEY));
}

export async function markSampleImported(value: boolean): Promise<void> {
  const db = await getDb();
  await db.put('meta', value, SAMPLE_KEY);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('meta', value, key);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get('meta', key)) as T | undefined;
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  const names = [
    'intake',
    'plants',
    'points',
    'instruments',
    'calibrations',
    'states',
    'bindings',
    'readings',
    'declarations',
    'recalc',
    'audits',
    'invRegistry',
    'invEvents',
    'invCandidates',
    'invInvestigations',
    'invDeliveries',
    'meta',
  ] as const;
  const tx = db.transaction(names, 'readwrite');
  await Promise.all(names.map((n) => tx.objectStore(n).clear()));
  await tx.done;
}

/** patch 键名 → IndexedDB 对象仓库名（files 存于 intake） */
const STORE_NAMES: Record<string, string> = {
  files: 'intake',
  plants: 'plants',
  points: 'points',
  instruments: 'instruments',
  calibrations: 'calibrations',
  states: 'states',
  bindings: 'bindings',
  readings: 'readings',
};

export async function putBatch(patch: {
  files?: IntakeFile[];
  plants?: Plant[];
  points?: OutfallPoint[];
  instruments?: Instrument[];
  calibrations?: Calibration[];
  states?: StatePeriod[];
  bindings?: Binding[];
  readings?: Reading[];
}): Promise<void> {
  const db = await getDb();
  const keys = (Object.keys(patch) as (keyof typeof patch)[]).filter(
    (k) => (patch[k] as unknown[] | undefined)?.length,
  );
  if (keys.length === 0) return;
  const stores = [...new Set(keys.map((k) => STORE_NAMES[k as string]))];
  const tx = db.transaction(stores as never, 'readwrite');
  for (const key of keys) {
    const store = STORE_NAMES[key as string];
    const list = patch[key] as unknown[];
    for (const item of list) await tx.objectStore(store as never).put(item as never);
  }
  await tx.done;
}

/** 大文件分批写入，避免长事务阻塞 UI */
export async function putReadingsInChunks(readings: Reading[], chunkSize = 4000): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < readings.length; i += chunkSize) {
    const chunk = readings.slice(i, i + chunkSize);
    const tx = db.transaction('readings', 'readwrite');
    for (const r of chunk) await tx.store.put(r);
    await tx.done;
  }
}

export async function getAllKv(): Promise<{
  plants: Plant[];
  points: OutfallPoint[];
  instruments: Instrument[];
  calibrations: Calibration[];
  states: StatePeriod[];
  bindings: Binding[];
  readings: Reading[];
  files: IntakeFile[];
}> {
  const db = await getDb();
  const [plants, points, instruments, calibrations, states, bindings, readings, files] = await Promise.all([
    db.getAll('plants'),
    db.getAll('points'),
    db.getAll('instruments'),
    db.getAll('calibrations'),
    db.getAll('states'),
    db.getAll('bindings'),
    db.getAll('readings'),
    db.getAll('intake'),
  ]);
  return { plants, points, instruments, calibrations, states, bindings, readings, files };
}

export async function addAudit(entry: Omit<AuditEntry, 'auditId'>): Promise<AuditEntry> {
  const db = await getDb();
  const auditId = `audit-${entry.at}-${Math.random().toString(36).slice(2, 8)}`;
  const full: AuditEntry = { ...entry, auditId };
  await db.put('audits', full);
  return full;
}

export async function listAudits(limit = 200): Promise<AuditEntry[]> {
  const db = await getDb();
  const all = await db.getAll('audits');
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function listDeclarations(): Promise<Declaration[]> {
  const db = await getDb();
  const all = await db.getAll('declarations');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** 申报版本只能新建；若同日同点位已有 FILED 版本，返回已有版本供对比而不覆盖 */
export async function fileDeclaration(declaration: Declaration): Promise<{ existing: Declaration | null }> {
  const db = await getDb();
  const all = await db.getAll('declarations');
  const existing = all.find((d) => d.pointCode === declaration.pointCode && d.day === declaration.day) ?? null;
  const tx = db.transaction(['declarations', 'audits'], 'readwrite');
  if (!existing) {
    await tx.objectStore('declarations').add(declaration);
  }
  await tx.objectStore('audits').put({
    auditId: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    actor: declaration.createdBy,
    action: existing ? 'FILE_ATTEMPT_DUPLICATE' : 'FILE_DECLARATION',
    detail: existing
      ? `已存在 ${declaration.pointCode} ${declaration.day} 的申报版本 ${existing.declarationId}，未覆盖，改为人工比对`
      : `出具 ${declaration.pointCode} ${declaration.day} 申报版本 ${declaration.declarationId}`,
    refIds: [declaration.declarationId],
  });
  await tx.done;
  return { existing };
}

export async function listRecalcCandidates(): Promise<RecalcCandidate[]> {
  const db = await getDb();
  const all = await db.getAll('recalc');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveRecalcCandidate(candidate: RecalcCandidate): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['recalc', 'audits'], 'readwrite');
  const existing = await tx.objectStore('recalc').get(candidate.candidateId);
  await tx.objectStore('recalc').put(candidate);
  await tx.objectStore('audits').put({
    auditId: `audit-${candidate.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    at: candidate.createdAt,
    actor: candidate.createdBy,
    action: existing ? 'RECALC_REVIEWED' : 'RECALC_CREATED',
    detail: `${candidate.pointCode} ${candidate.day}：${candidate.autoDetected ? '自动检出迟到读数' : '人工复核'}，候选 ${candidate.candidateId}`,
    refIds: [candidate.declarationId, candidate.candidateId],
  });
  await tx.done;
}

export async function getDeclaration(declarationId: string): Promise<Declaration | undefined> {
  const db = await getDb();
  return db.get('declarations', declarationId);
}

export async function readingsForDayFromDb(pointCode: string, day: string): Promise<Reading[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('readings', 'by-point-day', day);
  return all.filter((r) => r.pointCode === pointCode);
}

export async function readingsByInstrument(instrumentId: string): Promise<Reading[]> {
  const db = await getDb();
  return db.getAllFromIndex('readings', 'by-instrument', instrumentId);
}

export async function readingsByFile(fileId: string): Promise<Reading[]> {
  const db = await getDb();
  return db.getAllFromIndex('readings', 'by-file', fileId);
}

export async function intakeFiles(): Promise<IntakeFile[]> {
  const db = await getDb();
  const all = await db.getAll('intake');
  return all.sort((a, b) => b.receivedAt - a.receivedAt);
}

export async function currentSchema(): Promise<number> {
  const db = await getDb();
  return db.version;
}

/* ---------------- 事件调查：登记簿 / 事件 / 候选 / 处置板 / 交付 ---------------- */

export async function putRegistryRecords(records: RegistryRecordWrapper[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('invRegistry', 'readwrite');
  for (const r of records) await tx.store.put(r);
  await tx.done;
}

export async function allRegistryRecords(): Promise<RegistryRecordWrapper[]> {
  const db = await getDb();
  return db.getAll('invRegistry');
}

/** 把登记簿记录还原为 InvestigationRegistry（保留全部版本，含已撤销） */
export function registryFromRecords(records: RegistryRecordWrapper[]): InvestigationRegistry {
  const registry: InvestigationRegistry = { sources: [], rainfall: [], pumpSwitches: [], selfReports: [], eventProfiles: [] };
  for (const r of records) {
    if (r.kind === 'SOURCE') registry.sources.push(r.record as InvestigationRegistry['sources'][number]);
    else if (r.kind === 'RAINFALL') registry.rainfall.push(r.record as InvestigationRegistry['rainfall'][number]);
    else if (r.kind === 'PUMP_SWITCH') registry.pumpSwitches.push(r.record as InvestigationRegistry['pumpSwitches'][number]);
    else if (r.kind === 'SELF_REPORT') registry.selfReports.push(r.record as InvestigationRegistry['selfReports'][number]);
    else if (r.kind === 'EVENT_PROFILE') registry.eventProfiles.push(r.record as InvestigationRegistry['eventProfiles'][number]);
  }
  return registry;
}

export function registryToRecords(registry: InvestigationRegistry): RegistryRecordWrapper[] {
  const out: RegistryRecordWrapper[] = [];
  for (const s of registry.sources) out.push({ recordId: s.recordId, kind: 'SOURCE', record: s });
  for (const r of registry.rainfall) out.push({ recordId: r.recordId, kind: 'RAINFALL', record: r });
  for (const p of registry.pumpSwitches) out.push({ recordId: p.recordId, kind: 'PUMP_SWITCH', record: p });
  for (const b of registry.selfReports) out.push({ recordId: b.recordId, kind: 'SELF_REPORT', record: b });
  for (const e of registry.eventProfiles) out.push({ recordId: e.recordId, kind: 'EVENT_PROFILE', record: e });
  return out;
}

export async function saveEvent(event: OutfallEvent): Promise<void> {
  const db = await getDb();
  await db.put('invEvents', event);
}

export async function getEvent(eventId: string): Promise<OutfallEvent | undefined> {
  const db = await getDb();
  return db.get('invEvents', eventId);
}

export async function listEvents(): Promise<OutfallEvent[]> {
  const db = await getDb();
  const all = await db.getAll('invEvents');
  return all.sort((a, b) => b.computedAt - a.computedAt);
}

export async function saveCandidates(assessments: CandidateAssessment[]): Promise<void> {
  if (assessments.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('invCandidates', 'readwrite');
  for (const a of assessments) await tx.store.put(a);
  await tx.done;
}

export async function listCandidates(eventId: string): Promise<CandidateAssessment[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('invCandidates', 'by-event', eventId);
  return all.sort((a, b) => b.computedAt - a.computedAt);
}

export async function saveInvestigation(investigation: Investigation): Promise<void> {
  const db = await getDb();
  await db.put('invInvestigations', investigation);
}

export async function listInvestigations(eventId?: string): Promise<Investigation[]> {
  const db = await getDb();
  if (eventId) {
    const all = await db.getAllFromIndex('invInvestigations', 'by-event', eventId);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  const all = await db.getAll('invInvestigations');
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveDelivery(delivery: Delivery): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['invDeliveries', 'audits'], 'readwrite');
  await tx.objectStore('invDeliveries').put(delivery);
  await tx.objectStore('audits').put({
    auditId: `audit-${delivery.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    at: delivery.createdAt,
    actor: delivery.createdBy,
    action: 'PUBLISH_DELIVERY',
    detail: `发布${delivery.route === 'SET' ? '集合' : '排序'}交付 ${delivery.deliveryId}（仅调查优先级，非责任结论），内容哈希 ${delivery.contentHash.slice(0, 16)}…`,
    refIds: [delivery.deliveryId, delivery.eventId],
  });
  await tx.done;
}

export async function listDeliveries(eventId?: string): Promise<Delivery[]> {
  const db = await getDb();
  if (eventId) {
    const all = await db.getAllFromIndex('invDeliveries', 'by-event', eventId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }
  const all = await db.getAll('invDeliveries');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
