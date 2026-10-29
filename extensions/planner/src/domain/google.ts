// Google as a source: Calendar events beside the plan, Google Tasks and Gmail
// messages that become tasks, and the rules that keep a linked task in step.
import type { CalendarEvent } from './ics.ts';
import { googleTaskKey, type DateKey, type Placement, type PlannerState, type Task, type TaskSourceRef } from './types.ts';
import { GOOGLE_NOTES_MAX, type EventBody, type NewTask, type PlannerEvent } from './events.ts';
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
  /** What it was made from in another Google product (an email in Gmail, a Keep note), to go back to: Google's, read-only. */
  links?: { type: string; description: string; link: string }[];
  /** A shared task assigned to the account from a Google Doc or a Chat space; it neither repeats nor takes subtasks. */
  assigned?: { surface: 'document' | 'space' | 'other'; link: string | null };
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
  /** The guest's note with their answer. */
  comment?: string;
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
  /** When it was made (an instant). */
  created?: string;
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
/** A link whose Google task is in none of the account's lists any more: deleted in Google. */
export const GONE_STATUS = { name: 'Deleted', type: 'canceled', color: '#80868b' };
/** What the service says when a task is in none of the account's lists. */
export const TASK_GONE = 'This task is no longer in Google Tasks';

/** A Planner title holds at most this much of a Google task's (Google allows 1024 characters). */
const TITLE_MAX = 500;

/** A Google task as a link: where it is now, and its title, details and date as last seen (what a three-way merge compares against). */
export const gtaskSource = (item: GoogleTaskItem): TaskSourceRef => ({
  kind: 'gtask',
  id: item.id,
  key: 'Google Tasks',
  url: item.url,
  title: item.title.slice(0, TITLE_MAX),
  status: item.completed ? DONE : OPEN,
  account: item.account,
  listId: item.listId,
  notes: item.notes.slice(0, GOOGLE_NOTES_MAX),
  due: item.due,
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

/**
 * Google tasks to read again, by account and list: those behind open linked
 * tasks, and repeating ones whose next occurrence is not made yet (so a
 * completion in Google is seen).
 */
export const linkedGoogleTasks = (state: PlannerState): { account: string; listId: string; ids: string[] }[] => {
  const groups = new Map<string, { account: string; listId: string; ids: string[] }>();
  const add = (account: string, listId: string, id: string) => {
    const key = `${account}\n${listId}`;
    const group = groups.get(key) ?? { account, listId, ids: [] };
    if (!group.ids.includes(id)) group.ids.push(id);
    groups.set(key, group);
  };
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'gtask' || !source.account || !source.listId || !live(task) || task.completedAt || source.status?.name === GONE_STATUS.name) continue;
    add(source.account, source.listId, source.id);
  }
  for (const kept of Object.values(state.googleTasks ?? {})) if (kept.repeat && !kept.repeat.next) add(kept.account, kept.listId, kept.taskId);
  return [...groups.values()];
};

/** What a linked task and its Google task keep in step, both ways. */
export type SyncedField = 'title' | 'notes' | 'due';
const SYNCED: readonly SyncedField[] = ['title', 'notes', 'due'];

/** Changes for Google, from a linked task changed in the Planner. */
export interface GoogleTaskWrite {
  /** The Planner task. */
  taskId: string;
  account: string;
  listId: string;
  id: string;
  patch: { title?: string; notes?: string; due?: DateKey | null };
}

export interface GoogleMerge {
  /** Fields the Planner task takes from Google. */
  planner: { title?: string; notes?: string; dueDate?: DateKey | null };
  /** Fields Google takes from the Planner task. */
  google: GoogleTaskWrite['patch'];
  /** Fields changed on both sides since they last agreed. */
  conflicts: SyncedField[];
}

const plannerSide = (task: Task, field: SyncedField): string | null => (field === 'title' ? task.title : field === 'notes' ? task.notes.slice(0, GOOGLE_NOTES_MAX) : task.dueDate);
const googleSide = (item: GoogleTaskItem, field: SyncedField): string | null => (field === 'title' ? item.title.slice(0, TITLE_MAX) : field === 'notes' ? item.notes.slice(0, GOOGLE_NOTES_MAX) : item.due);
const agreed = (source: TaskSourceRef, field: SyncedField): string | null | undefined => (field === 'title' ? source.title : field === 'notes' ? source.notes : source.due);

/**
 * A linked task against its Google task, field by field (title, details,
 * date), with what both last agreed on (the link's base): a field changed on
 * one side only takes that side's value; a field changed on both takes the
 * newer change, Google's `updated` against the Planner's last edit of that
 * field (`editedAt`); an unchanged field is left alone. A link made before
 * the base was kept counts as changed on both sides, so the newer side wins.
 */
export const mergeGoogleTask = (task: Task, item: GoogleTaskItem, editedAt: (field: SyncedField) => string | null): GoogleMerge => {
  const merge: GoogleMerge = { planner: {}, google: {}, conflicts: [] };
  const source = task.source?.kind === 'gtask' ? task.source : null;
  for (const field of SYNCED) {
    const mine = plannerSide(task, field);
    const theirs = googleSide(item, field);
    if (mine === theirs) continue;
    const base = source ? agreed(source, field) : undefined;
    const plannerChanged = base === undefined || mine !== base;
    const googleChanged = base === undefined || theirs !== base;
    let planner = plannerChanged && !googleChanged;
    if (plannerChanged && googleChanged) {
      merge.conflicts.push(field);
      const edited = editedAt(field);
      planner = Boolean(edited && item.updated && Date.parse(edited) > Date.parse(item.updated));
    }
    if (planner) {
      if (field === 'title') merge.google.title = task.title;
      else if (field === 'notes') merge.google.notes = mine ?? '';
      else merge.google.due = task.dueDate;
    } else if (field === 'title') merge.planner.title = theirs ?? task.title;
    else if (field === 'notes') merge.planner.notes = theirs ?? '';
    else merge.planner.dueDate = theirs;
  }
  return merge;
};

