const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

// Run only against the smoke test's isolated database.
exports.testRestoreWithConcurrentLog = async ({ dbPath, restore }) => {
  const originalAsyncWrite = fs.promises.writeFile;
  const originalSyncWrite = fs.writeFileSync;
  const content = `恢复期间的自动摘要 ${randomUUID()}`;
  let queued = false;
  let insertionError;
  const queueBackgroundLog = file => {
    if (!path.basename(String(file)).startsWith('before-restore-')) return;
    queued = true;
    queueMicrotask(() => {
      let db;
      try {
        db = new Database(dbPath);
        db.prepare("INSERT INTO logs (content, created_at, source_type) VALUES (?, ?, 'activity_summary')")
          .run(content, new Date().toISOString());
      } catch (error) { insertionError = error; }
      finally { db?.close(); }
    });
  };
  fs.promises.writeFile = (...args) => { queueBackgroundLog(args[0]); return originalAsyncWrite(...args); };
  fs.writeFileSync = (...args) => { queueBackgroundLog(args[0]); return originalSyncWrite(...args); };
  let db;
  try {
    const result = await restore();
    assert.equal(queued, true, 'the recovery snapshot scheduled a concurrent log');
    if (insertionError) throw insertionError;
    const snapshot = JSON.parse(fs.readFileSync(result.snapshotPath, 'utf8'));
    db = new Database(dbPath);
    const current = db.prepare('SELECT content FROM logs WHERE content = ?').get(content);
    assert.ok(current || snapshot.logs.some(log => log.content === content),
      'a background log must survive in the current database or the recovery snapshot');
    return result;
  } finally {
    fs.promises.writeFile = originalAsyncWrite;
    fs.writeFileSync = originalSyncWrite;
    if (db) { db.prepare('DELETE FROM logs WHERE content = ?').run(content); db.close(); }
  }
};
