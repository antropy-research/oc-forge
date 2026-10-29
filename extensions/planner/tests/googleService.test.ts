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

  test('a deadline kept in the Planner brings its task to the calendar of its days, dated or not', async () => {
    const keep = (listId: string, taskId: string, deadline: string) => ({ type: 'gtask.kept', account: ME, listId, taskId, patch: { deadline } });
    expect((await commands(keep('L2', 't-stamps', addDays(today, 2)), keep('L1', 't-trip', addDays(today, 5)), keep('L1', 't-report', addDays(today, 30)))).status).toBe(200);
    const { status, body } = await week();
    expect(status).toBe(200);
    expect(body.deadlineTasks.map((task: any) => [task.id, task.due]).sort()).toEqual([['t-stamps', null], ['t-trip', addDays(today, 3)]]);
    expect(fake.requests.some((request) => request.method === 'GET' && request.path === '/tasks/v1/lists/L2/tasks/t-stamps')).toBe(true);
    await commands(keep('L2', 't-stamps', null as unknown as string), keep('L1', 't-trip', null as unknown as string), keep('L1', 't-report', null as unknown as string));
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

  test('a task moved in Google: a read finds it in its new list, a write to its old one is looked up and goes there; a deleted one says so', async () => {
    expect((await call('POST', '/google/tasks/move', { account: ME, listId: 'L1', id: 't-report', parent: null, previous: null, destinationListId: 'L2' })).body.task.listId).toBe('L2');
    const linked = await call('POST', '/google/tasks/linked', { groups: [{ account: ME, listId: 'L1', ids: ['t-report', 't-gone'] }] });
    expect(linked.body.tasks.map((task: any) => [task.id, task.listId])).toEqual([['t-report', 'L2']]);
    expect(linked.body.missing).toEqual([{ account: ME, listId: 'L1', id: 't-gone' }]);
    const before = fake.requests.length;
    const done = await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: 't-report', completed: true });
    expect(done.body.task).toMatchObject({ id: 't-report', listId: 'L2', completed: true });
    expect(fake.requests.slice(before).filter((request) => request.method === 'PATCH').map((request) => request.path)).toEqual(['/tasks/v1/lists/L1/tasks/t-report', '/tasks/v1/lists/L2/tasks/t-report']);
    expect(fake.tasks.get('L2')!.find((task) => task.id === 't-report')!.status).toBe('completed');
    expect(await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: 't-gone', completed: true })).toEqual({ status: 404, body: { error: 'This task is no longer in Google Tasks' } });
  });
});

