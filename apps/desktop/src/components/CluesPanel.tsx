import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityClue, ActivitySettings, ImportBrowserCluesResult, SearchCluesResult } from '@life-logger/domain';
import { dateKeyRange, localDateKey } from '@life-logger/shared';
import { api, durationLabel, errorText, type Notify } from '../api';
import { Icon } from './Icon';

const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const fullTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
export function CluesPanel({ notify, openSettings }: { notify: Notify; openSettings: () => void }) {
  const [date, setDate] = useState(localDateKey(new Date()));
  const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ActivityClue['kind'] | ''>('');
  const [dismissed, setDismissed] = useState(false); const [offset, setOffset] = useState(0);
  const [data, setData] = useState<SearchCluesResult>({ clues: [], total: 0 });
  const [settings, setSettings] = useState<ActivitySettings | null>(null);
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<(ImportBrowserCluesResult & { date: string }) | null>(null);
  const [revision, setRevision] = useState(0); const request = useRef(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setData({ clues: [], total: 0 }); }, [date, search, kind, dismissed, offset]);
  useEffect(() => {
    let active = true;
    void api.getActivitySettings().then(result => { if (active) setSettings(result); }).catch(error => notify(errorText(error), 'error'));
    return () => { active = false; };
  }, [notify]);
  useEffect(() => {
    const token = ++request.current; setLoading(true); setFailed(false);
    void api.searchClues({ date, query: search, kind: kind || undefined, dismissed, offset }).then(result => {
      if (request.current !== token) return;
      if (!result.clues.length && offset > 0) { setOffset(Math.max(0, offset - 30)); return; }
      setData(result);
    }).catch(error => { if (request.current === token) { setFailed(true); notify(errorText(error), 'error'); } })
      .finally(() => { if (request.current === token) setLoading(false); });
    return () => { request.current++; };
  }, [date, search, kind, dismissed, offset, revision, notify]);
  useEffect(() => {
    // Refresh only while this page is visible; editing state lives on each stable card.
    const update = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, [refresh]);
  const chooseDate = (value: string) => { if (!value) return; setDate(value); setOffset(0); setReport(null); };
  const stepDate = (step: number) => { const value = new Date(dateKeyRange(date).start); value.setDate(value.getDate() + step); chooseDate(localDateKey(value)); };
  const supplement = async () => {
    if (importing) return; setImporting(true); setReport(null);
    try {
      const result = await api.importBrowserClues({ date }); setReport({ ...result, date }); refresh();
      notify(result.added ? `已补充 ${result.added} 条网页线索` : '读取完成，没有新增网页线索');
    } catch (error) { notify(errorText(error), 'error'); } finally { setImporting(false); }
  };
  return <div className="clues-layout">
    <div className="panel-stack">
      <section className="surface clue-workspace">
        <div className="clue-toolbar">
          <div className="clue-date"><button className="icon-button" aria-label="线索前一天" disabled={importing} onClick={() => stepDate(-1)}><Icon name="left" size={18} /></button><input aria-label="线索日期" type="date" value={date} max={localDateKey(new Date())} disabled={importing} onChange={event => chooseDate(event.target.value)} /><button className="icon-button" aria-label="线索后一天" disabled={importing || date >= localDateKey(new Date())} onClick={() => stepDate(1)}><Icon name="right" size={18} /></button></div>
          <div className="inline-actions"><button className="icon-button" aria-label="刷新活动线索" disabled={loading} onClick={refresh}><Icon name="refresh" size={18} /></button><button className="primary-button" disabled={importing || date > localDateKey(new Date())} onClick={() => void supplement()}><Icon name="globe" size={17} />{importing ? '正在补充…' : '补充网页线索'}</button></div>
        </div>
        <div className="clue-filters"><div className="filter-tabs" aria-label="线索来源">{([{ value: '', label: '全部线索' }, { value: 'window', label: '窗口活动' }, { value: 'browser', label: '网页访问' }] as const).map(item => <button key={item.value} aria-pressed={kind === item.value} className={kind === item.value ? 'selected' : ''} onClick={() => { setKind(item.value); setOffset(0); }}>{item.label}</button>)}</div><label className="clue-dismissed"><input type="checkbox" checked={dismissed} onChange={event => { setDismissed(event.target.checked); setOffset(0); }} />查看已忽略</label></div>
        <div className="clue-search"><Icon name="search" size={17} /><input aria-label="搜索活动线索" placeholder="搜索标题、应用、网址或我的备注…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /><span>{data.total} 条</span></div>
        {report?.date === date && <div className={`clue-report ${report.warnings.length ? 'has-warning' : ''}`} role="status"><p>已读取 {report.scanned} 条可用网页访问，新增 {report.added} 条；重复记录已跳过。</p>{report.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <div className="clue-list" aria-busy={loading}>
          {failed ? <div className="compact-empty"><Icon name="info" size={30} /><p>线索读取失败，请刷新重试。</p></div> : loading && !data.clues.length ? <div className="compact-empty" role="status"><p>正在整理活动线索…</p></div> : !data.clues.length ? <div className="clue-empty"><span><Icon name="search" size={32} /></span><h3>{search || kind || dismissed ? '没有符合筛选条件的线索' : '这一天，还没有留下线索'}</h3><p>{search || kind || dismissed ? '试试其他关键词、来源或日期。' : '开启后台活动采集后，窗口标题会自动出现在这里。也可以补充这一天的网页访问。'}</p>{!search && !kind && !dismissed && <button className="secondary-button" onClick={openSettings}>查看采集设置<Icon name="arrow" size={16} /></button>}</div> : data.clues.map(clue => <ClueCard key={`${date}:${clue.id}`} clue={clue} date={date} notify={notify} refresh={refresh} />)}
        </div>
        {data.total > 30 && <div className="pagination"><span>{offset + 1}–{Math.min(offset + 30, data.total)} / {data.total}</span><div className="inline-actions"><button className="secondary-button" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 30))}>上一页</button><button className="secondary-button" disabled={loading || offset + 30 >= data.total} onClick={() => setOffset(value => value + 30)}>下一页</button></div></div>}
      </section>
    </div>
    <aside className="panel-stack clue-aside">
      <section className="surface clue-guide"><span className="eyebrow">CAPTURE STATUS</span><h3>线索从哪里来</h3><div className="clue-status"><span className={`status-dot ${settings?.enabled ? '' : 'inactive'}`} /><strong>{settings ? settings.enabled ? '窗口活动自动记录中' : '窗口活动采集未开启' : '正在读取采集状态…'}</strong></div><p>前台应用和窗口标题随活动采集更新。{settings && !settings.captureWindowTitles ? '目前已关闭标题采集，只能显示应用名。' : '文档名、页面名和对话标题能帮助你回忆上下文。'}</p><button className="text-button" onClick={openSettings}>调整采集设置<Icon name="arrow" size={15} /></button><div className="clue-guide-divider" /><strong>网页访问 · 手动补充</strong><p>点击按钮读取所选日期的本地浏览器历史，保留页面标题、网址和每次访问时间。支持 Edge、Chrome、Brave、Chromium，并遵循应用排除设置。</p></section>
      <section className="clue-note"><Icon name="edit" size={23} /><h3>补一句，回忆就完整一点。</h3><p>例如：<br />“查了三个方案，决定先尝试本地存储。”</p><small>线索是记录依据，备注由你补充。访问次数与窗口时长都不等于完成了某项任务。</small></section>
      <div className="clue-footnote"><Icon name="shield" size={17} /><p>不采集截图或正文。网址去除参数、片段和账号信息；页面标题与路径仍会保留。线索与备注保存在本机，保存为日志后才会纳入日志备份。</p></div>
    </aside>
  </div>;
}

