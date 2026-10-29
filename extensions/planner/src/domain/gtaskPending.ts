// Google Calendar's "Pending tasks": the open Google tasks dated in the past
// 365 days, gathered in one entry in today's all-day section ("3 pending
// tasks"), whose list edits, completes or reschedules each of them. A task
// only Google Tasks' own apps show (no date) or one done is not pending; one
// dated today is today's, on the calendar as usual.
import type { CalendarEvent } from './ics.ts';
import type { DateKey } from './types.ts';
import { addDays, instantAt } from './dates.ts';
import { GOOGLE_TASKS_CALENDAR, type GoogleTaskItem } from './google.ts';

/** How far back Google Calendar looks for pending tasks. */
export const PENDING_DAYS = 365;

/** The days whose open tasks are pending on `today`: the past 365, today not among them. */
export const pendingRange = (today: DateKey): { from: DateKey; to: DateKey } => ({ from: addDays(today, -PENDING_DAYS), to: addDays(today, -1) });

/** The pending tasks among `items` on `today`, each once, the latest date first (then by title), as Google lists them. */
export const pendingTasks = (items: readonly GoogleTaskItem[], today: DateKey): GoogleTaskItem[] => {
  const { from, to } = pendingRange(today);
  const seen = new Set<string>();
  const out: GoogleTaskItem[] = [];
  for (const item of items) {
    const key = `${item.account}\n${item.id}`;
    if (item.completed || !item.due || item.due < from || item.due > to || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (b.due ?? '').localeCompare(a.due ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
};

/** "1 pending task", "3 pending tasks". */
export const pendingTitle = (count: number): string => `${count} pending task${count === 1 ? '' : 's'}`;

/** The entry in today's all-day section that opens the list; null when nothing is pending. */
export const pendingEvent = (pending: readonly GoogleTaskItem[], today: DateKey, zone: string): CalendarEvent | null =>
  pending.length
    ? {
        id: `gtask-pending:${today}`,
        calendarId: GOOGLE_TASKS_CALENDAR,
        title: pendingTitle(pending.length),
        location: '',
        start: instantAt(today, 0, zone),
        end: instantAt(addDays(today, 1), 0, zone),
        allDay: true,
        busy: false,
        pendingTasks: [...pending],
      }
    : null;

/** "OCT" and "21", the date block of a pending task's row. */
export const dateBlock = (date: DateKey): { month: string; day: string } => ({
  month: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(date.slice(5, 7)) - 1] ?? '',
  day: String(Number(date.slice(8))),
});
