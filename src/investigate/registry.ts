/**
 * 来源登记簿解析：CSV → 版本化登记记录。
 * 所有记录带版本与可信等级；同一实体的多版本并存，撤销关系由 supersedes/revoked 表达。
 */

import { parseCsv, parseIso, parseIsoOrNull } from '../sample/csv';
import type {
  EventProfile,
  InvestigationRegistry,
  PumpSwitch,
  RainfallSeries,
  SelfReportBatch,
  SelfReportClaim,
  SourceRegistration,
  TrustLevel,
} from './types';

function trust(value: string): TrustLevel {
  const v = (value || 'B').toUpperCase();
  return v === 'A' || v === 'C' ? v : 'B';
}

function numOrNull(value: string): number | null {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rangeOrNull(lo: string, hi: string): [number, number] | null {
  const a = numOrNull(lo);
  const b = numOrNull(hi);
  if (a === null || b === null) return null;
  return [a, b];
}

function hhmmToMin(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function parseSources(text: string): { sources: SourceRegistration[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const sources: SourceRegistration[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2;
    try {
      const version = Number(row.version || '1');
      const allowedKind = row.allowed_kind;
      const allowed: SourceRegistration['allowed'] =
        allowedKind === 'RAIN_TRIGGERED'
          ? { kind: 'RAIN_TRIGGERED', thresholdMmH: Number(row.rain_threshold_mmh) }
          : allowedKind === 'PUMP_RUNNING'
            ? { kind: 'PUMP_RUNNING' }
            : { kind: 'DAILY', fromMin: hhmmToMin(row.allowed_from), toMin: hhmmToMin(row.allowed_to) };
      sources.push({
        recordId: `${row.source_id}@v${version}`,
        sourceId: row.source_id,
        kind: row.kind as SourceRegistration['kind'],
        name: row.name,
        version,
        trustLevel: trust(row.trust_level),
        registeredAt: parseIso(row.registered_at),
        revoked: row.revoked === 'true' || row.revoked === '1',
        supersedes: row.supersedes || null,
        access: {
          sewerId: row.sewer_id,
          chainageM: Number(row.chainage_m),
          travelTimeS: [Number(row.travel_min_s), Number(row.travel_max_s)],
        },
        allowed,
        envelope: {
          nh3n: rangeOrNull(row.env_nh3n_lo, row.env_nh3n_hi),
          cod: rangeOrNull(row.env_cod_lo, row.env_cod_hi),
          cond: rangeOrNull(row.env_cond_lo, row.env_cond_hi),
          ph: rangeOrNull(row.env_ph_lo, row.env_ph_hi),
        },
        typicalFlowM3h: [Number(row.flow_lo_m3h), Number(row.flow_hi_m3h)],
        note: row.note ?? '',
      });
    } catch (e) {
      errors.push(`第 ${line} 行来源登记解析失败：${(e as Error).message}`);
    }
  });
  return { sources, errors };
}

export function parseRainfall(text: string): { rainfall: RainfallSeries[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const groups = new Map<string, { meta: RainfallSeries; steps: { at: number; mm: number }[] }>();
  rows.forEach((row, idx) => {
    const line = idx + 2;
    try {
      const id = `${row.series_id}@v${row.version}`;
      let g = groups.get(id);
      if (!g) {
        g = {
          meta: {
            recordId: id,
            seriesId: row.series_id,
            gaugeId: row.gauge_id,
            version: Number(row.version),
            trustLevel: trust(row.trust_level),
            revoked: row.revoked === 'true' || row.revoked === '1',
            from: 0,
            to: 0,
            stepSeconds: Number(row.step_seconds),
            mmPerStep: [],
            errorRelative: Number(row.error_relative || '0'),
            note: row.note ?? '',
          },
          steps: [],
        };
        groups.set(id, g);
      }
      g.steps.push({ at: parseIso(row.at), mm: Number(row.mm) });
    } catch (e) {
      errors.push(`第 ${line} 行雨量解析失败：${(e as Error).message}`);
    }
  });
  const rainfall: RainfallSeries[] = [];
  for (const g of groups.values()) {
    g.steps.sort((a, b) => a.at - b.at);
    g.meta.from = g.steps[0]?.at ?? 0;
    g.meta.to = g.steps.length > 0 ? g.steps[g.steps.length - 1].at + g.meta.stepSeconds * 1000 : 0;
    g.meta.mmPerStep = g.steps.map((s) => s.mm);
    rainfall.push(g.meta);
  }
  return { rainfall, errors };
}

export function parsePumpSwitches(text: string): { pumpSwitches: PumpSwitch[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const groups = new Map<string, PumpSwitch>();
  rows.forEach((row, idx) => {
    const line = idx + 2;
    try {
      const id = `${row.switch_id}@v${row.version}`;
      let sw = groups.get(id);
      if (!sw) {
        sw = {
          recordId: id,
          switchId: row.switch_id,
          stationId: row.station_id,
          stationName: row.station_name,
          at: parseIso(row.at),
          fromMode: row.from_mode,
          toMode: row.to_mode,
          affects: [],
          version: Number(row.version),
          trustLevel: trust(row.trust_level),
          revoked: row.revoked === 'true' || row.revoked === '1',
          note: row.note ?? '',
        };
        groups.set(id, sw);
      }
      sw.affects.push({
        sewerId: row.affects_sewer_id,
        travelTimeAfterS: [Number(row.travel_after_min_s), Number(row.travel_after_max_s)],
      });
    } catch (e) {
      errors.push(`第 ${line} 行泵站切换解析失败：${(e as Error).message}`);
    }
  });
  return { pumpSwitches: [...groups.values()], errors };
}

export function parseSelfReports(text: string): { selfReports: SelfReportBatch[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const groups = new Map<string, { meta: SelfReportBatch; claims: SelfReportClaim[] }>();
  rows.forEach((row, idx) => {
    const line = idx + 2;
    try {
      const id = row.batch_id;
      let g = groups.get(id);
      if (!g) {
        g = {
          meta: {
            recordId: id,
            batchId: id,
            sourceId: row.source_id,
            version: Number(row.version),
            trustLevel: trust(row.trust_level),
            receivedAt: parseIso(row.received_at),
            revoked: row.revoked === 'true' || row.revoked === '1',
            supersedes: row.supersedes || null,
            claims: [],
            note: row.note ?? '',
          },
          claims: [],
        };
        groups.set(id, g);
      }
      g.claims.push({
        kind: row.claim_kind as SelfReportClaim['kind'],
        from: parseIsoOrNull(row.claim_from),
        to: parseIsoOrNull(row.claim_to),
        flowM3h: rangeOrNull(row.flow_lo_m3h, row.flow_hi_m3h),
        text: row.text ?? '',
      });
    } catch (e) {
      errors.push(`第 ${line} 行自报批次解析失败：${(e as Error).message}`);
    }
  });
  for (const g of groups.values()) g.meta.claims = g.claims;
  return { selfReports: [...groups.values()].map((g) => g.meta), errors };
}

export function parseEventProfiles(text: string): { eventProfiles: EventProfile[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const groups = new Map<string, { meta: EventProfile; steps: { at: number; cond: number | null; ph: number | null }[] }>();
  rows.forEach((row, idx) => {
    const line = idx + 2;
    try {
      const id = `${row.profile_id}@v${row.version}`;
      let g = groups.get(id);
      if (!g) {
        g = {
          meta: {
            recordId: id,
            profileId: row.profile_id,
            pointCode: row.point_code,
            version: Number(row.version),
            trustLevel: trust(row.trust_level),
            revoked: row.revoked === 'true' || row.revoked === '1',
            from: 0,
            to: 0,
            stepSeconds: Number(row.step_seconds),
            condUsCm: [],
            ph: [],
            note: row.note ?? '',
          },
          steps: [],
        };
        groups.set(id, g);
      }
      g.steps.push({ at: parseIso(row.at), cond: numOrNull(row.cond_us_cm), ph: numOrNull(row.ph) });
    } catch (e) {
      errors.push(`第 ${line} 行加密监测解析失败：${(e as Error).message}`);
    }
  });
  const eventProfiles: EventProfile[] = [];
  for (const g of groups.values()) {
    g.steps.sort((a, b) => a.at - b.at);
    g.meta.from = g.steps[0]?.at ?? 0;
    g.meta.to = g.steps.length > 0 ? g.steps[g.steps.length - 1].at + g.meta.stepSeconds * 1000 : 0;
    g.meta.condUsCm = g.steps.map((s) => s.cond);
    g.meta.ph = g.steps.map((s) => s.ph);
    eventProfiles.push(g.meta);
  }
  return { eventProfiles, errors };
}

export function emptyRegistry(): InvestigationRegistry {
  return { sources: [], rainfall: [], pumpSwitches: [], selfReports: [], eventProfiles: [] };
}

/**
 * 现行视图：每个实体只保留版本最高的未撤销记录。
 * 自报批次按 sourceId 归并（同一来源只留最新未撤销批次）。
 */
export function currentRegistry(all: InvestigationRegistry): InvestigationRegistry {
  const latest = <T extends { version: number; revoked: boolean }>(items: T[], key: (t: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const item of items) {
      if (item.revoked) continue;
      const k = key(item);
      const prev = map.get(k);
      if (!prev || item.version > prev.version) map.set(k, item);
    }
    return [...map.values()];
  };
  return {
    sources: latest(all.sources, (s) => s.sourceId),
    rainfall: latest(all.rainfall, (r) => r.seriesId),
    pumpSwitches: latest(all.pumpSwitches, (p) => p.switchId),
    selfReports: latest(all.selfReports, (s) => s.sourceId),
    eventProfiles: latest(all.eventProfiles, (e) => e.profileId),
  };
}

/** 应用一个更正批次：撤销其 supersedes 指向的旧批次，返回被撤销的记录键 */
export function applyCorrection(all: InvestigationRegistry, batch: SelfReportBatch): { registry: InvestigationRegistry; revokedIds: string[] } {
  const revokedIds: string[] = [];
  const selfReports = all.selfReports.map((b) => {
    if (batch.supersedes && b.recordId === batch.supersedes && !b.revoked) {
      revokedIds.push(b.recordId);
      return { ...b, revoked: true };
    }
    return b;
  });
  return { registry: { ...all, selfReports: [...selfReports, batch] }, revokedIds };
}

/** 应用拓扑修订：撤销被取代的来源版本 */
export function applyTopologyRevision(all: InvestigationRegistry, revised: SourceRegistration[]): { registry: InvestigationRegistry; revokedIds: string[] } {
  const revokedIds: string[] = [];
  const superseded = new Set(revised.map((s) => s.supersedes).filter((v): v is string => Boolean(v)));
  const sources = all.sources.map((s) => {
    if (superseded.has(s.recordId) && !s.revoked) {
      revokedIds.push(s.recordId);
      return { ...s, revoked: true };
    }
    return s;
  });
  return { registry: { ...all, sources: [...sources, ...revised] }, revokedIds };
}
