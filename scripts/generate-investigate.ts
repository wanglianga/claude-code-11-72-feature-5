#!/usr/bin/env tsx
/**
 * 生成事件调查样例资料包：public/sample/investigate/*.csv + manifest.json
 *
 * 场景（2026-11-20 暴雨日，Asia/Shanghai，确定性生成、无随机数）：
 *  - 暴雨 13:05–16:00，峰值雨强 42 mm/h（14:10），溢流触发阈值 18 mm/h，雨量误差界 ±15%
 *  - CC-E01 排口 14:32–14:41 短时高氨氮冲击（基线 ~3.6 → 峰值 9.2 mg/L，限值 5）
 *  - 两条时间相近支管：SRC-A 工业支管（倒推窗口 14:22–14:35）、SRC-B 雨污合流溢流
 *    （泵站 14:10 中途切换，切换后体制倒推窗口 14:10–14:27）；SRC-B 登记缺电导率
 *  - SRC-C 厂内回流：回流泵 14:00–14:45 停运，时间带不相容被排除
 *  - 自报批次：SR-A-v1 称全天未排放；SR-A-v2 更正承认 14:02–14:31 排放（按版本撤销 v1）
 *  - 拓扑修订：SRC-B 接入里程 950 → 1100 m（v2），演示已关闭调查不改写
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeCsv, isoLocal } from '../src/sample/csv';
import type { InvestigateManifest } from '../src/investigate/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/sample/investigate');

const SHANGHAI = 8 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 10, 20) - SHANGHAI; // 2026-11-20T00:00+08:00
const HOUR = 3_600_000;
const MIN = 60_000;
const SEC = 1000;

function at(h: number, m = 0, s = 0): number {
  return D0 + h * HOUR + m * MIN + s * SEC;
}

/* ---------------- 排口读数（12:00–18:00，10 s） ---------------- */

const RECEIVED_READINGS = at(24 + 6, 30); // 2026-11-21 06:30+08

/** 校准后真值 → 原始读数（按 2026-11-20 当天有效校准系数反推，与引擎口径一致） */
function rawOf(metric: 'COD' | 'NH3N' | 'FLOW', trueVal: number): number {
  // C-CO2：CAL-CO2-20261118（scale 1.08, offset -1.2，2026-11-18 13:00 起生效）
  // N-NH1：CAL-NH1-20261001（scale 1.02, offset -0.05）
  // F-FL1：CAL-FL1-20261001（scale 1.01, offset -1.2）
  const coef =
    metric === 'COD' ? { scale: 1.08, offset: -1.2 } : metric === 'NH3N' ? { scale: 1.02, offset: -0.05 } : { scale: 1.01, offset: -1.2 };
  return Math.round(((trueVal - coef.offset) / coef.scale) * 100) / 100;
}

function hourOfDay(t: number): number {
  return (t - D0) / HOUR;
}

function nh3nTrue(t: number): number {
  const h = hourOfDay(t);
  const base = 3.1 + 0.5 * Math.sin((2 * Math.PI * (h - 9)) / 24);
  const t0 = at(14, 32);
  const rampUpEnd = at(14, 33, 30);
  const holdEnd = at(14, 40);
  const rampDownEnd = at(14, 41, 30);
  if (t < t0 || t >= rampDownEnd) return round3(base);
  if (t < rampUpEnd) return round3(base + (9.2 - base) * ((t - t0) / (rampUpEnd - t0)));
  if (t < holdEnd) return round3(9.2 + 0.15 * Math.sin((2 * Math.PI * (t - rampUpEnd)) / 120_000));
  const baseEnd = 3.1 + 0.5 * Math.sin((2 * Math.PI * (hourOfDay(rampDownEnd) - 9)) / 24);
  return round3(9.2 + (baseEnd - 9.2) * ((t - holdEnd) / (rampDownEnd - holdEnd)));
}

