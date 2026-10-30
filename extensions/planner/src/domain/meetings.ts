// Sunsama's meeting import (help.sunsama.com/docs/usage-guides/importing-meetings): calendar events become tasks,
// suggested in daily planning ("Show prompt") or added by themselves ahead of time ("Auto-sync"), from the calendars
// chosen (else, for the suggestions, the ones shown), leaving out the kinds of events excluded. An event added by
// itself follows its event (moved, renamed) and goes when it no longer qualifies, unless its time was recorded; one
// the user removed is never added again. A task added from an event is completed when the event ends (always, never,
// or only one with other invitees), unless its timer is running.
import type { EventBody, NewTask, PlannerEvent } from './events.ts';
import { applyEvents } from './reducer.ts';
import type { CalendarEvent } from './ics.ts';
import { addDays, zonedDateMinutes } from './dates.ts';
import { tasksForDay } from './selectors.ts';
import type { CalendarSubscription, DateKey, MeetingExclusion, PlannerState, Settings, Task, TaskSourceRef } from './types.ts';

export const MEETING_EXCLUSION_LABELS: Record<MeetingExclusion, string> = {
  noAttendees: 'Exclude events without other attendees',
  nonBlocking: 'Exclude non-blocking events',
  oooHold: 'Exclude events with "OOO" or "HOLD" in title',
  unconfirmed: 'Exclude events where attendance is not confirmed',
  multiDayAllDay: 'Exclude multi-day, all-day events',
};

/** How far ahead auto-sync adds meetings: today and the six days after. */
export const MEETING_SYNC_DAYS = 7;

/** The key an event task keeps for its event: the account, the calendar and the occurrence. */
export const eventKey = (event: Pick<CalendarEvent, 'google'>): string | null => (event.google ? `${event.google.account}|${event.google.calendarId}|${event.google.eventId}` : null);

const DAY_MS = 86_400_000;

/** Which exclusion leaves an event out, or null when it qualifies. Declined meetings never do. */
export const excludedBy = (event: CalendarEvent, exclusions: readonly MeetingExclusion[]): MeetingExclusion | 'declined' | null => {
  const response = event.google?.response ?? null;
  if (response === 'declined') return 'declined';
  if (exclusions.includes('noAttendees') && !event.google?.guests) return 'noAttendees';
  if (exclusions.includes('nonBlocking') && event.transparent) return 'nonBlocking';
  if (exclusions.includes('oooHold') && /\b(OOO|HOLD)\b/i.test(event.title)) return 'oooHold';
  if (exclusions.includes('unconfirmed') && (response === 'needsAction' || response === 'tentative')) return 'unconfirmed';
  if (exclusions.includes('multiDayAllDay') && event.allDay && Date.parse(event.end) - Date.parse(event.start) > DAY_MS + 3_600_000) return 'multiDayAllDay';
  return null;
};

/** The Google calendars meetings come from: the ones chosen; for suggestions, else the ones shown. Auto-sync needs one chosen. */
export const importCalendars = (state: PlannerState, mode: 'suggest' | 'autoSync'): CalendarSubscription[] => {
  const google = Object.values(state.calendars).filter((calendar) => calendar.google);
  const chosen = state.settings.meetingCalendars;
  if (chosen.length) return google.filter((calendar) => chosen.includes(calendar.id));
  return mode === 'suggest' ? google.filter((calendar) => calendar.visible) : [];
};

/** The subscription an event comes from (Google calendars are subscriptions with a `google` part). */
const subscriptionOf = (state: PlannerState, event: CalendarEvent): CalendarSubscription | undefined =>
  Object.values(state.calendars).find((calendar) => calendar.google && event.google && calendar.google.account === event.google.account && calendar.google.calendarId === event.google.calendarId);

/** An event task, made or already in the plan (one removed too, which stays removed). */
export const taskForEvent = (state: PlannerState, key: string): Task | null => Object.values(state.tasks).find((task) => task.source?.kind === 'event' && task.source.id === key) ?? null;

