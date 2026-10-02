import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogRepository } from '@life-logger/storage';
import { captureBrowserVisits } from '@life-logger/capture';
import { localDateKey, dateKeyRange } from '@life-logger/shared';

export const readSmokeBrowserVisits = (input: { start: string; end: string; excludedProcesses: string[] }, folder: string) =>
  captureBrowserVisits(input, { homeDir: path.join(folder, 'synthetic-home'), platform: 'win32' });

export function addSmokeBrowserVisit(folder: string) {
  const history = new Database(path.join(folder, 'synthetic-home/AppData/Local/Google/Chrome/User Data/Default/History'));
  try {
    history.prepare('INSERT INTO urls VALUES (?, ?, ?)').run(4, 'https://example.com/automation?token=private#secret', '自动补充测试：本地整理说明');
    history.prepare('INSERT INTO visits VALUES (?, ?, ?)').run(6, 4, (Date.now() + 11_644_473_600_000) * 1000);
  } finally { history.close(); }
}

export async function testAndSeedClues(dbPath: string, folder: string) {
  const date = localDateKey(new Date());
  const at = (hour: number, minute = 0) => { const value = new Date(dateKeyRange(date).start); value.setHours(hour, minute, 0, 0); return value.toISOString(); };
  const range = dateKeyRange(date);
  // All browser reads are directed to this synthetic home, never the user's profile.
  const homeDir = path.join(folder, 'synthetic-home');
  const profileDir = path.join(homeDir, 'AppData/Local/Google/Chrome/User Data/Default');
  fs.mkdirSync(profileDir, { recursive: true });
  const history = new Database(path.join(profileDir, 'History'));
  history.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);');
  history.prepare('INSERT INTO urls VALUES (?, ?, ?)').run(1, 'https://user:password@example.com/docs/storage?token=private#secret', 'SQLite · 本地数据存储指南');
  history.prepare('INSERT INTO urls VALUES (?, ?, ?)').run(2, 'file:///private.txt', '不应采集');
  history.prepare('INSERT INTO urls VALUES (?, ?, ?)').run(3, 'https://chatgpt.com/c/example?private=1', '讨论 Life Logger 的活动线索设计');
  const insert = history.prepare('INSERT INTO visits VALUES (?, ?, ?)');
  const chromeTime = (iso: string) => (Date.parse(iso) + 11_644_473_600_000) * 1000;
  insert.run(1, 1, chromeTime(at(9, 10))); insert.run(2, 1, chromeTime(at(9, 25)));
  insert.run(3, 2, chromeTime(at(9, 30))); insert.run(4, 3, chromeTime(at(10, 5)));
  insert.run(5, 1, chromeTime(range.end));
  history.close();
  const result = await captureBrowserVisits(range, { homeDir, platform: 'win32' });
  assert.equal(result.visits.length, 3, 'per-visit history, half-open day, web-only URLs');
  assert.equal(result.visits.filter(visit => visit.url === 'https://example.com/docs/storage').length, 2);
  assert.equal(new Set(result.visits.map(visit => visit.key)).size, 3);
  assert.equal(JSON.stringify(result).includes('password'), false); assert.equal(JSON.stringify(result).includes('token='), false);
  assert.equal((await captureBrowserVisits({ ...range, excludedProcesses: ['CHROME.EXE'] }, { homeDir, platform: 'win32' })).visits.length, 0);
  assert.equal((await captureBrowserVisits(range, { homeDir: path.join(folder, 'missing-home'), platform: 'win32' })).warnings.length, 1);
  await assert.rejects(() => captureBrowserVisits({ start: range.start, end: range.start }, { homeDir, platform: 'win32' }));

  const testPath = path.join(folder, 'clue-storage-test.db');
  let repo = createLogRepository(testPath);
  assert.equal(repo.importBrowserVisits(result.visits), 3);
  assert.equal(repo.importBrowserVisits(result.visits), 0);
  const session = repo.openActivitySession({ processName: 'Code', windowTitle: 'Life_Logger — CluesPanel.tsx — Visual Studio Code', startedAt: at(10, 20) });
  repo.closeActivitySession({ id: session.id, endedAt: at(10, 40), durationSeconds: 1200 });
  let clue = repo.searchClues({ date, kind: 'window' }).clues[0];
  repo.updateClue({ id: clue.id, label: '实现活动线索界面', note: '备注含 100%_ 也能准确搜索。' });
  repo.closeActivitySession({ id: session.id, endedAt: at(10, 50), durationSeconds: 1800 });
  clue = repo.searchClues({ date, query: '100%_' }).clues[0];
  assert.equal(clue.note, '备注含 100%_ 也能准确搜索。'); assert.equal(clue.durationSeconds, 1800);
  assert.equal(repo.searchClues({ date, kind: 'browser' }).total, 3);
  repo.updateClue({ id: clue.id, dismissed: true });
  assert.equal(repo.searchClues({ date }).total, 3); assert.equal(repo.searchClues({ date, dismissed: true }).total, 1);
  repo.updateClue({ id: clue.id, dismissed: false });
  const saved = repo.saveClueAsLog({ id: clue.id });
  assert.equal(repo.saveClueAsLog({ id: clue.id }).id, saved.id); assert.match(saved.content, /实现活动线索界面/);
  repo.deleteLog({ id: saved.id });
  assert.equal(repo.searchClues({ date, kind: 'window' }).clues[0].savedLogId, null);
  const savedAgain = repo.saveClueAsLog({ id: clue.id }); assert.notEqual(savedAgain.id, saved.id);
  repo.replaceAllLogs([{ content: '恢复后的日志', createdAt: at(8), sourceType: 'manual' }]);
  assert.equal(repo.searchClues({ date, kind: 'window' }).clues[0].savedLogId, null);
  assert.equal(repo.searchClues({ date, query: '100%_' }).total, 1);
  assert.throws(() => repo.updateClue({ id: clue.id, note: 'x'.repeat(5001) }));
  assert.throws(() => repo.searchClues({ date: '2026-02-30' }));
  assert.throws(() => repo.saveClueAsLog({ id: -1 }));
  // A session ending exactly at midnight belongs only to the preceding day.
  const boundary = repo.openActivitySession({ processName: 'Code', windowTitle: '午夜前的窗口', startedAt: new Date(Date.parse(range.start) - 60_000).toISOString() });
  repo.closeActivitySession({ id: boundary.id, endedAt: range.start, durationSeconds: 60 });
  assert.equal(repo.searchClues({ date, query: '午夜前' }).total, 0);
  repo.importBrowserVisits(Array.from({ length: 35 }, (_, index) => ({ ...result.visits[0], key: `pagination-${index}` })));
  const firstPage = repo.searchClues({ date }); const nextPage = repo.searchClues({ date, offset: 30 });
  assert.equal(firstPage.total, 39); assert.equal(firstPage.clues.length, 30); assert.equal(nextPage.clues.length, 9);
  assert.equal(new Set([...firstPage.clues, ...nextPage.clues].map(row => row.id)).size, 39);
  const review = repo.getDailyReview({ date });
  assert.equal(review.clueCount, 39, 'daily review reads beyond the first page');
  assert.equal(review.visitCount, 38);
  assert.equal(review.groups.length, 3);
  const reviewInput = { date, content: `# ${date} · 一天回顾\n\n我的备注：准备复核。` };
  const reviewLog = repo.saveDailyReview(reviewInput);
  assert.equal(repo.saveDailyReview(reviewInput).id, reviewLog.id, 'saving is idempotent');
  const revised = repo.saveDailyReview({ ...reviewInput, content: reviewInput.content + '\n复核已完成。' });
  assert.notEqual(revised.id, reviewLog.id, 'revisions create snapshots');
  repo.updateLog({ id: reviewLog.id, content: '用户直接修改了日志' });
  const afterEdit = repo.saveDailyReview(reviewInput);
  assert.notEqual(afterEdit.id, reviewLog.id, 'never overwrite direct edits');
  repo.deleteLog({ id: afterEdit.id });
  assert.notEqual(repo.saveDailyReview(reviewInput).id, afterEdit.id, 'deleted snapshots can be recreated');
  assert.throws(() => repo.saveDailyReview({ date, content: ' ' }));
  assert.throws(() => repo.saveDailyReview({ date, content: 'x'.repeat(100001) }));
  repo.replaceAllLogs([]);
  assert.equal(repo.getAllLogs().length, 0);
  repo.saveDailyReview(reviewInput);
  assert.equal(repo.getAllLogs().length, 1, 'restore clears stale review associations');
  repo.pruneActivitySessions(range.end);
  assert.equal(repo.searchClues({ date }).total, 1, 'retention preserves personal annotations');
  repo.close(); repo = createLogRepository(testPath);
  assert.equal(repo.searchClues({ date }).total, 1, 'restart preserves annotations without resurrecting pruned clues');
  repo.close();
  // Backfill an existing installation that already has activity sessions.
  const legacyPath = path.join(folder, 'legacy.db');
  let legacy = createLogRepository(legacyPath); legacy.openActivitySession({ processName: 'Code', windowTitle: '旧活动标题', startedAt: at(8) }); legacy.close();
  const legacyDb = new Database(legacyPath); legacyDb.exec('DROP TABLE activity_clues'); legacyDb.close();
  legacy = createLogRepository(legacyPath); assert.equal(legacy.searchClues({ date }).clues[0].title, '旧活动标题'); legacy.close();

  // Seed the live smoke-test database for actual IPC/UI editing and presentation.
  const live = createLogRepository(dbPath);
  live.importBrowserVisits(result.visits);
  const addWindow = (processName: string, windowTitle: string, start: string, end: string) => {
    const session = live.openActivitySession({ processName, windowTitle, startedAt: start });
    live.closeActivitySession({ id: session.id, endedAt: end, durationSeconds: Math.round((Date.parse(end) - Date.parse(start)) / 1000) });
  };
  addWindow('Code', 'CluesPanel.tsx — Life_Logger — Visual Studio Code', at(10, 20), at(10, 50));
  addWindow('WINWORD', '产品设计笔记.docx — Word', at(9, 40), at(10));
  const first = live.searchClues({ date, kind: 'window' }).clues[0];
  live.close();
  return { date, firstId: first.id, browserResult: result };
}
