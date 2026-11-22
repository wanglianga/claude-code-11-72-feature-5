import type { AppActions, AppState } from '../useAppState';
import type { InvestigateActions, InvestigateState, RankRouteResult, SetRouteResult } from '../investigate/useInvestigate';
import type { CandidateAssessment, RankScenario } from '../../investigate/types';
import { independentSupports } from '../../investigate/routes';
import { fmtDateTime } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  inv: InvestigateState;
  invActions: InvestigateActions;
  current: CandidateAssessment[];
  setResult: SetRouteResult | null;
  rankResult: RankRouteResult | null;
}

export function RoutesPage({ inv, invActions, current, setResult, rankResult }: Props) {
  if (!inv.packLoaded || !inv.event) {
    return (
      <div className="card card-pad">
        <div className="empty">请先在「事件与候选」页装载调查资料包并检出事件。</div>
      </div>
    );
  }
  const nameOf = (candidateId: string) => current.find((c) => c.candidateId === candidateId)?.sourceName ?? candidateId;

  return (
    <div className="stack">
      <div className="note bad">
        两条路线都只输出<strong>调查优先级</strong>（下一步采样与现场核查顺序），不构成、也不得被解释为污染来源的责任结论。
      </div>

      {/* 集合路线 */}
      <div className="card">
        <div className="card-head">
          <h2>路线一 · 集合发布（保守）</h2>
          <span className="sub">只发布满足预先声明的独立证据门槛的候选集合，留下更多并列对象</span>
          <div className="spacer" />
          <button className="btn primary small" onClick={() => void invActions.publish('SET')} disabled={!setResult}>
            发布集合交付
          </button>
        </div>
        <div className="card-pad stack">
          {setResult && (
            <>
              <dl className="kv">
                <dt>预先声明门槛</dt>
                <dd>
                  独立支持 ≥ {setResult.thresholds.minIndependentSupports}（相容=1、弱相容=0.5） · 独立反证 ≤{' '}
                  {setResult.thresholds.maxStrongCounters} · 完整度 ≥ {setResult.thresholds.minCompleteness}
                </dd>
                <dt>声明时刻 / 声明人</dt>
                <dd className="mono">
                  {fmtDateTime(setResult.thresholds.declaredAt)} · {setResult.thresholds.declaredBy}
                </dd>
                <dt>声明内容</dt>
                <dd className="tiny">{setResult.thresholds.note}</dd>
              </dl>
              <div className="grid cols-2">
                <div className="card" style={{ border: '1px solid var(--line)' }}>
                  <div className="card-pad">
                    <h3>入选集合（{setResult.inSet.length}）</h3>
                    {setResult.inSet.length === 0 && <div className="empty">无候选满足门槛</div>}
                    {setResult.inSet.map((id) => {
                      const c = current.find((x) => x.candidateId === id);
                      const s = c ? independentSupports(c) : null;
                      return (
                        <div key={id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                          <span>{nameOf(id)}</span>
                          {s && (
                            <span className="tiny muted">
                              独立支持 {s.supports} · 反证 {s.counters} · 完整度 {c!.completeness.toFixed(2)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {setResult.stormParallelApplied && (
                      <div className="note warn" style={{ marginTop: 6 }}>暴雨规则已生效：无独立反证的候选保留并列。</div>
                    )}
                  </div>
                </div>
                <div className="card" style={{ border: '1px solid var(--line)' }}>
                  <div className="card-pad">
                    <h3>未入选（{setResult.excluded.length}）</h3>
                    {setResult.excluded.map((e) => (
                      <div key={e.candidateId} style={{ padding: '4px 0' }}>
                        <div>{nameOf(e.candidateId)}</div>
                        <div className="tiny muted">{e.reasons.join('；')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {setResult.notes.map((n, i) => (
                <div key={i} className="tiny muted">· {n}</div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* 排序路线 */}
      <div className="card">
        <div className="card-head">
          <h2>路线二 · 排序发布（可拒答）</h2>
          <span className="sub">每个证据贡献与缺测惩罚可回放；分差不足或完整度过低时输出不可判定</span>
          <div className="spacer" />
          <button className="btn primary small" onClick={() => void invActions.publish('RANK')} disabled={!rankResult}>
            发布排序交付
          </button>
        </div>
        <div className="card-pad stack">
          {rankResult && (
            <>
              {!rankResult.decidable && (
                <div className="note warn">
                  <strong>不可判定：</strong>
                  {rankResult.undecidableReasons.join('；')}。建议按集合路线发布并列候选，或补充取证后再排序。
                </div>
              )}
              <RankingTable ranking={rankResult.ranking} nameOf={nameOf} decidable={rankResult.decidable} />
              <div className="tiny muted">
                拒答门槛：前两名分差 ≥ {rankResult.marginThreshold} 且首位完整度 ≥ {rankResult.completenessFloor} 方可输出排序。
              </div>

              <h3>排序敏感性（必须展示）</h3>
              <div className="grid cols-3">
                {rankResult.sensitivity.selfReportBefore && (
                  <ScenarioCard title="自报更正前（旧版本批次）" scenario={rankResult.sensitivity.selfReportBefore} nameOf={nameOf} />
                )}
                <ScenarioCard title="雨量下浮（误差界）" scenario={rankResult.sensitivity.rainfallMinus} nameOf={nameOf} />
                <ScenarioCard title="雨量上浮（误差界）" scenario={rankResult.sensitivity.rainfallPlus} nameOf={nameOf} />
              </div>
              {rankResult.notes.map((n, i) => (
                <div key={i} className="tiny muted">· {n}</div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RankingTable({ ranking, nameOf, decidable }: { ranking: RankRouteResult['ranking']; nameOf: (id: string) => string; decidable: boolean }) {
  return (
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
        {ranking.map((r, i) => (
          <tr key={r.candidateId}>
            <td className="num">{decidable ? i + 1 : '并列'}</td>
            <td>{nameOf(r.candidateId)}</td>
            <td className="num">{r.score.toFixed(3)}</td>
            <td className="num">{r.completeness.toFixed(2)}</td>
          </tr>
        ))}
        {ranking.length === 0 && (
          <tr>
            <td colSpan={4} className="empty">没有通过时间带门槛的候选</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ScenarioCard({ title, scenario, nameOf }: { title: string; scenario: RankScenario; nameOf: (id: string) => string }) {
  return (
    <div className="card" style={{ border: '1px solid var(--line)' }}>
      <div className="card-pad">
        <h3>{title}</h3>
        <div className="tiny muted" style={{ marginBottom: 6 }}>{scenario.note}</div>
        {scenario.ranking.map((r, i) => (
          <div key={r.candidateId} className="row" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
            <span className="tiny">{scenario.decidable ? `${i + 1}. ` : ''}{nameOf(r.candidateId)}</span>
            <span className="tiny mono">{r.score.toFixed(3)}</span>
          </div>
        ))}
        {!scenario.decidable && (
          <div className="note warn" style={{ marginTop: 6 }}>
            不可判定：{scenario.undecidableReasons.join('；')}
          </div>
        )}
      </div>
    </div>
  );
}
