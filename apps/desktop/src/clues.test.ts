import { describe, expect, it } from 'vitest';
import { sanitizeClueUrl } from '@life-logger/shared';

describe('activity clue URLs', () => {
  it('removes query tokens, fragments and credentials while preserving the document path', () => {
    expect(sanitizeClueUrl('https://user:password@example.com/docs/intro?token=secret#part')).toBe('https://example.com/docs/intro');
  });
  it.each(['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/plain,secret', 'chrome://settings', 'invalid'])('does not retain non-web address %s', value => {
    expect(sanitizeClueUrl(value)).toBe('');
  });
  it('keeps local web addresses and encoded paths without requesting them', () => {
    expect(sanitizeClueUrl('http://localhost:5173/a%20b?key=x')).toBe('http://localhost:5173/a%20b');
  });
});
