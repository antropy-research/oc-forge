// Helpers for tests/googleCalendar.test.ts: Google's consent page as the browser goes through it, a calendar feed
// (ICS) served on this machine, a zone where it is about noon now, and the fake Google calendars the scenarios read.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addDays, instantAt, todayIn } from '../../src/domain/dates.ts';
import { defaultFakeWorld, fakeAuthCode, type FakeWorld } from '../e2e/fakeGoogle.mjs';
import type { Planner } from './planner.ts';

export const LA = 'America/Los_Angeles';
export const ME = 'harness@example.com';
export const WORK = 'work@group.calendar.google.com';

/**
 * A zone where it is between noon and 1pm now, so a day's morning meetings have ended and its evening ones are still
 * to come, whenever the suite runs (and no midnight falls inside it).
 */
export const noonZone = (now = new Date()): string => {
  const east = 12 - now.getUTCHours();
  return east === 0 ? 'Etc/GMT' : `Etc/GMT${east > 0 ? '-' : '+'}${Math.abs(east)}`;
};

/**
 * Where Google's consent page sends the browser back: the sign-in's loopback address with its state and a code for
 * the scopes the user left ticked (all it asked for unless `allow` says), or Google's error.
 */
export const consentRedirect = (authUrl: string, redirectUri: string, answer: { allow?: string[]; error?: string; state?: string } = {}): string => {
  const asked = new URL(authUrl).searchParams;
  const state = answer.state ?? asked.get('state') ?? '';
  const scope = (answer.allow ?? (asked.get('scope') ?? '').split(' ')).join(' ');
  return `${redirectUri}?${new URLSearchParams(answer.error ? { state, error: answer.error } : { state, code: fakeAuthCode(scope) })}`;
};

/** A calendar feed on this machine, which can go down. */
export const serveFeed = async (text: string) => {
  let down = false;
  const server = createServer((request, response) => {
    if (down) response.writeHead(503).end('down');
    else if (request.url === '/team.ics') response.writeHead(200, { 'Content-Type': 'text/calendar' }).end(text);
    else response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/team.ics`,
    /** An address on the same server that never had a feed. */
    missing: `${base}/gone.ics`,
    setDown: (value: boolean) => void (down = value),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

/** Google Calendar events of a fake calendar now (masters, singles and the occurrences changed on their own). */
export const eventsIn = (planner: Planner, calendarId: string) => planner.google!.calendars.get(calendarId)!.events;
export const exceptionsIn = (planner: Planner, calendarId: string) => planner.google!.calendars.get(calendarId)!.exceptions;
/** Requests the fake Google got, by method and a part of the path. */
export const requestsTo = (planner: Planner, method: string, path: string | RegExp) =>
  planner.google!.requests.filter((request) => request.method === method && (typeof path === 'string' ? request.path.includes(path) : path.test(request.path)));

/** A Google calendar shown beside the plan (a subscription read through the account), as ticking it in the rail adds it. */
export const showCalendar = async (planner: Planner, calendarId: string, name: string): Promise<string> => {
  const state = await planner.state();
  const existing = Object.values(state.calendars).find((calendar) => calendar.google?.calendarId === calendarId);
  if (existing) {
    if (!existing.visible) await planner.commands({ type: 'calendar.updated', calendarId: existing.id, patch: { visible: true } });
    return existing.id;
  }
  const id = `sub${calendarId.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`;
  await planner.commands({ type: 'calendar.added', calendar: { id, name, url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}`, color: '#039be5', google: { account: ME, calendarId } } });
  return id;
};

const pacific = (date: string, hour: number, minute = 0) => ({ dateTime: instantAt(date, hour * 60 + minute, LA), timeZone: LA });

/**
 * The calendar scenarios' Google: the journeys' account (today relative, small pages) with a few more events of its
 * own calendar (declined, free, cancelled, a Planner session), and a Work calendar of series on fixed dates around
 * the change from summer time in Los Angeles (Sunday, November 1, 2026).
 */