function codTrue(t: number): number {
  const h = hourOfDay(t);
  const base = 29 + 3.4 * Math.sin((2 * Math.PI * (h - 7)) / 24);
  const t0 = at(14, 33);
  const upEnd = at(14, 34);
  const holdEnd = at(14, 40);
  const downEnd = at(14, 41);
  let bump = 0;
  if (t >= t0 && t < upEnd) bump = 12 * ((t - t0) / (upEnd - t0));
  else if (t >= upEnd && t < holdEnd) bump = 12;
  else if (t >= holdEnd && t < downEnd) bump = 12 * (1 - (t - holdEnd) / (downEnd - holdEnd));
  return round3(base + bump);
}

function stormHydro(t: number): number {
  const r0 = at(13, 20);
  const r1 = at(14, 10);
  const holdEnd = at(15, 0);
  const rec1 = at(16, 30);
  const rec2 = at(17, 30);
  if (t < r0) return 0;
  if (t < r1) return 190 * ((t - r0) / (r1 - r0));
  if (t < holdEnd) return 190;
  if (t < rec1) return 190 - 150 * ((t - holdEnd) / (rec1 - holdEnd));
  if (t < rec2) return 40 * (1 - (t - rec1) / (rec2 - rec1));
  return 0;
}

function flowTrue(t: number): number {
  const h = hourOfDay(t);
  return round3(430 + 42 * Math.sin((2 * Math.PI * (h - 11)) / 24) + stormHydro(t));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function generateReadings(): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  const instruments: { id: string; metric: 'COD' | 'NH3N' | 'FLOW'; clockOffsetMs: number; value: (t: number) => number }[] = [
    { id: 'C-CO2', metric: 'COD', clockOffsetMs: 2500, value: codTrue },
    { id: 'N-NH1', metric: 'NH3N', clockOffsetMs: -1500, value: nh3nTrue },
    { id: 'F-FL1', metric: 'FLOW', clockOffsetMs: 3200, value: flowTrue },
  ];
  for (let aligned = at(12); aligned < at(18); aligned += 10 * SEC) {
    for (const inst of instruments) {
      rows.push({
        reading_id: `rd-${inst.id}-${Math.floor(aligned / 1000)}`,
        point_code: 'CC-E01',
        plant_id: 'P1',
        instrument_id: inst.id,
        metric: inst.metric,
        sampled_at: isoLocal(aligned - inst.clockOffsetMs, true),
        received_at: isoLocal(RECEIVED_READINGS),
        raw_value: rawOf(inst.metric, inst.value(aligned)),
        quality_flag: 'VALID',
      });
    }
  }
  return rows;
}

/* ---------------- 雨量（5 min 步长，mm/步） ---------------- */

/** 各时刻雨强（mm/h），确定性阶梯序列 */
const RAIN_PROFILE: [number, number, number][] = [
  // [时, 分, mm/h]
  [13, 5, 2], [13, 10, 3], [13, 15, 4], [13, 20, 5], [13, 25, 6], [13, 30, 8],
  [13, 35, 10], [13, 40, 12], [13, 45, 14], [13, 50, 16], [13, 55, 20], [14, 0, 26],
  [14, 5, 34], [14, 10, 42], [14, 15, 40], [14, 20, 36], [14, 25, 30], [14, 30, 24],
  [14, 35, 18], [14, 40, 14], [14, 45, 12], [14, 50, 10], [14, 55, 8], [15, 0, 7],
  [15, 5, 6.5], [15, 10, 6], [15, 15, 5.5], [15, 20, 5], [15, 25, 4.5], [15, 30, 4],
  [15, 35, 3.5], [15, 40, 3], [15, 45, 2.5], [15, 50, 2], [15, 55, 1.5],
  [16, 0, 0.5], [16, 30, 0],
];

function rainMmH(t: number): number {
  let v = 0;
  for (const [h, m, mmH] of RAIN_PROFILE) {
    if (t >= at(h, m)) v = mmH;
  }
  return v;
}

