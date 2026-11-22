/**
 * 两条发布路线（都只输出调查优先级，不输出责任结论）：
 *
 * 集合路线（SET）：只发布满足“预先声明的独立证据门槛”的候选集合。
 *   门槛在计算前声明（调查资料包清单内，含声明时刻与声明人）。
 *   暴雨事件期间，无独立反证的候选必须保留并列，不得凭时间接近单独剔除。
 *
 * 排序路线（RANK）：输出可拒答的优先级排序。
 *   每个证据贡献与缺测惩罚都可回放；前两名分差小于门槛或完整度不足时
 *   输出“不可判定”而不是强行排序。同时给出对自报更正与雨量误差的敏感性。
 */

import type {
  CandidateAssessment,
  InvestigationRegistry,
  OutfallEvent,
  RankEntry,
  RankRouteResult,
  RankScenario,
  SetRouteResult,
  SetRouteThresholds,
} from './types';
import { assessCandidates } from './evidence';

const STRENGTH: Record<string, number> = {
  STRONG_MATCH: 1,
  WEAK_MATCH: 0.5,
  NEUTRAL: 0,
  MISSING: 0,
  CONTRADICT: -1,
};

/** 独立支持数：按 independenceGroup 归并，同组只取最强；反证数单独统计 */
export function independentSupports(assessment: CandidateAssessment): { supports: number; counters: number } {
  const groups = new Map<string, number>();
  let counters = 0;
  for (const item of assessment.items) {
    if (item.weight <= 0) continue; // 门槛/注记项不参与
    const s = STRENGTH[item.verdict];
    if (s < 0) {
      counters += 1;
      continue;
    }
    if (s === 0) continue;
    const prev = groups.get(item.independenceGroup) ?? 0;
    if (s > prev) groups.set(item.independenceGroup, s);
  }
  let supports = 0;
  for (const v of groups.values()) supports += v;
  return { supports: Math.round(supports * 100) / 100, counters };
}

export function runSetRoute(
  assessments: CandidateAssessment[],
  thresholds: SetRouteThresholds,
  stormEvent: boolean,
): SetRouteResult {
  const inSet: string[] = [];
  const excluded: { candidateId: string; reasons: string[] }[] = [];
  const notes: string[] = [];
  let stormParallelApplied = false;

  for (const a of assessments.filter((x) => !x.revoked)) {
    if (!a.timeBandCompatible) {
      excluded.push({ candidateId: a.candidateId, reasons: [a.excludeReason ?? '时间带不相容'] });
      continue;
    }
    const { supports, counters } = independentSupports(a);
    const reasons: string[] = [];
    if (counters > thresholds.maxStrongCounters) reasons.push(`独立反证 ${counters} 项 > 门槛 ${thresholds.maxStrongCounters}`);
    if (supports < thresholds.minIndependentSupports)
      reasons.push(`独立支持 ${supports} < 门槛 ${thresholds.minIndependentSupports}`);
    if (a.completeness < thresholds.minCompleteness)
      reasons.push(`完整度 ${a.completeness.toFixed(2)} < 门槛 ${thresholds.minCompleteness}`);
    const hasCounter = counters > 0;
    if (reasons.length === 0) {
      inSet.push(a.candidateId);
    } else if (stormEvent && !hasCounter && supports > 0) {
      // 暴雨规则：无独立反证、仅因支持数/完整度不足的候选保留并列
      inSet.push(a.candidateId);
      stormParallelApplied = true;
      notes.push(
        `${a.sourceName}：${reasons.join('；')}，但暴雨事件期间无独立反证的候选必须保留并列，按暴雨规则纳入集合。`,
      );
    } else {
      excluded.push({ candidateId: a.candidateId, reasons });
    }
  }
  if (stormEvent) {
    notes.push('暴雨事件：凡无独立反证的候选均保留并列，集合只按独立反证收敛，不按时间接近排除。');
  }
  return { route: 'SET', thresholds, inSet, excluded, stormParallelApplied, notes };
}

function toRanking(assessments: CandidateAssessment[]): RankEntry[] {
  return assessments
    .filter((a) => !a.revoked && a.timeBandCompatible)
    .map((a) => ({ candidateId: a.candidateId, score: a.score, completeness: a.completeness }))
    .sort((x, y) => y.score - x.score);
}

