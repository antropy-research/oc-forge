// The service as the host runs it, signed in to a fake Google on this machine
// (PLANNER_GOOGLE_API_BASE): Google tasks on the calendar, planned or not and
// with no calendar subscribed; and the calendar and Tasks routes end to end.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, todayIn } from '../src/domain/dates.ts';
import { defaultFakeWorld, startFakeGoogle, type FakeGoogle } from './e2e/fakeGoogle.mjs';

const token = 'google-service-test-token';
const ZONE = 'America/Los_Angeles';
const today = todayIn(ZONE);
const ME = 'harness@example.com';
let child: ChildProcess;
let fake: FakeGoogle;
let base = '';
let root = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
let seq = 0;
const commands = (...bodies: Record<string, unknown>[]) => call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `gs${String(++seq).padStart(8, '0')}`, ...body })) });
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

beforeAll(async () => {
  fake = await startFakeGoogle(defaultFakeWorld({ account: ME, today, zone: ZONE }));
  root = mkdtempSync(join(tmpdir(), 'planner-gservice-'));
  writeFileSync(join(root, 'google-accounts.json'), fake.accountsFile(), { mode: 0o600 });
  const port = await freePort();
  child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), PLANNER_GOOGLE_API_BASE: fake.base },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await commands({ type: 'settings.updated', patch: { timezone: ZONE } });
});

afterAll(async () => {
  const exited = new Promise((resolve) => child?.once('exit', resolve));
  child?.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await fake?.close();
  rmSync(root, { recursive: true, force: true });
});

const week = () => call('GET', `/calendar?${q({ from: today, to: addDays(today, 6), refresh: '1' })}`);

describe('Google tasks on the calendar', () => {
  test('they show on their due day with no calendar subscribed, completed ones too', async () => {
    const { status, body } = await call('GET', `/calendar?${q({ from: addDays(today, -1), to: addDays(today, 6) })}`);
    expect(status).toBe(200);
    const due = body.events.filter((event: any) => event.calendarId === 'google-tasks').map((event: any) => [event.googleTask.id, event.googleTask.due, event.googleTask.completed]);
    expect(due).toEqual(expect.arrayContaining([['t-report', today, false], ['t-trip', addDays(today, 3), false], ['t-old', addDays(today, -1), true]]));
  });

  test('a planned Google task stays on its due day, where the panel shows its link', async () => {
    const source = { kind: 'gtask', id: 't-report', key: 'Google Tasks', url: 'https://tasks.google.com/task/t-report', title: 'Send the report', status: { name: 'Open', type: 'open', color: '#1a73e8' }, account: ME, listId: 'L1' };
    expect((await commands({ type: 'task.created', task: { id: 'planned1', title: 'Send the report', placement: { kind: 'day', date: today }, position: 1024, dueDate: today, source } })).status).toBe(200);
    const { body } = await week();
    expect(body.events.some((event: any) => event.id === 'gtask:L1:t-report' && event.allDay)).toBe(true);
  });
});

describe('Google Calendar events through the service', () => {
  let subscription = '';
  test('a subscribed calendar reads every page, with what may be done with each event', async () => {
    subscription = 'gcalprimary1';
    await commands({ type: 'calendar.added', calendar: { id: subscription, name: ME, url: 'https://calendar.google.com/calendar/r', color: '#039be5', google: { account: ME, calendarId: 'primary' } } });
    const { body } = await week();
    const mine = body.events.filter((event: any) => event.calendarId === subscription);
    const planning = mine.find((event: any) => event.title === 'Quarter planning');
    expect(planning.google).toMatchObject({ account: ME, calendarId: 'primary', eventId: 'planning', editable: true, guests: true, meet: 'https://meet.google.com/abc-defg-hij' });
    expect(mine.find((event: any) => event.title === 'Vendor demo').google).toMatchObject({ editable: false, response: 'needsAction' });
    // A daily standup: seven of them in a week, read over several pages of the fake.
    expect(mine.filter((event: any) => event.title === 'Standup').length).toBe(7);
    expect(fake.requests.filter((request) => request.path === '/calendar/v3/calendars/primary/events' && request.query.pageToken).length).toBeGreaterThan(0);
  });

  test('details: the series rule, guests and answers, the call, the description', async () => {
    const standup = (await week()).body.events.find((event: any) => event.title === 'Standup');
    const { body } = await call('GET', `/google/event?${q({ account: ME, calendar: 'primary', id: standup.google.eventId })}`);
    expect(body.event).toMatchObject({ recurringEventId: 'standup', recurrence: ['RRULE:FREQ=DAILY'], editable: true });
    const planning = await call('GET', `/google/event?${q({ account: ME, calendar: 'primary', id: 'planning' })}`);
    expect(planning.body.event).toMatchObject({ description: '<b>Agenda</b><br>Goals<br>Budget', location: 'Room 4', meet: { url: 'https://meet.google.com/abc-defg-hij' }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } });
    expect(planning.body.event.attendees.map((guest: any) => [guest.email, guest.response])).toEqual([[ME, 'accepted'], ['ann@example.com', 'accepted'], ['bo@example.com', 'needsAction']]);
  });

  test('create with a Meet call, change this and following, answer, delete', async () => {
    const start = { dateTime: `${today}T17:00:00.000Z`, timeZone: ZONE };
    const end = { dateTime: `${today}T17:30:00.000Z`, timeZone: ZONE };
    const created = await call('POST', '/google/events', { account: ME, calendarId: 'primary', event: { summary: 'Harness 1:1', start, end, meet: true }, sendUpdates: 'none' });
    expect(created.status).toBe(200);
    expect(created.body.event.meet.url).toStartWith('https://meet.google.com/');
    expect(fake.requests.find((request) => request.method === 'POST' && request.path === '/calendar/v3/calendars/primary/events')!.query).toMatchObject({ sendUpdates: 'none', conferenceDataVersion: '1' });

    // This and following from tomorrow's standup: today's keeps its name, the rest is a new series.
    const standups = (await week()).body.events.filter((event: any) => event.title === 'Standup');
    const split = await call('PATCH', '/google/events', { account: ME, calendarId: 'primary', eventId: standups[1].google.eventId, scope: 'following', event: { summary: 'Standup (new)' } });
    expect(split).toEqual({ status: 200, body: { requests: 2 } });
    const titles = (await week()).body.events.filter((event: any) => event.title.startsWith('Standup')).map((event: any) => event.title);
    expect(titles).toEqual(['Standup', ...Array(6).fill('Standup (new)')]);
    expect(fake.calendars.get('primary')!.events.get('standup').recurrence[0]).toMatch(/^RRULE:FREQ=DAILY;UNTIL=\d{8}T\d{6}Z$/);

    expect((await call('POST', '/google/events/respond', { account: ME, calendarId: 'primary', eventId: 'invite', response: 'accepted' })).status).toBe(200);
    expect(fake.calendars.get('primary')!.events.get('invite').attendees.find((guest: any) => guest.self).responseStatus).toBe('accepted');

    expect((await call('DELETE', `/google/events?${q({ account: ME, calendar: 'primary', id: created.body.event.id, scope: 'this' })}`)).status).toBe(200);
    expect(fake.calendars.get('primary')!.events.has(created.body.event.id)).toBe(false);
  });

  test('refusals: a bad scope here, a calendar the account may only read in Google', async () => {
    expect((await call('PATCH', '/google/events', { account: ME, calendarId: 'primary', eventId: 'planning', scope: 'sometimes', event: {} })).status).toBe(400);
    const readOnly = await call('PATCH', '/google/events', { account: ME, calendarId: 'holidays', eventId: 'holiday', scope: 'this', event: { summary: 'Mine now' } });
    expect(readOnly).toEqual({ status: 403, body: { error: 'You need to have writer access to this calendar.' } });
  });
});

