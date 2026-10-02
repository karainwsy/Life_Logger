import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createLogRepository, type LogRepository } from '@life-logger/storage';
import { parseBackup, serializeBackup } from '@life-logger/sync';
import type { ActivitySettings, BrowserHistorySummary, CreateLogInput, DeleteLogInput, GenerateActivitySummaryInput, GenerateBrowserHistorySummaryInput, LogDateRange, SearchLogsInput, TranscribeAudioInput, TranscribeAudioResult, UpdateLogInput } from '@life-logger/domain';
import { createActivityManager, type ActivityManager } from './activity-manager';
import { dateKeyRange } from '@life-logger/shared';
import type { BrowserVisitsResult, SearchCluesInput, UpdateClueInput, SaveDailyReviewInput } from '@life-logger/domain';

app.setName('life-logger');
const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');
const htmlPath = path.resolve(__dirname, '../dist/index.html');
const appUrl = isDev ? 'http://127.0.0.1:5173/' : pathToFileURL(htmlPath).href;
let repository: LogRepository;
let activity: ActivityManager;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopped = false;
let stopping = false;
let voiceBusy = false;
let voiceController: AbortController | null = null;
let historyBusy = false;
let cluesBusy = false;
let settingsRevision = 0;
let backupBusy = false;
let reviewExportBusy = false;
const workers = new Set<Worker>();

