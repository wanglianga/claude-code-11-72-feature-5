/**
 * 证据组合器：时间带相容性 + COD/氨氮/电导率/pH/流量特征 + 自报 + 雨量 + 缺测惩罚。
 *
 * 可回放约定：
 * - 每个 EvidenceItem 记录权重、贡献、观测、期望与依据记录键（含版本）；
 *   总分 = Σ贡献，完整度 = 1 − Σ缺测权重；缺测只产生缺失惩罚，不支持也不反证。
 * - 特征维度的相容强度按“观测增量区间与登记包络的重叠比（占观测宽度）”判定：
 *   ≥0.8 相容（×1.0），≥0.15 弱相容（×0.5），<0.15 反证（×−0.75）。
 * - 自报贡献乘可信等级系数；自报否认是反证（×−0.75×可信系数）。
 * - 雨量维度对雨污合流溢流计分，对工业支管/厂内回流记中性（有观测但不具指示性）。
 * - 排放窗口重叠判定逐泵站体制进行（recallOverlaps），不用包络近似。
 */

import type {
  CandidateAssessment,
  CandidateRecall,
  EvidenceItem,
  InvestigationRegistry,
  OutfallEvent,
  RainfallSeries,
  SelfReportBatch,
  SourceRegistration,
} from './types';
import { EVIDENCE_WEIGHTS, TRUST_FACTOR } from './types';
import { recallCandidates, recallOverlaps } from './candidates';

const STRONG_OVERLAP = 0.8;
const WEAK_OVERLAP = 0.15;
const CONTRADICT_FACTOR = -0.75;

export interface AssessOptions {
  /** 雨量缩放（敏感性分析：1 ± errorRelative） */
  rainScale?: number;
  computedAt: number;
}

function overlapRatio(obs: [number, number], env: [number, number]): number {
  const lo = Math.max(obs[0], env[0]);
  const hi = Math.min(obs[1], env[1]);
  const inter = Math.max(0, hi - lo);
  const width = Math.max(1e-9, obs[1] - obs[0]);
  return inter / width;
}

function fmtRange(r: [number, number], unit: string): string {
  return `${r[0]} – ${r[1]} ${unit}`;
}

function featureItem(
  dim: 'NH3N' | 'COD' | 'COND' | 'PH',
  label: string,
  observed: [number, number] | null,
  envelope: [number, number] | null,
  unit: string,
  source: SourceRegistration,
  observedBasis: string | undefined,
): EvidenceItem {
  const weight = EVIDENCE_WEIGHTS[dim];
  const basis = [source.recordId];
  if (observed === null || envelope === null) {
    const which = observed === null ? '事件层面无观测' : '来源登记缺测';
    return {
      dim,
      label,
      verdict: 'MISSING',
      weight,
      contribution: 0,
      completenessLoss: weight,
      observed: observed ? fmtRange(observed, unit) : '无观测',
      expected: envelope ? fmtRange(envelope, unit) : '未登记',
      basisRecordIds: basis,
      note: `${which}（${observed === null ? (observedBasis ?? '无加密监测') : '登记包络为空'}）：按缺测处理，只计缺失惩罚，不产生支持或反证。`,
      independenceGroup: dim,
    };
  }
  const ratio = overlapRatio(observed, envelope);
  if (ratio >= STRONG_OVERLAP) {
    return {
      dim,
      label,
      verdict: 'STRONG_MATCH',
      weight,
      contribution: weight,
      completenessLoss: 0,
      observed: fmtRange(observed, unit),
      expected: fmtRange(envelope, unit),
      basisRecordIds: basis,
      note: `重叠比 ${ratio.toFixed(2)} ≥ ${STRONG_OVERLAP}，观测增量落在登记包络内。`,
      independenceGroup: dim,
    };
  }
  if (ratio >= WEAK_OVERLAP) {
    return {
      dim,
      label,
      verdict: 'WEAK_MATCH',
      weight,
      contribution: weight * 0.5,
      completenessLoss: 0,
      observed: fmtRange(observed, unit),
      expected: fmtRange(envelope, unit),
      basisRecordIds: basis,
      note: `重叠比 ${ratio.toFixed(2)}，部分相容，按半权重计。`,
      independenceGroup: dim,
    };
  }
  return {
    dim,
    label,
    verdict: 'CONTRADICT',
    weight,
    contribution: weight * CONTRADICT_FACTOR,
    completenessLoss: 0,
    observed: fmtRange(observed, unit),
    expected: fmtRange(envelope, unit),
    basisRecordIds: basis,
    note: `重叠比 ${ratio.toFixed(2)} < ${WEAK_OVERLAP}，观测增量与登记包络基本不相交，构成反证。`,
    independenceGroup: dim,
  };
}

