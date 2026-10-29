// What the calendar views draw: events, working sessions and Google tasks as
// one kind of item, their colors (Google Calendar's solid fills, with ink that
// reads on them), labels, and the drag payloads between calendar cells.
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { CalendarSubscription, DateKey, PlannerState, Task, WorkBlock } from '../../../src/domain/types.ts';
import { blocksOnDay } from '../../../src/domain/selectors.ts';
import { addDays, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactClock, compactRange, eventSpan, longDay, shortDay, type RowItem } from '../../../src/domain/gcalendar.ts';
import { GOOGLE_TASKS_CALENDAR, taskForGoogleTask } from '../../../src/domain/google.ts';
import { keptFor, keptTimeLabel, upcomingValues } from '../../../src/domain/gtaskKept.ts';
import { PENDING_DAYS } from '../../../src/domain/gtaskPending.ts';
import { describeRecurrence } from '../../../src/domain/rrule.ts';

/** Google Calendar's color for tasks. */
export const GOOGLE_TASKS_COLOR = '#1a73e8';
/** A calendar event dragged between days (its id). */
export const GCAL_EVENT_TYPE = 'application/x-planner-gcal-event';
/** A Google task chip dragged to another day (the task as JSON). */
export const GCAL_TASK_TYPE = 'application/x-planner-gcal-task';
/** A working session dragged to another day in the month (its id). */
export const GCAL_BLOCK_TYPE = 'application/x-planner-gcal-block';

/** A Google task on the calendar: on its date, or on its deadline's day. */
export const isTaskEvent = (event: CalendarEvent): boolean => event.calendarId === GOOGLE_TASKS_CALENDAR && Boolean(event.googleTask);

/** A Google task on its date: it completes, and drags to another day or time. Not its deadline, nor an upcoming occurrence. */
export const isMovableTask = (event: CalendarEvent): boolean => isTaskEvent(event) && !event.taskDeadline;

export const eventColor = (event: CalendarEvent, calendars: Readonly<Record<string, CalendarSubscription>>): string =>
  event.calendarId === GOOGLE_TASKS_CALENDAR ? GOOGLE_TASKS_COLOR : event.google?.color ?? calendars[event.calendarId]?.color ?? '#868e96';

/** How a Google task item shows: the task, its deadline, an upcoming occurrence of its series, or the pending tasks ('' for anything else), as class names. */
export const taskClass = (event: CalendarEvent): string =>
  event.pendingTasks ? ' is-task is-pending' : event.upcoming ? ' is-task is-upcoming' : !isTaskEvent(event) ? '' : event.taskDeadline ? ' is-task is-deadline' : ' is-task';

/** Dark ink on light fills, white on the rest, as Google Calendar does. */
export const inkOn = (hex: string): string => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return '#fff';
  const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16) / 255) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.66 ? '#202124' : '#fff';
};

/** How my answer shows: unanswered and maybe as outlines, declined struck through. */
export const answerClass = (event: CalendarEvent): string => {
  switch (event.google?.response) {
    case 'needsAction':
      return ' is-unanswered';
    case 'tentative':
      return ' is-tentative';
    case 'declined':
      return ' is-declined';
    default:
      return '';
  }
};

/** "Quarter planning, 2pm – 3pm, Monday, October 26"; "3 pending tasks, from the past 365 days" */
export const eventLabel = (event: CalendarEvent, zone: string): string => {
  if (event.pendingTasks) return `${event.title}, from the past ${PENDING_DAYS} days`;
  const start = zonedDateMinutes(event.start, zone);
  const end = zonedDateMinutes(event.end, zone);
  if (event.allDay) return `${event.title}, all day, ${longDay(start.date)}`;
  return `${event.title}, ${compactRange(start.minutes, end.date > start.date && end.minutes === 0 ? 1440 : end.minutes)}, ${longDay(start.date)}`;
};

/**
 * "Google task Send the report, due Monday, October 26 at 2pm, planned in the
 * Planner, deadline Friday, October 30, repeats": a task chip's full text, for
 * its label and tooltip. On its deadline's day: "Google task Send the report,
 * deadline Friday, October 30, no date". An upcoming occurrence: "Google task
 * Standup, upcoming Wednesday, October 28 at 10am, repeats daily" (", changed
 * for this task" when it was changed on its own).
 */