export const calendarWorld = (): { world: FakeWorld; today: string } => {
  const today = todayIn(LA);
  const world = defaultFakeWorld({ account: ME, today, zone: LA });
  const at = (days: number, hour: number) => ({ dateTime: instantAt(addDays(today, days), hour * 60, LA) });
  world.pageSize = { ...world.pageSize, events: 6 };
  world.calendars.push({ id: WORK, summary: 'Work', accessRole: 'owner', backgroundColor: '#7986cb' });
  world.events.primary!.push(
    { id: 'declined', summary: 'Skip-level', start: at(1, 10), end: at(1, 11), organizer: { email: 'ann@example.com' }, attendees: [{ email: 'ann@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'declined' }] },
    { id: 'free', summary: 'Office hours', transparency: 'transparent', start: at(1, 13), end: at(1, 14), organizer: { email: ME, self: true } },
    { id: 'gone', summary: 'Cancelled sync', status: 'cancelled', start: at(1, 15), end: at(1, 16), organizer: { email: ME, self: true } },
    { id: 'session', summary: 'Write the report', start: at(1, 16), end: at(1, 17), organizer: { email: ME, self: true }, extendedProperties: { private: { plannerBlockId: 'blk-from-elsewhere', plannerTaskId: 'task-elsewhere' } } },
  );
  const guests = [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', displayName: 'Ann', responseStatus: 'accepted' }];
  world.events[WORK] = [
    // Mondays at 9am, from before the change to after it.
    { id: 'design', summary: 'Design sync', start: pacific('2026-10-19', 9), end: pacific('2026-10-19', 10), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], organizer: { email: ME, self: true } },
    // The day the clocks go back is 25 hours long.
    { id: 'fallback', summary: 'Fall back', start: { date: '2026-11-01' }, end: { date: '2026-11-02' }, organizer: { email: ME, self: true } },
    { id: 'split', summary: 'Team sync', description: 'Agenda', start: pacific('2026-10-05', 9), end: pacific('2026-10-05', 10), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], attendees: guests, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }, organizer: { email: ME, self: true } },
    { id: 'gym', summary: 'Gym', start: pacific('2026-10-07', 7), end: pacific('2026-10-07', 8), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'], organizer: { email: ME, self: true } },
    { id: 'board', summary: 'Board', start: pacific('2026-10-12', 10), end: pacific('2026-10-12', 11), recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2'], organizer: { email: ME, self: true } },
    { id: 'monthly', summary: 'Retro', start: pacific('2026-10-26', 15), end: pacific('2026-10-26', 16), recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=4MO'], organizer: { email: ME, self: true } },
    { id: 'pills', summary: 'Pills', start: pacific('2026-10-01', 8), end: pacific('2026-10-01', 8, 15), recurrence: ['RRULE:FREQ=DAILY;COUNT=12'], organizer: { email: ME, self: true } },
    { id: 'yoga', summary: 'Yoga', start: pacific('2026-10-01', 6), end: pacific('2026-10-01', 7), recurrence: ['RRULE:FREQ=DAILY;COUNT=10'], organizer: { email: ME, self: true } },
    { id: 'payday', summary: 'Payday', start: { date: '2026-10-02' }, end: { date: '2026-10-03' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'], organizer: { email: ME, self: true } },
  ];
  return { world, today };
};

/**
 * The meeting scenario's Google, in `zone` where it is about noon: today's ended standup and later planning, the week's
 * events of each excluded kind, a declined one, one past the week, and a second calendar's.
 */
export const meetingWorld = (zone: string): { world: FakeWorld; today: string; at: (days: number, hour: number, minute?: number) => string } => {
  const today = todayIn(zone);
  const at = (days: number, hour: number, minute = 0) => instantAt(addDays(today, days), hour * 60 + minute, zone);
  const time = (days: number, hour: number, minute = 0) => ({ dateTime: at(days, hour, minute) });
  const invited = (response = 'accepted') => [{ email: ME, self: true, responseStatus: response }, { email: 'ann@example.com', organizer: true, responseStatus: 'accepted' }];
  const meeting = (id: string, summary: string, days: number, hour: number, length = 60, extra: Record<string, unknown> = {}) => ({ id, summary, start: time(days, hour), end: time(days, hour, length), organizer: { email: 'ann@example.com' }, attendees: invited(), ...extra });
  const world = defaultFakeWorld({ account: ME, today, zone });
  world.calendars = [
    { id: 'primary', summary: ME, accessRole: 'owner', backgroundColor: '#039be5', primary: true },
    { id: 'home@group.calendar.google.com', summary: 'Home', accessRole: 'owner', backgroundColor: '#33b679' },
  ];
  world.events = {
    primary: [
      meeting('standup', 'Standup', 0, 8, 15),
      meeting('planning', 'Quarter planning', 0, 15),
      meeting('review', 'Design review', 1, 11),
      meeting('solo', 'Dentist', 0, 9, 30, { attendees: undefined, organizer: { email: ME, self: true } }),
      meeting('free', 'Office hours', 1, 13, 60, { transparency: 'transparent' }),
      meeting('ooo', 'OOO: dentist', 1, 15),
      meeting('maybe', 'Vendor demo', 2, 10, 60, { attendees: invited('needsAction') }),
      meeting('declined', 'Skip-level', 2, 14, 60, { attendees: invited('declined') }),
      { id: 'trip', summary: 'Team offsite', start: { date: addDays(today, 3) }, end: { date: addDays(today, 5) }, organizer: { email: 'ann@example.com' }, attendees: invited() },
      meeting('later', 'Next month', 10, 10),
    ],
    'home@group.calendar.google.com': [meeting('breakfast', 'Breakfast', 0, 7, 30), meeting('family', 'Family call', 0, 18), meeting('dinner', 'Dinner with Bo', 1, 19)],
  };
  return { world, today, at };
};