/** When the Planner last changed each synced field of a task, from its activity (changes that came from Google do not count). */
export const plannerEditTimes = (events: readonly PlannerEvent[]): Partial<Record<SyncedField, string>> => {
  const times: Partial<Record<SyncedField, string>> = {};
  for (const event of events) {
    if (event.type === 'task.created') for (const field of SYNCED) times[field] = event.at;
    if (event.type !== 'task.updated') continue;
    if (event.patch.title !== undefined) times.title = event.at;
    if (event.patch.notes !== undefined) times.notes = event.at;
    if (event.patch.dueDate !== undefined) times.due = event.at;
  }
  return times;
};

export interface GoogleSyncOptions {
  today: DateKey;
  /** Complete the task when its Google task is completed. */
  importCompletion: boolean;
  /** When the Planner last changed a field of a task, for a field changed on both sides; else the task's last change. */
  editedAt?: (taskId: string, field: SyncedField) => string | null;
}

export interface GoogleSyncPlan {
  /** Events for the Planner: links that follow their Google task (a new list, title, details, date, state), and completions. */
  bodies: EventBody[];
  /** Planner changes Google has not seen yet. */
  writes: GoogleTaskWrite[];
  /** Linked tasks with a field changed on both sides, decided by `editedAt`. */
  conflicts: { taskId: string; fields: SyncedField[] }[];
}

/**
 * Bring linked tasks and their Google tasks into step (`mergeGoogleTask`
 * decides each field): a link follows its task to another list, takes what
 * changed in Google and sends back what changed in the Planner; a completion
 * in Google completes the task when asked to. What the Planner keeps for a
 * Google task follows it to another list too.
 */
export const planGoogleTaskSync = (state: PlannerState, items: ReadonlyMap<string, GoogleTaskItem>, options: GoogleSyncOptions): GoogleSyncPlan => {
  const plan: GoogleSyncPlan = { bodies: [], writes: [], conflicts: [] };
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'gtask' || !live(task)) continue;
    const item = items.get(source.id);
    if (!item || (source.account && item.account !== source.account)) continue;
    const next = gtaskSource(item);
    // A completed task keeps what it was done with; only its link follows.
    const merge = task.completedAt ? { planner: {}, google: {}, conflicts: [] } : mergeGoogleTask(task, item, (field) => options.editedAt?.(task.id, field) ?? task.updatedAt);
    const moved = source.listId !== next.listId || source.url !== next.url;
    const seen = source.title !== next.title || source.notes !== next.notes || source.due !== next.due || source.status?.type !== next.status?.type;
    if (moved || seen || Object.keys(merge.planner).length) plan.bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: next, ...merge.planner });
    if (Object.keys(merge.google).length) plan.writes.push({ taskId: task.id, account: item.account, listId: item.listId, id: item.id, patch: merge.google });
    if (merge.conflicts.length) plan.conflicts.push({ taskId: task.id, fields: merge.conflicts });
    if (options.importCompletion && item.completed && !task.completedAt) plan.bodies.push({ type: 'task.completed', taskId: task.id, on: options.today });
  }
  for (const item of items.values()) {
    const kept = state.googleTasks?.[googleTaskKey(item.account, item.id)];
    if (kept && kept.listId !== item.listId) plan.bodies.push({ type: 'gtask.moved', account: item.account, taskId: item.id, listId: item.listId });
  }
  return plan;
};

/**
 * Where a linked Google task went when Google no longer has it under its id
 * (Google's own apps may give a task moved to another list a new id): the one
 * open task elsewhere with the title, details and date last seen, that no
 * other Planner task links. Null when there is not exactly one.
 */
export const findMovedTask = (source: TaskSourceRef, candidates: readonly GoogleTaskItem[], state: PlannerState): GoogleTaskItem | null => {
  if (source.kind !== 'gtask' || source.title === undefined) return null;
  const matches = candidates.filter(
    (item) => !item.completed && item.account === source.account && item.id !== source.id && item.title.slice(0, TITLE_MAX) === source.title && (source.notes === undefined || item.notes.slice(0, GOOGLE_NOTES_MAX) === source.notes) && (source.due === undefined || item.due === source.due) && !taskForGoogleTask(state, item),
  );
  return matches.length === 1 ? matches[0]! : null;
};

// ── Drag payloads ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isGoogleTaskItem = (value: unknown): value is GoogleTaskItem =>
  isRecord(value) && typeof value.account === 'string' && typeof value.listId === 'string' && typeof value.id === 'string' && typeof value.title === 'string' &&
  typeof value.url === 'string' && /^https:\/\//.test(value.url) && typeof value.completed === 'boolean' && (value.due === null || isDateKey(value.due)) && typeof value.notes === 'string';

export const isMailItem = (value: unknown): value is MailItem =>
  isRecord(value) && typeof value.account === 'string' && typeof value.id === 'string' && typeof value.threadId === 'string' && typeof value.subject === 'string' &&
  typeof value.from === 'string' && typeof value.snippet === 'string' && typeof value.url === 'string' && value.url.startsWith('https://mail.google.com/');
