// What the Planner keeps for Google tasks because Google Tasks' API does not
// let other apps read or write it: a time on the task's date (and how long it
// takes), a deadline, a repeat rule with its series' template and its upcoming
// occurrences changed on their own, and a star, as Google Tasks and Google
// Calendar have them. Where a kept time puts a task on the calendar, where its
// deadline and a series' upcoming occurrences show, how a repeating task's
// next occurrence is found (without making one Google's own repeat made
// already), and the Starred view's order. Google keeps the rest: nothing kept
// here is written into a task's title or details.
import type { CalendarEvent } from './ics.ts';
import { googleTaskKey, type DateKey, type GoogleTaskException, type GoogleTaskKept, type GoogleTaskTemplate, type PlannerState } from './types.ts';
import { addDays, daysBetween, instantAt, monthDay, weekday, weekdayName } from './dates.ts';
import { addMonths, compactClock, compactRange, daysInMonth } from './gcalendar.ts';
import { parseRRule, untilDate, WEEKDAY_CODES, type RRule } from './rrule.ts';
import { GOOGLE_TASKS_CALENDAR, type GoogleTaskItem } from './google.ts';
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
    if (!item?.due || !found || found.time === null || event.taskDeadline) return event;
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
type Exceptions = Record<DateKey, GoogleTaskException>;

/** At most this many upcoming occurrences of one series in a range: a daily one fills a month's six weeks. */
const UPCOMING_MAX = 62;
/** How far a series is stepped to reach a range, so one years ahead stays quick. */
const STEPS_MAX = 4000;

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

/** What one occurrence of a series is: its template on the date the series puts it on, with what was changed for it alone. */
export interface OccurrenceValues {
  title: string;
  notes: string;
  /** Its date: the one the series puts it on, or its own once moved. */
  due: DateKey;
  time: number | null;
  duration: number | null;
  deadline: DateKey | null;
}

/** The occurrence a series puts on `on`: the template there (its deadline as many days after `on`), with `change` over it. */
export const occurrenceValues = (template: GoogleTaskTemplate, on: DateKey, change?: GoogleTaskException): OccurrenceValues => ({
  title: change?.title ?? template.title,
  notes: change?.notes ?? template.notes,
  due: change?.date ?? on,
  time: change?.time !== undefined ? change.time : template.time,
  duration: change?.time !== undefined ? change.duration ?? null : template.duration,
  deadline: change?.deadline !== undefined ? change.deadline : template.deadline === null ? null : addDays(on, template.deadline),
});

/**
 * What makes the occurrence the series puts on `on` read as `values`: only
 * what differs from its template there, so an "All tasks" change of anything
 * else reaches it too; null when nothing does.
 */
export const occurrenceChange = (template: GoogleTaskTemplate, on: DateKey, values: OccurrenceValues): GoogleTaskException | null => {
  const series = occurrenceValues(template, on);
  const change: GoogleTaskException = {
    ...(values.title !== series.title ? { title: values.title } : {}),
    ...(values.notes !== series.notes ? { notes: values.notes } : {}),
    ...(values.due !== on ? { date: values.due } : {}),
    ...(values.time !== series.time || values.duration !== series.duration ? { time: values.time, duration: values.duration } : {}),
    ...(values.deadline !== series.deadline ? { deadline: values.deadline } : {}),
  };
  return Object.keys(change).length ? change : null;
};

/** A series' exceptions with the one for `on` set, or (null) taken off; undefined when none are left. */
export const withException = (exceptions: Exceptions | undefined, on: DateKey, change: GoogleTaskException | null): Exceptions | undefined => {
  const { [on]: _old, ...rest } = exceptions ?? {};
  const next: Exceptions = change ? { ...rest, [on]: change } : rest;
  return Object.keys(next).length ? next : undefined;
};

