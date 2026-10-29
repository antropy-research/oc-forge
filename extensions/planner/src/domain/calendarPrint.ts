// Google Calendar's Print (Settings → Print, or Ctrl/⌘+P;
// https://support.google.com/calendar/answer/41067): a print preview of the
// range the view shows, with its options (print range, view, font size,
// orientation, color and style, show weekends, show events you have declined,
// and for Schedule the descriptions and your response), and what each page
// of the printout holds.
import type { DateKey } from './types.ts';
import { addDays, weekday } from './dates.ts';
import { SCHEDULE_DAYS, addMonths, daysInMonth, longDay, monthStart, monthWeeks, rangeTitle, type CalendarMode } from './gcalendar.ts';

/** The print preview's View: Auto prints as the calendar shows (a year, month by month). */
export type PrintView = 'auto' | 'day' | 'week' | 'month' | 'schedule';
export type PrintLayout = Exclude<PrintView, 'auto'>;
export type PrintFontSize = 'smallest' | 'smaller' | 'small' | 'normal' | 'big' | 'bigger' | 'biggest';
export type PrintOrientation = 'auto' | 'portrait' | 'landscape';
/** Color & style: Full color (my answer shows as Google draws it), Outline, or Black and white. */
export type PrintColor = 'full' | 'outline' | 'bw';

export interface PrintOptions {
  /** The print range, both days included. */
  from: DateKey;
  to: DateKey;
  view: PrintView;
  fontSize: PrintFontSize;
  orientation: PrintOrientation;
  color: PrintColor;
  weekends: boolean;
  declined: boolean;
  /** Schedule: each event's description. */
  descriptions: boolean;
  /** Schedule: my answer to each invitation. */
  responses: boolean;
}

export const PRINT_VIEWS: readonly { id: PrintView; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'schedule', label: 'Schedule' },
];
export const PRINT_FONT_SIZES: readonly { id: PrintFontSize; label: string; scale: number }[] = [
  { id: 'smallest', label: 'Smallest', scale: 0.7 },
  { id: 'smaller', label: 'Smaller', scale: 0.8 },
  { id: 'small', label: 'Small', scale: 0.9 },
  { id: 'normal', label: 'Normal', scale: 1 },
  { id: 'big', label: 'Big', scale: 1.15 },
  { id: 'bigger', label: 'Bigger', scale: 1.3 },
  { id: 'biggest', label: 'Biggest', scale: 1.5 },
];
export const PRINT_ORIENTATIONS: readonly { id: PrintOrientation; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
];
export const PRINT_COLORS: readonly { id: PrintColor; label: string }[] = [
  { id: 'full', label: 'Full color' },
  { id: 'outline', label: 'Outline' },
  { id: 'bw', label: 'Black and white' },
];

const lastOfMonth = (date: DateKey): DateKey => `${date.slice(0, 8)}${String(daysInMonth(date)).padStart(2, '0')}`;
const isWeekend = (date: DateKey): boolean => weekday(date) === 0 || weekday(date) === 6;

/**
 * The print range the preview opens with: the range the calendar shows (a month view prints its month, not the
 * other months' days around it; a year its twelve months).
 */
export const printRange = (mode: CalendarMode, anchor: DateKey, days: readonly DateKey[]): { from: DateKey; to: DateKey } => {
  if (mode === 'month') return { from: monthStart(anchor), to: lastOfMonth(anchor) };
  if (mode === 'year') return { from: `${anchor.slice(0, 4)}-01-01`, to: `${anchor.slice(0, 4)}-12-31` };
  if (mode === 'schedule') return { from: anchor, to: addDays(anchor, SCHEDULE_DAYS - 1) };
  return { from: days[0] ?? anchor, to: days[days.length - 1] ?? anchor };
};

/** The options the preview opens with, as Google Calendar's: Auto, Normal, Auto, Outline, weekends as the view shows them. */
export const defaultPrintOptions = (mode: CalendarMode, anchor: DateKey, days: readonly DateKey[], shown: { weekends: boolean; declined: boolean }): PrintOptions => ({
  ...printRange(mode, anchor, days),
  view: 'auto',
  fontSize: 'normal',
  orientation: 'auto',
  color: 'outline',
  weekends: shown.weekends,
  declined: shown.declined,
  descriptions: false,
  responses: false,
});

/** How it prints: Auto prints as the calendar shows it (a year as its months). */
export const printLayout = (view: PrintView, mode: CalendarMode): PrintLayout => (view !== 'auto' ? view : mode === 'year' ? 'month' : mode);

/** Auto orientation: Week and Month across the page (landscape), Day and Schedule down it (portrait). */
export const pageOrientation = (orientation: PrintOrientation, layout: PrintLayout): 'portrait' | 'landscape' =>
  orientation !== 'auto' ? orientation : layout === 'week' || layout === 'month' ? 'landscape' : 'portrait';

/** One page of a printout: its title and days (a Month page: its weeks). */
export interface PrintPage {
  title: string;
  days: DateKey[];
  weeks?: DateKey[][];
}

/**
 * The pages of a printout of `from`–`to`: a Day a page; a Week a page (its days in the range); a Month a page (its
 * weeks, the range's days in them); Schedule one run of days, broken between days. Without weekends, Saturdays and
 * Sundays are left out, as the view leaves them out.
 */
export const printPages = (layout: PrintLayout, from: DateKey, to: DateKey, weekStartsOn: 0 | 1, weekends: boolean): PrintPage[] => {
  if (to < from) return [];
  const keep = (date: DateKey) => weekends || !isWeekend(date);
  const all: DateKey[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) all.push(date);
  if (layout === 'day') return all.filter(keep).map((date) => ({ title: `${longDay(date)}, ${date.slice(0, 4)}`, days: [date] }));
  if (layout === 'schedule') return [{ title: rangeTitle('schedule', from, all), days: all }];
  if (layout === 'week') {
    const pages: PrintPage[] = [];
    for (const date of all) {
      const page = pages.at(-1);
      if (page && weekday(date) !== weekStartsOn) page.days.push(date);
      else pages.push({ title: '', days: [date] });
    }
    // "Oct 26 – Nov 1, 2026", as the week's own days run, weekends or not.
    return pages.map((page) => ({ ...page, title: rangeTitle('schedule', page.days[0]!, page.days), days: page.days.filter(keep) })).filter((page) => page.days.length);
  }
  const pages: PrintPage[] = [];
  for (let month = monthStart(from); month <= to; month = addMonths(month, 1)) {
    const weeks = monthWeeks(month, weekStartsOn).map((week) => week.filter(keep));
    const days = weeks.flat().filter((date) => date.slice(0, 7) === month.slice(0, 7) && date >= from && date <= to);
    if (days.length) pages.push({ title: rangeTitle('month', month, days), days, weeks });
  }
  return pages;
};

/** Hours a Day or Week page draws: its events' hours, at least 8 AM to 6 PM, as a printed day reads. */
export const printHours = (spans: readonly { start: number; end: number }[]): { first: number; last: number } => {
  const first = Math.min(8, ...spans.map((span) => Math.floor(span.start / 60)));
  const last = Math.max(18, ...spans.map((span) => Math.ceil(span.end / 60)));
  return { first: Math.max(0, first), last: Math.min(24, last) };
};
