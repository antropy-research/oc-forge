// Read-only iCalendar (RFC 5545) support: parse VEVENTs and expand them into
// concrete occurrences for a date range in the user's zone.
import type { GoogleTaskItem } from './google.ts';
import type { DateKey } from './types.ts';
import { addDays, daysBetween, instantAt, isDateKey, isValidTimeZone, startOfWeek, weekday } from './dates.ts';

/** A DTSTART-like value: local date and minute of day in `zone`, or UTC, or a whole day. */
export interface IcsTime {
  date: DateKey;
  minutes: number;
  /** IANA zone; null for floating time (read in the user's zone). */
  zone: string | null;
  allDay: boolean;
}

export interface VEvent {
  uid: string;
  summary: string;
  location: string;
  start: IcsTime;
  end: IcsTime | null;
  durationMs: number | null;
  rrule: Record<string, string> | null;
  exdates: IcsTime[];
  recurrenceId: IcsTime | null;
  cancelled: boolean;
  /** TRANSP:TRANSPARENT — shown, but does not block time. */
  free: boolean;
}

/** One occurrence, ready to draw. */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  /** A Google task due that day, shown the way Google Calendar shows tasks; planning it links it. */
  googleTask?: GoogleTaskItem;
}

// Windows zone names that Outlook writes into TZID.
const WINDOWS_ZONES: Record<string, string> = {
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'aus eastern standard time': 'Australia/Sydney',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

const resolveZone = (tzid: string | undefined): string | null => {
  if (!tzid) return null;
  const clean = tzid.replace(/^"|"$/g, '').trim();
  if (isValidTimeZone(clean)) return clean;
  const windows = WINDOWS_ZONES[clean.toLowerCase()];
  if (windows) return windows;
  // Some exporters prefix a path, e.g. "/mozilla.org/20050126_1/America/New_York".
  const tail = clean.split('/').slice(-2).join('/');
  return isValidTimeZone(tail) ? tail : null;
};

export const parseIcsTime = (value: string, params: Record<string, string> = {}): IcsTime | null => {
  const text = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (date || params.VALUE === 'DATE') {
    const match = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(text);
    if (!match) return null;
    const key = `${match[1]}-${match[2]}-${match[3]}`;
    return isDateKey(key) ? { date: key, minutes: 0, zone: null, allDay: true } : null;
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(text);
  if (!time) return null;
  const key = `${time[1]}-${time[2]}-${time[3]}`;
  if (!isDateKey(key)) return null;
  const minutes = Number(time[4]) * 60 + Number(time[5]) + Number(time[6] ?? 0) / 60;
  return { date: key, minutes, zone: time[7] ? 'UTC' : resolveZone(params.TZID), allDay: false };
};

/** `PT1H30M`, `P1D`, `P2W` → milliseconds. */
export const parseDurationIcs = (value: string): number | null => {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, w, d, h, m, s] = match;
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
};

const unescapeText = (value: string): string => value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

const parseLine = (line: string): Property | null => {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ':' && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon < 0) return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1);
  }
  return { name: (rawName ?? '').toUpperCase(), params, value: line.slice(colon + 1) };
};