function ClueCard({ clue, date, notify, refresh }: { clue: ActivityClue; date: string; notify: Notify; refresh: () => void }) {
  const [editing, setEditing] = useState(false); const [label, setLabel] = useState(clue.label); const [note, setNote] = useState(clue.note);
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return; setBusy(true);
    try { await action(); setEditing(false); refresh(); notify(message); } catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); }
  };
  const range = dateKeyRange(date);
  const start = new Date(Math.max(Date.parse(range.start), Date.parse(clue.startedAt))).toISOString();
  const end = new Date(Math.min(Date.parse(range.end), Date.parse(clue.endedAt))).toISOString();
  const seconds = Math.min(clue.durationSeconds, Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)));
  return <article className={`clue-card ${clue.dismissed ? 'is-dismissed' : ''}`}>
    <div className="clue-time"><time dateTime={start}>{time(start)}</time><span className={`clue-node ${clue.kind}`}><Icon name={clue.kind === 'browser' ? 'globe' : 'monitor'} size={16} /></span></div>
    <div className="clue-content"><div className="clue-meta"><span className={`clue-source ${clue.kind}`}>{clue.kind === 'browser' ? '网页访问' : '窗口活动'}</span><span>{clue.kind === 'browser' ? clue.browser : clue.processName}</span><span>{clue.kind === 'browser' ? '一次访问 · 时长未知' : seconds ? `${time(start)}–${Date.parse(end) === Date.parse(range.end) ? '24:00' : time(end)} · 约 ${durationLabel(seconds)}` : '采样记录 · 暂无时长'}</span></div>
      <h3>{clue.label || clue.title || `${clue.processName} · 未记录窗口标题`}</h3>
      {clue.url && <p className="clue-url" title={clue.url}>{clue.url}</p>}
      {clue.note && !editing && <p className="clue-user-note"><span>我的备注</span>{clue.note}</p>}
      <details className="clue-evidence"><summary>查看记录依据</summary><dl><dt>{clue.kind === 'browser' ? '页面标题' : '窗口标题'}</dt><dd>{clue.title || '未记录窗口标题'}</dd><dt>记录时间</dt><dd>{fullTime(clue.startedAt)}{clue.kind === 'window' && ` — ${fullTime(clue.endedAt)}`}</dd><dt>来源</dt><dd>{clue.kind === 'browser' ? `${clue.browser} / ${clue.profile} · 本地浏览历史` : `${clue.processName} · 前台窗口采样`}</dd></dl>{clue.kind === 'browser' && <p>标题为补充时浏览器保存的标题，可能与访问当时不同；访问不代表持续阅读。</p>}</details>
      {editing ? <form className="clue-editor" onSubmit={event => { event.preventDefault(); void perform(() => api.updateClue({ id: clue.id, label, note }), '备注已保存'); }}><label>为这段活动起个名字<input aria-label="线索名称" maxLength={200} value={label} placeholder="例如：研究本地存储方案" disabled={busy} onChange={event => setLabel(event.target.value)} /></label><label>我的备注<textarea aria-label="线索备注" maxLength={5000} rows={3} value={note} placeholder="当时在做什么？有什么进展或想法？" disabled={busy} onChange={event => setNote(event.target.value)} /></label>{clue.savedLogId && <small>已保存的日志是当时的副本，新的备注不会同步修改日志。</small>}<div className="inline-actions"><button className="primary-button" type="submit" disabled={busy}>保存备注</button><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button></div></form>
      : <div className="clue-actions"><button className="text-button" disabled={busy} onClick={() => { setLabel(clue.label); setNote(clue.note); setEditing(true); }}><Icon name="edit" size={14} />{clue.note || clue.label ? '编辑备注' : '补充备注'}</button><button className="text-button" disabled={busy || Boolean(clue.savedLogId)} onClick={() => void perform(() => api.saveClueAsLog({ id: clue.id }), '线索已保存到我的日志')}><Icon name={clue.savedLogId ? 'check' : 'plus'} size={14} />{clue.savedLogId ? '已保存为日志' : '保存为日志'}</button><button className="text-button clue-dismiss" disabled={busy} onClick={() => void perform(() => api.updateClue({ id: clue.id, dismissed: !clue.dismissed }), clue.dismissed ? '线索已恢复' : '已移至忽略列表')}>{clue.dismissed ? '恢复线索' : '忽略'}</button></div>}
    </div>
  </article>;
}
