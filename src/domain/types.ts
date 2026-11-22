/**
 * 领域模型：排口污染负荷离线复核
 *
 * 统一语义（全工程共用，UI 不得另作解释）：
 * - 对齐时间轴：alignedAt = sampledAt + instrument.clockOffsetMs（毫秒）。
 *   自然日按 alignedAt 在 Asia/Shanghai（固定 UTC+8）划分；receivedAt 保留平台接收证据。
 * - 点位编号可复用；binding(instrumentId, metric, from, to) 决定读数归属，设备交接处切开片段。
 * - 校准按“仪表实例 + effectiveAt”描述，自生效时刻起作用于后续读数；
 *   校准中途生效必须切片段，两侧分别引用各自校准记录与系数，不跨系数插值。
 * - 状态按“仪表实例 + [from,to)”描述；OK 以外的冲洗、校准、旁路、故障一律不得并入排放。
 * - 采样空档：同一实例相邻有效读数间隔超过 nominalInterval × 2.5 的区间，显式从积分扣除并量化影响。
 * - 申报版本 FILED 后不可改写；迟到读数只能形成锁定来源窗口的重算候选与差异说明。
 */

export type Pollutant = 'COD' | 'NH3N';
export type Metric = Pollutant | 'FLOW';

export type DeviceState = 'OK' | 'FLUSH' | 'CALIB' | 'BYPASS' | 'FAULT';

export const EXCLUDING_STATES: ReadonlySet<DeviceState> = new Set([
  'FLUSH',
  'CALIB',
  'BYPASS',
  'FAULT',
]);

export const STATE_LABELS: Record<DeviceState, string> = {
  OK: '正常',
  FLUSH: '冲洗',
  CALIB: '校准中',
  BYPASS: '旁路',
  FAULT: '故障',
};

export const METRIC_LABELS: Record<Metric, string> = {
  COD: 'COD',
  NH3N: '氨氮',
  FLOW: '流量',
};

export const POLLUTANTS: Pollutant[] = ['COD', 'NH3N'];

export const ENGINE_VERSION = '1.0.0';

export interface Plant {
  plantId: string;
  name: string;
  shortName: string;
  timezone: string;
  dischargeStandard: { COD: number; NH3N: number };
}

export interface OutfallPoint {
  pointCode: string;
  plantId: string;
  name: string;
  /** 点位编号是否复用（同一编码先后承载不同物理排口/仪表链） */
  reused: boolean;
  designFlowM3h: number;
  note: string;
}

export interface Instrument {
  instrumentId: string;
  pointCode: string;
  plantId: string;
  kind: 'CONCENTRATION' | 'FLOW';
  /** 浓度仪为 COD 或 NH3N；流量仪为 FLOW */
  metric: Metric;
  model: string;
  serial: string;
  /** 基础系数：值 = raw * scale + offset（有校准记录时以校准为准） */
  scale: number;
  offset: number;
  /** 无校准记录时的默认相对不确定度（折算为区间半宽） */
  valueUncertainty: number;
  /** 标称上报间隔（秒）；空档阈值 = nominal × 2.5，片段边缘保持 = nominal × 0.75 */
  nominalIntervalSeconds: number;
  /** 设备实例在该点位上的有效区间 [installedAt, removedAt)，半开 */
  installedAt: number;
  removedAt: number | null;
  /** 时钟校正量：alignedAt = sampledAt + clockOffsetMs（毫秒） */
  clockOffsetMs: number;
  clockOffsetUncertaintyMs: number;
  note: string;
}

export interface Calibration {
  calibrationId: string;
  instrumentId: string;
  /** 生效时刻（对齐时间轴），参数自此时刻起作用于后续读数 */
  effectiveAt: number;
  /** 输出 = raw * scale + offset */
  scale: number;
  offset: number;
  /** 系数相对不确定度（折算为区间半宽） */
  coefficientUncertainty: number;
  operator: string;
  certificate: string;
  note: string;
}

export interface StatePeriod {
  stateId: string;
  instrumentId: string;
  state: DeviceState;
  from: number;
  /** null 表示开放式（到查询窗口末尾） */
  to: number | null;
  reason: string;
  workOrder: string;
}

/** 仪表实例与点位/指标的绑定有效期（点位编号复用靠它衔接） */
export interface Binding {
  bindingId: string;
  pointCode: string;
  instrumentId: string;
  metric: Metric;
  from: number;
  to: number | null;
}

