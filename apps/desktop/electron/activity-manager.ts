import fs from 'node:fs/promises';
import path from 'node:path';
import { captureForegroundWindow } from '@life-logger/capture';
import { generateActivitySummary } from '@life-logger/ai';
import { localDateKey, startOfDayIso } from '@life-logger/shared';
import type { ActivitySession, ActivitySettings, ActivitySummary, GenerateActivitySummaryInput } from '@life-logger/domain';
import type { LogRepository } from '@life-logger/storage';

type Dependencies = {
  repository: LogRepository;
  stateFilePath: string;
  getIdleSeconds?: () => number;
  applyLoginItem?: (settings: ActivitySettings) => void;
  capture?: typeof captureForegroundWindow;
};
type State = { settings: ActivitySettings; lastAutoSummaryAt: string | null; lastNightlyDate: string | null };
export type ActivityManager = {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  getSettings(): ActivitySettings;
  updateSettings(input: ActivitySettings): Promise<ActivitySettings>;
  getRecentSessions(limit?: number): ActivitySession[];
  generateSummary(input?: GenerateActivitySummaryInput): Promise<ActivitySummary>;
  summarizeSinceLast(): Promise<ActivitySummary | null>;
};

export const DEFAULT_SETTINGS: ActivitySettings = {
  enabled: false, pollIntervalSeconds: 60, periodicSummaryMinutes: 30,
  nightlySummaryTime: '22:00', openAtLogin: false, startMinimized: true,
  captureWindowTitles: true, excludedProcesses: [], retentionDays: 0
};
const integer = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
export const normalizeSettings = (input: Partial<ActivitySettings>): ActivitySettings => ({
  enabled: input.enabled === true,
  pollIntervalSeconds: integer(input.pollIntervalSeconds, 10, 600, 60),
  periodicSummaryMinutes: integer(input.periodicSummaryMinutes, 0, 1440, 30),
  nightlySummaryTime: input.nightlySummaryTime === '' ? '' :
    typeof input.nightlySummaryTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.nightlySummaryTime) ? input.nightlySummaryTime : '22:00',
  openAtLogin: input.openAtLogin === true, startMinimized: input.startMinimized === true,
  captureWindowTitles: input.captureWindowTitles === true,
  excludedProcesses: Array.isArray(input.excludedProcesses) ? input.excludedProcesses.filter((item): item is string => typeof item === 'string').slice(0, 100).map(item => item.trim().toLowerCase().replace(/\.exe$/, '')).filter(Boolean) : [],
  retentionDays: input.retentionDays && input.retentionDays > 0 ? integer(input.retentionDays, 7, 3650, 0) : 0
});

