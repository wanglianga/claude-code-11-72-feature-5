import { describe, expect, it } from 'vitest';
import type {
  CandidateAssessment,
  InvestigationRegistry,
  OutfallEvent,
  SourceRegistration,
} from '../src/investigate/types';
import { assessCandidates } from '../src/investigate/evidence';
import { recallCandidates, recallOverlaps } from '../src/investigate/candidates';
import { independentSupports, runRankRoute, runSetRoute } from '../src/investigate/routes';
import { applyCorrection, applyTopologyRevision, currentRegistry } from '../src/investigate/registry';
import {
  buildDelivery,
  canonicalize,
  currentAssessments,
  flagStaleRegistry,
  newInvestigation,
  registryWithoutCorrection,
  revokeAssessmentsByBatch,
  supersedeOld,
  transitionInvestigation,
} from '../src/investigate/service';

const D0 = Date.UTC(2026, 10, 20) - 8 * 3_600_000;
const H = 3_600_000;
const M = 60_000;
const at = (h: number, m = 0) => D0 + h * H + m * M;

function makeSource(over: Partial<SourceRegistration> = {}): SourceRegistration {
  return {
    recordId: 'SRC-X@v1',
    sourceId: 'SRC-X',
    kind: 'INDUSTRIAL_BRANCH',
    name: '测试支管',
    version: 1,
    trustLevel: 'B',
    registeredAt: at(8),
    revoked: false,
    supersedes: null,
    access: { sewerId: 'SW-1', chainageM: 1000, travelTimeS: [300, 600] },
    allowed: { kind: 'DAILY', fromMin: 360, toMin: 1320 },
    envelope: { nh3n: [3, 8], cod: [4, 16], cond: [60, 240], ph: [-0.2, 0.3] },
    typicalFlowM3h: [25, 45],
    note: '',
    ...over,
  };
}

function makeEvent(over: Partial<OutfallEvent> = {}): OutfallEvent {
  return {
    eventId: 'EVT-T',
    pointCode: 'CC-E01',
    day: '2026-11-20',
    pollutant: 'NH3N',
    windowFrom: at(14, 32),
    windowTo: at(14, 41),
    peakConcentration: 9.2,
    peakAt: at(14, 36),
    standard: 5,
    observed: { nh3n: [4.4, 5.8], cod: [7.6, 11.4], cond: [62, 86], ph: [-0.32, -0.08], flowM3h: [150, 210] },
    observedBasis: {},
    stormEvent: true,
    computedAt: at(20),
    engineVersion: '1.1.0',
    ...over,
  };
}

function registryOf(parts: Partial<InvestigationRegistry>): InvestigationRegistry {
  return { sources: [], rainfall: [], pumpSwitches: [], selfReports: [], eventProfiles: [], ...parts };
}

describe('水力候选生成器', () => {
  it('无泵站切换：单一倒推窗口 = 事件窗口平移传播时间', () => {
    const event = makeEvent();
    const [r] = recallCandidates(registryOf({ sources: [makeSource()] }), event);
    expect(r.recall.regimes).toHaveLength(1);
    expect(r.recall.dischargeWindow.from).toBe(at(14, 32) - 600_000);
    expect(r.recall.dischargeWindow.to).toBe(at(14, 41) - 300_000);
    expect(r.recall.pumpSwitchMidEvent).toBe(false);
  });

  it('泵站中途切换：按排放时刻体制裁剪，切换前窗口可裁空', () => {
    const event = makeEvent();
    const registry = registryOf({
      sources: [makeSource()],
      pumpSwitches: [
        {
          recordId: 'PSW-1@v1',
          switchId: 'PSW-1',
          stationId: 'PS-2',
          stationName: '城西泵站',
          at: at(14, 10),
          fromMode: '直排',
          toMode: '截流',
          affects: [{ sewerId: 'SW-1', travelTimeAfterS: [840, 1320] }],
          version: 1,
          trustLevel: 'A',
          revoked: false,
          note: '',
        },
      ],
    });
    const [r] = recallCandidates(registry, event);
    expect(r.recall.pumpSwitchMidEvent).toBe(true);
    // 切换前体制（τ300–600）倒推窗口 14:22–14:36 全部在 14:10 之后 → 裁空
    expect(r.recall.regimes[0].dischargeWindow).toBeNull();
    // 切换后体制（τ840–1320）窗口 14:10–14:27，裁剪到 ≥14:10
    const after = r.recall.regimes[1].dischargeWindow!;
    expect(after.from).toBe(at(14, 32) - 1320_000);
    expect(after.to).toBe(at(14, 41) - 840_000);
    expect(after.from).toBeGreaterThanOrEqual(at(14, 10));
  });

  it('recallOverlaps 逐体制判定', () => {
    const event = makeEvent();
    const [r] = recallCandidates(registryOf({ sources: [makeSource()] }), event);
    expect(recallOverlaps(r.recall, at(14, 25), at(14, 30))).toBe(true);
    expect(recallOverlaps(r.recall, at(13, 0), at(13, 30))).toBe(false);
    expect(recallOverlaps(r.recall, null, null)).toBe(false);
  });
});

