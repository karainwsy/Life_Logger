import type { ActivityClue, DailyReview, DailyReviewGroup } from '@life-logger/domain';
import { dateKeyRange } from './index';

type Interval = [number, number];
const unionSeconds = (intervals: Interval[]) => {
  let end = -Infinity; let milliseconds = 0;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    milliseconds += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop);
  }
  return Math.round(milliseconds / 1000);
};

/** Group only identical observed titles and sources. Never infer shared projects across apps. */
export function buildDailyReview(date: string, clues: ActivityClue[]): DailyReview {
  const range = dateKeyRange(date); const start = Date.parse(range.start); const end = Date.parse(range.end);
  const grouped = new Map<string, { group: DailyReviewGroup; intervals: Interval[]; notes: Set<string> }>();
  const intervals: Interval[] = [];
  let windowCount = 0; let visitCount = 0;
  for (const clue of clues) {
    const from = Date.parse(clue.startedAt); const to = Date.parse(clue.endedAt);
    if (clue.dismissed || !Number.isFinite(from) || !Number.isFinite(to) || from >= end || (to <= start && from < start)) continue;
    const key = JSON.stringify([clue.kind, clue.kind === 'browser' ? clue.browser : clue.processName, clue.kind === 'browser' ? clue.url : '', clue.title, clue.label]);
    const firstAt = new Date(Math.max(start, from)).toISOString();
    const lastAt = new Date(Math.max(Math.max(start, from), Math.min(end, to))).toISOString();
    let item = grouped.get(key);
    if (!item) {
      item = { group: { key, kind: clue.kind, title: clue.title || '未记录窗口标题', label: clue.label,
        source: clue.kind === 'browser' ? clue.browser : clue.processName, url: clue.url,
        firstAt, lastAt, count: 0, activeSeconds: 0, notes: [] }, intervals: [], notes: new Set() };
      grouped.set(key, item);
    }
    item.group.count++;
    if (firstAt < item.group.firstAt) item.group.firstAt = firstAt;
    if (lastAt > item.group.lastAt) item.group.lastAt = lastAt;
    if (clue.note.trim()) item.notes.add(clue.note.trim());
    if (clue.kind === 'browser') visitCount++;
    else {
      windowCount++;
      const stop = Math.min(end, to, from + Math.max(0, clue.durationSeconds) * 1000);
      if (stop > Math.max(start, from)) {
        const interval: Interval = [Math.max(start, from), stop]; item.intervals.push(interval); intervals.push(interval);
      }
    }
  }
  return { date, clueCount: windowCount + visitCount, windowCount, visitCount, activeSeconds: unionSeconds(intervals),
    groups: [...grouped.values()].map(item => ({ ...item.group, notes: [...item.notes], activeSeconds: unionSeconds(item.intervals) }))
      .sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.key.localeCompare(b.key)) };
}

export function recommendDailyReviewGroup(group: DailyReviewGroup): string | null {
  if (group.notes.some(note => note.trim())) return '有我的备注';
  if (group.label.trim()) return '有我的名称';
  if (group.count >= 2) return '重复出现';
  if (group.kind === 'window' && group.activeSeconds >= 300) return '累计活动至少 5 分钟';
  return null;
}

export function composeDailyReview(review: DailyReview, selectedKeys: string[]): string {
  const selected = new Set(selectedKeys);
  const groups = review.groups.filter(group => selected.has(group.key));
  if (!groups.length) throw new Error('请至少选择一组线索');
  const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const endOfDay = dateKeyRange(review.date).end;
  const duration = (seconds: number) => seconds < 60 ? `${seconds} 秒` : seconds < 3600
    ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
  const lines = [`# ${review.date} · 一天回顾`, '', `根据 ${groups.reduce((count, group) => count + group.count, 0)} 条线索，整理为 ${groups.length} 组记录。`, '',
    '> 以下是窗口采样和网页访问的整理，不能证明任务已完成。首末时间之间可能存在间隔；网页访问不代表阅读时长。', ''];
  for (const group of groups) {
    const when = group.firstAt === group.lastAt ? time(group.firstAt) : `${time(group.firstAt)}–${group.lastAt === endOfDay ? '24:00' : time(group.lastAt)}`;
    lines.push(`## ${when} · ${group.kind === 'window' ? '窗口活动' : '网页访问'}`, '',
      `记录标题：${group.title}`, `来源：${group.source}`, group.kind === 'window'
        ? `记录到 ${group.count} 段活动，累计采样估计约 ${duration(group.activeSeconds)}。`
        : `记录到 ${group.count} 次访问。`);
    if (group.url) lines.push(`网址：${group.url}`);
    if (group.label) lines.push(`我的名称：${group.label}`);
    for (const note of group.notes) lines.push(`我的备注：${note}`);
    lines.push('');
  }
  lines.push('## 我的补充', '', '');
  const content = lines.join('\n');
  if (content.length > 100_000) throw new Error('所选线索过多，请减少选择后再生成草稿');
  return content;
}
