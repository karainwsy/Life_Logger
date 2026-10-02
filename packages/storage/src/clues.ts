import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { DailyReview, SaveDailyReviewInput } from '@life-logger/domain';
import type { ActivityClue, ActivitySession, BrowserVisit, LogEntry, SearchCluesInput, SearchCluesResult, UpdateClueInput } from '@life-logger/domain';
import { buildDailyReview, dateKeyRange, sanitizeClueUrl } from '@life-logger/shared';

export type ClueRepository = {
  getDailyReview(input: { date: string }): DailyReview;
  saveDailyReview(input: SaveDailyReviewInput): LogEntry;
  searchClues(input: SearchCluesInput): SearchCluesResult;
  updateClue(input: UpdateClueInput): ActivityClue;
  importBrowserVisits(visits: BrowserVisit[]): number;
  saveClueAsLog(input: { id: number }): LogEntry;
};
const columns = `id, kind, title, process_name AS processName, url, browser, profile,
  started_at AS startedAt, ended_at AS endedAt, duration_seconds AS durationSeconds,
  label, note, dismissed, saved_log_id AS savedLogId`;
const map = (row: ActivityClue): ActivityClue => ({ ...row, dismissed: Boolean(row.dismissed) });

export function createClueRepository(db: Database.Database, onChanged: () => void) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_clues (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, title TEXT NOT NULL, process_name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', dismissed INTEGER NOT NULL DEFAULT 0,
    saved_log_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_clues_time ON activity_clues(started_at);
  CREATE TABLE IF NOT EXISTS daily_review_saves (date TEXT NOT NULL, content_hash TEXT NOT NULL, log_id INTEGER NOT NULL, PRIMARY KEY (date, content_hash));
  INSERT OR IGNORE INTO activity_clues (source_key, kind, title, process_name, started_at, ended_at, duration_seconds)
  SELECT 'window:' || id, 'window', window_title, process_name, started_at, ended_at, duration_seconds FROM activity_sessions;`);
  const get = (id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('线索编号无效');
    const row = db.prepare(`SELECT ${columns} FROM activity_clues WHERE id = ?`).get(id) as ActivityClue | undefined;
    if (!row) throw new Error('线索已不存在，请刷新列表');
    return map(row);
  };
  const syncWindow = (session: ActivitySession) => {
    db.prepare(`INSERT INTO activity_clues (source_key, kind, title, process_name, started_at, ended_at, duration_seconds)
      VALUES (?, 'window', ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET title=excluded.title, ended_at=excluded.ended_at, duration_seconds=excluded.duration_seconds`)
      .run(`window:${session.id}`, session.windowTitle, session.processName, session.startedAt, session.endedAt, session.durationSeconds);
  };
  const repository: ClueRepository = {
    getDailyReview(input) {
      const range = dateKeyRange(input?.date);
      const rows = db.prepare(`SELECT ${columns} FROM activity_clues WHERE dismissed = 0 AND started_at < ? AND (ended_at > ? OR started_at >= ?)`)
        .all(range.end, range.start, range.start) as ActivityClue[];
      return buildDailyReview(input.date, rows.map(map));
    },
    saveDailyReview(input) {
      dateKeyRange(input?.date);
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100_000) throw new Error('回顾内容不能为空，且不能超过 10 万字');
      const content = input.content.trim();
      const hash = createHash('sha256').update(content).digest('hex');
      const result = db.transaction(() => {
        const saved = db.prepare(`SELECT logs.id, logs.content, logs.created_at AS createdAt, logs.source_type AS sourceType
          FROM daily_review_saves INNER JOIN logs ON logs.id = daily_review_saves.log_id WHERE date = ? AND content_hash = ?`).get(input.date, hash) as LogEntry | undefined;
        if (saved && saved.content === content) return saved;
        const createdAt = new Date().toISOString();
        const insert = db.prepare("INSERT INTO logs (content, created_at, source_type) VALUES (?, ?, 'activity_summary')").run(content, createdAt);
        const id = Number(insert.lastInsertRowid);
        db.prepare(`INSERT INTO daily_review_saves (date, content_hash, log_id) VALUES (?, ?, ?)
          ON CONFLICT(date, content_hash) DO UPDATE SET log_id = excluded.log_id`).run(input.date, hash, id);
        return { id, content, createdAt, sourceType: 'activity_summary' as const };
      })();
      onChanged();
      return result;
    },
    searchClues(input) {
      const range = dateKeyRange(input?.date);
      const conditions = ['started_at < ?', '(ended_at > ? OR started_at >= ?)', 'dismissed = ?'];
      const values: (string | number)[] = [range.end, range.start, range.start, input.dismissed === true ? 1 : 0];
      if (input.kind) {
        if (!['window', 'browser'].includes(input.kind)) throw new Error('线索来源无效');
        conditions.push('kind = ?'); values.push(input.kind);
      }
      if (input.query) {
        if (typeof input.query !== 'string') throw new Error('搜索内容无效');
        conditions.push("(title || ' ' || label || ' ' || note || ' ' || url || ' ' || process_name || ' ' || browser) LIKE ? ESCAPE '\\'");
        values.push(`%${input.query.slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`);
      }
      const where = conditions.join(' AND ');
      const total = (db.prepare(`SELECT COUNT(*) AS total FROM activity_clues WHERE ${where}`).get(...values) as { total: number }).total;
      const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;
      const rows = db.prepare(`SELECT ${columns} FROM activity_clues WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT 30 OFFSET ?`).all(...values, offset) as ActivityClue[];
      return { clues: rows.map(map), total };
    },
    updateClue(input) {
      const current = get(input?.id);
      if ((input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 200)) ||
          (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 5000)) ||
          (input.dismissed !== undefined && typeof input.dismissed !== 'boolean')) throw new Error('线索标题或备注无效');
      db.prepare('UPDATE activity_clues SET label = ?, note = ?, dismissed = ? WHERE id = ?')
        .run(input.label?.trim() ?? current.label, input.note?.trim() ?? current.note, Number(input.dismissed ?? current.dismissed), current.id);
      return get(current.id);
    },
    importBrowserVisits(visits) {
      const insert = db.prepare(`INSERT OR IGNORE INTO activity_clues
        (source_key, kind, title, url, browser, profile, started_at, ended_at) VALUES (?, 'browser', ?, ?, ?, ?, ?, ?)`);
      return db.transaction(() => {
        let added = 0;
        for (const visit of visits) {
          const url = sanitizeClueUrl(visit.url);
          if (!url || !Number.isFinite(Date.parse(visit.visitedAt))) continue;
          const at = new Date(visit.visitedAt).toISOString();
          added += insert.run(`browser:${visit.key}`, visit.title.trim().slice(0, 2000) || url,
            url, visit.browser, visit.profile, at, at).changes;
        }
        return added;
      })();
    },
    saveClueAsLog(input) {
      const result = db.transaction(() => {
        const clue = get(input?.id);
        if (clue.savedLogId) {
          const saved = db.prepare('SELECT id, content, created_at AS createdAt, source_type AS sourceType FROM logs WHERE id = ?').get(clue.savedLogId) as LogEntry | undefined;
          if (saved) return saved;
        }
        const when = new Date(clue.startedAt).toLocaleString('zh-CN', { hour12: false });
        const title = clue.title || '未记录窗口标题';
        const evidence = clue.kind === 'window'
          ? `前台窗口：${clue.processName} · ${title}\n时间：${when} 至 ${new Date(clue.endedAt).toLocaleString('zh-CN', { hour12: false })}\n采样估计：${clue.durationSeconds} 秒（不代表完成任务）`
          : `网页访问：${title}\n访问时间：${when}\n来源：${clue.browser} / ${clue.profile}\n网址：${clue.url}\n这是访问记录，不代表阅读时长；标题为补充线索时浏览器保存的标题。`;
        const content = `${clue.label || '活动线索'}\n\n${clue.note ? `我的备注：${clue.note}\n\n` : ''}记录依据\n${evidence}`;
        const createdAt = new Date().toISOString();
        const inserted = db.prepare("INSERT INTO logs (content, created_at, source_type) VALUES (?, ?, 'activity_summary')").run(content, createdAt);
        const id = Number(inserted.lastInsertRowid);
        db.prepare('UPDATE activity_clues SET saved_log_id = ? WHERE id = ?').run(id, clue.id);
        return { id, content, createdAt, sourceType: 'activity_summary' as const };
      })();
      onChanged();
      return result;
    }
  };
  return { repository, syncWindow };
}
