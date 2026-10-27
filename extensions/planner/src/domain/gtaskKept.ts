// What the Planner keeps for Google tasks because Google Tasks' API does not
// let other apps read or write it: a time on the task's date (and how long it
// takes), a deadline, a repeat rule with its series' template, and a star, as
// Google Tasks and Google Calendar have them. Where a kept time puts a task on
// the calendar, how a repeating task's next occurrence is found (from its
// series' template, without making one Google's own repeat made already), and
// the Starred view's order. Google keeps the rest: nothing kept here is
// written into a task's title or details.
import type { CalendarEvent } from './ics.ts';
import { googleTaskKey, type DateKey, type GoogleTaskKept, type GoogleTaskTemplate, type PlannerState } from './types.ts';
import { addDays, daysBetween, instantAt, monthDay, weekday, weekdayName } from './dates.ts';
import { addMonths, compactClock, compactRange, daysInMonth } from './gcalendar.ts';
import { parseRRule, untilDate, WEEKDAY_CODES, type RRule } from './rrule.ts';
import type { GoogleTaskItem } from './google.ts';
import type { EventBody, GoogleTaskKeptPatch } from './events.ts';

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

type Repeat = NonNullable<GoogleTaskKept['repeat']>;

/** The date the series put an occurrence on: kept since templates (a one-off change of its date leaves it), else its date. */
export const scheduledOn = (kept: GoogleTaskKept, item: Pick<GoogleTaskItem, 'due'>): DateKey | null => kept.repeat?.on ?? item.due;

/** A series' template from a task's values: what it says, its time, and its deadline as days after `date`; its schedule counts from `start`. */
export const templateOf = (task: { title: string; notes: string }, kept: Pick<GoogleTaskKept, 'time' | 'duration' | 'deadline'>, date: DateKey, start: DateKey = date): GoogleTaskTemplate => ({
  title: task.title,
  notes: task.notes,
  time: kept.time,
  duration: kept.duration,
  deadline: kept.deadline ? daysBetween(date, kept.deadline) : null,
  start,
});

/**
 * A series' template: kept with its repeat, or, for a series kept before
 * templates, this occurrence as it is now (as it was first seen). Null when
 * there is no date to count from.
 */
export const seriesTemplate = (kept: GoogleTaskKept, item: Pick<GoogleTaskItem, 'title' | 'notes' | 'due'>): GoogleTaskTemplate | null => {
  if (kept.repeat?.template) return kept.repeat.template;
  const on = scheduledOn(kept, item);
  return on ? templateOf(item, kept, on) : null;
};

/** What is kept for the occurrence a series makes on `date` after `repeat`'s: the template's time and deadline, and the series. */
export const nextOccurrenceKept = (repeat: Repeat, template: GoogleTaskTemplate, date: DateKey): GoogleTaskKeptPatch => ({
  time: template.time,
  duration: template.duration,
  deadline: template.deadline === null ? null : addDays(date, template.deadline),
  repeat: { rule: repeat.rule, seriesId: repeat.seriesId, index: repeat.index + 1, next: null, on: date, template },
});

/**
 * Series kept before templates, seen again: each open occurrence keeps the
 * date it is on and a template made from it as it is, once, so later one-off
 * changes leave the series alone. Nothing is made in Google.
 */
export const firstSightOfSeries = (state: Pick<PlannerState, 'googleTasks'>, items: Iterable<GoogleTaskItem>): EventBody[] => {
  const out: EventBody[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const kept = keptFor(state, item);
    const repeat = kept?.repeat;
    const key = googleTaskKey(item.account, item.id);
    if (!kept || !repeat || repeat.next || item.completed || (repeat.on && repeat.template) || seen.has(key)) continue;
    seen.add(key);
    const on = scheduledOn(kept, item);
    const template = seriesTemplate(kept, item);
    if (on && template) out.push({ type: 'gtask.kept', account: item.account, listId: item.listId, taskId: item.id, patch: { repeat: { ...repeat, on, template } } });
  }
  return out;
};

/** An occurrence of a repeating task to make: after `item` (completed or deleted), on `date`, from `template`. */
export interface NextOccurrence {
  item: GoogleTaskItem;
  kept: GoogleTaskKept;
  /** What it is made from; null when the series has no date to count from. */
  template: GoogleTaskTemplate | null;
  /** Null when the series ends with this occurrence. */
  date: DateKey | null;
}

/**
 * Repeating tasks completed (in the Planner or in Google) whose next
 * occurrence is not made yet, and its date: the series' next one after the
 * date it put this occurrence on, whatever this one was moved to.
 */
export const dueOccurrences = (state: Pick<PlannerState, 'googleTasks'>, items: Iterable<GoogleTaskItem>): NextOccurrence[] => {
  const out: NextOccurrence[] = [];
  for (const item of items) {
    const kept = keptFor(state, item);
    if (!item.completed || !kept?.repeat || kept.repeat.next) continue;
    const on = scheduledOn(kept, item);
    out.push({ item, kept, template: seriesTemplate(kept, item), date: on ? nextRepeatDate(kept.repeat.rule, on, kept.repeat.index) : null });
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
