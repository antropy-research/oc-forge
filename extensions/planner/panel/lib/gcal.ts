// The calendar views' Google Calendar side in the panel: what is open (an
// event's details, quick create, the editor, a question such as "This event or
// all events?"), changes on their way to Google (shown at once, then read
// back), the calendar page's view settings, and the requests the service runs.
import { useEffect, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { EditScope, EventInput } from '../../src/domain/gevents.ts';
import type { GoogleEventDetail, GoogleEventRef, GoogleResponse } from '../../src/domain/google.ts';
import type { CalendarMode } from '../../src/domain/gcalendar.ts';
import type { DateKey } from '../../src/domain/types.ts';
import { instantAt, zonedDateMinutes } from '../../src/domain/dates.ts';
import type { PlannerClient } from './client.ts';

/** Where a popover points: the clicked thing's box. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const anchorOf = (element: Element): Anchor => boxAnchor(element.getBoundingClientRect());

export const boxAnchor = (box: DOMRect): Anchor => ({ x: box.left, y: box.top, width: box.width, height: box.height });

export type CalendarPopover =
  | { kind: 'event'; event: CalendarEvent; anchor: Anchor }
  | { kind: 'task'; event: CalendarEvent; anchor: Anchor }
  | { kind: 'day'; date: DateKey; anchor: Anchor; events: CalendarEvent[] };

/** A new event or task being made in quick create: its day(s) and, for a timed one, its minutes. */
export interface Draft {
  kind: 'event' | 'task';
  date: DateKey;
  /** Last day, for an all-day event over several days. */
  endDate: DateKey;
  start: number | null;
  end: number | null;
  anchor: Anchor;
}

export type EditorTarget =
  | { mode: 'new'; draft: Omit<Draft, 'anchor' | 'kind'> & { title?: string; calendar?: { account: string; calendarId: string } | null }; copy?: { event: CalendarEvent; detail: GoogleEventDetail } }
  | { mode: 'edit'; event: CalendarEvent };

/** Google Calendar's snackbar: what just happened, and Undo where it can be undone. */
export interface Snack {
  id: number;
  text: string;
  undo: (() => Promise<void>) | null;
}

export interface Question {
  title: string;
  text?: string;
  /** Radio choices with OK and Cancel (as Google's "Edit recurring event"), or one button each. */
  style: 'radio' | 'buttons';
  choices: { id: string; label: string }[];
  resolve: (choice: string | null) => void;
}

/** A change on its way: where the event shows meanwhile, or that it is gone. */
export interface Pending {
  start?: string;
  end?: string;
  allDay?: boolean;
  title?: string;
  gone?: boolean;
  /** When Google confirmed it; a read begun after that has it. */
  doneAt: number | null;
}

/** The calendar page's choices, kept while the panel is open. */
export interface CalendarPrefs {
  page: 'calendar' | 'tasks';
  mode: CalendarMode;
  anchor: DateKey | null;
  weekends: boolean;
  declined: boolean;
  completedTasks: boolean;
  /** null: as much as the width allows. */
  rail: boolean | null;
  side: boolean | null;
  /** The panel opened last wins when both do not fit. */
  lastOpened: 'rail' | 'side' | null;
  sideTab: 'unscheduled' | 'backlog' | 'linear';
  myCalendarsOpen: boolean;
  otherCalendarsOpen: boolean;
  /** The last calendar an event was made in. */
  lastCalendar: { account: string; calendarId: string } | null;
  /** The last list a task was added to ('' for the Planner only). */
  lastList: string | null;
}

interface CalendarUiState {
  popover: CalendarPopover | null;
  draft: Draft | null;
  editor: EditorTarget | null;
  question: Question | null;
  pending: ReadonlyMap<string, Pending>;
  added: readonly { event: CalendarEvent; doneAt: number | null }[];
  /** Bumped after each write: calendar reads ask Google again. */
  tick: number;
  prefs: CalendarPrefs;
  snack: Snack | null;
}

const SNACK_MS = 8000;

class CalendarUi {
  private state: CalendarUiState = {
    popover: null,
    draft: null,
    editor: null,
    question: null,
    pending: new Map(),
    added: [],
    tick: 0,
    prefs: { page: 'calendar', mode: 'week', anchor: null, weekends: true, declined: true, completedTasks: true, rail: null, side: null, lastOpened: null, sideTab: 'unscheduled', myCalendarsOpen: true, otherCalendarsOpen: true, lastCalendar: null, lastList: null },
    snack: null,
  };
  private readonly listeners = new Set<() => void>();
  private snacks = 0;

  /** Say what happened, with Undo when `undo` is given; it goes after a while. */
  snack(text: string, undo: (() => Promise<void>) | null = null): void {
    const id = ++this.snacks;
    this.set({ snack: { id, text, undo } });
    setTimeout(() => {
      if (this.state.snack?.id === id) this.set({ snack: null });
    }, SNACK_MS);
  }

  get = (): CalendarUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<CalendarUiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  prefs(patch: Partial<CalendarPrefs>): void {
    this.set({ prefs: { ...this.state.prefs, ...patch } });
  }

  open(popover: CalendarPopover | null): void {
    this.set({ popover, draft: null });
  }

  startDraft(draft: Draft | null): void {
    this.set({ draft, popover: null });
  }

  edit(editor: EditorTarget | null): void {
    this.set({ editor, popover: null, draft: null });
  }

  /** Ask, and wait for the answer; null when it is cancelled. */
  ask(question: Omit<Question, 'resolve'>): Promise<string | null> {
    this.state.question?.resolve(null);
    return new Promise((resolve) => this.set({ question: { ...question, resolve: (choice) => {
      this.set({ question: null });
      resolve(choice);
    } } }));
  }

  /** Show a change at once, until a read after Google's answer brings it back. */
  hold(key: string, change: Omit<Pending, 'doneAt'>): void {
    this.set({ pending: new Map(this.state.pending).set(key, { ...change, doneAt: null }) });
  }

  /** Google answered: read again, and stop holding changes once a later read has them. */
  confirm(keys: readonly string[]): void {
    const now = Date.now();
    const pending = new Map(this.state.pending);
    for (const key of keys) {
      const entry = pending.get(key);
      if (entry) pending.set(key, { ...entry, doneAt: now });
    }
    const added = this.state.added.map((entry) => (keys.includes(entry.event.id) ? { ...entry, doneAt: now } : entry));
    this.set({ pending, added, tick: this.state.tick + 1 });
  }

  /** Google refused: show it as it was. */
  drop(keys: readonly string[]): void {
    const pending = new Map(this.state.pending);
    for (const key of keys) pending.delete(key);
    this.set({ pending, added: this.state.added.filter((entry) => !keys.includes(entry.event.id)) });
  }

  /** A new event, shown until a read after Google made it brings it back. */
  add(event: CalendarEvent): void {
    this.set({ added: [...this.state.added, { event, doneAt: null }] });
  }

  /** A read that began at `startedAt` has every change Google confirmed before it. */
  settle(startedAt: number): void {
    const pending = new Map([...this.state.pending].filter(([, entry]) => entry.doneAt === null || entry.doneAt > startedAt));
    const added = this.state.added.filter((entry) => entry.doneAt === null || entry.doneAt > startedAt);
    if (pending.size !== this.state.pending.size || added.length !== this.state.added.length) this.set({ pending, added });
  }

  refresh(): void {
    this.set({ tick: this.state.tick + 1 });
  }
}

export const calendarUi = new CalendarUi();

/** Re-render on every calendar UI change. */
export const useCalendarUi = (): CalendarUiState => {
  const [state, setState] = useState(calendarUi.get());
  useEffect(() => calendarUi.subscribe(() => setState(calendarUi.get())), []);
  return state;
};

/** The events as they will be: changes on their way shown, new ones added, deleted ones gone. */
export const withPending = (events: readonly CalendarEvent[], pending: ReadonlyMap<string, Pending>, added: CalendarUiState['added'], from: string, to: string): CalendarEvent[] => {
  const out: CalendarEvent[] = [];
  for (const event of events) {
    const change = pending.get(event.id);
    if (change?.gone) continue;
    out.push(change ? { ...event, ...(change.start ? { start: change.start } : {}), ...(change.end ? { end: change.end } : {}), ...(change.allDay !== undefined ? { allDay: change.allDay } : {}), ...(change.title ? { title: change.title } : {}) } : event);
  }
  for (const { event } of added) if (event.end > from && event.start < to) out.push(event);
  return out.sort((a, b) => a.start.localeCompare(b.start));
};

// ── Requests ─────────────────────────────────────────────────────────────────

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const eventDetail = (client: PlannerClient, ref: GoogleEventRef): Promise<GoogleEventDetail> =>
  client.call<{ event: GoogleEventDetail }>('GET', `/google/event?${q({ account: ref.account, calendar: ref.calendarId, id: ref.eventId })}`).then((answer) => answer.event);

export const createEvent = (client: PlannerClient, account: string, calendarId: string, event: EventInput, sendUpdates: 'all' | 'none'): Promise<GoogleEventDetail> =>
  client.call<{ event: GoogleEventDetail }>('POST', '/google/events', { account, calendarId, event, sendUpdates }).then((answer) => answer.event);

export const updateEvent = (client: PlannerClient, ref: GoogleEventRef, event: EventInput, scope: EditScope, sendUpdates: 'all' | 'none'): Promise<unknown> =>
  client.call('PATCH', '/google/events', { account: ref.account, calendarId: ref.calendarId, eventId: ref.eventId, event, scope, sendUpdates });

/** Google Calendar's search over the calendars shown: matching events a year back and two ahead, in date order. */
export const searchEvents = (client: PlannerClient, query: string): Promise<{ events: CalendarEvent[]; from: DateKey; to: DateKey; more: boolean; errors: { calendarId: string; message: string }[] }> =>
  client.call('GET', `/calendar/search?${q({ q: query })}`);

/** Delete; `undo` is a token that puts one deleted event or occurrence back for a while (a series has none). */
export const deleteEvent = (client: PlannerClient, ref: GoogleEventRef, scope: EditScope, sendUpdates: 'all' | 'none'): Promise<{ requests: number; undo: string | null }> =>
  client.call('DELETE', `/google/events?${q({ account: ref.account, calendar: ref.calendarId, id: ref.eventId, scope, sendUpdates })}`);

export const restoreEvent = (client: PlannerClient, token: string): Promise<unknown> => client.call('POST', '/google/events/restore', { token });

export const respondToEvent = (client: PlannerClient, ref: GoogleEventRef, response: GoogleResponse, scope: 'this' | 'all'): Promise<unknown> =>
  client.call('POST', '/google/events/respond', { account: ref.account, calendarId: ref.calendarId, eventId: ref.eventId, response, scope });

export const moveEventToCalendar = (client: PlannerClient, ref: GoogleEventRef, destination: string, sendUpdates: 'all' | 'none'): Promise<GoogleEventDetail> =>
  client.call<{ event: GoogleEventDetail }>('POST', '/google/events/move', { account: ref.account, calendarId: ref.calendarId, eventId: ref.eventId, destination, sendUpdates }).then((answer) => answer.event);

// ── Google Calendar's questions ──────────────────────────────────────────────

const SCOPE_LABELS: Record<EditScope, string> = { this: 'This event', following: 'This and following events', all: 'All events' };

/** "Edit recurring event": which occurrences a change is for; null when cancelled. */
export const askScope = async (action: 'edit' | 'delete' | 'respond', scopes: readonly EditScope[] = ['this', 'following', 'all']): Promise<EditScope | null> => {
  const title = action === 'delete' ? 'Delete recurring event' : action === 'respond' ? 'RSVP to recurring event' : 'Edit recurring event';
  const choice = await calendarUi.ask({ title, style: 'radio', choices: scopes.map((scope) => ({ id: scope, label: SCOPE_LABELS[scope] })) });
  return (choice as EditScope | null) ?? null;
};

/** "Send update emails to guests?", as Google Calendar asks before telling them; null when cancelled. */
export const askSend = async (action: 'invite' | 'update' | 'cancel'): Promise<'all' | 'none' | null> => {
  const titles = { invite: 'Send invitation emails to Google Calendar guests?', update: 'Send update emails to existing Google Calendar guests?', cancel: 'Send cancellation emails to Google Calendar guests?' };
  const choice = await calendarUi.ask({ title: titles[action], style: 'buttons', choices: [{ id: 'cancel', label: 'Back' }, { id: 'none', label: "Don't send" }, { id: 'all', label: 'Send' }] });
  return choice === 'all' || choice === 'none' ? choice : null;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** New times for an event: instants, or days for an all-day one (the end day not included, as Google has it). */
export type EventTimes = { allDay: false; start: string; end: string } | { allDay: true; startDate: DateKey; endDate: DateKey };

/**
 * Move or resize a Google event as its new times say, after asking which
 * events of a series and whether to tell the guests; shown moved at once.
 */
export const changeEventTimes = async (client: PlannerClient, event: CalendarEvent, times: EventTimes, zone: string): Promise<void> => {
  const ref = event.google;
  if (!ref) return;
  const scope = ref.recurringEventId ? await askScope('edit') : 'this';
  if (!scope) return;
  const send = ref.guests ? await askSend('update') : 'none';
  if (!send) return;
  calendarUi.hold(event.id, times.allDay ? { start: instantAt(times.startDate, 0, zone), end: instantAt(times.endDate, 0, zone), allDay: true } : { start: times.start, end: times.end, allDay: false });
  const input: EventInput = times.allDay
    ? { start: { date: times.startDate }, end: { date: times.endDate } }
    : { start: { dateTime: times.start, timeZone: zone }, end: { dateTime: times.end, timeZone: zone } };
  try {
    await updateEvent(client, ref, input, scope, send);
    calendarUi.confirm([event.id]);
    // One event can be put back where it was; a change to a series is undone in its editor.
    const before: EventInput = event.allDay
      ? { start: { date: zonedDateMinutes(event.start, zone).date }, end: { date: zonedDateMinutes(event.end, zone).date } }
      : { start: { dateTime: event.start, timeZone: zone }, end: { dateTime: event.end, timeZone: zone } };
    calendarUi.snack(
      'Event saved',
      scope === 'this'
        ? async () => {
            calendarUi.hold(event.id, { start: event.start, end: event.end, allDay: event.allDay });
            try {
              await updateEvent(client, ref, before, 'this', send);
              calendarUi.confirm([event.id]);
            } catch (error) {
              calendarUi.drop([event.id]);
              client.notify(`Google Calendar did not put "${event.title}" back: ${messageOf(error)}`);
            }
          }
        : null,
    );
  } catch (error) {
    calendarUi.drop([event.id]);
    client.notify(`Google Calendar did not move "${event.title}": ${messageOf(error)}`);
  }
};

/** Delete a Google event, asking which events of a series and whether to tell the guests. */
export const removeEvent = async (client: PlannerClient, event: CalendarEvent): Promise<boolean> => {
  const ref = event.google;
  if (!ref) return false;
  const scope = ref.recurringEventId ? await askScope('delete') : 'this';
  if (!scope) return false;
  const send = ref.guests ? await askSend('cancel') : 'none';
  if (!send) return false;
  calendarUi.hold(event.id, { gone: true });
  try {
    const { undo } = await deleteEvent(client, ref, scope, send);
    calendarUi.confirm([event.id]);
    // "Event deleted · Undo", as Google Calendar offers it for one event or occurrence.
    calendarUi.snack(
      scope === 'this' ? 'Event deleted' : 'Events deleted',
      undo
        ? async () => {
            try {
              await restoreEvent(client, undo);
              calendarUi.drop([event.id]);
              calendarUi.refresh();
            } catch (error) {
              client.notify(`Google Calendar did not put "${event.title}" back: ${messageOf(error)}`);
            }
          }
        : null,
    );
    return true;
  } catch (error) {
    calendarUi.drop([event.id]);
    client.notify(`Google Calendar did not delete "${event.title}": ${messageOf(error)}`);
    return false;
  }
};

/** Answer an invitation (asking, for a series, whether for this event or all). */
export const respond = async (client: PlannerClient, event: CalendarEvent, response: GoogleResponse): Promise<boolean> => {
  const ref = event.google;
  if (!ref) return false;
  const scope = ref.recurringEventId ? await askScope('respond', ['this', 'all']) : 'this';
  if (!scope || scope === 'following') return false;
  try {
    await respondToEvent(client, ref, response, scope);
    calendarUi.confirm([]);
    return true;
  } catch (error) {
    client.notify(`Google Calendar did not take the answer: ${messageOf(error)}`);
    return false;
  }
};

/** A new event, shown at once and then as Google has it. */
export const addEvent = async (client: PlannerClient, target: { account: string; calendarId: string; subscriptionId: string | null; color: string }, input: EventInput, sendUpdates: 'all' | 'none', placeholder: Omit<CalendarEvent, 'id' | 'calendarId'>): Promise<GoogleEventDetail> => {
  const id = `new:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  if (target.subscriptionId) calendarUi.add({ ...placeholder, id, calendarId: target.subscriptionId });
  try {
    const created = await createEvent(client, target.account, target.calendarId, input, sendUpdates);
    calendarUi.confirm([id]);
    return created;
  } catch (error) {
    calendarUi.drop([id]);
    throw error;
  }
};
