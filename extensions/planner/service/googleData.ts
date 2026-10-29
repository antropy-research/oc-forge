// What the Planner reads from and writes to Google, through GoogleAccounts:
// calendars and their events (read, created, changed, answered), working
// sessions as events, Google Tasks (lists, tasks, subtasks, order), Gmail
// messages, and Drive files' names to attach to a task. Lists are read page after page; where the Planner stops early it
// says so rather than leaving the rest out quietly. Every call is short, since
// the host restarts a service that takes more than 20 seconds to answer.
import type { CalendarEvent } from '../src/domain/ics.ts';
import {
  eventDetail,
  gmailUrl,
  googleEvent,
  plannerBlockOf,
  PLANNER_BLOCK_KEY,
  TASK_GONE,
  type GoogleCalendarInfo,
  type GoogleEventDetail,
  type GoogleResponse,
  type GoogleTaskItem,
  type GoogleTaskList,
  type MailItem,
  type RawGoogleEvent,
} from '../src/domain/google.ts';
import { checkEventInput, eventBody, planDelete, planEdit, planRsvp, type EditScope, type EventInput, type EventOp, type EventPlan } from '../src/domain/gevents.ts';
import { isDateKey } from '../src/domain/dates.ts';
import { driveQuery, type DriveFile, type Invitation } from '../src/domain/gtaskAdvanced.ts';
import { newId } from '../src/domain/ids.ts';
import type { DateKey, TaskVisibility } from '../src/domain/types.ts';
import { GoogleError, type GoogleAccounts } from './google.ts';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
/** Files a page of a Drive search lists, as a picker's screen; the picker asks for the next page ("More files"). */
const DRIVE_PAGE = 30;
const EVENT_FIELDS =
  'accessRole,nextPageToken,items(id,status,summary,location,transparency,colorId,eventType,start,end,recurringEventId,originalStartTime,attendees(email,self,organizer,resource,responseStatus),organizer(email,self),guestsCanModify,locked,privateCopy,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),extendedProperties,htmlLink)';
/** Pages read at most: Google's page sizes make each limit thousands of items. */
const LIMITS = { calendars: 10, events: 8, lists: 5, tasks: 40, due: 20 } as const;
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
  completed?: string;
  parent?: string;
  position?: string;
  webViewLink?: string;
  updated?: string;
  deleted?: boolean;
  /** What it was made from elsewhere (an email in Gmail, a Keep note): Google's, read-only. */
  links?: { type?: string; description?: string; link?: string }[];
  /** A shared task assigned from Google Docs or a Chat space: Google's, read-only. */
  assignmentInfo?: { linkToTask?: string; surfaceType?: string };
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
    ...(raw.status === 'completed' ? { completedAt: raw.completed ?? null } : {}),
    parent: raw.parent ?? null,
    position: raw.position ?? '',
    url: raw.webViewLink && /^https:\/\//.test(raw.webViewLink) ? raw.webViewLink : `https://tasks.google.com/task/${enc(raw.id)}`,
    updated: raw.updated ?? '',
    ...originsOf(raw),
  };
};