export interface Reading {
  readingId: string;
  pointCode: string;
  plantId: string;
  instrumentId: string;
  metric: Metric;
  /** 采样时刻（设备时钟） */
  sampledAt: number;
  /** 对齐后的采样时刻 = sampledAt + clockOffsetMs */
  alignedAt: number;
  /** alignedAt 所属自然日（Asia/Shanghai） */
  dayKey: string;
  /** 接收时刻（平台时钟） */
  receivedAt: number;
  /** 原始值：浓度 mg/L，流量 m³/h */
  rawValue: number;
  qualityFlag: 'VALID' | 'SUSPECT' | 'INVALID';
  sourceFileId: string;
  sourceRow: number;
  /** 原始 CSV 行，用于回溯 */
  rawText?: string;
}

export type FileKind =
  | 'PLANT_REGISTER'
  | 'POINT_REGISTER'
  | 'INSTRUMENT_REGISTER'
  | 'BINDING_REGISTER'
  | 'CALIBRATION_REGISTER'
  | 'STATE_LOG'
  | 'READINGS'
  | 'LATE_BATCH'
  | 'SOURCE_REGISTRY'
  | 'RAINFALL'
  | 'PUMP_SWITCH'
  | 'SELF_REPORT'
  | 'EVENT_PROFILE';

export interface IntakeFile {
  fileId: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  kind: FileKind;
  /** 平台接收时刻 */
  receivedAt: number;
  rowCount: number;
  acceptedRows: number;
  rejectedRows: number;
  rejectedReasons: string[];
  note: string;
  ingestedAt: number;
  ingestedBy: string;
  sample: boolean;
}

export type IntegrationMethod = 'SEGMENT' | 'RESAMPLE';

export interface LoadBounds {
  min: number;
  best: number;
  max: number;
}

export interface ExceedanceInterval {
  from: number;
  to: number;
  seconds: number;
  peak: number;
  peakAt: number;
}

export interface PeakWindow {
  /** 1 小时滑动负荷峰值（kg） */
  loadKg: number;
  from: number;
  to: number;
  center: number;
}

export type EligibilityStatus = 'ELIGIBLE' | 'CONDITIONAL' | 'INELIGIBLE';

export interface QualityVerdict {
  status: EligibilityStatus;
  coverage: number;
  threshold: number;
  reasons: string[];
  /** 可以申报但需附注的事项 */
  caveats: string[];
}

export interface SegmentBoundary {
  kind:
    | 'DAY_START'
    | 'DAY_END'
    | 'CALIBRATION'
    | 'STATE'
    | 'INSTRUMENT_SWAP'
    | 'GAP';
  at: number;
  refId: string | null;
  label: string;
}

export type SegmentCategory =
  | 'VALID'
  | 'EXCLUDED_STATE'
  | 'SAMPLING_GAP'
  | 'NO_INSTRUMENT'
  | 'NO_STATE';

export interface SegmentSummary {
  segmentId: string;
  pollutant: Pollutant;
  from: number;
  to: number;
  durationSeconds: number;
  /** 有效积分域（浓度∩流量且非排除） */
  effectiveFrom: number | null;
  effectiveTo: number | null;
  instrumentId: string | null;
  flowInstrumentId: string | null;
  calibrationId: string | null;
  flowCalibrationId: string | null;
  calibrationScale: number | null;
  calibrationOffset: number | null;
  flowCalibrationScale: number | null;
  flowCalibrationOffset: number | null;
  state: DeviceState | null;
  flowState: DeviceState | null;
  category: SegmentCategory;
  excluded: boolean;
  excludeReason: string | null;
  readingCount: number;
  meanConcentration: number | null;
  meanFlow: number | null;
  loadKg: LoadBounds | null;
  /** 片段内有效积分覆盖比例 0..1 */
  coverage: number;
  /** 片段切口是否由校准生效造成 */
  calibrationCut: boolean;
  sourceReadingIds: string[];
  sourceStateIds: string[];
  sourceCalibrationIds: string[];
  sourceFileIds: string[];
  boundaries: SegmentBoundary[];
  quality: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
  readingWindow: { from: number; to: number } | null;
}

export type GapKind =
  | 'SAMPLING_GAP'
  | 'INSTRUMENT_GAP'
  | 'NO_EFFECTIVE_STATE'
  | 'CALIBRATION_EDGE'
  | 'EXCLUDED_STATE';

