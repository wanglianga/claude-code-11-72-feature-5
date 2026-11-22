/**
 * 调查编排服务：交付组装（内容哈希）、调查处置板状态机、版本撤销规则。
 *
 * 不变量：
 * - 交付一旦发布不可改写；更正/修订只能产生新版本交付并 supersede 旧版本。
 * - 自报批次更正按版本撤销旧评分：依据被撤销批次的评估标记 revoked，保留追溯。
 * - 拓扑修订不改写已关闭调查：已关闭/已排除的调查保留关闭快照，内容不变。
 */

import { sha256Hex } from '../sample/csv';
import type {
  CandidateAssessment,
  Delivery,
  DeliveryRoute,
  Investigation,
  InvestigationRegistry,
  InvestigationStatus,
  RankRouteResult,
  RegistryRef,
  SetRouteResult,
} from './types';
import { DELIVERY_DISCLAIMER } from './types';

/** 确定性 JSON（键排序），用于内容哈希 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export interface BuildDeliveryInput {
  eventId: string;
  route: DeliveryRoute;
  createdAt: number;
  createdBy: string;
  setResult: SetRouteResult | null;
  rankResult: RankRouteResult | null;
  candidates: CandidateAssessment[];
  registryRefs: RegistryRef[];
}

export async function buildDelivery(input: BuildDeliveryInput): Promise<Delivery> {
  const core = {
    eventId: input.eventId,
    route: input.route,
    setResult: input.setResult,
    rankResult: input.rankResult,
    candidates: input.candidates.map((c) => ({
      candidateId: c.candidateId,
      sourceId: c.sourceId,
      score: c.score,
      completeness: c.completeness,
      timeBandCompatible: c.timeBandCompatible,
      items: c.items.map((it) => ({
        dim: it.dim,
        verdict: it.verdict,
        weight: it.weight,
        contribution: it.contribution,
        completenessLoss: it.completenessLoss,
        basisRecordIds: it.basisRecordIds,
      })),
    })),
    registryRefs: input.registryRefs,
    disclaimer: DELIVERY_DISCLAIMER,
  };
  const contentHash = await sha256Hex(canonicalize(core));
  return {
    deliveryId: `DEL-${input.eventId}-${input.route}-${input.createdAt}`,
    eventId: input.eventId,
    route: input.route,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    status: 'PUBLISHED',
    supersededBy: null,
    setResult: input.setResult,
    rankResult: input.rankResult,
    candidates: input.candidates,
    registryRefs: input.registryRefs,
    disclaimer: DELIVERY_DISCLAIMER,
    contentHash,
  };
}

/** 同事件同路线的旧交付全部标记为被取代（内容保留，可回放） */
export function supersedeOld(deliveries: Delivery[], eventId: string, route: DeliveryRoute, newId: string): Delivery[] {
  return deliveries.map((d) =>
    d.eventId === eventId && d.route === route && d.status === 'PUBLISHED'
      ? { ...d, status: 'SUPERSEDED' as const, supersededBy: newId }
      : d,
  );
}

/** 自报更正：依据被撤销批次的评估一律标记 revoked（旧评分撤销，内容保留） */
export function revokeAssessmentsByBatch(assessments: CandidateAssessment[], revokedBatchIds: string[]): CandidateAssessment[] {
  const revoked = new Set(revokedBatchIds);
  return assessments.map((a) => (a.selfReportRecordId && revoked.has(a.selfReportRecordId) ? { ...a, revoked: true } : a));
}

/** 自报更正前的登记簿视图：移除更正批次、恢复其取代的旧批次 */
export function registryWithoutCorrection(all: InvestigationRegistry, correctionRecordId: string): InvestigationRegistry | null {
  const correction = all.selfReports.find((b) => b.recordId === correctionRecordId);
  if (!correction || !correction.supersedes) return null;
  return {
    ...all,
    selfReports: all.selfReports
      .filter((b) => b.recordId !== correctionRecordId)
      .map((b) => (b.recordId === correction.supersedes ? { ...b, revoked: false } : b)),
  };
}