function generateRainfall(): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  for (let t = at(12); t < at(18); t += 5 * MIN) {
    rows.push({
      series_id: 'RG-1',
      gauge_id: 'RG-城西-01',
      version: 1,
      trust_level: 'A',
      step_seconds: 300,
      error_relative: 0.15,
      at: isoLocal(t),
      mm: Math.round((rainMmH(t) / 12) * 1000) / 1000,
      note: '城西雨量站，误差界 ±15%',
    });
  }
  return rows;
}

/* ---------------- 事件加密监测（电导率/pH，1 min） ---------------- */

function condTrue(t: number): number {
  const base = 1150 + 3 * Math.sin((2 * Math.PI * (t - at(14, 20))) / (35 * MIN));
  const t0 = at(14, 31);
  const upEnd = at(14, 34);
  const holdEnd = at(14, 41);
  const downEnd = at(14, 46);
  let bump = 0;
  if (t >= t0 && t < upEnd) bump = 75 * ((t - t0) / (upEnd - t0));
  else if (t >= upEnd && t < holdEnd) bump = 75 + 4 * Math.sin((2 * Math.PI * (t - upEnd)) / (6 * MIN));
  else if (t >= holdEnd && t < downEnd) bump = 75 * (1 - (t - holdEnd) / (downEnd - holdEnd));
  return Math.round((base + bump) * 10) / 10;
}

function phTrue(t: number): number {
  const base = 7.25 + 0.02 * Math.sin((2 * Math.PI * (t - at(14, 20))) / (40 * MIN));
  const t0 = at(14, 31);
  const upEnd = at(14, 34);
  const holdEnd = at(14, 41);
  const downEnd = at(14, 46);
  let dip = 0;
  if (t >= t0 && t < upEnd) dip = -0.23 * ((t - t0) / (upEnd - t0));
  else if (t >= upEnd && t < holdEnd) dip = -0.23 + 0.015 * Math.sin((2 * Math.PI * (t - upEnd)) / (5 * MIN));
  else if (t >= holdEnd && t < downEnd) dip = -0.23 * (1 - (t - holdEnd) / (downEnd - holdEnd));
  return Math.round((base + dip) * 1000) / 1000;
}

function generateEventProfile(): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  for (let t = at(14, 0); t < at(15, 0); t += MIN) {
    rows.push({
      profile_id: 'EP-CC-E01',
      point_code: 'CC-E01',
      version: 1,
      trust_level: 'B',
      step_seconds: 60,
      at: isoLocal(t),
      cond_us_cm: condTrue(t),
      ph: phTrue(t),
      note: '移动监测车事件期间加密监测',
    });
  }
  return rows;
}

