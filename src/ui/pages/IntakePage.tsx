import { useEffect, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { IntakeFile } from '../../domain/types';
import { readingsByFile } from '../../db/db';
import { fmtDateTime, hashShort, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

const KIND_LABEL: Record<string, string> = {
  PLANT_REGISTER: '厂站台账',
  POINT_REGISTER: '点位台账',
  INSTRUMENT_REGISTER: '设备履历',
  BINDING_REGISTER: '绑定有效期',
  CALIBRATION_REGISTER: '校准台账',
  STATE_LOG: '状态台账',
  READINGS: '读数批次',
  LATE_BATCH: '迟到补录',
  SOURCE_REGISTRY: '来源登记簿',
  RAINFALL: '雨量序列',
  PUMP_SWITCH: '泵站切换',
  SELF_REPORT: '自报批次',
  EVENT_PROFILE: '事件加密监测',
};

export function IntakePage({ state, actions }: Props) {
  const [selected, setSelected] = useState<IntakeFile | null>(null);
  const [storedReadings, setStoredReadings] = useState<number | null>(null);

  useEffect(() => {
    if (!selected) {
      setStoredReadings(null);
      return;
    }
    let alive = true;
    void readingsByFile(selected.fileId).then((rows) => {
      if (alive) setStoredReadings(rows.length);
    });
    return () => {
      alive = false;
    };
  }, [selected]);

  const files = state.files;
  const totals = files.reduce(
    (acc, f) => ({
      rows: acc.rows + f.rowCount,
      accepted: acc.accepted + f.acceptedRows,
      rejected: acc.rejected + f.rejectedRows,
    }),
    { rows: 0, accepted: 0, rejected: 0 },
  );

  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card stat">
          <div className="stat-label">接入文件</div>
          <div className="stat-value">{files.length}</div>
          <div className="stat-foot">每份文件一行，指纹为 SHA-256</div>
        </div>
        <div className="card stat">
          <div className="stat-label">文件行数</div>
          <div className="stat-value">{totals.rows.toLocaleString('zh-CN')}</div>
          <div className="stat-foot">含台账与读数</div>
        </div>
        <div className="card stat">
          <div className="stat-label">已接受</div>
          <div className="stat-value">{totals.accepted.toLocaleString('zh-CN')}</div>
          <div className="stat-foot">通过归属与数值校验</div>
        </div>
        <div className="card stat">
          <div className="stat-label">已拒绝</div>
          <div className="stat-value" style={{ color: totals.rejected > 0 ? 'var(--danger)' : undefined }}>
            {totals.rejected.toLocaleString('zh-CN')}
          </div>
          <div className="stat-foot">未登记仪表 / 绑定缺失 / 解析失败</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>接入账</h2>
          <span className="sub">文件接收时刻与入库时间分离；迟到文件以文件接收时刻判定</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => void actions.loadSample()} disabled={state.loading}>
            重新装载样例
          </button>
          <button className="btn small" onClick={() => void actions.importLate()} disabled={state.loading}>
            导入迟到补录
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>文件</th>
                <th>类型</th>
                <th>SHA-256</th>
                <th className="num">字节</th>
                <th className="num">行数</th>
                <th className="num">接受</th>
                <th className="num">拒绝</th>
                <th>接收时刻</th>
                <th>入库</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.fileId} className={selected?.fileId === f.fileId ? 'selected' : ''} onClick={() => setSelected(f)} style={{ cursor: 'pointer' }}>
                  <td className="mono tiny">{f.fileName}</td>
                  <td>
                    <span className={`badge ${f.kind === 'LATE_BATCH' ? 'warn' : 'neutral'}`}>{KIND_LABEL[f.kind] ?? f.kind}</span>
                  </td>
                  <td className="mono tiny" title={f.sha256}>{hashShort(f.sha256)}</td>
                  <td className="num">{f.sizeBytes.toLocaleString('zh-CN')}</td>
                  <td className="num">{f.rowCount.toLocaleString('zh-CN')}</td>
                  <td className="num">{f.acceptedRows.toLocaleString('zh-CN')}</td>
                  <td className="num" style={{ color: f.rejectedRows > 0 ? 'var(--danger)' : undefined }}>
                    {f.rejectedRows}
                  </td>
                  <td className="mono tiny">{fmtDateTime(f.receivedAt)}</td>
                  <td className="mono tiny muted">{fmtDateTime(f.ingestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="card-head">
            <h2>文件详情</h2>
            <span className="sub mono">{selected.fileName}</span>
          </div>
          <div className="card-pad grid cols-2">
            <dl className="kv">
              <dt>fileId</dt>
              <dd className="mono tiny">{selected.fileId}</dd>
              <dt>完整指纹</dt>
              <dd className="mono tiny">{selected.sha256}</dd>
              <dt>类型 / 样例</dt>
              <dd>{KIND_LABEL[selected.kind] ?? selected.kind} · {selected.sample ? '样例' : '用户导入'}</dd>
              <dt>接收 / 入库</dt>
              <dd className="mono tiny">{fmtDateTime(selected.receivedAt)} / {fmtDateTime(selected.ingestedAt)}</dd>
              <dt>入库人</dt>
              <dd>{selected.ingestedBy}</dd>
              <dt>行数</dt>
              <dd>
                总 {selected.rowCount}，接受 {selected.acceptedRows}，拒绝 {selected.rejectedRows}
                {storedReadings !== null && <span className="muted">（库中实存读数 {storedReadings}）</span>}
              </dd>
              <dt>说明</dt>
              <dd className="small">{selected.note}</dd>
            </dl>
            <div className="stack">
              <h3 className="small">拒绝原因</h3>
              {selected.rejectedReasons.length === 0 ? (
                <div className="small muted">无拒绝行</div>
              ) : (
                <ul className="list-reset stack" style={{ gap: 4 }}>
                  {selected.rejectedReasons.map((r, i) => (
                    <li key={i} className="small" style={{ color: 'var(--danger)' }}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="note small">
                文件指纹用于冻结来源：申报版本保存文件 ID 与指纹列表；迟到文件即使同名也因指纹不同而不会被当作同一来源。
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>操作审计</h2>
          <span className="sub">装载、出具申报、生成候选、复核均记入本地审计</span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>说明</th>
                <th>关联</th>
              </tr>
            </thead>
            <tbody>
              {state.audits.map((a) => (
                <tr key={a.auditId}>
                  <td className="mono tiny">{fmtDateTime(a.at)}</td>
                  <td className="tiny">{a.actor}</td>
                  <td>
                    <span className="badge neutral">{a.action}</span>
                  </td>
                  <td className="small">{a.detail}</td>
                  <td className="mono tiny muted">{a.refIds.map((id) => trimId(id, 18, 6)).join('，')}</td>
                </tr>
              ))}
              {state.audits.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted small">暂无审计记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            清空本地库会同时删除读数、申报版本、重算候选与审计，仅用于演示复位。
          </div>
          <button className="btn" onClick={() => void actions.reset()}>
            清空本地库
          </button>
        </div>
      </div>
    </div>
  );
}
