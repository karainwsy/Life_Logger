import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyReview } from '@life-logger/domain';
import { composeDailyReview, recommendDailyReviewGroup } from '@life-logger/shared';
import { api, durationLabel, errorText, type Notify } from '../api';
import { Icon } from './Icon';

type Draft = { content: string; selectedKeys?: string[] };
const draftKey = (date: string) => `life-logger:daily-review:${date}`;
const readDraft = (date: string): { draft: Draft; error: boolean; exists: boolean } => {
  try {
    const value = localStorage.getItem(draftKey(date));
    if (value === null) return { draft: { content: '', selectedKeys: [] }, error: false, exists: false };
    const parsed = JSON.parse(value) as Draft;
    if (typeof parsed.content !== 'string' || (parsed.selectedKeys !== undefined && (!Array.isArray(parsed.selectedKeys) || parsed.selectedKeys.some(key => typeof key !== 'string')))) throw new Error('Invalid draft');
    return { draft: parsed, error: false, exists: true };
  } catch { return { draft: { content: '' }, error: true, exists: true }; }
};

export function DailyReviewPanel({ date, revision, notify }: { date: string; revision: number; notify: Notify }) {
  const [initial] = useState(() => readDraft(date));
  const [draft, setDraft] = useState(initial.draft);
  const [draftError, setDraftError] = useState(initial.error);
  const [data, setData] = useState<DailyReview | null>(null);
  const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState(''); const [limit, setLimit] = useState(20);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [busy, setBusy] = useState(''); const busyRef = useRef(false);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const autoPrepared = useRef(initial.exists || initial.error);
  useEffect(() => {
    let active = true; setLoading(true); setFailed(false);
    void api.getDailyReview({ date }).then(result => {
      if (!active) return; setData(result);
      if (autoPrepared.current || !result.groups.length) return; autoPrepared.current = true;
      const selectedKeys = result.groups.filter(group => recommendDailyReviewGroup(group) !== null).map(group => group.key);
      if (selectedKeys.length) {
        try { persist({ content: composeDailyReview(result, selectedKeys), selectedKeys }); }
        catch (error) { notify(errorText(error), 'error'); }
      }
    })
      .catch(error => { if (active) { setFailed(true); notify(errorText(error), 'error'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, revision, refresh, notify]);
  const persist = (next: Draft) => {
    autoPrepared.current = true;
    setDraft(next);
    try { localStorage.setItem(draftKey(date), JSON.stringify(next)); setDraftError(false); }
    catch { setDraftError(true); }
  };
  const recommendedKeys = useMemo(() => data?.groups.filter(group => recommendDailyReviewGroup(group) !== null).map(group => group.key) ?? [], [data]);
  const selected = useMemo(() => new Set(draft.selectedKeys ?? data?.groups.map(group => group.key) ?? []), [draft.selectedKeys, data]);
  const selectedCount = data?.groups.filter(group => selected.has(group.key)).length ?? 0;
  const matching = useMemo(() => data?.groups.filter(group => `${group.title} ${group.label} ${group.source} ${group.url} ${group.notes.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [], [data, query]);
  const toggle = (key: string) => { const next = new Set(selected); if (next.has(key)) next.delete(key); else next.add(key); persist({ ...draft, selectedKeys: [...next] }); };
  const useContent = (content: string) => { persist({ ...draft, content }); setReplacement(null); requestAnimationFrame(() => editor.current?.focus()); };
  const generate = () => {
    if (!data) return;
    try {
      const content = composeDailyReview(data, [...selected]);
      if (draft.content.trim() && content !== draft.content) setReplacement(content);
      else useContent(content);
    } catch (error) { notify(errorText(error), 'error'); }
  };
  const save = async (exporting: boolean) => {
    if (busyRef.current || !draft.content.trim()) return;
    busyRef.current = true; setBusy(exporting ? 'export' : 'save');
    const content = draft.content;
    try {
      if (exporting) {
        const result = await api.exportDailyReview({ date, content }); if (result) notify(`回顾已导出至 ${result.filePath}`);
      } else {
        await api.saveDailyReview({ date, content }); setSavedContent(content); notify('一天回顾已保存到我的日志');
      }
    } catch (error) { notify(errorText(error), 'error'); }
    finally { busyRef.current = false; setBusy(''); }
  };
  return <div className="daily-review">
    <div className="review-overview"><div className="review-heading"><div><h2>把零散片段，整理成一天。</h2><p>首次查看时自动准备推荐草稿，你写过的内容会保留。</p></div></div>
    {data && <div className="review-stats"><div><strong>{data.clueCount}</strong><span>条未忽略线索</span></div><div><strong>{data.groups.length}</strong><span>组活动片段</span></div><div><strong>{durationLabel(data.activeSeconds)}</strong><span>窗口采样估计</span></div></div>}
    </div><div className="review-workspace">
    <section className="review-source-panel" aria-label="选择活动片段">
      <div className="review-step-heading"><span className="review-step">01</span><div><h3>选择活动片段</h3><p>挑选值得记住的活动，准备回顾草稿。</p></div></div>
    {failed ? <div className="compact-empty"><p>未能读取这一天的线索。</p><button className="secondary-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>
      : loading && !data ? <p className="muted" role="status">正在整理这一天…</p>
      : data && !data.groups.length ? <div className="review-empty"><Icon name="sun" size={28} /><p>这一天还没有可整理的线索。你仍可以直接写下回顾。</p></div>
      : data && <>
        <div className="review-selection"><span>已选 {selectedCount} / {data.groups.length} 组</span><div className="inline-actions"><button className="text-button" disabled={Boolean(busy)} onClick={() => persist({ ...draft, selectedKeys: recommendedKeys })}>推荐选择</button><button className="text-button" disabled={Boolean(busy)} onClick={() => persist({ ...draft, selectedKeys: data.groups.map(group => group.key) })}>全选当天</button><button className="text-button" disabled={Boolean(busy)} onClick={() => persist({ ...draft, selectedKeys: [] })}>清空选择</button></div></div>
        <p className="muted review-hint">推荐有备注或名称、重复出现、累计窗口活动至少 5 分钟的片段，其余仍可自行选择。{!recommendedKeys.length && ' 暂无推荐片段，可以手动选择或全选当天。'}</p>
        <div className="clue-search"><Icon name="search" size={16} /><input aria-label="筛选回顾片段" value={query} maxLength={200} placeholder="查找活动片段…" onChange={event => { setQuery(event.target.value); setLimit(20); }} /><span>{matching.length} 组</span></div>
        <div className="review-groups" aria-busy={loading}>{matching.slice(0, limit).map(group => { const reason = recommendDailyReviewGroup(group); return <label className={`review-group${selected.has(group.key) ? ' is-selected' : ''}`} key={group.key}><input type="checkbox" aria-label={`选择片段：${group.label || group.title}`} checked={selected.has(group.key)} disabled={Boolean(busy)} onChange={() => toggle(group.key)} /><span className={`clue-node ${group.kind}`}><Icon name={group.kind === 'browser' ? 'globe' : 'monitor'} size={17} /></span><span className="review-group-body"><strong>{group.label || group.title}</strong><small>{group.source} · {group.kind === 'browser' ? `${group.count} 次访问 · 时长未知` : `${group.count} 段活动 · 约 ${durationLabel(group.activeSeconds)}`}</small>{reason && <small className="review-recommendation">推荐 · {reason}</small>}{group.notes.length > 0 && <span className="review-note-preview">我的备注：{group.notes.join('；')}</span>}</span></label>; })}</div>
        {!matching.length && <p className="muted">没有匹配的片段，已选内容仍然保留。</p>}
        {matching.length > limit && <button className="secondary-button review-more" onClick={() => setLimit(value => value + 20)}>显示更多片段（还剩 {matching.length - limit} 组）</button>}
        <div className="review-generate"><span>整理范围覆盖当天全部线索，包含时间线其他分页。</span><button className="primary-button" disabled={!selectedCount || loading || Boolean(busy)} onClick={generate}><Icon name="edit" size={16} />{draft.content.trim() ? '重新整理草稿' : '生成回顾草稿'}</button></div>
      </>}
    </section>
    <div className="review-writing-panel">
    {replacement !== null && <section className="review-replacement" aria-label="替换草稿预览"><h3>新草稿已准备好</h3><p>替换会覆盖下方的编辑内容；已保存的日志不受影响。</p><pre>{replacement}</pre><div className="inline-actions"><button className="primary-button" onClick={() => useContent(replacement)}>使用新草稿</button><button className="secondary-button" onClick={() => setReplacement(null)}>保留当前草稿</button></div></section>}
    <section className="review-editor"><div className="review-step-heading"><span className="review-step">02</span><div><h3>我的一天回顾</h3><p>补充自己的想法，让记录更完整。</p></div></div><div className={`review-draft-status${draftError ? ' has-error' : ''}`} role="status"><Icon name={draftError ? 'journal' : 'check'} size={14} /><span>{draftError ? '草稿未能保留，请导出或保存日志' : '草稿在本机自动保留'}</span></div>
      {draftError && <p className="notice warning">本机草稿读取或保存失败，请先保存日志或导出文件，避免丢失内容。</p>}
      <textarea ref={editor} aria-label="一天回顾草稿" placeholder={`# ${date} · 一天回顾\n\n今天做了什么？有哪些进展、想法，或值得记住的小事？`} value={draft.content} maxLength={100000} rows={14} onChange={event => persist({ ...draft, content: event.target.value })} />
      <div className="review-editor-footer"><small>{draft.content.length.toLocaleString()} / 100,000 字 · 支持 Markdown</small><span>{savedContent === draft.content ? '此版本已保存为日志' : '编辑后可保存一个新的日志副本'}</span></div>
      <div className="review-save-actions"><button className="secondary-button" disabled={Boolean(busy) || !draft.content.trim()} onClick={() => void save(true)}><Icon name="download" size={17} />{busy === 'export' ? '导出中…' : '导出 Markdown'}</button><button className="primary-button" disabled={Boolean(busy) || !draft.content.trim()} onClick={() => void save(false)}><Icon name="check" size={17} />{busy === 'save' ? '保存中…' : '保存回顾为日志'}</button></div>
      <p className="footnote">草稿与勾选仅保存在本机，保存为日志后纳入日志备份。日志按保存时间归档，正文保留回顾日期。同一内容重复保存不会新增日志，修改内容后会创建新副本。</p>
    </section>
    </div>
    </div>
  </div>;
}
