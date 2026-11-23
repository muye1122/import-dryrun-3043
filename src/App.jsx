import React, { useEffect, useState } from 'react';

const API = '/api/v1';

async function api(path, options) {
  const res = await fetch(API + path, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.message || '请求失败');
    err.code = data?.code;
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

function Panel({ title, children, testid, note }) {
  return (
    <section className="panel" data-testid={testid}>
      <h3>{title}</h3>
      {note && <p className="tiny">{note}</p>}
      {children}
    </section>
  );
}

const fmtCounts = (c) => c
  ? `create=${c.create} · update=${c.update} · unchanged=${c.unchanged} · error=${c.error} · warning=${c.warning}`
  : '—';

const fmtDiff = (diff) => (!diff || diff.length === 0)
  ? '—'
  : diff.map((d) => `${d.field}: ${d.old_value || '∅'} → ${d.new_value || '∅'}`).join('；');

export default function App() {
  const [report, setReport] = useState(null);
  const [commitResult, setCommitResult] = useState(null);
  const [counts, setCounts] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCounts = () => api('/tables/counts').then(setCounts).catch(() => {});
  useEffect(() => { loadCounts(); }, []);

  const runFull = async () => {
    setBusy(true); setMsg(''); setCommitResult(null);
    try {
      await post('/demo/reset');
      const r = await post('/dry-run', {});
      setReport(r);
      setMsg(`预演完成：${r.status}，共 ${r.total_rows} 行。`);
      await loadCounts();
    } catch (e) { setMsg(`错误 [${e.code || e.status}]：${e.message}`); }
    finally { setBusy(false); }
  };

  const runReady = async () => {
    setBusy(true); setMsg(''); setCommitResult(null);
    try {
      const r = await post('/demo/ready-dry-run');
      setReport(r);
      setMsg(`预演完成：${r.status}，共 ${r.rows.length} 行（无阻塞问题）。`);
      await loadCounts();
    } catch (e) { setMsg(`错误 [${e.code || e.status}]：${e.message}`); }
    finally { setBusy(false); }
  };

  const commit = async (changed) => {
    if (!report) { setMsg('请先运行预演。'); return; }
    setBusy(true); setMsg('');
    try {
      const body = changed
        ? { file_sha256: 'demo-file-sha256-v1', mapper_version: 'v1.0.0', mapping_override: { '联系电话': 'phone' } }
        : { file_sha256: 'demo-file-sha256-v1', mapper_version: 'v1.0.0', mapping_override: {} };
      const r = await post(`/import/batches/${report.batchId}/commit`, body);
      setCommitResult({ ok: true, text: `导入成功，实际写入 ${r.applied} 行；status=imported。` });
      await loadCounts();
    } catch (e) {
      setCommitResult({ ok: false, text: `被拒绝 [${e.code}]：${e.message}` });
    }
    finally { setBusy(false); }
  };

  const issues = report ? (report.issues || []) : [];

  return (
    <div className="container">
      <header>
        <h1>Import Dry-Run Framework</h1>
        <p className="sub">单事务 · 强制回滚 · 字段级 diff · 文件内重复检测 · 指纹门禁 · 正式导入</p>
        <p className="tiny">演示边界：内存数据层模拟 PostgreSQL 16（非真实数据库），Transaction 为真实 DB 事务替换点；全部为虚构数据。</p>
      </header>

      <Panel title="1. 运行预演" testid="panel-run" note="流水线严格按 map_row → clean → validate → natural_key → upsert 执行，全部包在单个事务内，结束强制 ROLLBACK。">
        <div className="controls">
          <button className="primary" data-testid="run-dryrun" onClick={runFull} disabled={busy}>运行预演（含错误样例）</button>
          <button data-testid="run-ready" onClick={runReady} disabled={busy}>运行可导入预演</button>
        </div>
        {msg && <div className="msg" data-testid="msg">{msg}</div>}
      </Panel>

      {report && (
        <Panel title="2. 预演汇总" testid="panel-summary">
          <div className="grid">
            <div><span className="label">批次状态</span><b data-testid="dryrun-status" className={report.status === 'dry_run_ready' ? 'ok' : 'bad'}>{report.status}</b></div>
            <div><span className="label">指纹</span><code data-testid="fingerprint-value" className="mono small">{report.dry_run_fingerprint}</code></div>
            <div><span className="label">聚合计数</span><b data-testid="dryrun-counts">{fmtCounts(report.counts)}</b></div>
            <div><span className="label">回滚的写入数</span><b data-testid="reverted-writes">{report.transaction.revertedBusinessWrites}</b></div>
          </div>
          <div className={`proof ${report.zeroWrites ? 'ok' : 'bad'}`} data-testid="zero-write-proof">
            {report.zeroWrites ? '✓ 业务表零写入' : '✗ 业务表被改动'}：
            前 <code className="mono">{JSON.stringify(report.businessCountsBefore)}</code>
            → 后 <code className="mono">{JSON.stringify(report.businessCountsAfter)}</code>
          </div>
        </Panel>
      )}

      {report && (
        <Panel title="3. import_row（预演结果，唯一落库的业务输出）" testid="panel-rows">
          <table data-testid="row-table">
            <thead><tr><th>行</th><th>action</th><th>target_id</th><th>cleaned_payload</th><th>字段级 diff（仅变化字段）</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.line} data-testid={`row-${r.line}`}>
                  <td>{r.line}</td>
                  <td><span className={`tag ${r.action}`}>{r.action}</span></td>
                  <td className="mono">{r.target_id || '—'}</td>
                  <td className="mono small">{JSON.stringify(r.cleaned_payload)}</td>
                  <td data-testid={`diff-${r.line}`}>{fmtDiff(r.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {report && (
        <Panel title="4. import_issue（错误 / 警告）" testid="panel-issues">
          {issues.length === 0
            ? <div className="tiny">无问题。</div>
            : (
              <ul data-testid="issue-list">
                {issues.map((it, i) => (
                  <li key={i} data-testid={`issue-${it.code}`} className={it.severity}>
                    <b>[{it.severity}] {it.code}</b> · line {it.line} · {it.field}：{it.message}
                  </li>
                ))}
              </ul>
            )}
        </Panel>
      )}

      <Panel title="5. 指纹门禁 · 正式导入" testid="panel-commit" note="文件 / mapper 版本 / override 任一变化都会改变指纹，正式导入被拒并要求重跑预演。">
        <div className="controls">
          <button className="primary" data-testid="commit-ok" onClick={() => commit(false)} disabled={busy}>用一致参数导入</button>
          <button data-testid="commit-bad" onClick={() => commit(true)} disabled={busy}>改动 mapping_override 后导入</button>
        </div>
        {commitResult && (
          <div className={commitResult.ok ? 'result ok' : 'result bad'} data-testid="commit-result">{commitResult.text}</div>
        )}
        {counts && <div className="tiny" data-testid="table-counts">当前业务表行数：<code className="mono">{JSON.stringify(counts.business)}</code></div>}
      </Panel>

      <Panel title="6. 性能参考" testid="panel-perf">
        <p data-testid="perf-note">50,000 行虚构文件 dry-run 实测耗时见 README.md / 验证记录.md；验收上限 3 分钟（180,000 ms），本地实测在限额内。</p>
      </Panel>
    </div>
  );
}