export const taskEventLabel = (event: CalendarEvent, state: PlannerState, today: DateKey, zone = 'UTC'): string => {
  const upcoming = event.upcoming;
  if (upcoming) {
    const time = keptTimeLabel(upcomingValues(upcoming));
    const repeats = describeRecurrence([upcoming.rule], upcoming.template.start, zone);
    return `Google task ${event.title}, upcoming ${longDay(upcoming.date)}${time ? ` at ${time}` : ''}, repeats ${repeats.charAt(0).toLowerCase()}${repeats.slice(1)}${upcoming.change ? ', changed for this task' : ''}`;
  }
  const task = event.googleTask!;
  const kept = keptFor(state, task);
  const time = keptTimeLabel(kept);
  const planned = taskForGoogleTask(state, task);
  const deadline = kept?.deadline ?? null;
  const overdue = deadline && deadline < today && !task.completed ? ', overdue' : '';
  const after = `${task.completed ? ', completed' : ''}${planned ? ', planned in the Planner' : ''}`;
  if (event.taskDeadline && deadline) return `Google task ${event.title}, deadline ${longDay(deadline)}${overdue}${task.due ? `, due ${longDay(task.due)}${time ? ` at ${time}` : ''}` : ', no date'}${after}${kept?.repeat ? ', repeats' : ''}`;
  return `Google task ${event.title}, due ${longDay(task.due ?? event.start.slice(0, 10))}${time ? ` at ${time}` : ''}${after}${deadline ? `, deadline ${longDay(deadline)}${overdue}` : ''}${kept?.repeat ? ', repeats' : ''}`;
};

/** A task's deadline on its chip, red once it has passed; null without one, and on its deadline's own item (the flag is the item). */
export const deadlineOf = (event: CalendarEvent, state: PlannerState, today: DateKey): { date: DateKey; label: string; overdue: boolean } | null => {
  const task = event.googleTask;
  const deadline = task ? keptFor(state, task)?.deadline ?? null : null;
  return deadline && !event.taskDeadline ? { date: deadline, label: shortDay(deadline), overdue: deadline < today && !task!.completed } : null;
};

/** A deadline's own item, red once it has passed with the task open. */
export const deadlinePassed = (event: CalendarEvent, state: PlannerState, today: DateKey): boolean => {
  const task = event.googleTask;
  const deadline = task && event.taskDeadline ? keptFor(state, task)?.deadline ?? null : null;
  return Boolean(deadline && deadline < today && !task!.completed);
};

/** One thing on the calendar: an event (or a Google task due that day) or a working session. */
export type CalItem = { kind: 'event'; event: CalendarEvent } | { kind: 'block'; block: WorkBlock; task: Task };

export const itemKey = (item: CalItem): string => (item.kind === 'event' ? item.event.id : `block:${item.block.id}`);

/** Events, Google tasks and working sessions between two days, for the month and the schedule. */
export const calendarItems = (state: PlannerState, events: readonly CalendarEvent[], from: DateKey, to: DateKey, zone: string, options: { completedTasks: boolean; channel: (task: Task) => boolean }): RowItem<CalItem>[] => {
  const out: RowItem<CalItem>[] = [];
  for (const event of events) {
    if (isTaskEvent(event) && event.googleTask?.completed && !options.completedTasks) continue;
    const span = eventSpan(event, zone);
    // A task with a kept time is timed, as an event is; the rest show all day.
    out.push({ item: { kind: 'event', event }, span, bar: event.allDay || span.last > span.first, startMs: event.allDay ? Date.parse(event.start) - 1 : Date.parse(event.start) });
  }
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const block of blocksOnDay(state, date)) {
      const task = state.tasks[block.taskId];
      if (!task || !options.channel(task)) continue;
      out.push({ item: { kind: 'block', block, task }, span: { first: date, last: date }, bar: false, startMs: Date.parse(block.start) });
    }
  }
  return out;
};

/** Start time as Google's month view shows it before a title: "9am", "2:30pm". */
export const startLabel = (iso: string, zone: string): string => compactClock(zonedDateMinutes(iso, zone).minutes);

/** The Planner task that plans a Google task shown on the calendar. */
export const plannedTask = (state: PlannerState, event: CalendarEvent): Task | null => (event.googleTask ? taskForGoogleTask(state, event.googleTask) : null);
