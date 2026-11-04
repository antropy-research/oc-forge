// Sunsama's Add Task syntax: `@` start date or backlog bucket, `~` planned time,
// `#` channel, `!` priority, `$` weekly objective, `>` the task to merge it into
// (as a subtask). Unparsed tokens stay in the title.
import type { BacklogBucket, DateKey, Placement, Priority } from './types.ts';
import { addDays, isDateKey, monthIndex, nextWeekday, startOfWeek } from './dates.ts';

export interface QuickAdd {
  title: string;
  plannedMinutes: number | null;
  placement: Placement | null;
  channel: string | null;
  priority: Priority | null;
  objective: string | null;
  /** `>Inbox triage`: the open task, by the start of its title, to merge this one into as a subtask (Sunsama's `>`). */
  merge?: string | null;
}

const PRIORITIES: Record<string, Priority> = {
  urgent: 'urgent', u: 'urgent', '1': 'urgent',
  high: 'high', h: 'high', '2': 'high',
  medium: 'medium', med: 'medium', m: 'medium', '3': 'medium',
  low: 'low', l: 'low', '4': 'low',
};

const BUCKET_WORDS: Record<string, BacklogBucket> = {
  backlog: 'next-weeks', later: 'next-weeks', nextweeks: 'next-weeks', 'next-weeks': 'next-weeks',
  nextmonth: 'next-month', 'next-month': 'next-month',
  nextquarter: 'next-quarter', 'next-quarter': 'next-quarter',
  nextyear: 'next-year', 'next-year': 'next-year',
  someday: 'someday',
  never: 'never',
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** `30`, `30m`, `45min`, `1h`, `1.5h`, `1h30`, `1h30m`, `1:30` → minutes. */
export const parseDuration = (raw: string): number | null => {
  const text = raw.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const match = /^(?:(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours))?(?:(\d+)(?:m|min|mins|minute|minutes)?)?$/.exec(text);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Math.round(Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0));
  return minutes > 0 && minutes <= 24 * 60 ? minutes : null;
};

const monthDayToDate = (month: number, day: number, today: DateKey): DateKey | null => {
  const year = Number(today.slice(0, 4));
  for (const candidateYear of [year, year + 1]) {
    const key = `${candidateYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isDateKey(key) && key >= today) return key;
  }
  return null;
};

/** `today`, `tomorrow`, `fri`, `nextweek`, `2026-10-30`, `10/30`, `oct30`, `backlog`, `someday` … */
export const parseWhen = (raw: string, today: DateKey, weekStartsOn: 0 | 1 = 1): Placement | null => {
  const text = raw.trim().toLowerCase();
  if (text in BUCKET_WORDS) return { kind: 'backlog', bucket: BUCKET_WORDS[text]! };
  const day = (date: DateKey): Placement => ({ kind: 'day', date });
  if (text === 'today' || text === 'tod') return day(today);
  if (text === 'tomorrow' || text === 'tmr' || text === 'tmrw' || text === 'tom') return day(addDays(today, 1));
  if (text in WEEKDAYS) return day(nextWeekday(today, WEEKDAYS[text]!));
  if (text === 'nextweek' || text === 'next-week') return day(addDays(startOfWeek(today, weekStartsOn), 7));
  if (isDateKey(text)) return day(text);
  const numeric = /^(\d{1,2})[/-](\d{1,2})$/.exec(text);
  if (numeric) {
    const date = monthDayToDate(Number(numeric[1]) - 1, Number(numeric[2]), today);
    return date ? day(date) : null;
  }
  const named = /^([a-z]{3,9})-?(\d{1,2})$/.exec(text) ?? null;
  const reversed = /^(\d{1,2})-?([a-z]{3,9})$/.exec(text);
  const monthName = named?.[1] ?? reversed?.[2];
  const dayNumber = named?.[2] ?? reversed?.[1];
  if (monthName && dayNumber) {
    const month = monthIndex(monthName);
    if (month < 0) return null;
    const date = monthDayToDate(month, Number(dayNumber), today);
    return date ? day(date) : null;
  }
  return null;
};

export const parseQuickAdd = (input: string, today: DateKey, weekStartsOn: 0 | 1 = 1): QuickAdd => {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const result: QuickAdd = { title: '', plannedMinutes: null, placement: null, channel: null, priority: null, objective: null };
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const sigil = token[0];
    const rest = token.slice(1);
    if (rest && sigil === '~') {
      const minutes = parseDuration(rest);
      if (minutes !== null) { result.plannedMinutes = minutes; continue; }
    } else if (rest && sigil === '@') {
      // `@oct 30` and `@next week` arrive as two tokens.
      const next = tokens[index + 1];
      const joined = next ? parseWhen(`${rest}${/^\d/.test(next) ? '-' : ''}${next}`, today, weekStartsOn) : null;
      if (joined && next && (monthIndex(rest) >= 0 || rest.toLowerCase() === 'next')) { result.placement = joined; index++; continue; }
      const placement = parseWhen(rest, today, weekStartsOn);
      if (placement) { result.placement = placement; continue; }
    } else if (rest && sigil === '#' && /^[\p{L}\p{N}_-]+$/u.test(rest)) {
      result.channel = rest;
      continue;
    } else if (rest && sigil === '!' && rest.toLowerCase() in PRIORITIES) {
      result.priority = PRIORITIES[rest.toLowerCase()]!;
      continue;
    } else if (rest && sigil === '$' && /^[\p{L}\p{N}_-]+$/u.test(rest)) {
      result.objective = rest;
      continue;
    } else if (sigil === '>' && /^[\p{L}\p{N}]/u.test(rest)) {
      // The words after `>`, up to the next token, name the task (titles have spaces).
      const name = [rest];
      while (index + 1 < tokens.length && !/^[~@#!$>]./u.test(tokens[index + 1]!)) name.push(tokens[++index]!);
      result.merge = name.join(' ');
      continue;
    }
    words.push(token);
  }
  result.title = words.join(' ');
  return result;
};