/** 雨量序列 → 逐步长强度（mm/h），可按 rainScale 缩放做敏感性 */
export function rainIntensities(series: RainfallSeries, rainScale = 1): { at: number; mmH: number }[] {
  const perHour = 3600 / series.stepSeconds;
  return series.mmPerStep.map((mm, i) => ({
    at: series.from + i * series.stepSeconds * 1000,
    mmH: mm * perHour * rainScale,
  }));
}

function peakIntensityInRecall(series: RainfallSeries, recall: CandidateRecall, rainScale: number): number {
  let peak = 0;
  const windows = recall.regimes.map((r) => r.dischargeWindow).filter((w): w is { from: number; to: number } => w !== null);
  for (const p of rainIntensities(series, rainScale)) {
    const stepTo = p.at + series.stepSeconds * 1000;
    const inAny = windows.some((w) => p.at < w.to && stepTo > w.from);
    if (inAny && p.mmH > peak) peak = p.mmH;
  }
  return peak;
}

function dailyWindowOverlaps(from: number, to: number, fromMin: number, toMin: number): boolean {
  const dayMs = 86_400_000;
  // 逐日展开允许时段（支持跨午夜），检查与 [from,to) 是否相交
  const firstDay = Math.floor((from - dayMs) / dayMs);
  const lastDay = Math.floor((to + dayMs) / dayMs);
  for (let d = firstDay; d <= lastDay; d += 1) {
    const dayStart = d * dayMs;
    const spans: [number, number][] =
      fromMin <= toMin
        ? [[dayStart + fromMin * 60_000, dayStart + toMin * 60_000]]
        : [
            [dayStart, dayStart + toMin * 60_000],
            [dayStart + fromMin * 60_000, dayStart + dayMs],
          ];
    for (const [a, b] of spans) {
      // 允许时段按本地时钟定义：此处 from/to 已是绝对毫秒，需按上海时区对齐日界
      const shiftA = a - 8 * 3_600_000;
      const shiftB = b - 8 * 3_600_000;
      if (from < shiftB && to > shiftA) return true;
    }
  }
  return false;
}

interface TimeBandResult {
  compatible: boolean;
  reason: string | null;
  item: EvidenceItem;
}

function regimeWindows(recall: CandidateRecall): { from: number; to: number }[] {
  return recall.regimes.map((r) => r.dischargeWindow).filter((w): w is { from: number; to: number } => w !== null);
}

