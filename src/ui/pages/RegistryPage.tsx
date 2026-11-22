import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { InvestigateActions, InvestigateState } from '../investigate/useInvestigate';
import { fmtDateTime, fmtNum, shortTime } from '../format';
import {
  EVIDENCE_WEIGHTS,
  INVESTIGATE_KIND_LABELS,
  SOURCE_KIND_LABELS,
  TRUST_FACTOR,
  type SourceRegistration,
} from '../../investigate/types';

interface Props {
  state: AppState;
  actions: AppActions;
  inv: InvestigateState;
  invActions: InvestigateActions;
}

const DIMS = [
  { key: 'nh3n', label: '氨氮增量', unit: 'mg/L', weight: EVIDENCE_WEIGHTS.NH3N },
  { key: 'cod', label: 'COD 增量', unit: 'mg/L', weight: EVIDENCE_WEIGHTS.COD },
  { key: 'cond', label: '电导率增量', unit: 'µS/cm', weight: EVIDENCE_WEIGHTS.COND },
  { key: 'ph', label: 'pH 变化', unit: '', weight: EVIDENCE_WEIGHTS.PH },
] as const;

export function RegistryPage({ inv, invActions }: Props) {
  const { registryAll, manifest, packLoaded, loading } = inv;
  const [showRevoked, setShowRevoked] = useState(true);

  const sources = useMemo(
    () => [...registryAll.sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || b.version - a.version),
    [registryAll.sources],
  );
  const rainfall = useMemo(() => [...registryAll.rainfall].sort((a, b) => b.version - a.version), [registryAll.rainfall]);
  const batches = useMemo(
    () => [...registryAll.selfReports].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || b.version - a.version),
    [registryAll.selfReports],
  );

  if (!packLoaded) {
    return (
      <div className="card card-pad">
        <div className="empty">
          尚未装载调查资料包。请先在「概览」装载基础样例，然后到「事件与候选」页装载调查资料包。
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>来源登记簿</h2>
          <span className="sub">支管接入位置、允许排放时段、排口等效增量包络；全部记录带版本与可信等级</span>
          <div className="spacer" />
          <label className="checkline">
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
            显示已撤销版本
          </label>
        </div>
        <div className="card-pad stack">
          <div className="note">
            证据权重（全事件统一、预先声明）：氨氮 {EVIDENCE_WEIGHTS.NH3N}、COD {EVIDENCE_WEIGHTS.COD}、电导率{' '}
            {EVIDENCE_WEIGHTS.COND}、pH {EVIDENCE_WEIGHTS.PH}、流量证据 {EVIDENCE_WEIGHTS.FLOW}、自报{' '}
            {EVIDENCE_WEIGHTS.SELF_REPORT}、雨量 {EVIDENCE_WEIGHTS.RAINFALL}；自报类贡献乘可信系数（
            {Object.entries(TRUST_FACTOR)
              .map(([k, v]) => `${k}=${v}`)
              .join('，')}
            ）。缺测维度只产生缺失惩罚。
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>类型</th>
                  <th>接入位置</th>
                  <th>传播时间 s</th>
                  <th>允许排放时段</th>
                  <th>可信</th>
                  <th>版本</th>
                </tr>
              </thead>
              <tbody>
                {sources
                  .filter((s) => showRevoked || !s.revoked)
                  .map((s) => (
                    <SourceRow key={s.recordId} source={s} />
                  ))}
              </tbody>
            </table>
          </div>
          {sources
            .filter((s) => showRevoked || !s.revoked)
            .map((s) => (
              <EnvelopeCard key={`env-${s.recordId}`} source={s} />
            ))}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>雨量序列</h2>
            <span className="sub">误差界用于排序敏感性分析</span>
          </div>
          <div className="card-pad stack">
            {rainfall.map((r) => (
              <dl className="kv" key={r.recordId}>
                <dt>记录</dt>
                <dd className="mono">
                  {r.recordId} {r.revoked && <span className="badge bad">已撤销</span>}
                </dd>
                <dt>量程</dt>
                <dd className="mono">
                  {shortTime(r.from)} → {shortTime(r.to)}（{r.stepSeconds}s 步长，{r.mmPerStep.length} 步）
                </dd>
                <dt>峰值雨强</dt>
                <dd>{fmtNum(Math.max(...r.mmPerStep) * (3600 / r.stepSeconds), 1)} mm/h</dd>
                <dt>误差界 / 可信</dt>
                <dd>
                  ±{fmtNum(r.errorRelative * 100, 0)}% · {r.trustLevel} 级
                </dd>
                <dt>说明</dt>
                <dd className="tiny">{r.note}</dd>
              </dl>
            ))}
            {rainfall.length === 0 && <div className="empty">无雨量序列</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>泵站切换</h2>
            <span className="sub">切换前后传播时间分别登记，召回时按体制分别倒推</span>
          </div>
          <div className="card-pad stack">
            {registryAll.pumpSwitches.map((p) => (
              <dl className="kv" key={p.recordId}>
                <dt>记录</dt>
                <dd className="mono">
                  {p.recordId} {p.revoked && <span className="badge bad">已撤销</span>}
                </dd>
                <dt>泵站 / 时刻</dt>
                <dd>
                  {p.stationName}（{p.stationId}） · {fmtDateTime(p.at)}
                </dd>
                <dt>模式</dt>
                <dd>
                  {p.fromMode} → {p.toMode}
                </dd>
                <dt>影响管道</dt>
                <dd className="tiny">
                  {p.affects.map((a) => (
                    <div key={a.sewerId}>
                      {a.sewerId}：切换后传播 {a.travelTimeAfterS[0]}–{a.travelTimeAfterS[1]} s
                    </div>
                  ))}
                </dd>
                <dt>说明</dt>
                <dd className="tiny">{p.note}</dd>
              </dl>
            ))}
            {registryAll.pumpSwitches.length === 0 && <div className="empty">无泵站切换记录</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>自报批次</h2>
          <span className="sub">更正批次按版本撤销旧批次；依据旧批次的评分同步撤销</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => void invActions.importCorrection()} disabled={loading}>
            导入自报更正批次
          </button>
          <button className="btn small" onClick={() => void invActions.importTopology()} disabled={loading}>
            导入拓扑修订
          </button>
        </div>
        <div className="card-pad">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>来源</th>
                  <th>版本</th>
                  <th>可信</th>
                  <th>接收时刻</th>
                  <th>声明内容</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.recordId} style={b.revoked ? { opacity: 0.55 } : undefined}>
                    <td className="mono tiny">{b.recordId}</td>
                    <td className="tiny">{b.sourceId}</td>
                    <td className="num">v{b.version}</td>
                    <td>{b.trustLevel} 级</td>
                    <td className="mono tiny">{fmtDateTime(b.receivedAt)}</td>
                    <td className="tiny">
                      {b.claims.map((c, i) => (
                        <div key={i}>
                          {c.text}
                          {c.from !== null && c.to !== null && (
                            <span className="muted">
                              （{shortTime(c.from)} → {shortTime(c.to)}
                              {c.flowM3h ? `，${c.flowM3h[0]}–${c.flowM3h[1]} m³/h` : ''}）
                            </span>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      {b.revoked ? (
                        <span className="badge bad" title={b.supersedes ? `被 ${b.supersedes} 取代` : ''}>
                          已撤销
                        </span>
                      ) : (
                        <span className="badge ok">现行</span>
                      )}
                      {b.supersedes && <div className="tiny muted">取代 {b.supersedes}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {manifest && (
            <div className="tiny muted" style={{ marginTop: 8 }}>
              资料包文件类型：{[...new Set(manifest.baseFiles.map((f) => INVESTIGATE_KIND_LABELS[f.kind]))].join('、')}
              ；更正批次 {manifest.correctionFile.fileName} 与拓扑修订 {manifest.topologyFile.fileName} 需手动导入。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceRow({ source: s }: { source: SourceRegistration }) {
  return (
    <tr style={s.revoked ? { opacity: 0.55 } : undefined}>
      <td>
        <strong>{s.name}</strong>
        <div className="tiny muted mono">{s.recordId}</div>
      </td>
      <td className="tiny">{SOURCE_KIND_LABELS[s.kind]}</td>
      <td className="tiny">
        {s.access.sewerId} · 里程 {fmtNum(s.access.chainageM, 0)} m
      </td>
      <td className="num tiny">
        {s.access.travelTimeS[0]}–{s.access.travelTimeS[1]}
      </td>
      <td className="tiny">
        {s.allowed.kind === 'DAILY' && `每日 ${minText(s.allowed.fromMin)}–${minText(s.allowed.toMin)}`}
        {s.allowed.kind === 'RAIN_TRIGGERED' && `雨强 ≥ ${s.allowed.thresholdMmH} mm/h 触发`}
        {s.allowed.kind === 'PUMP_RUNNING' && '回流泵运行时段'}
      </td>
      <td>{s.trustLevel} 级</td>
      <td>
        v{s.version} {s.revoked ? <span className="badge bad">已撤销</span> : <span className="badge ok">现行</span>}
      </td>
    </tr>
  );
}

function EnvelopeCard({ source: s }: { source: SourceRegistration }) {
  if (s.revoked) return null;
  return (
    <div className="note" style={{ background: 'var(--surface-2)' }}>
      <strong>{s.name}</strong>
      <span className="tiny muted">（排口等效增量包络，历史联合监测率定；典型流量 {s.typicalFlowM3h[0]}–{s.typicalFlowM3h[1]} m³/h）</span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {DIMS.map((d) => {
          const env = s.envelope[d.key as keyof SourceRegistration['envelope']];
          return (
            <span key={d.key} className={`badge ${env ? 'neutral' : 'warn'}`} title={`权重 ${d.weight}`}>
              {d.label}：{env ? `${env[0]} – ${env[1]} ${d.unit}` : '缺测'}
            </span>
          );
        })}
      </div>
      <div className="tiny muted" style={{ marginTop: 4 }}>{s.note}</div>
    </div>
  );
}

function minText(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
}
