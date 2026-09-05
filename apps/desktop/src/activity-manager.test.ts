import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySession, ActivitySettings, LogEntry } from '@life-logger/domain';
import type { LogRepository } from '@life-logger/storage';
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
let logs: LogEntry[];
let config: ActivitySettings;
let idle = 0;
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
    pruneActivitySessions: vi.fn()
  } as unknown as LogRepository;
  manager = createActivityManager({ repository, stateFilePath: 'memory/settings.json', capture, getIdleSeconds: () => idle });
  await manager.start(); await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 5, 9, 0));
  sessions = []; logs = []; idle = 0; memory.files.clear();
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
    expect(logs).toHaveLength(2); expect(logs[0].content).toContain('30 分钟'); expect(logs[1].content).toContain('40 分钟');
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
});
