// What the Planner reads from and writes to Google, through GoogleAccounts:
// calendars and their events, working sessions as events, Google Tasks, and
// Gmail messages. Every call is short, since the host restarts a service that
// takes more than 20 seconds to answer.
import type { CalendarEvent } from '../src/domain/ics.ts';
import { gmailUrl, googleEvent, plannerBlockOf, PLANNER_BLOCK_KEY, type GoogleCalendarInfo, type GoogleTaskItem, type GoogleTaskList, type MailItem, type RawGoogleEvent } from '../src/domain/google.ts';
import { isDateKey } from '../src/domain/dates.ts';
import type { DateKey } from '../src/domain/types.ts';
import { GoogleError, type GoogleAccounts } from './google.ts';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EVENT_FIELDS = 'items(id,status,summary,location,transparency,start,end,attendees(self,responseStatus),extendedProperties,htmlLink),nextPageToken';
const MAX_EVENT_PAGES = 2;
const MAIL_MAX = 25;

const enc = encodeURIComponent;

/** Map with at most `limit` calls in flight. */
const mapLimited = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
};

const isGone = (error: unknown): boolean => error instanceof GoogleError && error.status === 404;

const color = (value: string | undefined): string => (value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#4285f4');

interface RawTask {
  id?: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
  parent?: string;
  position?: string;
  webViewLink?: string;
  updated?: string;
  deleted?: boolean;
}

/** Google keeps a task's due date as midnight UTC of that day. */
const dueDate = (due: string | undefined): DateKey | null => (due && isDateKey(due.slice(0, 10)) ? due.slice(0, 10) : null);

export const toTaskItem = (raw: RawTask, account: string, listId: string): GoogleTaskItem | null => {
  if (!raw.id || raw.deleted) return null;
  return {
    account,
    listId,
    id: raw.id,
    title: raw.title?.trim() || '(No title)',
    notes: raw.notes ?? '',
    due: dueDate(raw.due),
    completed: raw.status === 'completed',
    parent: raw.parent ?? null,
    position: raw.position ?? '',
    url: raw.webViewLink && /^https:\/\//.test(raw.webViewLink) ? raw.webViewLink : `https://tasks.google.com/task/${enc(raw.id)}`,
    updated: raw.updated ?? '',
  };
};

interface RawMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: { name?: string; value?: string }[] };
}

/** Undo the HTML entities Gmail puts in snippets. */
const plain = (text: string): string =>
  text.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export const toMailItem = (raw: RawMessage, account: string): MailItem | null => {
  if (!raw.id || !raw.threadId) return null;
  const header = (name: string) => raw.payload?.headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? '';
  const internal = Number(raw.internalDate);
  return {
    account,
    id: raw.id,
    threadId: raw.threadId,
    subject: header('subject').trim() || '(No subject)',
    from: header('from').trim(),
    date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : '',
    snippet: plain(raw.snippet ?? ''),
    unread: Boolean(raw.labelIds?.includes('UNREAD')),
    url: gmailUrl(account, raw.threadId),
  };
};

/** One working session as a Google Calendar event, keyed back to the session. */
export interface TimeboxEvent {
  blockId: string;
  taskId: string;
  title: string;
  start: string;
  end: string;
}

export class GoogleData {
  constructor(private readonly accounts: GoogleAccounts) {}

  async calendars(account: string): Promise<GoogleCalendarInfo[]> {
    type Answer = { items?: { id?: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; accessRole?: string }[] };
    const data = await this.accounts.request<Answer>(account, 'GET', `${CALENDAR}/users/me/calendarList?minAccessRole=reader&maxResults=250`);
    return (data?.items ?? []).flatMap((item) =>
      item.id ? [{ account, id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, color: color(item.backgroundColor), primary: Boolean(item.primary), writable: item.accessRole === 'owner' || item.accessRole === 'writer' }] : [],
    );
  }

