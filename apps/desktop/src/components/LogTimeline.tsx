import { useMemo, useState } from 'react';
import type { LogEntry } from '@life-logger/domain';
import { localDateKey } from '@life-logger/shared';
import { api, errorText, sourceLabels, type Notify } from '../api';
import { Icon } from './Icon';
export function LogTimeline({ logs, loading, notify, refresh, filtered }: { logs: LogEntry[]; loading: boolean; notify: Notify; refresh: () => void; filtered: boolean }) {
  const groups = useMemo(() => {
    const result = new Map<string, LogEntry[]>();
    for (const log of logs) { const key = localDateKey(log.createdAt); result.set(key, [...(result.get(key) ?? []), log]); }
    return [...result];
  }, [logs]);
  if (loading && !logs.length) return <div className="empty-state" role="status"><span className="spinner" />正在打开你的记录…</div>;
  if (!logs.length) return <div className="empty-state"><span className="empty-symbol"><Icon name={filtered ? 'search' : 'book'} size={32} /></span><h3>{filtered ? '没有找到匹配的记录' : '从今天的第一条记录开始'}</h3><p>{filtered ? '换一个关键词，或清除日期与来源筛选。' : '写下正在发生的事，让平常的日子有处可寻。'}</p></div>;
  const today = localDateKey(new Date()); const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  return <div className={`timeline ${loading ? 'is-refreshing' : ''}`} aria-busy={loading}>{groups.map(([key, entries]) => {
    const day = new Date(`${key}T12:00:00`);
    const label = key === today ? '今天' : key === localDateKey(yesterday) ? '昨天' : day.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', ...(day.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) });
    return <section key={key} className="day-group"><div className="day-heading"><h3>{label}</h3><span>{day.toLocaleDateString('zh-CN', { weekday: 'long' })}</span><span className="day-count">{entries.length} 条</span></div><div className="day-entries">{entries.map(entry => <Entry key={entry.id} entry={entry} notify={notify} refresh={refresh} />)}</div></section>;
  })}</div>;
}
function Entry({ entry, notify, refresh }: { entry: LogEntry; notify: Notify; refresh: () => void }) {
  const [editing, setEditing] = useState(false); const [content, setContent] = useState(entry.content);
  const [confirming, setConfirming] = useState(false); const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mutate = async (remove: boolean) => {
    if (busy) return; setBusy(true);
    try {
      const result = remove ? await api.deleteLog({ id: entry.id }) : await api.updateLog({ id: entry.id, content });
      if (!result) throw new Error('这条日志已不存在');
      setEditing(false); setConfirming(false); notify(remove ? '日志已删除' : '修改已保存'); refresh();
    } catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); }
  };
  return <article className={`log-entry ${entry.sourceType !== 'manual' ? 'generated-entry' : ''}`}>
    <div className="entry-marker" /><div className="entry-meta"><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span className={`source-tag source-${entry.sourceType}`}>{sourceLabels[entry.sourceType]}</span><div className="entry-actions"><button className="icon-button" title="编辑日志" aria-label="编辑日志" disabled={busy} onClick={() => { setContent(entry.content); setEditing(true); setConfirming(false); }}><Icon name="edit" size={16} /></button><button className="icon-button danger" title="删除日志" aria-label="删除日志" disabled={busy} onClick={() => setConfirming(!confirming)}><Icon name="trash" size={16} /></button></div></div>
    {editing ? <div className="entry-editor"><textarea aria-label="编辑日志内容" autoFocus value={content} maxLength={100000} disabled={busy} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (busy) return; if (event.key === 'Escape') setEditing(false); if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void mutate(false); } }} /><div className="inline-actions"><button className="secondary-button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button className="primary-button" disabled={busy || !content.trim()} onClick={() => void mutate(false)}>{busy ? '保存中…' : '保存修改'}</button></div></div> : <><p className={`entry-content ${!expanded && entry.content.length > 500 ? 'collapsed' : ''}`}>{entry.content}</p>{entry.content.length > 500 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全文'}</button>}</>}
    {confirming && <div className="delete-confirm" role="alert"><span>删除后无法撤销，确定删除？</span><button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>保留</button><button className="danger-button" disabled={busy} onClick={() => void mutate(true)}>删除</button></div>}
  </article>;
}
