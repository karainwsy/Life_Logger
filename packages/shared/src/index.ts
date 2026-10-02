export const appName = 'Life Logger';
export { buildDailyReview, composeDailyReview, recommendDailyReviewGroup } from './daily-review';

/** Keep only a web address's origin and path; never persist credentials or query tokens. */
export const sanitizeClueUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
};

export const localDateKey = (value: Date | string) => {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const dateKeyRange = (key: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式不正确');
  const date = new Date(`${key}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || localDateKey(date) !== key) throw new Error('日期无效');
  return { start: startOfDayIso(date), end: addDaysIso(date, 1) };
};

export const startOfDayIso = (date: Date) => {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
};

export const addDaysIso = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next.toISOString();
};
