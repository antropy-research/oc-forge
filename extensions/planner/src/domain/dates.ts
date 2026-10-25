// Date-only arithmetic. A DateKey is a local calendar day, so all math runs on
// UTC midnights of that day and never touches a wall-clock offset or DST.
import type { DateKey } from './types.ts';

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isDateKey = (value: unknown): value is DateKey => {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
};

const toUtc = (key: DateKey): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};

const fromUtc = (date: Date): DateKey => date.toISOString().slice(0, 10);

/** Today's date in `timeZone` at instant `now`. */
export const todayIn = (timeZone: string, now: Date = new Date()): DateKey =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const isValidTimeZone = (timeZone: unknown): timeZone is string => {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

export const addDays = (key: DateKey, days: number): DateKey => {
  const date = toUtc(key);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
};

/** Whole days from `a` to `b` (positive when `b` is later). */
export const daysBetween = (a: DateKey, b: DateKey): number => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (key: DateKey): number => toUtc(key).getUTCDay();

/** First day of the week containing `key`. */
export const startOfWeek = (key: DateKey, weekStartsOn: 0 | 1): DateKey => {
  const offset = (weekday(key) - weekStartsOn + 7) % 7;
  return addDays(key, -offset);
};

/** The next date strictly after `from` that falls on `day` (0 = Sunday). */
export const nextWeekday = (from: DateKey, day: number): DateKey => {
  const delta = ((day - weekday(from) + 7) % 7) || 7;
  return addDays(from, delta);
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const weekdayName = (key: DateKey): string => WEEKDAY_NAMES[weekday(key)]!;

/** "October 24" */
export const monthDay = (key: DateKey): string => {
  const date = toUtc(key);
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
};

export const monthIndex = (name: string): number => {
  const lower = name.toLowerCase();
  return MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(lower.slice(0, 3)));
};

/** Minutes as Sunsama shows them: `0:30`, `1:15`. */
export const formatMinutes = (minutes: number | null | undefined): string => {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
