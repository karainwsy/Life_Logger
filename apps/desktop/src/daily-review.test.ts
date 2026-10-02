import { describe, expect, it } from 'vitest';
import { buildDailyReview, composeDailyReview, dateKeyRange, recommendDailyReviewGroup } from '@life-logger/shared';
import type { ActivityClue } from '@life-logger/domain';

const day = '2026-09-12';
const at = (hour: number, minute = 0) => { const date = new Date(dateKeyRange(day).start); date.setHours(hour, minute, 0, 0); return date.toISOString(); };
const clue = (overrides: Partial<ActivityClue> = {}): ActivityClue => ({ id: 1, kind: 'window', title: '计划.docx — Word', processName: 'WINWORD', url: '', browser: '', profile: '', startedAt: at(9), endedAt: at(9, 10), durationSeconds: 600, label: '', note: '', dismissed: false, savedLogId: null, ...overrides });

describe('daily review facts', () => {
  it('recommends manual context first and reports one reason for repeated or sustained activity', () => {
    const group = buildDailyReview(day, [clue({ label: '整理计划', note: '调整章节顺序' })]).groups[0];
    expect(recommendDailyReviewGroup({ ...group, count: 3 })).toBe('有我的备注');
    expect(recommendDailyReviewGroup({ ...group, notes: [], count: 3 })).toBe('有我的名称');
    expect(recommendDailyReviewGroup({ ...group, notes: [], label: '', count: 2 })).toBe('重复出现');
    expect(recommendDailyReviewGroup({ ...group, notes: [], label: '', count: 1, activeSeconds: 300 })).toBe('累计活动至少 5 分钟');
    expect(recommendDailyReviewGroup({ ...group, notes: ['  '], label: '  ', count: 1, activeSeconds: 299 })).toBeNull();
  });
  it('recommends repeated browser visits without treating a visit as reading time', () => {
    const visit = buildDailyReview(day, [clue({ kind: 'browser', browser: 'Chrome', url: 'https://example.com', startedAt: at(10), endedAt: at(10), durationSeconds: 0 })]).groups[0];
    expect(recommendDailyReviewGroup(visit)).toBeNull();
    expect(recommendDailyReviewGroup({ ...visit, activeSeconds: 600 })).toBeNull();
    expect(recommendDailyReviewGroup({ ...visit, count: 2 })).toBe('重复出现');
    expect(recommendDailyReviewGroup({ ...visit, label: '需要复查的资料' })).toBe('有我的名称');
  });
  it('merges repeated titles, keeps source and manual labels distinct, and deduplicates notes', () => {
    const review = buildDailyReview(day, [clue({ note: '调整章节顺序' }), clue({ id: 2, startedAt: at(11), endedAt: at(11, 10), note: '调整章节顺序' }),
      clue({ id: 3, processName: 'OtherApp' }), clue({ id: 4, label: '我的另一件事' })]);
    expect(review.groups).toHaveLength(3);
    const repeated = review.groups.find(group => group.count === 2)!;
    expect(repeated.activeSeconds).toBe(1200); expect(repeated.notes).toEqual(['调整章节顺序']);
    expect(repeated.firstAt).toBe(at(9)); expect(repeated.lastAt).toBe(at(11, 10));
  });
  it('counts visits without attributing reading time and keeps different page titles separate', () => {
    const visit = clue({ kind: 'browser', browser: 'Chrome', url: 'https://example.com/search', title: '查询一', startedAt: at(10), endedAt: at(10), durationSeconds: 0 });
    const review = buildDailyReview(day, [visit, { ...visit, id: 2, startedAt: at(12), endedAt: at(12) }, { ...visit, id: 3, title: '查询二' }]);
    expect(review.visitCount).toBe(3); expect(review.groups).toHaveLength(2); expect(review.activeSeconds).toBe(0);
    expect(review.groups.find(group => group.title === '查询一')?.count).toBe(2);
  });
  it('clips at local midnight and excludes dismissed or out-of-day evidence', () => {
    const range = dateKeyRange(day); const before = new Date(Date.parse(range.start) - 600_000).toISOString();
    const review = buildDailyReview(day, [clue({ startedAt: before, endedAt: at(0, 10), durationSeconds: 1200 }),
      clue({ id: 2, startedAt: before, endedAt: range.start }), clue({ id: 3, dismissed: true }),
      clue({ id: 4, startedAt: range.end, endedAt: range.end })]);
    expect(review.clueCount).toBe(1); expect(review.activeSeconds).toBe(600); expect(review.groups[0].firstAt).toBe(range.start);
  });
  it('does not double-count overlapping samples, including overlaps between apps', () => {
    const review = buildDailyReview(day, [clue(), clue({ id: 2, startedAt: at(9, 5), endedAt: at(9, 15) }),
      clue({ id: 3, processName: 'Code', startedAt: at(9, 10), endedAt: at(9, 20) })]);
    expect(review.activeSeconds).toBe(1200);
    expect(review.groups.find(group => group.source === 'WINWORD')?.activeSeconds).toBe(900);
  });
  it('generates only selected evidence, separating personal notes from observed titles', () => {
    const review = buildDailyReview(day, [clue({ label: '完成计划初稿', note: '还需要复核数字' }), clue({ id: 2, title: '不选这条' })]);
    const chosen = review.groups.find(group => group.label)!;
    const content = composeDailyReview(review, [chosen.key, chosen.key, 'unknown']);
    expect(content).toContain('根据 1 条线索'); expect(content).toContain('记录标题：计划.docx — Word');
    expect(content).toContain('我的名称：完成计划初稿'); expect(content).toContain('我的备注：还需要复核数字');
    expect(content).not.toContain('不选这条'); expect(content).toContain('不能证明任务已完成');
    expect(() => composeDailyReview(review, [])).toThrow('至少选择');
  });
  it('keeps zero-duration observations but labels missing titles honestly', () => {
    const review = buildDailyReview(day, [clue({ title: '', startedAt: at(0), endedAt: at(0), durationSeconds: 0 })]);
    expect(review.windowCount).toBe(1); expect(review.groups[0].title).toBe('未记录窗口标题'); expect(review.activeSeconds).toBe(0);
  });
  it('rejects invalid dates and oversized generated drafts instead of silently dropping evidence', () => {
    expect(() => buildDailyReview('2026-02-30', [])).toThrow();
    const review = buildDailyReview(day, Array.from({ length: 30 }, (_, id) => clue({ id, title: `窗口 ${id}`, note: '字'.repeat(5000) })));
    expect(() => composeDailyReview(review, review.groups.map(group => group.key))).toThrow('所选线索过多');
  });
});
