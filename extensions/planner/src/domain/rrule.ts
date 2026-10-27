// Google Calendar's repeat rules (RFC 5545 RRULE lines): the presets Google
// offers for a day, a custom rule, the sentence Google shows for a rule, and
// the changes a series needs when it is split or moved to another day.
import type { DateKey } from './types.ts';
import { addDays, daysBetween, instantAt, isDateKey, monthDay, weekday, weekdayName, zonedDateMinutes } from './dates.ts';

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
const FREQUENCIES: readonly string[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const KNOWN = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL']);

export interface RRule {
  freq: Frequency;
  interval: number;
  /** Weekdays, with an ordinal for monthly rules: MO, 4MO, -1FR. */
  byDay: string[];
  byMonthDay: number[];
  byMonth: number[];
  count: number | null;
  /** As written: 20261231, or 20261231T075959Z. */
  until: string | null;
  /** Parts the Planner does not edit (WKST, BYSETPOS…), kept as they were. */
  other: [string, string][];
}

const BYDAY = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;
const UNTIL = /^\d{8}(T\d{6}Z?)?$/;

/** One RRULE line, or null when it is not one the Planner can read. */
export const parseRRule = (line: string): RRule | null => {
  const body = line.trim().replace(/^RRULE:/i, '');
  if (!body) return null;
  const parts = new Map<string, string>();
  const other: [string, string][] = [];
  for (const part of body.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).toUpperCase();
    if (KNOWN.has(key)) parts.set(key, value);
    else other.push([key, value]);
  }
  const freq = parts.get('FREQ') ?? '';
  if (!FREQUENCIES.includes(freq)) return null;
  const interval = Number(parts.get('INTERVAL') ?? '1');
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) return null;
  const byDay = (parts.get('BYDAY') ?? '').split(',').filter(Boolean);
  if (!byDay.every((code) => BYDAY.test(code))) return null;
  const numbers = (key: string, low: number, high: number): number[] | null => {
    const values = (parts.get(key) ?? '').split(',').filter(Boolean).map(Number);
    return values.every((value) => Number.isInteger(value) && value !== 0 && value >= low && value <= high) ? values : null;
  };
  const byMonthDay = numbers('BYMONTHDAY', -31, 31);
  const byMonth = numbers('BYMONTH', 1, 12);
  if (!byMonthDay || !byMonth) return null;
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  const until = parts.get('UNTIL') ?? null;
  if (until !== null && !UNTIL.test(until)) return null;
  return { freq: freq as Frequency, interval, byDay, byMonthDay, byMonth, count, until, other };
};