  /** Events of one calendar between two instants, as drawn, plus the Planner's own session events. */
  async events(account: string, calendarId: string, timeMin: string, timeMax: string, zone: string, subscriptionId: string): Promise<{ events: CalendarEvent[]; sessions: { blockId: string; eventId: string; start: string; end: string }[] }> {
    const events: CalendarEvent[] = [];
    const sessions: { blockId: string; eventId: string; start: string; end: string }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250', fields: EVENT_FIELDS, ...(pageToken ? { pageToken } : {}) });
      const data = await this.accounts.request<{ items?: RawGoogleEvent[]; nextPageToken?: string }>(account, 'GET', `${CALENDAR}/calendars/${enc(calendarId)}/events?${query}`);
      for (const raw of data?.items ?? []) {
        const blockId = plannerBlockOf(raw);
        if (blockId && raw.id && raw.status !== 'cancelled' && raw.start?.dateTime && raw.end?.dateTime) {
          sessions.push({ blockId, eventId: raw.id, start: new Date(raw.start.dateTime).toISOString(), end: new Date(raw.end.dateTime).toISOString() });
        }
        const event = googleEvent(raw, subscriptionId, zone);
        if (event) events.push(event);
      }
      pageToken = data?.nextPageToken;
      if (!pageToken) break;
    }
    return { events, sessions };
  }

  /** Write a working session as an event, or update the one written before; returns its event id. */
  async putTimebox(account: string, calendarId: string, timebox: TimeboxEvent, eventId: string | null): Promise<string> {
    const body = {
      summary: timebox.title,
      start: { dateTime: timebox.start },
      end: { dateTime: timebox.end },
      transparency: 'opaque',
      extendedProperties: { private: { [PLANNER_BLOCK_KEY]: timebox.blockId, plannerTaskId: timebox.taskId } },
    };
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    const data = eventId
      ? await this.accounts.request<{ id?: string }>(account, 'PATCH', `${base}/${enc(eventId)}`, body)
      : await this.accounts.request<{ id?: string }>(account, 'POST', base, { ...body, reminders: { useDefault: false } });
    if (!data?.id) throw new Error('Google did not return the event');
    return data.id;
  }

  async deleteTimebox(account: string, calendarId: string, eventId: string): Promise<void> {
    try {
      await this.accounts.request(account, 'DELETE', `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    } catch (error) {
      // Already gone in Google: nothing left to delete.
      if (!isGone(error)) throw error;
    }
  }

  /** One event as Google has it now; null once it is deleted or cancelled. */
  async event(account: string, calendarId: string, eventId: string): Promise<RawGoogleEvent | null> {
    try {
      const raw = await this.accounts.request<RawGoogleEvent>(account, 'GET', `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
      return raw && raw.status !== 'cancelled' ? raw : null;
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  }

  async taskLists(account: string): Promise<GoogleTaskList[]> {
    const data = await this.accounts.request<{ items?: { id?: string; title?: string }[] }>(account, 'GET', `${TASKS}/users/@me/lists?maxResults=100`);
    return (data?.items ?? []).flatMap((item) => (item.id ? [{ account, id: item.id, title: item.title?.trim() || 'Tasks' }] : []));
  }

  /** A list's open tasks, in the list's order. */
  async tasks(account: string, listId: string): Promise<GoogleTaskItem[]> {
    const data = await this.accounts.request<{ items?: RawTask[] }>(account, 'GET', `${TASKS}/lists/${enc(listId)}/tasks?showCompleted=false&showHidden=false&maxResults=100`);
    return (data?.items ?? [])
      .map((raw) => toTaskItem(raw, account, listId))
      .filter((item): item is GoogleTaskItem => Boolean(item))
      .sort((a, b) => a.position.localeCompare(b.position));
  }

  /** Open tasks due between two days (inclusive) in all of an account's lists. */
  async dueTasks(account: string, from: DateKey, to: DateKey): Promise<GoogleTaskItem[]> {
    const lists = await this.taskLists(account);
    // Google keeps a due date as midnight UTC of that day.
    const query = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100', dueMin: `${from}T00:00:00.000Z`, dueMax: `${to}T23:59:59.999Z` });
    const perList = await mapLimited(lists, 4, async (list) => {
      const data = await this.accounts.request<{ items?: RawTask[] }>(account, 'GET', `${TASKS}/lists/${enc(list.id)}/tasks?${query}`);
      return (data?.items ?? []).map((raw) => toTaskItem(raw, account, list.id)).filter((item): item is GoogleTaskItem => Boolean(item && item.due && !item.completed && item.due >= from && item.due <= to));
    });
    return perList.flat();
  }

  /** The current state of tasks behind linked Planner tasks; ones Google no longer has are left out. */
  async tasksById(account: string, listId: string, ids: readonly string[]): Promise<GoogleTaskItem[]> {
    const found = await mapLimited(ids.slice(0, 50), 5, async (id) => {
      try {
        const raw = await this.accounts.request<RawTask>(account, 'GET', `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}`);
        return raw ? toTaskItem(raw, account, listId) : null;
      } catch (error) {
        if (isGone(error)) return null;
        throw error;
      }
    });
    return found.filter((item): item is GoogleTaskItem => Boolean(item));
  }

  /** Complete or reopen a task, or set or clear its due date. */
  async updateTask(account: string, listId: string, id: string, patch: { completed?: boolean; due?: DateKey | null }): Promise<GoogleTaskItem | null> {
    const body: Record<string, unknown> = {};
    if (patch.completed !== undefined) Object.assign(body, patch.completed ? { status: 'completed' } : { status: 'needsAction', completed: null });
    if (patch.due !== undefined) body.due = patch.due ? `${patch.due}T00:00:00.000Z` : null;
    const raw = await this.accounts.request<RawTask>(account, 'PATCH', `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}`, body);
    return raw ? toTaskItem(raw, account, listId) : null;
  }

  async createTask(account: string, listId: string, task: { title: string; notes?: string; due?: DateKey | null }): Promise<GoogleTaskItem | null> {
    const raw = await this.accounts.request<RawTask>(account, 'POST', `${TASKS}/lists/${enc(listId)}/tasks`, {
      title: task.title,
      ...(task.notes ? { notes: task.notes } : {}),
      ...(task.due ? { due: `${task.due}T00:00:00.000Z` } : {}),
    });
    return raw ? toTaskItem(raw, account, listId) : null;
  }

  /** Messages that match a Gmail search, newest first, with the headers a task needs. */
  async mail(account: string, query: string): Promise<MailItem[]> {
    const list = await this.accounts.request<{ messages?: { id?: string }[] }>(account, 'GET', `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(MAIL_MAX) })}`);
    const ids = (list?.messages ?? []).flatMap((message) => (message.id ? [message.id] : []));
    const metadata = 'format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';
    const messages = await mapLimited(ids, 5, (id) => this.accounts.request<RawMessage>(account, 'GET', `${GMAIL}/messages/${enc(id)}?${metadata}`));
    return messages
      .map((raw) => (raw ? toMailItem(raw, account) : null))
      .filter((item): item is MailItem => Boolean(item))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
}