/** The source a task added from an event keeps: its key, the event's address and times, whether others are invited. */
export const eventSource = (event: CalendarEvent, auto: boolean): TaskSourceRef | null => {
  const key = eventKey(event);
  if (!key || !event.google || key.length > 200) return null;
  return {
    kind: 'event',
    id: key,
    key: 'Google Calendar',
    url: event.google.htmlLink || 'https://calendar.google.com/calendar/r',
    title: event.title,
    account: event.google.account,
    event: { calendarId: event.google.calendarId, start: event.start, end: event.end, allDay: event.allDay, invitees: event.google.guests, ...(auto ? { auto: true } : {}) },
  };
};

/** The day an event is on, where the user is. */
export const eventDay = (event: Pick<CalendarEvent, 'start' | 'allDay'>, zone: string): DateKey => zonedDateMinutes(event.start, zone).date;

/** An event task's start, for placing meetings in time order. */
const startOf = (task: Task): number | null => (task.source?.kind === 'event' && task.source.event ? Date.parse(task.source.event.start) : null);

/**
 * Where a meeting goes in its day's list: before the first meeting that starts after it, else after the day's last
 * meeting, else at the top of the day (meetings in time order, as Sunsama's import sorts them).
 */
export const meetingPosition = (state: PlannerState, date: DateKey, start: number): number => {
  const list = tasksForDay(state, date).filter((task) => !task.deletedAt);
  const later = list.findIndex((task) => (startOf(task) ?? -Infinity) > start);
  if (later >= 0) {
    const before = list[later - 1]?.position;
    const at = list[later]!.position;
    return before === undefined ? at - 1024 : (before + at) / 2;
  }
  const meetings = list.map((task, index) => ({ task, index })).filter(({ task }) => startOf(task) !== null);
  const last = meetings.at(-1);
  if (last) {
    const next = list[last.index + 1]?.position;
    return next === undefined ? last.task.position + 1024 : (last.task.position + next) / 2;
  }
  return list.length ? list[0]!.position - 1024 : 1024;
};

/** The task a meeting becomes: its title, its length as planned time (none for an all-day one), on its day. */
export const meetingTask = (state: PlannerState, event: CalendarEvent, options: { id: string; zone: string; auto: boolean; position?: number }): NewTask | null => {
  const source = eventSource(event, options.auto);
  if (!source) return null;
  const date = eventDay(event, options.zone);
  const minutes = event.allDay ? null : Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
  const channelId = importChannel(state, event);
  return {
    id: options.id,
    title: event.title,
    placement: { kind: 'day', date },
    position: options.position ?? meetingPosition(state, date, Date.parse(event.start)),
    ...(minutes && minutes > 0 ? { plannedMinutes: Math.min(minutes, 24 * 60) } : {}),
    ...(channelId ? { channelId } : {}),
    source,
  };
};

/** A calendar's import channel, when it is a live channel. */
const calendarChannel = (state: PlannerState, calendarId: string): string | null => {
  const channelId = state.settings.meetingChannels[calendarId];
  return channelId && state.channels[channelId] && !state.channels[channelId]!.deletedAt ? channelId : null;
};

/** The channel meetings from an event's calendar get ("Import channel"), when it is a live channel. */
const importChannel = (state: PlannerState, event: CalendarEvent): string | null => {
  const subscription = subscriptionOf(state, event);
  return subscription ? calendarChannel(state, subscription.id) : null;
};

/**
 * A calendar's import channel chosen (or changed) with auto-sync on: the meetings auto-sync added from it that have no
 * channel take it, those whose event is today or later and that are not done. The first import starts as the calendar
 * is ticked, before its channel can be chosen. A channel given before (by hand, from another window, by an earlier
 * choice) stays, and so does a past meeting, rolled over to today or not. Besides the import, this is the only time
 * a meeting is given its calendar's channel: a sync never gives one again.
 */
