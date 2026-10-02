import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createClueRepository, type ClueRepository } from './clues';
import { isLogSourceType } from '@life-logger/domain';
import { dateKeyRange } from '@life-logger/shared';
import type {
  ActivityRange,
  ActivitySession,
  CreateLogInput,
  DeleteLogInput,
  LogDateRange,
  LogEntry,
  LogSourceType,
  UpdateLogInput
} from '@life-logger/domain';
import type { SearchLogsInput, SearchLogsResult } from '@life-logger/domain';

export type LogRepository = ClueRepository & {
  close(): void;
  searchLogs(input: SearchLogsInput): SearchLogsResult;
  pruneActivitySessions(before: string): void;
  createLog(input: CreateLogInput): LogEntry;
  getLogsByDateRange(range: LogDateRange): LogEntry[];
  getAllLogs(): LogEntry[];
  openActivitySession(input: {
    processName: string;
    windowTitle: string;
    startedAt: string;
  }): ActivitySession;
  closeActivitySession(input: {
    id: number;
    endedAt: string;
    durationSeconds: number;
  }): ActivitySession | null;
  getActivitySessionsByRange(range: ActivityRange): ActivitySession[];
  updateLog(input: UpdateLogInput): LogEntry | null;
  deleteLog(input: DeleteLogInput): boolean;
  replaceAllLogs(
    logs: Array<{ content: string; createdAt: string; sourceType: LogSourceType }>
  ): number;
};

type LogRow = {
  id: number;
  content: string;
  created_at: string;
  source_type: LogEntry['sourceType'];
};

type ActivityRow = {
  id: number;
  process_name: string;
  window_title: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
};

const mapRowToLogEntry = (row: LogRow): LogEntry => ({
  id: row.id,
  content: row.content,
  createdAt: row.created_at,
  sourceType: row.source_type
});

const mapRowToActivitySession = (row: ActivityRow): ActivitySession => ({
  id: row.id,
  processName: row.process_name,
  windowTitle: row.window_title,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  durationSeconds: row.duration_seconds
});

