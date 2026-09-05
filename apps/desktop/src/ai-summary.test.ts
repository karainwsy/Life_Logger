import { describe, expect, it } from 'vitest';
import type { CaptureBrowserHistoryResult } from '@life-logger/domain';
import { generateBrowserHistorySummary } from '@life-logger/ai';

const history: CaptureBrowserHistoryResult = {
  start: '2026-05-01T00:00:00.000Z',
  end: '2026-05-08T00:00:00.000Z',
  sources: [
    {
      browser: 'Chrome',
      profile: 'Default',
      itemCount: 2
    }
  ],
  items: [
    {
      url: 'https://github.com/openai/codex',
      title: 'GitHub - openai/codex',
      visitCount: 8,
      lastVisitAt: '2026-05-07T10:00:00.000Z'
    },
    {
      url: 'https://www.bilibili.com/video/example',
      title: '示例视频',
      visitCount: 12,
      lastVisitAt: '2026-05-07T11:00:00.000Z'
    }
  ]
};

describe('browser history summary', () => {
  it('creates a readable summary from local history items', async () => {
    const summary = await generateBrowserHistorySummary(history);

    expect(summary.totalVisits).toBe(20);
    expect(summary.uniqueDomains).toBe(2);
    expect(summary.topDomains[0].domain).toBe('bilibili.com');
    expect(summary.summaryText).toContain('20');
    expect(summary.summaryText).toContain('bilibili.com');
  });

  it('handles empty history', async () => {
    const summary = await generateBrowserHistorySummary({
      start: history.start,
      end: history.end,
      sources: [],
      items: []
    });

    expect(summary.totalVisits).toBe(0);
    expect(summary.uniqueDomains).toBe(0);
    expect(summary.summaryText).toContain('没有发现');
  });
});
