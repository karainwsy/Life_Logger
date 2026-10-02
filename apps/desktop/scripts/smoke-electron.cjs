const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const logHandlers = new Map();
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => { if (['logs:create', 'logs:update', 'review:get'].includes(channel)) logHandlers.set(channel, listener); registerHandler(channel, listener); };
const root = path.resolve(__dirname, '../../..');
const artifactRoot = path.join(root, '.test-artifacts'); fs.mkdirSync(artifactRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifactRoot, 'desktop-'));
// Redirect every browser-clue worker to a real SQLite fixture, including automatic background reads.
const workerThreads = require('node:worker_threads'); const NativeWorker = workerThreads.Worker;
const browserWorkerPath = path.join(artifactRoot, 'browser-smoke-worker.cjs');
fs.writeFileSync(browserWorkerPath, `const { parentPort, workerData } = require('node:worker_threads');
require('./clues-fixture.cjs').readSmokeBrowserVisits(workerData.input, workerData.folder)
  .then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }));`);
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    const browser = options?.workerData?.task === 'clues';
    super(browser ? browserWorkerPath : filename, browser ? { ...options, workerData: { ...options.workerData, folder: dataDir } } : options);
  }
};
app.setPath('userData', dataDir); app.setPath('sessionData', dataDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const backupPath = path.join(dataDir, 'backup.json');
dialog.showSaveDialog = async (_window, options) => ({ canceled: false, filePath: options.title === '导出一天回顾' ? path.join(dataDir, 'review.md') : backupPath });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backupPath] });
dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = (title, content) => { console.error(title, content); app.exit(1); };
const timeout = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 90_000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => {
    const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const waitFor = async (fn, ...args) => {
      for (let i = 0; i < 80; i++) { if (await evaluate(fn, ...args)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`UI condition timed out: ${fn.toString()}`);
    };
    const clickText = text => evaluate(label => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label); if (!button) throw new Error(`Button missing: ${label}`); button.click(); }, text);
    const fill = (selector, value) => evaluate((selector, value) => {
      const element = document.querySelector(selector); if (!element) throw new Error(`Input missing: ${selector}`);
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
    }, selector, value);
    const shot = async (name, top = false) => {
      await evaluate(() => document.querySelector('[aria-label="关闭提示"]')?.click());
      // Force a new compositor frame for a hidden test window before capture.
      const [width, height] = window.getSize(); window.setSize(width + 1, height);
      await new Promise(resolve => setTimeout(resolve, 180)); window.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 180));
      if (top) await evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); });
      await window.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 100));
      const image = await window.webContents.capturePage(); fs.writeFileSync(path.join(artifactRoot, name), image.toPNG());
    };
    (async () => {
      await waitFor(() => Boolean(document.querySelector('.composer')));
      assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sidebar')).position), 'fixed');
      await shot('journal-empty.png');
      await evaluate(() => {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        window.testStreams = [];
        navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); window.testStreams.push(stream); return stream; };
      });
      // Chromium supplies a synthetic microphone. No real device is accessed.
      await evaluate(() => document.querySelector('[aria-label="开始语音记录"]').click());
      await waitFor(() => Boolean(document.querySelector('[aria-label="停止录音并转写"]')));
      await fill('textarea[aria-label="日志内容"]', '录音期间继续编辑');
      assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('记下来')).disabled), true);
      await clickText('取消'); await waitFor(() => Boolean(document.querySelector('[aria-label="开始语音记录"]:not(:disabled)')));
      assert.equal(await evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      assert.equal((await evaluate(() => window.lifeLogger.searchLogs({}))).total, 0);
      // A successful save must clear its persisted draft even after leaving the editor.
      const createLog = logHandlers.get('logs:create');
      let finishSave;
      ipcMain.removeHandler('logs:create');
      ipcMain.handle('logs:create', (event, input) => new Promise(resolve => { finishSave = () => resolve(createLog(event, input)); }));
      await fill('textarea[aria-label="日志内容"]', '保存期间切页的草稿'); await clickText('记下来');
      await waitFor(() => document.body.textContent.includes('保存中…'));
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-workspace')));
      assert.ok(finishSave); finishSave();
      await waitFor(() => JSON.parse(localStorage.getItem('life-logger.draft.v1') ?? '{}').content !== '保存期间切页的草稿');
      await clickText('我的日志'); await waitFor(() => document.querySelector('[aria-label="日志内容"]')?.value === '');
      const draftLog = (await evaluate(() => window.lifeLogger.searchLogs({ query: '保存期间切页' }))).logs[0];
      await evaluate(id => window.lifeLogger.deleteLog({ id }), draftLog.id);
      // Finishing an earlier save must preserve text written after returning to the page.
      finishSave = null;
      await fill('textarea[aria-label="日志内容"]', '等待完成的旧草稿'); await clickText('记下来');
      await waitFor(() => document.body.textContent.includes('保存中…'));
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-workspace')));
      await clickText('我的日志'); await waitFor(() => Boolean(document.querySelector('.composer')));
      await fill('textarea[aria-label="日志内容"]', '重新进入后写的新草稿');
      assert.ok(finishSave); finishSave();
      await waitFor(() => document.querySelector('.entry-content')?.textContent.includes('等待完成的旧草稿'));
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-workspace')));
      await clickText('我的日志'); await waitFor(() => document.querySelector('[aria-label="日志内容"]')?.value === '重新进入后写的新草稿');
      const oldDraftLog = (await evaluate(() => window.lifeLogger.searchLogs({ query: '等待完成的旧草稿' }))).logs[0];
      await evaluate(id => window.lifeLogger.deleteLog({ id }), oldDraftLog.id);
      ipcMain.removeHandler('logs:create'); ipcMain.handle('logs:create', createLog);
      // Storage failures must be visible and leave an unreadable draft untouched.
      await evaluate(() => {
        window.originalDraftGet = Storage.prototype.getItem; window.originalDraftSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) { if (key === 'life-logger.draft.v1') throw new Error('模拟草稿空间不足'); return window.originalDraftSet.call(this, key, value); };
      });
      await fill('textarea[aria-label="日志内容"]', '未能保留的草稿');
      await waitFor(() => document.body.textContent.includes('草稿未能保留'));
      assert.equal(await evaluate(() => document.body.textContent.includes('草稿自动保留')), false);
      await shot('composer-storage-warning.png');
      await evaluate(() => { Storage.prototype.setItem = window.originalDraftSet; Storage.prototype.getItem = function(key) { if (key === 'life-logger.draft.v1') throw new Error('模拟无法读取'); return window.originalDraftGet.call(this, key); }; });
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-workspace')));
      await clickText('我的日志'); await waitFor(() => document.body.textContent.includes('草稿读取失败'));
      assert.equal(await evaluate(() => JSON.parse(window.originalDraftGet.call(localStorage, 'life-logger.draft.v1')).content), '重新进入后写的新草稿');
      await evaluate(() => { Storage.prototype.getItem = window.originalDraftGet; });
      await fill('textarea[aria-label="日志内容"]', '');
      // Real renderer -> preload -> IPC -> SQLite, in a newly created isolated data directory.
      await fill('textarea[aria-label="日志内容"]', '测试：完成今天的第一条记录'); await clickText('记下来');
      await waitFor(() => document.querySelector('.entry-content')?.textContent.includes('第一条记录'));
      let result = await evaluate(() => window.lifeLogger.searchLogs({})); assert.equal(result.total, 1);
      const firstId = result.logs[0].id;
      await evaluate(() => document.querySelector('[aria-label="编辑日志"]').click());
      const updateLog = logHandlers.get('logs:update'); let finishUpdate;
      ipcMain.removeHandler('logs:update');
      ipcMain.handle('logs:update', (event, input) => new Promise(resolve => { finishUpdate = () => resolve(updateLog(event, input)); }));
      await fill('textarea[aria-label="编辑日志内容"]', '测试：修改后的内容'); await clickText('保存修改');
      await waitFor(() => document.querySelector('textarea[aria-label="编辑日志内容"]')?.disabled === true);
      await evaluate(() => document.querySelector('textarea[aria-label="编辑日志内容"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(await evaluate(() => Boolean(document.querySelector('textarea[aria-label="编辑日志内容"]'))), true);
      assert.ok(finishUpdate); finishUpdate();
      await waitFor(() => document.querySelector('.entry-content')?.textContent === '测试：修改后的内容');
      ipcMain.removeHandler('logs:update'); ipcMain.handle('logs:update', updateLog);
      for (const sourceType of ['voice', 'ai_summary', 'activity_summary']) await evaluate(sourceType => window.lifeLogger.createLog({ content: `测试 ${sourceType}`, sourceType }), sourceType);
      await evaluate(() => window.lifeLogger.exportBackup()); assert.equal(JSON.parse(fs.readFileSync(backupPath, 'utf8')).logs.length, 4);
      await evaluate(id => window.lifeLogger.deleteLog({ id }), firstId);
      const restored = await require('./backup-restore-fixture.cjs').testRestoreWithConcurrentLog({ dbPath: path.join(dataDir, 'life-logger.db'), restore: () => evaluate(() => window.lifeLogger.importBackup()) });
      assert.equal(restored.importedCount, 4); assert.ok(fs.existsSync(restored.snapshotPath));
      assert.equal(JSON.parse(fs.readFileSync(restored.snapshotPath, 'utf8')).logs.length, 3);
      // Import historical and early-morning records through the same restore path.
      const fixture = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      fixture.logs.push({ content: '更早的日记，跨越最近一个月的限制。', createdAt: '2024-01-02T03:00:00.000Z', sourceType: 'manual' });
      fixture.logs.push({ content: '凌晨日期分组测试', createdAt: new Date(2026, 8, 5, 1, 0).toISOString(), sourceType: 'manual' });
      fs.writeFileSync(backupPath, JSON.stringify(fixture)); await evaluate(() => window.lifeLogger.importBackup());
      assert.equal((await evaluate(() => window.lifeLogger.searchLogs({ date: '2024-01-02' }))).total, 1);
      assert.equal((await evaluate(() => window.lifeLogger.searchLogs({ date: '2026-09-05', query: '凌晨' }))).total, 1);
      await fill('[aria-label="搜索全部日志"]', '更早的日记'); await waitFor(() => document.querySelectorAll('.log-entry').length === 1 && document.querySelector('.entry-content')?.textContent.includes('更早'));
      await fill('[aria-label="搜索全部日志"]', '不存在的内容'); await waitFor(() => document.body.textContent.includes('没有找到匹配的记录'));
      await fill('[aria-label="搜索全部日志"]', ''); await waitFor(() => document.querySelectorAll('.log-entry').length === 6);
      // Validate a missing-model failure without requesting the user's microphone.
      const voiceError = await evaluate(async () => {
        const data = new ArrayBuffer(46); const bytes = new Uint8Array(data);
        for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE']]) [...text].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
        try { await window.lifeLogger.transcribeAudio({ wavData: data }); return ''; } catch (error) { return error.message; }
      }); assert.match(voiceError, /未找到本地 Whisper 模型/);
      // Exercise a delayed transcription while the user continues editing the draft.
      ipcMain.removeHandler('voice:transcribe');
      let finishTranscription;
      ipcMain.handle('voice:transcribe', (_event, input) => {
        const view = new DataView(input.wavData);
        assert.equal(view.getUint32(24, true), 16000);
        assert.ok(input.wavData.byteLength > 44);
        return new Promise(resolve => { finishTranscription = resolve; });
      });
      await fill('textarea[aria-label="日志内容"]', '原始草稿');
      await evaluate(() => document.querySelector('[aria-label="开始语音记录"]').click());
      await waitFor(() => Boolean(document.querySelector('[aria-label="停止录音并转写"]')));
      await new Promise(resolve => setTimeout(resolve, 450));
      await evaluate(() => document.querySelector('[aria-label="停止录音并转写"]').click());
      await waitFor(() => document.body.textContent.includes('正在本地转写'));
      window.setMinimumSize(360, 640); window.setSize(650, 820);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await evaluate(() => { const status = document.querySelector('.recording-status'); return status.textContent.includes('正在本地转写') && status.getBoundingClientRect().height > 0; }), true, 'transcription status stays visible in a narrow window');
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'narrow composer horizontal overflow');
      window.setSize(1440, 940); window.setMinimumSize(820, 640);
      await fill('textarea[aria-label="日志内容"]', '转写期间新写的内容');
      for (let i = 0; !finishTranscription && i < 60; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(finishTranscription); finishTranscription({ text: '语音追加内容' });
      await waitFor(() => document.querySelector('[aria-label="日志内容"]').value === '转写期间新写的内容\n语音追加内容');
      assert.equal(await evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      await fill('textarea[aria-label="日志内容"]', '');
      await clickText('设置与备份'); await waitFor(() => document.querySelector('[role="switch"]'));
      await evaluate(() => { const labels = [...document.querySelectorAll('.toggle-row')]; labels.find(label => label.textContent.includes('记录窗口标题')).querySelector('input').click(); });
      await evaluate(() => document.querySelectorAll('.settings-section')[1].scrollIntoView({ block: 'center' }));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate(() => { const bar = document.querySelector('.settings-save'); const rect = bar.getBoundingClientRect(); return bar.classList.contains('is-dirty') && rect.top >= 0 && rect.bottom <= window.innerHeight; }), true, 'unsaved settings and save action remain visible while scrolling');
      await clickText('保存设置'); await waitFor(() => document.body.textContent.includes('设置已保存'));
      assert.equal((await evaluate(() => window.lifeLogger.getActivitySettings())).captureWindowTitles, false);
      await shot('settings.png', true);
      await clickText('自动记录'); await waitFor(() => document.body.textContent.includes('今天还没有活动记录')); await shot('activity.png');
      await clickText('浏览回顾'); await waitFor(() => document.body.textContent.includes('选择时间范围')); await shot('browser-empty.png');
      // Only the browser data is a synthetic fixture; no personal browser database is opened.
      ipcMain.removeHandler('browser:generateSummary');
      ipcMain.handle('browser:generateSummary', () => ({ generatedAt: new Date().toISOString(), start: '2026-08-29T00:00:00Z', end: '2026-09-05T00:00:00Z', rangeLabel: '8 月 29 日 至 9 月 5 日', totalVisits: 86, uniqueDomains: 3, totalItems: 3, topDomains: [{ domain: 'github.com', visits: 42, percentage: 49 }, { domain: 'developer.mozilla.org', visits: 28, percentage: 33 }, { domain: 'wikipedia.org', visits: 16, percentage: 18 }], topItems: [{ url: 'https://developer.mozilla.org/', title: 'MDN Web Docs · Web 开发文档', visitCount: 28 }], summaryText: '在最近 7 天内，共统计 86 次页面访问，来自 3 个网站。\n主要关注：项目开发、技术文档与知识检索。', sources: [{ browser: 'Chrome', profile: 'Default', itemCount: 3 }], warnings: [], truncated: false }));
      await clickText('生成回顾'); await waitFor(() => document.body.textContent.includes('github.com')); await shot('browser.png');
      await clickText('保存为日志'); await waitFor(() => document.body.textContent.includes('浏览回顾已保存到日志'));
      await clickText('我的日志'); await waitFor(() => document.querySelectorAll('.log-entry').length === 7);
      await evaluate(() => document.querySelector('[aria-label="删除日志"]').click()); await clickText('删除'); await waitFor(() => document.querySelectorAll('.log-entry').length === 6);
      await clickText('活动线索'); await waitFor(() => document.body.textContent.includes('这一天，还没有留下线索'));
      await shot('clues-empty.png');
      const clues = await require(path.join(artifactRoot, 'clues-fixture.cjs')).testAndSeedClues(path.join(dataDir, 'life-logger.db'), dataDir);
      await evaluate(() => document.querySelector('[aria-label="刷新活动线索"]').click());
      await waitFor(() => document.querySelectorAll('.clue-card').length === 5);
      await clickText('补充备注');
      await fill('[aria-label="线索名称"]', '开发 Life Logger 的活动线索页面');
      await fill('[aria-label="线索备注"]', '把窗口标题和网页访问放到同一条时间线上，先完成备注与搜索。');
      await clickText('一天回顾'); await waitFor(() => Boolean(document.querySelector('.review-editor')));
      await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]')?.value.includes('SQLite'));
      assert.equal(await evaluate(() => [...document.querySelectorAll('.review-group input')].filter(input => input.checked).length), 3);
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value.includes('讨论 Life Logger')), false, 'single visits are available but not automatically recommended');
      assert.equal(await evaluate(() => document.querySelectorAll('.review-recommendation').length), 3);
      await clickText('线索时间线'); await waitFor(() => document.querySelector('[aria-label="线索备注"]')?.value.includes('同一条时间线'));
      await clickText('网页访问'); await waitFor(() => document.querySelectorAll('.clue-card').length === 3);
      await clickText('全部线索'); await waitFor(() => document.querySelector('[aria-label="线索名称"]')?.value === '开发 Life Logger 的活动线索页面');
      window.webContents.reload(); await waitFor(() => Boolean(document.querySelector('.composer')));
      await clickText('活动线索'); await waitFor(() => document.querySelector('[aria-label="线索备注"]')?.value.includes('同一条时间线'));
      await clickText('我的日志'); await waitFor(() => Boolean(document.querySelector('.composer')));
      await clickText('活动线索'); await waitFor(() => document.querySelector('[aria-label="线索备注"]')?.value.includes('同一条时间线'));
      await shot('clue-draft.png');
      await clickText('保存备注'); await waitFor(() => document.querySelector('.clue-user-note')?.textContent.includes('同一条时间线'));
      assert.equal(await evaluate(id => localStorage.getItem(`life-logger:clue-draft:${id}`), clues.firstId), null);
      await clickText('编辑备注'); await fill('[aria-label="线索备注"]', '应当取消的未保存备注'); await clickText('取消');
      await clickText('我的日志'); await waitFor(() => Boolean(document.querySelector('.composer')));
      await clickText('活动线索'); await waitFor(() => document.querySelector('.clue-user-note')?.textContent.includes('同一条时间线'));
      assert.equal(await evaluate(() => Boolean(document.querySelector('[aria-label="线索备注"]'))), false);
      await clickText('编辑备注');
      await evaluate(() => {
        window.originalClueSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) { if (key.startsWith('life-logger:clue-draft:')) throw new Error('模拟线索草稿空间不足'); return window.originalClueSet.call(this, key, value); };
      });
      await fill('[aria-label="线索备注"]', '无法自动保留的线索备注');
      await waitFor(() => document.body.textContent.includes('线索草稿未能保留'));
      await evaluate(() => { Storage.prototype.setItem = window.originalClueSet; });
      await fill('[aria-label="线索备注"]', '可自动保留的线索备注');
      assert.equal(await evaluate(() => document.body.textContent.includes('线索草稿未能保留')), false);
      await clickText('取消');
      await evaluate(id => localStorage.setItem(`life-logger:clue-draft:${id}`, '{'), clues.firstId);
      await clickText('我的日志'); await waitFor(() => Boolean(document.querySelector('.composer')));
      await clickText('活动线索'); await waitFor(() => document.body.textContent.includes('线索草稿读取失败'));
      assert.equal(await evaluate(id => localStorage.getItem(`life-logger:clue-draft:${id}`), clues.firstId), '{');
      await evaluate(id => localStorage.removeItem(`life-logger:clue-draft:${id}`), clues.firstId);
      await clickText('我的日志'); await waitFor(() => Boolean(document.querySelector('.composer')));
      await clickText('活动线索'); await waitFor(() => document.querySelector('.clue-user-note')?.textContent.includes('同一条时间线'));
      await evaluate(() => document.querySelector('.clue-evidence summary').click());
      assert.equal(await evaluate(() => document.querySelector('.clue-evidence').textContent.includes('CluesPanel.tsx')), true);
      await clickText('保存为日志'); await waitFor(() => document.querySelector('.clue-actions').textContent.includes('已保存为日志'));
      const firstSaved = await evaluate(id => window.lifeLogger.saveClueAsLog({ id }), clues.firstId);
      assert.equal((await evaluate(id => window.lifeLogger.saveClueAsLog({ id }), clues.firstId)).id, firstSaved.id);
      await evaluate(() => window.lifeLogger.exportBackup());
      assert.ok(JSON.parse(fs.readFileSync(backupPath, 'utf8')).logs.some(log => log.content.includes('同一条时间线')));
      await clickText('忽略'); await waitFor(() => document.querySelectorAll('.clue-card').length === 4);
      await evaluate(() => document.querySelector('.clue-dismissed input').click());
      await waitFor(() => document.querySelectorAll('.clue-card').length === 1);
      await clickText('恢复线索'); await waitFor(() => document.querySelectorAll('.clue-card').length === 0);
      await evaluate(() => document.querySelector('.clue-dismissed input').click());
      await waitFor(() => document.querySelectorAll('.clue-card').length === 5);
      await fill('[aria-label="搜索活动线索"]', '同一条时间线'); await waitFor(() => document.querySelectorAll('.clue-card').length === 1);
      await fill('[aria-label="搜索活动线索"]', ''); await waitFor(() => document.querySelectorAll('.clue-card').length === 5);
      await clickText('网页访问'); await waitFor(() => document.querySelectorAll('.clue-card').length === 3);
      assert.equal(await evaluate(() => [...document.querySelectorAll('.clue-url')].every(node => !node.textContent.includes('?'))), true);
      // Import UI uses controlled output; browser SQL/privacy behavior was checked with the synthetic home above.
      ipcMain.removeHandler('clues:importBrowser');
      ipcMain.handle('clues:importBrowser', () => ({ added: 0, scanned: 3, warnings: [], truncated: false }));
      await clickText('补充网页线索'); await waitFor(() => document.body.textContent.includes('重复记录已跳过'));
      await clickText('全部线索'); await waitFor(() => document.querySelectorAll('.clue-card').length === 5);
      await clickText('我的日志'); await waitFor(() => document.querySelectorAll('.log-entry').length === 7);
      await clickText('活动线索'); await waitFor(() => document.querySelector('.clue-user-note')?.textContent.includes('同一条时间线'));
      await shot('clues.png');
      window.setSize(900, 820); await shot('clues-narrow.png');
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'clues horizontal overflow');
      window.setSize(1440, 940);
      await clickText('我的日志'); await waitFor(() => document.querySelectorAll('.log-entry').length === 7);

      await clickText('活动线索'); await waitFor(() => document.querySelector('.clue-card'));
      await clickText('一天回顾'); await waitFor(() => document.querySelectorAll('.review-group').length === 4);
      assert.equal(await evaluate(() => document.querySelector('.review-stats').textContent.includes('5条未忽略线索')), true);
      await clickText('清空选择');
      assert.equal(await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '重新整理草稿').disabled), true);
      await clickText('全选当天'); await clickText('重新整理草稿');
      await waitFor(() => Boolean(document.querySelector('.review-replacement'))); await clickText('使用新草稿');
      await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]').value.includes('SQLite'));
      const originalReview = await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value);
      const editedReview = originalReview + '\n回顾测试：完成线索整理，明天继续改进。';
      await fill('[aria-label="一天回顾草稿"]', editedReview);
      await clickText('推荐选择');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.review-group input')].filter(input => input.checked).length), 3);
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), editedReview, 'recommendation changes choices, not edited text');
      await clickText('全选当天');
      ipcMain.removeHandler('clues:importBrowser');
      ipcMain.handle('clues:importBrowser', () => ({ added: 0, scanned: 0, warnings: ['模拟浏览器被占用，请关闭后重试。'], truncated: false }));
      await clickText('补充网页线索'); await waitFor(() => document.body.textContent.includes('模拟浏览器被占用'));
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), editedReview);
      await clickText('线索时间线'); await waitFor(() => document.querySelector('.clue-card'));
      await clickText('一天回顾'); await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]')?.value.includes('回顾测试'));
      await evaluate(() => document.querySelector('[aria-label="线索前一天"]').click());
      await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]')?.value === '');
      await fill('[aria-label="一天回顾草稿"]', '前一天的独立草稿');
      await evaluate(() => document.querySelector('[aria-label="线索后一天"]').click());
      await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]')?.value.includes('回顾测试'));
      await waitFor(() => document.querySelectorAll('.review-group').length === 4);
      await clickText('重新整理草稿'); await waitFor(() => document.querySelector('.review-replacement'));
      await clickText('保留当前草稿');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), editedReview);
      await clickText('重新整理草稿'); await waitFor(() => document.querySelector('.review-replacement'));
      await clickText('使用新草稿');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), originalReview);
      await fill('[aria-label="一天回顾草稿"]', editedReview);
      await clickText('保存回顾为日志'); await waitFor(() => document.body.textContent.includes('一天回顾已保存到我的日志'));
      const savedReview = (await evaluate(() => window.lifeLogger.searchLogs({ query: '回顾测试' }))).logs[0];
      assert.ok(savedReview);
      assert.equal((await evaluate(input => window.lifeLogger.saveDailyReview(input), { date: clues.date, content: editedReview })).id, savedReview.id);
      assert.equal((await evaluate(() => window.lifeLogger.searchLogs({}))).total, 8);
      await clickText('导出 Markdown'); await waitFor(() => document.body.textContent.includes('回顾已导出至'));
      assert.equal(fs.readFileSync(path.join(dataDir, 'review.md'), 'utf8'), editedReview.trim() + '\n');
      await evaluate(() => window.lifeLogger.exportBackup());
      assert.ok(JSON.parse(fs.readFileSync(backupPath, 'utf8')).logs.some(log => log.content.includes('回顾测试')));
      await evaluate(() => { document.querySelector('.review-editor textarea').scrollTop = 0; });
      await shot('daily-review.png', true);
      assert.equal(await evaluate(() => { const source = document.querySelector('.review-group').getBoundingClientRect(); const editor = document.querySelector('.review-editor').getBoundingClientRect(); return editor.left > source.right && editor.top < source.top; }), true, 'wide review shows the editor beside the selected fragments');
      window.setSize(900, 820); await shot('daily-review-selection-narrow.png', true);
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'recommended selection horizontal overflow');
      window.setSize(1440, 940);
      await evaluate(() => { document.querySelector('.review-editor textarea').scrollTop = 0; document.querySelector('.review-editor').scrollIntoView({ block: 'start' }); }); await shot('daily-review-editor.png');
      window.setSize(900, 820); await shot('daily-review-narrow.png');
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'daily review horizontal overflow');
      window.setSize(1440, 940);
      await evaluate(id => window.lifeLogger.deleteLog({ id }), savedReview.id);
      await clickText('我的日志'); await waitFor(() => document.querySelectorAll('.log-entry').length === 7);

      // First-time automation must respect both intentional empty drafts and text written while loading.
      const getReview = logHandlers.get('review:get');
      const reviewFixture = await evaluate(date => window.lifeLogger.getDailyReview({ date }), clues.date);
      const shiftedDate = days => { const date = new Date(); date.setDate(date.getDate() - days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
      let reviewMode = 'delayed'; let finishReview;
      ipcMain.removeHandler('review:get');
      ipcMain.handle('review:get', (_event, input) => {
        const result = { ...reviewFixture, date: input.date };
        if (reviewMode === 'empty') Object.assign(result, { groups: [], clueCount: 0, windowCount: 0, visitCount: 0, activeSeconds: 0 });
        if (reviewMode === 'single') Object.assign(result, { groups: [{ ...reviewFixture.groups.find(group => group.kind === 'browser'), count: 1, notes: [], label: '' }], clueCount: 1, windowCount: 0, visitCount: 1, activeSeconds: 0 });
        return reviewMode === 'delayed' ? new Promise(resolve => { finishReview = () => resolve(result); }) : result;
      });
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-workspace')));
      await fill('[aria-label="线索日期"]', shiftedDate(2)); await clickText('一天回顾');
      await waitFor(() => Boolean(document.querySelector('[aria-label="一天回顾草稿"]')));
      await fill('[aria-label="一天回顾草稿"]', '等待线索加载时写的内容');
      assert.ok(finishReview); finishReview();
      await waitFor(() => document.querySelectorAll('.review-group').length === 4);
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), '等待线索加载时写的内容');
      reviewMode = 'empty'; await fill('[aria-label="线索日期"]', shiftedDate(3));
      await waitFor(() => document.body.textContent.includes('这一天还没有可整理的线索'));
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), '');
      reviewMode = 'full'; await evaluate(() => document.querySelector('[aria-label="刷新活动线索"]').click());
      await waitFor(() => document.querySelector('[aria-label="一天回顾草稿"]')?.value.includes('SQLite'));
      await fill('[aria-label="一天回顾草稿"]', ''); await clickText('清空选择');
      await clickText('线索时间线'); await waitFor(() => Boolean(document.querySelector('.clue-list')));
      await clickText('一天回顾'); await waitFor(() => document.querySelectorAll('.review-group').length === 4);
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), '');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.review-group input')].some(input => input.checked)), false);
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').placeholder.includes('\n')), true);
      reviewMode = 'single'; await fill('[aria-label="线索日期"]', shiftedDate(4));
      await waitFor(() => document.body.textContent.includes('暂无推荐片段'));
      assert.equal(await evaluate(() => document.querySelector('[aria-label="一天回顾草稿"]').value), '');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.review-group input')].some(input => input.checked)), false);
      ipcMain.removeHandler('review:get'); ipcMain.handle('review:get', getReview);

      // Actual automatic renderer -> IPC -> worker -> synthetic Chromium history -> SQLite.
      await clickText('设置与备份'); await waitFor(() => Boolean(document.querySelector('[role="switch"]')));
      await evaluate(() => {
        const rows = [...document.querySelectorAll('.toggle-row')];
        const nightly = rows.find(row => row.textContent.includes('每晚生成今日总结')).querySelector('input'); if (nightly.checked) nightly.click();
        rows.find(row => row.textContent.includes('自动补充网页线索')).querySelector('input').click();
      });
      await clickText('保存设置'); await waitFor(async () => { const status = await window.lifeLogger.getClueAutomationStatus(); return Boolean(status.lastSyncAt) && !status.syncing; });
      const autoSettings = await evaluate(() => window.lifeLogger.getActivitySettings());
      assert.equal(autoSettings.enabled, false); assert.equal(autoSettings.autoBrowserClues, true);
      assert.equal((await evaluate(() => window.lifeLogger.getClueAutomationStatus())).added, 0, 'automatic import deduplicates existing visits');
      const firstSync = (await evaluate(() => window.lifeLogger.getClueAutomationStatus())).lastSyncAt;
      require(path.join(artifactRoot, 'clues-fixture.cjs')).addSmokeBrowserVisit(dataDir);
      await evaluate(settings => window.lifeLogger.updateActivitySettings({ ...settings, excludedProcesses: ['chrome.exe'] }), autoSettings);
      await waitFor(async lastSync => { const status = await window.lifeLogger.getClueAutomationStatus(); return status.lastSyncAt !== lastSync && !status.syncing; }, firstSync);
      assert.equal((await evaluate(date => window.lifeLogger.searchClues({ date, query: '自动补充测试' }), clues.date)).total, 0, 'excluded browser visits are not imported');
      await evaluate(settings => window.lifeLogger.updateActivitySettings(settings), autoSettings);
      await waitFor(async date => (await window.lifeLogger.searchClues({ date, query: '自动补充测试' })).total === 1, clues.date);
      const autoStatus = await evaluate(() => window.lifeLogger.getClueAutomationStatus()); assert.notEqual(autoStatus.lastSyncAt, firstSync); assert.equal(autoStatus.added, 1);
      const automaticClue = (await evaluate(date => window.lifeLogger.searchClues({ date, query: '自动补充测试' }), clues.date)).clues[0];
      assert.equal(automaticClue.url, 'https://example.com/automation');
      await clickText('活动线索'); await waitFor(() => document.body.textContent.includes('自动补充已开启') && document.body.textContent.includes('最近同步'));
      await shot('clues-automation.png', true);
      await evaluate(settings => window.lifeLogger.updateActivitySettings({ ...settings, nightlySummaryTime: '00:00' }), autoSettings);
      await waitFor(async () => (await window.lifeLogger.searchLogs({})).total === 8);
      const nightly = (await evaluate(() => window.lifeLogger.searchLogs({ query: '自动补充测试' }))).logs[0];
      assert.ok(nightly); assert.ok(nightly.content.includes('同一条时间线')); assert.ok(nightly.content.includes('SQLite'));
      await evaluate(settings => window.lifeLogger.updateActivitySettings({ ...settings, nightlySummaryTime: '00:00' }), autoSettings);
      await waitFor(async () => !(await window.lifeLogger.getClueAutomationStatus()).syncing);
      assert.equal((await evaluate(() => window.lifeLogger.searchLogs({}))).total, 8, 'nightly review saves only once per local day');
      await evaluate(settings => window.lifeLogger.updateActivitySettings({ ...settings, autoBrowserClues: false, nightlySummaryTime: '22:00' }), autoSettings);
      await evaluate(id => window.lifeLogger.deleteLog({ id }), nightly.id);
      await clickText('我的日志'); await waitFor(() => document.querySelectorAll('.log-entry').length === 7);

      // Screenshots use an explicit presentation fixture in the test database only.
      const now = new Date(); const date = (days, hours, minutes) => { const value = new Date(now); value.setDate(value.getDate() - days); value.setHours(hours, minutes, 0, 0); return value.toISOString(); };
      const examples = [
        { content: '把复杂的事情，慢慢做简单。\n今天重新梳理了项目的方向，删掉一些不必要的步骤。比起做得更多，更想把真正重要的事做好。', sourceType: 'manual', createdAt: date(0, 10, 35) },
        { content: '早上绕着公园走了一圈，天气刚刚好。路边的树开始有了秋天的颜色，买了杯咖啡，给自己留了半小时的空白。', sourceType: 'voice', createdAt: date(0, 8, 20) },
        { content: '今天的阅读笔记：专注不只是排除干扰，也是在有限的时间里，清楚地选择自己想做的事。', sourceType: 'manual', createdAt: date(1, 21, 15) },
        { content: '今日前台活动约 3 小时 24 分钟。\n主要集中在：Visual Studio Code（2 小时 10 分钟）、Chrome（54 分钟）、Notion（20 分钟）。', sourceType: 'activity_summary', createdAt: date(1, 18, 0) },
        { content: '和朋友吃了顿晚饭，聊了很多最近的小事。普通的一天，也有值得记住的时刻。', sourceType: 'manual', createdAt: date(2, 20, 40) }
      ];
      fs.writeFileSync(backupPath, JSON.stringify({ format: 'life-logger-backup', version: 1, exportedAt: now.toISOString(), logs: examples }));
      await evaluate(() => window.lifeLogger.importBackup()); await waitFor(() => document.querySelectorAll('.log-entry').length === 5);
      await evaluate(() => document.querySelector('[aria-label="关闭提示"]')?.click());
      await shot('journal.png');
      window.setSize(900, 820); await new Promise(resolve => setTimeout(resolve, 150)); await shot('journal-narrow.png');
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'horizontal overflow');
      window.setMinimumSize(360, 640); window.setSize(390, 820);
      await shot('journal-compact.png', true);
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'compact journal horizontal overflow');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.nav-item')].every(button => button.getAttribute('aria-label') && button.querySelector('span').getBoundingClientRect().height > 0)), true, 'compact navigation keeps visible and accessible labels');
      await clickText('活动线索'); await waitFor(() => Boolean(document.querySelector('.clue-toolbar')));
      await clickText('一天回顾'); await waitFor(() => Boolean(document.querySelector('.review-editor')));
      await shot('daily-review-compact.png', true);
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'compact review horizontal overflow');
      await clickText('设置与备份'); await waitFor(() => Boolean(document.querySelector('.settings-save')));
      await shot('settings-compact.png', true);
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'compact settings horizontal overflow');
      assert.deepEqual(errors, [], 'renderer console errors');
      console.log(JSON.stringify({ result: 'PASS', checks: ['recommended review drafts and manual choice control', 'automatic draft preserves empty drafts and edits during loading', 'automatic browser IPC and worker with synthetic history, exclusions and deduplication', 'nightly complete review with notes and same-day idempotency', 'composer draft save across navigation and subsequent input protection', 'draft storage read and write failures are visible', 'clue drafts survive filtering, navigation and reload, and clear on save or cancel', 'log editing locks during save', 'backup restore preserves concurrent background logs', 'daily review grouping beyond pagination and snapshot safety', 'daily review draft persistence, date isolation and replacement preview', 'daily review Markdown export and backup', 'clue native SQLite migration, retention, note preservation, deduplication', 'synthetic Chromium per-visit capture and URL privacy', 'clue IPC editing, dismissal, save, backup and search', 'clue responsive layout', 'production startup', 'real SQLite CRUD', 'all-source backup restore and recovery snapshot', 'historical search', 'local date grouping', 'renderer search and empty states', 'synthetic microphone and cancellation', 'recording blocks save', 'delayed transcription preserves edits', 'missing model error', 'settings persistence', 'activity and browser views', 'browser summary save', 'delete confirmation', 'responsive overflow'], screenshots: artifactRoot, dataDir }, null, 2));
      clearTimeout(timeout); app.quit();
    })().catch(error => { console.error(error); console.error('Renderer errors:', errors); clearTimeout(timeout); app.exit(1); });
  });
});
require('../dist-electron/main.cjs');