export const planChannelFill = (state: PlannerState, calendarIds: readonly string[], today: DateKey, zone: string): EventBody[] => {
  if (state.settings.meetingImport !== 'autoSync') return [];
  return calendarIds.flatMap((calendarId) => {
    const google = state.calendars[calendarId]?.google;
    const channelId = calendarChannel(state, calendarId);
    if (!google || !channelId || !state.settings.meetingCalendars.includes(calendarId)) return [];
    return Object.values(state.tasks).flatMap((task): EventBody[] => {
      const event = task.source?.kind === 'event' ? task.source.event : undefined;
      if (!event?.auto || task.channelId || task.completedAt || task.deletedAt || task.archivedAt) return [];
      if (task.source!.account !== google.account || event.calendarId !== google.calendarId || eventDay(event, zone) < today) return [];
      return [{ type: 'task.updated', taskId: task.id, patch: { channelId } }];
    });
  });
};

/**
 * Adding one meeting by hand ("Add to tasks"): a task for it on its day, by its start time. One removed before comes
 * back (Sunsama: a removed meeting is imported again by hand), from then on the user's own, which auto-sync leaves be.
 */
export const addMeetingCommands = (state: PlannerState, event: CalendarEvent, zone: string, newId: () => string): EventBody[] => {
  const key = eventKey(event);
  if (!key) return [];
  const known = taskForEvent(state, key);
  if (known && !known.deletedAt) return [];
  const date = eventDay(event, zone);
  if (known) {
    const source = eventSource(event, false)!;
    return [
      { type: 'task.restored', taskId: known.id },
      { type: 'task.moved', taskId: known.id, placement: { kind: 'day', date }, position: meetingPosition(state, date, Date.parse(event.start)) },
      { type: 'task.updated', taskId: known.id, patch: { title: event.title, source } },
    ];
  }
  const task = meetingTask(state, event, { id: newId(), zone, auto: false });
  return task ? [{ type: 'task.created', task }] : [];
};

/** Several meetings added at once (daily planning's import): in start order, each placed by its start time. */
export const addMeetingsCommands = (state: PlannerState, events: readonly CalendarEvent[], zone: string, newId: () => string): EventBody[] => {
  const bodies: EventBody[] = [];
  let working = state;
  for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    for (const body of addMeetingCommands(working, event, zone, newId)) {
      bodies.push(body);
      working = applyLocally(working, body);
    }
  }
  return bodies;
};

/** A day's meetings as daily planning suggests them: each one's key, whether it is in the plan, and what excludes it. */
export interface MeetingSuggestion {
  event: CalendarEvent;
  key: string;
  /** In the plan already (or removed from it). */
  task: Task | null;
  excluded: MeetingExclusion | 'declined' | null;
}

export const meetingSuggestions = (state: PlannerState, events: readonly CalendarEvent[], date: DateKey, zone: string): MeetingSuggestion[] => {
  const calendars = new Set(importCalendars(state, 'suggest').map((calendar) => calendar.id));
  return events
    .flatMap((event): MeetingSuggestion[] => {
      const key = eventKey(event);
      const subscription = subscriptionOf(state, event);
      if (!key || !subscription || !calendars.has(subscription.id) || eventDay(event, zone) !== date || event.googleTask || event.upcoming || event.pendingTasks) return [];
      return [{ event, key, task: taskForEvent(state, key), excluded: excludedBy(event, state.settings.meetingExclusions) }];
    })
    .sort((a, b) => a.event.start.localeCompare(b.event.start));
};

/** Has time been recorded on a task (its timer ran, or time was entered)? Such an added meeting stays. */
const hasTime = (state: PlannerState, taskId: string): boolean => Object.values(state.entries).some((entry) => entry.taskId === taskId);

/**
 * Auto-sync for the days `from`..`from`+days-1: the qualifying events of the chosen calendars not yet in the plan
 * become tasks, in their calendar's import channel; the ones it added follow their event (day, title, times) and go
 * when the event no longer qualifies or is gone, unless they were completed or have time recorded; any task the user
 * removed stays removed. A sync never gives a channel to one it added before: a channel cleared by hand stays cleared,
 * and one chosen for its calendar later reaches it when chosen (planChannelFill).
 */