export interface GapSummary {
  from: number;
  to: number;
  seconds: number;
  kind: GapKind;
  metric: Metric;
  metricLabel: string;
  /** 缺口内各污染物的估计负荷 */
  impacts: { pollutant: Pollutant; impactKg: LoadBounds; note: string }[];
  reason: string;
  refIds: string[];
  /** 该空档可由迟到读数填补时的相关读数 ID */
  pendingLateReadings?: string[];
}

export interface ExclusionSummary {
  state: DeviceState;
  seconds: number;
  from: number;
  to: number;
  stateId: string;
  instrumentId: string;
  metric: Metric;
  metricLabel: string;
  reason: string;
  /** 排除时段若以邻近读数估算的影响（不并入排放） */
  impactKg: LoadBounds;
  impactNote: string;
}

export interface ResampleGridResult {
  gridSeconds: number;
  totalLoad: Record<Pollutant, LoadBounds>;
  peakWindow: Record<Pollutant, PeakWindow | null>;
  exceedanceSeconds: Record<Pollutant, number>;
  /** 与逐片段精确积分相比的最大相对偏差 */
  loadBestDriftPercent: number;
  peakShiftSeconds: number;
  exceedanceSymmetricDiffSeconds: number;
  /** 梯形法解析误差界（kg，各污染物最大值） */
  errorBoundKg: number;
  accepted: boolean;
}

export interface ResampleCheck {
  method: IntegrationMethod;
  gridSeconds: number;
  loadBestDriftPercent: number;
  peakWindowShiftSeconds: number;
  exceedanceSymmetricDiffSeconds: number;
  errorBoundKg: number;
  verified: boolean;
  notes: string[];
  gridResults: ResampleGridResult[];
  /** 朴素中点重采样（不切读数、不切边界）的失败证据 */
  naiveCheck: {
    gridSeconds: number;
    loadErrorPercent: number;
    missedExceedanceSeconds: number;
    note: string;
  };
  chosenGridSeconds: number;
}

export interface PollutantTrace {
  pollutant: Pollutant;
  /** 排放限值 mg/L */
  standard: number;
  load: LoadBounds;
  effectiveSeconds: number;
  excludedSeconds: number;
  gapSeconds: number;
  uncoveredSeconds: number;
  coverage: number;
  eligibility: QualityVerdict;
  flowWeightedMean: number;
  peakConcentration: number;
  peakConcentrationAt: number;
  exceedances: ExceedanceInterval[];
  exceedanceSeconds: number;
  peakWindow: PeakWindow | null;
  segments: SegmentSummary[];
  gaps: GapSummary[];
  exclusions: ExclusionSummary[];
  sourceReadingIds: string[];
  sourceFileIds: string[];
  /** 读数结点数（逐片段路线的查询负担指标） */
  knotCount: number;
  /** 网格单元数（重采样路线的汇总负担指标） */
  gridCellCount: number;
}

export interface ChartPoint {
  at: number;
  cod: number | null;
  nh3n: number | null;
  flow: number | null;
  /** kg/h = 浓度 mg/L × 流量 m³/h / 1000 */
  codRateKgH: number | null;
  nh3nRateKgH: number | null;
  codSegmentId: string | null;
  nh3nSegmentId: string | null;
  excluded: boolean;
  gap: boolean;
}

export interface DayLoadSnapshot {
  day: string;
  pointCode: string;
  plantId: string;
  method: IntegrationMethod;
  gridSeconds: number;
  windowFrom: number;
  windowTo: number;
  pollutants: PollutantTrace[];
  /** 全窗口覆盖率：各污染物最小值 */
  coverage: number;
  eligibility: QualityVerdict;
  uncertaintyNotes: string[];
  resampleCheck?: ResampleCheck;
  computeMs: number;
  engineVersion: string;
  /** 本次计算实际纳入的读数（指纹化来源） */
  sourceReadingIds: string[];
  sourceFileIds: string[];
  instrumentChain: {
    metric: Metric;
    instrumentId: string;
    from: number;
    to: number;
    bindingId: string;
    installedAt: number;
    removedAt: number | null;
  }[];
  clockNotes: string[];
  routingStats: {
    segmentCount: number;
    readingKnots: number;
    gridCells: number;
  };
  /** 展示曲线（不持久化） */
  chart?: ChartPoint[];
  chartResolutionSeconds?: number;
}