/* ---------------- 主流程 ---------------- */

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const files: { fileName: string; kind: InvestigateManifest['baseFiles'][number]['kind']; receivedAt: string; text: string; note: string }[] = [];

  // 1. 排口读数（暴雨日 12:00–18:00）
  const readings = generateReadings();
  const readingsText = serializeCsv(
    ['reading_id', 'point_code', 'plant_id', 'instrument_id', 'metric', 'sampled_at', 'received_at', 'raw_value', 'quality_flag'],
    readings,
  );
  files.push({
    fileName: 'readings_CC-E01_2026-11-20.csv',
    kind: 'READINGS',
    receivedAt: isoLocal(RECEIVED_READINGS),
    text: readingsText,
    note: '暴雨日排口读数（COD/氨氮/流量，10 s），含 14:32–14:41 高氨氮冲击',
  });

  // 2. 扩展状态台账（覆盖 2026-11-20，基础台账 OK 状态到 11-20 00:00 为止）
  const statesText = serializeCsv(
    ['state_id', 'instrument_id', 'state', 'from', 'to', 'reason', 'work_order'],
    ['C-CO2', 'N-NH1', 'F-FL1'].map((id) => ({
      state_id: `ST-${id}-OK-20261120`,
      instrument_id: id,
      state: 'OK',
      from: isoLocal(at(0)),
      to: isoLocal(at(0) + 2 * 24 * HOUR),
      reason: '运行正常（暴雨日台账延续）',
      work_order: 'WO-120-000',
    })),
  );
  files.push({
    fileName: 'states_ext_2026-11-20.csv',
    kind: 'STATE_LOG',
    receivedAt: isoLocal(at(24 + 6, 30)),
    text: statesText,
    note: '暴雨日状态台账延续（OK），衔接基础台账有效期',
  });

  // 3. 来源登记簿 v1
  const sourcesText = serializeCsv(
    [
      'source_id', 'kind', 'name', 'version', 'trust_level', 'registered_at', 'supersedes',
      'sewer_id', 'chainage_m', 'travel_min_s', 'travel_max_s',
      'allowed_kind', 'allowed_from', 'allowed_to', 'rain_threshold_mmh',
      'env_nh3n_lo', 'env_nh3n_hi', 'env_cod_lo', 'env_cod_hi',
      'env_cond_lo', 'env_cond_hi', 'env_ph_lo', 'env_ph_hi',
      'flow_lo_m3h', 'flow_hi_m3h', 'revoked', 'note',
    ],
    [
      {
        source_id: 'SRC-A', kind: 'INDUSTRIAL_BRANCH', name: '宏成化工工业支管', version: 1, trust_level: 'B',
        registered_at: isoLocal(at(9) - 24 * HOUR), supersedes: '',
        sewer_id: 'SW-IND-01', chainage_m: 1850, travel_min_s: 360, travel_max_s: 600,
        allowed_kind: 'DAILY', allowed_from: '06:00', allowed_to: '22:00', rain_threshold_mmh: '',
        env_nh3n_lo: 3.0, env_nh3n_hi: 8.0, env_cod_lo: 4, env_cod_hi: 16,
        env_cond_lo: 60, env_cond_hi: 240, env_ph_lo: -0.2, env_ph_hi: 0.3,
        flow_lo_m3h: 25, flow_hi_m3h: 45, revoked: 'false',
        note: '化工园支管，历史联合监测率定包络；允许 06:00–22:00 排放。',
      },
      {
        source_id: 'SRC-B', kind: 'CSO_OVERFLOW', name: '城西雨污合流溢流口', version: 1, trust_level: 'B',
        registered_at: isoLocal(at(9) - 24 * HOUR), supersedes: '',
        sewer_id: 'SW-CSO-07', chainage_m: 950, travel_min_s: 300, travel_max_s: 540,
        allowed_kind: 'RAIN_TRIGGERED', allowed_from: '', allowed_to: '', rain_threshold_mmh: 18,
        env_nh3n_lo: 2.0, env_nh3n_hi: 6.5, env_cod_lo: 10, env_cod_hi: 45,
        env_cond_lo: '', env_cond_hi: '', env_ph_lo: -0.5, env_ph_hi: -0.05,
        flow_lo_m3h: 300, flow_hi_m3h: 600, revoked: 'false',
        note: '合流制溢流口，雨强 ≥18 mm/h 触发；未登记电导率包络（缺测）。',
      },
      {
        source_id: 'SRC-C', kind: 'PLANT_RECYCLE', name: '厂内反硝化回流', version: 1, trust_level: 'A',
        registered_at: isoLocal(at(9) - 24 * HOUR), supersedes: '',
        sewer_id: 'SW-REC-01', chainage_m: 120, travel_min_s: 60, travel_max_s: 120,
        allowed_kind: 'PUMP_RUNNING', allowed_from: '', allowed_to: '', rain_threshold_mmh: '',
        env_nh3n_lo: 0.5, env_nh3n_hi: 1.5, env_cod_lo: 1, env_cod_hi: 5,
        env_cond_lo: -50, env_cond_hi: 10, env_ph_lo: 0.05, env_ph_hi: 0.25,
        flow_lo_m3h: 80, flow_hi_m3h: 120, revoked: 'false',
        note: '厂内回流，仅回流泵运行时水力连通。',
      },
    ],
  );
  files.push({
    fileName: 'sources.csv',
    kind: 'SOURCE_REGISTRY',
    receivedAt: isoLocal(at(9) - 24 * HOUR),
    text: sourcesText,
    note: '来源登记簿 v1：接入位置、允许排放时段、排口等效增量包络、可信等级',
  });

  // 4. 雨量
  const rainfallText = serializeCsv(
    ['series_id', 'gauge_id', 'version', 'trust_level', 'step_seconds', 'error_relative', 'at', 'mm', 'note'],
    generateRainfall(),
  );
  files.push({
    fileName: 'rainfall_RG-1_2026-11-20.csv',
    kind: 'RAINFALL',
    receivedAt: isoLocal(at(18, 30)),
    text: rainfallText,
    note: '城西雨量站 5 分钟雨量，峰值 42 mm/h（14:10），误差界 ±15%',
  });

  // 5. 泵站切换
  const pumpText = serializeCsv(
    ['switch_id', 'station_id', 'station_name', 'at', 'from_mode', 'to_mode', 'affects_sewer_id', 'travel_after_min_s', 'travel_after_max_s', 'version', 'trust_level', 'revoked', 'note'],
    [
      {
        switch_id: 'PSW-1', station_id: 'PS-2', station_name: '城西提升泵站', at: isoLocal(at(14, 10)),
        from_mode: '直排', to_mode: '截流', affects_sewer_id: 'SW-CSO-07',
        travel_after_min_s: 840, travel_after_max_s: 1320, version: 1, trust_level: 'A', revoked: 'false',
        note: '暴雨调度：14:10 由直排切换为截流，SW-CSO-07 传播时间变长',
      },
    ],
  );
  files.push({
    fileName: 'pump_switches.csv',
    kind: 'PUMP_SWITCH',
    receivedAt: isoLocal(at(15, 0)),
    text: pumpText,
    note: '泵站切换记录：14:10 直排→截流，影响 SW-CSO-07 传播时间',
  });

  // 6. 自报批次 v1
  const selfV1Text = serializeCsv(
    ['batch_id', 'source_id', 'version', 'trust_level', 'received_at', 'supersedes', 'claim_kind', 'claim_from', 'claim_to', 'flow_lo_m3h', 'flow_hi_m3h', 'text', 'revoked', 'note'],
    [
      {
        batch_id: 'SR-A-v1', source_id: 'SRC-A', version: 1, trust_level: 'B', received_at: isoLocal(at(18, 30)), supersedes: '',
        claim_kind: 'NO_DISCHARGE', claim_from: isoLocal(at(0)), claim_to: isoLocal(at(24)), flow_lo_m3h: '', flow_hi_m3h: '',
        text: '全天未排放（流量计零读数）', revoked: 'false', note: '宏成化工自报，后被 v2 更正',
      },
      {
        batch_id: 'SR-B-v1', source_id: 'SRC-B', version: 1, trust_level: 'B', received_at: isoLocal(at(19, 10)), supersedes: '',
        claim_kind: 'OVERFLOW', claim_from: isoLocal(at(14, 5)), claim_to: isoLocal(at(14, 55)), flow_lo_m3h: 380, flow_hi_m3h: 520,
        text: '降雨溢流，液位计记录溢流时段 14:05–14:55', revoked: 'false', note: '市政排水公司溢流记录',
      },
      {
        batch_id: 'SR-C-v1', source_id: 'SRC-C', version: 1, trust_level: 'A', received_at: isoLocal(at(17, 0)), supersedes: '',
        claim_kind: 'PUMP_OFF', claim_from: isoLocal(at(14, 0)), claim_to: isoLocal(at(14, 45)), flow_lo_m3h: '', flow_hi_m3h: '',
        text: '反硝化回流泵停运检修（工单 WO-120-007）', revoked: 'false', note: '厂内运行日志（台账级）',
      },
    ],
  );
  files.push({
    fileName: 'self_reports_v1.csv',
    kind: 'SELF_REPORT',
    receivedAt: isoLocal(at(19, 10)),
    text: selfV1Text,
    note: '自报批次 v1：化工否认排放；市政溢流记录；厂内回流泵停运',
  });

  // 7. 事件加密监测
  const profileText = serializeCsv(
    ['profile_id', 'point_code', 'version', 'trust_level', 'step_seconds', 'at', 'cond_us_cm', 'ph', 'note'],
    generateEventProfile(),
  );
  files.push({
    fileName: 'event_profile_CC-E01.csv',
    kind: 'EVENT_PROFILE',
    receivedAt: isoLocal(at(16, 30)),
    text: profileText,
    note: '移动监测车 14:00–15:00 加密监测（电导率/pH，1 min）',
  });

  // 8. 自报更正 v2（单独导入，演示按版本撤销旧评分）
  const correctionText = serializeCsv(
    ['batch_id', 'source_id', 'version', 'trust_level', 'received_at', 'supersedes', 'claim_kind', 'claim_from', 'claim_to', 'flow_lo_m3h', 'flow_hi_m3h', 'text', 'revoked', 'note'],
    [
      {
        batch_id: 'SR-A-v2', source_id: 'SRC-A', version: 2, trust_level: 'B', received_at: isoLocal(at(24 + 9, 5)), supersedes: 'SR-A-v1',
        claim_kind: 'DISCHARGE', claim_from: isoLocal(at(14, 2)), claim_to: isoLocal(at(14, 31)), flow_lo_m3h: 32, flow_hi_m3h: 38,
        text: '抄表更正：14:02–14:31 实际排放约 35 m³/h（原零读数为抄表遗漏）', revoked: 'false', note: '更正批次，撤销 SR-A-v1',
      },
    ],
  );

  // 9. 拓扑修订（单独导入，演示已关闭调查不改写）
  const topologyText = serializeCsv(
    [
      'source_id', 'kind', 'name', 'version', 'trust_level', 'registered_at', 'supersedes',
      'sewer_id', 'chainage_m', 'travel_min_s', 'travel_max_s',
      'allowed_kind', 'allowed_from', 'allowed_to', 'rain_threshold_mmh',
      'env_nh3n_lo', 'env_nh3n_hi', 'env_cod_lo', 'env_cod_hi',
      'env_cond_lo', 'env_cond_hi', 'env_ph_lo', 'env_ph_hi',
      'flow_lo_m3h', 'flow_hi_m3h', 'revoked', 'note',
    ],
    [
      {
        source_id: 'SRC-B', kind: 'CSO_OVERFLOW', name: '城西雨污合流溢流口', version: 2, trust_level: 'B',
        registered_at: isoLocal(at(24 + 10, 30)), supersedes: 'SRC-B@v1',
        sewer_id: 'SW-CSO-07', chainage_m: 1100, travel_min_s: 360, travel_max_s: 600,
        allowed_kind: 'RAIN_TRIGGERED', allowed_from: '', allowed_to: '', rain_threshold_mmh: 18,
        env_nh3n_lo: 2.0, env_nh3n_hi: 6.5, env_cod_lo: 10, env_cod_hi: 45,
        env_cond_lo: '', env_cond_hi: '', env_ph_lo: -0.5, env_ph_hi: -0.05,
        flow_lo_m3h: 300, flow_hi_m3h: 600, revoked: 'false',
        note: '里程复核更正：接入点里程 950→1100 m，常规传播时间 300–540→360–600 s。',
      },
    ],
  );

  // 写文件并组装清单
  const manifestFiles: InvestigateManifest['baseFiles'] = [];
  for (const f of files) {
    writeFileSync(resolve(outDir, f.fileName), f.text, 'utf8');
    manifestFiles.push({
      fileName: f.fileName,
      kind: f.kind,
      receivedAt: f.receivedAt,
      rowCount: f.text.trim().split('\n').length - 1,
      sha256: sha256(f.text),
      note: f.note,
    });
  }
  writeFileSync(resolve(outDir, 'self_reports_v2_correction.csv'), correctionText, 'utf8');
  writeFileSync(resolve(outDir, 'sources_v2_topology.csv'), topologyText, 'utf8');

  const manifest: InvestigateManifest = {
    name: '暴雨高氨氮事件调查样例（虚构）',
    description:
      '2026-11-20 暴雨期间 CC-E01 排口 14:32–14:41 短时高氨氮事件。两条时间相近支管（工业支管 / 雨污合流溢流，其中溢流口缺电导率登记）与厂内回流候选；泵站 14:10 中途切换；自报批次 v2 更正撤销 v1；拓扑修订更正溢流口里程。',
    generatedAt: '2026-11-21T12:00:00+08:00',
    timezone: 'Asia/Shanghai',
    event: {
      pointCode: 'CC-E01',
      day: '2026-11-20',
      pollutant: 'NH3N',
      expectWindowLocal: '14:32–14:41',
      storm: true,
      scenario: [
        '暴雨 13:05–16:00，峰值雨强 42 mm/h（14:10），溢流触发阈值 18 mm/h，雨量误差 ±15%',
        '14:32–14:41 排口氨氮 3.6 → 9.2 mg/L（限值 5），电导率 +75 µS/cm，pH −0.23',
        'SRC-A 工业支管倒推窗口 14:22–14:35；SRC-B 溢流口经泵站切换后体制倒推 14:10–14:27',
        'SRC-B 登记缺电导率（缺测惩罚）；SRC-C 回流泵 14:00–14:45 停运被排除',
        '自报 v1 否认排放 → v2 更正承认 14:02–14:31 排放，旧评分按版本撤销',
      ],
    },
    setRoute: {
      minIndependentSupports: 3,
      maxStrongCounters: 0,
      minCompleteness: 0.6,
      declaredAt: '2026-11-20T08:00:00+08:00',
      declaredBy: '调度中心',
      note: '预先声明：独立支持 ≥3（相容=1、弱相容=0.5）、独立反证 =0、完整度 ≥0.6 方入集合；暴雨期间无独立反证的候选保留并列。',
    },
    rankRoute: {
      marginThreshold: 0.05,
      completenessFloor: 0.6,
      note: '前两名分差 <0.05 或首位完整度 <0.6 时输出不可判定；须展示对自报更正与雨量误差 ±15% 的敏感性。',
    },
    baseFiles: manifestFiles,
    correctionFile: {
      fileName: 'self_reports_v2_correction.csv',
      kind: 'SELF_REPORT',
      receivedAt: isoLocal(at(24 + 9, 5)),
      rowCount: correctionText.trim().split('\n').length - 1,
      sha256: sha256(correctionText),
      note: '自报更正批次 SR-A-v2：承认 14:02–14:31 排放，撤销 SR-A-v1 的否认',
    },
    topologyFile: {
      fileName: 'sources_v2_topology.csv',
      kind: 'SOURCE_REGISTRY',
      receivedAt: isoLocal(at(24 + 10, 30)),
      rowCount: topologyText.trim().split('\n').length - 1,
      sha256: sha256(topologyText),
      note: '拓扑修订：SRC-B 接入里程 950→1100 m（v2），不改写已关闭调查',
    },
  };
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`调查样例资料包已生成：${outDir}`);
  console.log(`读数 ${readings.length} 行；基础文件 ${manifestFiles.length} 份 + 更正/拓扑各 1 份`);
}

main();