describe('证据组合器', () => {
  it('特征维度：相容/弱相容/反证/缺测', () => {
    const event = makeEvent();
    const strong = makeSource();
    const weak = makeSource({ recordId: 'SRC-W@v1', sourceId: 'SRC-W', envelope: { nh3n: [5.5, 9], cod: null, cond: null, ph: null } });
    const contra = makeSource({ recordId: 'SRC-C@v1', sourceId: 'SRC-C', envelope: { nh3n: [9, 12], cod: null, cond: null, ph: null } });
    const registry = registryOf({ sources: [strong, weak, contra] });
    const out = assessCandidates(registry, event, { computedAt: at(20) });
    const a = out.find((c) => c.sourceId === 'SRC-X')!;
    const w = out.find((c) => c.sourceId === 'SRC-W')!;
    const c = out.find((c) => c.sourceId === 'SRC-C')!;
    expect(a.items.find((i) => i.dim === 'NH3N')!.verdict).toBe('STRONG_MATCH');
    // 观测 [4.4,5.8] 与包络 [5.5,9] 重叠 0.3/1.4 ≈ 0.21 → 弱相容
    expect(w.items.find((i) => i.dim === 'NH3N')!.verdict).toBe('WEAK_MATCH');
    // 观测与 [9,12] 不相交 → 反证
    expect(c.items.find((i) => i.dim === 'NH3N')!.verdict).toBe('CONTRADICT');
    // 包络为 null → 缺测，只计缺失惩罚
    const missing = w.items.find((i) => i.dim === 'COD')!;
    expect(missing.verdict).toBe('MISSING');
    expect(missing.contribution).toBe(0);
    expect(missing.completenessLoss).toBeCloseTo(0.12, 6);
  });

  it('自报否认是反证且乘可信系数；无批次记缺测', () => {
    const event = makeEvent();
    const src = makeSource();
    const denied = assessCandidates(
      registryOf({
        sources: [src],
        selfReports: [
          {
            recordId: 'SR-X-v1',
            batchId: 'SR-X-v1',
            sourceId: 'SRC-X',
            version: 1,
            trustLevel: 'B',
            receivedAt: at(18),
            revoked: false,
            supersedes: null,
            claims: [{ kind: 'NO_DISCHARGE', from: at(0), to: at(24), flowM3h: null, text: '全天未排放' }],
            note: '',
          },
        ],
      }),
      event,
      { computedAt: at(20) },
    )[0];
    const self = denied.items.find((i) => i.dim === 'SELF_REPORT')!;
    expect(self.verdict).toBe('CONTRADICT');
    expect(self.contribution).toBeCloseTo(-0.16 * 0.75 * 0.8, 6);
    const noBatch = assessCandidates(registryOf({ sources: [src] }), event, { computedAt: at(20) })[0];
    expect(noBatch.items.find((i) => i.dim === 'SELF_REPORT')!.verdict).toBe('MISSING');
  });

  it('雨量维度：≥2×阈值相容、≥阈值弱相容、<阈值反证；雨量缩放改变判定', () => {
    const event = makeEvent();
    const cso = makeSource({
      recordId: 'SRC-R@v1',
      sourceId: 'SRC-R',
      kind: 'CSO_OVERFLOW',
      allowed: { kind: 'RAIN_TRIGGERED', thresholdMmH: 18 },
      envelope: { nh3n: [2, 6.5], cod: null, cond: null, ph: null },
    });
    const rain = {
      recordId: 'RG@v1',
      seriesId: 'RG',
      gaugeId: 'RG-1',
      version: 1,
      trustLevel: 'A' as const,
      revoked: false,
      from: at(14, 20),
      to: at(14, 35),
      stepSeconds: 300,
      mmPerStep: [3.5, 3.5, 3.5], // 42 mm/h
      errorRelative: 0.15,
      note: '',
    };
    const base = assessCandidates(registryOf({ sources: [cso], rainfall: [rain] }), event, { computedAt: at(20) })[0];
    expect(base.items.find((i) => i.dim === 'RAINFALL')!.verdict).toBe('STRONG_MATCH');
    const scaled = assessCandidates(registryOf({ sources: [cso], rainfall: [rain] }), event, {
      rainScale: 0.8, // 42 → 33.6 < 36 = 2×18
      computedAt: at(20),
    })[0];
    expect(scaled.items.find((i) => i.dim === 'RAINFALL')!.verdict).toBe('WEAK_MATCH');
    const dry = assessCandidates(registryOf({ sources: [cso], rainfall: [rain] }), event, {
      rainScale: 0.3, // 12.6 < 18 → 反证，且时间带不相容
      computedAt: at(20),
    })[0];
    expect(dry.timeBandCompatible).toBe(false);
  });

  it('时间带门槛：允许时段不相交则排除且不计分', () => {
    const event = makeEvent();
    const night = makeSource({ allowed: { kind: 'DAILY', fromMin: 0, toMin: 360 } }); // 00:00–06:00
    const out = assessCandidates(registryOf({ sources: [night] }), event, { computedAt: at(20) })[0];
    expect(out.timeBandCompatible).toBe(false);
    expect(out.excludeReason).toContain('不相交');
    expect(out.score).toBe(0);
  });
});

