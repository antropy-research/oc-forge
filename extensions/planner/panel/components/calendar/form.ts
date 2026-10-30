// What the quick create popover and the event editor choose from: times as
// Google Calendar lists them (every 15 minutes, ends with their length), the
// calendars the account may write to, and the default calendar and list.
import type { CalendarSubscription, PlannerState } from '../../../src/domain/types.ts';
import { compactClock } from '../../../src/domain/gcalendar.ts';
import type { GoogleCalendarInfo, GoogleTaskList } from '../../../src/domain/google.ts';
import type { CalendarPrefs } from '../../lib/gcal.ts';

export const STEP = 15;

/** Start times of a day, every 15 minutes. */
export const startChoices = (): { value: number; label: string }[] => Array.from({ length: 96 }, (_, index) => ({ value: index * STEP, label: compactClock(index * STEP) }));

const length = (minutes: number): string => (minutes < 60 ? `${minutes} mins` : minutes % 60 === 0 ? `${minutes / 60} hr${minutes === 60 ? '' : 's'}` : `${(minutes / 60).toFixed(minutes % 30 === 0 ? 1 : 2).replace(/0$/, '')} hrs`);

/** End times after `start` on the same day, each with the length it makes: "10:30am (30 mins)". */
export const endChoices = (start: number): { value: number; label: string }[] => {
  const out: { value: number; label: string }[] = [];
  for (let end = start + STEP; end <= 24 * 60; end += STEP) out.push({ value: end, label: `${compactClock(end % 1440)}${end === 1440 ? ' (midnight)' : ''} (${length(end - start)})` });
  return out;
};

export interface WritableCalendar extends GoogleCalendarInfo {
  key: string;
  /** Its subscription in the Planner, when it is shown. */
  subscription: CalendarSubscription | null;
}

export const calendarKey = (account: string, calendarId: string): string => `${account}\n${calendarId}`;

/** The Google calendars new events can go to, primary ones first. */
export const writableCalendars = (calendars: readonly GoogleCalendarInfo[], subscriptions: Readonly<Record<string, CalendarSubscription>>): WritableCalendar[] =>
  calendars
    .filter((calendar) => calendar.writable)
    .map((calendar) => ({ ...calendar, key: calendarKey(calendar.account, calendar.id), subscription: Object.values(subscriptions).find((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id) ?? null }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));

/** Where a new event goes: the calendar used last, the one sessions are written to, a primary calendar. */
export const defaultCalendar = (writable: readonly WritableCalendar[], state: PlannerState, prefs: CalendarPrefs): WritableCalendar | null => {
  const find = (target: { account: string; calendarId: string } | null) => (target ? writable.find((calendar) => calendar.account === target.account && calendar.id === target.calendarId) : undefined);
  return find(prefs.lastCalendar) ?? find(state.settings.googleTimebox) ?? writable.find((calendar) => calendar.primary) ?? writable[0] ?? null;
};

export const listKeyOf = (list: GoogleTaskList): string => calendarKey(list.account, list.id);

/** Where a new task goes in Google Tasks: the list used last, else the default list ("My Tasks"); '' keeps it in the Planner only. */
export const defaultList = (lists: readonly GoogleTaskList[], prefs: CalendarPrefs): string => {
  if (prefs.lastList !== null && (prefs.lastList === '' || lists.some((list) => listKeyOf(list) === prefs.lastList))) return prefs.lastList;
  const list = lists.find((item) => item.isDefault) ?? lists[0];
  return list ? listKeyOf(list) : '';
};