/** A daily task from today at 9am, made as the panel makes one: the task in Google, then its series kept. */
const daily = async (title: string) => {
  const made = await call('POST', '/google/tasks', { account: ME, listId: 'L1', title, notes: 'Series notes', due: today });
  const id = made.body.task.id as string;
  const seriesId = `s${id}`;
  const template = { title, notes: 'Series notes', time: 540, duration: null, deadline: null, start: today };
  expect((await commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: id, patch: { time: 540, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId, index: 1, next: null, on: today, template } } })).status).toBe(200);
  return { id, seriesId, template };
};
const inserts = (title: string) => fake.requests.filter((request) => request.method === 'POST' && request.path === '/tasks/v1/lists/L1/tasks' && request.body?.title === title);
const open = (title: string, list = 'L1') => fake.tasks.get(list)!.filter((task) => task.title === title && task.status !== 'completed');
const kept = async () => (await call('GET', '/state')).body.state.googleTasks as Record<string, any>;
const heads = (all: Record<string, any>, seriesId: string) => Object.values(all).filter((entry) => entry.repeat?.seriesId === seriesId && !entry.repeat.next).map((entry) => entry.taskId);
/** Until Google has been asked what `check` waits for (a slow insert under way), at most 2 s. */
const asked = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe('a repeating task through the service, asked by two windows at once (review 8)', () => {
  test('completed in two windows at once, Google slow to make the next one: one next task in Google, linked; both answers name it, with the plan', async () => {
    const { id, seriesId } = await daily('Harness twin');
    expect((await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true })).status).toBe(200);
    fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 600);
    const [first, second] = await Promise.all([1, 2].map(() => call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id })));
    expect([first!.status, second!.status]).toEqual([200, 200]);
    expect(inserts('Harness twin')).toHaveLength(2);
    const next = open('Harness twin');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ due: `${addDays(today, 1)}T00:00:00.000Z`, notes: 'Series notes' });
    expect([first!.body.task.id, second!.body.task.id]).toEqual([next[0].id, next[0].id]);
    expect([first!.body.made, second!.body.made].sort()).toEqual([false, true]);
    // Each answer carries the plan as it is, link included.
    for (const answer of [first!, second!]) expect(answer.body.state.googleTasks[`${ME}\n${id}`].repeat.next).toBe(next[0].id);
    const all = await kept();
    expect(all[`${ME}\n${next[0].id}`]).toMatchObject({ time: 540, repeat: { seriesId, index: 2, next: null, on: addDays(today, 1) } });
    expect(heads(all, seriesId)).toEqual([next[0].id]);
    // Asked again later (a window's next read): the same one.
    expect((await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id })).body).toMatchObject({ task: { id: next[0].id }, made: false });
    expect(inserts('Harness twin')).toHaveLength(2);
  });

  test('Google refuses the first of two: the other makes it, once', async () => {
    const { id, seriesId } = await daily('Harness refused twin');
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 400);
    fake.failNext('POST', '/tasks/v1/lists/L1/tasks', 503, 'Backend Error');
    const answers = await Promise.all([1, 2].map(() => call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id })));
    // Google's 503 is the service's 502 ("Backend Error"), as for every Google write.
    expect(answers.map((answer) => [answer.status, answer.body.error ?? null]).sort()).toEqual([[200, null], [502, 'Backend Error']]);
    expect(open('Harness refused twin')).toHaveLength(1);
    expect(heads(await kept(), seriesId)).toEqual([open('Harness refused twin')[0].id]);
  });

  test('This and following tasks from the day after tomorrow: today’s task and tomorrow’s stay; All tasks: every task of the series goes', async () => {
    const { id, seriesId } = await daily('Harness cut');
    const cut = await call('DELETE', `/google/tasks/series?${q({ account: ME, series: seriesId, from: addDays(today, 2) })}`);
    expect(cut.status).toBe(200);
    expect(cut.body.deleted).toEqual([]);
    expect(open('Harness cut').map((task) => task.id)).toEqual([id]);
    expect(cut.body.state.googleTasks[`${ME}\n${id}`].repeat.rule).toBe(`RRULE:FREQ=DAILY;UNTIL=${addDays(today, 1).replace(/-/g, '')}`);
    // Today's done: tomorrow's is made, and nothing after it.
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    const made = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id })).body.task;
    expect(made).toMatchObject({ due: addDays(today, 1) });
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: made.id, completed: true });
    expect((await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id: made.id })).body).toMatchObject({ task: null, made: false });
    expect(open('Harness cut')).toEqual([]);
    expect((await kept())[`${ME}\n${made.id}`].repeat).toBeNull();

    const other = await daily('Harness all');
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: other.id, completed: true });
    const second = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id: other.id })).body.task;
    const all = await call('DELETE', `/google/tasks/series?${q({ account: ME, series: other.seriesId })}`);
    expect(all.body.deleted).toEqual([second.id, other.id]);
    expect(fake.tasks.get('L1')!.filter((task) => task.title === 'Harness all')).toEqual([]);
    expect(Object.values(await kept()).filter((entry) => entry.repeat?.seriesId === other.seriesId)).toEqual([]);
    expect((await call('DELETE', `/google/tasks/series?${q({ account: ME, series: other.seriesId })}`)).status).toBe(404);
    expect((await call('DELETE', `/google/tasks/series?${q({ account: ME, series: other.seriesId, from: 'tomorrow' })}`)).status).toBe(400);
  });
});

