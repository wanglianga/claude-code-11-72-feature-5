import { useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { InvestigateActions, InvestigateState } from '../investigate/useInvestigate';
import type { CandidateAssessment } from '../../investigate/types';
import { EVIDENCE_DIM_LABELS, SOURCE_KIND_LABELS, VERDICT_LABELS } from '../../investigate/types';
import { fmtDateTime, fmtNum, shortTime } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  inv: InvestigateState;
  invActions: InvestigateActions;
  current: CandidateAssessment[];
}

const VERDICT_BADGE: Record<string, string> = {
  STRONG_MATCH: 'ok',
  WEAK_MATCH: 'info',
  CONTRADICT: 'bad',
  MISSING: 'warn',
  NEUTRAL: 'neutral',
};

export function EventPage({ state, inv, invActions, current }: Props) {
  const { event, packLoaded, loading, computing, manifest } = inv;
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!packLoaded) {
    return (
      <div className="card card-pad stack">
        <div className="empty">
          事件调查需要先装载基础样例与调查资料包。
          {state.dataset.points.length === 0 && <div style={{ marginTop: 6 }}>请先在「概览」页装载基础样例资料。</div>}
        </div>
        <div>
          <button
            className="btn primary"
            onClick={() => void invActions.loadPack()}
            disabled={loading || state.dataset.points.length === 0}
          >
            {loading ? '装载中…' : '装载调查资料包（暴雨日读数 + 登记簿）'}
          </button>
        </div>
        {inv.progress && (
          <div className="tiny muted">
            {inv.progress.step}（{inv.progress.done}/{inv.progress.total}）
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      {event ? (
        <div className="card">
          <div className="card-head">
            <h2>短时高氨氮事件</h2>
            <span className="sub">
              {event.pointCode} · {event.day} · 窗口取自基础复核台氨氮阈值穿越（引擎 {event.engineVersion}）
            </span>
            <div className="spacer" />
            <span className="badge warn">暴雨事件</span>
            <button className="btn small" onClick={() => void invActions.computeEvent()} disabled={computing}>
              {computing ? '重算中…' : '按现行登记簿重算'}
            </button>
          </div>
          <div className="card-pad stack">
            <div className="grid cols-4">
              <div className="card stat">
                <div className="stat-label">事件窗口</div>
                <div className="stat-value small mono">
                  {shortTime(event.windowFrom)} → {shortTime(event.windowTo)}
                </div>
                <div className="stat-foot">持续 {fmtNum((event.windowTo - event.windowFrom) / 60000, 1)} 分钟</div>
              </div>
              <div className="card stat">
                <div className="stat-label">氨氮峰值</div>
                <div className="stat-value small">
                  {fmtNum(event.peakConcentration, 2)} <span className="stat-unit">mg/L</span>
                </div>
                <div className="stat-foot">限值 {event.standard} mg/L · {shortTime(event.peakAt)}</div>
              </div>
              <div className="card stat">
                <div className="stat-label">召回候选</div>
                <div className="stat-value small">{current.length}</div>
                <div className="stat-foot">{current.filter((c) => c.timeBandCompatible).length} 个通过时间带门槛</div>
              </div>
              <div className="card stat">
                <div className="stat-label">泵站切换</div>
                <div className="stat-value small">{current.some((c) => c.recall.pumpSwitchMidEvent) ? '有' : '无'}</div>
                <div className="stat-foot">按体制分别倒推排放窗口</div>
              </div>
            </div>
            <div>
              <h3 style={{ marginBottom: 6 }}>事件指纹（排口观测增量，含不确定度）</h3>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="badge neutral">氨氮 {event.observed.nh3n[0]} – {event.observed.nh3n[1]} mg/L</span>
                <span className="badge neutral">COD {event.observed.cod[0]} – {event.observed.cod[1]} mg/L</span>
                <span className="badge neutral">
                  电导率 {event.observed.cond ? `${event.observed.cond[0]} – ${event.observed.cond[1]} µS/cm` : '无观测'}
                </span>
                <span className="badge neutral">pH {event.observed.ph ? `${event.observed.ph[0]} – ${event.observed.ph[1]}` : '无观测'}</span>
                <span className="badge neutral">流量 {event.observed.flowM3h[0]} – {event.observed.flowM3h[1]} m³/h</span>
              </div>
              <div className="tiny muted" style={{ marginTop: 4 }}>
                依据：{Object.entries(event.observedBasis).map(([k, v]) => `${k} ← ${v}`).join('；')}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card card-pad">
          <div className="empty">资料包已装载，尚未检出事件。</div>
          <button className="btn primary" onClick={() => void invActions.computeEvent()} disabled={computing}>
            {computing ? '计算中…' : '检出事件并生成候选'}
          </button>
        </div>
      )}

      {current.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>水力候选与证据展开</h2>
            <span className="sub">候选只由水力传播范围与事件窗口召回；每项证据贡献可回放</span>
          </div>
          <div className="card-pad stack">
            {current.map((c) => (
              <CandidateCard
                key={c.candidateId}
                candidate={c}
                expanded={expanded === c.candidateId}
                onToggle={() => setExpanded((v) => (v === c.candidateId ? null : c.candidateId))}
              />
            ))}
            <div className="note warn">
              暴雨事件期间，无独立反证的候选必须保留并列；本页不输出、也不得被用来输出责任结论——
              评分只表示下一步采样与现场核查的优先级。
            </div>
          </div>
        </div>
      )}
      {manifest && (
        <div className="tiny muted">
          资料包：{manifest.name} · 事件口径 {manifest.event.expectWindowLocal} · 集合门槛声明于 {manifest.setRoute.declaredAt}（{manifest.setRoute.declaredBy}）
        </div>
      )}
    </div>
  );
}

function CandidateCard({ candidate: c, expanded, onToggle }: { candidate: CandidateAssessment; expanded: boolean; onToggle: () => void }) {
  const supports = c.items.filter((i) => i.weight > 0 && (i.verdict === 'STRONG_MATCH' || i.verdict === 'WEAK_MATCH'));
  const counters = c.items.filter((i) => i.verdict === 'CONTRADICT');
  const missing = c.items.filter((i) => i.verdict === 'MISSING');
  return (
    <div className="card" style={{ border: '1px solid var(--line)' }}>
      <div className="card-head" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <h3>
          {c.sourceName}
          <span className="tiny muted" style={{ marginLeft: 8 }}>{SOURCE_KIND_LABELS[c.sourceKind]}</span>
        </h3>
        {!c.timeBandCompatible && <span className="badge bad">时间带不相容</span>}
        {c.recall.pumpSwitchMidEvent && <span className="badge info">泵站中途切换</span>}
        <div className="spacer" />
        {c.timeBandCompatible && (
          <>
            <span className="badge neutral">评分 {c.score.toFixed(3)}</span>
            <span className={`badge ${c.completeness >= 0.6 ? 'neutral' : 'warn'}`}>完整度 {c.completeness.toFixed(2)}</span>
          </>
        )}
        <span className="tiny muted">{expanded ? '收起 ▲' : '展开 ▼'}</span>
      </div>
      <div className="card-pad stack">
        <div className="tiny">
          <strong>倒推排放窗口：</strong>
          {c.recall.regimes.map((r, i) => (
            <span key={i} className="mono" style={{ marginRight: 10 }}>
              {r.label}：
              {r.dischargeWindow ? `${shortTime(r.dischargeWindow.from)} → ${shortTime(r.dischargeWindow.to)}` : '无可行排放时刻'}
              （τ {r.travelTimeS[0]}–{r.travelTimeS[1]}s）
            </span>
          ))}
        </div>
        {c.recall.notes.map((n, i) => (
          <div key={i} className="tiny muted">· {n}</div>
        ))}
        {!c.timeBandCompatible && <div className="note bad">排除理由：{c.excludeReason}</div>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="tiny muted">支持 {supports.length}</span>
          <span className="tiny muted">反证 {counters.length}</span>
          <span className="tiny muted">缺测 {missing.length}</span>
        </div>
        {expanded && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>证据维度</th>
                  <th>判定</th>
                  <th className="num">权重</th>
                  <th className="num">贡献</th>
                  <th className="num">缺失惩罚</th>
                  <th>观测</th>
                  <th>期望 / 登记</th>
                  <th>依据记录</th>
                </tr>
              </thead>
              <tbody>
                {c.items.map((it, i) => (
                  <tr key={`${it.dim}-${i}`}>
                    <td className="tiny">{EVIDENCE_DIM_LABELS[it.dim]}</td>
                    <td>
                      <span className={`badge ${VERDICT_BADGE[it.verdict]}`}>{VERDICT_LABELS[it.verdict]}</span>
                    </td>
                    <td className="num tiny">{it.weight > 0 ? it.weight.toFixed(2) : '—'}</td>
                    <td className="num tiny">{it.weight > 0 ? it.contribution.toFixed(3) : '—'}</td>
                    <td className="num tiny">{it.completenessLoss > 0 ? `-${it.completenessLoss.toFixed(2)}` : '—'}</td>
                    <td className="tiny">{it.observed}</td>
                    <td className="tiny">{it.expected}</td>
                    <td className="tiny mono">
                      {it.basisRecordIds.length > 0 ? it.basisRecordIds.join('，') : '—'}
                      {it.note && <div className="muted" style={{ fontFamily: 'var(--sans)' }}>{it.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              回放口径：总分 = Σ贡献 = {c.score.toFixed(3)}；完整度 = 1 − Σ缺失惩罚 = {c.completeness.toFixed(2)}；
              登记簿引用 {c.registryRefs.map((r) => `${r.recordId}`).join('，')}；计算于 {fmtDateTime(c.computedAt)}。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
