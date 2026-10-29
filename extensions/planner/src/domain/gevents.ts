// Changing Google Calendar events: the request bodies for events the Planner
// creates and edits, and the requests a change to a recurring event takes for
// Google Calendar's "This event", "This and following events" and "All events".
// Pure: the service fetches the events, runs the planned requests, and undoes
// a split whose second half fails.
import type { DateKey } from './types.ts';
import { addDays, daysBetween, instantAt, isDateKey, isValidTimeZone, zonedDateMinutes } from './dates.ts';
import { formatRRule, shiftRule, splitRecurrence, untilBefore } from './rrule.ts';
import { EVENT_COLORS, type GoogleResponse, type GoogleTime, type RawAttendee, type RawGoogleEvent } from './google.ts';

export type EditScope = 'this' | 'following' | 'all';
export const EDIT_SCOPES: readonly EditScope[] = ['this', 'following', 'all'];

/** What the Planner sets on an event; a field left out stays as it is. */
export interface EventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  /** Rule lines; empty when it does not repeat. */
  recurrence?: string[];
  /** Guests by email; those already invited keep their answers. */
  attendees?: { email: string; optional?: boolean }[];
  reminders?: { useDefault: boolean; overrides?: { method: 'popup' | 'email'; minutes: number }[] };
  colorId?: string | null;
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private';
  /** Add a Google Meet call, or (false) remove the event's call. */
  meet?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export const isEmailAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value);

const timeKind = (time: unknown): 'date' | 'dateTime' | null => {
  if (!isRecord(time)) return null;
  if (time.date !== undefined) return isDateKey(time.date) && time.dateTime === undefined ? 'date' : null;
  if (typeof time.dateTime !== 'string' || Number.isNaN(Date.parse(time.dateTime))) return null;
  if (time.timeZone !== undefined && !isValidTimeZone(time.timeZone)) return null;
  return 'dateTime';
};

const startMs = (time: GoogleTime): number => (time.date ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime ?? ''));

/** Why `input` cannot go to Google, or null. A new event needs its start and end. */
export const checkEventInput = (input: unknown, creating: boolean): string | null => {
  if (!isRecord(input)) return 'event must be an object';
  const allowed = new Set(['summary', 'description', 'location', 'start', 'end', 'recurrence', 'attendees', 'reminders', 'colorId', 'transparency', 'visibility', 'meet']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) return `unknown event field ${key}`;
  if (input.summary !== undefined && !isText(input.summary, 1024)) return 'the title is too long';
  if (input.description !== undefined && !isText(input.description, 8000)) return 'the description is too long';
  if (input.location !== undefined && !isText(input.location, 1024)) return 'the location is too long';
  if (creating && (input.start === undefined || input.end === undefined)) return 'a new event needs a start and an end';
  if ((input.start === undefined) !== (input.end === undefined)) return 'start and end change together';
  if (input.start !== undefined) {
    const kinds = [timeKind(input.start), timeKind(input.end)];
    if (!kinds[0] || kinds[0] !== kinds[1]) return 'start and end must both be days, or both be times';
    if (startMs(input.end as GoogleTime) <= startMs(input.start as GoogleTime)) return 'the event must end after it starts';
  }
  if (input.recurrence !== undefined) {
    if (!Array.isArray(input.recurrence) || input.recurrence.length > 10) return 'recurrence must be at most 10 lines';
    if (!input.recurrence.every((line) => isText(line, 1000) && /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/i.test(line))) return 'recurrence lines must be RRULE, RDATE or EXDATE';
  }
  if (input.attendees !== undefined) {
    if (!Array.isArray(input.attendees) || input.attendees.length > 200) return 'at most 200 guests';
    if (!input.attendees.every((guest) => isRecord(guest) && isEmailAddress(guest.email) && (guest.optional === undefined || typeof guest.optional === 'boolean'))) return 'a guest is not an email address';
  }
  if (input.reminders !== undefined) {
    const reminders = input.reminders;
    if (!isRecord(reminders) || typeof reminders.useDefault !== 'boolean') return 'reminders must say whether to use the calendar default';
    const overrides = reminders.overrides ?? [];
    if (!Array.isArray(overrides) || overrides.length > 5) return 'at most 5 notifications';
    if (!overrides.every((item) => isRecord(item) && (item.method === 'popup' || item.method === 'email') && Number.isInteger(item.minutes) && (item.minutes as number) >= 0 && (item.minutes as number) <= 40_320)) return 'a notification must be 0 to 40320 minutes before';
  }
  if (input.colorId !== undefined && input.colorId !== null && !(typeof input.colorId === 'string' && EVENT_COLORS[input.colorId])) return 'unknown event color';
  if (input.transparency !== undefined && input.transparency !== 'opaque' && input.transparency !== 'transparent') return 'transparency must be opaque or transparent';
  if (input.visibility !== undefined && !['default', 'public', 'private'].includes(input.visibility as string)) return 'visibility must be default, public or private';
  if (input.meet !== undefined && typeof input.meet !== 'boolean') return 'meet must be true or false';
  return null;
};