const notify = () => {
  if (window && !window.isDestroyed()) window.webContents.send('logs:changed');
};
const trusted = (event: IpcMainInvokeEvent) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== appUrl) throw new Error('请求来源无效');
};
const handle = <T>(channel: string, listener: (input: T) => unknown) => {
  ipcMain.handle(channel, (event, input: T) => { trusted(event); return listener(input); });
};
const runWorker = <T>(workerData: unknown, timeout = 120_000, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(__dirname, 'background-worker.cjs'), { workerData });
  workers.add(worker);
  let settled = false;
  const finish = (error?: Error, result?: T) => {
    if (settled) return; settled = true; clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    void worker.terminate().then(() => {
      workers.delete(worker);
      if (error) reject(error); else resolve(result!);
    }, terminationError => { workers.delete(worker); reject(error ?? terminationError); });
  };
  const timer = setTimeout(() => finish(new Error('处理超时，请缩短录音或统计范围后重试')), timeout);
  const cancel = () => finish(new Error('已取消转写'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  worker.once('message', (message: { result?: T; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result));
  worker.once('error', error => finish(error));
  worker.once('exit', code => { if (!settled) finish(new Error(`后台任务意外结束（${code}）`)); });
});
const readBrowserClues = async (date: string, excludedProcesses: string[], skipBusy = false): Promise<BrowserVisitsResult | null> => {
  if (cluesBusy) { if (skipBusy) return null; throw new Error('网页线索正在读取'); }
  const range = dateKeyRange(date);
  if (Date.parse(range.start) > Date.now()) throw new Error('不能读取未来的网页访问');
  cluesBusy = true;
  try {
    const result = await runWorker<BrowserVisitsResult>({ task: 'clues', input: { ...range, excludedProcesses } });
    if (quitting) throw new Error('应用正在退出');
    return result;
  } finally { cluesBusy = false; }
};
const transcribe = async (input: TranscribeAudioInput) => {
  if (voiceBusy) throw new Error('已有录音正在转写');
  if (!(input?.wavData instanceof ArrayBuffer) || input.wavData.byteLength < 44 || input.wavData.byteLength > 20 * 1024 * 1024) throw new Error('录音文件无效或过长');
  const audio = Buffer.from(input.wavData);
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('录音必须是 WAV 格式');
  voiceBusy = true;
  voiceController = new AbortController();
  const temporary = path.join(os.tmpdir(), `life-logger-${randomUUID()}.wav`);
  try {
    await fs.writeFile(temporary, audio);
    return await runWorker<TranscribeAudioResult>({ task: 'voice', input: { wavFilePath: temporary, modelsDir: path.join(app.getPath('userData'), 'whisper-models'), language: 'zh' } }, 180_000, voiceController.signal);
  } finally { voiceBusy = false; voiceController = null; await fs.rm(temporary, { force: true }); }
};
const show = () => { if (window) { window.restore(); window.show(); window.focus(); notify(); } };
const registerIpc = () => {
  ipcMain.on('app:getVersion', (event) => { event.returnValue = app.getVersion(); });
  handle<CreateLogInput>('logs:create', input => repository.createLog(input));
  handle<LogDateRange>('logs:listByRange', input => {
    if (!input || !Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end))) throw new Error('日期范围无效');
    return repository.getLogsByDateRange({ start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() });
  });
  handle<SearchLogsInput>('logs:search', input => repository.searchLogs(input ?? {}));
  handle<UpdateLogInput>('logs:update', input => repository.updateLog(input));
  handle<DeleteLogInput>('logs:delete', input => repository.deleteLog(input));
  handle<TranscribeAudioInput>('voice:transcribe', transcribe);
  handle('voice:cancel', () => { voiceController?.abort(); });
  handle<GenerateBrowserHistorySummaryInput>('browser:generateSummary', async input => {
    if (historyBusy) throw new Error('浏览统计正在生成');
    historyBusy = true;
    try { return await runWorker<BrowserHistorySummary>({ task: 'history', input: input ?? {} }); }
    finally { historyBusy = false; }
  });
  handle('activity:getSettings', () => activity.getSettings());
  handle('clues:getAutomationStatus', () => activity.getClueAutomationStatus());
  handle<SearchCluesInput>('clues:search', input => repository.searchClues(input));
  handle<{ date: string }>('review:get', input => repository.getDailyReview(input));
  handle<SaveDailyReviewInput>('review:save', input => repository.saveDailyReview(input));
  handle<SaveDailyReviewInput>('review:export', async input => {
    dateKeyRange(input?.date);
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100_000) throw new Error('回顾内容不能为空，且不能超过 10 万字');
    if (reviewExportBusy) throw new Error('请先完成当前导出');
    reviewExportBusy = true;
    try {
      const result = await dialog.showSaveDialog(window!, { title: '导出一天回顾', defaultPath: path.join(app.getPath('documents'), `life-logger-review-${input.date}.md`), filters: [{ name: 'Markdown 文档', extensions: ['md'] }] });
      if (result.canceled || !result.filePath) return null;
      await fs.writeFile(result.filePath, input.content.trim() + '\n', 'utf8');
      return { filePath: result.filePath };
    } finally { reviewExportBusy = false; }
  });
  handle<UpdateClueInput>('clues:update', input => repository.updateClue(input));
  handle<{ id: number }>('clues:save', input => repository.saveClueAsLog(input));
  handle<{ date: string }>('clues:importBrowser', async input => {
    const revision = settingsRevision;
    const result = (await readBrowserClues(input?.date, activity.getSettings().excludedProcesses ?? []))!;
    if (revision !== settingsRevision) throw new Error('采集设置已变化，请重新补充网页线索');
    return { added: repository.importBrowserVisits(result.visits), scanned: result.visits.length, warnings: result.warnings, truncated: result.truncated };
  });
  handle<ActivitySettings>('activity:updateSettings', input => {
    if (!input || typeof input !== 'object') throw new Error('设置格式无效');
    if (input.enabled && process.platform !== 'win32') throw new Error('当前系统暂不支持自动采集前台活动');
    settingsRevision++;
    return activity.updateSettings(input);
  });
  handle<number>('activity:getRecentSessions', limit => activity.getRecentSessions(limit));
  handle<GenerateActivitySummaryInput>('activity:generateSummary', input => activity.generateSummary(input));
  handle('backup:export', async () => {
    if (backupBusy) throw new Error('请等待当前备份操作完成'); backupBusy = true;
    try {
      const result = await dialog.showSaveDialog(window!, { title: '导出日志备份', defaultPath: path.join(app.getPath('documents'), `life-logger-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: '日志备份', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return null;
      const logs = repository.getAllLogs();
      await fs.writeFile(result.filePath, serializeBackup(logs), 'utf8');
      return { filePath: result.filePath, logCount: logs.length };
    } finally { backupBusy = false; }
  });
  handle('backup:import', async () => {
    if (backupBusy) throw new Error('请等待当前备份操作完成'); backupBusy = true;
    try {
      const result = await dialog.showOpenDialog(window!, { title: '恢复日志备份', properties: ['openFile'], filters: [{ name: '日志备份', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      if ((await fs.stat(result.filePaths[0])).size > 50 * 1024 * 1024) throw new Error('备份文件不能超过 50 MB');
      const backup = parseBackup(await fs.readFile(result.filePaths[0], 'utf8'));
      const confirm = await dialog.showMessageBox(window!, { type: 'warning', buttons: ['取消', '恢复备份'], defaultId: 0, cancelId: 0, title: '恢复日志', message: `用备份中的 ${backup.logs.length} 条日志替换当前日志？`, detail: '恢复前会自动保存当前日志的安全副本。原始活动记录和自动化设置不受影响。' });
      if (confirm.response !== 1) return null;
      const folder = path.join(app.getPath('userData'), 'recovery');
      await fs.mkdir(folder, { recursive: true });
      const snapshotPath = path.join(folder, `before-restore-${Date.now()}-${randomUUID()}.json`);
      writeFileSync(snapshotPath, serializeBackup(repository.getAllLogs()), { encoding: 'utf8', flag: 'wx' });
      return { importedCount: repository.replaceAllLogs(backup.logs), snapshotPath };
    } finally { backupBusy = false; }
  });
};

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    repository = createLogRepository(path.join(app.getPath('userData'), 'life-logger.db'), notify);
    activity = createActivityManager({ repository, stateFilePath: path.join(app.getPath('userData'), 'activity-settings.json'),
      readBrowserClues: (date, excludedProcesses) => readBrowserClues(date, excludedProcesses, true),
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      applyLoginItem: settings => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: settings.startMinimized ? ['--hidden'] : [] }); }
    });
    await activity.start(); registerIpc();
    const pauseReasons = new Set<string>();
    const pause = (reason: string) => { pauseReasons.add(reason); activity.pause(); };
    const resume = (reason: string) => { pauseReasons.delete(reason); if (!pauseReasons.size) activity.resume(); };
    powerMonitor.on('suspend', () => pause('suspend'));
    powerMonitor.on('lock-screen', () => pause('lock'));
    powerMonitor.on('resume', () => resume('suspend'));
    powerMonitor.on('unlock-screen', () => resume('lock'));
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 820, minHeight: 640, title: 'Life Logger', backgroundColor: '#f6f8fa', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== appUrl) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && details.isMainFrame && 'mediaTypes' in details && (details.mediaTypes ?? []).every(type => type === 'audio')));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    window.on('focus', notify);
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPY5DPf/2fEjxqwKgBIDxqwDAw4PV/AIEueB/XGtYiAAAAAElFTkSuQmCC');
    tray = new Tray(icon); tray.setToolTip('Life Logger');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Life Logger', click: show }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
    tray.on('click', show);
    if (isDev) await window.loadURL(appUrl); else await window.loadFile(htmlPath);
    if (!startHidden && !process.argv.includes('--smoke-test')) window.show();
    app.on('activate', show);
  }).catch(error => { console.error('应用启动失败', error); dialog.showErrorBox('Life Logger 启动失败', String(error)); app.exit(1); });
  app.on('before-quit', event => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void (async () => {
      await activity?.stop();
      await Promise.all([...workers].map(worker => worker.terminate()));
      repository?.close(); tray?.destroy(); stopped = true; app.quit();
    })().catch(error => { console.error('退出时保存失败', error); app.exit(1); });
  });
  app.on('window-all-closed', () => {});
}
