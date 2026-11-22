import { useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { InvestigateActions, InvestigateState } from '../investigate/useInvestigate';
import type { CandidateAssessment, Investigation } from '../../investigate/types';
import { INVESTIGATION_STATUS_LABELS } from '../../investigate/types';
import { fmtDateTime } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  inv: InvestigateState;
  invActions: InvestigateActions;
  current: CandidateAssessment[];
}

const STATUS_BADGE: Record<Investigation['status'], string> = {
  PENDING: 'warn',
  SAMPLING: 'info',
  EXCLUDED: 'neutral',
  CLOSED: 'ok',
};

export function BoardPage({ state, inv, invActions, current }: Props) {
  if (!inv.packLoaded || !inv.event) {
    return (
      <div className="card card-pad">
        <div className="empty">请先在「事件与候选」页装载调查资料包并检出事件。</div>
      </div>
    );
  }
  const open = inv.investigations.filter((i) => i.status === 'PENDING' || i.status === 'SAMPLING');
  const closed = inv.investigations.filter((i) => i.status === 'EXCLUDED' || i.status === 'CLOSED');

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>调查处置板</h2>
          <span className="sub">取样记录、排除理由与待办；已关闭调查保留快照，拓扑修订不改写</span>
          <div className="spacer" />
          <span className="badge info">未关闭 {open.length}</span>
          <span className="badge neutral">已关闭 {closed.length}</span>
        </div>
        <div className="card-pad stack">
          {inv.investigations.length === 0 && <div className="empty">尚无调查任务：候选生成后自动创建。</div>}
          {[...open, ...closed].map((i) => (
            <InvestigationCard
              key={i.investigationId}
              investigation={i}
              candidate={current.find((c) => c.sourceId === i.sourceId) ?? null}
              actor={state.actor}
              invActions={invActions}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function InvestigationCard({
  investigation: inv,
  candidate,
  actor,
  invActions,
}: {
  investigation: Investigation;
  candidate: CandidateAssessment | null;
  actor: string;
  invActions: InvestigateActions;
}) {
  const [todoText, setTodoText] = useState('');
  const [sampling, setSampling] = useState({ location: '', items: '', result: '' });
  const [reason, setReason] = useState(inv.exclusionReason ?? '');
  const [showHistory, setShowHistory] = useState(false);
  const terminal = inv.status === 'EXCLUDED' || inv.status === 'CLOSED';

  const save = (next: Investigation, action: string, detail: string) => {
    void invActions.saveInvestigation({ ...next, updatedAt: Date.now() }, action, detail);
  };

  return (
    <div className="card" style={{ border: '1px solid var(--line)' }}>
      <div className="card-head">
        <h3>{candidate?.sourceName ?? inv.sourceId}</h3>
        <span className={`badge ${STATUS_BADGE[inv.status]}`}>{INVESTIGATION_STATUS_LABELS[inv.status]}</span>
        {inv.staleRegistry && <span className="badge warn">登记簿已修订，评分依据可能过旧</span>}
        <div className="spacer" />
        {candidate && (
          <span className="tiny muted">
            现行评分 {candidate.score.toFixed(3)} · 完整度 {candidate.completeness.toFixed(2)}
          </span>
        )}
      </div>
      <div className="card-pad stack">
        {inv.closedSnapshot && (
          <div className="note ok">
            关闭快照（{inv.closedAt ? fmtDateTime(inv.closedAt) : '—'}）：评分 {inv.closedSnapshot.score.toFixed(3)} · 完整度{' '}
            {inv.closedSnapshot.completeness.toFixed(2)} · 登记簿引用 {inv.closedSnapshot.registryRefs.length} 条。
            {inv.closedSnapshot.note}
          </div>
        )}

        {/* 待办 */}
        <div>
          <h4>待办（{inv.todos.filter((t) => !t.done).length} 未完成）</h4>
          {inv.todos.map((t) => (
            <label key={t.id} className="checkline" style={{ display: 'flex' }}>
              <input
                type="checkbox"
                checked={t.done}
                disabled={terminal}
                onChange={() =>
                  save(
                    { ...inv, todos: inv.todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) },
                    'TODO_TOGGLE',
                    `${t.done ? '重新打开' : '完成'}待办：${t.text}`,
                  )
                }
              />
              <span style={t.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{t.text}</span>
            </label>
          ))}
          {!terminal && (
            <div className="row" style={{ marginTop: 4 }}>
              <input
                type="text"
                value={todoText}
                placeholder="新增待办，例如：联系化工园调取 14:00–14:40 出水流量计原始记录"
                onChange={(e) => setTodoText(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn small"
                disabled={!todoText.trim()}
                onClick={() => {
                  save(
                    {
                      ...inv,
                      todos: [...inv.todos, { id: `todo-${Date.now()}`, text: todoText.trim(), done: false, createdAt: Date.now() }],
                    },
                    'TODO_ADD',
                    `新增待办：${todoText.trim()}`,
                  );
                  setTodoText('');
                }}
              >
                添加
              </button>
            </div>
          )}
        </div>

        {/* 取样记录 */}
        <div>
          <h4>取样记录（{inv.samplings.length}）</h4>
          {inv.samplings.map((s) => (
            <div key={s.id} className="tiny" style={{ padding: '3px 0' }}>
              <span className="mono">{fmtDateTime(s.at)}</span> · {s.location} · {s.items} → {s.result}
              <span className="muted">（{s.by}）</span>
            </div>
          ))}
          {!terminal && (
            <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
              <input type="text" placeholder="取样点" value={sampling.location} onChange={(e) => setSampling({ ...sampling, location: e.target.value })} style={{ width: 150 }} />
              <input type="text" placeholder="项目（氨氮/COD/电导率…）" value={sampling.items} onChange={(e) => setSampling({ ...sampling, items: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
              <input type="text" placeholder="结果" value={sampling.result} onChange={(e) => setSampling({ ...sampling, result: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
              <button
                className="btn small"
                disabled={!sampling.location.trim() || !sampling.result.trim()}
                onClick={() => {
                  save(
                    {
                      ...inv,
                      samplings: [
                        ...inv.samplings,
                        {
                          id: `smp-${Date.now()}`,
                          at: Date.now(),
                          location: sampling.location.trim(),
                          items: sampling.items.trim() || '未注明',
                          result: sampling.result.trim(),
                          by: actor,
                        },
                      ],
                    },
                    'SAMPLING_ADD',
                    `取样记录：${sampling.location.trim()} → ${sampling.result.trim()}`,
                  );
                  setSampling({ location: '', items: '', result: '' });
                }}
              >
                记录取样
              </button>
            </div>
          )}
        </div>

        {/* 排除理由与状态流转 */}
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {!terminal && (
            <>
              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <label>排除理由（标记排除时必填）</label>
                <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：泵站停运记录覆盖全部倒推窗口，水力不连通" />
              </div>
              {inv.status === 'PENDING' && (
                <button className="btn small" onClick={() => void invActions.transition(inv, 'SAMPLING')}>开始取样</button>
              )}
              {inv.status === 'SAMPLING' && (
                <button className="btn small" onClick={() => void invActions.transition(inv, 'PENDING')}>退回待核查</button>
              )}
              <button className="btn small" onClick={() => void invActions.transition(inv, 'EXCLUDED', reason)}>标记排除</button>
              <button className="btn primary small" onClick={() => void invActions.transition(inv, 'CLOSED', reason)}>关闭调查</button>
            </>
          )}
          {terminal && (
            <button className="btn small" onClick={() => void invActions.transition(inv, 'PENDING')}>重新打开（保留快照）</button>
          )}
        </div>
        {inv.exclusionReason && <div className="note warn">排除理由：{inv.exclusionReason}</div>}

        <button className="linklike tiny" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? '收起处置历史 ▲' : `处置历史（${inv.history.length}）▼`}
        </button>
        {showHistory && (
          <div className="tiny">
            {inv.history.map((h, i) => (
              <div key={i}>
                <span className="mono">{fmtDateTime(h.at)}</span> · {h.by} · {h.action}：{h.detail}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