describe('Google Tasks through the service', () => {
  test('lists: every page, made, renamed, deleted; the default one stays', async () => {
    const lists = await call('GET', '/google/tasklists');
    expect(lists.body.lists.map((list: any) => [list.id, list.isDefault])).toEqual([['L1', true], ['L2', false]]);
    const made = await call('POST', '/google/tasklists', { account: ME, title: 'Groceries' });
    expect(made.body.list).toMatchObject({ title: 'Groceries', isDefault: false });
    expect((await call('PATCH', '/google/tasklists', { account: ME, listId: made.body.list.id, title: 'Food' })).body.list.title).toBe('Food');
    expect((await call('DELETE', `/google/tasklists?${q({ account: ME, list: made.body.list.id })}`)).status).toBe(200);
    expect((await call('DELETE', `/google/tasklists?${q({ account: ME, list: 'L1' })}`))).toEqual({ status: 400, body: { error: 'Invalid Value' } });
  });

  test('tasks: all of them with the completed ones; a subtask added after a sibling; moved to another list; deleted', async () => {
    const all = await call('GET', `/google/tasks/all?${q({ account: ME, list: 'L1' })}`);
    expect(all.body.complete).toBe(true);
    expect(all.body.tasks.map((task: any) => [task.id, task.parent, task.completed])).toEqual(expect.arrayContaining([['t-hotel', 't-trip', false], ['t-old', null, true]]));
    const sub = await call('POST', '/google/tasks', { account: ME, listId: 'L1', title: 'Pack', parent: 't-trip', previous: 't-hotel' });
    expect(sub.body.task).toMatchObject({ title: 'Pack', parent: 't-trip' });
    expect(fake.requests.filter((request) => request.method === 'POST' && request.path === '/tasks/v1/lists/L1/tasks').at(-1)!.query).toEqual({ parent: 't-trip', previous: 't-hotel' });
    const renamed = await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: sub.body.task.id, title: 'Pack the bags', notes: 'and the charger' });
    expect(renamed.body.task).toMatchObject({ title: 'Pack the bags', notes: 'and the charger' });
    const moved = await call('POST', '/google/tasks/move', { account: ME, listId: 'L1', id: sub.body.task.id, parent: null, previous: null, destinationListId: 'L2' });
    expect(moved.body.task).toMatchObject({ listId: 'L2', parent: null });
    expect((await call('DELETE', `/google/tasks?${q({ account: ME, list: 'L2', id: sub.body.task.id })}`)).status).toBe(200);
    expect(fake.tasks.get('L2')!.some((task) => task.id === sub.body.task.id)).toBe(false);
  });

  test('linked tasks are asked for in parts; more at once is refused, not cut short', async () => {
    const groups = Array.from({ length: 11 }, (_, index) => ({ account: ME, listId: `L${index}`, ids: ['x'] }));
    expect((await call('POST', '/google/tasks/linked', { groups })).status).toBe(400);
    expect((await call('POST', '/google/tasks/linked', { groups: [{ account: ME, listId: 'L1', ids: ['t-report', 't-gone'] }] })).body.tasks.map((task: any) => task.id)).toEqual(['t-report']);
  });
});