describe('两条发布路线', () => {
  function assessed(): CandidateAssessment[] {
    const event = makeEvent();
    const a = makeSource();
    const b = makeSource({
      recordId: 'SRC-B@v1',
      sourceId: 'SRC-B',
      kind: 'CSO_OVERFLOW',
      allowed: { kind: 'RAIN_TRIGGERED', thresholdMmH: 18 },
      envelope: { nh3n: [2, 6.5], cod: [10, 45], cond: null, ph: [-0.5, -0.05] },
    });
    const registry = registryOf({
      sources: [a, b],
      rainfall: [
        {
          recordId: 'RG@v1',
          seriesId: 'RG',
          gaugeId: 'RG-1',
          version: 1,
          trustLevel: 'A',
          revoked: false,
          from: at(14, 20),
          to: at(14, 35),
          stepSeconds: 300,
          mmPerStep: [3.5, 3.5, 3.5],
          errorRelative: 0.15,
          note: '',
        },
      ],
      selfReports: [
        {
          recordId: 'SR-A-v2',
          batchId: 'SR-A-v2',
          sourceId: 'SRC-X',
          version: 2,
          trustLevel: 'B',
          receivedAt: at(19),
          revoked: false,
          supersedes: 'SR-A-v1',
          claims: [{ kind: 'DISCHARGE', from: at(14, 2), to: at(14, 31), flowM3h: [32, 38], text: '排放 35 m³/h' }],
          note: '',
        },
        {
          recordId: 'SR-B-v1',
          batchId: 'SR-B-v1',
          sourceId: 'SRC-B',
          version: 1,
          trustLevel: 'B',
          receivedAt: at(19),
          revoked: false,
          supersedes: null,
          claims: [{ kind: 'OVERFLOW', from: at(14, 5), to: at(14, 55), flowM3h: [380, 520], text: '溢流' }],
          note: '',
        },
      ],
    });
    return assessCandidates(registry, event, { computedAt: at(20) });
  }

  it('独立支持数：同一自报批次的流量与自报维度不重复计', () => {
    const out = assessed();
    const a = out.find((c) => c.sourceId === 'SRC-X')!;
    const s = independentSupports(a);
    // NH3N 1 + COD 1 + COND 1 + PH 0.5 + SELF 组 1 = 4.5
    expect(s.supports).toBeCloseTo(4.5, 6);
    expect(s.counters).toBe(0);
  });

  it('集合路线：门槛判定 + 暴雨并列规则', () => {
    const out = assessed();
    const thresholds = {
      minIndependentSupports: 3,
      maxStrongCounters: 0,
      minCompleteness: 0.6,
      declaredAt: at(8).valueOf(),
      declaredBy: '调度中心',
      note: '',
    };
    const res = runSetRoute(out, thresholds, true);
    expect(res.inSet).toHaveLength(2);
    // 门槛抬高到 5：两者（均 4.5）都不满足但无反证 → 暴雨规则保留并列
    const strict = runSetRoute(out, { ...thresholds, minIndependentSupports: 5 }, true);
    expect(strict.inSet.length).toBe(2);
    expect(strict.stormParallelApplied).toBe(true);
    // 非暴雨事件：严格门槛 → 无并列保护，集合为空
    const noStorm = runSetRoute(out, { ...thresholds, minIndependentSupports: 5 }, false);
    expect(noStorm.inSet.length).toBe(0);
  });

  it('排序路线：分差不足输出不可判定；完整度过低也不可判定', () => {
    const out = assessed();
    const event = makeEvent();
    const rank = runRankRoute({
      registry: registryOf({}),
      registryBeforeCorrection: null,
      event,
      assessments: out,
      marginThreshold: 0.05,
      completenessFloor: 0.6,
      rainErrorRelative: 0.15,
      computedAt: at(20),
    });
    // A ≈ 0.758 vs B ≈ 0.748 → 分差 0.01 < 0.05 → 不可判定
    expect(rank.decidable).toBe(false);
    expect(rank.undecidableReasons.join('')).toContain('不可判定');
    const wide = runRankRoute({
      registry: registryOf({}),
      registryBeforeCorrection: null,
      event,
      assessments: out,
      marginThreshold: 0.001,
      completenessFloor: 0.6,
      rainErrorRelative: 0.15,
      computedAt: at(20),
    });
    expect(wide.decidable).toBe(true);
    expect(wide.ranking[0].score).toBeGreaterThan(wide.ranking[1].score);
  });
});