/** A repeat with these exceptions, or with none kept. */
export const withExceptions = (repeat: Repeat, exceptions: Exceptions | undefined): Repeat => {
  const { exceptions: _old, ...rest } = repeat;
  return exceptions ? { ...rest, exceptions } : rest;
};

/**
 * The exceptions of a series that still fall on its schedule: dates after
 * `on` that `rule` makes from its `index`th occurrence there. A new rule or
 * start drops the rest, as they are no occurrence of it any more.
 */
export const exceptionsOnSchedule = (exceptions: Exceptions | undefined, rule: string, on: DateKey, index: number): Exceptions | undefined => {
  const dates = Object.keys(exceptions ?? {}).filter((date) => date > on).sort();
  if (!exceptions || !dates.length) return undefined;
  const out: Exceptions = {};
  let date: DateKey | null = on;
  for (let step = 0, at = index, seen = 0; date && seen < dates.length && step < STEPS_MAX; step++) {
    date = nextRepeatDate(rule, date, at++);
    while (date && seen < dates.length && dates[seen]! < date) seen++;
    if (date && dates[seen] === date) {
      out[date] = exceptions[date]!;
      seen++;
    }
  }
  return Object.keys(out).length ? out : undefined;
};

/**
 * The task a series makes for its `index`th occurrence, on `date`: Google's
 * title, details and date, and what is kept for it (its time and deadline,
 * and the series, with the exceptions still ahead), each as that occurrence
 * was changed on its own, else from the template.
 */
export const occurrenceTask = (repeat: Repeat, template: GoogleTaskTemplate, date: DateKey, index: number): { title: string; notes: string; due: DateKey; kept: GoogleTaskKeptPatch } => {
  const values = occurrenceValues(template, date, repeat.exceptions?.[date]);
  const ahead = Object.entries(repeat.exceptions ?? {}).filter(([on]) => on > date);
  return {
    title: values.title,
    notes: values.notes,
    due: values.due,
    kept: {
      time: values.time,
      duration: values.duration,
      deadline: values.deadline,
      repeat: { rule: repeat.rule, seriesId: repeat.seriesId, index, next: null, on: date, template, ...(ahead.length ? { exceptions: Object.fromEntries(ahead) } : {}) },
    },
  };
};

/** The occurrences a series goes on from (no next one made): where its template and exceptions are kept. */
export const seriesHeads = (state: Pick<PlannerState, 'googleTasks'>, seriesId: string): GoogleTaskKept[] =>
  Object.values(state.googleTasks ?? {}).filter((kept) => kept.repeat?.seriesId === seriesId && !kept.repeat.next);

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
  /** The date the series puts it on; null when the series ends with `item`. */
  date: DateKey | null;
  /** Which occurrence of the series it is: a date deleted on its own counts, as an EXDATE does. */
  index: number;
}

/**
 * The occurrence a series makes after `item` (completed, or deleted with
 * "This task"): the series' next date after the one it put `item` on,
 * whatever `item` was moved to, passing over the dates deleted on their own.
 */
export const nextOccurrence = (item: GoogleTaskItem, kept: GoogleTaskKept): NextOccurrence => {
  const repeat = kept.repeat;
  let date = scheduledOn(kept, item);
  let index = repeat?.index ?? 0;
  let found: DateKey | null = null;
  for (let step = 0; repeat && date && !found && step < STEPS_MAX; step++) {
    date = nextRepeatDate(repeat.rule, date, index);
    if (!date) break;
    index += 1;
    if (!repeat.exceptions?.[date]?.skip) found = date;
  }
  return { item, kept, template: seriesTemplate(kept, item), date: found, index };
};

/**
 * Repeating tasks completed (in the Planner or in Google) whose next
 * occurrence is not made yet, and its date (`nextOccurrence`). One whose
 * next Google refused stays so, and is made on the next read.
 */
