import { describe, expect, it } from 'vitest';
import { LOG_SOURCE_TYPES } from '@life-logger/domain';
import { parseBackup, serializeBackup } from '@life-logger/sync';
import { dateKeyRange, localDateKey } from '@life-logger/shared';
import { downsampleBuffer, encodeWav } from './audio/recorder';
describe('data integrity regressions', () => {
  it.each(LOG_SOURCE_TYPES)('round-trips %s logs', sourceType => {
    const logs = [{ id: 1, content: '完整备份', sourceType, createdAt: '2026-09-05T00:00:00.000Z' }];
    expect(parseBackup(serializeBackup(logs)).logs[0]).toEqual({ content: logs[0].content, sourceType, createdAt: logs[0].createdAt });
  });
  it.each(['not-a-date', '2026-02-30T00:00:00Z', '2026-09-05', ''])('rejects invalid backup dates: %s', createdAt => {
    expect(() => parseBackup(serializeBackup([{ id: 1, content: 'test', sourceType: 'manual', createdAt }]))).toThrow();
  });
  it('rejects whitespace-only logs before a destructive restore', () => {
    expect(() => parseBackup(serializeBackup([{ id: 1, content: '  ', sourceType: 'manual', createdAt: new Date().toISOString() }]))).toThrow();
  });
  it('normalizes imported timezone offsets', () => {
    const backup = parseBackup(serializeBackup([{ id: 1, content: 'test', sourceType: 'manual', createdAt: '2026-09-05T01:00:00+08:00' }]));
    expect(backup.logs[0].createdAt).toBe('2026-09-04T17:00:00.000Z');
  });
  it('groups early morning entries by local calendar date', () => {
    const local = new Date(2026, 8, 5, 1, 0);
    expect(localDateKey(local.toISOString())).toBe('2026-09-05');
    const range = dateKeyRange('2026-09-05'); expect(local.toISOString() >= range.start && local.toISOString() < range.end).toBe(true);
  });
  it('rejects normalized invalid calendar dates', () => { expect(() => dateKeyRange('2026-02-30')).toThrow(); });
});
describe('audio encoding', () => {
  it('encodes mono PCM with a correct WAV header and clipping', () => {
    const buffer = encodeWav(new Float32Array([-2, 0, 2])); const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(50); expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768); expect(view.getInt16(48, true)).toBe(32767);
  });
  it('preserves duration when converting 48 kHz samples', () => {
    expect(downsampleBuffer(new Float32Array(48000).fill(0.5), 48000)).toEqual(new Float32Array(16000).fill(0.5));
  });
});
