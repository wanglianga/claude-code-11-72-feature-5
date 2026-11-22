/**
 * 事件调查领域模型：排口短时高氨氮事件的来源排查
 *
 * 统一语义（与基础复核台一致，UI 不得另作解释）：
 * - 登记簿记录全部带 版本(version) 与 可信等级(trustLevel)；更正批次到达后旧版本
 *   revoked=true，依据旧版本计算的评分一并标记 revoked（按版本撤销，不改写内容）。
 * - 候选只由水力传播范围与事件窗口召回；证据组合器输出可回放的逐项贡献，
 *   缺测维度只产生缺失惩罚，不产生支持也不产生反证。
 * - 两条发布路线（集合 / 排序）都只输出“调查优先级”，绝不输出责任结论。
 * - 暴雨事件期间，无独立反证的候选必须保留并列，不得凭时间接近单独剔除。
 * - 拓扑修订不改写已关闭调查；已关闭调查保留关闭时刻的评分快照。
 */

export type SourceKind = 'INDUSTRIAL_BRANCH' | 'CSO_OVERFLOW' | 'PLANT_RECYCLE';

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  INDUSTRIAL_BRANCH: '工业支管',
  CSO_OVERFLOW: '雨污合流溢流',
  PLANT_RECYCLE: '厂内回流',
};

export type TrustLevel = 'A' | 'B' | 'C';

export const TRUST_LABELS: Record<TrustLevel, string> = {
  A: 'A（台账/工单级）',
  B: 'B（自报/常规监测）',
  C: 'C（间接估计）',
};

/** 可信等级折算系数：只作用于自报类证据贡献 */
export const TRUST_FACTOR: Record<TrustLevel, number> = { A: 1.0, B: 0.8, C: 0.55 };

export type FeatureDim = 'NH3N' | 'COD' | 'COND' | 'PH' | 'FLOW';

export const FEATURE_DIM_LABELS: Record<FeatureDim, string> = {
  NH3N: '氨氮增量',
  COD: 'COD 增量',
  COND: '电导率增量',
  PH: 'pH 变化',
  FLOW: '排放流量证据',
};

/** 证据维度权重（全事件统一，预先声明，可回放） */
export const EVIDENCE_WEIGHTS: Record<Exclude<EvidenceDim, 'TIME_BAND' | 'PUMP_STATE'>, number> = {
  NH3N: 0.2,
  COD: 0.12,
  COND: 0.16,
  PH: 0.1,
  FLOW: 0.1,
  SELF_REPORT: 0.16,
  RAINFALL: 0.16,
};

export type EvidenceDim = FeatureDim | 'SELF_REPORT' | 'RAINFALL' | 'TIME_BAND' | 'PUMP_STATE';

export const EVIDENCE_DIM_LABELS: Record<EvidenceDim, string> = {
  ...FEATURE_DIM_LABELS,
  SELF_REPORT: '自报资料',
  RAINFALL: '雨量相容性',
  TIME_BAND: '时间带相容性',
  PUMP_STATE: '泵站切换',
};

export interface Interval {
  from: number;
  to: number;
}

/** 支管接入位置与允许排放时段（登记簿主记录，版本化） */
export interface SourceRegistration {
  /** 记录键：sourceId@v{version} */
  recordId: string;
  sourceId: string;
  kind: SourceKind;
  name: string;
  version: number;
  trustLevel: TrustLevel;
  registeredAt: number;
  /** 被更正版本撤销（内容保留，仅供追溯） */
  revoked: boolean;
  supersedes: string | null;
  access: {
    sewerId: string;
    /** 接入点距排口里程（米） */
    chainageM: number;
    /** 常规体制下的水力传播时间区间（秒） */
    travelTimeS: [number, number];
  };
  allowed:
    | { kind: 'DAILY'; fromMin: number; toMin: number }
    | { kind: 'RAIN_TRIGGERED'; thresholdMmH: number }
    | { kind: 'PUMP_RUNNING' };
  /** 排口等效增量包络（历史联合监测率定；null = 该维度缺测） */
  envelope: {
    nh3n: [number, number] | null;
    cod: [number, number] | null;
    cond: [number, number] | null;
    ph: [number, number] | null;
  };
  /** 典型排放流量（m³/h） */
  typicalFlowM3h: [number, number];
  note: string;
}

export interface PumpSwitch {
  recordId: string;
  switchId: string;
  stationId: string;
  stationName: string;
  at: number;
  fromMode: string;
  toMode: string;
  /** 受影响的管道 → 切换后传播时间区间（秒） */
  affects: { sewerId: string; travelTimeAfterS: [number, number] }[];
  version: number;
  trustLevel: TrustLevel;
  revoked: boolean;
  note: string;
}

export interface RainfallSeries {
  recordId: string;
  seriesId: string;
  gaugeId: string;
  version: number;
  trustLevel: TrustLevel;
  revoked: boolean;
  from: number;
  to: number;
  stepSeconds: number;
  /** 每个步长的降雨量（mm） */
  mmPerStep: number[];
  /** 雨量相对误差界（±），敏感性分析使用 */
  errorRelative: number;
  note: string;
}