export const dueOccurrences = (state: Pick<PlannerState, 'googleTasks'>, items: Iterable<GoogleTaskItem>): NextOccurrence[] => {
  const out: NextOccurrence[] = [];
  for (const item of items) {
    const kept = keptFor(state, item);
    if (!item.completed || !kept?.repeat || kept.repeat.next) continue;
    out.push(nextOccurrence(item, kept));
  }
  return out;
};

/** An upcoming occurrence of a repeating Google task, shown before Google Tasks has it. */
export interface UpcomingTask {
  account: string;
  listId: string;
  /** The open occurrence the series goes on from: editing or deleting the series acts on it. */
  taskId: string;
  seriesId: string;
  rule: string;
  /** Which occurrence of the series it would be. */
  index: number;
  /** The date the series puts it on, which says which occurrence it is. */
  on: DateKey;
  /** The date it shows on: `on`, or its own once moved. */
  date: DateKey;
  template: GoogleTaskTemplate;
  /** What was changed for it alone ("This task"). */
  change?: GoogleTaskException;
}

/** What an upcoming occurrence is: its template on its date, with what was changed for it alone. */
export const upcomingValues = (task: UpcomingTask): OccurrenceValues => occurrenceValues(task.template, task.on, task.change);

/**
 * Each repeating task's upcoming occurrences shown between `from` and `to`,
 * as Google Calendar shows a number of them on its grid: from the series'
 * open occurrence on, by its rule and template, from today on. One changed
 * on its own shows as changed (`change`): a date deleted shows nothing, one
 * moved shows on its new date. A date a real occurrence of the series shows
 * on (`shown`, kept as this series' own: the next one made, or one moved
 * there) is left to it, so one date never shows two. A task that only shares
 * the title and the date is a task of its own and shows beside it, as two
 * tasks do in Google Calendar (nor is it taken for the next occurrence:
 * `seriesNextIn`). A series deleted or ended shows none.
 */
export const upcomingTasks = (kept: Readonly<Record<string, GoogleTaskKept>>, shown: readonly GoogleTaskItem[], from: DateKey, to: DateKey, today: DateKey): UpcomingTask[] => {
  const taken = new Set<string>();
  for (const item of shown) {
    if (!item.due) continue;
    const series = kept[googleTaskKey(item.account, item.id)]?.repeat?.seriesId;
    if (series) taken.add(`${series}\n${item.due}`);
  }
  // Each occurrence once (by the date the series puts it on), however many open occurrences its series has.
  const projected = new Set<string>();
  const out: UpcomingTask[] = [];
  for (const source of Object.values(kept)) {
    const repeat = source.repeat;
    const rule = repeat && !repeat.next && repeat.on && repeat.template ? parseRRule(repeat.rule) : null;
    if (!repeat?.on || !repeat.template || !rule) continue;
    const until = rule.until ? untilDate(rule.until, 'UTC') : null;
    const changes = repeat.exceptions ?? {};
    // An occurrence moved into the range from a later date is stepped to.
    const last = Object.entries(changes).reduce((latest, [on, change]) => (change.date && change.date >= from && change.date <= to && on > latest ? on : latest), to);
    let date = repeat.on;
    let index = repeat.index;
    for (let step = 0, made = 0; step < STEPS_MAX && made < UPCOMING_MAX; step++) {
      if (rule.count !== null && index >= rule.count) break;
      const next = stepRule(rule, date);
      if (!next || (until && next > until) || next > last) break;
      date = next;
      index += 1;
      const change = changes[next];
      const on = change?.date ?? next;
      if (change?.skip || on < from || on > to || on < today) continue;
      const own = `${repeat.seriesId}\n${next}`;
      if (projected.has(own) || taken.has(`${repeat.seriesId}\n${on}`)) continue;
      projected.add(own);
      out.push({ account: source.account, listId: source.listId, taskId: source.taskId, seriesId: repeat.seriesId, rule: repeat.rule, index, on: next, date: on, template: repeat.template, ...(change ? { change } : {}) });
      made++;
    }
  }
  return out;
};

