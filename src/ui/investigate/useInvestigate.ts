/**
 * 事件调查状态：登记簿（全版本）、事件、候选评估、处置板、交付。
 * 计算路径：基础复核台日快照（Worker）→ 事件检测 → 水力召回 → 证据组合（主线程纯函数）。
 * 所有写操作落 IndexedDB 并记审计；刷新后从本地库恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DayLoadSnapshot } from '../../domain/types';
import type {
  CandidateAssessment,
  Delivery,
  Investigation,
  InvestigationRegistry,
  InvestigateManifest,
  OutfallEvent,
  RankRouteResult,
  SetRouteResult,
} from '../../investigate/types';
import { assessCandidates } from '../../investigate/evidence';
import { detectEvent } from '../../investigate/event';
import { currentRegistry } from '../../investigate/registry';
import { runRankRoute, runSetRoute } from '../../investigate/routes';
import {
  buildDelivery,
  currentAssessments,
  flagStaleRegistry,
  latestCorrection,
  newInvestigation,
  registryWithoutCorrection,
  revokeAssessmentsByBatch,
  supersedeOld,
  transitionInvestigation,
} from '../../investigate/service';
import {
  addAudit,
  allRegistryRecords,
  getMeta,
  listCandidates,
  listDeliveries,
  listEvents,
  listInvestigations,
  registryFromRecords,
  saveCandidates,
  saveDelivery,
  saveEvent,
  saveInvestigation,
  INVESTIGATE_KEY,
} from '../../db/db';
import {
  fetchInvestigateManifest,
  importSelfReportCorrection,
  importTopologyRevision,
  loadInvestigatePack,
} from '../../sample/loadInvestigate';
import { createWorkerClient, type WorkerClient } from '../../worker/client';
import type { AppActions, AppState } from '../useAppState';
import type { LoadProgress } from '../../sample/loadSample';

export interface InvestigateState {
  packLoaded: boolean;
  loading: boolean;
  progress: LoadProgress | null;
  manifest: InvestigateManifest | null;
  registryAll: InvestigationRegistry;
  event: OutfallEvent | null;
  candidatesAll: CandidateAssessment[];
  investigations: Investigation[];
  deliveries: Delivery[];
  computing: boolean;
}

export interface InvestigateActions {
  loadPack: () => Promise<void>;
  computeEvent: () => Promise<void>;
  importCorrection: () => Promise<void>;
  importTopology: () => Promise<void>;
  recomputeCandidates: () => Promise<void>;
  publish: (route: 'SET' | 'RANK') => Promise<void>;
  saveInvestigation: (inv: Investigation, auditAction: string, detail: string) => Promise<void>;
  transition: (inv: Investigation, next: Investigation['status'], exclusionReason?: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const EMPTY_REGISTRY: InvestigationRegistry = { sources: [], rainfall: [], pumpSwitches: [], selfReports: [], eventProfiles: [] };

export function useInvestigate(appState: AppState, appActions: AppActions): InvestigateHook {
  const workerRef = useRef<WorkerClient | null>(null);
  const [packLoaded, setPackLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [manifest, setManifest] = useState<InvestigateManifest | null>(null);
  const [registryAll, setRegistryAll] = useState<InvestigationRegistry>(EMPTY_REGISTRY);
  const [event, setEvent] = useState<OutfallEvent | null>(null);
  const [candidatesAll, setCandidatesAll] = useState<CandidateAssessment[]>([]);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [computing, setComputing] = useState(false);

  const toast = appActions.toast;

  const refresh = useCallback(async () => {
    const [records, events, mf, loaded] = await Promise.all([
      allRegistryRecords(),
      listEvents(),
      fetchInvestigateManifest().catch(() => null),
      getMeta<boolean>(INVESTIGATE_KEY),
    ]);
    const reg = records.length > 0 ? registryFromRecords(records) : EMPTY_REGISTRY;
    const ev = events[0] ?? null;
    const [cands, invs, dels] = ev
      ? await Promise.all([listCandidates(ev.eventId), listInvestigations(ev.eventId), listDeliveries(ev.eventId)])
      : [[], [], []];
    setRegistryAll(reg);
    setEvent(ev);
    setCandidatesAll(cands as CandidateAssessment[]);
    setInvestigations(invs as Investigation[]);
    setDeliveries(dels as Delivery[]);
    setManifest(mf);
    setPackLoaded(Boolean(loaded) || records.length > 0);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 事件检测 + 候选评估 + 落库（幂等：重复执行产生新版本评估，旧版本按规则撤销） */
  const computeEventWith = useCallback(
    async (dataset: AppState['dataset'], registry: InvestigationRegistry) => {
      if (!manifest) throw new Error('清单未装载');
      setComputing(true);
      try {
        if (!workerRef.current) workerRef.current = createWorkerClient();
        const snapshot = await workerRef.current.request<DayLoadSnapshot>({
          type: 'computeDay',
          dataset,
          pointCode: manifest.event.pointCode,
          day: manifest.event.day,
          method: 'SEGMENT',
          scope: appState.scope,
          withChart: false,
        });
        const now = Date.now();
        const ev = detectEvent({
          dataset,
          snapshot,
          pointCode: manifest.event.pointCode,
          day: manifest.event.day,
          eventProfiles: registry.eventProfiles,
          computedAt: now,
        });
        if (!ev) throw new Error('未检出高氨氮事件（当日无氨氮阈值穿越）');
        const assessments = assessCandidates(currentRegistry(registry), ev, { computedAt: now });
        await saveEvent(ev);
        await saveCandidates(assessments);
        const existing = await listInvestigations(ev.eventId);
        for (const a of assessments) {
          if (!existing.some((i) => i.sourceId === a.sourceId)) {
            await saveInvestigation(newInvestigation(ev.eventId, a, now));
          }
        }
        await addAudit({
          at: now,
          actor: appState.actor,
          action: 'COMPUTE_EVENT',
          detail: `事件 ${ev.eventId}：窗口 ${ev.windowFrom}–${ev.windowTo}，召回 ${assessments.length} 个候选（${assessments.filter((a) => a.timeBandCompatible).length} 个通过时间带门槛）`,
          refIds: [ev.eventId, ...assessments.map((a) => a.candidateId)],
        });
        return ev;
      } finally {
        setComputing(false);
      }
    },
    [appState.actor, appState.scope, manifest],
  );

  const loadPack = useCallback(async () => {
    if (appState.dataset.points.length === 0) {
      toast('warn', '请先在「概览」页装载基础样例资料');
      return;
    }
    setLoading(true);
    setProgress({ step: '准备', done: 0, total: 1 });
    try {
      const loaded = await loadInvestigatePack(appState.dataset, (p) => setProgress(p), appState.actor);
      await addAudit({
        at: Date.now(),
        actor: appState.actor,
        action: 'LOAD_INVESTIGATE_PACK',
        detail: `装载调查资料包：${loaded.registry.sources.length} 个来源、${loaded.registry.selfReports.length} 个自报批次、${loaded.registry.rainfall.length} 个雨量序列；指纹 ${loaded.fingerprintMatches.filter((f) => f.ok).length}/${loaded.fingerprintMatches.length} 匹配`,
        refIds: loaded.fingerprintMatches.map((f) => f.fileName),
      });
      if (loaded.warnings.length > 0) toast('warn', loaded.warnings.join('；'));
      await appActions.reload();
      const ev = await computeEventWith(loaded.dataset, loaded.registry);
      toast('success', `调查资料包已装载：检出事件 ${ev.eventId.slice(0, 40)}…，候选 ${await listCandidates(ev.eventId).then((c) => c.length)} 个`);
      await refresh();
    } catch (error) {
      toast('error', `装载调查资料包失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [appActions, appState.actor, appState.dataset, computeEventWith, refresh, toast]);

  const computeEvent = useCallback(async () => {
    if (appState.dataset.points.length === 0 || registryAll.sources.length === 0) {
      toast('warn', '请先装载调查资料包');
      return;
    }
    try {
      await computeEventWith(appState.dataset, registryAll);
      toast('success', '事件与候选已按现行登记簿重算');
      await refresh();
    } catch (error) {
      toast('error', `事件重算失败：${(error as Error).message}`);
    }
  }, [appState.dataset, registryAll, computeEventWith, refresh, toast]);

  const importCorrection = useCallback(async () => {
    if (!event) {
      toast('warn', '请先装载资料包并检出事件');
      return;
    }
    setLoading(true);
    try {
      const { registry, revokedIds, fingerprint } = await importSelfReportCorrection(registryAll, appState.actor);
      if (!fingerprint.ok) toast('warn', '更正批次指纹与清单不一致');
      // ① 按版本撤销旧评分
      const old = await listCandidates(event.eventId);
      const revokedMarked = revokeAssessmentsByBatch(old, revokedIds);
      await saveCandidates(revokedMarked);
      // ② 用更正后登记簿重算
      const now = Date.now();
      const fresh = assessCandidates(currentRegistry(registry), event, { computedAt: now });
      await saveCandidates(fresh);
      await addAudit({
        at: now,
        actor: appState.actor,
        action: 'SELF_REPORT_CORRECTION',
        detail: `自报更正到达：撤销批次 ${revokedIds.join('，')}，依据旧批次的评分已按版本撤销并重算`,
        refIds: revokedIds,
      });
      toast('success', `自报更正已入库：撤销 ${revokedIds.join('，')}，旧评分已按版本撤销`);
      await refresh();
    } catch (error) {
      toast('error', `导入自报更正失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [appState.actor, event, registryAll, refresh, toast]);

  const importTopology = useCallback(async () => {
    if (!event) {
      toast('warn', '请先装载资料包并检出事件');
      return;
    }
    setLoading(true);
    try {
      const { registry, revokedIds, fingerprint } = await importTopologyRevision(registryAll, appState.actor);
      if (!fingerprint.ok) toast('warn', '拓扑修订指纹与清单不一致');
      // 已关闭调查不改写；未关闭的标记 staleRegistry
      const invs = await listInvestigations(event.eventId);
      const flagged = flagStaleRegistry(invs);
      for (const inv of flagged) {
        if (inv.staleRegistry !== invs.find((i) => i.investigationId === inv.investigationId)?.staleRegistry) {
          await saveInvestigation(inv);
        }
      }
      await addAudit({
        at: Date.now(),
        actor: appState.actor,
        action: 'TOPOLOGY_REVISION',
        detail: `拓扑修订：撤销 ${revokedIds.join('，')}；已关闭调查保持原快照，未关闭调查标记“登记簿已修订”`,
        refIds: revokedIds,
      });
      toast('success', `拓扑修订已入库：撤销 ${revokedIds.join('，')}；已关闭调查未被改写`);
      void registry;
      await refresh();
    } catch (error) {
      toast('error', `导入拓扑修订失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [appState.actor, event, registryAll, refresh, toast]);

  const recomputeCandidates = useCallback(async () => {
    if (!event || registryAll.sources.length === 0) return;
    try {
      const now = Date.now();
      const fresh = assessCandidates(currentRegistry(registryAll), event, { computedAt: now });
      await saveCandidates(fresh);
      await addAudit({
        at: now,
        actor: appState.actor,
        action: 'RECOMPUTE_CANDIDATES',
        detail: `按现行登记簿重算候选（${fresh.length} 个）`,
        refIds: fresh.map((f) => f.candidateId),
      });
      toast('success', '候选已按现行登记簿重算');
      await refresh();
    } catch (error) {
      toast('error', `重算失败：${(error as Error).message}`);
    }
  }, [appState.actor, event, registryAll, refresh, toast]);

  const current = useMemo(() => currentAssessments(candidatesAll), [candidatesAll]);

  const setResult: SetRouteResult | null = useMemo(() => {
    if (!manifest || !event || current.length === 0) return null;
    return runSetRoute(
      current,
      {
        minIndependentSupports: manifest.setRoute.minIndependentSupports,
        maxStrongCounters: manifest.setRoute.maxStrongCounters,
        minCompleteness: manifest.setRoute.minCompleteness,
        declaredAt: Date.parse(manifest.setRoute.declaredAt),
        declaredBy: manifest.setRoute.declaredBy,
        note: manifest.setRoute.note,
      },
      event.stormEvent,
    );
  }, [current, event, manifest]);

  const rankResult: RankRouteResult | null = useMemo(() => {
    if (!manifest || !event || current.length === 0) return null;
    const correctionId = latestCorrection(registryAll);
    const before = correctionId ? registryWithoutCorrection(registryAll, correctionId) : null;
    return runRankRoute({
      registry: currentRegistry(registryAll),
      registryBeforeCorrection: before ? currentRegistry(before) : null,
      event,
      assessments: current,
      marginThreshold: manifest.rankRoute.marginThreshold,
      completenessFloor: manifest.rankRoute.completenessFloor,
      rainErrorRelative: registryAll.rainfall.filter((r) => !r.revoked)[0]?.errorRelative ?? 0.15,
      computedAt: Date.now(),
    });
  }, [current, event, manifest, registryAll]);

  const publish = useCallback(
    async (route: 'SET' | 'RANK') => {
      if (!event || !setResult || !rankResult) {
        toast('warn', '请先完成事件与候选计算');
        return;
      }
      try {
        const now = Date.now();
        const refs = [...new Map(current.flatMap((c) => c.registryRefs).map((r) => [r.recordId, r])).values()];
        const delivery = await buildDelivery({
          eventId: event.eventId,
          route,
          createdAt: now,
          createdBy: appState.actor,
          setResult: route === 'SET' ? setResult : null,
          rankResult: route === 'RANK' ? rankResult : null,
          candidates: current,
          registryRefs: refs,
        });
        // 同事件同路线旧交付标记被取代（内容保留）
        const updated = supersedeOld(deliveries, event.eventId, route, delivery.deliveryId);
        for (const d of updated.filter((d) => d.status === 'SUPERSEDED' && deliveries.find((o) => o.deliveryId === d.deliveryId)?.status === 'PUBLISHED')) {
          await saveDelivery(d);
        }
        await saveDelivery(delivery);
        toast('success', `已发布${route === 'SET' ? '集合' : '排序'}交付（仅调查优先级，非责任结论）`);
        await refresh();
      } catch (error) {
        toast('error', `发布交付失败：${(error as Error).message}`);
      }
    },
    [appState.actor, current, deliveries, event, rankResult, refresh, setResult, toast],
  );

  const saveInvestigationAction = useCallback(
    async (inv: Investigation, auditAction: string, detail: string) => {
      await saveInvestigation(inv);
      await addAudit({ at: Date.now(), actor: appState.actor, action: auditAction, detail, refIds: [inv.investigationId] });
      await refresh();
    },
    [appState.actor, refresh],
  );

  const transition = useCallback(
    async (inv: Investigation, next: Investigation['status'], exclusionReason?: string) => {
      const candidate = current.find((c) => c.sourceId === inv.sourceId);
      const result = transitionInvestigation(inv, next, appState.actor, Date.now(), { exclusionReason, candidate });
      if (!result.ok) {
        toast('warn', result.error ?? '状态流转被拒绝');
        return;
      }
      await saveInvestigation(result.investigation);
      await addAudit({
        at: Date.now(),
        actor: appState.actor,
        action: 'INVESTIGATION_TRANSITION',
        detail: `${inv.sourceId}：${inv.status} → ${next}${exclusionReason ? `（${exclusionReason}）` : ''}`,
        refIds: [inv.investigationId],
      });
      toast('success', next === 'CLOSED' || next === 'EXCLUDED' ? '调查已关闭，快照已冻结（拓扑修订不改写）' : '状态已更新');
      await refresh();
    },
    [appState.actor, current, refresh, toast],
  );

  const inv: InvestigateState = {
    packLoaded,
    loading,
    progress,
    manifest,
    registryAll,
    event,
    candidatesAll,
    investigations,
    deliveries,
    computing,
  };
  const invActions: InvestigateActions = {
    loadPack,
    computeEvent,
    importCorrection,
    importTopology,
    recomputeCandidates,
    publish,
    saveInvestigation: saveInvestigationAction,
    transition,
    refresh,
  };
  return { inv, invActions, derived: { setResult, rankResult, current } };
}

export interface InvestigateDerived {
  setResult: SetRouteResult | null;
  rankResult: RankRouteResult | null;
  current: CandidateAssessment[];
}

export type InvestigateHook = {
  inv: InvestigateState;
  invActions: InvestigateActions;
  derived: InvestigateDerived;
};

export type { SetRouteResult, RankRouteResult, CandidateAssessment };