export type ClaimKind = 'DISCHARGE' | 'NO_DISCHARGE' | 'PUMP_OFF' | 'OVERFLOW' | 'NOTE';

export interface SelfReportClaim {
  kind: ClaimKind;
  from: number | null;
  to: number | null;
  flowM3h: [number, number] | null;
  text: string;
}

export interface SelfReportBatch {
  recordId: string;
  batchId: string;
  sourceId: string;
  version: number;
  trustLevel: TrustLevel;
  receivedAt: number;
  revoked: boolean;
  supersedes: string | null;
  claims: SelfReportClaim[];
  note: string;
}

/** 事件期间排口加密监测（电导率/pH 等基础台账没有的指标） */
export interface EventProfile {
  recordId: string;
  profileId: string;
  pointCode: string;
  version: number;
  trustLevel: TrustLevel;
  revoked: boolean;
  from: number;
  to: number;
  stepSeconds: number;
  condUsCm: (number | null)[];
  ph: (number | null)[];
  note: string;
}

export interface InvestigationRegistry {
  sources: SourceRegistration[];
  rainfall: RainfallSeries[];
  pumpSwitches: PumpSwitch[];
  selfReports: SelfReportBatch[];
  eventProfiles: EventProfile[];
}

/** 事件指纹：排口观测增量区间（含不确定度） */
export interface EventFingerprint {
  nh3n: [number, number];
  cod: [number, number];
  /** 来自加密监测；null 表示事件层面也缺测 */
  cond: [number, number] | null;
  ph: [number, number] | null;
  flowM3h: [number, number];
}

export interface OutfallEvent {
  eventId: string;
  pointCode: string;
  day: string;
  pollutant: 'NH3N';
  windowFrom: number;
  windowTo: number;
  peakConcentration: number;
  peakAt: number;
  standard: number;
  observed: EventFingerprint;
  /** 各维度观测依据（引擎片段 / 加密监测记录 ID） */
  observedBasis: Record<string, string>;
  stormEvent: boolean;
  computedAt: number;
  engineVersion: string;
}

/** 水力召回：一个候选在一种泵站体制下的传播时间与倒推排放窗口 */
export interface RecallRegime {
  label: string;
  travelTimeS: [number, number];
  /** 该体制下倒推出的排放窗口；null = 该体制下无可行排放时刻（已裁剪） */
  dischargeWindow: Interval | null;
}

export interface CandidateRecall {
  regimes: RecallRegime[];
  /** 各非空体制窗口的包络（仅用于展示；重叠判定逐体制进行） */
  dischargeWindow: Interval;
  /** 泵站是否在事件期间发生切换（已按体制分别倒推） */
  pumpSwitchMidEvent: boolean;
  notes: string[];
}

export type EvidenceVerdict = 'STRONG_MATCH' | 'WEAK_MATCH' | 'CONTRADICT' | 'MISSING' | 'NEUTRAL';

export const VERDICT_LABELS: Record<EvidenceVerdict, string> = {
  STRONG_MATCH: '相容',
  WEAK_MATCH: '弱相容',
  CONTRADICT: '反证',
  MISSING: '缺测',
  NEUTRAL: '中性',
};

export interface EvidenceItem {
  dim: EvidenceDim;
  label: string;
  verdict: EvidenceVerdict;
  /** 该维度满分权重（时间带/泵站为 0：它们是门槛与注记，不计分） */
  weight: number;
  /** 本次贡献（反证为负） */
  contribution: number;
  /** 缺测造成的完整度损失（= weight；非缺测为 0） */
  completenessLoss: number;
  observed: string;
  expected: string;
  /** 可回放依据：登记簿记录键（含版本） */
  basisRecordIds: string[];
  note: string;
  /**
   * 独立性分组：集合路线统计“独立支持数”时，同组维度只计一次（取最强）。
   * 排放流量证据与自报资料若出自同一批次文档，则不视为相互独立。
   */
  independenceGroup: string;
}

export interface RegistryRef {
  kind: 'SOURCE' | 'RAINFALL' | 'PUMP_SWITCH' | 'SELF_REPORT' | 'EVENT_PROFILE';
  recordId: string;
  version: number;
}

export interface CandidateAssessment {
  candidateId: string;
  eventId: string;
  sourceId: string;
  sourceKind: SourceKind;
  sourceName: string;
  recall: CandidateRecall;
  /** 时间带相容性：不相容的候选不进入评分（排除理由留档） */
  timeBandCompatible: boolean;
  excludeReason: string | null;
  items: EvidenceItem[];
  score: number;
  completeness: number;
  registryRefs: RegistryRef[];
  /** 评分依据的自报批次版本（更正到达时按此撤销） */
  selfReportRecordId: string | null;
  /** 依据的自报批次已被更正撤销（旧评分保留追溯，不再有效） */
  revoked: boolean;
  computedAt: number;
}