/** An upcoming occurrence as the calendar draws it: at its time on its date (the template's, or its own), or all day. */
export const upcomingEvent = (task: UpcomingTask, zone: string): CalendarEvent => {
  const { title, due, time, duration } = upcomingValues(task);
  return {
    id: `gtask-upcoming:${task.seriesId}:${task.on}`,
    calendarId: GOOGLE_TASKS_CALENDAR,
    title,
    location: '',
    start: instantAt(due, time ?? 0, zone),
    end: time === null ? instantAt(addDays(due, 1), 0, zone) : instantAt(due, Math.min(24 * 60, time + (duration ?? TASK_MINUTES)), zone),
    allDay: time === null,
    busy: false,
    upcoming: task,
  };
};

/**
 * Deadlines on their own day, in the all-day section as Google Calendar
 * shows them: each task (once, however often it was read) whose kept deadline
 * falls between `from` and `to`. A task without a date shows only there; a
 * timed one keeps its block at its time and has its deadline there too, its
 * own day included; an all-day task due on its deadline's day is one item,
 * the task with its flag.
 */
export const deadlineEvents = (items: readonly GoogleTaskItem[], kept: Readonly<Record<string, GoogleTaskKept>>, from: DateKey, to: DateKey, zone: string): CalendarEvent[] => {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const item of items) {
    const key = googleTaskKey(item.account, item.id);
    const deadline = kept[key]?.deadline;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!deadline || deadline < from || deadline > to) continue;
    // All day on its deadline's day: its own item carries the flag (a time puts it on the grid, as `withTaskTimes`).
    if (deadline === item.due && (kept[key]?.time ?? null) === null) continue;
    out.push({ id: `gtask-deadline:${item.listId}:${item.id}`, calendarId: GOOGLE_TASKS_CALENDAR, title: item.title, location: '', start: instantAt(deadline, 0, zone), end: instantAt(addDays(deadline, 1), 0, zone), allDay: true, busy: false, googleTask: item, taskDeadline: true });
  }
  return out;
};

/** The tasks to read for the deadlines kept between `from` and `to`, by account and list: Google has no deadline to ask by. */
export const deadlineGroups = (kept: Readonly<Record<string, GoogleTaskKept>>, accounts: readonly string[], from: DateKey, to: DateKey): { account: string; listId: string; ids: string[] }[] => {
  const groups = new Map<string, { account: string; listId: string; ids: string[] }>();
  for (const entry of Object.values(kept)) {
    if (!entry.deadline || entry.deadline < from || entry.deadline > to || !accounts.includes(entry.account)) continue;
    const key = `${entry.account}\n${entry.listId}`;
    const group = groups.get(key) ?? { account: entry.account, listId: entry.listId, ids: [] };
    group.ids.push(entry.taskId);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * The next occurrence a series has already (another Planner window made it): a
 * task in the list whose kept repeat is a later occurrence of this series (the
 * next one, or one past dates deleted on their own). Never a task that only
 * shares the title and the date: an unrelated task can have both.
 */
export const seriesNextIn = (state: Pick<PlannerState, 'googleTasks'>, items: readonly GoogleTaskItem[], repeat: { seriesId: string; index: number }, except: string): GoogleTaskItem | null =>
  items.find((item) => {
    if (item.id === except) return false;
    const theirs = keptFor(state, item)?.repeat;
    return Boolean(theirs && theirs.seriesId === repeat.seriesId && theirs.index > repeat.index);
  }) ?? null;

/** Starred tasks, the newest star first, as Google Tasks' Starred view lists them. */
export const starredKept = (state: Pick<PlannerState, 'googleTasks'>): GoogleTaskKept[] =>
  Object.values(state.googleTasks ?? {})
    .filter((kept) => kept.starredAt)
    .sort((a, b) => b.starredAt!.localeCompare(a.starredAt!) || a.taskId.localeCompare(b.taskId));