function checkTimeBand(
  source: SourceRegistration,
  recall: CandidateRecall,
  batch: SelfReportBatch | null,
  rainfall: RainfallSeries | null,
  rainScale: number,
): TimeBandResult {
  const win = recall.dischargeWindow;
  const basis = [source.recordId];
  const winText = `${timeText(win.from)} → ${timeText(win.to)}`;
  const windows = regimeWindows(recall);
  if (source.allowed.kind === 'DAILY') {
    const { fromMin, toMin } = source.allowed;
    const compatible = windows.some((w) => dailyWindowOverlaps(w.from, w.to, fromMin, toMin));
    return {
      compatible,
      reason: compatible ? null : `倒推排放窗口 ${winText} 与允许排放时段 ${minToText(fromMin)}–${minToText(toMin)} 不相交`,
      item: timeBandItem(compatible, winText, `允许时段 ${minToText(fromMin)}–${minToText(toMin)}`, basis),
    };
  }
  if (source.allowed.kind === 'RAIN_TRIGGERED') {
    const threshold = source.allowed.thresholdMmH;
    const peak = rainfall ? peakIntensityInRecall(rainfall, recall, rainScale) : 0;
    const compatible = rainfall !== null && peak >= threshold;
    return {
      compatible,
      reason: compatible
        ? null
        : rainfall
          ? `倒推排放窗口 ${winText} 内最大雨强 ${peak.toFixed(1)} mm/h 低于溢流触发阈值 ${threshold} mm/h`
          : '无雨量序列，无法验证降雨触发条件',
      item: timeBandItem(
        compatible,
        winText,
        rainfall ? `雨强 ≥ ${threshold} mm/h（窗口内峰值 ${peak.toFixed(1)}）` : '无雨量序列',
        rainfall ? [...basis, rainfall.recordId] : basis,
      ),
    };
  }
  // PUMP_RUNNING：回流泵运行时段才水力连通；PUMP_OFF 记录覆盖全部体制窗口则不连通
  const offs = (batch?.claims ?? []).filter((c) => c.kind === 'PUMP_OFF' && c.from !== null && c.to !== null);
  if (windows.length > 0 && offs.length > 0) {
    const allCovered = windows.every((w) =>
      offs.some((off) => {
        const coverFrom = Math.max(w.from, off.from!);
        const coverTo = Math.min(w.to, off.to!);
        return Math.max(0, coverTo - coverFrom) / Math.max(1, w.to - w.from) >= 0.5;
      }),
    );
    if (allCovered) {
      const off = offs[0];
      return {
        compatible: false,
        reason: `倒推排放窗口 ${winText} 被回流泵停运记录覆盖（${off.text}），水力不连通`,
        item: timeBandItem(false, winText, `停运记录 ${timeText(off.from!)} → ${timeText(off.to!)}`, batch ? [...basis, batch.recordId] : basis),
      };
    }
  }
  return {
    compatible: true,
    reason: null,
    item: timeBandItem(true, winText, offs.length > 0 ? '有停运记录但未覆盖全部体制窗口' : '无停运记录，按连通处理', batch ? [...basis, batch.recordId] : basis),
  };
}

function timeBandItem(compatible: boolean, observed: string, expected: string, basis: string[]): EvidenceItem {
  return {
    dim: 'TIME_BAND',
    label: '时间带相容性',
    verdict: compatible ? 'STRONG_MATCH' : 'CONTRADICT',
    weight: 0,
    contribution: 0,
    completenessLoss: 0,
    observed,
    expected,
    basisRecordIds: basis,
    note: compatible ? '倒推排放窗口与允许排放时段相容（门槛项，不计分）。' : '倒推排放窗口与允许排放时段不相容，候选排除（门槛项，不计分）。',
    independenceGroup: 'TIME_BAND',
  };
}

export function timeText(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19);
}