/** Where a task came from in another Google product (Gmail, Keep, a Doc, a Chat space), as Google says it: https links only. */
const originsOf = (raw: RawTask): Pick<GoogleTaskItem, 'links' | 'assigned'> => {
  const https = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000 && /^https:\/\//.test(value);
  const links = (raw.links ?? []).flatMap((link) => (https(link.link) ? [{ type: (link.type ?? '').slice(0, 40), description: (link.description ?? '').slice(0, 300), link: link.link }] : [])).slice(0, 10);
  const info = raw.assignmentInfo;
  const surface = info?.surfaceType === 'DOCUMENT' ? 'document' : info?.surfaceType === 'SPACE' ? 'space' : 'other';
  return { ...(links.length ? { links } : {}), ...(info ? { assigned: { surface, link: https(info.linkToTask) ? info.linkToTask : null } } : {}) };
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

/** Timed events as "Automatically decline meetings" looks at them: my answer, who organizes it, its kind and when it was made. */
const invitationsOf = (items: readonly RawGoogleEvent[]): Invitation[] =>
  items.flatMap((raw) => {
    if (!raw.id || raw.status === 'cancelled' || !raw.start?.dateTime || !raw.end?.dateTime) return [];
    const self = raw.attendees?.find((attendee) => attendee.self);
    const response = self?.responseStatus;
    return [{
      id: raw.id,
      summary: raw.summary ?? '(No title)',
      start: new Date(raw.start.dateTime).toISOString(),
      end: new Date(raw.end.dateTime).toISOString(),
      created: raw.created ?? new Date(0).toISOString(),
      response: response === 'needsAction' || response === 'declined' || response === 'tentative' || response === 'accepted' ? response : null,
      mine: Boolean(raw.organizer?.self || self?.organizer),
      meeting: !raw.eventType || raw.eventType === 'default',
    }];
  });

/** One working session as a Google Calendar event, keyed back to the session. */
export interface TimeboxEvent {
  blockId: string;
  taskId: string;
  title: string;
  start: string;
  end: string;
  /** The visibility of the Google task the session's task plans (kept in the Planner); absent for any other task. */
  visibility?: TaskVisibility;
}

/** Who hears about a change to an event with guests: Google Calendar asks before sending. */
export type SendUpdates = 'all' | 'none';

type Identified = RawGoogleEvent & { id: string };

/** How long a deleted event can be put back ("Undo"); Google Calendar's own offer is shorter. */
const UNDO_MS = 10 * 60_000;
/** What a restored or copied event keeps of the deleted one: what can be written, not Google's own bookkeeping. */
const RESTORED_FIELDS = ['summary', 'description', 'location', 'colorId', 'start', 'end', 'recurrence', 'attendees', 'reminders', 'transparency', 'visibility', 'conferenceData', 'guestsCanInviteOthers', 'guestsCanModify', 'guestsCanSeeOtherGuests', 'anyoneCanAddSelf', 'source', 'extendedProperties'] as const;

/** A deleted event, kept for "Undo": as Google had it just before. */
interface Deleted {
  account: string;
  calendarId: string;
  resource: Identified;
  sendUpdates: SendUpdates;
  at: number;
}

export class GoogleData {
  /** Each calendar's access role, as last read, for telling what may be changed. */
  private readonly roles = new Map<string, string>();
  /** Single events and occurrences deleted lately, by their undo token. */
  private readonly deleted = new Map<string, Deleted>();

  constructor(private readonly accounts: GoogleAccounts) {}

  /** Every page of a Google list, up to `limit` pages; `complete` says whether there was more. */
  private async pages<T>(account: string, url: (pageToken: string | undefined) => string, limit: number): Promise<{ items: T[]; complete: boolean; first: Record<string, unknown> | null }> {
    const items: T[] = [];
    let pageToken: string | undefined;
    let first: Record<string, unknown> | null = null;
    for (let page = 0; page < limit; page++) {
      const data = await this.accounts.request<{ items?: T[]; nextPageToken?: string } & Record<string, unknown>>(account, 'GET', url(pageToken));
      first ??= data;
      items.push(...(data?.items ?? []));
      pageToken = data?.nextPageToken;
      if (!pageToken) return { items, complete: true, first };
    }
    return { items, complete: false, first };
  }

  async calendars(account: string): Promise<GoogleCalendarInfo[]> {
    type Raw = { id?: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; accessRole?: string };
    const { items, complete } = await this.pages<Raw>(account, (token) => `${CALENDAR}/users/me/calendarList?${new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', ...(token ? { pageToken: token } : {}) })}`, LIMITS.calendars);
    if (!complete) throw new GoogleError(502, `${account} has more than ${LIMITS.calendars * 250} calendars; the Planner reads at most that many`);
    return items.flatMap((item) => {
      if (!item.id) return [];
      if (item.accessRole) this.roles.set(`${account}\n${item.id}`, item.accessRole);
      return [{ account, id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, color: color(item.backgroundColor), primary: Boolean(item.primary), writable: item.accessRole === 'owner' || item.accessRole === 'writer', accessRole: item.accessRole ?? 'reader' }];
    });
  }

  /** Events of one calendar between two instants, as drawn, plus the Planner's own session events. */
  async events(account: string, calendarId: string, timeMin: string, timeMax: string, zone: string, subscriptionId: string): Promise<{ events: CalendarEvent[]; sessions: { blockId: string; eventId: string; start: string; end: string }[] }> {
    const events: CalendarEvent[] = [];
    const sessions: { blockId: string; eventId: string; start: string; end: string }[] = [];
    const { items, complete, first } = await this.pages<RawGoogleEvent>(
      account,
      (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events?${new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '2500', fields: EVENT_FIELDS, ...(token ? { pageToken: token } : {}) })}`,
      LIMITS.events,
    );
    if (!complete) throw new GoogleError(502, `More than ${LIMITS.events * 2500} events in this range; the Planner reads at most that many`);
    const accessRole = typeof first?.accessRole === 'string' ? first.accessRole : undefined;
    if (accessRole) this.roles.set(`${account}\n${calendarId}`, accessRole);
    for (const raw of items) {
      const blockId = plannerBlockOf(raw);
      if (blockId && raw.id && raw.status !== 'cancelled' && raw.start?.dateTime && raw.end?.dateTime) {
        sessions.push({ blockId, eventId: raw.id, start: new Date(raw.start.dateTime).toISOString(), end: new Date(raw.end.dateTime).toISOString() });
      }
      const event = googleEvent(raw, subscriptionId, zone, { account, calendarId, accessRole });
      if (event) events.push(event);
    }
    return { events, sessions };
  }

  /**
   * Events of one calendar whose text matches `query`, as Google Calendar's
   * search finds them (Google matches title, place, description and guests),
   * at most two pages; `more` says Google had more.
   */
  async searchEvents(account: string, calendarId: string, query: string, timeMin: string, timeMax: string, zone: string, subscriptionId: string): Promise<{ events: CalendarEvent[]; more: boolean }> {
    const { items, complete, first } = await this.pages<RawGoogleEvent>(
      account,
      (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events?${new URLSearchParams({ q: query, singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250', fields: EVENT_FIELDS, ...(token ? { pageToken: token } : {}) })}`,
      2,
    );
    const accessRole = typeof first?.accessRole === 'string' ? first.accessRole : this.roles.get(`${account}\n${calendarId}`);
    const events: CalendarEvent[] = [];
    for (const raw of items) {
      const event = googleEvent(raw, subscriptionId, zone, { account, calendarId, accessRole });
      if (event) events.push(event);
    }
    return { events, more: !complete };
  }

  /** Write a working session as an event, or update the one written before; returns its event id. */
  async putTimebox(account: string, calendarId: string, timebox: TimeboxEvent, eventId: string | null): Promise<string> {
    const body = {
      summary: timebox.title,
      start: { dateTime: timebox.start },
      end: { dateTime: timebox.end },
      transparency: 'opaque',
      // A private task's sessions show to others as busy, without their title, as Google Calendar shows a private event.
      ...(timebox.visibility ? { visibility: timebox.visibility } : {}),
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

  private async mustEvent(account: string, calendarId: string, eventId: string): Promise<Identified> {
    const raw = await this.event(account, calendarId, eventId);
    if (!raw?.id) throw new GoogleError(404, 'This event is no longer in Google Calendar');
    return raw as Identified;
  }

  /** The account's role on a calendar, read once from Google's calendar list. */
  private async role(account: string, calendarId: string): Promise<string | undefined> {
    const key = `${account}\n${calendarId}`;
    if (!this.roles.has(key)) {
      try {
        await this.calendars(account);
      } catch {
        // Unknown: the event shows as not editable.
      }
    }
    return this.roles.get(key);
  }

  /** Everything the details popover and the editor show of an event, with its series' rule. */
  async eventDetail(account: string, calendarId: string, eventId: string): Promise<GoogleEventDetail> {
    const raw = await this.mustEvent(account, calendarId, eventId);
    let rule: string[] | null = null;
    if (raw.recurringEventId) rule = (await this.event(account, calendarId, raw.recurringEventId))?.recurrence ?? [];
    return eventDetail(raw, { account, calendarId, accessRole: await this.role(account, calendarId) }, rule);
  }

  /** A new event; Google Meet calls are made when asked for. */
  async insertEvent(account: string, calendarId: string, input: EventInput, sendUpdates: SendUpdates): Promise<GoogleEventDetail> {
    const problem = checkEventInput(input, true);
    if (problem) throw new GoogleError(400, problem);
    const { body, conference } = eventBody(input, null, newId());
    const query = new URLSearchParams({ sendUpdates, ...(conference ? { conferenceDataVersion: '1' } : {}) });
    const raw = await this.accounts.request<RawGoogleEvent>(account, 'POST', `${CALENDAR}/calendars/${enc(calendarId)}/events?${query}`, body);
    if (!raw?.id) throw new GoogleError(502, 'Google did not return the event');
    return eventDetail(raw as Identified, { account, calendarId, accessRole: await this.role(account, calendarId) }, null);
  }

  /** How many occurrences of a series come before one of them (cancelled ones count, as COUNT counts them). */
  private async priorCount(account: string, calendarId: string, series: Identified, instance: Identified): Promise<number> {
    const before = instance.originalStartTime?.dateTime ?? (instance.originalStartTime?.date ? `${instance.originalStartTime.date}T00:00:00Z` : null);
    const from = series.start?.dateTime ?? (series.start?.date ? `${series.start.date}T00:00:00Z` : null);
    if (!before || !from) throw new GoogleError(502, 'Google did not say when this series starts');
    const { items, complete } = await this.pages<RawGoogleEvent>(
      account,
      (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(series.id)}/instances?${new URLSearchParams({ timeMin: new Date(Date.parse(from) - 1000).toISOString(), timeMax: new Date(Date.parse(before)).toISOString(), showDeleted: 'true', maxResults: '2500', fields: 'nextPageToken,items(id,originalStartTime)', ...(token ? { pageToken: token } : {}) })}`,
      LIMITS.events,
    );
    if (!complete) throw new GoogleError(502, 'This series is too long to split here');
    return items.filter((item) => Date.parse(item.originalStartTime?.dateTime ?? `${item.originalStartTime?.date ?? ''}T00:00:00Z`) < Date.parse(before)).length;
  }

  /** Run a plan's requests in order; a series made by a split goes again when the split's second step fails. */
  private async run(account: string, calendarId: string, plan: EventPlan, sendUpdates: SendUpdates): Promise<number> {
    if ('error' in plan) throw new GoogleError(400, plan.error);
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    const created: string[] = [];
    for (const op of plan.ops as EventOp[]) {
      const query = new URLSearchParams({ sendUpdates, ...(op.conference ? { conferenceDataVersion: '1' } : {}) });
      try {
        if (op.method === 'POST') {
          const raw = await this.accounts.request<RawGoogleEvent>(account, 'POST', `${base}?${query}`, op.body);
          if (!raw?.id) throw new GoogleError(502, 'Google did not return the new series');
          created.push(raw.id);
        } else if (op.method === 'PATCH') await this.accounts.request(account, 'PATCH', `${base}/${enc(op.eventId!)}?${query}`, op.body);
        else {
          try {
            await this.accounts.request(account, 'DELETE', `${base}/${enc(op.eventId!)}?${query}`);
          } catch (error) {
            if (!isGone(error)) throw error;
          }
        }
      } catch (error) {
        for (const id of created) await this.accounts.request(account, 'DELETE', `${base}/${enc(id)}?sendUpdates=none`).catch(() => {});
        throw error;
      }
    }
    return plan.ops.length;
  }

  /** The event and, for an occurrence, its series' own event. */
  private async withSeries(account: string, calendarId: string, eventId: string): Promise<{ instance: Identified; series: Identified | null }> {
    const instance = await this.mustEvent(account, calendarId, eventId);
    const series = instance.recurringEventId ? ((await this.event(account, calendarId, instance.recurringEventId)) as Identified | null) : null;
    return { instance, series };
  }

  /** Change an event, or with `scope` this occurrence, it and the ones after it, or the whole series. */
  async updateEvent(account: string, calendarId: string, eventId: string, input: EventInput, scope: EditScope, sendUpdates: SendUpdates, zone: string): Promise<number> {
    const problem = checkEventInput(input, false);
    if (problem) throw new GoogleError(400, problem);
    const { instance, series } = await this.withSeries(account, calendarId, eventId);
    const requestId = newId();
    let plan = planEdit({ scope, instance, series, input, zone, requestId });
    if ('needs' in plan && plan.needs === 'priorCount' && series) plan = planEdit({ scope, instance, series, input, zone, requestId, priorCount: await this.priorCount(account, calendarId, series, instance) });
    return this.run(account, calendarId, plan, sendUpdates);
  }

  /**
   * Delete an event, or with `scope` this occurrence, it and the ones after it,
   * or the whole series. One event or one occurrence can be put back for a
   * while (`undo`, a token for `restoreEvent`), as Google Calendar's "Undo" does.
   */
  async deleteEvent(account: string, calendarId: string, eventId: string, scope: EditScope, sendUpdates: SendUpdates): Promise<{ requests: number; undo: string | null }> {
    let found: { instance: Identified; series: Identified | null };
    try {
      found = await this.withSeries(account, calendarId, eventId);
    } catch (error) {
      // Deleted already, here or in Google Calendar.
      if (isGone(error)) return { requests: 0, undo: null };
      throw error;
    }
    const requests = await this.run(account, calendarId, planDelete({ scope, ...found }), sendUpdates);
    if (found.instance.recurringEventId && scope !== 'this') return { requests, undo: null };
    const now = Date.now();
    for (const [token, entry] of this.deleted) if (now - entry.at > UNDO_MS) this.deleted.delete(token);
    const undo = newId();
    this.deleted.set(undo, { account, calendarId, resource: found.instance, sendUpdates, at: now });
    return { requests, undo };
  }

  /**
   * Put back an event deleted here a moment ago. A deleted occurrence is a
   * cancelled exception of its series: confirming it brings it back. A deleted
   * event is written back as confirmed, which Google allows while it keeps the
   * event; once it no longer does, a copy is made. Guests hear of it as they
   * heard of the deletion.
   */
  async restoreEvent(token: string): Promise<void> {
    const entry = this.deleted.get(token);
    this.deleted.delete(token);
    if (!entry || Date.now() - entry.at > UNDO_MS) throw new GoogleError(410, 'This deletion can no longer be undone');
    const { account, calendarId, resource, sendUpdates } = entry;
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    if (resource.recurringEventId) {
      await this.accounts.request(account, 'PATCH', `${base}/${enc(resource.id)}?${new URLSearchParams({ sendUpdates })}`, { status: 'confirmed' });
      return;
    }
    const body: Record<string, unknown> = {};
    for (const field of RESTORED_FIELDS) if (resource[field as keyof RawGoogleEvent] !== undefined) body[field] = resource[field as keyof RawGoogleEvent];
    const query = new URLSearchParams({ sendUpdates, ...(body.conferenceData ? { conferenceDataVersion: '1' } : {}) });
    try {
      await this.accounts.request(account, 'PUT', `${base}/${enc(resource.id)}?${query}`, { ...body, status: 'confirmed' });
    } catch (error) {
      if (!(error instanceof GoogleError) || error.status < 400 || error.status >= 500) throw error;
      await this.accounts.request(account, 'POST', `${base}?${query}`, body);
    }
  }

  /** Answer an invitation, for this occurrence or the whole series; `comment` goes to the organizer with it. */
  async respond(account: string, calendarId: string, eventId: string, response: GoogleResponse, scope: 'this' | 'all', comment?: string): Promise<number> {
    const found = await this.withSeries(account, calendarId, eventId);
    // The organizer hears the answer, as when answering in Google Calendar.
    return this.run(account, calendarId, planRsvp({ scope, response, ...found, ...(comment ? { comment } : {}) }), 'all');
  }

  /**
   * One page of the events on the account's own calendar between two instants, in the order they start, as
   * "Automatically decline meetings" looks at them: each occurrence on its own, with my answer, who organizes it,
   * its kind and when it was made; `next` is the following page's token (null after the last page).
   */
  async invitationPage(account: string, timeMin: string, timeMax: string, pageToken?: string): Promise<{ items: Invitation[]; next: string | null }> {
    const data = await this.accounts.request<{ items?: RawGoogleEvent[]; nextPageToken?: string }>(
      account,
      'GET',
      `${CALENDAR}/calendars/primary/events?${new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '2500', fields: 'nextPageToken,items(id,status,summary,start,end,created,eventType,organizer(email,self),attendees(email,self,organizer,responseStatus))', ...(pageToken ? { pageToken } : {}) })}`,
    );
    return { items: invitationsOf(data?.items ?? []), next: data?.nextPageToken ?? null };
  }

  // ── Google Drive ───────────────────────────────────────────────────────────

  /**
   * A page of the Drive files whose name has `text`, newest first (the newest of all when empty), as Google's Drive
   * picker finds them to attach to a task: their names, types and addresses, never their contents; `next` is the
   * following page's token (null after the last).
   */
  async driveFiles(account: string, text: string, pageToken?: string): Promise<{ files: DriveFile[]; next: string | null }> {
    const query = new URLSearchParams({ q: driveQuery(text), orderBy: 'recency desc', pageSize: String(DRIVE_PAGE), fields: 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)', ...(pageToken ? { pageToken } : {}) });
    const answer = await this.accounts.request<{ files?: { id?: string; name?: string; mimeType?: string; webViewLink?: string; modifiedTime?: string }[]; nextPageToken?: string }>(account, 'GET', `${DRIVE}/files?${query}`);
    const files = (answer?.files ?? []).flatMap((file) =>
      file.id && /^[A-Za-z0-9_-]{1,200}$/.test(file.id) && file.webViewLink && /^https:\/\//.test(file.webViewLink)
        ? [{ id: file.id, title: (file.name ?? '').trim().slice(0, 500) || '(Untitled)', mimeType: (file.mimeType ?? '').slice(0, 200), url: file.webViewLink, ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}) }]
        : [],
    );
    return { files, next: answer?.nextPageToken ?? null };
  }

  /** Move an event (or a whole series) to another of the account's calendars. */
  async moveEvent(account: string, calendarId: string, eventId: string, destination: string, sendUpdates: SendUpdates): Promise<GoogleEventDetail> {
    const instance = await this.mustEvent(account, calendarId, eventId);
    const target = instance.recurringEventId ?? instance.id;
    const raw = await this.accounts.request<RawGoogleEvent>(account, 'POST', `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(target)}/move?${new URLSearchParams({ destination, sendUpdates })}`);
    if (!raw?.id) throw new GoogleError(502, 'Google did not return the event');
    return eventDetail(raw as Identified, { account, calendarId: destination, accessRole: await this.role(account, destination) }, raw.recurrence ?? null);
  }

  // ── Google Tasks ───────────────────────────────────────────────────────────

  async taskLists(account: string): Promise<GoogleTaskList[]> {
    const [{ items, complete }, fallback] = await Promise.all([
      this.pages<{ id?: string; title?: string }>(account, (token) => `${TASKS}/users/@me/lists?${new URLSearchParams({ maxResults: '1000', ...(token ? { pageToken: token } : {}) })}`, LIMITS.lists),
      this.accounts.request<{ id?: string }>(account, 'GET', `${TASKS}/users/@me/lists/%40default`).catch(() => null),
    ]);
    if (!complete) throw new GoogleError(502, `${account} has more than ${LIMITS.lists * 1000} task lists; the Planner reads at most that many`);
    return items.flatMap((item) => (item.id ? [{ account, id: item.id, title: item.title?.trim() || 'Tasks', isDefault: item.id === fallback?.id }] : []));
  }

  async createTaskList(account: string, title: string): Promise<GoogleTaskList> {
    const raw = await this.accounts.request<{ id?: string; title?: string }>(account, 'POST', `${TASKS}/users/@me/lists`, { title });
    if (!raw?.id) throw new GoogleError(502, 'Google did not return the list');
    return { account, id: raw.id, title: raw.title?.trim() || title, isDefault: false };
  }

  async renameTaskList(account: string, listId: string, title: string): Promise<GoogleTaskList> {
    const raw = await this.accounts.request<{ id?: string; title?: string }>(account, 'PATCH', `${TASKS}/users/@me/lists/${enc(listId)}`, { title });
    return { account, id: listId, title: raw?.title?.trim() || title };
  }

  async deleteTaskList(account: string, listId: string): Promise<void> {
    try {
      await this.accounts.request(account, 'DELETE', `${TASKS}/users/@me/lists/${enc(listId)}`);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  /** A list's open tasks, in the list's order. */
  async tasks(account: string, listId: string): Promise<GoogleTaskItem[]> {
    const { items, complete } = await this.pages<RawTask>(account, (token) => `${TASKS}/lists/${enc(listId)}/tasks?${new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100', ...(token ? { pageToken: token } : {}) })}`, LIMITS.tasks);
    if (!complete) throw new GoogleError(502, `This list has more than ${LIMITS.tasks * 100} open tasks; the Planner reads at most that many`);
    return items
      .map((raw) => toTaskItem(raw, account, listId))
      .filter((item): item is GoogleTaskItem => Boolean(item))
      .sort((a, b) => a.position.localeCompare(b.position));
  }

  /**
   * Every task of a list, completed ones too (Google marks tasks completed in
   * its own apps hidden, so those are asked for as well). `complete` is false
   * when the list is longer than the Planner reads.
   */
  async allTasks(account: string, listId: string): Promise<{ tasks: GoogleTaskItem[]; complete: boolean }> {
    const { items, complete } = await this.pages<RawTask>(account, (token) => `${TASKS}/lists/${enc(listId)}/tasks?${new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', ...(token ? { pageToken: token } : {}) })}`, LIMITS.tasks);
    const tasks = items.map((raw) => toTaskItem(raw, account, listId)).filter((item): item is GoogleTaskItem => Boolean(item));
    return { tasks: tasks.sort((a, b) => a.position.localeCompare(b.position)), complete };
  }

  /**
   * Tasks due between two days (inclusive) in all of an account's lists, completed ones too, as Google Calendar shows
   * them; with `open`, only the ones not done (Pending tasks: a year of completed ones would be read for nothing).
   */
  async dueTasks(account: string, from: DateKey, to: DateKey, open = false): Promise<GoogleTaskItem[]> {
    const lists = await this.taskLists(account);
    // Google keeps a due date as midnight UTC of that day.
    const range = { showCompleted: open ? 'false' : 'true', showHidden: open ? 'false' : 'true', maxResults: '100', dueMin: `${from}T00:00:00.000Z`, dueMax: `${to}T23:59:59.999Z` };
    const perList = await mapLimited(lists, 4, async (list) => {
      const { items, complete } = await this.pages<RawTask>(account, (token) => `${TASKS}/lists/${enc(list.id)}/tasks?${new URLSearchParams({ ...range, ...(token ? { pageToken: token } : {}) })}`, LIMITS.due);
      if (!complete) throw new GoogleError(502, `"${list.title}" has more than ${LIMITS.due * 100} tasks due in these days; the Planner reads at most that many`);
      return items.map((raw) => toTaskItem(raw, account, list.id)).filter((item): item is GoogleTaskItem => Boolean(item && item.due && item.due >= from && item.due <= to));
    });
    return perList.flat();
  }

  /** The current state of tasks behind linked Planner tasks; ones Google no longer has are left out. */
  async tasksById(account: string, listId: string, ids: readonly string[]): Promise<GoogleTaskItem[]> {
    const found = await mapLimited(ids, 5, async (id) => {
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

  /**
   * Where tasks are now that their list no longer has them (moved in Google's
   * own apps): the account's other lists are read for them, once.
   */
  async locateTasks(account: string, ids: readonly string[], except: string | null): Promise<GoogleTaskItem[]> {
    const wanted = new Set(ids);
    if (!wanted.size) return [];
    const lists = (await this.taskLists(account)).filter((list) => list.id !== except);
    const read = await mapLimited(lists, 4, (list) => this.allTasks(account, list.id));
    return read.flatMap((list) => list.tasks.filter((task) => wanted.has(task.id)));
  }

  /** Tasks behind linked Planner tasks, where they are now (another list, after a move), and the ones Google no longer has. */
  async linkedTasks(account: string, listId: string, ids: readonly string[]): Promise<{ tasks: GoogleTaskItem[]; missing: string[] }> {
    const here = await this.tasksById(account, listId, ids);
    const gone = ids.filter((id) => !here.some((item) => item.id === id));
    const moved = await this.locateTasks(account, gone, listId);
    return { tasks: [...here, ...moved], missing: gone.filter((id) => !moved.some((item) => item.id === id)) };
  }

  /**
   * Complete or reopen a task, set or clear its due date, rename it or change
   * its details. Written to the list the Planner knows it in; when that list
   * no longer has it (moved in Google's own apps), the task is looked up in
   * the account's other lists once and written there. Its answer says where
   * it is now.
   */
  async updateTask(account: string, listId: string, id: string, patch: { completed?: boolean; due?: DateKey | null; title?: string; notes?: string; deleted?: false }): Promise<GoogleTaskItem | null> {
    const body: Record<string, unknown> = {};
    if (patch.completed !== undefined) Object.assign(body, patch.completed ? { status: 'completed' } : { status: 'needsAction', completed: null });
    if (patch.due !== undefined) body.due = patch.due ? `${patch.due}T00:00:00.000Z` : null;
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.notes !== undefined) body.notes = patch.notes;
    // Google Tasks keeps a deleted task a while (deleted: true): writing false gives it back.
    if (patch.deleted === false) body.deleted = false;
    const write = async (list: string) => {
      const raw = await this.accounts.request<RawTask>(account, 'PATCH', `${TASKS}/lists/${enc(list)}/tasks/${enc(id)}`, body);
      return raw ? toTaskItem(raw, account, list) : null;
    };
    try {
      return await write(listId);
    } catch (error) {
      if (!isGone(error)) throw error;
      const [moved] = await this.locateTasks(account, [id], listId);
      if (!moved) throw new GoogleError(404, TASK_GONE);
      return write(moved.listId);
    }
  }

  /** A new task: at the top of the list, or under `parent`, or right after `previous`. */
  async createTask(account: string, listId: string, task: { title: string; notes?: string; due?: DateKey | null; parent?: string | null; previous?: string | null }): Promise<GoogleTaskItem | null> {
    const query = new URLSearchParams({ ...(task.parent ? { parent: task.parent } : {}), ...(task.previous ? { previous: task.previous } : {}) });
    const raw = await this.accounts.request<RawTask>(account, 'POST', `${TASKS}/lists/${enc(listId)}/tasks${query.size ? `?${query}` : ''}`, {
      title: task.title,
      ...(task.notes ? { notes: task.notes } : {}),
      ...(task.due ? { due: `${task.due}T00:00:00.000Z` } : {}),
    });
    return raw ? toTaskItem(raw, account, listId) : null;
  }

  /** Delete a task (Google deletes its subtasks with it). */
  async deleteTask(account: string, listId: string, id: string): Promise<void> {
    try {
      await this.accounts.request(account, 'DELETE', `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}`);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  /** Put a task under `parent` (null: the top level) right after `previous` (null: first), in this list or `destination`. */
  async moveTask(account: string, listId: string, id: string, target: { parent: string | null; previous: string | null; destination?: string | null }): Promise<GoogleTaskItem | null> {
    const query = new URLSearchParams({
      ...(target.parent ? { parent: target.parent } : {}),
      ...(target.previous ? { previous: target.previous } : {}),
      ...(target.destination && target.destination !== listId ? { destinationTasklist: target.destination } : {}),
    });
    const raw = await this.accounts.request<RawTask>(account, 'POST', `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}/move${query.size ? `?${query}` : ''}`);
    return raw ? toTaskItem(raw, account, target.destination ?? listId) : null;
  }

  // ── Gmail ──────────────────────────────────────────────────────────────────

  /** One page of messages matching a Gmail search, newest first, and where the next page starts. */
  async mail(account: string, query: string, pageToken?: string): Promise<{ messages: MailItem[]; nextPageToken: string | null }> {
    const list = await this.accounts.request<{ messages?: { id?: string }[]; nextPageToken?: string }>(account, 'GET', `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(MAIL_MAX), ...(pageToken ? { pageToken } : {}) })}`);
    const ids = (list?.messages ?? []).flatMap((message) => (message.id ? [message.id] : []));
    const metadata = 'format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';
    const messages = await mapLimited(ids, 5, (id) => this.accounts.request<RawMessage>(account, 'GET', `${GMAIL}/messages/${enc(id)}?${metadata}`));
    return {
      messages: messages
        .map((raw) => (raw ? toMailItem(raw, account) : null))
        .filter((item): item is MailItem => Boolean(item))
        .sort((a, b) => b.date.localeCompare(a.date)),
      nextPageToken: list?.nextPageToken ?? null,
    };
  }
}