export const parseIcs = (text: string): VEvent[] => {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: VEvent[] = [];
  let current: Partial<VEvent> & { exdates: IcsTime[] } | null = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = { exdates: [] };
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (upper.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (upper.startsWith('END:')) {
      if (upper === 'END:VEVENT' && depth === 0) {
        if (current.start) {
          events.push({
            uid: current.uid ?? `${current.start.date}-${events.length}`,
            summary: current.summary ?? '(No title)',
            location: current.location ?? '',
            start: current.start,
            end: current.end ?? null,
            durationMs: current.durationMs ?? null,
            rrule: current.rrule ?? null,
            exdates: current.exdates,
            recurrenceId: current.recurrenceId ?? null,
            cancelled: current.cancelled ?? false,
            free: current.free ?? false,
          });
        }
        current = null;
      } else depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue; // VALARM and other nested components
    const property = parseLine(line);
    if (!property) continue;
    switch (property.name) {
      case 'UID': current.uid = property.value; break;
      case 'SUMMARY': current.summary = unescapeText(property.value); break;
      case 'LOCATION': current.location = unescapeText(property.value); break;
      case 'DTSTART': current.start = parseIcsTime(property.value, property.params) ?? undefined; break;
      case 'DTEND': current.end = parseIcsTime(property.value, property.params); break;
      case 'DURATION': current.durationMs = parseDurationIcs(property.value); break;
      case 'RECURRENCE-ID': current.recurrenceId = parseIcsTime(property.value, property.params); break;
      case 'STATUS': current.cancelled = property.value.toUpperCase() === 'CANCELLED'; break;
      case 'TRANSP': current.free = property.value.toUpperCase() === 'TRANSPARENT'; break;
      case 'EXDATE':
        for (const value of property.value.split(',')) {
          const time = parseIcsTime(value, property.params);
          if (time) current.exdates.push(time);
        }
        break;
      case 'RRULE': {
        const rule: Record<string, string> = {};
        for (const part of property.value.split(';')) {
          const [key, value] = part.split('=');
          if (key && value) rule[key.toUpperCase()] = value.toUpperCase();
        }
        current.rrule = rule;
        break;
      }
    }
  }
  return events;
};

/** The instant of an IcsTime; floating and all-day values are read in `userZone`. */
export const icsInstant = (time: IcsTime, userZone: string): number =>
  Date.parse(instantAt(time.date, time.allDay ? 0 : time.minutes, time.allDay ? userZone : time.zone ?? userZone));

const WEEKDAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_OCCURRENCES = 5000;

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const keyOf = (year: number, month: number, day: number): DateKey => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Dates of the `n`th (negative from the end) `day` of a month, e.g. 2TU or -1FR. */
const nthWeekdayOfMonth = (year: number, month: number, day: number, n: number): DateKey | null => {
  const total = daysInMonth(year, month);
  const matches: number[] = [];
  for (let d = 1; d <= total; d++) if (new Date(Date.UTC(year, month, d)).getUTCDay() === day) matches.push(d);
  const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
  return pick ? keyOf(year, month, pick) : null;
};

/**
 * Occurrence dates of a recurring event, in the event's own wall clock, from
 * DTSTART through `lastDate`. COUNT counts from DTSTART, so the walk always
 * starts there; UNTIL is compared as an instant.
 */
const recurrenceDates = (start: IcsTime, rule: Record<string, string>, lastDate: DateKey, userZone: string): DateKey[] => {
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const untilTime = rule.UNTIL ? parseIcsTime(rule.UNTIL) : null;
  const until = untilTime ? (untilTime.allDay ? icsInstant({ ...untilTime, minutes: 24 * 60 - 1, allDay: false, zone: start.zone }, userZone) : icsInstant(untilTime, userZone)) : Infinity;
  const out: DateKey[] = [];
  let produced = 0;
  let done = false;
  const take = (date: DateKey): void => {
    if (done || date < start.date) return;
    if (date > lastDate || produced >= count || icsInstant({ ...start, date }, userZone) > until) {
      done = true;
      return;
    }
    produced++;
    out.push(date);
  };
  const byDay = (rule.BYDAY ?? '').split(',').filter(Boolean);
  const [startYear, startMonth] = start.date.split('-').map(Number) as [number, number];
  const startDay = Number(start.date.slice(8));
  switch (rule.FREQ) {
    case 'DAILY':
      for (let date = start.date, guard = 0; !done && guard < MAX_OCCURRENCES * interval; date = addDays(date, interval), guard++) take(date);
      break;
    case 'WEEKLY': {
      const weekStartsOn = rule.WKST === 'SU' ? 0 : 1;
      const days = byDay.length ? byDay.map((code) => WEEKDAY_CODES[code.slice(-2)]!).filter((day) => day !== undefined) : [weekday(start.date)];
      const offsets = [...new Set(days.map((day) => (day - weekStartsOn + 7) % 7))].sort((a, b) => a - b);
      for (let week = startOfWeek(start.date, weekStartsOn as 0 | 1), guard = 0; !done && guard < MAX_OCCURRENCES; week = addDays(week, 7 * interval), guard++) {
        for (const offset of offsets) take(addDays(week, offset));
      }
      break;
    }
    case 'MONTHLY': {
      const monthDays = (rule.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number);
      for (let index = 0, guard = 0; !done && guard < MAX_OCCURRENCES; index += interval, guard++) {
        const year = startYear + Math.floor((startMonth - 1 + index) / 12);
        const month = (startMonth - 1 + index) % 12;
        const candidates: DateKey[] = [];
        if (byDay.length) {
          for (const code of byDay) {
            const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(code);
            if (!match) continue;
            const day = WEEKDAY_CODES[match[2]!]!;
            const nth = match[1] ? Number(match[1]) : null;
            if (nth) {
              const date = nthWeekdayOfMonth(year, month, day, nth);
              if (date) candidates.push(date);
            } else {
              for (let d = 1; d <= daysInMonth(year, month); d++) if (new Date(Date.UTC(year, month, d)).getUTCDay() === day) candidates.push(keyOf(year, month, d));
            }
          }
        } else {
          for (const value of monthDays.length ? monthDays : [startDay]) {
            const total = daysInMonth(year, month);
            const day = value < 0 ? total + value + 1 : value;
            if (day >= 1 && day <= total) candidates.push(keyOf(year, month, day));
          }
        }
        for (const date of [...new Set(candidates)].sort()) take(date);
        if (keyOf(year, month, 1) > lastDate) done = true;
      }
      break;
    }
    case 'YEARLY':
      for (let year = startYear, guard = 0; !done && guard < MAX_OCCURRENCES; year += interval, guard++) {
        const month = startMonth - 1;
        if (startDay <= daysInMonth(year, month)) take(keyOf(year, month, startDay));
        if (keyOf(year, 0, 1) > lastDate) done = true;
      }
      break;
    default:
      take(start.date);
  }
  return out;
};

/** Concrete occurrences overlapping [from, to] (inclusive local dates in `userZone`). */
export const expandEvents = (events: readonly VEvent[], calendarId: string, from: DateKey, to: DateKey, userZone: string): CalendarEvent[] => {
  const rangeStart = Date.parse(instantAt(from, 0, userZone));
  const rangeEnd = Date.parse(instantAt(addDays(to, 1), 0, userZone));
  const overrides = new Map<string, VEvent>();
  for (const event of events) {
    if (event.recurrenceId) overrides.set(`${event.uid}|${icsInstant(event.recurrenceId, userZone)}`, event);
  }
  const masters = new Set(events.filter((event) => !event.recurrenceId).map((event) => event.uid));
  const out: CalendarEvent[] = [];
  const emit = (event: VEvent, start: IcsTime, occurrenceKey: string) => {
    if (event.cancelled) return;
    const startMs = icsInstant(start, userZone);
    let endMs: number;
    if (event.start.allDay) {
      const days = event.end?.allDay ? Math.max(1, daysBetween(event.start.date, event.end.date)) : Math.max(1, Math.round((event.durationMs ?? 86_400_000) / 86_400_000));
      endMs = Date.parse(instantAt(addDays(start.date, days), 0, userZone));
    } else {
      const length = event.end ? icsInstant(event.end, userZone) - icsInstant(event.start, userZone) : event.durationMs ?? 3_600_000;
      endMs = startMs + Math.max(0, length);
    }
    if (endMs <= rangeStart || startMs >= rangeEnd) return;
    out.push({
      id: `${calendarId}:${event.uid}:${occurrenceKey}`,
      calendarId,
      title: event.summary,
      location: event.location,
      start: new Date(startMs).toISOString(),
      end: new Date(Math.max(endMs, startMs)).toISOString(),
      allDay: event.start.allDay,
      busy: !event.free && !event.start.allDay,
    });
  };
  for (const event of events) {
    if (event.recurrenceId) {
      // An override replaces one occurrence of its series; without a series it stands alone.
      if (!masters.has(event.uid)) emit(event, event.start, String(icsInstant(event.start, userZone)));
      continue;
    }
    if (!event.rrule) {
      emit(event, event.start, 'single');
      continue;
    }
    const excluded = new Set(event.exdates.map((time) => (time.allDay ? `d:${time.date}` : `t:${icsInstant(time, userZone)}`)));
    for (const date of recurrenceDates(event.start, event.rrule, to, userZone)) {
      const occurrence: IcsTime = { ...event.start, date };
      const instant = icsInstant(occurrence, userZone);
      if (excluded.has(`d:${date}`) || excluded.has(`t:${instant}`)) continue;
      const override = overrides.get(`${event.uid}|${instant}`);
      if (override) emit(override, override.start, String(instant));
      else emit(event, occurrence, String(instant));
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
};
