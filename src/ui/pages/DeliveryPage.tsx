import { useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { InvestigateState } from '../investigate/useInvestigate';
import type { CandidateAssessment, Delivery } from '../../investigate/types';
import { DELIVERY_DISCLAIMER, EVIDENCE_DIM_LABELS, VERDICT_LABELS } from '../../investigate/types';
import { fmtDateTime, hashShort } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  inv: InvestigateState;
}

export function DeliveryPage({ inv }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deliveries = inv.deliveries;
  const active = deliveries.find((d) => d.deliveryId === selectedId) ?? deliveries[0] ?? null;

  if (!inv.packLoaded || !inv.event) {
    return (
      <div className="card card-pad">
        <div className="empty">请先在「事件与候选」页装载调查资料包并检出事件，再到「证据路线」页发布交付。</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>结论交付（可审计）</h2>
          <span className="sub">交付一旦发布不可改写；更正只能产生新版本并取代旧版本</span>
          <div className="spacer" />
          {deliveries.length > 1 && (
            <select value={active?.deliveryId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
              {deliveries.map((d) => (
                <option key={d.deliveryId} value={d.deliveryId}>
                  {fmtDateTime(d.createdAt)} · {d.route === 'SET' ? '集合' : '排序'} · {d.status === 'PUBLISHED' ? '现行' : '已被取代'}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="card-pad stack">
          {deliveries.length === 0 && <div className="empty">尚无交付：请到「证据路线」页发布集合或排序交付。</div>}
          {active && <DeliveryDetail delivery={active} />}
        </div>
      </div>
    </div>
  );
}

function DeliveryDetail({ delivery: d }: { delivery: Delivery }) {
  return (
    <>
      <div className={`note ${d.status === 'PUBLISHED' ? 'warn' : 'bad'}`}>
        <strong>{d.disclaimer}</strong>
        {d.status === 'SUPERSEDED' && <div className="tiny" style={{ marginTop: 4 }}>本版本已被 {d.supersededBy} 取代，内容保留供回放审计。</div>}
      </div>
      <div className="grid cols-4">
        <div className="card stat">
          <div className="stat-label">路线</div>
          <div className="stat-value small">{d.route === 'SET' ? '集合发布' : '排序发布'}</div>
          <div className="stat-foot">{d.status === 'PUBLISHED' ? '现行版本' : '已被取代'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">发布人 / 时刻</div>
          <div className="stat-value small">{d.createdBy}</div>
          <div className="stat-foot mono">{fmtDateTime(d.createdAt)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">内容哈希</div>
          <div className="stat-value small mono" title={d.contentHash}>{hashShort(d.contentHash)}</div>
          <div className="stat-foot">SHA-256（候选证据 + 门槛 + 登记簿版本）</div>
        </div>
        <div className="card stat">
          <div className="stat-label">登记簿引用</div>
          <div className="stat-value small">{d.registryRefs.length}</div>
          <div className="stat-foot">全部含版本号，可逐条回放</div>
        </div>
      </div>

      {d.setResult && (
        <div className="card" style={{ border: '1px solid var(--line)' }}>
          <div className="card-pad">
            <h3>集合结论</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {d.setResult.inSet.map((id) => (
                <span key={id} className="badge ok">{nameOf(d, id)}</span>
              ))}
              {d.setResult.inSet.length === 0 && <span className="badge neutral">空集合</span>}
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              门槛：独立支持 ≥ {d.setResult.thresholds.minIndependentSupports} · 独立反证 ≤ {d.setResult.thresholds.maxStrongCounters} · 完整度 ≥{' '}
              {d.setResult.thresholds.minCompleteness}（声明于 {fmtDateTime(d.setResult.thresholds.declaredAt)}，{d.setResult.thresholds.declaredBy}）
            </div>
            {d.setResult.excluded.map((e) => (
              <div key={e.candidateId} className="tiny muted" style={{ marginTop: 2 }}>
                未入选 {nameOf(d, e.candidateId)}：{e.reasons.join('；')}
              </div>
            ))}
          </div>
        </div>
      )}

      {d.rankResult && (
        <div className="card" style={{ border: '1px solid var(--line)' }}>
          <div className="card-pad">
            <h3>排序结论{d.rankResult.decidable ? '' : '（不可判定）'}</h3>
            {!d.rankResult.decidable && <div className="note warn">{d.rankResult.undecidableReasons.join('；')}</div>}
            <table>
              <thead>
                <tr>
                  <th>位次</th>
                  <th>候选</th>
                  <th className="num">评分</th>
                  <th className="num">完整度</th>
                </tr>
              </thead>
              <tbody>
                {d.rankResult.ranking.map((r, i) => (
                  <tr key={r.candidateId}>
                    <td className="num">{d.rankResult!.decidable ? i + 1 : '并列'}</td>
                    <td>{nameOf(d, r.candidateId)}</td>
                    <td className="num">{r.score.toFixed(3)}</td>
                    <td className="num">{r.completeness.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              敏感性快照：自报更正前 {d.rankResult.sensitivity.selfReportBefore ? (d.rankResult.sensitivity.selfReportBefore.decidable ? '可判定' : '不可判定') : '—'}
              {' · '}雨量下浮 {d.rankResult.sensitivity.rainfallMinus.decidable ? '可判定' : '不可判定'}
              {' · '}雨量上浮 {d.rankResult.sensitivity.rainfallPlus.decidable ? '可判定' : '不可判定'}
            </div>
          </div>
        </div>
      )}

      <h3>支持与反证并列（发布时刻快照）</h3>
      {d.candidates.map((c) => (
        <CandidateEvidence key={c.candidateId} candidate={c} />
      ))}

      <div className="card" style={{ border: '1px solid var(--line)' }}>
        <div className="card-pad">
          <h3>登记簿版本清单（回放依据）</h3>
          <div className="tiny mono">
            {d.registryRefs.map((r) => (
              <div key={r.recordId}>{r.kind} · {r.recordId}（v{r.version}）</div>
            ))}
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>
            交付标识 <span className="mono">{d.deliveryId}</span> · 事件 <span className="mono">{d.eventId}</span>
          </div>
        </div>
      </div>
      <div className="note">{DELIVERY_DISCLAIMER}</div>
    </>
  );
}

function CandidateEvidence({ candidate: c }: { candidate: CandidateAssessment }) {
  const supports = c.items.filter((i) => i.weight > 0 && (i.verdict === 'STRONG_MATCH' || i.verdict === 'WEAK_MATCH'));
  const counters = c.items.filter((i) => i.verdict === 'CONTRADICT');
  const missing = c.items.filter((i) => i.verdict === 'MISSING');
  return (
    <div className="card" style={{ border: '1px solid var(--line)' }}>
      <div className="card-head">
        <h3>{c.sourceName}</h3>
        {!c.timeBandCompatible && <span className="badge bad">时间带不相容</span>}
        <div className="spacer" />
        {c.timeBandCompatible && (
          <span className="tiny muted">评分 {c.score.toFixed(3)} · 完整度 {c.completeness.toFixed(2)}</span>
        )}
      </div>
      <div className="card-pad">
        {!c.timeBandCompatible && <div className="note bad">排除理由：{c.excludeReason}</div>}
        <div className="grid cols-2">
          <div>
            <h4>支持（{supports.length}）</h4>
            {supports.length === 0 && <div className="tiny muted">无</div>}
            {supports.map((it, i) => (
              <div key={i} className="tiny" style={{ padding: '2px 0' }}>
                <span className={`badge ${it.verdict === 'STRONG_MATCH' ? 'ok' : 'info'}`}>{VERDICT_LABELS[it.verdict]}</span>{' '}
                {EVIDENCE_DIM_LABELS[it.dim]} <span className="mono">+{it.contribution.toFixed(3)}</span>
                <div className="muted">{it.observed} ↔ {it.expected}</div>
              </div>
            ))}
          </div>
          <div>
            <h4>反证与缺测（{counters.length + missing.length}）</h4>
            {counters.length + missing.length === 0 && <div className="tiny muted">无</div>}
            {counters.map((it, i) => (
              <div key={`c-${i}`} className="tiny" style={{ padding: '2px 0' }}>
                <span className="badge bad">反证</span> {EVIDENCE_DIM_LABELS[it.dim]}{' '}
                <span className="mono">{it.contribution.toFixed(3)}</span>
                <div className="muted">{it.observed} ↔ {it.expected}</div>
              </div>
            ))}
            {missing.map((it, i) => (
              <div key={`m-${i}`} className="tiny" style={{ padding: '2px 0' }}>
                <span className="badge warn">缺测</span> {EVIDENCE_DIM_LABELS[it.dim]}{' '}
                <span className="mono">完整度 -{it.completenessLoss.toFixed(2)}</span>
                <div className="muted">{it.note}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function nameOf(d: Delivery, candidateId: string): string {
  return d.candidates.find((c) => c.candidateId === candidateId)?.sourceName ?? candidateId;
}
