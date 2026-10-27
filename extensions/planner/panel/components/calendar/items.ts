// What the calendar views draw: events, working sessions and Google tasks as
// one kind of item, their colors (Google Calendar's solid fills, with ink that
// reads on them), labels, and the drag payloads between calendar cells.
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { CalendarSubscription, DateKey, PlannerState, Task, WorkBlock } from '../../../src/domain/types.ts';
import { blocksOnDay } from '../../../src/domain/selectors.ts';
import { addDays, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactClock, compactRange, eventSpan, longDay, type RowItem } from '../../../src/domain/gcalendar.ts';
import { GOOGLE_TASKS_CALENDAR, taskForGoogleTask } from '../../../src/domain/google.ts';

/** Google Calendar's color for tasks. */
export const GOOGLE_TASKS_COLOR = '#1a73e8';
/** A calendar event dragged between days (its id). */
export const GCAL_EVENT_TYPE = 'application/x-planner-gcal-event';
/** A Google task chip dragged to another day (the task as JSON). */
export const GCAL_TASK_TYPE = 'application/x-planner-gcal-task';
/** A working session dragged to another day in the month (its id). */
export const GCAL_BLOCK_TYPE = 'application/x-planner-gcal-block';

export const isTaskEvent = (event: CalendarEvent): boolean => event.calendarId === GOOGLE_TASKS_CALENDAR && Boolean(event.googleTask);

export const eventColor = (event: CalendarEvent, calendars: Readonly<Record<string, CalendarSubscription>>): string =>
  isTaskEvent(event) ? GOOGLE_TASKS_COLOR : event.google?.color ?? calendars[event.calendarId]?.color ?? '#868e96';

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

/** "Quarter planning, 2pm – 3pm, Monday, October 26" */
export const eventLabel = (event: CalendarEvent, zone: string): string => {
  const start = zonedDateMinutes(event.start, zone);
  const end = zonedDateMinutes(event.end, zone);
  if (event.allDay || isTaskEvent(event)) return `${event.title}, all day, ${longDay(start.date)}`;
  return `${event.title}, ${compactRange(start.minutes, end.date > start.date && end.minutes === 0 ? 1440 : end.minutes)}, ${longDay(start.date)}`;
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
    out.push({ item: { kind: 'event', event }, span, bar: event.allDay || isTaskEvent(event) || span.last > span.first, startMs: event.allDay ? Date.parse(event.start) - 1 : Date.parse(event.start) });
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
