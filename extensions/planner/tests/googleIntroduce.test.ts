// Google Calendar shows your own calendar from the start: the panel's Google store
// shows a newly seen account's primary calendar once, and leaves the user's later
// choices alone.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore } from '../panel/lib/google.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { emptyState, type PlannerState } from '../src/domain/types.ts';
import type { GoogleCalendarInfo } from '../src/domain/google.ts';

const ME = 'me@example.com';
const calendars: GoogleCalendarInfo[] = [
  { account: ME, id: 'primary', name: ME, color: '#039be5', primary: true, writable: true, accessRole: 'owner' },
  { account: ME, id: 'team@group.calendar.google.com', name: 'Team', color: '#33b679', primary: false, writable: true, accessRole: 'writer' },
];

/** A Planner client whose dispatch applies the events, so the store sees what it did; Google answers from `calendars`. */
const fakeClient = (start: PlannerState = emptyState(), features: string[] = ['calendar', 'tasks']) => {
  let state = start;
  let n = 0;
  const dispatched: EventBody[] = [];
  const calls: string[] = [];
  const client = {
    getView: () => ({ state, today: '2026-10-26' }),
    call: async (_method: string, path: string) => {
      calls.push(path);
      // Let two loads interleave, as they do in the panel.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (path === '/google/status') return { client: { id: 'x.apps.googleusercontent.com' }, accounts: [{ email: ME, features, addedAt: '2026-10-26T00:00:00Z' }] };
      if (path === '/google/calendars') return { calendars, errors: [] };
      if (path === '/google/tasklists') return { lists: [], errors: [] };
      return {};
    },
    dispatch: async (bodies: EventBody[]) => {
      // The service checks every command; what the store sends must pass.
      for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
      dispatched.push(...bodies);
      state = applyEvents(state, bodies.map((body) => ({ ...body, v: 1, id: `e${++n}`, at: '2026-10-26T00:00:00Z' }) as PlannerEvent));
    },
    notify: () => {},
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { client, dispatched, calls, state: () => state };
};

const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;
const shownGoogle = (state: PlannerState) => Object.values(state.calendars).filter((calendar) => calendar.google).map((calendar) => `${calendar.google!.account}/${calendar.google!.calendarId}:${calendar.visible}`);

describe('an account’s own calendar shows from the start, as in Google Calendar', () => {
  test('the first time an account’s calendars are seen, its primary calendar is shown, once', async () => {
    const fake = fakeClient();
    const store = new GoogleStore(host, fake.client, 'page');
    await store.loadCalendars();
    expect(shownGoogle(fake.state())).toEqual([`${ME}/primary:true`]);
    expect(fake.state().settings.googleCalendarsIntroduced).toEqual([ME]);
    // Hidden by the user afterwards: a later load leaves it hidden.
    const added = Object.values(fake.state().calendars)[0]!;
    await fake.client.dispatch([{ type: 'calendar.updated', calendarId: added.id, patch: { visible: false } }]);
    await store.loadCalendars();
    expect(shownGoogle(fake.state())).toEqual([`${ME}/primary:false`]);
  });

  test('an account whose calendar was removed, or one that already shows another of its calendars, gets nothing added', async () => {
    const removed = fakeClient({ ...emptyState(), settings: { ...emptyState().settings, googleCalendarsIntroduced: [ME] } });
    await new GoogleStore(host, removed.client, 'page').loadCalendars();
    expect(shownGoogle(removed.state())).toEqual([]);

    const fake = fakeClient();
    await fake.client.dispatch([{ type: 'calendar.added', calendar: { id: 'c-team', name: 'Team', url: 'https://calendar.google.com/calendar/r?cid=team', color: '#33b679', google: { account: ME, calendarId: 'team@group.calendar.google.com' } } }]);
    await new GoogleStore(host, fake.client, 'page').loadCalendars();
    expect(shownGoogle(fake.state())).toEqual([`${ME}/team@group.calendar.google.com:true`]);
    expect(fake.state().settings.googleCalendarsIntroduced).toEqual([ME]);
  });

  test('two loads at once show the calendar once', async () => {
    const fake = fakeClient();
    const store = new GoogleStore(host, fake.client, 'page');
    await Promise.all([store.loadCalendars(), store.loadCalendars()]);
    expect(fake.dispatched.filter((body) => body.type === 'calendar.added')).toHaveLength(1);
    expect(shownGoogle(fake.state())).toEqual([`${ME}/primary:true`]);
  });

  test('connected accounts are looked at when the Planner starts, wherever the user is; accounts without Calendar are not', async () => {
    const fake = fakeClient();
    await new GoogleStore(host, fake.client, 'page').checkStatus();
    for (let i = 0; i < 50 && !shownGoogle(fake.state()).length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(shownGoogle(fake.state())).toEqual([`${ME}/primary:true`]);

    const tasksOnly = fakeClient(emptyState(), ['tasks']);
    await new GoogleStore(host, tasksOnly.client, 'page').checkStatus();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tasksOnly.calls).not.toContain('/google/calendars');
  });

  test('the setting is checked: email addresses only, at most 50', () => {
    const check = (value: unknown) => validateCommand({ cmd: 'c', type: 'settings.updated', patch: { googleCalendarsIntroduced: value } }, emptyState());
    expect(check([ME])).toBeNull();
    expect(check(['not an email'])).toMatch(/googleCalendarsIntroduced/);
    expect(check(ME)).toMatch(/googleCalendarsIntroduced/);
    expect(check(Array.from({ length: 51 }, (_, index) => `a${index}@example.com`))).toMatch(/googleCalendarsIntroduced/);
  });
});
