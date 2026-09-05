import { describe, expect, it } from 'vitest';
import { addDaysIso, appName, startOfDayIso } from '@life-logger/shared';

describe('shared exports', () => {
  it('exports the desktop app name', () => {
    expect(appName).toBe('Life Logger');
  });

  it('creates start-of-day iso values', () => {
    const iso = startOfDayIso(new Date('2026-05-02T15:30:00.000Z'));
    const date = new Date(iso);

    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
    expect(date.getMilliseconds()).toBe(0);
  });

  it('creates next-day iso values', () => {
    const base = new Date('2026-05-02T15:30:00.000Z');
    const start = new Date(startOfDayIso(base));
    const next = new Date(addDaysIso(base, 1));

    expect(next.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });
});