export const createLogRepository = (dbFilePath: string, onChanged: () => void = () => {}): LogRepository => {
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });

  const db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);

    CREATE TABLE IF NOT EXISTS activity_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_name TEXT NOT NULL,
      window_title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_activity_sessions_started_at
      ON activity_sessions(started_at);
  `);

  const createStatement = db.prepare<[string, string, LogEntry['sourceType']]>(`
    INSERT INTO logs (content, created_at, source_type)
    VALUES (?, ?, ?)
  `);

  const getByIdStatement = db.prepare<[number], LogRow>(`
    SELECT id, content, created_at, source_type
    FROM logs
    WHERE id = ?
  `);

  const getByDateRangeStatement = db.prepare<[string, string], LogRow>(`
    SELECT id, content, created_at, source_type
    FROM logs
    WHERE created_at >= ? AND created_at < ?
    ORDER BY created_at ASC, id ASC
  `);

  const getAllStatement = db.prepare<[], LogRow>(`
    SELECT id, content, created_at, source_type
    FROM logs
    ORDER BY created_at ASC, id ASC
  `);

  const updateStatement = db.prepare<[string, number]>(`
    UPDATE logs
    SET content = ?
    WHERE id = ?
  `);

  const deleteStatement = db.prepare<[number]>(`
    DELETE FROM logs
    WHERE id = ?
  `);

  const insertImportedStatement = db.prepare<[string, string, LogEntry['sourceType']]>(`
    INSERT INTO logs (content, created_at, source_type)
    VALUES (?, ?, ?)
  `);

  const deleteAllStatement = db.prepare(`
    DELETE FROM logs
  `);

  const getActivityByIdStatement = db.prepare<[number], ActivityRow>(`
    SELECT id, process_name, window_title, started_at, ended_at, duration_seconds
    FROM activity_sessions
    WHERE id = ?
  `);

  const openActivityStatement = db.prepare<[string, string, string, string]>(`
    INSERT INTO activity_sessions (process_name, window_title, started_at, ended_at)
    VALUES (?, ?, ?, ?)
  `);

  const closeActivityStatement = db.prepare<[string, number, number]>(`
    UPDATE activity_sessions
    SET ended_at = ?, duration_seconds = ?
    WHERE id = ?
  `);

  const getActivityByRangeStatement = db.prepare<[string, string], ActivityRow>(`
    SELECT id, process_name, window_title, started_at, ended_at, duration_seconds
    FROM activity_sessions
    WHERE started_at < ? AND ended_at >= ?
    ORDER BY started_at ASC, id ASC
  `);

  const clues = createClueRepository(db, onChanged);
  return {
    ...clues.repository,
    close() { db.close(); },
    pruneActivitySessions(before) {
      db.transaction(() => {
        db.prepare('DELETE FROM activity_sessions WHERE ended_at < ?').run(before);
        db.prepare("DELETE FROM activity_clues WHERE ended_at < ? AND label = '' AND note = ''").run(before);
      })();
    },
    searchLogs(input = {}) {
      const conditions: string[] = [];
      const values: (string | number)[] = [];
      if (input.query) {
        conditions.push("content LIKE ? ESCAPE '\\'");
        values.push(`%${input.query.slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`);
      }
      if (input.date) {
        const range = dateKeyRange(input.date);
        conditions.push('created_at >= ? AND created_at < ?');
        values.push(range.start, range.end);
      }
      if (input.sourceType) {
        if (!isLogSourceType(input.sourceType)) throw new Error('日志来源无效');
        conditions.push('source_type = ?'); values.push(input.sourceType);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) AS total FROM logs ${where}`).get(...values) as { total: number }).total;
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Math.floor(input.limit!))) : 30;
      const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;
      const rows = db.prepare(`SELECT id, content, created_at, source_type FROM logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as LogRow[];
      return { logs: rows.map(mapRowToLogEntry), total };
    },
    createLog(input) {
      if (typeof input?.content !== 'string' || input.content.length > 100_000) throw new Error('日志内容无效或超过 10 万字');
      const content = input.content.trim();

      if (!content) {
        throw new Error('日志内容不能为空');
      }

      const createdAt = new Date().toISOString();
      const sourceType = input.sourceType ?? 'manual';
      if (!isLogSourceType(sourceType)) throw new Error('日志来源无效');
      const result = createStatement.run(content, createdAt, sourceType);
      const row = getByIdStatement.get(Number(result.lastInsertRowid));

      if (!row) {
        throw new Error('创建日志失败');
      }

      onChanged();
      return mapRowToLogEntry(row);
    },

    getLogsByDateRange(range) {
      return getByDateRangeStatement
        .all(range.start, range.end)
        .map(mapRowToLogEntry);
    },

    getAllLogs() {
      return getAllStatement.all().map(mapRowToLogEntry);
    },

    openActivitySession(input) {
      const processName = input.processName.trim() || '未知应用';
      const windowTitle = input.windowTitle.trim();
      const result = openActivityStatement.run(
        processName,
        windowTitle,
        input.startedAt,
        input.startedAt
      );
      const row = getActivityByIdStatement.get(Number(result.lastInsertRowid));

      if (!row) {
        throw new Error('创建活动会话失败');
      }

      const session = mapRowToActivitySession(row);
      clues.syncWindow(session);
      return session;
    },

    closeActivitySession(input) {
      const result = closeActivityStatement.run(
        input.endedAt,
        Math.max(0, input.durationSeconds),
        input.id
      );
      if (result.changes === 0) {
        return null;
      }

      const row = getActivityByIdStatement.get(input.id);
      if (row) clues.syncWindow(mapRowToActivitySession(row));
      return row ? mapRowToActivitySession(row) : null;
    },

    getActivitySessionsByRange(range) {
      return getActivityByRangeStatement
        .all(range.end, range.start)
        .map(mapRowToActivitySession);
    },

    updateLog(input) {
      if (typeof input?.content !== 'string' || input.content.length > 100_000 || !Number.isSafeInteger(input.id)) throw new Error('日志参数无效');
      const content = input.content.trim();

      if (!content) {
        throw new Error('日志内容不能为空');
      }

      const result = updateStatement.run(content, input.id);
      if (result.changes === 0) {
        return null;
      }

      const row = getByIdStatement.get(input.id);
      onChanged();
      return row ? mapRowToLogEntry(row) : null;
    },

    deleteLog(input) {
      if (!Number.isSafeInteger(input?.id)) throw new Error('日志编号无效');
      const result = deleteStatement.run(input.id);
      if (result.changes) db.prepare('UPDATE activity_clues SET saved_log_id = NULL WHERE saved_log_id = ?').run(input.id);
      if (result.changes) db.prepare('DELETE FROM daily_review_saves WHERE log_id = ?').run(input.id);
      if (result.changes) onChanged();
      return result.changes > 0;
    },

    replaceAllLogs(logs) {
      const replaceAll = db.transaction(
        (items: Array<{ content: string; createdAt: string; sourceType: LogSourceType }>) => {
        deleteAllStatement.run();
        db.prepare('UPDATE activity_clues SET saved_log_id = NULL').run();
        db.prepare('DELETE FROM daily_review_saves').run();

        for (const item of items) {
          const content = item.content.trim();
          if (!content) {
            throw new Error('备份中存在空日志');
          }

          insertImportedStatement.run(
            content,
            item.createdAt,
            item.sourceType
          );
        }
      });

      replaceAll(logs);
      onChanged();
      return getAllStatement.all().length;
    }
  };
};