export const formatRRule = (rule: RRule): string => {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  for (const [key, value] of rule.other) parts.push(`${key}=${value}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  else if (rule.until !== null) parts.push(`UNTIL=${rule.until}`);
  return `RRULE:${parts.join(';')}`;
};

/** The RRULE line of an event's recurrence, and the lines beside it (EXDATE, RDATE). */
export const splitRecurrence = (lines: readonly string[]): { rule: RRule | null; line: string | null; rest: string[] } => {
  const rules = lines.filter((line) => /^RRULE:/i.test(line.trim()));
  const rest = lines.filter((line) => !/^RRULE:/i.test(line.trim()));
  // Several RRULE lines make a series the Planner does not take apart.
  if (rules.length !== 1) return { rule: null, line: rules[0] ?? null, rest };
  return { rule: parseRRule(rules[0]!), line: rules[0]!, rest };
};

const daysInMonth = (date: DateKey): number => {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
};

/** Which of its weekday in the month a day is (1–5), and whether it is the last one. */
export const weekdayOrdinal = (date: DateKey): { nth: number; last: boolean } => {
  const day = Number(date.slice(8));
  return { nth: Math.ceil(day / 7), last: day + 7 > daysInMonth(date) };
};

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `Dec 31, 2026` */
export const shortDate = (date: DateKey): string => `${SHORT_MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}, ${date.slice(0, 4)}`;

export interface RecurrencePreset {
  id: string;
  label: string;
  /** The RRULE line; null for "Does not repeat". */
  rule: string | null;
}

/** What Google Calendar's "Does not repeat" menu offers for an event on `date`. */
export const recurrencePresets = (date: DateKey): RecurrencePreset[] => {
  const name = weekdayName(date);
  const code = WEEKDAY_CODES[weekday(date)];
  const { nth, last } = weekdayOrdinal(date);
  const presets: RecurrencePreset[] = [
    { id: 'none', label: 'Does not repeat', rule: null },
    { id: 'daily', label: 'Daily', rule: 'RRULE:FREQ=DAILY' },
    { id: 'weekly', label: `Weekly on ${name}`, rule: `RRULE:FREQ=WEEKLY;BYDAY=${code}` },
  ];
  if (nth <= 4) presets.push({ id: 'monthly', label: `Monthly on the ${ORDINALS[nth - 1]} ${name}`, rule: `RRULE:FREQ=MONTHLY;BYDAY=${nth}${code}` });
  if (last) presets.push({ id: 'monthly-last', label: `Monthly on the last ${name}`, rule: `RRULE:FREQ=MONTHLY;BYDAY=-1${code}` });
  presets.push(
    { id: 'yearly', label: `Annually on ${monthDay(date)}`, rule: 'RRULE:FREQ=YEARLY' },
    { id: 'weekdays', label: 'Every weekday (Monday to Friday)', rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  );
  return presets;
};

const sameRule = (a: RRule, b: RRule): boolean => formatRRule(a) === formatRRule(b);

/** The preset an event's recurrence is, or 'custom'. */
export const presetIdOf = (lines: readonly string[], date: DateKey): string => {
  if (!lines.length) return 'none';
  const { rule, rest } = splitRecurrence(lines);
  if (!rule || rest.length) return 'custom';
  for (const preset of recurrencePresets(date)) {
    const parsed = preset.rule ? parseRRule(preset.rule) : null;
    if (parsed && sameRule(parsed, rule)) return preset.id;
  }
  return 'custom';
};

const list = (items: string[]): string => items.join(', ');

/** The local day an UNTIL value ends on, in `zone`. */
export const untilDate = (until: string, zone: string): DateKey | null => {
  const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  if (!isDateKey(date)) return null;
  if (until.length === 8) return date;
  const instant = Date.parse(`${date}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`);
  return Number.isNaN(instant) ? null : zonedDateMinutes(instant, zone).date;
};

/** The sentence Google Calendar shows for a series that starts on `start`: "Weekly on Monday, until Dec 31, 2026". */
export const describeRecurrence = (lines: readonly string[], start: DateKey, zone = 'UTC'): string => {
  if (!lines.length) return 'Does not repeat';
  const { rule } = splitRecurrence(lines);
  if (!rule) return 'Repeats (a custom rule)';
  const every = (one: string, many: string) => (rule.interval === 1 ? one : `Every ${rule.interval} ${many}`);
  const dayName = (code: string) => WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(code.slice(-2) as (typeof WEEKDAY_CODES)[number])] ?? code;
  let text: string;
  switch (rule.freq) {
    case 'DAILY':
      text = rule.byDay.length ? `${every('Weekly', 'weeks')} on ${list(rule.byDay.map(dayName))}` : every('Daily', 'days');
      break;
    case 'WEEKLY': {
      const codes = rule.byDay.length ? rule.byDay : [WEEKDAY_CODES[weekday(start)]];
      const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'];
      const days = codes.length === 5 && weekdays.every((code) => codes.includes(code)) ? 'weekdays' : codes.length === 7 ? 'all days' : list(codes.map(dayName));
      text = `${every('Weekly', 'weeks')} on ${days}`;
      break;
    }
    case 'MONTHLY': {
      const ordinal = rule.byDay.length === 1 ? BYDAY.exec(rule.byDay[0]!) : null;
      let on: string;
      if (ordinal && ordinal[1]) {
        const n = Number(ordinal[1]);
        on = `the ${n === -1 ? 'last' : ORDINALS[n - 1] ?? `${n}th`} ${dayName(ordinal[2]!)}`;
      } else if (rule.byDay.length) on = list(rule.byDay.map(dayName));
      else on = `day ${list((rule.byMonthDay.length ? rule.byMonthDay : [Number(start.slice(8))]).map((day) => (day === -1 ? 'last' : String(day))))}`;
      text = `${every('Monthly', 'months')} on ${on}`;
      break;
    }
    case 'YEARLY':
      text = `${every('Annually', 'years')} on ${monthDay(start)}`;
      break;
  }
  if (rule.count !== null) text += rule.count === 1 ? ', once' : `, ${rule.count} times`;
  else if (rule.until) {
    const date = untilDate(rule.until, zone);
    if (date) text += `, until ${shortDate(date)}`;
  }
  return text;
};

const utcStamp = (instant: number): string => new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** UNTIL for a series that ends just before an occurrence: a second before it, or the day before for all-day events. */
export const untilBefore = (occurrence: { dateTime?: string; date?: string }): string | null => {
  if (occurrence.date && isDateKey(occurrence.date)) return addDays(occurrence.date, -1).replace(/-/g, '');
  const instant = Date.parse(occurrence.dateTime ?? '');
  return Number.isNaN(instant) ? null : utcStamp(instant - 1000);
};

/** UNTIL for a series that ends on `date` (that day's occurrences included). */
export const untilOn = (date: DateKey, allDay: boolean, zone: string): string =>
  allDay ? date.replace(/-/g, '') : utcStamp(Date.parse(instantAt(addDays(date, 1), 0, zone)) - 1000);

const shiftCode = (code: string, days: number): string | null => {
  const match = BYDAY.exec(code);
  if (!match || match[1]) return null;
  const index = WEEKDAY_CODES.indexOf(match[2] as (typeof WEEKDAY_CODES)[number]);
  return WEEKDAY_CODES[(((index + days) % 7) + 7) % 7]!;
};

/**
 * The rule for a series whose occurrence on `from` now falls on `to`, as when
 * "All events" is moved to another day: weekdays and month days follow the
 * move. Null for rules whose days the Planner cannot carry over.
 */
export const shiftRule = (rule: RRule, from: DateKey, to: DateKey): RRule | null => {
  const days = daysBetween(from, to);
  if (days === 0) return rule;
  if (rule.other.some(([key]) => key !== 'WKST')) return null;
  const code = WEEKDAY_CODES[weekday(to)];
  switch (rule.freq) {
    case 'DAILY':
    case 'WEEKLY': {
      if (rule.byMonthDay.length || rule.byMonth.length) return null;
      const byDay = rule.byDay.map((item) => shiftCode(item, days));
      return byDay.every(Boolean) ? { ...rule, byDay: [...new Set(byDay as string[])] } : null;
    }
    case 'MONTHLY': {
      if (rule.byMonth.length || (rule.byDay.length && rule.byMonthDay.length)) return null;
      if (rule.byMonthDay.length) return rule.byMonthDay.length === 1 ? { ...rule, byMonthDay: [Number(to.slice(8))] } : null;
      if (rule.byDay.length === 1 && BYDAY.exec(rule.byDay[0]!)?.[1]) {
        const { nth, last } = weekdayOrdinal(to);
        const wasLast = rule.byDay[0]!.startsWith('-1');
        return { ...rule, byDay: [`${wasLast && last ? -1 : nth >= 5 ? -1 : nth}${code}`] };
      }
      if (rule.byDay.length) {
        const byDay = rule.byDay.map((item) => shiftCode(item, days));
        return byDay.every(Boolean) ? { ...rule, byDay: byDay as string[] } : null;
      }
      return rule;
    }
    case 'YEARLY':
      if (rule.byDay.length) return null;
      return {
        ...rule,
        byMonth: rule.byMonth.length ? [Number(to.slice(5, 7))] : [],
        byMonthDay: rule.byMonthDay.length ? [Number(to.slice(8))] : [],
      };
  }
};

/** Google Calendar's "Custom recurrence" dialog, as fields. */
export interface CustomRecurrence {
  freq: Frequency;
  interval: number;
  /** Weekly: the days (0 = Sunday). */
  weekdays: number[];
  /** Monthly: on the same day of the month, or the same weekday of its week. */
  monthly: 'day' | 'weekday';
  ends: { kind: 'never' } | { kind: 'on'; date: DateKey } | { kind: 'after'; count: number };
}

/** The custom dialog's fields for a series starting on `start` (the defaults when it does not repeat yet). */
export const customOf = (lines: readonly string[], start: DateKey, zone: string): CustomRecurrence => {
  const { rule } = splitRecurrence(lines);
  const fallback: CustomRecurrence = { freq: 'WEEKLY', interval: 1, weekdays: [weekday(start)], monthly: 'day', ends: { kind: 'never' } };
  if (!rule) return fallback;
  const weekdays = rule.byDay.map((code) => WEEKDAY_CODES.indexOf(code.slice(-2) as (typeof WEEKDAY_CODES)[number])).filter((day) => day >= 0);
  const until = rule.until ? untilDate(rule.until, zone) : null;
  return {
    freq: rule.freq,
    interval: rule.interval,
    weekdays: rule.freq === 'WEEKLY' && weekdays.length ? [...new Set(weekdays)].sort() : [weekday(start)],
    monthly: rule.freq === 'MONTHLY' && rule.byDay.length ? 'weekday' : 'day',
    ends: rule.count !== null ? { kind: 'after', count: rule.count } : until ? { kind: 'on', date: until } : { kind: 'never' },
  };
};

/** The RRULE line for the custom dialog's fields, for a series starting on `start`. */
export const customRule = (custom: CustomRecurrence, start: DateKey, allDay: boolean, zone: string): string => {
  const rule: RRule = { freq: custom.freq, interval: Math.max(1, Math.min(999, Math.round(custom.interval) || 1)), byDay: [], byMonthDay: [], byMonth: [], count: null, until: null, other: [] };
  if (custom.freq === 'WEEKLY') {
    const days = custom.weekdays.length ? [...new Set(custom.weekdays)].sort() : [weekday(start)];
    rule.byDay = days.map((day) => WEEKDAY_CODES[day]!);
  } else if (custom.freq === 'MONTHLY') {
    if (custom.monthly === 'weekday') {
      const { nth } = weekdayOrdinal(start);
      rule.byDay = [`${nth >= 5 ? -1 : nth}${WEEKDAY_CODES[weekday(start)]}`];
    } else rule.byMonthDay = [Number(start.slice(8))];
  }
  if (custom.ends.kind === 'after') rule.count = Math.max(1, Math.min(730, Math.round(custom.ends.count) || 1));
  else if (custom.ends.kind === 'on') rule.until = untilOn(custom.ends.date < start ? start : custom.ends.date, allDay, zone);
  return formatRRule(rule);
};

/** The monthly options of the custom dialog for a series starting on `start`. */
export const monthlyLabels = (start: DateKey): { day: string; weekday: string } => {
  const { nth } = weekdayOrdinal(start);
  return { day: `Monthly on day ${Number(start.slice(8))}`, weekday: `Monthly on the ${nth >= 5 ? 'last' : ORDINALS[nth - 1]} ${weekdayName(start)}` };
};