/** 找到最近应用的自报更正批次（有 supersedes 且未撤销、版本最高） */
export function latestCorrection(all: InvestigationRegistry): string | null {
  const corrections = all.selfReports
    .filter((b) => b.supersedes && !b.revoked)
    .sort((a, b) => b.receivedAt - a.receivedAt);
  return corrections[0]?.recordId ?? null;
}

export function newInvestigation(eventId: string, candidate: CandidateAssessment, now: number): Investigation {
  return {
    investigationId: `INV-${eventId}-${candidate.sourceId}`,
    eventId,
    candidateId: candidate.candidateId,
    sourceId: candidate.sourceId,
    status: 'PENDING',
    todos: [],
    samplings: [],
    exclusionReason: null,
    history: [{ at: now, by: '系统', action: 'CREATE', detail: `候选生成，待核查（评分 ${candidate.score.toFixed(3)}，完整度 ${candidate.completeness.toFixed(2)}）` }],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedSnapshot: null,
    staleRegistry: false,
  };
}

/** 现行候选视图：每个来源取计算时刻最新的未撤销评估 */
export function currentAssessments(all: CandidateAssessment[]): CandidateAssessment[] {
  const map = new Map<string, CandidateAssessment>();
  for (const a of all) {
    if (a.revoked) continue;
    const prev = map.get(a.sourceId);
    if (!prev || a.computedAt > prev.computedAt) map.set(a.sourceId, a);
  }
  return [...map.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export interface TransitionResult {
  ok: boolean;
  investigation: Investigation;
  error?: string;
}

/** 处置板状态机：PENDING ↔ SAMPLING → EXCLUDED / CLOSED；关闭需取样记录或排除理由 */
export function transitionInvestigation(
  inv: Investigation,
  next: InvestigationStatus,
  actor: string,
  now: number,
  opts: { exclusionReason?: string; candidate?: CandidateAssessment },
): TransitionResult {
  const terminal = inv.status === 'EXCLUDED' || inv.status === 'CLOSED';
  if (terminal && next !== 'PENDING') {
    return { ok: false, investigation: inv, error: '已关闭/已排除的调查只能重新打开为待核查' };
  }
  if (next === 'EXCLUDED' && !opts.exclusionReason?.trim() && !inv.exclusionReason) {
    return { ok: false, investigation: inv, error: '标记排除必须填写排除理由' };
  }
  if (next === 'CLOSED' && inv.samplings.length === 0 && !inv.exclusionReason && !opts.exclusionReason?.trim()) {
    return { ok: false, investigation: inv, error: '关闭调查需至少一条取样记录或排除理由' };
  }
  const updated: Investigation = {
    ...inv,
    status: next,
    updatedAt: now,
    exclusionReason: next === 'EXCLUDED' ? (opts.exclusionReason ?? inv.exclusionReason) : inv.exclusionReason,
    history: [
      ...inv.history,
      {
        at: now,
        by: actor,
        action: next === 'PENDING' && terminal ? 'REOPEN' : 'TRANSITION',
        detail: `${inv.status} → ${next}${opts.exclusionReason ? `：${opts.exclusionReason}` : ''}`,
      },
    ],
  };
  if (next === 'CLOSED' || next === 'EXCLUDED') {
    updated.closedAt = now;
    updated.closedSnapshot = {
      score: opts.candidate?.score ?? 0,
      completeness: opts.candidate?.completeness ?? 0,
      registryRefs: opts.candidate?.registryRefs ?? [],
      note: '关闭时刻的评分与登记簿版本快照；此后的拓扑修订不改写本调查。',
    };
    updated.staleRegistry = false;
  }
  if (next === 'PENDING') {
    // 重新打开不清空快照，保留追溯
    updated.closedAt = null;
  }
  return { ok: true, investigation: updated };
}

/** 拓扑修订后：未关闭调查标记 staleRegistry；已关闭/已排除的保持原样 */
export function flagStaleRegistry(investigations: Investigation[]): Investigation[] {
  return investigations.map((inv) => {
    const terminal = inv.status === 'EXCLUDED' || inv.status === 'CLOSED';
    return terminal ? inv : { ...inv, staleRegistry: true };
  });
}