export const planMeetingSync = (state: PlannerState, events: readonly CalendarEvent[], options: { from: DateKey; days: number; zone: string; newId: () => string; read?: ReadonlySet<string> }): EventBody[] => {
  if (state.settings.meetingImport !== 'autoSync') return [];
  const calendars = new Set(importCalendars(state, 'autoSync').map((calendar) => calendar.id));
  // The chosen calendars read this time: a meeting of one that could not be read stays.
  const read = options.read ?? calendars;
  const days = new Set(Array.from({ length: options.days }, (_, index) => addDays(options.from, index)));
  const bodies: EventBody[] = [];
  let working = state;
  const qualifying = new Map<string, CalendarEvent>();
  for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    const key = eventKey(event);
    const subscription = subscriptionOf(state, event);
    if (!key || !subscription || !calendars.has(subscription.id) || !days.has(eventDay(event, options.zone)) || excludedBy(event, state.settings.meetingExclusions)) continue;
    qualifying.set(key, event);
  }
  const push = (body: EventBody) => {
    bodies.push(body);
    working = applyLocally(working, body);
  };
  for (const [key, event] of qualifying) {
    const task = taskForEvent(working, key);
    if (!task) {
      const made = meetingTask(working, event, { id: options.newId(), zone: options.zone, auto: true });
      if (made) push({ type: 'task.created', task: made });
      continue;
    }
    // Only the ones it added follow their event, while open.
    if (task.deletedAt || task.completedAt || !task.source?.event?.auto) continue;
    const date = eventDay(event, options.zone);
    const source = eventSource(event, true)!;
    const changed = task.title !== event.title || task.source.event.start !== event.start || task.source.event.end !== event.end;
    if (task.placement.kind !== 'day' || task.placement.date !== date) push({ type: 'task.moved', taskId: task.id, placement: { kind: 'day', date }, position: meetingPosition(working, date, Date.parse(event.start)) });
    if (changed) {
      const minutes = event.allDay ? null : Math.min(24 * 60, Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000));
      push({ type: 'task.updated', taskId: task.id, patch: { title: event.title, source, ...(minutes && minutes > 0 ? { plannedMinutes: minutes } : {}) } });
    }
  }
  for (const task of Object.values(working.tasks)) {
    const event = task.source?.kind === 'event' ? task.source.event : undefined;
    if (!event?.auto || task.deletedAt || task.completedAt || qualifying.has(task.source!.id)) continue;
    // Only within the days read, and never one with its time recorded.
    if (task.placement.kind !== 'day' || !days.has(task.placement.date) || hasTime(working, task.id)) continue;
    const calendar = Object.values(state.calendars).find((item) => item.google && task.source!.account === item.google.account && item.google.calendarId === event.calendarId);
    // Gone from a calendar read this time, or its calendar no longer chosen (or gone): it goes. One of a chosen calendar
    // that could not be read stays.
    if (calendar && calendars.has(calendar.id) && !read.has(calendar.id)) continue;
    push({ type: 'task.deleted', taskId: task.id });
  }
  return bodies;
};

/** Meetings whose event has ended are completed, as the setting says, unless their timer is running. */
export const planMeetingCompletion = (state: PlannerState, now: number, zone: string, mode: Settings['meetingAutoComplete'] = state.settings.meetingAutoComplete): EventBody[] => {
  if (mode === 'never') return [];
  return Object.values(state.tasks).flatMap((task): EventBody[] => {
    const event = task.source?.kind === 'event' ? task.source.event : undefined;
    if (!event || task.completedAt || task.deletedAt || task.archivedAt || Date.parse(event.end) > now) return [];
    if (mode === 'invitees' && !event.invitees) return [];
    if (state.timer?.taskId === task.id) return [];
    return [{ type: 'task.completed', taskId: task.id, on: zonedDateMinutes(Math.min(Date.parse(event.end), now) - 1, zone).date }];
  });
};

/** Auto-sync sees its own work while it plans: each change applied as the plan would apply it. */
const applyLocally = (state: PlannerState, body: EventBody): PlannerState => applyEvents(state, [{ v: 1, id: `meeting-sync-${state.version}-${body.type}`, at: new Date().toISOString(), ...body } as PlannerEvent]);
