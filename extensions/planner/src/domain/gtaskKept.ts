// What the Planner keeps for Google tasks because Google Tasks' API does not
// let other apps read or write it: a time on the task's date (and how long it
// takes), a deadline, a repeat rule and a star, as Google Tasks and Google
// Calendar have them. Where a kept time puts a task on the calendar, how a
// repeating task's next occurrence is found (without making one Google's own
// repeat made already), and the Starred view's order. Google keeps the rest:
// nothing kept here is written into a task's title or details.
import type { CalendarEvent } from './ics.ts';
import { googleTaskKey, type DateKey, type GoogleTaskKept, type PlannerState } from './types.ts';
import { addDays, instantAt, monthDay, weekday, weekdayName } from './dates.ts';
import { addMonths, compactClock, compactRange, daysInMonth } from './gcalendar.ts';
import { parseRRule, untilDate, WEEKDAY_CODES, type RRule } from './rrule.ts';
import type { GoogleTaskItem } from './google.ts';

/** Google's reference for what its Tasks API carries (a date without a time; no repeat, no star). */
export const TASKS_API_REFERENCE = 'https://developers.google.com/workspace/tasks/reference/rest/v1/tasks';
/** Said wherever a user sets something the Planner keeps. */
export const KEPT_HINT = "Kept in the Planner: Google Tasks doesn't let other apps set times, deadlines, repeats or stars";
/** How long a timed task without an end time shows on the grid, as Google Calendar draws it. */
export const TASK_MINUTES = 30;

export const keptFor = (state: Pick<PlannerState, 'googleTasks'>, item: { account: string; id: string }): GoogleTaskKept | null => state.googleTasks?.[googleTaskKey(item.account, item.id)] ?? null;

/** "2pm", or "2 – 3pm" when it has an end. */
export const keptTimeLabel = (kept: Pick<GoogleTaskKept, 'time' | 'duration'> | null): string | null => {
  if (!kept || kept.time === null) return null;
  return kept.duration ? compactRange(kept.time, Math.min(24 * 60, kept.time + kept.duration)) : compactClock(kept.time);
};

/**
 * Google tasks at their kept time: timed on the grid instead of all day, as
 * Google Calendar shows a task with a time. A change of date in Google moves
 * the task and keeps its time.
 */
export const withTaskTimes = (events: readonly CalendarEvent[], kept: Readonly<Record<string, GoogleTaskKept>> | undefined, zone: string): CalendarEvent[] => {
  if (!kept || !Object.keys(kept).length) return [...events];
  return events.map((event) => {
    const item = event.googleTask;
    const found = item?.due ? kept[googleTaskKey(item.account, item.id)] : undefined;
    if (!item?.due || !found || found.time === null) return event;
    const start = instantAt(item.due, found.time, zone);
    const end = instantAt(item.due, Math.min(24 * 60, found.time + (found.duration ?? TASK_MINUTES)), zone);
    return { ...event, start, end, allDay: false };
  });
};

