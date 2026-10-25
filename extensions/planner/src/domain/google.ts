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
}

export interface GoogleTaskList {
  account: string;
  id: string;
  title: string;
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

/** A Google Calendar event, the part the Planner reads. */
export interface RawGoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
  htmlLink?: string;
}

/**
 * An event as the calendar draws it, or null when it is not shown: cancelled,
 * declined by me, or one of the Planner's own working sessions (those show as
 * sessions already). All-day events run midnight to midnight in `zone` and do
 * not block time, as with ICS feeds.
 */
export const googleEvent = (event: RawGoogleEvent, calendarId: string, zone: string): CalendarEvent | null => {
  if (!event.id || event.status === 'cancelled') return null;
  if (event.extendedProperties?.private?.[PLANNER_BLOCK_KEY]) return null;
  if (event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined')) return null;
  const base = { id: `${calendarId}:${event.id}`, calendarId, title: event.summary?.trim() || '(No title)', location: event.location ?? '' };
  if (event.start?.date && isDateKey(event.start.date)) {
    const endDate = event.end?.date && isDateKey(event.end.date) && event.end.date > event.start.date ? event.end.date : null;
    const start = instantAt(event.start.date, 0, zone);
    const end = endDate ? instantAt(endDate, 0, zone) : new Date(Date.parse(start) + 86_400_000).toISOString();
    return { ...base, start, end, allDay: true, busy: false };
  }
  const startMs = Date.parse(event.start?.dateTime ?? '');
  const endMs = Date.parse(event.end?.dateTime ?? '');
  if (Number.isNaN(startMs)) return null;
  return { ...base, start: new Date(startMs).toISOString(), end: new Date(Number.isNaN(endMs) ? startMs : Math.max(endMs, startMs)).toISOString(), allDay: false, busy: event.transparency !== 'transparent' };
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