describe('版本撤销与调查保护', () => {
  it('自报更正按版本撤销旧批次与旧评分', () => {
    const registry = registryOf({
      selfReports: [
        {
          recordId: 'SR-A-v1',
          batchId: 'SR-A-v1',
          sourceId: 'SRC-A',
          version: 1,
          trustLevel: 'B',
          receivedAt: at(18),
          revoked: false,
          supersedes: null,
          claims: [{ kind: 'NO_DISCHARGE', from: at(0), to: at(24), flowM3h: null, text: '未排放' }],
          note: '',
        },
      ],
    });
    const correction = {
      recordId: 'SR-A-v2',
      batchId: 'SR-A-v2',
      sourceId: 'SRC-A',
      version: 2,
      trustLevel: 'B' as const,
      receivedAt: at(20),
      revoked: false,
      supersedes: 'SR-A-v1',
      claims: [{ kind: 'DISCHARGE' as const, from: at(14), to: at(14, 30), flowM3h: [32, 38] as [number, number], text: '更正' }],
      note: '',
    };
    const { registry: after, revokedIds } = applyCorrection(registry, correction);
    expect(revokedIds).toEqual(['SR-A-v1']);
    expect(currentRegistry(after).selfReports[0].recordId).toBe('SR-A-v2');
    // 更正前视图可回放
    const before = registryWithoutCorrection(after, 'SR-A-v2')!;
    expect(currentRegistry(before).selfReports[0].recordId).toBe('SR-A-v1');
    // 旧评分撤销
    const assessments = [
      { candidateId: 'C1', selfReportRecordId: 'SR-A-v1', revoked: false },
      { candidateId: 'C2', selfReportRecordId: 'SR-B-v1', revoked: false },
    ] as unknown as CandidateAssessment[];
    const marked = revokeAssessmentsByBatch(assessments, revokedIds);
    expect(marked[0].revoked).toBe(true);
    expect(marked[1].revoked).toBe(false);
  });

  it('拓扑修订撤销旧来源版本；已关闭调查不改写，未关闭标记过旧', () => {
    const registry = registryOf({ sources: [makeSource()] });
    const revised = makeSource({ recordId: 'SRC-X@v2', version: 2, supersedes: 'SRC-X@v1', access: { sewerId: 'SW-1', chainageM: 1100, travelTimeS: [360, 660] } });
    const { registry: after, revokedIds } = applyTopologyRevision(registry, [revised]);
    expect(revokedIds).toEqual(['SRC-X@v1']);
    expect(currentRegistry(after).sources[0].access.chainageM).toBe(1100);

    const event = makeEvent();
    const cand = assessCandidates(registry, event, { computedAt: at(20) })[0];
    let inv = newInvestigation(event.eventId, cand, at(20).valueOf());
    // 关闭需取样或理由
    expect(transitionInvestigation(inv, 'CLOSED', '调查员', at(21).valueOf(), { candidate: cand }).ok).toBe(false);
    inv = { ...inv, samplings: [{ id: 's1', at: at(20, 30).valueOf(), location: 'SW-1', items: '氨氮', result: '6.1 mg/L', by: '调查员' }] };
    const closed = transitionInvestigation(inv, 'CLOSED', '调查员', at(21).valueOf(), { candidate: cand });
    expect(closed.ok).toBe(true);
    expect(closed.investigation.closedSnapshot).not.toBeNull();
    const open = newInvestigation(event.eventId, cand, at(20).valueOf());
    const flagged = flagStaleRegistry([closed.investigation, open]);
    expect(flagged[0].staleRegistry).toBe(false); // 已关闭不改写
    expect(flagged[1].staleRegistry).toBe(true);
    // 已关闭调查不能直接跳到其他状态，只能重新打开
    expect(transitionInvestigation(closed.investigation, 'SAMPLING', '调查员', at(22).valueOf(), {}).ok).toBe(false);
    const reopened = transitionInvestigation(closed.investigation, 'PENDING', '调查员', at(22).valueOf(), {});
    expect(reopened.ok).toBe(true);
    expect(reopened.investigation.closedSnapshot).not.toBeNull(); // 快照保留追溯
  });

  it('交付：内容哈希确定、同路线旧版本被取代', async () => {
    const event = makeEvent();
    const candidates = assessCandidates(registryOf({ sources: [makeSource()] }), event, { computedAt: at(20) });
    const input = {
      eventId: event.eventId,
      route: 'SET' as const,
      createdAt: 1_763_800_000_000,
      createdBy: '调查员',
      setResult: null,
      rankResult: null,
      candidates,
      registryRefs: candidates[0].registryRefs,
    };
    const d1 = await buildDelivery(input);
    const d2 = await buildDelivery(input);
    expect(d1.contentHash).toBe(d2.contentHash);
    expect(d1.contentHash).toHaveLength(64);
    expect(d1.disclaimer).toContain('责任结论');
    const superseded = supersedeOld([d1], event.eventId, 'SET', d2.deliveryId);
    expect(superseded[0].status).toBe('SUPERSEDED');
    expect(superseded[0].supersededBy).toBe(d2.deliveryId);
    // canonicalize 键序无关
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('现行候选视图：每来源取最新未撤销评估', () => {
    const mk = (sourceId: string, computedAt: number, revoked: boolean): CandidateAssessment =>
      ({ sourceId, computedAt, revoked }) as unknown as CandidateAssessment;
    const all = [mk('A', 1, false), mk('A', 2, false), mk('A', 3, true), mk('B', 1, false)];
    const cur = currentAssessments(all);
    expect(cur.find((c) => c.sourceId === 'A')?.computedAt).toBe(2);
    expect(cur).toHaveLength(2);
  });
});