function decidability(
  ranking: RankEntry[],
  marginThreshold: number,
  completenessFloor: number,
): { decidable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (ranking.length === 0) return { decidable: false, reasons: ['没有通过时间带门槛的候选'] };
  if (ranking.length === 1) {
    if (ranking[0].completeness < completenessFloor) reasons.push(`唯一候选完整度 ${ranking[0].completeness.toFixed(2)} 低于下限 ${completenessFloor}`);
    return { decidable: reasons.length === 0, reasons };
  }
  const margin = ranking[0].score - ranking[1].score;
  if (margin < marginThreshold)
    reasons.push(`前两名分差 ${margin.toFixed(3)} < 拒答门槛 ${marginThreshold}，排序不可判定，保持并列`);
  if (ranking[0].completeness < completenessFloor)
    reasons.push(`首位候选完整度 ${ranking[0].completeness.toFixed(2)} 低于下限 ${completenessFloor}，关键证据缺测，排序不可判定`);
  return { decidable: reasons.length === 0, reasons };
}

function scenario(
  label: string,
  assessments: CandidateAssessment[],
  marginThreshold: number,
  completenessFloor: number,
  note: string,
): RankScenario {
  const ranking = toRanking(assessments);
  const { decidable, reasons } = decidability(ranking, marginThreshold, completenessFloor);
  return { label, ranking, decidable, undecidableReasons: reasons, note };
}

export interface RankRouteInput {
  registry: InvestigationRegistry;
  /** 自报更正前的登记簿快照（用于敏感性对比；无更正时为 null） */
  registryBeforeCorrection: InvestigationRegistry | null;
  event: OutfallEvent;
  assessments: CandidateAssessment[];
  marginThreshold: number;
  completenessFloor: number;
  rainErrorRelative: number;
  computedAt: number;
}

export function runRankRoute(input: RankRouteInput): RankRouteResult {
  const { event, assessments, marginThreshold, completenessFloor, rainErrorRelative, computedAt } = input;
  const ranking = toRanking(assessments);
  const { decidable, reasons } = decidability(ranking, marginThreshold, completenessFloor);

  // 敏感性①：自报更正（用更正前登记簿重放同一事件）
  let selfReportBefore: RankScenario | null = null;
  if (input.registryBeforeCorrection) {
    const before = assessCandidates(input.registryBeforeCorrection, event, { computedAt });
    selfReportBefore = scenario(
      '自报更正前（旧版本批次）',
      before,
      marginThreshold,
      completenessFloor,
      '以被撤销的自报批次版本重放评分；旧版本到达时的排序仅用于对比，已不作为有效结论。',
    );
  }

  // 敏感性②③：雨量误差 ±（按登记簿声明的相对误差界缩放）
  const minus = assessCandidates(input.registry, event, { rainScale: 1 - rainErrorRelative, computedAt });
  const plus = assessCandidates(input.registry, event, { rainScale: 1 + rainErrorRelative, computedAt });
  const rainfallMinus = scenario(
    `雨量 −${(rainErrorRelative * 100).toFixed(0)}%`,
    minus,
    marginThreshold,
    completenessFloor,
    '雨量按登记误差界下浮后重放评分，检验排序对雨量误差的敏感性。',
  );
  const rainfallPlus = scenario(
    `雨量 +${(rainErrorRelative * 100).toFixed(0)}%`,
    plus,
    marginThreshold,
    completenessFloor,
    '雨量按登记误差界上浮后重放评分。',
  );

  const notes: string[] = [
    `排序按 Σ证据贡献降序；前两名分差 < ${marginThreshold} 或首位完整度 < ${completenessFloor} 时输出“不可判定”，不强行排序。`,
    '每个贡献与缺测惩罚均可由候选详情的证据展开逐项回放。',
  ];
  if (!decidable) notes.push(`当前排序不可判定：${reasons.join('；')}。建议按集合路线发布并列候选。`);

  return {
    route: 'RANK',
    marginThreshold,
    completenessFloor,
    ranking,
    decidable,
    undecidableReasons: reasons,
    sensitivity: { selfReportBefore, rainfallMinus, rainfallPlus },
    notes,
  };
}
