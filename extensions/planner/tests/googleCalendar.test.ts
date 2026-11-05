// Google Calendar in the Planner, end to end: the real service signed in to the journeys' fake Google
// (tests/e2e/fakeGoogle.mjs), Planner windows made of the panel's own client and stores (tests/support/planner.ts),
// and the calendar view's own requests (panel/lib/calendar/calendarUi.ts). Signing in (the OAuth client, Google's consent page, a
// pasted address, features as Google granted them, secrets kept on this machine, an account removed); the account's
// own calendar shown from the start; the week read page after page, with what may be done with each event; events
// made, changed, answered, moved, deleted and put back; recurring events (This event, This and following, All events)
// across the change from summer time in Los Angeles; working sessions written to Google Calendar and following it back;
// a calendar feed (ICS) served on this machine; and meetings imported as Sunsama imports them. How the calendar is
// drawn (day, week, month and year, compact times, titles), the repeat menu's wording and printing are the browser
// journeys' (tests/e2e/calendar.mjs, tasks-calendar.mjs).
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, instantAt, todayIn } from '../src/domain/core/dates.ts';
import type { GoogleEventRef } from '../src/domain/google/google.ts';
import type { CalendarEvent } from '../src/domain/calendar/ics.ts';
import { createEvent, deleteEvent, eventDetail, moveEventToCalendar, respondToEvent, restoreEvent, searchEvents, updateEvent } from '../panel/lib/calendar/calendarUi.ts';
import { GoogleAccounts, testFetcher } from '../service/google/accounts.ts';
import { defaultFakeWorld } from './e2e/fakeGoogle.mjs';
import { until, usePlanner, type PlannerWindow } from './support/planner.ts';
import { LA, ME, WORK, calendarWorld, consentRedirect, eventsIn, meetingWorld, noonZone, requestsTo, serveFeed, showCalendar } from './support/googleCalendar.ts';

const TEAM = 'team@group.calendar.google.com';
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
// Made-up credentials, built at run time so nothing here looks like a real secret.
const CLIENT_ID = `${'7654321'.repeat(2)}-${'zyxwvutsrq'.repeat(3)}.apps.googleusercontent.com`;
const SECRET = `GOCSPX-${'k'.repeat(28)}`;
const failure = (promise: Promise<unknown>) => promise.then(() => 'done', (error: Error) => error.message);
const pacific = (iso: string) => ({ dateTime: iso, timeZone: LA });

