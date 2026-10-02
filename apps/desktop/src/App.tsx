import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogSourceType, SearchLogsResult } from '@life-logger/domain';
import { api, errorText, sourceLabels, type Notify } from './api';
import { Icon, type IconName } from './components/Icon';
import { Composer } from './components/Composer';
import { Calendar } from './components/Calendar';
import { LogTimeline } from './components/LogTimeline';
import { ActivityPanel, BrowserPanel, SettingsPanel } from './components/Panels';
import { CluesPanel } from './components/CluesPanel';
type Page = 'journal' | 'clues' | 'browser' | 'activity' | 'settings';
const navigation: { id: Page; label: string; icon: IconName }[] = [
  { id: 'journal', label: '我的日志', icon: 'journal' }, { id: 'clues', label: '活动线索', icon: 'search' }, { id: 'browser', label: '浏览回顾', icon: 'globe' },
  { id: 'activity', label: '自动记录', icon: 'activity' }, { id: 'settings', label: '设置与备份', icon: 'settings' }
];
const titles: Record<Page, { title: string; description: string; eyebrow: string }> = {
  journal: { title: '我的日志', description: '记下此刻，慢慢看见生活的全貌。', eyebrow: 'JOURNAL' },
  clues: { title: '活动线索', description: '不只记得用了多久，也想起当时在做什么。', eyebrow: 'DAILY CLUES' },
  browser: { title: '浏览回顾', description: '回看最近的探索，把有价值的线索留下。', eyebrow: 'BROWSING' },
  activity: { title: '自动记录', description: '让时间留下足迹，让回顾有所依据。', eyebrow: 'ACTIVITY' },
  settings: { title: '设置与备份', description: '按自己的节奏记录，妥善保存每一段日常。', eyebrow: 'PREFERENCES' }
};
export default function App() {
  const [page, setPage] = useState<Page>('journal'); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [date, setDate] = useState(''); const [source, setSource] = useState<LogSourceType | ''>(''); const [offset, setOffset] = useState(0);
  const [data, setData] = useState<SearchLogsResult>({ logs: [], total: 0 }); const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0); const request = useRef(0);
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const notify: Notify = useCallback((text, kind = 'success') => setToast({ text, kind }), []);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, [page]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    const token = ++request.current; setLoading(true);
    void api.searchLogs({ query: search, date: date || undefined, sourceType: source || undefined, offset, limit: 30 }).then(result => {
      if (token !== request.current) return;
      if (offset > 0 && !result.logs.length) { setOffset(Math.max(0, offset - 30)); return; }
      setData(result);
    }).catch(error => { if (token === request.current) notify(errorText(error), 'error'); }).finally(() => { if (token === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [search, date, source, offset, revision, notify]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => { clearTimeout(timer); timer = setTimeout(refresh, 60); };
    const unsubscribe = api.onLogsChanged(update);
    window.addEventListener('focus', update);
    return () => { unsubscribe(); clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [refresh]);
  useEffect(() => { if (!toast || toast.kind === 'error') return; const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); }, [toast]);
  const selectDate = (value: string) => { setDate(value); setOffset(0); };
  const resetFilters = () => { setDate(''); setSource(''); setQuery(''); setSearch(''); setOffset(0); };
  const onSaved = () => { resetFilters(); refresh(); };
  const pageTitle = titles[page];
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" aria-label="Life Logger · 我的日志" onClick={event => { event.preventDefault(); setPage('journal'); }}><span className="brand-symbol"><Icon name="book" size={25} /></span><span>Life Logger<small>日常记录</small></span></a>
      <div className="workspace-label">我的空间</div>
      <nav aria-label="主导航">{navigation.map(item => <div key={item.id}>{item.id === 'activity' && <div className="nav-section-label">记录工具</div>}<button className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)} aria-label={item.label} title={item.label} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} size={20} /><span>{item.label}</span>{page === item.id && <span className="nav-dot" />}</button></div>)}</nav>
      <div className="sidebar-spacer" /><div className="sidebar-note"><span className="sidebar-note-line" /><p>日子一页页过去，<br />记录让它们有迹可循。</p></div>
      <div className="sidebar-bottom"><span className="avatar">L</span><div><strong>本地空间</strong><small><span className="status-dot" />离线可用</small></div><Icon name="shield" size={17} /></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">个人空间<span>/</span><strong>{navigation.find(item => item.id === page)?.label}</strong></div><div className="topbar-right"><span className="local-status"><Icon name="shield" size={15} />数据仅存于本机</span><span className="today-label">{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })}</span></div></header>
      <main className="main-content"><div className="page-heading"><div><span className="eyebrow">{pageTitle.eyebrow}</span><h1>{pageTitle.title}<span className="heading-dot">.</span></h1><p>{pageTitle.description}</p></div>{page === 'journal' && <div className="search-box"><Icon name="search" size={18} /><input aria-label="搜索全部日志" placeholder="搜索全部日志…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={15} /></button>}</div>}</div>
      {page === 'journal' ? <div className="journal-layout"><div className="journal-main"><Composer notify={notify} onSaved={onSaved} />
        <div className="journal-filter"><div className="filter-tabs" aria-label="日志来源"><button className={!source ? 'selected' : ''} aria-pressed={!source} onClick={() => { setSource(''); setOffset(0); }}>全部记录</button>{(Object.keys(sourceLabels) as LogSourceType[]).map(value => <button key={value} className={source === value ? 'selected' : ''} aria-pressed={source === value} onClick={() => { setSource(value); setOffset(0); }}>{sourceLabels[value]}</button>)}</div><span className="result-count">{data.total} 条</span></div>
        {(date || search) && <div className="active-filters">{date && <button onClick={() => selectDate('')}><Icon name="calendar" size={14} />{date}<Icon name="close" size={13} /></button>}{search && <span>搜索「{search}」</span>}<button className="text-button" onClick={resetFilters}>清除筛选</button></div>}
        <LogTimeline logs={data.logs} loading={loading} notify={notify} refresh={refresh} filtered={Boolean(date || search || source)} />
        {data.total > 30 && <div className="pagination"><span>第 {offset + 1}–{Math.min(offset + 30, data.total)} 条，共 {data.total} 条</span><div className="inline-actions"><button className="secondary-button" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 30))}><Icon name="left" size={16} />上一页</button><button className="secondary-button" disabled={loading || offset + 30 >= data.total} onClick={() => setOffset(value => value + 30)}>下一页<Icon name="right" size={16} /></button></div></div>}
      </div><aside className="journal-aside"><Calendar selected={date} onSelect={selectDate} /><section className="reflection-card"><span className="reflection-icon"><Icon name="sun" size={25} /></span><h3>留一点时间，回看今天</h3><p>那些打开的页面、专注的片段，也可以成为日常的一部分。</p><button onClick={() => setPage('clues')}>查看活动线索<Icon name="arrow" size={16} /></button></section><div className="keyboard-note"><Icon name="edit" size={16} /><span>快速记录</span><kbd>Ctrl</kbd><kbd>N</kbd></div><div className="aside-footer"><Icon name="shield" size={15} /><span>记录属于你，也只属于你。</span></div></aside></div>
      : page === 'clues' ? <CluesPanel notify={notify} openSettings={() => setPage('settings')} /> : page === 'browser' ? <BrowserPanel notify={notify} /> : page === 'activity' ? <ActivityPanel notify={notify} openSettings={() => setPage('settings')} /> : <SettingsPanel notify={notify} />}
      <footer className="page-footer"><span>Life Logger</span><span>本地记录 · 从容回顾</span></footer></main>
    </div>
    {toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}><Icon name={toast.kind === 'error' ? 'info' : 'check'} size={19} /><span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><Icon name="close" size={16} /></button></div>}
  </div>;
}