const sameTime = (a: GoogleTime | undefined, b: GoogleTime | undefined): boolean =>
  Boolean(a && b) && (a!.date ? a!.date === b!.date : Date.parse(a!.dateTime ?? '') === Date.parse(b!.dateTime ?? ''));

/**
 * The Google event resource that sets `input` on `existing` (null for a new
 * event): guests who stay keep their answers, and `conference` says the
 * request needs conferenceDataVersion=1.
 */
export const eventBody = (input: EventInput, existing: RawGoogleEvent | null, requestId: string): { body: Record<string, unknown>; conference: boolean } => {
  const body: Record<string, unknown> = {};
  let conference = false;
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = input.start;
  if (input.end !== undefined) body.end = input.end;
  if (input.recurrence !== undefined) body.recurrence = input.recurrence;
  if (input.attendees !== undefined) {
    const before = new Map((existing?.attendees ?? []).filter((attendee) => attendee.email).map((attendee) => [attendee.email!.toLowerCase(), attendee]));
    const kept = input.attendees.map((guest) => {
      const known = before.get(guest.email.toLowerCase());
      return known ? { ...known, ...(guest.optional !== undefined ? { optional: guest.optional } : {}) } : { email: guest.email, ...(guest.optional ? { optional: true } : {}) };
    });
    // The organizer stays on the list (Google keeps the organizer's own entry), as do rooms.
    const wanted = new Set(kept.map((guest) => guest.email!.toLowerCase()));
    const staying = (existing?.attendees ?? []).filter((attendee) => attendee.email && !wanted.has(attendee.email.toLowerCase()) && (attendee.organizer || attendee.self || attendee.resource));
    body.attendees = [...staying, ...kept];
  }
  if (input.reminders !== undefined) body.reminders = input.reminders.useDefault ? { useDefault: true } : { useDefault: false, overrides: input.reminders.overrides ?? [] };
  if (input.colorId !== undefined) body.colorId = input.colorId;
  if (input.transparency !== undefined) body.transparency = input.transparency;
  if (input.visibility !== undefined) body.visibility = input.visibility;
  if (input.meet === true && !existing?.conferenceData && !existing?.hangoutLink) {
    body.conferenceData = { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    conference = true;
  } else if (input.meet === false && (existing?.conferenceData || existing?.hangoutLink)) {
    body.conferenceData = null;
    conference = true;
  }
  return { body, conference };
};

/** One request of a planned change. */
export interface EventOp {
  method: 'POST' | 'PATCH' | 'DELETE';
  /** The event it is about; null for a new one. */
  eventId: string | null;
  body?: Record<string, unknown>;
  /** Needs conferenceDataVersion=1. */
  conference?: boolean;
  /** A series made by "This and following": deleted again when the step after it fails. */
  role: 'change' | 'create' | 'truncate' | 'delete';
}

export type EventPlan = { ops: EventOp[] } | { error: string; needs?: 'priorCount' };

type Identified = RawGoogleEvent & { id: string };

const localOf = (time: GoogleTime | undefined, zone: string): { date: DateKey; minutes: number } | null => {
  if (!time) return null;
  if (time.date) return isDateKey(time.date) ? { date: time.date, minutes: 0 } : null;
  const ms = Date.parse(time.dateTime ?? '');
  return Number.isNaN(ms) ? null : zonedDateMinutes(ms, zone);
};

/**
 * A new start and end of one occurrence, as the series' own start and end:
 * the same move in days and the same clock time, so "All events" follow it.
 */
const seriesTimes = (instance: Identified, series: Identified, start: GoogleTime, end: GoogleTime, zone: string): { start: GoogleTime; end: GoogleTime; from: DateKey; to: DateKey } | null => {
  const original = localOf(instance.originalStartTime ?? instance.start, zone);
  const moved = localOf(start, zone);
  const first = localOf(series.start, zone);
  if (!original || !moved || !first) return null;
  const days = daysBetween(original.date, moved.date);
  const firstDay = addDays(first.date, days);
  if (start.date && end.date) {
    return { start: { date: firstDay }, end: { date: addDays(firstDay, Math.max(1, daysBetween(start.date, end.date))) }, from: original.date, to: moved.date };
  }
  const length = Date.parse(end.dateTime ?? '') - Date.parse(start.dateTime ?? '');
  const zoneOf = series.start?.timeZone ?? start.timeZone ?? zone;
  const begin = instantAt(firstDay, moved.minutes, zone);
  return {
    start: { dateTime: begin, timeZone: zoneOf },
    end: { dateTime: new Date(Date.parse(begin) + length).toISOString(), timeZone: zoneOf },
    from: original.date,
    to: moved.date,
  };
};

const sameLines = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** The fields a new series copies from the one it splits off from. */
const seriesCopy = (series: Identified): RawGoogleEvent => {
  const copy: RawGoogleEvent = {};
  for (const key of ['summary', 'description', 'location', 'colorId', 'transparency', 'visibility', 'guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests', 'reminders', 'conferenceData'] as const) {
    if (series[key] !== undefined) (copy as Record<string, unknown>)[key] = series[key];
  }
  if (series.attendees) copy.attendees = series.attendees.map(({ email, displayName, optional, resource, organizer, self }) => ({ email, ...(displayName ? { displayName } : {}), ...(optional ? { optional } : {}), ...(resource ? { resource } : {}), ...(organizer ? { organizer } : {}), ...(self ? { self } : {}) }));
  return copy;
};

/**
 * The requests that apply `input` to an event with `scope`. `instance` is the
 * occurrence that was changed, `series` the series' own event (null for a
 * single event). A split of a series with COUNT needs `priorCount`: how many
 * of its occurrences come before `instance` (the plan says so when missing).
 */
export const planEdit = (args: { scope: EditScope; instance: Identified; series: Identified | null; input: EventInput; zone: string; requestId: string; priorCount?: number }): EventPlan => {
  const { scope, instance, series, input, zone, requestId } = args;
  if (!instance.recurringEventId) {
    const { body, conference } = eventBody(input, instance, requestId);
    return { ops: [{ method: 'PATCH', eventId: instance.id, body, conference, role: 'change' }] };
  }
  if (!series) return { error: 'The series this event belongs to is gone from Google Calendar' };
  const changesRule = input.recurrence !== undefined && !sameLines(input.recurrence, series.recurrence);
  if (scope === 'this') {
    if (changesRule) return { error: 'One event of a series cannot repeat on its own: choose "This and following events" or "All events"' };
    const { recurrence: _drop, ...rest } = input;
    const { body, conference } = eventBody(rest, instance, requestId);
    return { ops: [{ method: 'PATCH', eventId: instance.id, body, conference, role: 'change' }] };
  }
  const original = instance.originalStartTime ?? instance.start;
  const first = sameTime(original, series.start);
  const start = input.start ?? instance.start;
  const end = input.end ?? instance.end;
  const timesChanged = input.start !== undefined && start && end && !(sameTime(start, instance.start) && sameTime(end, instance.end));
  const { rule, rest } = splitRecurrence(series.recurrence ?? []);

  if (scope === 'all' || first) {
    const next: EventInput = { ...input };
    if (timesChanged) {
      const moved = seriesTimes(instance, series, start!, end!, zone);
      if (!moved) return { error: 'Google did not say when this series starts' };
      next.start = moved.start;
      next.end = moved.end;
      if (moved.from !== moved.to && !changesRule) {
        const shifted = rule ? shiftRule(rule, moved.from, moved.to) : null;
        if (!shifted) return { error: 'This series repeats in a way the Planner cannot move to another day: move "This event" only, or change the repeat rule in the editor' };
        next.recurrence = [formatRRule(shifted), ...rest];
      }
    } else {
      delete next.start;
      delete next.end;
    }
    const { body, conference } = eventBody(next, series, requestId);
    return { ops: [{ method: 'PATCH', eventId: series.id, body, conference, role: 'change' }] };
  }

  // This and following: the series ends before this occurrence, and a new one starts with it.
  if (!rule) return { error: 'This series repeats in a way the Planner cannot split: change "This event" or "All events"' };
  const until = untilBefore(original ?? {});
  if (!until) return { error: 'Google did not say when this event first was' };
  let lines: string[];
  if (changesRule) lines = input.recurrence ?? [];
  else {
    let next = rule;
    if (rule.count !== null) {
      if (args.priorCount === undefined) return { error: 'How many events come before this one is needed to split the series', needs: 'priorCount' };
      const remaining = rule.count - args.priorCount;
      if (remaining < 1) return { error: 'This series has no events from this one on' };
      next = { ...rule, count: remaining };
    }
    if (timesChanged) {
      const from = localOf(original, zone);
      const to = localOf(start, zone);
      const shifted = from && to ? shiftRule(next, from.date, to.date) : null;
      if (!shifted) return { error: 'This series repeats in a way the Planner cannot move to another day: move "This event" only' };
      next = shifted;
    }
    lines = [formatRRule(next), ...rest];
  }
  const copied = seriesCopy(series);
  const created = eventBody({ ...input, start, end, recurrence: lines }, copied, requestId);
  const body: Record<string, unknown> = { ...copied, ...created.body };
  // A copied call needs conferenceDataVersion=1 too; a removed one is simply left out.
  if (body.conferenceData === null) delete body.conferenceData;
  const conference = created.conference || Boolean(body.conferenceData);
  return {
    ops: [
      { method: 'POST', eventId: null, body, conference, role: 'create' },
      { method: 'PATCH', eventId: series.id, body: { recurrence: [formatRRule({ ...rule, count: null, until }), ...rest] }, role: 'truncate' },
    ],
  };
};

/** The requests that delete an event with `scope`. */
export const planDelete = (args: { scope: EditScope; instance: Identified; series: Identified | null }): EventPlan => {
  const { scope, instance, series } = args;
  if (!instance.recurringEventId || scope === 'this') return { ops: [{ method: 'DELETE', eventId: instance.id, role: 'delete' }] };
  if (!series) return { error: 'The series this event belongs to is gone from Google Calendar' };
  const original = instance.originalStartTime ?? instance.start;
  if (scope === 'all' || sameTime(original, series.start)) return { ops: [{ method: 'DELETE', eventId: series.id, role: 'delete' }] };
  const { rule, rest } = splitRecurrence(series.recurrence ?? []);
  const until = untilBefore(original ?? {});
  if (!rule || !until) return { error: 'This series repeats in a way the Planner cannot end early: delete "This event" or "All events"' };
  return { ops: [{ method: 'PATCH', eventId: series.id, body: { recurrence: [formatRRule({ ...rule, count: null, until }), ...rest] }, role: 'truncate' }] };
};

/**
 * The request that answers an invitation, for this occurrence or (scope 'all') the whole series; with `comment`, the
 * note the organizer gets with the answer (as "Automatically decline meetings" sends its message).
 */
export const planRsvp = (args: { scope: 'this' | 'all'; instance: Identified; series: Identified | null; response: GoogleResponse; comment?: string }): EventPlan => {
  const target = args.scope === 'all' && args.series ? args.series : args.instance;
  const attendees = target.attendees ?? [];
  if (!attendees.some((attendee) => attendee.self)) return { error: "You are not on this event's guest list" };
  const answer = (attendee: RawAttendee) => ({ ...attendee, responseStatus: args.response, ...(args.comment ? { comment: args.comment } : {}) });
  return { ops: [{ method: 'PATCH', eventId: target.id, body: { attendees: attendees.map((attendee) => (attendee.self ? answer(attendee) : attendee)) }, role: 'change' }] };
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (text: string): string =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (match, name: string) => {
    if (ENTITIES[name.toLowerCase()]) return ENTITIES[name.toLowerCase()]!;
    if (name.startsWith('#')) {
      const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return match;
  });

/**
 * An event description as plain text: Google Calendar writes HTML (line
 * breaks, lists, links), which is shown as text, never as markup.
 */
export const descriptionText = (value: string): string => {
  if (!/<[a-z!/]/i.test(value)) return decode(value).trim();
  return decode(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(ul|ol)(\s[^>]*)?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<a\s[^>]*href="(https?:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, text: string) => {
        const label = text.replace(/<[^>]+>/g, '').trim();
        return !label || label === href ? href : `${label} (${href})`;
      })
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
