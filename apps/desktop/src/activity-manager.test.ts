import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityClue, ActivitySession, ActivitySettings, BrowserVisitsResult, LogEntry } from '@life-logger/domain';
import type { LogRepository } from '@life-logger/storage';
import { buildDailyReview } from '@life-logger/shared';
import { createActivityManager, DEFAULT_SETTINGS, type ActivityManager } from '../electron/activity-manager';
const memory = vi.hoisted(() => ({ disk: '', files: new Map<string, string>() }));
vi.mock('node:fs/promises', () => ({ default: {
  mkdir: vi.fn(async () => {}), readFile: vi.fn(async () => memory.disk),
  writeFile: vi.fn(async (file: string, content: string) => { memory.files.set(file, content); }),
  rename: vi.fn(async (from: string) => { memory.disk = memory.files.get(from)!; })
} }));
vi.mock('@life-logger/capture', () => ({ captureForegroundWindow: vi.fn() }));
let manager: ActivityManager;
let sessions: ActivitySession[];
let clues: ActivityClue[];
let logs: LogEntry[];
let config: ActivitySettings;
let idle = 0;
const prune = vi.fn();
const readBrowserClues = vi.fn<() => Promise<BrowserVisitsResult | null>>();
const browserResult = (): BrowserVisitsResult => ({ visits: [{ key: 'visit-1', title: 'SQLite documentation', url: 'https://sqlite.org/docs.html', browser: 'Chrome', profile: 'Default', visitedAt: new Date().toISOString() }], sources: [], warnings: [], truncated: false });
const browserClue = (title = 'SQLite documentation', note = ''): ActivityClue => ({ id: 100 + clues.length, kind: 'browser', title, processName: '', url: 'https://sqlite.org/docs.html', browser: 'Chrome', profile: 'Default', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSeconds: 0, label: '', note, dismissed: false, savedLogId: null });
const capture = vi.fn(async (): Promise<{ processName: string; windowTitle: string } | null> => ({ processName: 'Editor', windowTitle: 'A document' }));
async function start(extra: Partial<ActivitySettings> = {}) {
  config = { ...DEFAULT_SETTINGS, enabled: true, ...extra };
  memory.disk = JSON.stringify({ settings: config, lastAutoSummaryAt: null, lastNightlyDate: null });
  const repository = {
    openActivitySession(input: { processName: string; windowTitle: string; startedAt: string }) {
      const session = { id: sessions.length + 1, ...input, endedAt: input.startedAt, durationSeconds: 0 }; sessions.push(session); return session;
    },
    closeActivitySession(input: { id: number; endedAt: string; durationSeconds: number }) { const session = sessions.find(item => item.id === input.id)!; Object.assign(session, input); return session; },
    getActivitySessionsByRange: () => sessions,
    createLog(input: { content: string; sourceType: LogEntry['sourceType'] }) { const log = { id: logs.length + 1, ...input, createdAt: new Date().toISOString() }; logs.push(log); return log; },
    importBrowserVisits(result: BrowserVisitsResult['visits']) {
      let added = 0;
      for (const visit of result) {
        if (clues.some(clue => clue.title === visit.title && clue.startedAt === visit.visitedAt)) continue;
        clues.push({ ...browserClue(visit.title), startedAt: visit.visitedAt, endedAt: visit.visitedAt }); added++;
      }
      return added;
    },
    getDailyReview(input: { date: string }) {
      return buildDailyReview(input.date, [...clues, ...sessions.map(session => ({ ...session, kind: 'window' as const, title: session.windowTitle, url: '', browser: '', profile: '', label: '', note: '', dismissed: false, savedLogId: null }))]);
    },
    saveDailyReview(input: { date: string; content: string }) {
      const existing = logs.find(log => log.content === input.content);
      if (existing) return existing;
      const log = { id: logs.length + 1, content: input.content, createdAt: new Date().toISOString(), sourceType: 'activity_summary' as const }; logs.push(log); return log;
    },
    pruneActivitySessions: prune
  } as unknown as LogRepository;
  manager = createActivityManager({ repository, stateFilePath: 'memory/settings.json', capture, getIdleSeconds: () => idle, readBrowserClues });
  await manager.start(); await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 5, 9, 0));
  sessions = []; clues = []; logs = []; idle = 0; memory.files.clear(); prune.mockReset();
  readBrowserClues.mockReset().mockResolvedValue({ visits: [], sources: [], warnings: [], truncated: false });
  capture.mockReset().mockResolvedValue({ processName: 'Editor', windowTitle: 'A document' });
});
afterEach(async () => { await manager?.stop(); vi.useRealTimers(); });
describe('activity lifecycle and scheduling', () => {
  it('starts periodic summaries for a first-time user', async () => {
    await start(); await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(logs).toHaveLength(1); expect(logs[0].sourceType).toBe('activity_summary'); expect(logs[0].content).toContain('30 分钟');
  });
  it('does not count disabled time on exit or after re-enabling', async () => {
    await start(); await vi.advanceTimersByTimeAsync(31 * 60_000);
    await manager.updateSettings({ ...config, enabled: false }); const before = sessions[0].durationSeconds;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await manager.updateSettings(config); await vi.advanceTimersByTimeAsync(60_000); await manager.stop();
    expect(sessions[0].durationSeconds).toBe(before); expect(sessions[1].durationSeconds).toBe(60);
  });
  it('keeps the nightly daily range independent from the periodic cursor', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 21, 20)); await start();
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(logs).toHaveLength(2); expect(logs[0].content).toContain('30 分钟'); expect(logs[1].content).toContain('40 分钟'); expect(logs[1].content).toContain('# 2026-09-05 · 一天回顾');
  });
  it('ends the session at the last successful sample on capture failure', async () => {
    await start(); await vi.advanceTimersByTimeAsync(5 * 60_000);
    capture.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(5 * 60_000); await manager.stop();
    expect(sessions[0].durationSeconds).toBe(300);
  });
  it('does not bridge suspend and resume', async () => {
    await start(); await vi.advanceTimersByTimeAsync(5 * 60_000); manager.pause();
    await vi.advanceTimersByTimeAsync(60 * 60_000); manager.resume(); await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(2); expect(sessions[0].durationSeconds).toBe(300); expect(sessions[1].durationSeconds).toBe(60);
  });
  it('discards a capture completing after collection is disabled', async () => {
    await start(); let resolve: (value: { processName: string; windowTitle: string }) => void;
    capture.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(60_000);
    const update = manager.updateSettings({ ...config, enabled: false }); resolve!({ processName: 'Private', windowTitle: 'Private document' });
    await update; await manager.stop(); expect(sessions.some(session => session.processName === 'Private')).toBe(false);
  });
  it('stops recording excluded applications and idle periods', async () => {
    await start({ excludedProcesses: ['private.exe'] }); await vi.advanceTimersByTimeAsync(60_000);
    capture.mockResolvedValue({ processName: 'Private', windowTitle: 'Secret' }); await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(1); expect(sessions[0].durationSeconds).toBe(60);
    idle = 600; capture.mockResolvedValue({ processName: 'Editor', windowTitle: 'A document' }); await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(1);
  });
  it('allows nightly summaries to be disabled', async () => {
    await start({ nightlySummaryTime: '', periodicSummaryMinutes: 0 }); await vi.advanceTimersByTimeAsync(14 * 60 * 60_000);
    expect(logs).toHaveLength(0);
  });
  it('applies a newly enabled retention period on the same day', async () => {
    await start({ periodicSummaryMinutes: 0 }); expect(prune).not.toHaveBeenCalled();
    await manager.updateSettings({ ...config, retentionDays: 7 }); await vi.advanceTimersByTimeAsync(0);
    expect(prune).toHaveBeenCalledOnce();
  });
});
describe('automatic browser clues and daily reviews', () => {
  it('keeps browser automation opt-in and independent from foreground collection', async () => {
    await start({ enabled: false }); expect(readBrowserClues).not.toHaveBeenCalled(); expect(manager.getSettings().autoBrowserClues).toBe(false);
    readBrowserClues.mockResolvedValue({ ...browserResult(), warnings: ['One profile could not be read'] });
    await manager.updateSettings({ ...config, autoBrowserClues: true, excludedProcesses: ['private.exe'] }); await vi.advanceTimersByTimeAsync(0);
    expect(capture).not.toHaveBeenCalled(); expect(readBrowserClues).toHaveBeenCalledWith('2026-09-05', ['private']); expect(clues).toHaveLength(1);
    const status = manager.getClueAutomationStatus(); expect(status.added).toBe(1); expect(status.lastSyncAt).not.toBeNull(); expect(status.warnings).toEqual(['One profile could not be read']);
    status.warnings.push('Mutated'); expect(manager.getClueAutomationStatus().warnings).toHaveLength(1);
  });
  it('does not block foreground sampling while a browser read is pending', async () => {
    let resolve!: (value: BrowserVisitsResult) => void; readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ autoBrowserClues: true, periodicSummaryMinutes: 0 }); await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(capture.mock.calls.length).toBeGreaterThanOrEqual(4); expect(manager.getClueAutomationStatus().syncing).toBe(true); expect(clues).toHaveLength(0);
    resolve(browserResult()); await vi.advanceTimersByTimeAsync(0); expect(clues).toHaveLength(1);
  });
  it('discards an old browser read after privacy settings change and retries with the new exclusions', async () => {
    let resolve!: (value: BrowserVisitsResult) => void; readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ autoBrowserClues: true, periodicSummaryMinutes: 0 });
    await manager.updateSettings({ ...config, excludedProcesses: ['chrome'] });
    resolve(browserResult()); await vi.advanceTimersByTimeAsync(0);
    expect(clues).toHaveLength(0); expect(readBrowserClues).toHaveBeenLastCalledWith('2026-09-05', ['chrome']); expect(readBrowserClues).toHaveBeenCalledTimes(2);
  });
  it('discards a read finishing while locked and checks immediately after resume', async () => {
    let resolve!: (value: BrowserVisitsResult) => void; readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ enabled: false, autoBrowserClues: true }); manager.pause(); resolve(browserResult()); await vi.advanceTimersByTimeAsync(0);
    expect(clues).toHaveLength(0); readBrowserClues.mockResolvedValue(browserResult()); manager.resume(); await vi.advanceTimersByTimeAsync(0);
    expect(clues).toHaveLength(1); expect(readBrowserClues).toHaveBeenCalledTimes(2);
  });
  it('does not import an in-flight result after browser automation is turned off', async () => {
    let resolve!: (value: BrowserVisitsResult) => void; readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ enabled: false, autoBrowserClues: true }); await manager.updateSettings({ ...config, autoBrowserClues: false });
    resolve(browserResult()); await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(clues).toHaveLength(0); expect(readBrowserClues).toHaveBeenCalledTimes(1); expect(manager.getClueAutomationStatus().syncing).toBe(false);
  });
  it('starts reading the new local day without waiting for the old day interval', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 23, 59)); await start({ enabled: false, autoBrowserClues: true, nightlySummaryTime: '' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readBrowserClues).toHaveBeenCalledTimes(2); expect(readBrowserClues).toHaveBeenLastCalledWith('2026-09-06', []);
  });
  it('stops without waiting for a browser worker and ignores its eventual result', async () => {
    let resolve!: (value: BrowserVisitsResult) => void; readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ enabled: false, autoBrowserClues: true }); await manager.stop();
    resolve(browserResult()); await vi.advanceTimersByTimeAsync(0); expect(clues).toHaveLength(0);
  });
  it('retries a busy reader after one minute without consuming the fifteen-minute interval', async () => {
    readBrowserClues.mockResolvedValueOnce(null).mockResolvedValue(browserResult());
    await start({ enabled: false, autoBrowserClues: true, nightlySummaryTime: '' }); expect(readBrowserClues).toHaveBeenCalledTimes(1); expect(manager.getClueAutomationStatus().lastSyncAt).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); expect(readBrowserClues).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14 * 60_000); expect(readBrowserClues).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); expect(readBrowserClues).toHaveBeenCalledTimes(3);
  });
  it('exposes worker failures and retries after fifteen minutes', async () => {
    readBrowserClues.mockRejectedValueOnce(new Error('History unavailable')).mockResolvedValue(browserResult());
    await start({ enabled: false, autoBrowserClues: true, nightlySummaryTime: '' }); expect(manager.getClueAutomationStatus().error).toBe('History unavailable');
    await vi.advanceTimersByTimeAsync(14 * 60_000); expect(readBrowserClues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(readBrowserClues).toHaveBeenCalledTimes(2); expect(manager.getClueAutomationStatus().error).toBeNull();
  });
  it('waits for browser clues before saving a complete nightly review and does not duplicate it on restart', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 22, 5)); let resolve!: (value: BrowserVisitsResult) => void;
    readBrowserClues.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await start({ autoBrowserClues: true, periodicSummaryMinutes: 0 }); clues.push(browserClue('Research plan', 'Compared two approaches'));
    expect(logs).toHaveLength(0); resolve(browserResult()); await vi.advanceTimersByTimeAsync(0);
    expect(logs).toHaveLength(1); expect(logs[0].content).toContain('SQLite documentation'); expect(logs[0].content).toContain('Compared two approaches'); expect(logs[0].content).toContain('A document'); expect(logs[0].sourceType).toBe('activity_summary');
    await manager.stop(); await manager.start(); await vi.advanceTimersByTimeAsync(0); expect(logs).toHaveLength(1);
  });
  it('waits for a busy browser reader before saving the nightly review', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 22, 5)); readBrowserClues.mockResolvedValueOnce(null).mockResolvedValue(browserResult());
    await start({ autoBrowserClues: true, periodicSummaryMinutes: 0 }); expect(logs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toHaveLength(1); expect(logs[0].content).toContain('SQLite documentation');
  });
  it('refreshes browser visits at the nightly time even when the next regular sync is later', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 21, 55)); readBrowserClues.mockResolvedValue(browserResult());
    await start({ enabled: false, autoBrowserClues: true, periodicSummaryMinutes: 0 }); expect(readBrowserClues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const result = browserResult(); result.visits[0].key = 'visit-2'; result.visits[0].title = 'New page just before bedtime'; readBrowserClues.mockResolvedValue(result);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readBrowserClues).toHaveBeenCalledTimes(2); expect(logs).toHaveLength(1); expect(logs[0].content).toContain('New page just before bedtime');
  });
  it('does not repeatedly force a failed nightly refresh while the review still has no data', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 21, 55)); await start({ enabled: false, autoBrowserClues: true, periodicSummaryMinutes: 0 });
    readBrowserClues.mockRejectedValue(new Error('History unavailable')); await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readBrowserClues).toHaveBeenCalledTimes(2); expect(manager.getClueAutomationStatus().error).toBe('History unavailable');
    await vi.advanceTimersByTimeAsync(60_000); expect(readBrowserClues).toHaveBeenCalledTimes(2); expect(logs).toHaveLength(0);
  });
  it('does not consume the nightly date on empty data or oversized content', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 22, 5)); await start({ enabled: false, autoBrowserClues: true, periodicSummaryMinutes: 0 });
    expect(logs).toHaveLength(0); expect(JSON.parse(memory.disk).lastNightlyDate).toBeNull();
    for (let index = 0; index < 21; index++) clues.push(browserClue(`Long note ${index}`, 'x'.repeat(5000)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toHaveLength(0); expect(manager.getClueAutomationStatus().reviewError).toContain('过多'); expect(JSON.parse(memory.disk).lastNightlyDate).toBeNull();
    clues.splice(1); clues[0].note = 'A shorter note'; await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toHaveLength(1); expect(manager.getClueAutomationStatus().reviewError).toBeNull(); expect(JSON.parse(memory.disk).lastNightlyDate).toBe('2026-09-05');
  });
  it('can still produce a review from collected clues when a browser read fails', async () => {
    vi.setSystemTime(new Date(2026, 8, 5, 22, 5)); readBrowserClues.mockRejectedValueOnce(new Error('History unavailable'));
    await start({ autoBrowserClues: true, periodicSummaryMinutes: 0 });
    expect(logs).toHaveLength(1); expect(logs[0].content).toContain('A document'); expect(manager.getClueAutomationStatus().error).toBe('History unavailable');
  });
});
