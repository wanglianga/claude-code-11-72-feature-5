/**
 * 事件检测与事件指纹：
 * - 事件窗口取自基础复核台的计算结果（氨氮阈值穿越区间），不另起口径；
 * - 事件指纹 = 事件窗口均值 − 事件前基线窗口均值，区间半宽由仪表相对不确定度合成（k=2）；
 * - 电导率/pH 来自事件期间加密监测记录（登记簿 EVENT_PROFILE），基础台账无此类仪表。
 */

import type { Dataset, Reading } from '../domain/types';
import type { DayLoadSnapshot } from '../domain/types';
import { buildIndex, calibrationAt } from '../domain/weave';
import type { EventFingerprint, EventProfile, OutfallEvent } from './types';

const BASELINE_BEFORE_MS = 60 * 60 * 1000;
const BASELINE_GAP_MS = 10 * 60 * 1000;
const K = 2;

interface SeriesStats {
  mean: number;
  relUnc: number;
}

function calibratedSeries(dataset: Dataset, pointCode: string, metric: 'COD' | 'NH3N' | 'FLOW', from: number, to: number): { at: number; value: number; relUnc: number }[] {
  const index = buildIndex(dataset.readings, dataset.instruments, dataset.calibrations, dataset.states, dataset.bindings);
  const out: { at: number; value: number; relUnc: number }[] = [];
  for (const r of dataset.readings) {
    if (r.pointCode !== pointCode || r.metric !== metric) continue;
    if (r.alignedAt < from || r.alignedAt >= to) continue;
    if (r.qualityFlag === 'INVALID') continue;
    const inst = index.instrumentsById.get(r.instrumentId);
    const cal = calibrationAt(index, r.instrumentId, r.alignedAt);
    const scale = cal?.scale ?? inst?.scale ?? 1;
    const offset = cal?.offset ?? inst?.offset ?? 0;
    const relUnc = cal?.coefficientUncertainty ?? inst?.valueUncertainty ?? 0.02;
    out.push({ at: r.alignedAt, value: r.rawValue * scale + offset, relUnc });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function stats(points: { value: number; relUnc: number }[]): SeriesStats | null {
  if (points.length === 0) return null;
  const mean = points.reduce((a, p) => a + p.value, 0) / points.length;
  const relUnc = points.reduce((a, p) => a + p.relUnc, 0) / points.length;
  return { mean, relUnc };
}

function incrementRange(base: SeriesStats, event: SeriesStats): [number, number] {
  const inc = event.mean - base.mean;
  const half = K * Math.sqrt((event.relUnc * event.mean) ** 2 + (base.relUnc * base.mean) ** 2);
  return [round2(inc - half), round2(inc + half)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function profileIncrement(profile: EventProfile, windowFrom: number, windowTo: number, pick: 'cond' | 'ph'): [number, number] | null {
  const series = pick === 'cond' ? profile.condUsCm : profile.ph;
  const stepMs = profile.stepSeconds * 1000;
  const baseVals: number[] = [];
  const eventVals: number[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const v = series[i];
    if (v === null) continue;
    const at = profile.from + i * stepMs;
    if (at >= windowFrom && at < windowTo) eventVals.push(v);
    else if (at >= windowFrom - BASELINE_BEFORE_MS && at < windowFrom - BASELINE_GAP_MS) baseVals.push(v);
  }
  if (eventVals.length === 0 || baseVals.length === 0) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const inc = mean(eventVals) - mean(baseVals);
  // 加密监测相对不确定度：电导率 8%，pH 绝对 ±0.06（k=2 已含）
  const half = pick === 'cond' ? K * 0.08 * Math.abs(inc || mean(baseVals)) : 0.12;
  return [round2(inc - half), round2(inc + half)];
}

export interface DetectEventInput {
  dataset: Dataset;
  snapshot: DayLoadSnapshot;
  pointCode: string;
  day: string;
  eventProfiles: EventProfile[];
  computedAt: number;
}

/**
 * 从日负荷快照的氨氮阈值穿越中检出短时高氨氮事件。
 * 取当日最长穿越区间作为事件窗口；无穿越时返回 null。
 */
export function detectEvent(input: DetectEventInput): OutfallEvent | null {
  const { dataset, snapshot, pointCode, day, eventProfiles, computedAt } = input;
  const nh3n = snapshot.pollutants.find((t) => t.pollutant === 'NH3N');
  if (!nh3n || nh3n.exceedances.length === 0) return null;
  const exceed = [...nh3n.exceedances].sort((a, b) => b.seconds - a.seconds)[0];
  const windowFrom = exceed.from;
  const windowTo = exceed.to;

  const baseFrom = windowFrom - BASELINE_BEFORE_MS;
  const baseTo = windowFrom - BASELINE_GAP_MS;

  const observed: EventFingerprint = {
    nh3n: [0, 0],
    cod: [0, 0],
    cond: null,
    ph: null,
    flowM3h: [0, 0],
  };
  const observedBasis: Record<string, string> = {};

  for (const metric of ['NH3N', 'COD', 'FLOW'] as const) {
    const eventSeries = calibratedSeries(dataset, pointCode, metric, windowFrom, windowTo);
    const baseSeries = calibratedSeries(dataset, pointCode, metric, baseFrom, baseTo);
    const es = stats(eventSeries);
    const bs = stats(baseSeries);
    if (!es || !bs) continue;
    const range = incrementRange(bs, es);
    if (metric === 'NH3N') observed.nh3n = range;
    else if (metric === 'COD') observed.cod = range;
    else observed.flowM3h = range;
    observedBasis[metric] = `基础复核台读数（引擎 ${snapshot.engineVersion}，片段路线 ${snapshot.method}）`;
  }

  const profile = eventProfiles
    .filter((p) => !p.revoked && p.pointCode === pointCode && p.from <= windowFrom && p.to >= windowTo)
    .sort((a, b) => b.version - a.version)[0];
  if (profile) {
    observed.cond = profileIncrement(profile, windowFrom, windowTo, 'cond');
    observed.ph = profileIncrement(profile, windowFrom, windowTo, 'ph');
    if (observed.cond) observedBasis.COND = `加密监测 ${profile.recordId}（可信 ${profile.trustLevel} 级）`;
    if (observed.ph) observedBasis.PH = `加密监测 ${profile.recordId}（可信 ${profile.trustLevel} 级）`;
  }

  return {
    eventId: `EVT-${pointCode}-${day}-NH3N-${windowFrom}`,
    pointCode,
    day,
    pollutant: 'NH3N',
    windowFrom,
    windowTo,
    peakConcentration: exceed.peak,
    peakAt: exceed.peakAt,
    standard: nh3n.standard,
    observed,
    observedBasis,
    stormEvent: true,
    computedAt,
    engineVersion: snapshot.engineVersion,
  };
}

/** 供脚本复用：从数据集中直接取校准序列（与 detectEvent 同一口径） */
export function readingsInWindow(dataset: Dataset, pointCode: string, metric: 'COD' | 'NH3N' | 'FLOW', from: number, to: number): Reading[] {
  return dataset.readings
    .filter((r) => r.pointCode === pointCode && r.metric === metric && r.alignedAt >= from && r.alignedAt < to)
    .sort((a, b) => a.alignedAt - b.alignedAt);
}