export const createActivityManager = ({ repository, stateFilePath, getIdleSeconds = () => 0, applyLoginItem = () => {}, capture = captureForegroundWindow }: Dependencies): ActivityManager => {
  let state: State = { settings: { ...DEFAULT_SETTINGS }, lastAutoSummaryAt: null, lastNightlyDate: null };
  let current: { id: number; key: string; start: number; lastSeen: number } | null = null;
  let timers: NodeJS.Timeout[] = [];
  let paused = false;
  let running = false;
  let generation = 0;
  let changesPending = 0;
  let lastPrunedDate = '';
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T> | T): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  const background = (task: () => Promise<unknown>) => { void task().catch(error => console.error('后台活动任务失败', error)); };
  const save = async () => {
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    const temporary = `${stateFilePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporary, stateFilePath);
  };
  const writeCurrent = (at: number) => {
    if (!current) return;
    const end = Math.max(current.start, Math.min(at, current.lastSeen + state.settings.pollIntervalSeconds * 1000));
    repository.closeActivitySession({ id: current.id, endedAt: new Date(end).toISOString(), durationSeconds: Math.round((end - current.start) / 1000) });
  };
  const close = (at = Date.now()) => { writeCurrent(at); current = null; };
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
  const pause = () => { paused = true; generation += 1; close(); };
  const poll = async () => {
    if (!running || paused || changesPending > 0 || !state.settings.enabled) return;
    if (getIdleSeconds() >= 300) { close(current?.lastSeen); return; }
    const token = generation;
    const foreground = await capture();
    if (token !== generation || !running || paused || changesPending > 0 || !state.settings.enabled) return;
    const now = Date.now();
    if (!foreground || state.settings.excludedProcesses?.includes(foreground.processName.toLowerCase().replace(/\.exe$/, ''))) {
      close(current?.lastSeen); return;
    }
    // Never bridge a suspend or a missed sampling interval with inferred activity.
    if (current && now - current.lastSeen > state.settings.pollIntervalSeconds * 2000) close(current.lastSeen);
    const title = state.settings.captureWindowTitles ? foreground.windowTitle : '';
    const key = `${foreground.processName}\u0000${title}`;
    if (current?.key === key) {
      current.lastSeen = now; writeCurrent(now); return;
    }
    close(now);
    const session = repository.openActivitySession({ processName: foreground.processName, windowTitle: title, startedAt: new Date(now).toISOString() });
    current = { id: session.id, key, start: now, lastSeen: now };
  };
  const summarize = (start: string, end: string, saveLog: boolean, input: GenerateActivitySummaryInput = {}) => {
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || start > end) throw new Error('摘要时间范围无效');
    if (!paused && running && getIdleSeconds() < 300) writeCurrent(Date.now());
    const sessions = repository.getActivitySessionsByRange({ start, end }).filter(session => session.endedAt > start && session.startedAt < end);
    const summary = generateActivitySummary({ sessions, start, end, maxProcesses: integer(input.maxProcesses, 1, 30, 8), maxTitles: integer(input.maxTitles, 1, 30, 6) });
    if (saveLog && summary.totalActiveSeconds > 0) repository.createLog({ content: summary.summaryText, sourceType: 'activity_summary' });
    return summary;
  };
  const checkScheduled = async () => {
    if (!running || paused || !state.settings.enabled) return;
    const now = new Date(); const end = now.toISOString(); const today = localDateKey(now);
    let changed = false;
    if (!state.lastAutoSummaryAt) { state.lastAutoSummaryAt = end; changed = true; }
    if (state.settings.periodicSummaryMinutes > 0 && now.getTime() - Date.parse(state.lastAutoSummaryAt!) >= state.settings.periodicSummaryMinutes * 60_000) {
      summarize(state.lastAutoSummaryAt!, end, true);
      state.lastAutoSummaryAt = end; changed = true;
    }
    if (state.settings.nightlySummaryTime && state.lastNightlyDate !== today) {
      const [hours, minutes] = state.settings.nightlySummaryTime.split(':').map(Number);
      const due = new Date(now); due.setHours(hours, minutes, 0, 0);
      if (now >= due) {
        summarize(startOfDayIso(now), end, true);
        state.lastNightlyDate = today; changed = true;
      }
    }
    if (lastPrunedDate !== today) {
      if (state.settings.retentionDays && state.settings.retentionDays > 0) {
        repository.pruneActivitySessions(new Date(now.getTime() - state.settings.retentionDays * 86_400_000).toISOString());
      }
      lastPrunedDate = today;
    }
    if (changed) await save();
  };
  const arm = () => {
    clearTimers();
    if (!state.settings.enabled || !running) return;
    let pollPending = false; let schedulePending = false;
    const sample = () => {
      if (pollPending) return;
      pollPending = true;
      background(() => serial(poll).finally(() => { pollPending = false; }));
    };
    const schedule = () => {
      if (schedulePending) return;
      schedulePending = true;
      background(() => serial(checkScheduled).finally(() => { schedulePending = false; }));
    };
    timers = [setInterval(sample, state.settings.pollIntervalSeconds * 1000), setInterval(schedule, 60_000)];
    sample(); schedule();
  };
  return {
    async start() {
      await serial(async () => {
        try {
          const parsed = JSON.parse(await fs.readFile(stateFilePath, 'utf8')) as Partial<State>;
          state = { settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }),
            lastAutoSummaryAt: typeof parsed.lastAutoSummaryAt === 'string' && Number.isFinite(Date.parse(parsed.lastAutoSummaryAt)) && Date.parse(parsed.lastAutoSummaryAt) <= Date.now() ? new Date(parsed.lastAutoSummaryAt).toISOString() : null,
            lastNightlyDate: typeof parsed.lastNightlyDate === 'string' ? parsed.lastNightlyDate : null };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('自动化设置读取失败，使用默认设置', error); }
        state.lastAutoSummaryAt ??= new Date().toISOString();
        running = true; paused = false;
        applyLoginItem(state.settings); await save();
      });
      arm();
    },
    async stop() {
      running = false; generation += 1; clearTimers(); close();
      await serial(save);
    },
    pause,
    resume() { paused = false; background(() => serial(poll)); },
    getSettings() { return { ...state.settings, excludedProcesses: [...(state.settings.excludedProcesses ?? [])] }; },
    async updateSettings(input) {
      generation += 1; changesPending++; close(); clearTimers();
      return serial(async () => {
        try {
          const settings = normalizeSettings(input);
          if (settings.enabled && !state.settings.enabled) state.lastAutoSummaryAt = new Date().toISOString();
          applyLoginItem(settings); state.settings = settings;
          await save(); return { ...state.settings };
        } finally { changesPending--; arm(); }
      });
    },
    getRecentSessions(limit = 20) {
      return repository.getActivitySessionsByRange({ start: new Date(Date.now() - 7 * 86_400_000).toISOString(), end: new Date().toISOString() })
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, integer(limit, 1, 200, 20));
    },
    generateSummary(input = {}) {
      return serial(() => {
        const end = input.end ? new Date(input.end).toISOString() : new Date().toISOString();
        const start = input.start ? new Date(input.start).toISOString() : startOfDayIso(new Date(end));
        return summarize(start, end, false, input);
      });
    },
    summarizeSinceLast() {
      return serial(async () => {
        if (!running || paused || !state.settings.enabled) return null;
        const end = new Date().toISOString(); const start = state.lastAutoSummaryAt ?? startOfDayIso(new Date());
        if (Date.parse(end) - Date.parse(start) < 300_000) return null;
        const summary = summarize(start, end, true); state.lastAutoSummaryAt = end; await save(); return summary;
      });
    }
  };
};