export interface MethodComparison {
  pointCode: string;
  plantId: string;
  day: string;
  segment: DayLoadSnapshot;
  resample: DayLoadSnapshot;
  agreement: {
    pollutant: Pollutant;
    segment: LoadBounds;
    resample: LoadBounds;
    overlapRatio: number;
    withinTolerance: boolean;
    peakShiftSeconds: number;
  }[];
  gapConsistency: {
    consistent: boolean;
    segmentGapSeconds: number;
    resampleGapSeconds: number;
    differingKinds: string[];
  };
  provenanceComplete: boolean;
  verified: boolean;
  notes: string[];
}

/** 申报版本：出具后锁定来源窗口，不因迟到数据而改变 */
export interface Declaration {
  declarationId: string;
  pointCode: string;
  plantId: string;
  /** YYYY-MM-DD（Asia/Shanghai） */
  day: string;
  method: IntegrationMethod;
  gridSeconds: number;
  createdAt: number;
  createdBy: string;
  status: 'FILED';
  /** 锁定来源窗口 [windowFrom, windowTo) */
  windowFrom: number;
  windowTo: number;
  /** 统计截至接收时刻：此后到达的读数视为迟到 */
  cutoffReceivedAt: number;
  sourceReadingIds: string[];
  sourceFileHashes: string[];
  result: DayLoadSnapshot;
}

export interface LoadDiff {
  byPollutant: {
    pollutant: Pollutant;
    baseline: LoadBounds;
    recomputed: LoadBounds;
    deltaKg: number;
    deltaPercent: number;
    overlapKg: LoadBounds;
  }[];
  coverageDelta: number;
  gapSecondsDelta: number;
  note: string;
}

export interface RecalcCandidate {
  candidateId: string;
  declarationId: string;
  pointCode: string;
  plantId: string;
  day: string;
  method: IntegrationMethod;
  gridSeconds: number;
  createdAt: number;
  createdBy: string;
  status: 'PENDING' | 'REVIEWED';
  /** 锁定的来源范围：只能引用申报窗口内的读数 */
  windowFrom: number;
  windowTo: number;
  cutoffReceivedAt: number;
  /** 申报后到达、但采样时刻落在已锁定窗口内的迟到读数 */
  lateReadingIds: string[];
  lateFileIds: string[];
  /** 迟到读数是否落在原缺口内 */
  fillsGapSeconds: number;
  baseline: DayLoadSnapshot;
  recomputed: DayLoadSnapshot;
  diff: LoadDiff;
  autoDetected: boolean;
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  /** 申报版本是否被改写（必须始终为 false） */
  declarationOverwritten: false;
}

export interface MonthLoad {
  month: string;
  pointCode: string;
  plantId: string;
  method: IntegrationMethod;
  daysInMonth: number;
  daysWithData: number;
  daysComputed: string[];
  missingDays: string[];
  pollutants: {
    pollutant: Pollutant;
    load: LoadBounds;
    coverageMean: number;
    effectiveSeconds: number;
  }[];
  coverage: number;
  eligibility: EligibilityStatus;
  notes: string[];
}

export interface ScopeOptions {
  /** 是否纳入 qualityFlag=SUSPECT（会拉宽不确定范围） */
  includeSuspect: boolean;
  /** 重采样主网格（秒） */
  gridSeconds: number;
  /** 不确定度膨胀系数（1σ → kσ） */
  uncertaintyMultiplier: number;
  /** 覆盖率合格线 */
  coverageThreshold: number;
}

export const DEFAULT_SCOPE: ScopeOptions = {
  includeSuspect: true,
  gridSeconds: 15,
  uncertaintyMultiplier: 2,
  coverageThreshold: 0.9,
};

export interface Dataset {
  plants: Plant[];
  points: OutfallPoint[];
  instruments: Instrument[];
  calibrations: Calibration[];
  states: StatePeriod[];
  bindings: Binding[];
  readings: Reading[];
  files: IntakeFile[];
}

export interface SampleManifest {
  name: string;
  description: string;
  generatedAt: string;
  timezone: string;
  baseFiles: {
    fileName: string;
    kind: FileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  }[];
  lateFile: {
    fileName: string;
    kind: FileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  };
  focus: {
    pointCode: string;
    day: string;
    declarationCutoff: string;
    scenario: string[];
  };
}
