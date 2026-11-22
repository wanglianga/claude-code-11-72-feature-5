import { useEffect, useState } from 'react';
import { useAppState, pickDays } from './useAppState';
import type { AppActions, AppState } from './useAppState';
import { OverviewPage } from './pages/OverviewPage';
import { HierarchyPage } from './pages/HierarchyPage';
import { TracePage } from './pages/TracePage';
import { QualityPage } from './pages/QualityPage';
import { RecalcPage } from './pages/RecalcPage';
import { VerifyPage } from './pages/VerifyPage';
import { IntakePage } from './pages/IntakePage';
import { InstrumentPage } from './pages/InstrumentPage';
import { MethodPage } from './pages/MethodPage';
import { MonthPage } from './pages/MonthPage';
import { RegistryPage } from './pages/RegistryPage';
import { EventPage } from './pages/EventPage';
import { RoutesPage } from './pages/RoutesPage';
import { BoardPage } from './pages/BoardPage';
import { DeliveryPage } from './pages/DeliveryPage';
import { useInvestigate } from './investigate/useInvestigate';
import { METHOD_LABEL, fmtNum } from './format';

const NAV: { key: string; label: string; group: string }[] = [
  { key: 'overview', label: '概览', group: '复核' },
  { key: 'hierarchy', label: '层级查询', group: '复核' },
  { key: 'trace', label: '片段与来源链', group: '复核' },
  { key: 'quality', label: '覆盖与资格', group: '合规' },
  { key: 'month', label: '月度汇总', group: '合规' },
  { key: 'recalc', label: '复算候选', group: '合规' },
  { key: 'event', label: '事件与候选', group: '事件调查' },
  { key: 'registry', label: '来源登记簿', group: '事件调查' },
  { key: 'routes', label: '证据路线', group: '事件调查' },
  { key: 'board', label: '调查处置板', group: '事件调查' },
  { key: 'delivery', label: '结论交付', group: '事件调查' },
  { key: 'verify', label: '样例核验', group: '质量保证' },
  { key: 'intake', label: '接入账', group: '资料' },
  { key: 'instruments', label: '设备履历', group: '资料' },
  { key: 'method', label: '方法说明', group: '资料' },
];

