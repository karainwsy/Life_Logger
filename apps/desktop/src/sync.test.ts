import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@life-logger/domain';
import { createBackup, parseBackup, serializeBackup } from '@life-logger/sync';

const logs: LogEntry[] = [
  {
    id: 1,
    content: '今天完成了一个功能',
    createdAt: '2026-05-02T08:30:00.000Z',
    sourceType: 'manual'
  },
  {
    id: 2,
    content: '语音输入测试',
    createdAt: '2026-05-02T09:30:00.000Z',
    sourceType: 'voice'
  }
];

describe('sync backup helpers', () => {
  it('serializes logs without exposing internal ids', () => {
    const content = serializeBackup(logs);
    const parsed = JSON.parse(content) as ReturnType<typeof createBackup>;

    expect(parsed.format).toBe('life-logger-backup');
    expect(parsed.version).toBe(1);
    expect(parsed.logs).toHaveLength(2);
    expect(parsed.logs[0]).not.toHaveProperty('id');
    expect(parsed.logs[0].sourceType).toBe('manual');
  });

  it('parses a valid backup file', () => {
    const backup = parseBackup(serializeBackup(logs));

    expect(backup.logs).toHaveLength(2);
    expect(backup.logs[1].content).toBe('语音输入测试');
  });

  it('rejects unsupported backup content', () => {
    expect(() => parseBackup('{"format":"other","version":1,"logs":[]}')).toThrow();
    expect(() => parseBackup('not-json')).toThrow();
  });
});
