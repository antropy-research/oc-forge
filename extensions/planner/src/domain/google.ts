// Google as a source: Calendar events beside the plan, Google Tasks and Gmail
// messages that become tasks, and the rules that keep a linked task in step.
import type { CalendarEvent } from './ics.ts';
import type { DateKey, Placement, PlannerState, Task, TaskSourceRef } from './types.ts';
import type { EventBody, NewTask } from './events.ts';
import { addDays, instantAt, isDateKey } from './dates.ts';

/** A calendar of a connected account, as Google lists it. */
export interface GoogleCalendarInfo {
  account: string;
  id: string;
  name: string;
  color: string;
  primary: boolean;
  /** The account may add and change events there. */
  writable: boolean;
  /** owner, writer, reader or freeBusyReader: Google Calendar lists owned ones under "My calendars". */
  accessRole?: string;
}

export interface GoogleTaskList {
  account: string;
  id: string;
  title: string;
  /** The account's default list ("My Tasks"), which Google does not let anyone delete. */
  isDefault?: boolean;
}

/** A Google task (Google keeps a due date without a time). */
export interface GoogleTaskItem {
  account: string;
  listId: string;
  id: string;
  title: string;
  notes: string;
  due: DateKey | null;
  completed: boolean;
  /** When it was completed (an instant), for the "Completed" section. */
  completedAt?: string | null;
  /** The task it is a subtask of. */
  parent: string | null;
  /** Its place in the list, Google's sortable string. */
  position: string;
  url: string;
  updated: string;
}

/** A Gmail message, by its headers and snippet. */
export interface MailItem {
  account: string;
  id: string;
  threadId: string;
  subject: string;
  from: string;
  /** ISO instant. */
  date: string;
  snippet: string;
  unread: boolean;
  url: string;
}

/** Private key the Planner puts on the Google events it writes for working sessions. */
export const PLANNER_BLOCK_KEY = 'plannerBlockId';

/** A start or end as Google writes it: a day for all-day events, else an instant (and the zone it repeats in). */
export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface RawAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: string;
}

/** A Google Calendar event, the part the Planner reads. */
export interface RawGoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  transparency?: string;
  visibility?: string;
  colorId?: string;
  eventType?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  /** Set on an occurrence of a series. */
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  /** Only on the series' own event. */
  recurrence?: string[];
  attendees?: RawAttendee[];
  attendeesOmitted?: boolean;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  privateCopy?: boolean;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string; label?: string }[]; conferenceSolution?: { name?: string } };
  reminders?: { useDefault?: boolean; overrides?: { method?: string; minutes?: number }[] };
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
}

export type GoogleResponse = 'needsAction' | 'declined' | 'tentative' | 'accepted';
const RESPONSES: readonly string[] = ['needsAction', 'declined', 'tentative', 'accepted'];

/** A Google Calendar event as the calendar views know it: where it lives and what may be done with it. */
export interface GoogleEventRef {
  account: string;
  /** Google's id of its calendar. */
  calendarId: string;
  /** This occurrence's id. */
  eventId: string;
  /** The series it is an occurrence of. */
  recurringEventId: string | null;
  /** Its time and details may be changed: a calendar the account writes to, and the organizer's copy or one guests may modify. */
  editable: boolean;
  /** My answer as a guest; null when I am not one. */
  response: GoogleResponse | null;
  /** Other people are invited, so a change can notify them. */
  guests: boolean;
  /** Its own color (Google's event palette), over its calendar's. */
  color: string | null;
  htmlLink: string;
  /** Its video call, when it has one. */
  meet: string | null;
}

/** Google Calendar's event colors, by colorId, as its color menu shows them. */
export const EVENT_COLORS: Record<string, { name: string; color: string }> = {
  '1': { name: 'Lavender', color: '#7986cb' },
  '2': { name: 'Sage', color: '#33b679' },
  '3': { name: 'Grape', color: '#8e24aa' },
  '4': { name: 'Flamingo', color: '#e67c73' },
  '5': { name: 'Banana', color: '#f6bf26' },
  '6': { name: 'Tangerine', color: '#f4511e' },
  '7': { name: 'Peacock', color: '#039be5' },
  '8': { name: 'Graphite', color: '#616161' },
  '9': { name: 'Blueberry', color: '#3f51b5' },
  '10': { name: 'Basil', color: '#0b8043' },
  '11': { name: 'Tomato', color: '#d50000' },
};

