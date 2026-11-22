#!/usr/bin/env tsx
/**
 * 事件调查样例核验：同一场暴雨、两条时间相近支管（其一缺电导率）、泵站中途切换。
 *
 * 断言（退出码非 0 表示失败）：
 *  1. 资料包指纹全部匹配；事件窗口 ≈14:32–14:42、峰值 ≈9.2 mg/L；
 *  2. 水力召回 3 个候选；泵站切换后 SRC-B 切换前体制窗口被裁空、切换后窗口 ≈14:10–14:27；
 *  3. SRC-C 因回流泵停运被时间带门槛排除（排除理由留档）；
 *  4. 集合范围：v1 自报否认时集合 = {SRC-B}；v2 更正后集合 = {SRC-A, SRC-B} 并列；
 *  5. 排序变化：v1 → [B,A] 可判定；v2 → 不可判定（分差 <0.05）；
 *     雨量 −15% → [A,B] 可判定；雨量 +15% → 不可判定（敏感性展示）；
 *  6. SRC-B 电导率缺测只产生缺失惩罚（完整度 0.84），不产生支持/反证；
 *  7. 自报更正按版本撤销旧评分；拓扑修订不改写已关闭调查；
 *  8. 交付内容哈希可复现，交付只含调查优先级与免责声明。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSampleFromDisk } from './sampleIo';
import { parseInvestigatePack } from './investigateIo';
import type { SampleManifest } from '../src/domain/types';
import type { InvestigateManifest } from '../src/investigate/types';
import { computeDayLoad } from '../src/domain/engine';
import { detectEvent } from '../src/investigate/event';
import { assessCandidates } from '../src/investigate/evidence';
import { runRankRoute, runSetRoute, independentSupports } from '../src/investigate/routes';
import {
  applyCorrection,
  applyTopologyRevision,
  currentRegistry,
} from '../src/investigate/registry';
import {
  buildDelivery,
  flagStaleRegistry,
  latestCorrection,
  newInvestigation,
  registryWithoutCorrection,
  revokeAssessmentsByBatch,
  transitionInvestigation,
} from '../src/investigate/service';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(__dirname, '../public/sample');
const invDir = resolve(sampleDir, 'investigate');

const baseManifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const invManifest = JSON.parse(readFileSync(resolve(invDir, 'manifest.json'), 'utf8')) as InvestigateManifest;
const { baseDataset } = parseSampleFromDisk(sampleDir, baseManifest);
const pack = parseInvestigatePack(invDir, invManifest, {
  instruments: baseDataset.instruments,
  bindings: baseDataset.bindings,
});

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  if (condition) console.log(`  ✓ ${label}：${detail}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}：${detail}`);
  }
}
function timeOf(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19);
}

console.log('=== 1. 资料包指纹与合并 ===');
const badFp = pack.fingerprints.filter((f) => !f.ok);
check('资料包指纹全部匹配', badFp.length === 0, `${pack.fingerprints.length} 份文件${badFp.length > 0 ? `，失配 ${badFp.map((f) => f.fileName).join(',')}` : ''}`);
check('解析无错误', pack.errors.length === 0, pack.errors.slice(0, 3).join('；') || '无错误');
const dataset = {
  ...baseDataset,
  states: [...baseDataset.states, ...pack.datasetPatch.states],
  readings: [...baseDataset.readings, ...pack.datasetPatch.readings],
};
const stormReadings = dataset.readings.filter((r) => r.dayKey === '2026-11-20');
check('暴雨日读数入库', stormReadings.length === 6480, `${stormReadings.length} 行（2026-11-20）`);

console.log('\n=== 2. 事件检测（基础复核台片段 → 事件窗口） ===');
const snapshot = computeDayLoad(dataset, 'CC-E01', '2026-11-20', 'SEGMENT');
const event = detectEvent({
  dataset,
  snapshot,
  pointCode: 'CC-E01',
  day: '2026-11-20',
  eventProfiles: pack.registry.eventProfiles,
  computedAt: Date.parse('2026-11-21T12:00:00+08:00'),
});
check('检出高氨氮事件', event !== null, event ? `${timeOf(event.windowFrom)} → ${timeOf(event.windowTo)}` : '未检出');
if (event) {
  const fromOK = timeOf(event.windowFrom) >= '14:31:00' && timeOf(event.windowFrom) <= '14:33:30';
  const toOK = timeOf(event.windowTo) >= '14:40:00' && timeOf(event.windowTo) <= '14:42:30';
  check('事件窗口 ≈14:32–14:41', fromOK && toOK, `${timeOf(event.windowFrom)} → ${timeOf(event.windowTo)}`);
  check('峰值 ≈9.2 mg/L', event.peakConcentration > 8.8 && event.peakConcentration < 9.6, `${event.peakConcentration.toFixed(2)} mg/L（限值 ${event.standard}）`);
  const o = event.observed;
  console.log(`  事件指纹：氨氮 ${o.nh3n}，COD ${o.cod}，电导率 ${o.cond}，pH ${o.ph}，流量 ${o.flowM3h}`);
  check('氨氮增量 ≈ +5', o.nh3n[0] > 3.8 && o.nh3n[1] < 6.6, `${o.nh3n}`);
  check('COD 增量 ≈ +10', o.cod[0] > 6.5 && o.cod[1] < 12.5, `${o.cod}`);
  check('电导率增量 ≈ +75（加密监测）', o.cond !== null && o.cond[0] > 50 && o.cond[1] < 100, `${o.cond}`);
  check('pH 变化 ≈ −0.23', o.ph !== null && o.ph[0] > -0.45 && o.ph[1] < -0.05, `${o.ph}`);
}

console.log('\n=== 3. 水力候选召回（泵站中途切换） ===');
const registryV1 = currentRegistry(pack.registry);
const assessmentsV1 = event ? assessCandidates(registryV1, event, { computedAt: event.computedAt }) : [];
check('召回 3 个候选', assessmentsV1.length === 3, assessmentsV1.map((a) => a.sourceId).join('，'));
const candA = assessmentsV1.find((a) => a.sourceId === 'SRC-A')!;
const candB = assessmentsV1.find((a) => a.sourceId === 'SRC-B')!;
const candC = assessmentsV1.find((a) => a.sourceId === 'SRC-C')!;
if (candB) {
  check('SRC-B 标记泵站中途切换', candB.recall.pumpSwitchMidEvent, candB.recall.notes[0]?.slice(0, 46) ?? '');
  const baseRegime = candB.recall.regimes[0];
  const afterRegime = candB.recall.regimes[1];
  check('切换前体制窗口被裁空', baseRegime.dischargeWindow === null, baseRegime.dischargeWindow ? '非空' : '空（无可行排放时刻）');
  check(
    '切换后体制窗口 ≈14:10–14:27',
    afterRegime.dischargeWindow !== null && timeOf(afterRegime.dischargeWindow.from) >= '14:09:00' && timeOf(afterRegime.dischargeWindow.from) <= '14:12:00' && timeOf(afterRegime.dischargeWindow.to) >= '14:26:00' && timeOf(afterRegime.dischargeWindow.to) <= '14:29:00',
    afterRegime.dischargeWindow ? `${timeOf(afterRegime.dischargeWindow.from)} → ${timeOf(afterRegime.dischargeWindow.to)}` : '空',
  );
}
if (candC) {
  check('SRC-C 被时间带门槛排除', !candC.timeBandCompatible && Boolean(candC.excludeReason?.includes('停运')), candC.excludeReason ?? '—');
}

console.log('\n=== 4. 证据组合（v1：自报否认） ===');
if (candA && candB) {
  const selfA = candA.items.find((i) => i.dim === 'SELF_REPORT')!;
  check('SRC-A 自报否认构成反证', selfA.verdict === 'CONTRADICT' && selfA.contribution < 0, `贡献 ${selfA.contribution.toFixed(3)}（批次 ${selfA.basisRecordIds[0]}）`);
  const condB = candB.items.find((i) => i.dim === 'COND')!;
  check('SRC-B 电导率缺测只计缺失惩罚', condB.verdict === 'MISSING' && condB.contribution === 0 && condB.completenessLoss === 0.16, `完整度损失 ${condB.completenessLoss}`);
  check('SRC-B 完整度 0.84', Math.abs(candB.completeness - 0.84) < 1e-6, `${candB.completeness}`);
  const pumpNote = candB.items.find((i) => i.dim === 'PUMP_STATE');
  check('泵站切换注记存在且不计分', Boolean(pumpNote) && pumpNote!.weight === 0, pumpNote ? pumpNote.note.slice(0, 40) : '缺失');
  console.log(`  评分（v1）：SRC-A ${candA.score}，SRC-B ${candB.score}`);
  check('v1 排序 B 在 A 前', candB.score > candA.score, `B ${candB.score} > A ${candA.score}`);
}

console.log('\n=== 5. 集合路线（v1 → v2 集合范围变化） ===');
const thresholds = {
  minIndependentSupports: invManifest.setRoute.minIndependentSupports,
  maxStrongCounters: invManifest.setRoute.maxStrongCounters,
  minCompleteness: invManifest.setRoute.minCompleteness,
  declaredAt: Date.parse(invManifest.setRoute.declaredAt),
  declaredBy: invManifest.setRoute.declaredBy,
  note: invManifest.setRoute.note,
};
const setV1 = runSetRoute(assessmentsV1, thresholds, true);
const namesOf = (ids: string[]) =>
  ids
    .map((id) => {
      const m = id.match(/SRC-[A-Z]/);
      return m ? m[0] : id;
    })
    .sort()
    .join('+');
const srcOf = (id: string) => id.match(/SRC-[A-Z]/)?.[0] ?? id;
check('v1 集合 = {SRC-B}', setV1.inSet.length === 1 && setV1.inSet[0].includes('SRC-B'), `集合 ${namesOf(setV1.inSet)}；排除 ${setV1.excluded.length} 个`);
check('v1 排除 SRC-A 的理由含独立反证', setV1.excluded.some((e) => e.candidateId.includes('SRC-A') && e.reasons.some((r) => r.includes('反证'))), setV1.excluded.find((e) => e.candidateId.includes('SRC-A'))?.reasons.join('；') ?? '—');

// 应用自报更正 v2
const correctionBatch = pack.correction[0];
const { registry: registryAfter, revokedIds } = applyCorrection(pack.registry, correctionBatch);
check('v1 批次被撤销', revokedIds.includes('SR-A-v1'), `撤销 ${revokedIds.join('，')}`);
const registryV2 = currentRegistry(registryAfter);
const assessmentsV2 = event ? assessCandidates(registryV2, event, { computedAt: event.computedAt + 1000 }) : [];
const candA2 = assessmentsV2.find((a) => a.sourceId === 'SRC-A')!;
const candB2 = assessmentsV2.find((a) => a.sourceId === 'SRC-B')!;
const setV2 = runSetRoute(assessmentsV2, thresholds, true);
check(
  'v2 集合 = {SRC-A, SRC-B} 并列',
  setV2.inSet.length === 2 && setV2.inSet.some((id) => id.includes('SRC-A')) && setV2.inSet.some((id) => id.includes('SRC-B')),
  `集合 ${namesOf(setV2.inSet)}（暴雨期间并列保留）`,
);
console.log(`  评分（v2）：SRC-A ${candA2.score}，SRC-B ${candB2.score}`);

console.log('\n=== 6. 排序路线（可拒答 + 敏感性） ===');
const correctionId = latestCorrection(registryAfter)!;
const beforeRegistry = registryWithoutCorrection(registryAfter, correctionId);
const rankV2 = runRankRoute({
  registry: registryV2,
  registryBeforeCorrection: beforeRegistry ? currentRegistry(beforeRegistry) : null,
  event: event!,
  assessments: assessmentsV2,
  marginThreshold: invManifest.rankRoute.marginThreshold,
  completenessFloor: invManifest.rankRoute.completenessFloor,
  rainErrorRelative: 0.15,
  computedAt: event!.computedAt,
});
check('v2 排序不可判定', !rankV2.decidable, rankV2.undecidableReasons.join('；'));
const before = rankV2.sensitivity.selfReportBefore;
check(
  '敏感性：自报更正前 [B,A] 可判定',
  Boolean(before && before.decidable && before.ranking[0]?.candidateId.includes('SRC-B')),
  before ? `${before.ranking.map((r) => `${srcOf(r.candidateId)}=${r.score}`).join(' > ')}` : '无',
);
const minus = rankV2.sensitivity.rainfallMinus;
check(
  '敏感性：雨量 −15% → [A,B] 可判定',
  minus.decidable && minus.ranking[0]?.candidateId.includes('SRC-A'),
  `${minus.ranking.map((r) => `${srcOf(r.candidateId)}=${r.score}`).join(' > ')}`,
);
const plus = rankV2.sensitivity.rainfallPlus;
check('敏感性：雨量 +15% → 不可判定', !plus.decidable, plus.undecidableReasons.join('；'));
const rankV1 = runRankRoute({
  registry: registryV1,
  registryBeforeCorrection: null,
  event: event!,
  assessments: assessmentsV1,
  marginThreshold: invManifest.rankRoute.marginThreshold,
  completenessFloor: invManifest.rankRoute.completenessFloor,
  rainErrorRelative: 0.15,
  computedAt: event!.computedAt,
});
check('v1 排序 [B,A] 可判定', rankV1.decidable && rankV1.ranking[0]?.candidateId.includes('SRC-B'), rankV1.ranking.map((r) => `${srcOf(r.candidateId)}=${r.score}`).join(' > '));

console.log('\n=== 7. 版本撤销与已关闭调查保护 ===');
const revokedAssessments = revokeAssessmentsByBatch(assessmentsV1, revokedIds);
check(
  '旧评分按版本撤销',
  revokedAssessments.find((a) => a.sourceId === 'SRC-A')?.revoked === true && revokedAssessments.find((a) => a.sourceId === 'SRC-B')?.revoked === false,
  'SRC-A 旧评分 revoked=true，SRC-B 不受影响',
);
// 处置板：关闭 SRC-B 调查 → 拓扑修订 → 已关闭调查不改写
let invB = newInvestigation(event!.eventId, candB2, event!.computedAt);
invB = { ...invB, samplings: [{ id: 'SMP-1', at: event!.computedAt + 3600_000, location: 'SW-CSO-07 溢流口', items: '氨氮/COD/电导率', result: '溢流液氨氮 8.4 mg/L', by: '调查员' }] };
const closed = transitionInvestigation(invB, 'CLOSED', '调查员', event!.computedAt + 7200_000, { candidate: candB2 });
check('取样后可关闭调查', closed.ok && closed.investigation.status === 'CLOSED' && closed.investigation.closedSnapshot !== null, `快照评分 ${closed.investigation.closedSnapshot?.score}`);
const { registry: registryTopo, revokedIds: topoRevoked } = applyTopologyRevision(registryAfter, pack.topology);
check('拓扑修订撤销 SRC-B@v1', topoRevoked.includes('SRC-B@v1'), `撤销 ${topoRevoked.join('，')}`);
const invA = newInvestigation(event!.eventId, candA2, event!.computedAt);
const flagged = flagStaleRegistry([closed.investigation, invA]);
check(
  '拓扑修订不改写已关闭调查',
  flagged[0].status === 'CLOSED' && flagged[0].staleRegistry === false && flagged[0].closedSnapshot !== null,
  '已关闭调查保持原快照',
);
check('未关闭调查标记登记簿已修订', flagged[1].staleRegistry === true, 'SRC-A 调查 staleRegistry=true');
void registryTopo;

console.log('\n=== 8. 交付可审计 ===');
const refs = assessmentsV2.flatMap((a) => a.registryRefs);
const d1 = await buildDelivery({
  eventId: event!.eventId,
  route: 'SET',
  createdAt: 1_763_800_000_000,
  createdBy: '调查员',
  setResult: setV2,
  rankResult: null,
  candidates: assessmentsV2,
  registryRefs: refs,
});
const d2 = await buildDelivery({
  eventId: event!.eventId,
  route: 'SET',
  createdAt: 1_763_800_000_000,
  createdBy: '调查员',
  setResult: setV2,
  rankResult: null,
  candidates: assessmentsV2,
  registryRefs: refs,
});
check('交付内容哈希可复现', d1.contentHash === d2.contentHash && d1.contentHash.length === 64, d1.contentHash.slice(0, 20) + '…');
check('交付含免责声明', d1.disclaimer.includes('不构成') && d1.disclaimer.includes('责任结论'), d1.disclaimer);
const supports = independentSupports(candA2);
console.log(`  SRC-A 独立支持 ${supports.supports}、反证 ${supports.counters}；交付候选 ${d1.candidates.length} 个，登记簿引用 ${d1.registryRefs.length} 条`);

if (failures > 0) {
  console.error(`\n核验失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n核验通过：集合范围、排序变化、不可判定提示、缺测惩罚、版本撤销与已关闭调查保护全部符合预期。');