function minToText(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function currentBatch(registry: InvestigationRegistry, sourceId: string): SelfReportBatch | null {
  const batches = registry.selfReports
    .filter((b) => b.sourceId === sourceId && !b.revoked)
    .sort((a, b) => b.version - a.version || b.receivedAt - a.receivedAt);
  return batches[0] ?? null;
}

/**
 * 评估全部候选：水力召回 → 时间带门槛 → 逐项证据 → 评分与完整度。
 * 同一 registry 输入必然得到同一结果（纯函数），更正/修订通过换 registry 版本体现。
 */
export function assessCandidates(
  registry: InvestigationRegistry,
  event: OutfallEvent,
  options: AssessOptions,
): CandidateAssessment[] {
  const rainScale = options.rainScale ?? 1;
  const recalled = recallCandidates(registry, event);
  const rainfall = registry.rainfall.filter((r) => !r.revoked).sort((a, b) => b.version - a.version)[0] ?? null;
  const assessments: CandidateAssessment[] = [];

  for (const { source, recall } of recalled) {
    const batch = currentBatch(registry, source.sourceId);
    const registryRefs: CandidateAssessment['registryRefs'] = [
      { kind: 'SOURCE', recordId: source.recordId, version: source.version },
    ];
    if (rainfall) registryRefs.push({ kind: 'RAINFALL', recordId: rainfall.recordId, version: rainfall.version });
    for (const sw of registry.pumpSwitches.filter((s) => !s.revoked && s.affects.some((a) => a.sewerId === source.access.sewerId))) {
      registryRefs.push({ kind: 'PUMP_SWITCH', recordId: sw.recordId, version: sw.version });
    }
    if (batch) registryRefs.push({ kind: 'SELF_REPORT', recordId: batch.recordId, version: batch.version });
    const profile = registry.eventProfiles.filter((p) => !p.revoked && p.pointCode === event.pointCode).sort((a, b) => b.version - a.version)[0];
    if (profile) registryRefs.push({ kind: 'EVENT_PROFILE', recordId: profile.recordId, version: profile.version });

    const tb = checkTimeBand(source, recall, batch, rainfall, rainScale);
    const items: EvidenceItem[] = [tb.item];

    if (!tb.compatible) {
      assessments.push({
        candidateId: `CAND-${event.eventId}-${source.sourceId}-${options.computedAt}`,
        eventId: event.eventId,
        sourceId: source.sourceId,
        sourceKind: source.kind,
        sourceName: source.name,
        recall,
        timeBandCompatible: false,
        excludeReason: tb.reason,
        items,
        score: 0,
        completeness: 0,
        registryRefs,
        selfReportRecordId: batch?.recordId ?? null,
        revoked: false,
        computedAt: options.computedAt,
      });
      continue;
    }

    // 特征维度（缺测只计缺失惩罚）
    items.push(
      featureItem('NH3N', '氨氮增量', event.observed.nh3n, source.envelope.nh3n, 'mg/L', source, event.observedBasis.NH3N),
      featureItem('COD', 'COD 增量', event.observed.cod, source.envelope.cod, 'mg/L', source, event.observedBasis.COD),
      featureItem('COND', '电导率增量', event.observed.cond, source.envelope.cond, 'µS/cm', source, event.observedBasis.COND),
      featureItem('PH', 'pH 变化', event.observed.ph, source.envelope.ph, '', source, event.observedBasis.PH),
    );

    // 排放流量证据：自报批次中的排放/溢流流量记录与倒推窗口重叠（逐体制）
    const flowClaims = (batch?.claims ?? []).filter(
      (c) => (c.kind === 'DISCHARGE' || c.kind === 'OVERFLOW') && c.flowM3h && recallOverlaps(recall, c.from, c.to),
    );
    if (flowClaims.length > 0) {
      const c = flowClaims[0];
      items.push({
        dim: 'FLOW',
        label: '排放流量证据',
        verdict: 'STRONG_MATCH',
        weight: EVIDENCE_WEIGHTS.FLOW,
        contribution: EVIDENCE_WEIGHTS.FLOW,
        completenessLoss: 0,
        observed: `${c.text}（${c.flowM3h![0]}–${c.flowM3h![1]} m³/h，${timeText(c.from!)} → ${timeText(c.to!)}）`,
        expected: `倒推排放窗口 ${timeText(recall.dischargeWindow.from)} → ${timeText(recall.dischargeWindow.to)} 内存在排放流量记录`,
        basisRecordIds: batch ? [batch.recordId] : [],
        note: '自报/市政流量记录与倒推排放窗口重叠。',
        independenceGroup: batch ? `SELF:${batch.recordId}` : 'FLOW',
      });
    } else {
      const denied = (batch?.claims ?? []).some((c) => c.kind === 'NO_DISCHARGE');
      items.push({
        dim: 'FLOW',
        label: '排放流量证据',
        verdict: 'MISSING',
        weight: EVIDENCE_WEIGHTS.FLOW,
        contribution: 0,
        completenessLoss: EVIDENCE_WEIGHTS.FLOW,
        observed: denied ? '自报称未排放，无流量记录' : '无排放流量记录',
        expected: '倒推排放窗口内的排放流量记录',
        basisRecordIds: batch ? [batch.recordId] : [],
        note: '无可用排放流量记录，按缺测处理（只计缺失惩罚）。',
        independenceGroup: batch ? `SELF:${batch.recordId}` : 'FLOW',
      });
    }

    // 自报资料：排放/溢流申报覆盖窗口 → 支持；否认排放 → 反证（均乘可信系数）
    if (!batch) {
      items.push({
        dim: 'SELF_REPORT',
        label: '自报资料',
        verdict: 'MISSING',
        weight: EVIDENCE_WEIGHTS.SELF_REPORT,
        contribution: 0,
        completenessLoss: EVIDENCE_WEIGHTS.SELF_REPORT,
        observed: '无自报批次',
        expected: '覆盖事件窗口的排放申报',
        basisRecordIds: [],
        note: '该来源没有任何自报批次，按缺测处理。',
        independenceGroup: 'SELF_REPORT',
      });
    } else {
      const trustFactor = TRUST_FACTOR[batch.trustLevel];
      const confirm = batch.claims.find(
        (c) => (c.kind === 'DISCHARGE' || c.kind === 'OVERFLOW') && recallOverlaps(recall, c.from, c.to),
      );
      const deny = batch.claims.find((c) => c.kind === 'NO_DISCHARGE');
      if (confirm) {
        items.push({
          dim: 'SELF_REPORT',
          label: '自报资料',
          verdict: 'STRONG_MATCH',
          weight: EVIDENCE_WEIGHTS.SELF_REPORT,
          contribution: EVIDENCE_WEIGHTS.SELF_REPORT * trustFactor,
          completenessLoss: 0,
          observed: `${confirm.text}（批次 ${batch.recordId}，可信 ${batch.trustLevel} 级）`,
          expected: `倒推排放窗口 ${timeText(recall.dischargeWindow.from)} → ${timeText(recall.dischargeWindow.to)}`,
          basisRecordIds: [batch.recordId],
          note: `自报排放与倒推窗口重叠，贡献 = 权重 × 可信系数 ${trustFactor}。`,
          independenceGroup: `SELF:${batch.recordId}`,
        });
      } else if (deny) {
        items.push({
          dim: 'SELF_REPORT',
          label: '自报资料',
          verdict: 'CONTRADICT',
          weight: EVIDENCE_WEIGHTS.SELF_REPORT,
          contribution: EVIDENCE_WEIGHTS.SELF_REPORT * CONTRADICT_FACTOR * trustFactor,
          completenessLoss: 0,
          observed: `${deny.text}（批次 ${batch.recordId}，可信 ${batch.trustLevel} 级）`,
          expected: `倒推排放窗口 ${timeText(recall.dischargeWindow.from)} → ${timeText(recall.dischargeWindow.to)} 内有排放`,
          basisRecordIds: [batch.recordId],
          note: `自报否认排放，构成反证：贡献 = 权重 × ${CONTRADICT_FACTOR} × 可信系数 ${trustFactor}；该批次被更正撤销时，此反证随之撤销。`,
          independenceGroup: `SELF:${batch.recordId}`,
        });
      } else {
        items.push({
          dim: 'SELF_REPORT',
          label: '自报资料',
          verdict: 'NEUTRAL',
          weight: EVIDENCE_WEIGHTS.SELF_REPORT,
          contribution: 0,
          completenessLoss: 0,
          observed: `批次 ${batch.recordId} 无覆盖事件窗口的排放声明`,
          expected: '覆盖事件窗口的排放申报',
          basisRecordIds: [batch.recordId],
          note: '自报批次存在但未涉及事件窗口，记中性。',
          independenceGroup: `SELF:${batch.recordId}`,
        });
      }
    }

    // 雨量相容性：仅对雨污合流溢流计分；其他来源记中性
    if (source.kind === 'CSO_OVERFLOW' && source.allowed.kind === 'RAIN_TRIGGERED') {
      const threshold = source.allowed.thresholdMmH;
      const peak = rainfall ? peakIntensityInRecall(rainfall, recall, rainScale) : 0;
      const scaledNote = rainScale !== 1 ? `（雨量已按 ×${rainScale.toFixed(2)} 缩放做敏感性）` : '';
      if (rainfall && peak >= threshold * 2) {
        items.push({
          dim: 'RAINFALL',
          label: '雨量相容性',
          verdict: 'STRONG_MATCH',
          weight: EVIDENCE_WEIGHTS.RAINFALL,
          contribution: EVIDENCE_WEIGHTS.RAINFALL,
          completenessLoss: 0,
          observed: `窗口内峰值雨强 ${peak.toFixed(1)} mm/h ≥ 2×阈值 ${threshold} mm/h${scaledNote}`,
          expected: `溢流触发阈值 ${threshold} mm/h`,
          basisRecordIds: [rainfall.recordId],
          note: '雨强远超触发阈值，溢流在窗口内几乎必然发生。',
          independenceGroup: 'RAINFALL',
        });
      } else if (rainfall && peak >= threshold) {
        items.push({
          dim: 'RAINFALL',
          label: '雨量相容性',
          verdict: 'WEAK_MATCH',
          weight: EVIDENCE_WEIGHTS.RAINFALL,
          contribution: EVIDENCE_WEIGHTS.RAINFALL * 0.5,
          completenessLoss: 0,
          observed: `窗口内峰值雨强 ${peak.toFixed(1)} mm/h ≥ 阈值 ${threshold} mm/h，但不足 2 倍${scaledNote}`,
          expected: `溢流触发阈值 ${threshold} mm/h`,
          basisRecordIds: [rainfall.recordId],
          note: '雨强刚过阈值，溢流可能发生，按半权重计。',
          independenceGroup: 'RAINFALL',
        });
      } else {
        items.push({
          dim: 'RAINFALL',
          label: '雨量相容性',
          verdict: rainfall ? 'CONTRADICT' : 'MISSING',
          weight: EVIDENCE_WEIGHTS.RAINFALL,
          contribution: rainfall ? EVIDENCE_WEIGHTS.RAINFALL * CONTRADICT_FACTOR : 0,
          completenessLoss: rainfall ? 0 : EVIDENCE_WEIGHTS.RAINFALL,
          observed: rainfall ? `窗口内峰值雨强 ${peak.toFixed(1)} mm/h < 阈值 ${threshold} mm/h${scaledNote}` : '无雨量序列',
          expected: `溢流触发阈值 ${threshold} mm/h`,
          basisRecordIds: rainfall ? [rainfall.recordId] : [],
          note: rainfall ? '雨强未达触发阈值，构成反证。' : '无雨量序列，按缺测处理。',
          independenceGroup: 'RAINFALL',
        });
      }
    } else {
      items.push({
        dim: 'RAINFALL',
        label: '雨量相容性',
        verdict: 'NEUTRAL',
        weight: EVIDENCE_WEIGHTS.RAINFALL,
        contribution: 0,
        completenessLoss: 0,
        observed: rainfall ? '降雨已观测，但该来源类型不由降雨触发' : '无雨量序列',
        expected: '该来源类型不依赖降雨触发',
        basisRecordIds: rainfall ? [rainfall.recordId] : [],
        note: '雨量对该来源类型不具指示性，记中性（不计分也不计缺测）。',
        independenceGroup: 'RAINFALL',
      });
    }

    // 泵站切换注记（不计分）
    if (recall.pumpSwitchMidEvent) {
      items.push({
        dim: 'PUMP_STATE',
        label: '泵站切换',
        verdict: 'NEUTRAL',
        weight: 0,
        contribution: 0,
        completenessLoss: 0,
        observed: recall.notes.join('；'),
        expected: '—',
        basisRecordIds: registry.pumpSwitches.filter((s) => !s.revoked).map((s) => s.recordId),
        note: '泵站中途切换已按体制分别倒推排放窗口；传播时间不确定已显式标注。',
        independenceGroup: 'PUMP_STATE',
      });
    }

    const score = items.reduce((a, it) => a + it.contribution, 0);
    const totalLoss = items.reduce((a, it) => a + it.completenessLoss, 0);
    assessments.push({
      candidateId: `CAND-${event.eventId}-${source.sourceId}-${options.computedAt}`,
      eventId: event.eventId,
      sourceId: source.sourceId,
      sourceKind: source.kind,
      sourceName: source.name,
      recall,
      timeBandCompatible: true,
      excludeReason: null,
      items,
      score: Math.round(score * 10000) / 10000,
      completeness: Math.round((1 - totalLoss) * 10000) / 10000,
      registryRefs,
      selfReportRecordId: batch?.recordId ?? null,
      revoked: false,
      computedAt: options.computedAt,
    });
  }
  return assessments;
}