const meetLink = (event: RawGoogleEvent): string | null => {
  const video = event.conferenceData?.entryPoints?.find((point) => point.entryPointType === 'video' && point.uri && /^https:\/\//.test(point.uri))?.uri;
  return video ?? (event.hangoutLink && /^https:\/\//.test(event.hangoutLink) ? event.hangoutLink : null);
};

/** Where an event lives and what this account may do with it there. */
export interface EventSource {
  account: string;
  calendarId: string;
  /** The account's role on the calendar (owner, writer, reader, freeBusyReader). */
  accessRole?: string;
}

const writableRole = (role: string | undefined): boolean => role === 'owner' || role === 'writer';

/** Whether this copy of an event may be moved and changed, as Google Calendar decides it. */
export const eventEditable = (event: RawGoogleEvent, accessRole: string | undefined): boolean => {
  if (!writableRole(accessRole) || event.locked || event.privateCopy) return false;
  if (event.eventType && !['default', 'focusTime', 'outOfOffice'].includes(event.eventType)) return false;
  // Google leaves `self` out when it is false: someone else's invitation is only answered.
  return !event.organizer || event.organizer.self === true || Boolean(event.guestsCanModify);
};

export const eventRef = (event: RawGoogleEvent & { id: string }, source: EventSource): GoogleEventRef => {
  const self = event.attendees?.find((attendee) => attendee.self);
  return {
    account: source.account,
    calendarId: source.calendarId,
    eventId: event.id,
    recurringEventId: event.recurringEventId ?? null,
    editable: eventEditable(event, source.accessRole),
    response: self && !self.organizer && RESPONSES.includes(self.responseStatus ?? '') ? (self.responseStatus as GoogleResponse) : null,
    guests: (event.attendees ?? []).some((attendee) => !attendee.self && !attendee.resource),
    color: event.colorId ? EVENT_COLORS[event.colorId]?.color ?? null : null,
    htmlLink: event.htmlLink && /^https:\/\//.test(event.htmlLink) ? event.htmlLink : '',
    meet: meetLink(event),
  };
};

/**
 * An event as the calendar draws it, or null when it is not shown: cancelled,
 * or one of the Planner's own working sessions (those show as sessions
 * already). One I declined stays, as Google Calendar shows it, but blocks no
 * time. All-day events run midnight to midnight in `zone` and do not block
 * time, as with ICS feeds. With its source, it carries its Google reference.
 */
export const googleEvent = (event: RawGoogleEvent, calendarId: string, zone: string, source?: EventSource): CalendarEvent | null => {
  if (!event.id || event.status === 'cancelled') return null;
  if (event.extendedProperties?.private?.[PLANNER_BLOCK_KEY]) return null;
  const declined = Boolean(event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined'));
  const base = { id: `${calendarId}:${event.id}`, calendarId, title: event.summary?.trim() || '(No title)', location: event.location ?? '', ...(source ? { google: eventRef(event as RawGoogleEvent & { id: string }, source) } : {}) };
  if (event.start?.date && isDateKey(event.start.date)) {
    const endDate = event.end?.date && isDateKey(event.end.date) && event.end.date > event.start.date ? event.end.date : null;
    const start = instantAt(event.start.date, 0, zone);
    const end = endDate ? instantAt(endDate, 0, zone) : new Date(Date.parse(start) + 86_400_000).toISOString();
    return { ...base, start, end, allDay: true, busy: false };
  }
  const startMs = Date.parse(event.start?.dateTime ?? '');
  const endMs = Date.parse(event.end?.dateTime ?? '');
  if (Number.isNaN(startMs)) return null;
  return { ...base, start: new Date(startMs).toISOString(), end: new Date(Number.isNaN(endMs) ? startMs : Math.max(endMs, startMs)).toISOString(), allDay: false, busy: event.transparency !== 'transparent' && !declined };
};

/** A guest of an event, as the details show them. */
export interface GoogleAttendee {
  email: string;
  name: string;
  response: GoogleResponse;
  self: boolean;
  organizer: boolean;
  optional: boolean;
  resource: boolean;
}

export interface GoogleReminder {
  method: 'popup' | 'email';
  minutes: number;
}

/** Everything the details popover and the editor show of an event. */
export interface GoogleEventDetail {
  account: string;
  calendarId: string;
  id: string;
  recurringEventId: string | null;
  title: string;
  /** As Google keeps it: plain text, or HTML when written in Google Calendar. */
  description: string;
  location: string;
  start: GoogleTime;
  end: GoogleTime;
  allDay: boolean;
  /** The series' rule lines (read from its own event for an occurrence). */
  recurrence: string[];
  attendees: GoogleAttendee[];
  attendeesOmitted: boolean;
  organizer: { email: string; name: string; self: boolean } | null;
  meet: { url: string; label: string } | null;
  reminders: { useDefault: boolean; overrides: GoogleReminder[] };
  colorId: string | null;
  transparency: 'opaque' | 'transparent';
  visibility: 'default' | 'public' | 'private' | 'confidential';
  htmlLink: string;
  editable: boolean;
  /** My answer as a guest; null when I am not one. */
  response: GoogleResponse | null;
  eventType: string;
}

export const eventDetail = (event: RawGoogleEvent & { id: string }, source: EventSource, seriesRecurrence: readonly string[] | null): GoogleEventDetail => {
  const ref = eventRef(event, source);
  const conference = meetLink(event);
  const visibility = event.visibility === 'public' || event.visibility === 'private' || event.visibility === 'confidential' ? event.visibility : 'default';
  return {
    account: source.account,
    calendarId: source.calendarId,
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    title: event.summary?.trim() || '(No title)',
    description: event.description ?? '',
    location: event.location ?? '',
    start: event.start ?? {},
    end: event.end ?? {},
    allDay: Boolean(event.start?.date),
    recurrence: [...(event.recurrence ?? seriesRecurrence ?? [])],
    attendees: (event.attendees ?? []).flatMap((attendee) =>
      attendee.email
        ? [{
            email: attendee.email,
            name: attendee.displayName?.trim() || attendee.email,
            response: (RESPONSES.includes(attendee.responseStatus ?? '') ? attendee.responseStatus : 'needsAction') as GoogleResponse,
            self: Boolean(attendee.self),
            organizer: Boolean(attendee.organizer),
            optional: Boolean(attendee.optional),
            resource: Boolean(attendee.resource),
          }]
        : [],
    ),
    attendeesOmitted: Boolean(event.attendeesOmitted),
    organizer: event.organizer?.email ? { email: event.organizer.email, name: event.organizer.displayName?.trim() || event.organizer.email, self: Boolean(event.organizer.self) } : null,
    meet: conference ? { url: conference, label: event.conferenceData?.conferenceSolution?.name ?? 'Google Meet' } : null,
    reminders: {
      useDefault: event.reminders?.useDefault !== false,
      overrides: (event.reminders?.overrides ?? []).flatMap((item) => (typeof item.minutes === 'number' ? [{ method: item.method === 'email' ? ('email' as const) : ('popup' as const), minutes: item.minutes }] : [])),
    },
    colorId: event.colorId ?? null,
    transparency: event.transparency === 'transparent' ? 'transparent' : 'opaque',
    visibility,
    htmlLink: ref.htmlLink,
    editable: ref.editable,
    response: ref.response,
    eventType: event.eventType ?? 'default',
  };
};

/** The Planner's working session an event was written for, if it is one of those. */
export const plannerBlockOf = (event: RawGoogleEvent): string | null => event.extendedProperties?.private?.[PLANNER_BLOCK_KEY] ?? null;

/** The calendar id of Google tasks shown on their due day. */
export const GOOGLE_TASKS_CALENDAR = 'google-tasks';

/** A Google task on its due day, all day long and blocking no time, as Google Calendar shows it. */
export const dueTaskEvent = (item: GoogleTaskItem & { due: DateKey }, zone: string): CalendarEvent => ({
  id: `gtask:${item.listId}:${item.id}`,
  calendarId: GOOGLE_TASKS_CALENDAR,
  title: item.title,
  location: '',
  start: instantAt(item.due, 0, zone),
  end: instantAt(addDays(item.due, 1), 0, zone),
  allDay: true,
  busy: false,
  googleTask: item,
});

// ── Task sources ─────────────────────────────────────────────────────────────

const OPEN = { name: 'Open', type: 'open', color: '#1a73e8' };
const DONE = { name: 'Completed', type: 'completed', color: '#188038' };

export const gtaskSource = (item: GoogleTaskItem): TaskSourceRef => ({
  kind: 'gtask',
  id: item.id,
  key: 'Google Tasks',
  url: item.url,
  title: item.title,
  status: item.completed ? DONE : OPEN,
  account: item.account,
  listId: item.listId,
});

export const taskFromGoogleTask = (item: GoogleTaskItem, id: string, placement: Placement, position: number): NewTask => ({
  id,
  title: item.title,
  placement,
  position,
  ...(item.notes.trim() ? { notes: item.notes.slice(0, 40_000) } : {}),
  ...(item.due ? { dueDate: item.due } : {}),
  source: gtaskSource(item),
});

export const gmailUrl = (account: string, threadId: string): string => `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${encodeURIComponent(threadId)}`;

export const mailSource = (item: MailItem): TaskSourceRef => ({
  kind: 'email',
  id: item.id,
  key: 'Email',
  url: item.url,
  title: item.subject,
  account: item.account,
});

/** A task for a message: its subject, who sent it and what it says, linked back to Gmail. */
export const taskFromMail = (item: MailItem, id: string, placement: Placement, position: number): NewTask => ({
  id,
  title: item.subject.trim() || '(No subject)',
  placement,
  position,
  notes: [`From ${item.from}`, item.snippet].filter(Boolean).join('\n\n').slice(0, 40_000),
  source: mailSource(item),
});

const live = (task: Task): boolean => !task.deletedAt && !task.archivedAt;

/** The live task planning a Google task, an open one before a completed one. */
export const taskForGoogleTask = (state: PlannerState, item: Pick<GoogleTaskItem, 'id'>): Task | null => {
  const linked = Object.values(state.tasks).filter((task) => live(task) && task.source?.kind === 'gtask' && task.source.id === item.id);
  return linked.find((task) => !task.completedAt) ?? linked[0] ?? null;
};

/** The live task made from a message. */
export const taskForMail = (state: PlannerState, item: Pick<MailItem, 'id'>): Task | null => {
  const linked = Object.values(state.tasks).filter((task) => live(task) && task.source?.kind === 'email' && task.source.id === item.id);
  return linked.find((task) => !task.completedAt) ?? linked[0] ?? null;
};

/** Open tasks linked to Google tasks, by account and list, for reading their current state. */
export const linkedGoogleTasks = (state: PlannerState): { account: string; listId: string; ids: string[] }[] => {
  const groups = new Map<string, { account: string; listId: string; ids: string[] }>();
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'gtask' || !source.account || !source.listId || !live(task) || task.completedAt) continue;
    const key = `${source.account}\n${source.listId}`;
    const group = groups.get(key) ?? { account: source.account, listId: source.listId, ids: [] };
    if (!group.ids.includes(source.id)) group.ids.push(source.id);
    groups.set(key, group);
  }
  return [...groups.values()];
};

export interface GoogleSyncOptions {
  today: DateKey;
  /** Complete the task when its Google task is completed. */
  importCompletion: boolean;
}

/**
 * Events that bring linked tasks up to date with their Google tasks. As with
 * Linear, a title follows a rename in Google only while the task still has the
 * title last seen there; a due date likewise.
 */
export const planGoogleTaskSync = (state: PlannerState, items: ReadonlyMap<string, GoogleTaskItem>, options: GoogleSyncOptions): EventBody[] => {
  const bodies: EventBody[] = [];
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'gtask' || !live(task)) continue;
    const item = items.get(source.id);
    if (!item) continue;
    const next = gtaskSource(item);
    const titleFollows = source.title !== undefined && task.title === source.title && item.title !== source.title;
    if (source.title !== next.title || source.status?.type !== next.status?.type || source.url !== next.url) {
      bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: next, ...(titleFollows ? { title: item.title } : {}) });
    }
    if (options.importCompletion && item.completed && !task.completedAt) bodies.push({ type: 'task.completed', taskId: task.id, on: options.today });
  }
  return bodies;
};

// ── Drag payloads ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isGoogleTaskItem = (value: unknown): value is GoogleTaskItem =>
  isRecord(value) && typeof value.account === 'string' && typeof value.listId === 'string' && typeof value.id === 'string' && typeof value.title === 'string' &&
  typeof value.url === 'string' && /^https:\/\//.test(value.url) && typeof value.completed === 'boolean' && (value.due === null || isDateKey(value.due)) && typeof value.notes === 'string';

export const isMailItem = (value: unknown): value is MailItem =>
  isRecord(value) && typeof value.account === 'string' && typeof value.id === 'string' && typeof value.threadId === 'string' && typeof value.subject === 'string' &&
  typeof value.from === 'string' && typeof value.snippet === 'string' && typeof value.url === 'string' && value.url.startsWith('https://mail.google.com/');