/** 集合路线：预先声明的独立证据门槛 */
export interface SetRouteThresholds {
  /** 独立支持数下限（相容=1，弱相容=0.5） */
  minIndependentSupports: number;
  /** 强反证数上限 */
  maxStrongCounters: number;
  /** 最低完整度 */
  minCompleteness: number;
  declaredAt: number;
  declaredBy: string;
  note: string;
}

export interface SetRouteResult {
  route: 'SET';
  thresholds: SetRouteThresholds;
  inSet: string[];
  excluded: { candidateId: string; reasons: string[] }[];
  /** 暴雨规则：无独立反证的候选全部保留并列 */
  stormParallelApplied: boolean;
  notes: string[];
}

export interface RankEntry {
  candidateId: string;
  score: number;
  completeness: number;
}

export interface RankScenario {
  label: string;
  ranking: RankEntry[];
  decidable: boolean;
  undecidableReasons: string[];
  note: string;
}

export interface RankRouteResult {
  route: 'RANK';
  marginThreshold: number;
  completenessFloor: number;
  ranking: RankEntry[];
  decidable: boolean;
  undecidableReasons: string[];
  /** 敏感性：自报更正（旧版本）与雨量误差 ± */
  sensitivity: {
    selfReportBefore: RankScenario | null;
    rainfallMinus: RankScenario;
    rainfallPlus: RankScenario;
  };
  notes: string[];
}

export type DeliveryRoute = 'SET' | 'RANK';

export const DELIVERY_DISCLAIMER =
  '本交付仅输出调查优先级（下一步采样与现场核查顺序），不构成、也不得被解释为污染来源的责任结论。';

export interface Delivery {
  deliveryId: string;
  eventId: string;
  route: DeliveryRoute;
  createdAt: number;
  createdBy: string;
  status: 'PUBLISHED' | 'SUPERSEDED';
  supersededBy: string | null;
  setResult: SetRouteResult | null;
  rankResult: RankRouteResult | null;
  /** 发布时刻的候选评估快照（含逐项证据，可回放） */
  candidates: CandidateAssessment[];
  registryRefs: RegistryRef[];
  disclaimer: string;
  contentHash: string;
}

export type InvestigationStatus = 'PENDING' | 'SAMPLING' | 'EXCLUDED' | 'CLOSED';

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> = {
  PENDING: '待核查',
  SAMPLING: '取样中',
  EXCLUDED: '已排除',
  CLOSED: '已关闭',
};

export interface InvestigationTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface SamplingRecord {
  id: string;
  at: number;
  location: string;
  items: string;
  result: string;
  by: string;
}

export interface Investigation {
  investigationId: string;
  eventId: string;
  candidateId: string;
  sourceId: string;
  status: InvestigationStatus;
  todos: InvestigationTodo[];
  samplings: SamplingRecord[];
  exclusionReason: string | null;
  history: { at: number; by: string; action: string; detail: string }[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** 关闭时刻的评分与登记簿版本快照：拓扑修订不改写已关闭调查 */
  closedSnapshot: {
    score: number;
    completeness: number;
    registryRefs: RegistryRef[];
    note: string;
  } | null;
  /** 登记簿已修订且本调查未关闭：评分依据可能过旧 */
  staleRegistry: boolean;
}

/** 调查资料包清单（public/sample/investigate/manifest.json） */
export interface InvestigateManifest {
  name: string;
  description: string;
  generatedAt: string;
  timezone: string;
  event: {
    pointCode: string;
    day: string;
    pollutant: 'NH3N';
    expectWindowLocal: string;
    storm: boolean;
    scenario: string[];
  };
  setRoute: {
    minIndependentSupports: number;
    maxStrongCounters: number;
    minCompleteness: number;
    declaredAt: string;
    declaredBy: string;
    note: string;
  };
  rankRoute: {
    marginThreshold: number;
    completenessFloor: number;
    note: string;
  };
  baseFiles: {
    fileName: string;
    kind: InvestigateFileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  }[];
  correctionFile: {
    fileName: string;
    kind: InvestigateFileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  };
  topologyFile: {
    fileName: string;
    kind: InvestigateFileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  };
}

export type InvestigateFileKind =
  | 'READINGS'
  | 'STATE_LOG'
  | 'SOURCE_REGISTRY'
  | 'RAINFALL'
  | 'PUMP_SWITCH'
  | 'SELF_REPORT'
  | 'EVENT_PROFILE';

export const INVESTIGATE_KIND_LABELS: Record<InvestigateFileKind, string> = {
  READINGS: '排口读数',
  STATE_LOG: '状态台账',
  SOURCE_REGISTRY: '来源登记簿',
  RAINFALL: '雨量序列',
  PUMP_SWITCH: '泵站切换',
  SELF_REPORT: '自报批次',
  EVENT_PROFILE: '事件加密监测',
};