describe('a series changed while Google makes its next task, through the service (review 9)', () => {
  const at = (date: string) => `${date}T00:00:00.000Z`;

  test('tomorrow edited alone (This task) while Google makes it after today was completed: the edit waits, then the task Google made takes it; one task, kept with it', async () => {
    const { id, seriesId } = await daily('Harness race');
    const tomorrow = addDays(today, 1);
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 1500);
    const making = call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today });
    await asked(() => inserts('Harness race').length === 2);
    const shown = { title: 'Harness race', notes: 'Series notes', due: tomorrow, time: 540, duration: null, deadline: null };
    const editing = call('POST', '/google/tasks/occurrence', { account: ME, seriesId, on: tomorrow, before: shown, after: { ...shown, title: 'Harness race with Ann', time: 900 } });
    const [made, edited] = await Promise.all([making, editing]);
    expect([made.status, edited.status]).toEqual([200, 200]);
    const next = open('Harness race with Ann');
    expect(next.map((task) => task.due)).toEqual([at(tomorrow)]);
    expect(open('Harness race')).toEqual([]);
    expect(inserts('Harness race')).toHaveLength(2);
    // As a window that loads now has it: the series' template stays; tomorrow's task has its own title and time.
    const all = await kept();
    expect(all[`${ME}\n${next[0].id}`]).toMatchObject({ time: 900, repeat: { seriesId, index: 2, on: tomorrow, next: null, template: { title: 'Harness race', time: 540 } } });
    expect(all[`${ME}\n${id}`].repeat.next).toBe(next[0].id);
    expect(heads(all, seriesId)).toEqual([next[0].id]);
  });

  test('a change written past the series lock while Google makes the next task (an older window, a sync): the task Google made is repaired, in Google and in the plan', async () => {
    const { id } = await daily('Harness repair');
    const tomorrow = addDays(today, 1);
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 1500);
    const making = call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today });
    await asked(() => inserts('Harness repair').length === 2);
    const repeat = (await kept())[`${ME}\n${id}`].repeat;
    const exceptions = { [tomorrow]: { title: 'Harness repair with Ann', time: 900, duration: null } };
    expect((await commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: id, patch: { repeat: { ...repeat, exceptions } } })).status).toBe(200);
    const made = await making;
    expect(made.status).toBe(200);
    expect(made.body.task).toMatchObject({ title: 'Harness repair with Ann', due: tomorrow });
    const next = open('Harness repair with Ann');
    expect(next).toHaveLength(1);
    expect(fake.requests.filter((request) => request.method === 'PATCH' && request.path === `/tasks/v1/lists/L1/tasks/${next[0].id}`).map((request) => request.body)).toEqual([{ title: 'Harness repair with Ann' }]);
    const all = await kept();
    expect(all[`${ME}\n${next[0].id}`]).toMatchObject({ time: 900, repeat: { on: tomorrow, next: null } });
    // The link went onto the series as it is now: the change stays with it.
    expect(all[`${ME}\n${id}`].repeat).toMatchObject({ next: next[0].id, exceptions });
  });

  test('all tasks edited while Google makes the next task: the edit waits, then the next task takes the new title and time, and the one after it too', async () => {
    const { id, seriesId, template } = await daily('Harness all-edit');
    const tomorrow = addDays(today, 1);
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 1500);
    const making = call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today });
    await asked(() => inserts('Harness all-edit').length === 2);
    // As the other window saves All tasks: Google has its task's own title first, then the series changes.
    expect((await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, title: 'Harness all-edit daily' })).status).toBe(200);
    const after = { ...template, title: 'Harness all-edit daily', time: 900 };
    const editing = call('POST', '/google/tasks/series/edit', { account: ME, listId: 'L1', taskId: id, seriesId, own: { time: 900 }, before: { rule: 'RRULE:FREQ=DAILY', template, due: today }, after: { rule: 'RRULE:FREQ=DAILY', template: after, due: today } });
    const [made, edited] = await Promise.all([making, editing]);
    expect([made.status, edited.status]).toEqual([200, 200]);
    const next = open('Harness all-edit daily');
    expect(next.map((task) => task.due)).toEqual([at(tomorrow)]);
    expect(open('Harness all-edit')).toEqual([]);
    const all = await kept();
    expect(all[`${ME}\n${next[0].id}`]).toMatchObject({ time: 900, repeat: { seriesId, on: tomorrow, template: { title: 'Harness all-edit daily', time: 900 } } });
    expect(heads(all, seriesId)).toEqual([next[0].id]);
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: next[0].id, completed: true });
    const third = await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id: next[0].id, completed: true, due: tomorrow });
    expect(third.body.task).toMatchObject({ title: 'Harness all-edit daily', due: addDays(today, 2) });
    expect(third.body.state.googleTasks[`${ME}\n${third.body.task.id}`]).toMatchObject({ time: 900 });
  });

  test('today moved alone to tomorrow at 1pm: completing it makes tomorrow’s own at 9am beside it; completing that one makes the day after; the moved one stays as it is', async () => {
    const { id, seriesId } = await daily('Harness moved');
    const tomorrow = addDays(today, 1);
    // This task: Google has its new date, the Planner its time; the series still puts it on today.
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, due: tomorrow });
    await commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: id, patch: { time: 780 } });
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    const own = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: tomorrow })).body.task;
    expect(own).toMatchObject({ title: 'Harness moved', due: tomorrow });
    let all = await kept();
    expect(all[`${ME}\n${own.id}`]).toMatchObject({ time: 540, repeat: { on: tomorrow, index: 2 } });
    expect(all[`${ME}\n${id}`]).toMatchObject({ time: 780, repeat: { on: today, next: own.id } });
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: own.id, completed: true });
    const after = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id: own.id, completed: true, due: tomorrow })).body.task;
    expect(after).toMatchObject({ due: addDays(today, 2) });
    expect(fake.tasks.get('L1')!.find((task) => task.id === id)).toMatchObject({ due: at(tomorrow), status: 'completed', title: 'Harness moved' });
    all = await kept();
    expect(all[`${ME}\n${id}`]).toMatchObject({ time: 780, repeat: { on: today, next: own.id } });
    expect(inserts('Harness moved')).toHaveLength(3);
    expect(heads(all, seriesId)).toEqual([after.id]);
  });

  test('its open task deleted in Google’s own apps: the service goes on from its next one, as This task; one moved to another list there is followed; one still there is left alone', async () => {
    const { id, seriesId } = await daily('Harness gone');
    // Deleted there: the plan still has it.
    await call('DELETE', `/google/tasks?${q({ account: ME, list: 'L1', id })}`);
    const answer = await call('POST', '/google/tasks/gone', { account: ME, listId: 'L1', id });
    expect(answer.status).toBe(200);
    const next = open('Harness gone');
    expect(next.map((task) => task.due)).toEqual([at(addDays(today, 1))]);
    expect(answer.body.state.googleTasks[`${ME}\n${id}`]).toBeUndefined();
    expect(heads(answer.body.state.googleTasks, seriesId)).toEqual([next[0].id]);
    // Still there: nothing changes.
    expect((await call('POST', '/google/tasks/gone', { account: ME, listId: 'L1', id: next[0].id })).status).toBe(200);
    expect(heads(await kept(), seriesId)).toEqual([next[0].id]);
    // Moved to another list there: followed, nothing made.
    await call('POST', '/google/tasks/move', { account: ME, listId: 'L1', id: next[0].id, parent: null, previous: null, destinationListId: 'L2' });
    await call('POST', '/google/tasks/gone', { account: ME, listId: 'L1', id: next[0].id });
    expect((await kept())[`${ME}\n${next[0].id}`]).toMatchObject({ listId: 'L2', repeat: { seriesId, next: null } });
    expect(inserts('Harness gone')).toHaveLength(2);
  });

  test('refusals: an occurrence its series does not put on that date, or past a cut; a malformed edit', async () => {
    const { seriesId, template } = await daily('Harness refused');
    const shown = { title: 'Harness refused', notes: 'Series notes', due: today, time: 540, duration: null, deadline: null };
    // Today is the open task itself, not an upcoming one; yesterday is before the series.
    expect((await call('POST', '/google/tasks/occurrence', { account: ME, seriesId, on: addDays(today, -1), before: shown, after: shown })).body).toEqual({ error: 'This task is no longer in its series' });
    await call('DELETE', `/google/tasks/series?${q({ account: ME, series: seriesId, from: addDays(today, 2) })}`);
    const later = { ...shown, due: addDays(today, 3) };
    expect(await call('POST', '/google/tasks/occurrence', { account: ME, seriesId, on: addDays(today, 3), before: later, after: { ...later, title: 'Late' } })).toEqual({ status: 409, body: { error: 'This task is no longer in its series' } });
    expect((await call('POST', '/google/tasks/occurrence', { account: ME, seriesId, on: addDays(today, 1), before: shown })).status).toBe(400);
    expect((await call('POST', '/google/tasks/series/edit', { account: ME, listId: 'L1', taskId: 'x', seriesId, own: { repeat: null }, before: { rule: null, template, due: today }, after: { rule: null, template, due: today } })).status).toBe(400);
  });
});

