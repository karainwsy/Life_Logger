import type { LogEntry, LogSourceType } from '@life-logger/domain';
import { isLogSourceType } from '@life-logger/domain';

export type LifeLoggerBackup = {
  format: 'life-logger-backup';
  version: 1;
  exportedAt: string;
  logs: Array<{
    content: string;
    createdAt: string;
    sourceType: LogSourceType;
  }>;
};

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);

const isBackupLog = (value: unknown): value is LifeLoggerBackup['logs'][number] => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const log = value as Record<string, unknown>;
  return (
    typeof log.content === 'string' &&
    log.content.trim().length > 0 && log.content.length <= 100_000 &&
    isTimestamp(log.createdAt) &&
    isLogSourceType(log.sourceType)
  );
};

export const createBackup = (logs: LogEntry[]): LifeLoggerBackup => ({
  format: 'life-logger-backup',
  version: 1,
  exportedAt: new Date().toISOString(),
  logs: logs.map((log) => ({
    content: log.content,
    createdAt: log.createdAt,
    sourceType: log.sourceType
  }))
});

export const parseBackup = (content: string): LifeLoggerBackup => {
  if (content.length > 50 * 1024 * 1024) throw new Error('备份文件不能超过 50 MB');
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('备份文件格式不正确');
  }

  const backup = parsed as Record<string, unknown>;
  if (backup.format !== 'life-logger-backup' || backup.version !== 1) {
    throw new Error('备份文件不是 Life Logger 支持的版本');
  }

  if (!Array.isArray(backup.logs) || !backup.logs.every(isBackupLog)) {
    throw new Error('备份文件中的日志数据不完整');
  }

  if (!isTimestamp(backup.exportedAt)) {
    throw new Error('备份文件缺少导出时间');
  }

  const valid = backup as LifeLoggerBackup;
  return { ...valid, exportedAt: new Date(valid.exportedAt).toISOString(), logs: valid.logs.map(log => ({
    content: log.content.trim(), createdAt: new Date(log.createdAt).toISOString(), sourceType: log.sourceType
  })) };
};

export const serializeBackup = (logs: LogEntry[]) =>
  JSON.stringify(createBackup(logs), null, 2);