describe('Signing in to Google', () => {
  // The account has granted the Planner nothing yet.
  const planner = usePlanner({ zone: LA, google: { ...defaultFakeWorld({ account: ME, today: todayIn(LA), zone: LA }), granted: [] } });

  test('a new OAuth client, a refused consent, a pasted address with Calendar unticked, then a sign-in from a window: the own calendar shows, tokens are refreshed and revoked, and no secret ever comes back', async () => {
    const answers: unknown[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const answer = await planner.call(method, path, body);
      answers.push(answer.body);
      return answer;
    };
    expect((await fetch(`${planner.base}/google/status`)).status).toBe(401);
    // The OAuth client: refused when it is not one; a new one starts without the old one's accounts.
    expect((await call('PUT', '/google/client', { id: 'not-a-client', secret: SECRET })).body.error).toContain('OAuth client ID');
    expect((await call('PUT', '/google/client', { id: CLIENT_ID, secret: 'short' })).body.error).toContain('client secret');
    expect((await call('PUT', '/google/client', { id: ` ${CLIENT_ID} `, secret: SECRET })).body).toEqual({ client: { id: CLIENT_ID }, accounts: [] });
    expect((await call('POST', '/google/connect', { features: [] })).status).toBe(400);

    // A sign-in asks Google for the features chosen (unknown ones left out), with PKCE, offline access and consent.
    const first = (await call('POST', '/google/connect', { features: ['tasks', 'bogus'] })).body;
    const auth = new URL(first.authUrl);
    expect(`${auth.origin}${auth.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: first.redirectUri, response_type: 'code', scope: `openid email ${TASKS_SCOPE}`, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
    expect(auth.searchParams.get('code_challenge')).toHaveLength(43);
    expect(first.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    // Someone else's redirect is not this sign-in's answer; Google's refusal ends it.
    expect(await (await fetch(consentRedirect(first.authUrl, first.redirectUri, { state: 'forged' }))).text()).toContain('does not belong');
    expect((await call('GET', `/google/connect/${first.id}`)).body).toEqual({ status: 'pending' });
    expect(await (await fetch(consentRedirect(first.authUrl, first.redirectUri, { error: 'access_denied' }))).text()).toContain('Not connected');
    expect((await call('GET', `/google/connect/${first.id}`)).body).toEqual({ status: 'failed', message: 'Access was not allowed' });
    expect((await call('GET', '/google/connect/unknownsignin1')).body).toMatchObject({ status: 'failed' });

    // From a window, the browser on another machine: Calendar unticked on Google's page, the address it lands on pasted.
    const window = await planner.window();
    await window.google.connect(['calendar', 'tasks']);
    const pasted = window.google.getView().signIn!;
    expect(window.opened).toEqual([pasted.authUrl]);
    expect(new URL(pasted.authUrl).searchParams.get('scope')).toBe(['openid', 'email', ...CALENDAR_SCOPES, TASKS_SCOPE].join(' '));
    expect(await failure(window.google.finishSignIn('not an address'))).toContain('whole address');
    expect(await failure(window.google.finishSignIn(consentRedirect(pasted.authUrl, 'http://127.0.0.1:9/')))).toContain('not the one');
    await window.google.finishSignIn(consentRedirect(pasted.authUrl, pasted.redirectUri, { allow: ['openid', 'email', TASKS_SCOPE] }));
    expect(window.client.getView().error).toBe(`Connected ${ME} to the Planner`);
    // Features follow what Google granted: Tasks alone, so no calendar is read.
    expect(window.google.getView().status!.accounts.map((account) => [account.email, account.features])).toEqual([[ME, ['tasks']]]);
    expect(requestsTo(planner, 'GET', '/users/me/calendarList')).toEqual([]);

    // Again from the window, Google's redirect reaching this machine: Calendar too now (Google keeps what it granted),
    // and the account's own calendar shows from the start.
    await window.google.connect(['calendar', 'tasks']);
    const signIn = window.google.getView().signIn!;
    expect(await (await fetch(consentRedirect(signIn.authUrl, signIn.redirectUri))).text()).toContain(`The Planner can now use ${ME}`);
    expect(await until(() => window.google.getView().status?.accounts[0]?.features.join() === 'calendar,tasks', 8000)).toBe(true);
    const subscriptions = async () => Object.values((await planner.state()).calendars).filter((calendar) => calendar.google).map((calendar) => `${calendar.google!.calendarId}:${calendar.visible}`);
    expect(await until(async () => (await subscriptions()).length > 0, 5000)).toBe(true);
    expect(await subscriptions()).toEqual(['primary:true']);

    // The client secret and the refresh tokens stay in a file only the user can read, beside the plan; no answer has them.
    const file = join(planner.home, 'google-accounts.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    const refresh = stored.accounts[0].refreshToken as string;
    expect([statSync(file).mode & 0o777, stored.client.secret, refresh]).toEqual([0o600, SECRET, expect.stringMatching(/^fake-refresh-/)]);
    answers.push((await planner.call('GET', '/google/status')).body, window.google.getView());
    expect(JSON.stringify(answers)).not.toContain(SECRET);
    expect(JSON.stringify(answers)).not.toContain(refresh);

    // A token Google refuses is refreshed once, with the stored refresh token, and the read goes through.
    planner.google!.failNext('GET', '/calendar/v3/calendars/primary/events', 401, 'Invalid Credentials');
    const today = todayIn(LA);
    const look = await window.client.calendarEvents(today, today, true);
    expect([look.errors, look.events.some((event) => event.title === 'Quarter planning')]).toEqual([[], true]);
    expect(requestsTo(planner, 'POST', '/token').at(-1)!.body).toEqual({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID, client_secret: SECRET });
    // Access taken back in the account's permissions: the calendar says to connect again.
    planner.google!.world.revoked = true;
    expect((await window.client.calendarEvents(today, today, true)).errors[0]!.message).toContain('connect it again');
    planner.google!.world.revoked = false;

    // Removing the account revokes it at Google, and takes its calendars and the session calendar off the plan.
    await window.google.setTimeboxCalendar({ account: ME, calendarId: 'primary' });
    await window.google.removeAccount(ME);
    expect(requestsTo(planner, 'POST', '/revoke').at(-1)!.body).toEqual({ token: refresh });
    const state = await planner.state();
    expect([await subscriptions(), state.settings.googleTimebox, window.google.getView().status!.accounts]).toEqual([[], null, []]);
    expect((await planner.call('DELETE', '/google/client')).body).toEqual({ client: null, accounts: [] });
  }, 20_000);
});

describe('Google Calendar', () => {
  const { world, today } = calendarWorld();
  const planner = usePlanner({ zone: LA, google: world });
  let window: PlannerWindow;
  let workSub = '';
  beforeAll(async () => {
    window = await planner.window();
  });
  /** What the calendar shows of one subscription between two days, read again from Google. */
  const read = async (from: string, to: string, subscription = workSub) => {
    const answer = await window.client.calendarEvents(from, to, true);
    const trouble = answer.errors.filter((error) => error.calendarId === subscription);
    if (trouble.length) throw new Error(`the calendar could not be read: ${JSON.stringify(trouble)}`);
    return answer.events.filter((event) => event.calendarId === subscription);
  };
  const ref = (calendarId: string, eventId: string) => ({ account: ME, calendarId, eventId }) as GoogleEventRef;
  const titled = (events: CalendarEvent[], title: string) => events.filter((event) => event.title === title);

  test("the first time the Planner sees the account, its own calendar shows, once; the user's later choices stay", async () => {
    const shown = async () => Object.values((await planner.state()).calendars).filter((calendar) => calendar.google).map((calendar) => `${calendar.google!.calendarId}:${calendar.visible}`).sort();
    await window.google.checkStatus();
    expect(await until(async () => (await shown()).length > 0)).toBe(true);
    expect(await shown()).toEqual(['primary:true']);
    expect((await planner.state()).settings.googleCalendarsIntroduced).toEqual([ME]);
    // The account's calendars, read page after page, are all offered.
    expect(window.google.getView().calendars.map((calendar) => calendar.name)).toEqual([ME, 'Team', 'Holidays', 'Work']);
    expect(requestsTo(planner, 'GET', '/users/me/calendarList').some((request) => request.query.pageToken)).toBe(true);
    // Hidden by the user: a window opened later leaves it hidden.
    const [own, team] = [window.google.getView().calendars[0]!, window.google.getView().calendars[1]!];
    await window.google.setVisible(own, false);
    const later = await planner.window();
    await later.google.loadCalendars();
    expect(await shown()).toEqual(['primary:false']);
    // Removed, with another of the account's calendars shown: a first sight of the account adds nothing.
    await window.google.showCalendar(own, false);
    await window.google.showCalendar(team, true);
    await planner.commands({ type: 'settings.updated', patch: { googleCalendarsIntroduced: [] } });
    await (await planner.window()).google.loadCalendars();
    expect(await shown()).toEqual([`${TEAM}:true`]);
    expect((await planner.state()).settings.googleCalendarsIntroduced).toEqual([ME]);
    // A first sight with two loads at once (the window starting and the rail opening): the calendar is shown once.
    const teamSub = Object.values((await planner.state()).calendars).find((calendar) => calendar.google)!.id;
    await planner.commands({ type: 'calendar.removed', calendarId: teamSub }, { type: 'settings.updated', patch: { googleCalendarsIntroduced: [] } });
    const twice = await planner.window();
    await Promise.all([twice.google.loadCalendars(), twice.google.loadCalendars()]);
    expect(await shown()).toEqual(['primary:true']);
  });

  // Found by this suite (2026-11-05): GoogleStore.introduce chains first sights within one window only, so two windows
  // seeing the account at the same moment each added its calendar (two subscriptions of it, its events shown once).
  test('two windows seeing the account for the first time at once show its calendar once', async () => {
    const shown = async () => Object.values((await planner.state()).calendars).filter((calendar) => calendar.google).map((calendar) => calendar.google!.calendarId);
    const before = Object.values((await planner.state()).calendars).filter((calendar) => calendar.google);
    await planner.commands(...before.map((calendar) => ({ type: 'calendar.removed', calendarId: calendar.id }) as const), { type: 'settings.updated', patch: { googleCalendarsIntroduced: [] } });
    const [a, b] = [await planner.window(), await planner.window()];
    await Promise.all([a.google.loadCalendars(), b.google.loadCalendars()]);
    expect(await shown()).toEqual(['primary']);
    await Promise.all([a.client.refresh(), b.client.refresh()]);
    expect([a, b].map((each) => Object.values(each.client.getView().state.calendars).filter((calendar) => calendar.google).length)).toEqual([1, 1]);
  });

  test('the week as the calendar shows it: every page, what may be done with each event, Google tasks on their days, a hidden calendar left out', async () => {
    const own = await showCalendar(planner, 'primary', ME);
    const team = await showCalendar(planner, TEAM, 'Team');
    await showCalendar(planner, 'holidays', 'Holidays');
    await planner.commands({ type: 'gtask.kept', account: ME, listId: 'L2', taskId: 't-stamps', patch: { deadline: addDays(today, 2) } });
    const week = await window.client.calendarEvents(addDays(today, -1), addDays(today, 6), true);
    expect(week.errors).toEqual([]);
    const events = week.events;
    expect(titled(events, 'Quarter planning')[0]!.google).toMatchObject({ account: ME, calendarId: 'primary', eventId: 'planning', editable: true, guests: true, meet: 'https://meet.google.com/abc-defg-hij' });
    expect(titled(events, 'Vendor demo')[0]!.google).toMatchObject({ editable: false, response: 'needsAction', guests: true });
    expect(titled(events, 'Standup').map((event) => event.calendarId)).toEqual(Array(8).fill(own));
    // Declined stays on the calendar but blocks no time; a free event blocks none; cancelled ones and the Planner's
    // own sessions are not events.
    expect(titled(events, 'Skip-level')[0]).toMatchObject({ busy: false, google: { response: 'declined', editable: false } });
    expect(titled(events, 'Office hours')[0]!.busy).toBe(false);
    expect([titled(events, 'Cancelled sync'), titled(events, 'Write the report')]).toEqual([[], []]);
    expect(titled(events, 'Team offsite')[0]).toMatchObject({ allDay: true, busy: false, start: instantAt(addDays(today, 2), 0, LA), end: instantAt(addDays(today, 4), 0, LA) });
    expect([titled(events, 'Sprint retro')[0]!.google!.editable, titled(events, 'Founders day')[0]!.google!.editable]).toEqual([true, false]);
    expect(requestsTo(planner, 'GET', '/calendar/v3/calendars/primary/events').some((request) => request.query.pageToken)).toBe(true);
    // Google tasks on their due day, completed ones too, with no Tasks calendar subscribed; a deadline kept in the
    // Planner brings its undated task along.
    const tasks = events.filter((event) => event.googleTask).map((event) => [event.googleTask!.id, event.googleTask!.due, event.googleTask!.completed]);
    expect(tasks).toEqual(expect.arrayContaining([['t-report', today, false], ['t-trip', addDays(today, 3), false], ['t-old', addDays(today, -1), true]]));
    expect(week.deadlineTasks!.map((task) => task.id)).toEqual(['t-stamps']);
    // The details: a series' rule; guests and their answers, the place, the call, the description and notifications.
    expect(await eventDetail(window.client, titled(events, 'Standup')[2]!.google!)).toMatchObject({ recurringEventId: 'standup', recurrence: ['RRULE:FREQ=DAILY'], editable: true });
    const planning = await eventDetail(window.client, ref('primary', 'planning'));
    expect(planning).toMatchObject({ description: '<b>Agenda</b><br>Goals<br>Budget', location: 'Room 4', meet: { url: 'https://meet.google.com/abc-defg-hij' }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } });
    expect(planning.attendees.map((guest) => [guest.email, guest.response])).toEqual([[ME, 'accepted'], ['ann@example.com', 'accepted'], ['bo@example.com', 'needsAction']]);
    // Hidden: the Team calendar's events are left out. Search asks Google over the calendars shown.
    await planner.commands({ type: 'calendar.updated', calendarId: team, patch: { visible: false } });
    expect(titled(await read(today, addDays(today, 6), team), 'Sprint retro')).toEqual([]);
    expect((await searchEvents(window.client, 'planning')).events.map((event) => event.title)).toEqual(['Quarter planning']);
    expect(requestsTo(planner, 'GET', '/calendar/v3/calendars/primary/events').some((request) => request.query.q === 'planning')).toBe(true);
  });

  test('an event made with a guest and a Meet call shows at once; guests keep their answers; an invitation answered; moved to another calendar, deleted and put back once', async () => {
    const at = (minutes: number) => pacific(instantAt(today, minutes, LA));
    await window.client.calendarEvents(today, today);
    const made = await createEvent(window.client, ME, 'primary', { summary: 'Harness 1:1', description: 'Notes', start: at(600), end: at(630), attendees: [{ email: 'ann@example.com' }], meet: true }, 'all');
    const insert = requestsTo(planner, 'POST', '/calendar/v3/calendars/primary/events').at(-1)!;
    expect(insert.query).toMatchObject({ sendUpdates: 'all', conferenceDataVersion: '1' });
    expect(insert.body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    expect(made).toMatchObject({ title: 'Harness 1:1', editable: true, meet: { url: expect.stringMatching(/^https:\/\/meet\.google\.com\//) } });
    // The next look has it, without waiting for what was read before to expire.
    expect(titled((await window.client.calendarEvents(today, today)).events, 'Harness 1:1')).toHaveLength(1);

    // Guests who stay keep their answers, the one taken off goes, the organizer stays; the guests hear of it.
    await updateEvent(window.client, ref('primary', 'planning'), { attendees: [{ email: 'ann@example.com' }, { email: 'cy@example.com', optional: true }] }, 'this', 'all');
    expect(eventsIn(planner, 'primary').get('planning').attendees).toEqual([{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', displayName: 'Ann Lee', responseStatus: 'accepted' }, { email: 'cy@example.com', optional: true }]);
    // Its Meet call taken off.
    await updateEvent(window.client, ref('primary', 'planning'), { meet: false }, 'this', 'none');
    expect([eventsIn(planner, 'primary').get('planning').hangoutLink, requestsTo(planner, 'PATCH', '/events/planning').at(-1)!.query.conferenceDataVersion]).toEqual([undefined, '1']);
    // An invitation answered: my own answer alone, and the organizer hears it. Not on the guest list: nothing to answer.
    await respondToEvent(window.client, ref('primary', 'invite'), 'accepted', 'this');
    expect(requestsTo(planner, 'PATCH', '/events/invite').at(-1)!.query.sendUpdates).toBe('all');
    expect(eventsIn(planner, 'primary').get('invite').attendees).toEqual([{ email: 'vendor@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'accepted' }]);
    const standup = titled((await window.client.calendarEvents(addDays(today, 1), addDays(today, 1), true)).events, 'Standup')[0]!;
    expect(await failure(respondToEvent(window.client, standup.google!, 'accepted', 'this'))).toContain('guest list');

    // Moved to the Team calendar; deleted there, then Undo: back with its title, times, guests and call, without
    // Google's own bookkeeping, the guests told again; once only.
    await moveEventToCalendar(window.client, ref('primary', made.id), TEAM, 'none');
    expect([eventsIn(planner, 'primary').has(made.id), eventsIn(planner, TEAM).get(made.id)?.summary]).toEqual([false, 'Harness 1:1']);
    const deleted = await deleteEvent(window.client, ref(TEAM, made.id), 'this', 'all');
    expect(eventsIn(planner, TEAM).has(made.id)).toBe(false);
    await restoreEvent(window.client, deleted.undo!);
    const copy = requestsTo(planner, 'POST', `/calendar/v3/calendars/${TEAM}/events`).at(-1)!;
    expect(copy.query).toMatchObject({ sendUpdates: 'all', conferenceDataVersion: '1' });
    expect(copy.body).toMatchObject({ summary: 'Harness 1:1', description: 'Notes', start: insert.body.start, attendees: [{ email: 'ann@example.com' }], conferenceData: { entryPoints: [{ uri: made.meet!.url }] } });
    expect(Object.keys(copy.body).filter((key) => ['id', 'etag', 'htmlLink', 'iCalUID', 'organizer', 'creator', 'created', 'updated', 'hangoutLink'].includes(key))).toEqual([]);
    expect([...eventsIn(planner, TEAM).values()].filter((event) => event.summary === 'Harness 1:1')).toHaveLength(1);
    expect(await failure(restoreEvent(window.client, deleted.undo!))).toContain('can no longer be undone');
    // One occurrence deleted comes back, confirmed.
    const one = await deleteEvent(window.client, standup.google!, 'this', 'none');
    const tomorrow = async () => titled((await window.client.calendarEvents(addDays(today, 1), addDays(today, 1), true)).events, 'Standup').length;
    expect(await tomorrow()).toBe(0);
    await restoreEvent(window.client, one.undo!);
    expect(await tomorrow()).toBe(1);
  });

  test('a recurring event changed for This event, This and following and All events, across the change from summer time in Los Angeles', async () => {
    workSub = await showCalendar(planner, WORK, 'Work');
    const starts = (events: CalendarEvent[], title: string) => titled(events, title).map((event) => event.start);
    // 9am every Monday on both sides of the change; the day the clocks go back is 25 hours long.
    let fall = await read('2026-10-19', '2026-11-15');
    expect(starts(fall, 'Design sync')).toEqual(['2026-10-19T16:00:00.000Z', '2026-10-26T16:00:00.000Z', '2026-11-02T17:00:00.000Z', '2026-11-09T17:00:00.000Z']);
    expect(titled(fall, 'Fall back')[0]).toMatchObject({ allDay: true, start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' });
    // All events, from the Monday before the change to the one after it, at the same 9am: the series starts a week
    // later, at 9am in summer time, and every occurrence stays at 9am.
    await updateEvent(window.client, titled(fall, 'Design sync')[1]!.google!, { start: pacific('2026-11-02T17:00:00.000Z'), end: pacific('2026-11-02T18:00:00.000Z') }, 'all', 'none');
    expect(eventsIn(planner, WORK).get('design').start).toEqual(pacific('2026-10-26T16:00:00.000Z'));
    expect(starts(await read('2026-10-19', '2026-11-15'), 'Design sync')).toEqual(['2026-10-26T16:00:00.000Z', '2026-11-02T17:00:00.000Z', '2026-11-09T17:00:00.000Z']);

    // This event: that occurrence alone, at 11am; a repeat rule is not one occurrence's to change.
    fall = await read('2026-10-05', '2026-11-15');
    const team = (date: string) => titled(fall, 'Team sync').find((event) => event.start.startsWith(date))!.google!;
    await updateEvent(window.client, team('2026-10-26'), { start: pacific('2026-10-26T18:00:00.000Z'), end: pacific('2026-10-26T19:00:00.000Z') }, 'this', 'none');
    expect(await failure(updateEvent(window.client, team('2026-10-19'), { recurrence: ['RRULE:FREQ=DAILY'] }, 'this', 'none'))).toContain('This and following');
    // This and following from the first Monday after the change, Google failing its second step: the new series is
    // taken back and the old one is as it was.
    planner.google!.failNext('PATCH', '/events/split', 500, 'Backend Error');
    expect(await failure(updateEvent(window.client, team('2026-11-02'), { summary: 'New sync' }, 'following', 'none'))).toBe('Backend Error');
    const renamed = () => [...eventsIn(planner, WORK).values()].filter((event) => event.summary === 'New sync');
    expect([eventsIn(planner, WORK).get('split').recurrence, renamed()]).toEqual([['RRULE:FREQ=WEEKLY;BYDAY=MO'], []]);
    // Then for good: the old series ends the second before (UNTIL, in UTC), a new one starts there with the change,
    // the description and notifications, and the guests without the answers they gave the old one.
    await updateEvent(window.client, team('2026-11-02'), { summary: 'New sync' }, 'following', 'none');
    expect(eventsIn(planner, WORK).get('split').recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T165959Z']);
    expect(renamed()[0]).toMatchObject({ description: 'Agenda', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } });
    expect(renamed()[0].attendees.find((guest: { email: string }) => guest.email === 'ann@example.com')).toEqual({ email: 'ann@example.com', displayName: 'Ann' });
    const syncs = titled(await read('2026-10-05', '2026-11-15'), 'Team sync').concat(titled(await read('2026-10-05', '2026-11-15'), 'New sync'));
    expect(syncs.map((event) => [event.start, event.title])).toEqual([
      ['2026-10-05T16:00:00.000Z', 'Team sync'],
      ['2026-10-12T16:00:00.000Z', 'Team sync'],
      ['2026-10-19T16:00:00.000Z', 'Team sync'],
      ['2026-10-26T18:00:00.000Z', 'Team sync'],
      ['2026-11-02T17:00:00.000Z', 'New sync'],
      ['2026-11-09T17:00:00.000Z', 'New sync'],
    ]);

    // All events moved to another weekday: the series and its weekday follow (Gym on Thursdays).
    const gym = titled(await read('2026-10-07', '2026-10-31'), 'Gym');
    await updateEvent(window.client, gym[1]!.google!, { start: pacific('2026-10-15T14:00:00.000Z'), end: pacific('2026-10-15T15:00:00.000Z') }, 'all', 'none');
    expect(eventsIn(planner, WORK).get('gym')).toMatchObject({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'], start: pacific('2026-10-08T14:00:00.000Z') });
    expect(titled(await read('2026-10-07', '2026-10-31'), 'Gym').map((event) => event.start.slice(0, 10))).toEqual(['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
    // A fourth Monday moved to a Tuesday repeats on the third Tuesday; a rule the Planner can't carry over is refused.
    const retro = titled(await read('2026-10-26', '2026-10-26'), 'Retro')[0]!;
    await updateEvent(window.client, retro.google!, { start: pacific('2026-10-20T22:00:00.000Z'), end: pacific('2026-10-20T23:00:00.000Z') }, 'all', 'none');
    expect(eventsIn(planner, WORK).get('monthly').recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=3TU']);
    const board = titled(await read('2026-10-12', '2026-10-12'), 'Board')[0]!;
    expect(await failure(updateEvent(window.client, board.google!, { start: pacific('2026-10-13T17:00:00.000Z'), end: pacific('2026-10-13T18:00:00.000Z') }, 'all', 'none'))).toContain('cannot move');
    expect(eventsIn(planner, WORK).get('board')).toMatchObject({ recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2'], start: pacific('2026-10-12T17:00:00.000Z') });
    // An all-day series split ends the day before (UNTIL a date); deleting the rest of a series ends it there, with no Undo.
    const paydays = titled(await read('2026-10-01', '2026-10-31'), 'Payday');
    await updateEvent(window.client, paydays[3]!.google!, { summary: 'Payday, new bank' }, 'following', 'none');
    expect(eventsIn(planner, WORK).get('payday').recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261022']);
    expect((await read('2026-10-01', '2026-10-31')).filter((event) => event.title.startsWith('Payday')).map((event) => event.title)).toEqual(['Payday', 'Payday', 'Payday', 'Payday, new bank', 'Payday, new bank']);
    const yoga = titled(await read('2026-10-01', '2026-10-10'), 'Yoga');
    expect((await deleteEvent(window.client, yoga[4]!.google!, 'following', 'none')).undo).toBeNull();
    expect(titled(await read('2026-10-01', '2026-10-10'), 'Yoga').map((event) => event.start.slice(0, 10))).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  });

  test('This and following on a counted series counts the occurrences before it, a deleted one too, read page after page', async () => {
    const pills = async () => (await read('2026-10-01', '2026-10-14')).filter((event) => event.title.startsWith('Pills'));
    const all = await pills();
    expect(all).toHaveLength(12);
    await deleteEvent(window.client, all[2]!.google!, 'this', 'none');
    await updateEvent(window.client, all[9]!.google!, { summary: 'Pills, new box' }, 'following', 'none');
    const instances = requestsTo(planner, 'GET', '/events/pills/instances');
    expect([instances.every((request) => request.query.showDeleted === 'true'), instances.some((request) => request.query.pageToken)]).toEqual([true, true]);
    expect([...eventsIn(planner, WORK).values()].find((event) => event.summary === 'Pills, new box').recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=3']);
    expect((await pills()).map((event) => `${event.start.slice(5, 10)} ${event.title}`)).toEqual([
      ...['01', '02', '04', '05', '06', '07', '08', '09'].map((day) => `10-${day} Pills`),
      ...['10', '11', '12'].map((day) => `10-${day} Pills, new box`),
    ]);
  });

  test("refusals: what the Planner won't send and what Google refuses keep their meaning, and leave Google as it was", async () => {
    const writes = () => planner.google!.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/calendar/')).length;
    const before = writes();
    const at = (hour: number) => pacific(instantAt(today, hour * 60, LA));
    const make = (event: Record<string, unknown>) => failure(createEvent(window.client, ME, 'primary', { summary: 'Refused', ...event }, 'none'));
    expect(await make({})).toContain('start and an end');
    expect(await make({ start: at(11), end: at(10) })).toContain('end after it starts');
    expect(await make({ start: at(10), end: at(11), attendees: [{ email: 'not an email' }] })).toContain('not an email');
    expect(await make({ start: at(10), end: at(11), recurrence: ['FREQ=DAILY'] })).toContain('RRULE');
    expect(await make({ start: at(10), end: at(11), eventType: 'focusTime' })).toContain('unknown event field');
    expect((await planner.call('PATCH', '/google/events', { account: ME, calendarId: 'primary', eventId: 'planning', scope: 'sometimes', event: {} })).status).toBe(400);
    expect(writes()).toBe(before);
    // Google's answers: a calendar the account may only read, a clash, Google's own trouble, a scope taken back.
    const patch = (calendarId: string, eventId: string) => planner.call('PATCH', '/google/events', { account: ME, calendarId, eventId, scope: 'this', event: { summary: 'Renamed' } });
    expect(await patch('holidays', 'holiday')).toEqual({ status: 403, body: { error: 'You need to have writer access to this calendar.' } });
    const answers: unknown[] = [];
    for (const [status, message] of [[412, 'Precondition Failed'], [503, 'Backend Error'], [403, 'Request had insufficient authentication scopes.']] as const) {
      planner.google!.failNext('PATCH', '/events/planning', status, message);
      answers.push(await patch('primary', 'planning'));
    }
    expect(answers).toEqual([
      { status: 409, body: { error: 'Precondition Failed' } },
      { status: 502, body: { error: 'Backend Error' } },
      { status: 403, body: { error: `${ME} has not allowed this; connect it again with that feature turned on` } },
    ]);
    expect(eventsIn(planner, 'primary').get('planning').summary).toBe('Quarter planning');
    // Deleted in Google Calendar meanwhile: changing it says so; deleting it again is no trouble.
    expect(await patch('primary', 'never-was')).toEqual({ status: 404, body: { error: 'This event is no longer in Google Calendar' } });
    expect(await deleteEvent(window.client, ref('primary', 'never-was'), 'this', 'none')).toEqual({ requests: 0, undo: null });
    // A calendar of an account that is not connected says so; the rest still shows.
    await planner.commands({ type: 'calendar.added', calendar: { id: 'stranger', name: 'Other', url: 'https://calendar.google.com/calendar/r', color: '#4285f4', google: { account: 'someone@example.com', calendarId: 'primary' } } });
    const look = await window.client.calendarEvents(today, today, true);
    expect([look.errors, titled(look.events, 'Quarter planning').length]).toEqual([[{ calendarId: 'stranger', message: 'someone@example.com is not connected' }], 1]);
    await planner.commands({ type: 'calendar.removed', calendarId: 'stranger' });
  });

  test("working sessions go to the chosen calendar, or their channel's: written, linked, moved, renamed and removed with their event, even while it is being made", async () => {
    const day = addDays(today, 1);
    const span = (hour: number, minutes = 60) => ({ start: instantAt(day, hour * 60, LA), end: instantAt(day, hour * 60 + minutes, LA) });
    const linked = async (blockId: string) => (await planner.state()).blocks[blockId]?.google ?? null;
    const posted = (blockId: string) => requestsTo(planner, 'POST', /^\/calendar\/v3\/calendars\/[^/]+\/events$/).filter((request) => request.body?.extendedProperties?.private?.plannerBlockId === blockId);
    // Without a calendar chosen, a session stays in the Planner.
    await planner.commands({ type: 'task.created', task: { id: 'tests', title: 'Write tests', placement: { kind: 'day', date: day }, position: 1024 } }, { type: 'block.created', block: { id: 'blk0', taskId: 'tests', ...span(8) } });
    await window.google.setTimeboxCalendar({ account: ME, calendarId: 'primary' });
    await planner.commands({ type: 'block.created', block: { id: 'blk1', taskId: 'tests', ...span(10) } });
    const link = (await until(() => linked('blk1')))!;
    expect(link).toMatchObject({ account: ME, calendarId: 'primary' });
    expect(eventsIn(planner, 'primary').get(link.eventId)).toMatchObject({ summary: 'Write tests', transparency: 'opaque', reminders: { useDefault: false }, extendedProperties: { private: { plannerBlockId: 'blk1', plannerTaskId: 'tests' } }, start: { dateTime: span(10).start } });
    expect(posted('blk0')).toEqual([]);
    // Moved and renamed here: Google follows. Deleted: its event goes.
    const event = () => eventsIn(planner, 'primary').get(link.eventId);
    await planner.commands({ type: 'block.updated', blockId: 'blk1', ...span(13, 90) });
    expect(await until(() => event().end.dateTime === span(13, 90).end)).toBe(true);
    await planner.commands({ type: 'task.updated', taskId: 'tests', patch: { title: 'Write more tests' } });
    expect(await until(() => event().summary === 'Write more tests')).toBe(true);
    await planner.commands({ type: 'block.deleted', blockId: 'blk1' });
    expect(await until(() => !eventsIn(planner, 'primary').has(link.eventId))).toBe(true);
    // Deleted while Google is still making its event: the event goes too, once made.
    const deletes = () => requestsTo(planner, 'DELETE', '/calendar/v3/calendars/primary/events/').length;
    const deletedBefore = deletes();
    planner.google!.delayNext('POST', '/calendar/v3/calendars/primary/events', 400);
    await planner.commands({ type: 'block.created', block: { id: 'blk2', taskId: 'tests', ...span(15) } });
    expect(await until(() => posted('blk2').length === 1)).toBe(true);
    await planner.commands({ type: 'block.deleted', blockId: 'blk2' });
    const sessionOf = (blockId: string) => [...eventsIn(planner, 'primary').values()].find((item) => item.extendedProperties?.private?.plannerBlockId === blockId);
    expect(await until(() => (posted('blk2')[0] as { answeredAt?: number }).answeredAt && !sessionOf('blk2') && deletes() === deletedBefore + 1, 3000)).toBe(true);
    // Its event deleted in Google Calendar, then the session moved here: the event is made again.
    await planner.commands({ type: 'block.created', block: { id: 'blk3', taskId: 'tests', ...span(16) } });
    const gone = (await until(() => linked('blk3')))!;
    eventsIn(planner, 'primary').delete(gone.eventId);
    await planner.commands({ type: 'block.updated', blockId: 'blk3', ...span(17) });
    const remade = await until(async () => ((await linked('blk3'))?.eventId !== gone.eventId ? linked('blk3') : null));
    expect(sessionOf('blk3')).toMatchObject({ id: remade!.eventId, start: { dateTime: span(17).start } });
    // A #personal task's sessions go to its channel's calendar (Timeboxing Channel), over the default.
    await planner.commands(
      { type: 'settings.updated', patch: { channelTimebox: { personal: { account: ME, calendarId: TEAM } } } },
      { type: 'task.created', task: { id: 'dentist', title: 'Dentist', placement: { kind: 'day', date: day }, position: 2048, channelId: 'personal' } },
      { type: 'block.created', block: { id: 'blk4', taskId: 'dentist', ...span(11) } },
    );
    expect(await until(async () => (await linked('blk4'))?.calendarId)).toBe(TEAM);
    expect(eventsIn(planner, TEAM).get((await linked('blk4'))!.eventId).summary).toBe('Dentist');
    // A session Google refuses to take: Settings says why.
    planner.google!.failNext('POST', '/calendar/v3/calendars/primary/events', 403, 'You need to have writer access to this calendar.');
    await planner.commands({ type: 'block.created', block: { id: 'blk5', taskId: 'tests', ...span(18) } });
    expect(await until(async () => (await planner.call('GET', '/google/status')).body.timeboxError)).toBe('You need to have writer access to this calendar.');
  });

  test('sessions moved or deleted in Google Calendar follow in the Planner, ten lookups a read, without being sent back; a read while a change is on its way is not believed', async () => {
    const day = addDays(today, 2);
    const at = (date: string, minutes: number) => instantAt(date, minutes, LA);
    const ids = Array.from({ length: 15 }, (_, n) => `back${n}`);
    await planner.commands(
      { type: 'task.created', task: { id: 'focus', title: 'Focus', placement: { kind: 'day', date: day }, position: 4096 } },
      ...ids.map((id, n) => ({ type: 'block.created' as const, block: { id, taskId: 'focus', start: at(day, 360 + n * 60), end: at(day, 390 + n * 60) } })),
    );
    const blocks = async () => (await planner.state()).blocks;
    const links = (await until(async () => {
      const now = await blocks();
      return ids.every((id) => now[id]?.google) ? ids.map((id) => now[id]!.google!) : null;
    }, 8000))!;
    // Later (the service restarted since, so nothing was written lately), the session calendar now Team: in Google
    // Calendar back0 is moved to 7–8am, back1 deleted, back2 moved to next week, and twelve more deleted.
    await planner.commands({ type: 'settings.updated', patch: { googleTimebox: { account: ME, calendarId: TEAM } } });
    await planner.restart();
    const primary = eventsIn(planner, 'primary');
    Object.assign(primary.get(links[0]!.eventId), { start: { dateTime: at(day, 420) }, end: { dateTime: at(day, 480) } });
    Object.assign(primary.get(links[2]!.eventId), { start: { dateTime: at(addDays(day, 7), 600) }, end: { dateTime: at(addDays(day, 7), 630) } });
    for (const link of [links[1]!, ...links.slice(3)]) primary.delete(link.eventId);
    const writes = () => planner.google!.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/calendar/')).length;
    const before = writes();
    const left = async () => Object.keys(await blocks()).filter((id) => id.startsWith('back')).sort();
    await planner.call('GET', `/calendar?from=${day}&to=${day}&refresh=1`);
    expect(await until(async () => (await left()).length === 6)).toBe(true);
    const now = await blocks();
    expect([now.back0!.start, now.back0!.end, now.back2!.start]).toEqual([at(day, 420), at(day, 480), at(addDays(day, 7), 600)]);
    // More missing than a read asks Google about: the rest at the next read.
    expect(await left()).toEqual(['back0', 'back11', 'back12', 'back13', 'back14', 'back2']);
    await planner.call('GET', `/calendar?from=${day}&to=${day}&refresh=1`);
    expect(await until(async () => (await left()).length === 2)).toBe(true);
    expect(writes()).toBe(before);
    // Moved here while Google is slow to take it: a read meanwhile, with the old time, doesn't move it back.
    planner.google!.delayNext('PATCH', `/events/${links[0]!.eventId}`, 800);
    await planner.commands({ type: 'block.updated', blockId: 'back0', start: at(day, 720), end: at(day, 750) });
    await planner.call('GET', `/calendar?from=${day}&to=${day}&refresh=1`);
    expect(await until(() => (requestsTo(planner, 'PATCH', `/events/${links[0]!.eventId}`)[0] as { answeredAt?: number } | undefined)?.answeredAt, 3000)).toBeTruthy();
    expect([(await blocks()).back0!.start, primary.get(links[0]!.eventId).start.dateTime]).toEqual([at(day, 720), at(day, 720)]);
  }, 20_000);

  test('a Google task made while the calendar was being read shows at the next look', async () => {
    planner.google!.delayNext('GET', '/tasks/v1/lists/L2/tasks', 600);
    const since = Date.now();
    const first = planner.call('GET', `/calendar?from=${today}&to=${today}&refresh=1`);
    expect(await until(() => requestsTo(planner, 'GET', '/tasks/v1/lists/L1/tasks').some((request) => request.query.dueMin && request.at >= since && (request as { answeredAt?: number }).answeredAt))).toBe(true);
    const made = (await planner.call('POST', '/google/tasks', { account: ME, listId: 'L1', title: 'Call the bank', due: today })).body.task;
    await first;
    const next = await planner.call('GET', `/calendar?from=${today}&to=${today}`);
    expect(next.body.events.some((event: CalendarEvent) => event.googleTask?.id === made.id)).toBe(true);
  });

  describe('a calendar subscribed by its address (ICS)', () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:sync', 'DTSTART;TZID=America/Los_Angeles:20261026T100000', 'DTEND;TZID=America/Los_Angeles:20261026T103000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5', 'EXDATE;TZID=America/Los_Angeles:20261028T100000', 'SUMMARY:Sync', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:sync', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261102T100000', 'DTSTART;TZID=America/Los_Angeles:20261102T140000', 'DTEND;TZID=America/Los_Angeles:20261102T143000', 'SUMMARY:Sync (moved)', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:review', 'DTSTART;TZID=Pacific Standard Time:20261027T090000', 'DTEND;TZID=Pacific Standard Time:20261027T091500', 'SUMMARY:Planning\\, Q4 review with a very long', '  title that folds', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:offsite', 'DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261030', 'SUMMARY:Offsite', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:gone', 'DTSTART:20261027T200000Z', 'DURATION:PT30M', 'STATUS:CANCELLED', 'SUMMARY:Cancelled', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:hold', 'DTSTART:20261027T210000Z', 'DURATION:PT1H30M', 'TRANSP:TRANSPARENT', 'SUMMARY:Hold', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:pills', 'DTSTART:20261026T150000Z', 'DURATION:PT15M', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261101T000000Z', 'SUMMARY:Pills', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:board', 'DTSTART:20261013T160000Z', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:Board', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:bday', 'DTSTART;VALUE=DATE:20201215', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday', 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n');
    let feed: Awaited<ReturnType<typeof serveFeed>>;
    beforeAll(async () => {
      feed = await serveFeed(ics);
    });
    afterAll(() => feed.close());

    test('its events keep their wall-clock time across the change, with exclusions, a moved occurrence, all-day, free and cancelled ones; while the feed is down its last copy shows', async () => {
      await planner.commands({ type: 'calendar.added', calendar: { id: 'feed', name: 'Team feed', url: feed.url, color: '#8e24aa' } });
      const shown = async () => (await read('2026-10-25', '2026-12-20', 'feed')).map((event) => [event.start.slice(0, 16), event.end.slice(11, 16), event.title, event.allDay, event.busy]);
      const expected = [
        ['2026-10-26T15:00', '15:15', 'Pills', false, true],
        ['2026-10-26T17:00', '17:30', 'Sync', false, true],
        ['2026-10-27T16:00', '16:15', 'Planning, Q4 review with a very long title that folds', false, true],
        ['2026-10-27T21:00', '22:30', 'Hold', false, false],
        ['2026-10-28T15:00', '15:15', 'Pills', false, true],
        ['2026-10-29T07:00', '07:00', 'Offsite', true, false],
        ['2026-10-30T15:00', '15:15', 'Pills', false, true],
        ['2026-11-02T22:00', '22:30', 'Sync (moved)', false, true],
        ['2026-11-04T18:00', '18:30', 'Sync', false, true],
        ['2026-11-09T18:00', '18:30', 'Sync', false, true],
        ['2026-11-10T16:00', '17:00', 'Board', false, true],
        ['2026-12-08T16:00', '17:00', 'Board', false, true],
        ['2026-12-15T08:00', '08:00', 'Birthday', true, false],
      ];
      expect(await shown()).toEqual(expected);
      expect((await searchEvents(window.client, 'folds')).events.map((event) => event.title)).toEqual(['Planning, Q4 review with a very long title that folds']);
      // The feed down: its last copy still shows; a feed that never answered says so beside the rest.
      feed.setDown(true);
      await planner.commands({ type: 'calendar.added', calendar: { id: 'nofeed', name: 'Gone feed', url: feed.missing, color: '#8e24aa' } });
      expect(await shown()).toEqual(expected);
      expect((await window.client.calendarEvents('2026-10-25', '2026-10-31', true)).errors).toEqual([{ calendarId: 'nofeed', message: 'calendar feed answered HTTP 503' }]);
      feed.setDown(false);
    });
  });
});

describe('Meetings imported from Google Calendar', () => {
  // Where it is about noon now: this morning's standup has ended, this afternoon's planning has not.
  const zone = noonZone();
  const { world, today, at } = meetingWorld(zone);
  const planner = usePlanner({ zone, google: world });

  test("auto-sync adds the week's meetings of the chosen calendars, Sunsama's five exclusions and declined ones left out; follows, completes and removes them; an import channel chosen goes at once to its calendar's meetings", async () => {
    await planner.commands(
      { type: 'calendar.added', calendar: { id: 'work', name: 'Work', url: 'https://calendar.google.com/calendar/r', color: '#039be5', google: { account: ME, calendarId: 'primary' } } },
      { type: 'calendar.added', calendar: { id: 'home', name: 'Home', url: 'https://calendar.google.com/calendar/r', color: '#33b679', google: { account: ME, calendarId: 'home@group.calendar.google.com' } } },
      { type: 'calendar.updated', calendarId: 'home', patch: { visible: false } },
      { type: 'settings.updated', patch: { meetingImport: 'autoSync', meetingAutoComplete: 'never' } },
    );
    const sync = async () => (await planner.call('POST', '/meetings/sync')).body;
    const meetings = async () => Object.values((await planner.state()).tasks).filter((task) => task.source?.kind === 'event');
    const live = async () => (await meetings()).filter((task) => !task.deletedAt).map((task) => task.title).sort();
    const task = async (eventId: string) => (await meetings()).find((item) => item.source!.id.endsWith(`|${eventId}`))!;
    const google = planner.google!.calendars.get('primary')!.events;
    // Auto-sync needs a calendar chosen.
    expect(await sync()).toMatchObject({ added: 0 });
    expect(await live()).toEqual([]);
    // Work chosen: the qualifying meetings of today and the six days after, each on its day, its length as planned
    // time. Two windows asking at once share one run, which reads Google once.
    await planner.commands({ type: 'settings.updated', patch: { meetingCalendars: ['work'] } });
    const reads = () => requestsTo(planner, 'GET', '/calendar/v3/calendars/primary/events').filter((request) => !request.query.pageToken).length;
    const readsBefore = reads();
    planner.google!.delayNext('GET', '/calendar/v3/calendars/primary/events', 300);
    const [one, other] = await Promise.all([sync(), sync()]);
    expect([one, other, reads() - readsBefore]).toEqual([{ added: 3, moved: 0, removed: 0, completed: 0, errors: [] }, one, 1]);
    expect(await live()).toEqual(['Design review', 'Quarter planning', 'Standup']);
    expect(await task('review')).toMatchObject({ placement: { kind: 'day', date: addDays(today, 1) }, plannedMinutes: 60, source: { key: 'Google Calendar', event: { auto: true, invitees: true } } });
    // Exclusions off: the excluded kinds come in, a declined meeting never; on again: they go.
    await planner.commands({ type: 'settings.updated', patch: { meetingExclusions: [] } });
    await sync();
    expect(await live()).toEqual(['Dentist', 'Design review', 'OOO: dentist', 'Office hours', 'Quarter planning', 'Standup', 'Team offsite', 'Vendor demo']);
    await planner.commands({ type: 'settings.updated', patch: { meetingExclusions: ['noAttendees', 'nonBlocking', 'oooHold', 'unconfirmed', 'multiDayAllDay'] } });
    await sync();
    expect(await live()).toEqual(['Design review', 'Quarter planning', 'Standup']);

    // Moved and renamed in Google: its task follows. A new one is added; held now ("HOLD"), it goes, and once removed
    // it is not added back.
    Object.assign(google.get('planning'), { summary: 'Quarter planning, moved', start: { dateTime: at(1, 16) }, end: { dateTime: at(1, 17, 30) } });
    google.set('kickoff', { id: 'kickoff', summary: 'Kickoff', start: { dateTime: at(2, 9) }, end: { dateTime: at(2, 10) }, organizer: { email: 'ann@example.com' }, attendees: [{ email: ME, self: true, responseStatus: 'accepted' }, { email: 'ann@example.com', organizer: true, responseStatus: 'accepted' }] });
    await sync();
    expect(await task('planning')).toMatchObject({ title: 'Quarter planning, moved', placement: { kind: 'day', date: addDays(today, 1) }, plannedMinutes: 90 });
    google.get('kickoff').summary = 'HOLD kickoff';
    await sync();
    google.get('kickoff').summary = 'Kickoff';
    await sync();
    expect((await task('kickoff')).deletedAt).not.toBeNull();

    // Ended: with auto-complete Never, left open; with Always, completed, but not while its timer runs, and not one
    // that has not ended yet.
    expect((await task('standup')).completedAt).toBeNull();
    await planner.commands({ type: 'timer.started', taskId: (await task('standup')).id }, { type: 'settings.updated', patch: { meetingAutoComplete: 'always' } });
    await sync();
    expect((await task('standup')).completedAt).toBeNull();
    await planner.commands({ type: 'timer.stopped' });
    await sync();
    expect([(await task('standup')).completedOn, (await task('planning')).completedAt]).toEqual([today, null]);
    // Completed, or with time recorded, they stay when their event goes.
    await planner.commands({ type: 'time.logged', entry: { id: 'review-notes', taskId: (await task('review')).id, start: at(0, 10), end: at(0, 10, 30) } });
    google.delete('standup');
    google.delete('review');
    await sync();
    expect(await live()).toEqual(['Design review', 'Quarter planning, moved', 'Standup']);
    // A calendar Google could not read keeps its meetings; one no longer chosen takes them off; a hidden one chosen is read.
    planner.google!.failNext('GET', '/calendar/v3/calendars/primary/events', 503, 'Backend Error');
    expect((await sync()).errors).toEqual([expect.stringContaining('Backend Error')]);
    expect(await live()).toEqual(['Design review', 'Quarter planning, moved', 'Standup']);
    await planner.commands({ type: 'settings.updated', patch: { meetingCalendars: ['home'] } });
    await sync();
    expect(await live()).toEqual(['Breakfast', 'Design review', 'Dinner with Bo', 'Family call', 'Standup']);

    // Round 13: the calendar's import channel, chosen after its first import, goes at once to its meetings with none;
    // one given a channel in another window keeps it, a done one stays without; one cleared by hand stays cleared,
    // through syncs and a restart.
    await sync();
    expect((await task('breakfast')).completedOn).toBe(today);
    await planner.commands({ type: 'task.updated', taskId: (await task('dinner')).id, patch: { channelId: 'work' } });
    await planner.commands({ type: 'settings.updated', patch: { meetingChannels: { home: 'personal' } } });
    expect(await until(async () => (await task('family')).channelId === 'personal', 2000)).toBe(true);
    expect([(await task('dinner')).channelId, (await task('breakfast')).channelId]).toEqual(['work', null]);
    await planner.commands({ type: 'task.updated', taskId: (await task('family')).id, patch: { channelId: null } });
    await sync();
    await planner.restart();
    await sync();
    expect([(await task('family')).channelId, (await task('dinner')).channelId]).toEqual([null, 'work']);
  }, 20_000);
});

// Not end to end: the test seam itself. A service pointed anywhere but this machine must keep talking to Google, and
// no token may go anywhere but Google's APIs; no scenario can show either without reaching the real Google.
describe('the Planner sends its Google tokens to Google alone', () => {
  test('only a loopback address replaces Google; a request for anything but a Google API is refused before it is sent', async () => {
    expect([testFetcher(undefined), testFetcher('https://evil.example/'), testFetcher('http://10.0.0.1:8080/')]).toEqual([null, null, null]);
    expect(testFetcher('http://127.0.0.1:8080/')).not.toBeNull();
    const accounts = new GoogleAccounts(join(tmpdir(), 'planner-never-written.json'), async () => {
      throw new Error('nothing may be fetched');
    });
    expect(await failure(accounts.request(ME, 'GET', 'https://evil.example/x'))).toContain('not a Google API');
  });
});
