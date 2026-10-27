// Google Calendar's views as data: which days Day, Week, Month and Schedule
// show, their titles, how the arrows step, and where events go in a month row
// (bars in the first free line, then "N more") and in the schedule list.
import type { DateKey } from './types.ts';
import { addDays, daysBetween, startOfWeek, weekday, zonedDateMinutes } from './dates.ts';

export type CalendarMode = 'day' | 'week' | 'month' | 'year' | 'schedule';
export const CALENDAR_MODES: readonly CalendarMode[] = ['day', 'week', 'month', 'year', 'schedule'];
/** How many days the Schedule view lists from its first day. */
export const SCHEDULE_DAYS = 30;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parts = (key: DateKey) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8)) });
const keyOf = (year: number, month: number, day: number): DateKey => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export const daysInMonth = (key: DateKey): number => {
  const { year, month } = parts(key);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

export const monthStart = (key: DateKey): DateKey => `${key.slice(0, 8)}01`;

/** The same day `n` months later, or the month's last day when it is shorter. */
export const addMonths = (key: DateKey, n: number): DateKey => {
  const { year, month, day } = parts(key);
  const index = year * 12 + (month - 1) + n;
  const first = keyOf(Math.floor(index / 12), (index % 12) + 1, 1);
  return keyOf(Math.floor(index / 12), (index % 12) + 1, Math.min(day, daysInMonth(first)));
};

/** The weeks of the month around `anchor`, whole weeks as a month grid draws them (four to six). */
export const monthWeeks = (anchor: DateKey, weekStartsOn: 0 | 1): DateKey[][] => {
  const first = monthStart(anchor);
  const last = keyOf(parts(first).year, parts(first).month, daysInMonth(first));
  const weeks: DateKey[][] = [];
  for (let week = startOfWeek(first, weekStartsOn); week <= last; week = addDays(week, 7)) weeks.push(Array.from({ length: 7 }, (_, index) => addDays(week, index)));
  return weeks;
};

const isWeekend = (key: DateKey): boolean => weekday(key) === 0 || weekday(key) === 6;

/** The days a view shows around `anchor`; without weekends, Saturdays and Sundays are left out of Week and Month. */
export const viewDays = (mode: CalendarMode, anchor: DateKey, weekStartsOn: 0 | 1, weekends = true): DateKey[] => {
  switch (mode) {
    case 'day':
      return [anchor];
    case 'week': {
      const days = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor, weekStartsOn), index));
      return weekends ? days : days.filter((day) => !isWeekend(day));
    }
    case 'month':
      return monthWeeks(anchor, weekStartsOn).flat().filter((day) => weekends || !isWeekend(day));
    case 'year': {
      const first = `${anchor.slice(0, 4)}-01-01` as DateKey;
      return Array.from({ length: daysBetween(first, `${Number(anchor.slice(0, 4)) + 1}-01-01` as DateKey) }, (_, index) => addDays(first, index));
    }
    case 'schedule':
      return Array.from({ length: SCHEDULE_DAYS }, (_, index) => addDays(anchor, index));
  }
};

