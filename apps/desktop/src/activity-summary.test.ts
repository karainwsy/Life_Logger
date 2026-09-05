import { describe, expect, it } from 'vitest';
import type { ActivitySession } from '@life-logger/domain';
import { generateActivitySummary } from '@life-logger/ai';

const sessions: ActivitySession[] = [
  {
    id: 1,
    processName: 'Code.exe',
    windowTitle: 'Life Logger - Visual Studio Code',
    startedAt: '2026-05-02T08:00:00.000Z',
    endedAt: '2026-05-02T08:30:00.000Z',
    durationSeconds: 1800
  },
  {
    id: 2,
    processName: 'chrome.exe',
    windowTitle: 'GitHub - Life Logger',
    startedAt: '2026-05-02T08:30:00.000Z',
    endedAt: '2026-05-02T08:45:00.000Z',
    durationSeconds: 900
  },
  {
    id: 3,
    processName: 'Code.exe',
    windowTitle: 'main.ts - Life Logger - Visual Studio Code',
    startedAt: '2026-05-02T08:45:00.000Z',
    endedAt: '2026-05-02T09:00:00.000Z',
    durationSeconds: 900
  }
];

describe('activity summary', () => {
  it('summarizes sessions by process and duration', () => {
    const summary = generateActivitySummary({
      sessions,
      start: '2026-05-02T08:00:00.000Z',
      end: '2026-05-02T09:00:00.000Z'
    });

    expect(summary.sessionCount).toBe(3);
    expect(summary.totalActiveSeconds).toBe(3600);
    expect(summary.topProcesses[0].processName).toBe('Code.exe');
    expect(summary.topProcesses[0].durationSeconds).toBe(2700);
    expect(summary.summaryText).toContain('1 小时');
  });

  it('handles empty activity', () => {
    const summary = generateActivitySummary({
      sessions: [],
      start: '2026-05-02T08:00:00.000Z',
      end: '2026-05-02T09:00:00.000Z'
    });

    expect(summary.sessionCount).toBe(0);
    expect(summary.totalActiveSeconds).toBe(0);
    expect(summary.summaryText).toContain('没有记录到前台活动');
  });
});