describe("round 10's fields and Undo through the service (merge)", () => {
  const DAILY = 'RRULE:FREQ=DAILY';
  const doc = { id: 'harnessDoc1', title: 'Plan', mimeType: 'application/vnd.google-apps.document', url: 'https://docs.google.com/document/d/harnessDoc1/edit' };
  const advanced = { busy: true, color: '#d50000', doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc] };

  test('All tasks with a color, Do not disturb, declining and attachments: the route takes them; the series and its open task keep them, and the next task has them', async () => {
    const { id, seriesId, template } = await daily('Harness advanced');
    const edited = await call('POST', '/google/tasks/series/edit', { account: ME, listId: 'L1', taskId: id, seriesId, own: advanced, before: { rule: DAILY, template, due: today }, after: { rule: DAILY, template: { ...template, ...advanced }, due: today } });
    expect(edited.status).toBe(200);
    const head = edited.body.state.googleTasks[`${ME}\n${id}`];
    expect(head).toMatchObject({ busy: true, color: '#d50000', doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc] });
    expect(head.repeat.template).toMatchObject(advanced);
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    const next = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today })).body;
    expect(next.state.googleTasks[`${ME}\n${next.task.id}`]).toMatchObject({ time: 540, busy: true, color: '#d50000', doNotDisturb: true, decline: { mode: 'new' }, attachments: [doc] });
  });

  test('Undo after "This task": Google undeletes the task, the next one its deletion made goes again, and the series goes on from the task as kept before', async () => {
    const { id, seriesId } = await daily('Harness undo one');
    // As the panel deletes "This task": its next one first, then the task in Google and here.
    const made = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: false, due: today })).body;
    const task = made.state.googleTasks[`${ME}\n${id}`];
    const fingerprint = { listId: 'L1', id: made.task.id, title: made.task.title, notes: made.task.notes, due: made.task.due, updatedAt: made.state.googleTasks[`${ME}\n${made.task.id}`].updatedAt };
    expect((await call('DELETE', `/google/tasks?${q({ account: ME, list: 'L1', id })}`)).status).toBe(200);
    await commands({ type: 'gtask.dropped', account: ME, taskId: id });
    const undone = await call('POST', '/google/tasks/series/undo', { account: ME, seriesId, kind: 'one', task, made: fingerprint });
    expect(undone.status).toBe(200);
    expect(undone.body.nextKept).toBe(false);
    expect(open('Harness undo one').map((one) => one.id)).toEqual([id]);
    expect(undone.body.state.googleTasks[`${ME}\n${made.task.id}`]).toBeUndefined();
    expect(heads(undone.body.state.googleTasks, seriesId)).toEqual([id]);
    // Again: nothing to give back.
    expect((await call('POST', '/google/tasks/series/undo', { account: ME, seriesId, kind: 'one', task, made: fingerprint })).status).toBe(409);
  });

  test('Undo after completing: open again in Google, the next task gone again; once that next task was edited, it stays and the answer says so', async () => {
    const { id, seriesId } = await daily('Harness undo done');
    const before = (await kept())[`${ME}\n${id}`];
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    const made = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today })).body;
    const fingerprint = { listId: 'L1', id: made.task.id, title: made.task.title, notes: made.task.notes, due: made.task.due, updatedAt: made.state.googleTasks[`${ME}\n${made.task.id}`].updatedAt };
    const undone = await call('POST', '/google/tasks/uncomplete', { account: ME, listId: 'L1', id, before, made: fingerprint });
    expect(undone.body).toMatchObject({ nextKept: false });
    expect(fake.tasks.get('L1')!.find((one) => one.id === id)!.status).toBe('needsAction');
    expect(fake.tasks.get('L1')!.some((one) => one.id === made.task.id)).toBe(false);
    expect(heads(undone.body.state.googleTasks, seriesId)).toEqual([id]);
    // Completed again, its next task edited in Google: Undo keeps that one.
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, completed: true });
    const again = (await call('POST', '/google/tasks/next', { account: ME, listId: 'L1', id, completed: true, due: today })).body;
    const print = { listId: 'L1', id: again.task.id, title: again.task.title, notes: again.task.notes, due: again.task.due, updatedAt: again.state.googleTasks[`${ME}\n${again.task.id}`].updatedAt };
    await call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id: again.task.id, title: 'Harness undo done, edited' });
    const kept2 = await call('POST', '/google/tasks/uncomplete', { account: ME, listId: 'L1', id, before, made: print });
    expect(kept2.body).toMatchObject({ nextKept: true });
    expect(fake.tasks.get('L1')!.find((one) => one.id === again.task.id)).toMatchObject({ title: 'Harness undo done, edited', status: 'needsAction' });
    expect(heads(kept2.body.state.googleTasks, seriesId)).toEqual([again.task.id]);
  });
});