/** Google Tasks' repeat menu for a task on `date`: its presets, then Custom… (the same rule builder as events). */
export const taskRepeatPresets = (date: DateKey): { id: string; label: string; rule: string | null }[] => [
  { id: 'none', label: 'Does not repeat', rule: null },
  { id: 'daily', label: 'Daily', rule: 'RRULE:FREQ=DAILY' },
  { id: 'weekly', label: `Weekly on ${weekdayName(date)}`, rule: `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[weekday(date)]}` },
  { id: 'monthly', label: `Monthly on day ${Number(date.slice(8))}`, rule: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Number(date.slice(8))}` },
  { id: 'yearly', label: `Annually on ${monthDay(date)}`, rule: 'RRULE:FREQ=YEARLY' },
];

const nthWeekday = (monthKey: DateKey, code: string): DateKey | null => {
  const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(code);
  if (!match) return null;
  const nth = Number(match[1] ?? '1');
  const day = WEEKDAY_CODES.indexOf(match[2] as (typeof WEEKDAY_CODES)[number]);
  const first = `${monthKey.slice(0, 8)}01`;
  const length = daysInMonth(first);
  const offset = (day - weekday(first) + 7) % 7;
  const dates = Array.from({ length: 5 }, (_, index) => 1 + offset + index * 7).filter((value) => value <= length);
  const chosen = nth > 0 ? dates[nth - 1] : dates[dates.length + nth];
  return chosen ? `${first.slice(0, 8)}${String(chosen).padStart(2, '0')}` : null;
};

/** The first date after `date` the rule makes, before any COUNT or UNTIL. */
const stepRule = (rule: RRule, date: DateKey): DateKey | null => {
  const every = rule.interval;
  switch (rule.freq) {
    case 'DAILY':
      return addDays(date, every);
    case 'WEEKLY': {
      const days = [...new Set(rule.byDay.map((code) => WEEKDAY_CODES.indexOf(code.slice(-2) as (typeof WEEKDAY_CODES)[number])).filter((day) => day >= 0))];
      if (!days.length) return addDays(date, 7 * every);
      // Weeks start on WKST (Monday unless the rule says), as RFC 5545 counts them.
      const start = WEEKDAY_CODES.indexOf((rule.other.find(([key]) => key === 'WKST')?.[1] ?? 'MO') as (typeof WEEKDAY_CODES)[number]);
      const place = (day: number) => (day - Math.max(0, start) + 7) % 7;
      const sorted = days.sort((a, b) => place(a) - place(b));
      const here = place(weekday(date));
      const later = sorted.find((day) => place(day) > here);
      return later !== undefined ? addDays(date, place(later) - here) : addDays(date, 7 * every - here + place(sorted[0]!));
    }
    case 'MONTHLY':
      for (let step = 1; step <= 48; step++) {
        const month = addMonths(`${date.slice(0, 8)}01`, step * every);
        let candidate: DateKey | null;
        if (rule.byDay.length === 1) candidate = nthWeekday(month, rule.byDay[0]!);
        else {
          const wanted = rule.byMonthDay[0] ?? Number(date.slice(8));
          const length = daysInMonth(month);
          const day = wanted < 0 ? length + wanted + 1 : wanted;
          candidate = day >= 1 && day <= length ? `${month.slice(0, 8)}${String(day).padStart(2, '0')}` : null;
        }
        if (candidate && candidate > date) return candidate;
      }
      return null;
    case 'YEARLY':
      for (let step = 1; step <= 8; step++) {
        const year = Number(date.slice(0, 4)) + step * every;
        const month = rule.byMonth[0] ?? Number(date.slice(5, 7));
        const day = rule.byMonthDay[0] ?? Number(date.slice(8));
        const first = `${year}-${String(month).padStart(2, '0')}-01`;
        if (day >= 1 && day <= daysInMonth(first)) return `${first.slice(0, 8)}${String(day).padStart(2, '0')}`;
      }
      return null;
  }
};

/** The date of the occurrence after the `index`th one (on `date`), or null when the rule ends there. */
export const nextRepeatDate = (line: string, date: DateKey, index: number): DateKey | null => {
  const rule = parseRRule(line);
  if (!rule) return null;
  if (rule.count !== null && index >= rule.count) return null;
  const next = stepRule(rule, date);
  if (!next) return null;
  const until = rule.until ? untilDate(rule.until, 'UTC') : null;
  return until && next > until ? null : next;
};

/** An occurrence of a repeating task to make: after `item` (completed or deleted), on `date`. */
export interface NextOccurrence {
  item: GoogleTaskItem;
  kept: GoogleTaskKept;
  /** Null when the series ends with this occurrence. */
  date: DateKey | null;
}

/** Repeating tasks completed (in the Planner or in Google) whose next occurrence is not made yet. */
export const dueOccurrences = (state: Pick<PlannerState, 'googleTasks'>, items: Iterable<GoogleTaskItem>): NextOccurrence[] => {
  const out: NextOccurrence[] = [];
  for (const item of items) {
    const kept = keptFor(state, item);
    if (!item.completed || !kept?.repeat || kept.repeat.next) continue;
    out.push({ item, kept, date: item.due ? nextRepeatDate(kept.repeat.rule, item.due, kept.repeat.index) : null });
  }
  return out;
};

/**
 * The next occurrence made already, by Google's own repeat (a series made in
 * Google Tasks) or another Planner window: a task in the list with the title,
 * due that day, other than the one just done.
 */
export const madeAlready = (items: readonly GoogleTaskItem[], title: string, date: DateKey, except: string): GoogleTaskItem | null =>
  items.find((item) => item.id !== except && item.due === date && item.title.trim() === title.trim()) ?? null;

/** Starred tasks, the newest star first, as Google Tasks' Starred view lists them. */
export const starredKept = (state: Pick<PlannerState, 'googleTasks'>): GoogleTaskKept[] =>
  Object.values(state.googleTasks ?? {})
    .filter((kept) => kept.starredAt)
    .sort((a, b) => b.starredAt!.localeCompare(a.starredAt!) || a.taskId.localeCompare(b.taskId));