/** Where the arrows go: a day, a week, a month, or the next stretch of the schedule. */
export const stepAnchor = (mode: CalendarMode, anchor: DateKey, direction: 1 | -1): DateKey => {
  switch (mode) {
    case 'day':
      return addDays(anchor, direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'month':
      return addMonths(anchor, direction);
    case 'year':
      return addMonths(anchor, 12 * direction);
    case 'schedule':
      return addDays(anchor, SCHEDULE_DAYS * direction);
  }
};

/** The header title, as Google Calendar writes it: "October 2026", "Oct – Nov 2026", "October 26, 2026". */
export const rangeTitle = (mode: CalendarMode, anchor: DateKey, days: readonly DateKey[]): string => {
  const { year, month, day } = parts(anchor);
  if (mode === 'day') return `${MONTHS[month - 1]} ${day}, ${year}`;
  if (mode === 'month') return `${MONTHS[month - 1]} ${year}`;
  if (mode === 'year') return String(year);
  const first = parts(days[0] ?? anchor);
  const last = parts(days[days.length - 1] ?? anchor);
  if (mode === 'schedule') {
    return first.year === last.year
      ? `${SHORT[first.month - 1]} ${first.day} – ${SHORT[last.month - 1]} ${last.day}, ${last.year}`
      : `${SHORT[first.month - 1]} ${first.day}, ${first.year} – ${SHORT[last.month - 1]} ${last.day}, ${last.year}`;
  }
  if (first.year !== last.year) return `${SHORT[first.month - 1]} ${first.year} – ${SHORT[last.month - 1]} ${last.year}`;
  if (first.month !== last.month) return `${SHORT[first.month - 1]} – ${SHORT[last.month - 1]} ${last.year}`;
  return `${MONTHS[first.month - 1]} ${first.year}`;
};

/** "Monday, October 26" */
export const longDay = (key: DateKey): string => `${WEEKDAYS[weekday(key)]}, ${MONTHS[parts(key).month - 1]} ${parts(key).day}`;
/** "MON" */
export const weekdayShort = (key: DateKey): string => WEEKDAYS[weekday(key)]!.slice(0, 3).toUpperCase();
/** "Oct 26" */
export const shortDay = (key: DateKey): string => `${SHORT[parts(key).month - 1]} ${parts(key).day}`;

/** Google's compact clock: "9am", "9:30am", "12pm". */
export const compactClock = (minutes: number): string => {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour < 12 ? 'am' : 'pm';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute ? `${h}:${String(minute).padStart(2, '0')}${suffix}` : `${h}${suffix}`;
};

/** Google's time range: "9 – 10am", "9:30 – 11am", "11am – 12:30pm". */
export const compactRange = (start: number, end: number): string => {
  const a = compactClock(start);
  const b = compactClock(end);
  const sameHalf = (start < 720) === (((end % 1440) + 1440) % 1440 < 720) && end - start < 720;
  return sameHalf ? `${a.replace(/(am|pm)$/, '')} – ${b}` : `${a} – ${b}`;
};

/** The local days an event covers, first and last included. */
export interface Span {
  first: DateKey;
  last: DateKey;
}

export const eventSpan = (event: { start: string; end: string; allDay: boolean }, zone: string): Span => {
  const start = zonedDateMinutes(event.start, zone);
  const end = zonedDateMinutes(event.end, zone);
  // An event that ends at midnight does not touch the next day; an all-day one ends at the midnight after its last day.
  const last = event.allDay || (end.minutes === 0 && end.date > start.date) ? addDays(end.date, -1) : end.date;
  return { first: start.date, last: last < start.date ? start.date : last };
};

/** Something placed in a month row or the schedule: its days, and whether it draws as a bar. */
export interface RowItem<T> {
  item: T;
  span: Span;
  /** All-day or several days long: a bar across its days, above the timed events. */
  bar: boolean;
  /** For ordering timed events within a day. */
  startMs: number;
}

export interface RowPlacement<T> {
  item: T;
  /** First and last column in the row. */
  col: number;
  span: number;
  /** Line within the row, from the top. */
  slot: number;
  /** It began before this row, or goes on after it. */
  fromBefore: boolean;
  toAfter: boolean;
}

/**
 * A month row (or a week's all-day row) as Google Calendar draws it: bars
 * first, longest first, then each day's timed events by start time, each in
 * the first line free across its days.
 */
export const layoutRow = <T>(items: readonly RowItem<T>[], days: readonly DateKey[]): { placements: RowPlacement<T>[]; lines: number } => {
  if (!days.length) return { placements: [], lines: 0 };
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  const columnOf = (date: DateKey, from: 'start' | 'end'): number => {
    if (from === 'start') {
      const index = days.findIndex((day) => day >= date);
      return index;
    }
    for (let index = days.length - 1; index >= 0; index--) if (days[index]! <= date) return index;
    return -1;
  };
  const sorted = items
    .filter((entry) => entry.span.last >= firstDay && entry.span.first <= lastDay)
    .slice()
    .sort((a, b) => Number(b.bar) - Number(a.bar) || a.span.first.localeCompare(b.span.first) || daysBetween(b.span.first, b.span.last) - daysBetween(a.span.first, a.span.last) || a.startMs - b.startMs);
  const taken: boolean[][] = [];
  const placements: RowPlacement<T>[] = [];
  for (const entry of sorted) {
    const col = columnOf(entry.span.first, 'start');
    const end = columnOf(entry.span.last, 'end');
    // A weekend-only event in a row without weekends.
    if (col < 0 || end < col) continue;
    let slot = 0;
    while ((taken[slot] ?? []).slice(col, end + 1).some(Boolean)) slot++;
    taken[slot] ??= [];
    for (let index = col; index <= end; index++) taken[slot]![index] = true;
    placements.push({ item: entry.item, col, span: end - col + 1, slot, fromBefore: entry.span.first < days[col]!, toAfter: entry.span.last > days[end]! });
  }
  return { placements, lines: taken.length };
};

/**
 * What a month row can show in `maxLines` lines per day: a day that needs more
 * keeps its last line for "N more", and a bar shows only where every day it
 * crosses has room for it. `more` counts, per column, what is behind the link;
 * the link always goes on line `maxLines - 1`, which is then free.
 */
export const fitRow = <T>(placements: readonly RowPlacement<T>[], columns: number, maxLines: number): { shown: RowPlacement<T>[]; more: number[] } => {
  const needed = new Array<number>(columns).fill(0);
  for (const entry of placements) for (let column = entry.col; column < entry.col + entry.span; column++) needed[column] = Math.max(needed[column]!, entry.slot + 1);
  const limit = needed.map((lines) => (lines > maxLines ? maxLines - 1 : maxLines));
  const shown: RowPlacement<T>[] = [];
  const more = new Array<number>(columns).fill(0);
  for (const entry of placements) {
    let room = Infinity;
    for (let column = entry.col; column < entry.col + entry.span; column++) room = Math.min(room, limit[column]!);
    if (entry.slot < room) shown.push(entry);
    else for (let column = entry.col; column < entry.col + entry.span; column++) more[column] = more[column]! + 1;
  }
  return { shown, more };
};

/** The schedule: each day in [from, to] with what it holds (bars first, then by start), days without anything left out. */
export const scheduleDays = <T>(items: readonly RowItem<T>[], from: DateKey, to: DateKey): { date: DateKey; items: RowItem<T>[] }[] => {
  const out: { date: DateKey; items: RowItem<T>[] }[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const today = items.filter((entry) => entry.span.first <= date && entry.span.last >= date).sort((a, b) => Number(b.bar) - Number(a.bar) || a.startMs - b.startMs);
    if (today.length) out.push({ date, items: today });
  }
  return out;
};