export function App() {
  const { state, actions } = useAppState();
  const { inv, invActions, derived } = useInvestigate(state, actions);
  const [page, setPage] = useState<string>('overview');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (state.dataset.points.length === 0 && !state.loading) setPage('overview');
  }, [state.dataset.points.length, state.loading]);

  const groups = [...new Set(NAV.map((n) => n.group))];
  const openInvestigations = inv.investigations.filter((i) => i.status === 'PENDING' || i.status === 'SAMPLING').length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">澄</div>
          <div className="brand-text">
            <strong>排口负荷复核台</strong>
            <span>offline review</span>
          </div>
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="nav-section">{g}</div>
            {NAV.filter((n) => n.group === g).map((n) => (
              <button
                key={n.key}
                className="nav-item"
                aria-current={page === n.key ? 'page' : undefined}
                onClick={() => setPage(n.key)}
              >
                {n.label}
                {n.key === 'recalc' && state.candidates.some((c) => c.status === 'PENDING') && (
                  <span className="nav-badge">{state.candidates.filter((c) => c.status === 'PENDING').length}</span>
                )}
                {n.key === 'quality' && state.declarations.length > 0 && (
                  <span className="nav-badge">{state.declarations.length}</span>
                )}
                {n.key === 'board' && openInvestigations > 0 && <span className="nav-badge">{openInvestigations}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          断网可用 · 数据不出本机
          <br />
          引擎 {state.snapshot?.engineVersion ?? '1.1.0'} · IndexedDB
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <strong>{titleOf(page)}</strong>
            <span>
              {state.dataset.points.find((p) => p.pointCode === state.pointCode)?.name ?? '未载入点位'}
              {' · '}
              <span className="mono">{state.pointCode}</span>
            </span>
          </div>

          <div className="field" style={{ minWidth: 150 }}>
            <label>点位</label>
            <select
              value={state.pointCode}
              onChange={(e) => actions.setPointCode(e.target.value)}
              disabled={state.dataset.points.length === 0}
            >
              {state.dataset.points.map((p) => (
                <option key={p.pointCode} value={p.pointCode}>
                  {p.pointCode} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label>自然日</label>
            <select
              value={state.day}
              onChange={(e) => actions.setDay(e.target.value)}
              disabled={state.dataset.points.length === 0}
            >
              {pickDays(state.dataset, state.pointCode).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 168 }}>
            <label>积分路线</label>
            <select value={state.method} onChange={(e) => actions.setMethod(e.target.value as AppState['method'])}>
              <option value="SEGMENT">{METHOD_LABEL.SEGMENT}</option>
              <option value="RESAMPLE">{METHOD_LABEL.RESAMPLE}</option>
            </select>
          </div>

          <div className="topbar-spacer" />

          {state.computing && (
            <span className="small muted">
              <span className="spinner" style={{ marginRight: 6 }} /> 计算中
            </span>
          )}
          {!state.computing && state.lastComputeMs !== null && (
            <span className="tiny muted mono">{fmtNum(state.lastComputeMs, 0)} ms</span>
          )}
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>
            计算作用域
          </button>
          <button className="btn primary" onClick={() => void actions.recompute()} disabled={state.computing || state.dataset.readings.length === 0}>
            重算
          </button>
        </header>

        {showSettings && <SettingsBar state={state} actions={actions} onClose={() => setShowSettings(false)} />}

        {state.computeError && (
          <div style={{ padding: '0 22px' }}>
            <div className="note bad" style={{ marginTop: 12 }}>计算失败：{state.computeError}</div>
          </div>
        )}

        <div className="content">
          {!state.ready && <div className="card card-pad"><span className="spinner" /> 正在打开本地库…</div>}
          {state.ready && page === 'overview' && <OverviewPage state={state} actions={actions} onNavigate={setPage} />}
          {state.ready && page === 'hierarchy' && <HierarchyPage state={state} actions={actions} onNavigate={setPage} />}
          {state.ready && page === 'trace' && <TracePage state={state} actions={actions} />}
          {state.ready && page === 'quality' && <QualityPage state={state} actions={actions} onNavigate={setPage} />}
          {state.ready && page === 'recalc' && <RecalcPage state={state} actions={actions} />}
          {state.ready && page === 'verify' && <VerifyPage state={state} actions={actions} />}
          {state.ready && page === 'intake' && <IntakePage state={state} actions={actions} />}
          {state.ready && page === 'instruments' && <InstrumentPage state={state} actions={actions} />}
          {state.ready && page === 'method' && <MethodPage state={state} />}
          {state.ready && page === 'month' && <MonthPage state={state} actions={actions} />}
          {state.ready && page === 'event' && (
            <EventPage state={state} actions={actions} inv={inv} invActions={invActions} current={derived.current} />
          )}
          {state.ready && page === 'registry' && <RegistryPage state={state} actions={actions} inv={inv} invActions={invActions} />}
          {state.ready && page === 'routes' && (
            <RoutesPage
              state={state}
              actions={actions}
              inv={inv}
              invActions={invActions}
              current={derived.current}
              setResult={derived.setResult}
              rankResult={derived.rankResult}
            />
          )}
          {state.ready && page === 'board' && (
            <BoardPage state={state} actions={actions} inv={inv} invActions={invActions} current={derived.current} />
          )}
          {state.ready && page === 'delivery' && <DeliveryPage state={state} actions={actions} inv={inv} />}
        </div>
      </main>

      {state.loading && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="spinner" />
              <strong>正在处理本地资料</strong>
            </div>
            {state.progress && (
              <>
                <div className="small muted">{state.progress.step}</div>
                <div className="stat-bar" style={{ marginTop: 8 }}>
                  <i style={{ width: `${(state.progress.done / Math.max(1, state.progress.total)) * 100}%` }} />
                </div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {state.progress.done} / {state.progress.total}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="toasts">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button onClick={() => actions.dismissToast(t.id)} aria-label="关闭">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsBar({ state, actions, onClose }: { state: AppState; actions: AppActions; onClose: () => void }) {
  return (
    <div style={{ padding: '10px 22px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
      <div className="toolbar">
        <div className="field" style={{ minWidth: 130 }}>
          <label>网格（秒）</label>
          <select
            value={state.scope.gridSeconds}
            onChange={(e) => actions.setScope({ gridSeconds: Number(e.target.value) })}
          >
            {[5, 10, 15, 30, 60].map((v) => (
              <option key={v} value={v}>
                {v}s
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 130 }}>
          <label>膨胀系数 k</label>
          <select
            value={state.scope.uncertaintyMultiplier}
            onChange={(e) => actions.setScope({ uncertaintyMultiplier: Number(e.target.value) })}
          >
            {[1, 1.5, 2, 2.5, 3].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 150 }}>
          <label>申报覆盖率线</label>
          <select
            value={state.scope.coverageThreshold}
            onChange={(e) => actions.setScope({ coverageThreshold: Number(e.target.value) })}
          >
            {[0.8, 0.85, 0.9, 0.95].map((v) => (
              <option key={v} value={v}>
                {(v * 100).toFixed(0)}%
              </option>
            ))}
          </select>
        </div>
        <label className="checkline" style={{ alignItems: 'center', marginTop: 16 }}>
          <input
            type="checkbox"
            checked={state.scope.includeSuspect}
            onChange={(e) => actions.setScope({ includeSuspect: e.target.checked })}
          />
          纳入 SUSPECT 读数（拉宽不确定范围）
        </label>
        <div className="field" style={{ minWidth: 150 }}>
          <label>操作人</label>
          <input type="text" value={state.actor} onChange={(e) => actions.setActor(e.target.value)} />
        </div>
        <button className="btn" style={{ marginTop: 16 }} onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}

function titleOf(page: string): string {
  return NAV.find((n) => n.key === page)?.label ?? '排口负荷复核台';
}
