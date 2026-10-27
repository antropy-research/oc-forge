// A Google task and the Planner task planning it stay in step: the link follows
// the task to another list (moved here or seen on a read), every write goes to
// the list it is in now (a stale one is looked up once and the write retried),
// a write Google refuses leaves the Planner as Google is, and title, details
// and date merge three ways. What the Planner keeps for Google tasks (time,
// deadline, repeat, star) follows moves too; a repeating task's next
// occurrence is made once; a timed block's text fits its height.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT } from '../panel/lib/google.ts';
import { dropTarget } from '../src/domain/gtasks.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { GoogleData, toTaskItem } from '../service/googleData.ts';
import { GoogleError, type GoogleAccounts } from '../service/google.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { emptyState, googleTaskKey, type PlannerState } from '../src/domain/types.ts';
import { findMovedTask, GONE_STATUS, gtaskSource, linkedGoogleTasks, mergeGoogleTask, planGoogleTaskSync, plannerEditTimes, TASK_GONE, taskFromGoogleTask, type GoogleTaskItem } from '../src/domain/google.ts';
import { deadlineEvents, deadlineGroups, dueOccurrences, firstSightOfSeries, keptFor, madeAlready, nextRepeatDate, starredKept, upcomingEvent, upcomingTasks, withTaskTimes } from '../src/domain/gtaskKept.ts';
import { blockText } from '../src/domain/gcalendar.ts';
import type { CalendarEvent } from '../src/domain/ics.ts';

const ME = 'me@example.com';
let clock = Date.parse('2026-10-26T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id: 'gt1', title: 'Send the report', notes: 'To Ann', due: '2026-10-26', completed: false, parent: null, position: '0001', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-26T15:00:00.000Z', ...patch,
});
const planned = (google = item()) => foldEvents([ev({ type: 'task.created', task: taskFromGoogleTask(google, 't1', { kind: 'day', date: '2026-10-26' }, 1) })]);

/** A Planner client whose dispatch applies (and checks) the events; Google answers through `answer`. */
const fakeClient = (start: PlannerState, answer: (method: string, path: string, body: any) => unknown = () => ({})) => {
  let state = start;
  let n = 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  const notes: string[] = [];
  const dispatched: EventBody[] = [];
  const log: PlannerEvent[] = [];
  const client = {
    getView: () => ({ state, today: '2026-10-26' }),
    call: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return answer(method, path, body);
    },
    dispatch: async (bodies: EventBody[]) => {
      for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
      dispatched.push(...bodies);
      const events = bodies.map((body) => ev(body));
      log.push(...events);
      n += bodies.length;
      state = applyEvents(state, events);
    },
    activity: async (taskId: string) => log.filter((event) => 'taskId' in event && event.taskId === taskId),
    notify: (message: string) => notes.push(message),
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { client, calls, notes, dispatched, log, state: () => state, setState: (next: PlannerState) => (state = next) };
};
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;

describe('a planned Google task moved to another list', () => {
  test('moved in the Tasks view: the Planner task and what is kept for it follow, and completing it writes to the new list', async () => {
    const start = applyEvents(planned(), [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { deadline: '2026-10-30' } })]);
    const fake = fakeClient(start, (method, path, body) => {
      if (path === '/google/tasks/move') return { task: item({ listId: 'L2' }) };
      if (method === 'PATCH' && path === '/google/tasks') return { task: item({ listId: body.listId, completed: true }) };
      return { tasks: [] };
    });
    const store = new GoogleStore(host, fake.client, 'page');
    await store.moveListTask(item(), { parent: null, previous: null }, 'L2');
    expect(fake.state().tasks.t1!.source).toMatchObject({ id: 'gt1', listId: 'L2' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })).toMatchObject({ listId: 'L2', deadline: '2026-10-30' });
    expect(await store.writeTask(fake.state().tasks.t1!, { completed: true })).toBe(true);
    expect(fake.calls.filter((call) => call.method === 'PATCH').at(-1)).toMatchObject({ path: '/google/tasks', body: { account: ME, listId: 'L2', id: 'gt1', completed: true } });
    expect(fake.state().tasks.t1!.source?.status?.type).toBe('completed');
  });

  test('moved in Google: a read finds it in the other list, and the link and kept time follow', () => {
    const state = applyEvents(planned(), [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: 14 * 60 } })]);
    const plan = planGoogleTaskSync(state, new Map([['gt1', item({ listId: 'L2' })]]), { today: '2026-10-26', importCompletion: true });
    expect(plan.bodies).toEqual([
      { type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item({ listId: 'L2' })) },
      { type: 'gtask.moved', account: ME, taskId: 'gt1', listId: 'L2' },
    ]);
    const after = applyEvents(state, plan.bodies.map((body) => ev(body)));
    expect(after.tasks.t1!.source?.listId).toBe('L2');
    expect(keptFor(after, { account: ME, id: 'gt1' })).toMatchObject({ listId: 'L2', time: 14 * 60 });
    expect(linkedGoogleTasks(after)).toEqual([{ account: ME, listId: 'L2', ids: ['gt1'] }]);
  });

  test('moved in Google under a new id: the one open task elsewhere that reads as it did is found; two such are not guessed between', () => {
    const state = planned();
    const source = state.tasks.t1!.source!;
    const moved = item({ id: 'gt9', listId: 'L2' });
    expect(findMovedTask(source, [moved, item({ id: 'gt8', listId: 'L2', title: 'Other' })], state)?.id).toBe('gt9');
    expect(findMovedTask(source, [moved, item({ id: 'gt7', listId: 'L3' })], state)).toBeNull();
    expect(findMovedTask(source, [{ ...moved, completed: true }], state)).toBeNull();
  });
});

describe('writes go to the list the task is in now', () => {
  const raw = (id: string) => ({ id, title: 'Send the report', notes: 'To Ann', due: '2026-10-26T00:00:00.000Z', status: 'needsAction', position: '0001', updated: '2026-10-26T15:00:00.000Z' });
  const google = (moved: boolean) => {
    const calls: string[] = [];
    const accounts = {
      request: async (_account: string, method: string, url: string, body?: any) => {
        calls.push(`${method} ${url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, '')}`);
        if (method === 'PATCH' && url.includes('/lists/L1/tasks/gt1')) throw new GoogleError(404, 'Not Found');
        if (url.includes('/users/@me/lists/%40default')) return { id: 'L1' };
        if (url.includes('/users/@me/lists?')) return { items: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Errands' }] };
        if (method === 'GET' && url.includes('/lists/L2/tasks?')) return { items: moved ? [raw('gt1')] : [] };
        if (method === 'GET') return { items: [] };
        if (method === 'PATCH') return { ...raw('gt1'), ...body };
        return {};
      },
    } as unknown as GoogleAccounts;
    return { data: new GoogleData(accounts), calls };
  };

  test('a 404 looks the task up across the account’s lists once and writes it there', async () => {
    const { data, calls } = google(true);
    const answer = await data.updateTask(ME, 'L1', 'gt1', { completed: true });
    expect(answer).toMatchObject({ id: 'gt1', listId: 'L2', completed: true });
    expect(calls.filter((call) => call.startsWith('PATCH'))).toEqual(['PATCH /tasks/v1/lists/L1/tasks/gt1', 'PATCH /tasks/v1/lists/L2/tasks/gt1']);
  });

  test('a task in none of the lists is gone, said so', async () => {
    const { data, calls } = google(false);
    await expect(data.updateTask(ME, 'L1', 'gt1', { completed: true })).rejects.toThrow(TASK_GONE);
    expect(calls.filter((call) => call.startsWith('PATCH'))).toEqual(['PATCH /tasks/v1/lists/L1/tasks/gt1']);
  });

  test('a read of linked tasks finds moved ones in other lists and names the missing', async () => {
    const { data } = google(true);
    expect(await data.linkedTasks(ME, 'L1', ['gt1', 'gone'])).toMatchObject({ tasks: [{ id: 'gt1', listId: 'L2' }], missing: ['gone'] });
  });

  test('the link follows the write to the list Google answered from', async () => {
    const fake = fakeClient(planned(), (method, _path, body) => (method === 'PATCH' ? { task: item({ listId: 'L2', completed: body.completed }) } : { tasks: [] }));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.writeTask(fake.state().tasks.t1!, { completed: true }, true);
    expect(fake.state().tasks.t1!.source).toMatchObject({ listId: 'L2', status: { type: 'completed' } });
  });

  test('a completion Google refuses is undone here; a task Google no longer has shows as deleted', async () => {
    const refused = fakeClient(applyEvents(planned(), [ev({ type: 'task.completed', taskId: 't1', on: '2026-10-26' })]), () => {
      throw new Error('Backend Error');
    });
    const store = new GoogleStore(host, refused.client, 'page');
    expect(await store.writeTask(refused.state().tasks.t1!, { completed: true })).toBe(false);
    expect(refused.state().tasks.t1!.completedAt).toBeNull();
    expect(refused.notes.at(-1)).toContain('stays open here too');

    const gone = fakeClient(planned(), () => {
      throw new Error(TASK_GONE);
    });
    await new GoogleStore(host, gone.client, 'page').writeTask(gone.state().tasks.t1!, { completed: true });
    expect(gone.state().tasks.t1!.source?.status).toEqual(GONE_STATUS);
    // Not asked for again: Google has nothing there.
    expect(linkedGoogleTasks(gone.state())).toEqual([]);
  });
});

describe('title, details and date, both ways', () => {
  const options = { today: '2026-10-26', importCompletion: true };
  test('changed in Google only: the Planner takes notes and date (the reviewer’s case)', () => {
    const plan = planGoogleTaskSync(planned(), new Map([['gt1', item({ title: 'Send the full report', notes: 'With the numbers', due: '2026-10-27' })]]), options);
    expect(plan.bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item({ title: 'Send the full report', notes: 'With the numbers', due: '2026-10-27' })), title: 'Send the full report', notes: 'With the numbers', dueDate: '2026-10-27' }]);
    expect(plan.writes).toEqual([]);
    const after = applyEvents(planned(), plan.bodies.map((body) => ev(body)));
    expect(after.tasks.t1).toMatchObject({ title: 'Send the full report', notes: 'With the numbers', dueDate: '2026-10-27' });
    // Read again: nothing left to do.
    expect(planGoogleTaskSync(after, new Map([['gt1', item({ title: 'Send the full report', notes: 'With the numbers', due: '2026-10-27' })]]), options)).toEqual({ bodies: [], writes: [], conflicts: [] });
  });

  test('changed in the Planner only: Google gets it', () => {
    const state = applyEvents(planned(), [ev({ type: 'task.updated', taskId: 't1', patch: { notes: 'To Ann and Bo', dueDate: '2026-10-28' } })]);
    const plan = planGoogleTaskSync(state, new Map([['gt1', item()]]), options);
    expect(plan.bodies).toEqual([]);
    expect(plan.writes).toEqual([{ taskId: 't1', account: ME, listId: 'L1', id: 'gt1', patch: { notes: 'To Ann and Bo', due: '2026-10-28' } }]);
  });

  test('changed on both sides: the newer change wins, field by field', () => {
    const state = applyEvents(planned(), [ev({ type: 'task.updated', taskId: 't1', patch: { notes: 'Planner notes' } })]);
    const edited = state.tasks.t1!.updatedAt;
    const older = item({ notes: 'Google notes', updated: new Date(Date.parse(edited) - 60_000).toISOString() });
    const newer = item({ notes: 'Google notes', updated: new Date(Date.parse(edited) + 60_000).toISOString() });
    const editedAt = () => edited;
    expect(mergeGoogleTask(state.tasks.t1!, older, editedAt)).toEqual({ planner: {}, google: { notes: 'Planner notes' }, conflicts: ['notes'] });
    expect(mergeGoogleTask(state.tasks.t1!, newer, editedAt)).toEqual({ planner: { notes: 'Google notes' }, google: {}, conflicts: ['notes'] });
    // The Planner's edit times come from the task's activity: Google's changes do not count as edits.
    const times = plannerEditTimes([ev({ type: 'task.created', task: { id: 't1', title: 'x', placement: { kind: 'day', date: '2026-10-26' }, position: 1 } }), ev({ type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item()), notes: 'g' }), ev({ type: 'task.updated', taskId: 't1', patch: { dueDate: '2026-10-29' } })]);
    expect(Object.keys(times).sort()).toEqual(['due', 'notes', 'title']);
    expect(times.due! > times.notes!).toBe(true);
  });

  test('unchanged on both sides: nothing; a link made before the base was kept lets the newer side win', () => {
    expect(mergeGoogleTask(planned().tasks.t1!, item(), () => null)).toEqual({ planner: {}, google: {}, conflicts: [] });
    const old = planned();
    const { notes: _notes, due: _due, ...bare } = old.tasks.t1!.source!;
    const legacy = { ...old.tasks.t1!, source: bare, createdAt: '2026-10-20T00:00:00.000Z' };
    expect(mergeGoogleTask(legacy, item({ notes: 'New in Google' }), () => legacy.createdAt).planner).toEqual({ notes: 'New in Google' });
  });

  test('a completed Planner task keeps what it was done with; only its link follows', () => {
    const done = applyEvents(planned(), [ev({ type: 'task.completed', taskId: 't1', on: '2026-10-26' })]);
    const plan = planGoogleTaskSync(done, new Map([['gt1', item({ notes: 'later', completed: true })]]), options);
    expect(plan.writes).toEqual([]);
    expect(plan.bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item({ notes: 'later', completed: true })) }]);
  });
});

describe('what the Planner keeps for Google tasks', () => {
  const kept = (patch: Record<string, unknown>, listId = 'L1', taskId = 'gt1') => ev({ type: 'gtask.kept', account: ME, listId, taskId, patch } as EventBody);
  test('times, deadlines, repeats and stars, checked; a task with nothing kept is forgotten', () => {
    const check = (patch: Record<string, unknown>) => validateCommand({ cmd: 'c', type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch }, emptyState());
    expect(check({ time: 600, duration: 30, deadline: '2026-10-30', starred: true })).toBeNull();
    expect(check({ repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', seriesId: 's1', index: 1, next: null } })).toBeNull();
    expect(check({ time: 1440 })).toMatch(/time/);
    expect(check({ duration: 2 })).toMatch(/duration/);
    expect(check({ repeat: { rule: 'every monday', seriesId: 's1', index: 1, next: null } })).toMatch(/RRULE/);
    expect(check({ color: 'red' })).toMatch(/unknown field/);
    const state = foldEvents([kept({ time: 600, starred: true }), kept({ deadline: '2026-10-30' })]);
    expect(state.googleTasks[googleTaskKey(ME, 'gt1')]).toMatchObject({ time: 600, deadline: '2026-10-30', listId: 'L1' });
    expect(keptFor(state, { account: ME, id: 'gt1' })?.starredAt).toBeTruthy();
    expect(foldEvents([kept({ time: 600 }), kept({ time: null })]).googleTasks).toEqual({});
  });

  test('a repeating task stays in its list, as in Google Tasks: a move to another list is refused before anything moves', async () => {
    const fake = fakeClient(foldEvents([kept({ repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', seriesId: 's1', index: 1, next: null } })]));
    const store = new GoogleStore(host, fake.client, 'page');
    const refused = await store.moveListTask(item(), { parent: null, previous: null }, 'L2').catch((error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/repeating task stays in its list/);
    expect(fake.calls.filter((call) => call.path === '/google/tasks/move')).toEqual([]);
    // Within its own list it still moves.
    await store.moveListTask(item(), { parent: null, previous: null });
    expect(fake.calls.filter((call) => call.path === '/google/tasks/move')).toHaveLength(1);
  });

  test('they follow the task to another list, and to a new id', () => {
    const moved = foldEvents([kept({ time: 600 }), ev({ type: 'gtask.moved', account: ME, taskId: 'gt1', listId: 'L2' })]);
    expect(keptFor(moved, { account: ME, id: 'gt1' })).toMatchObject({ listId: 'L2', time: 600 });
    const renamed = applyEvents(moved, [ev({ type: 'gtask.moved', account: ME, taskId: 'gt1', listId: 'L3', newTaskId: 'gt9' })]);
    expect(keptFor(renamed, { account: ME, id: 'gt1' })).toBeNull();
    expect(keptFor(renamed, { account: ME, id: 'gt9' })).toMatchObject({ listId: 'L3', taskId: 'gt9', time: 600 });
    expect(applyEvents(renamed, [ev({ type: 'gtask.dropped', account: ME, taskId: 'gt9' })]).googleTasks).toEqual({});
  });

  test('a list read in the Tasks view moves what is kept for a task it finds there', async () => {
    const fake = fakeClient(foldEvents([kept({ starred: true })]), (_method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [item({ listId: 'L2' })], complete: true } : {}));
    await new GoogleStore(host, fake.client, 'page').loadBoard(ME, 'L2');
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.listId).toBe('L2');
  });

  test('a kept time puts the task on the grid at that time; Google’s date moves it and keeps the time', () => {
    const state = foldEvents([kept({ time: 14 * 60, duration: 60 })]);
    const event = (due: string): CalendarEvent => ({ id: 'gtask:L1:gt1', calendarId: 'google-tasks', title: 'Send the report', location: '', start: `${due}T07:00:00.000Z`, end: '', allDay: true, busy: false, googleTask: item({ due }) });
    expect(withTaskTimes([event('2026-10-26')], state.googleTasks, 'America/Los_Angeles')[0]).toMatchObject({ allDay: false, start: '2026-10-26T21:00:00.000Z', end: '2026-10-26T22:00:00.000Z' });
    expect(withTaskTimes([event('2026-10-28')], state.googleTasks, 'America/Los_Angeles')[0]).toMatchObject({ allDay: false, start: '2026-10-28T21:00:00.000Z' });
  });

  test('starred tasks, the newest star first', () => {
    const state = foldEvents([kept({ starred: true }, 'L1', 'a'), kept({ starred: true }, 'L2', 'b'), kept({ starred: true }, 'L1', 'c'), kept({ starred: false }, 'L1', 'c')]);
    expect(starredKept(state).map((entry) => entry.taskId)).toEqual(['b', 'a']);
  });
});

describe('repeating tasks', () => {
  test('the next date, as the rule steps', () => {
    expect(nextRepeatDate('RRULE:FREQ=DAILY', '2026-10-26', 1)).toBe('2026-10-27');
    expect(nextRepeatDate('RRULE:FREQ=WEEKLY;BYDAY=MO', '2026-10-26', 1)).toBe('2026-11-02');
    expect(nextRepeatDate('RRULE:FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-26', 1)).toBe('2026-10-29');
    expect(nextRepeatDate('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2026-10-29', 2)).toBe('2026-11-09');
    expect(nextRepeatDate('RRULE:FREQ=MONTHLY;BYMONTHDAY=31', '2026-10-31', 1)).toBe('2026-12-31');
    expect(nextRepeatDate('RRULE:FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', 1)).toBe('2026-11-27');
    expect(nextRepeatDate('RRULE:FREQ=YEARLY', '2028-02-29', 1)).toBe('2032-02-29');
    // Ends: after its count, or past its last day.
    expect(nextRepeatDate('RRULE:FREQ=DAILY;COUNT=3', '2026-10-28', 3)).toBeNull();
    expect(nextRepeatDate('RRULE:FREQ=DAILY;UNTIL=20261027', '2026-10-27', 2)).toBeNull();
  });

  const series = (extra: Record<string, unknown> = {}) => foldEvents([ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: 9 * 60, deadline: '2026-10-28', repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', seriesId: 's1', index: 1, next: null }, ...extra } })]);

  test('completing an occurrence makes the next one in the same list, a week on, with the series’ time and deadline', async () => {
    const fake = fakeClient(series(), (method, path, body) => {
      if (path.startsWith('/google/tasks/all')) return { tasks: [item({ completed: true })], complete: true };
      if (method === 'POST' && path === '/google/tasks') return { task: item({ id: 'gt2', due: body.due }) };
      return {};
    });
    const store = new GoogleStore(host, fake.client, 'page');
    expect(dueOccurrences(fake.state(), [item({ completed: true })])).toMatchObject([{ date: '2026-11-02' }]);
    await store.makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls.find((call) => call.method === 'POST')).toMatchObject({ path: '/google/tasks', body: { account: ME, listId: 'L1', title: 'Send the report', due: '2026-11-02' } });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.next).toBe('gt2');
    expect(keptFor(fake.state(), { account: ME, id: 'gt2' })).toMatchObject({ time: 9 * 60, deadline: '2026-11-04', repeat: { seriesId: 's1', index: 2, next: null } });
    // Seen again (another read, another window): nothing more is made.
    await store.makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  test('no duplicate when Google’s own repeat made the next one already', async () => {
    const theirs = item({ id: 'g-own', due: '2026-11-02' });
    expect(madeAlready([item({ completed: true }), theirs], 'Send the report', '2026-11-02', 'gt1')?.id).toBe('g-own');
    const fake = fakeClient(series(), (_method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [item({ completed: true }), theirs], complete: true } : {}));
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.next).toBe('g-own');
    expect(keptFor(fake.state(), { account: ME, id: 'g-own' })?.repeat?.index).toBe(2);
  });

  test('the last occurrence ends the series', async () => {
    const fake = fakeClient(series({ repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=1', seriesId: 's1', index: 1, next: null } }));
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls).toEqual([]);
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat).toBeNull();
  });

  test('editing All tasks changes the rule of the series; This task leaves the others alone', async () => {
    const start = applyEvents(series(), [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt3', patch: { repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', seriesId: 's1', index: 2, next: null } } })]);
    const fake = fakeClient(start);
    const store = new GoogleStore(host, fake.client, 'page');
    const fields = (rule: string, time = 9 * 60) => ({ title: 'Send the report', notes: 'To Ann', due: '2026-10-26', kept: { time, duration: null, deadline: '2026-10-28', rule } });
    await store.saveListTask(item(), fields('RRULE:FREQ=WEEKLY;BYDAY=MO', 10 * 60), 'this');
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.time).toBe(10 * 60);
    expect(keptFor(fake.state(), { account: ME, id: 'gt3' })).toMatchObject({ time: null, repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO' } });
    await store.saveListTask(item(), fields('RRULE:FREQ=DAILY'), 'all');
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.rule).toBe('RRULE:FREQ=DAILY');
    expect(keptFor(fake.state(), { account: ME, id: 'gt3' })?.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 2 });
    // Google's own fields did not change, so Google was not written.
    expect(fake.calls).toEqual([]);
  });
});

describe("a repeating task's series", () => {
  /** A small Google Tasks list behind the store: tasks made, changed and read as Google keeps them. */
  const google = () => {
    const tasks = new Map<string, GoogleTaskItem>();
    let n = 0;
    const answer = (method: string, path: string, body: any) => {
      if (method === 'POST' && path === '/google/tasks') {
        const made = item({ id: `gt${++n}`, title: body.title, notes: body.notes ?? '', due: body.due ?? null, parent: null });
        tasks.set(made.id, made);
        return { task: made };
      }
      if (method === 'PATCH' && path === '/google/tasks') {
        const { account: _a, listId: _l, id, completed, ...rest } = body;
        const next = { ...tasks.get(id)!, ...rest, ...(completed !== undefined ? { completed } : {}) };
        tasks.set(id, next);
        return { task: next };
      }
      if (path.startsWith('/google/tasks/all')) return { tasks: [...tasks.values()], complete: true };
      return {};
    };
    return { tasks, answer };
  };
  const daily = async () => {
    const world = google();
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Daily standup', notes: 'Agenda', due: '2026-10-27' }, { time: 10 * 60, deadline: '2026-10-28', rule: 'RRULE:FREQ=DAILY' });
    return { world, fake, store, first };
  };
  const posts = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((call) => call.method === 'POST' && call.path === '/google/tasks');
  const fields = (title: string, notes: string, due: string, time: number, deadline: string | null, rule = 'RRULE:FREQ=DAILY') => ({ title, notes, due, kept: { time, duration: null, deadline, rule } });

  test('a new series keeps its template: title, details, time, the deadline as days after the date, and where its schedule starts', async () => {
    const { fake, first } = await daily();
    expect(keptFor(fake.state(), first)?.repeat).toEqual({ rule: 'RRULE:FREQ=DAILY', seriesId: expect.any(String), index: 1, next: null, on: '2026-10-27', template: { title: 'Daily standup', notes: 'Agenda', time: 600, duration: null, deadline: 1, start: '2026-10-27' } });
  });

  test('This task changes one occurrence; the next is made from the template, on the series’ next date after the original one', async () => {
    const { world, fake, store, first } = await daily();
    // The reviewer's case: a one-off title, details, time and date for this task alone.
    await store.saveListTask(first, fields('One-off', 'Just today', '2026-10-29', 12 * 60, '2026-10-30'), 'this');
    expect(world.tasks.get(first.id)).toMatchObject({ title: 'One-off', notes: 'Just today', due: '2026-10-29' });
    const kept = keptFor(fake.state(), first)!;
    expect(kept).toMatchObject({ time: 720, deadline: '2026-10-30', repeat: { on: '2026-10-27', template: { title: 'Daily standup', notes: 'Agenda', time: 600, deadline: 1 } } });
    await store.completeListTask(world.tasks.get(first.id)!, true);
    // Made from the template, on the 28th: the one-off move to the 29th does not shift the series.
    expect(posts(fake).at(-1)?.body).toMatchObject({ title: 'Daily standup', notes: 'Agenda', due: '2026-10-28' });
    const next = [...world.tasks.values()].find((task) => !task.completed)!;
    expect(next).toMatchObject({ title: 'Daily standup', due: '2026-10-28' });
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 600, deadline: '2026-10-29', repeat: { index: 2, next: null, on: '2026-10-28', template: { title: 'Daily standup' } } });
    expect(keptFor(fake.state(), first)?.repeat?.next).toBe(next.id);
  });

  test('All tasks changes the template, then this occurrence to match; the following one has the new values', async () => {
    const { world, fake, store, first } = await daily();
    await store.saveListTask(first, fields('Standup', 'New agenda', '2026-10-27', 9 * 60, '2026-10-29'), 'all');
    expect(world.tasks.get(first.id)).toMatchObject({ title: 'Standup', notes: 'New agenda', due: '2026-10-27' });
    expect(keptFor(fake.state(), first)).toMatchObject({ time: 540, deadline: '2026-10-29', repeat: { index: 1, on: '2026-10-27', template: { title: 'Standup', notes: 'New agenda', time: 540, deadline: 2, start: '2026-10-27' } } });
    await store.completeListTask(world.tasks.get(first.id)!, true);
    expect(posts(fake).at(-1)?.body).toMatchObject({ title: 'Standup', notes: 'New agenda', due: '2026-10-28' });
    const next = [...world.tasks.values()].find((task) => !task.completed)!;
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 540, deadline: '2026-10-30', repeat: { index: 2, on: '2026-10-28' } });
  });

  test('a new rule is for all tasks and starts the schedule on the occurrence’s date; a new date for all moves the schedule there', async () => {
    const { fake, store, first } = await daily();
    await store.saveListTask(first, fields('Daily standup', 'Agenda', '2026-10-27', 600, '2026-10-28', 'RRULE:FREQ=WEEKLY;BYDAY=TU'), 'this');
    expect(keptFor(fake.state(), first)?.repeat).toMatchObject({ rule: 'RRULE:FREQ=WEEKLY;BYDAY=TU', index: 1, on: '2026-10-27', template: { start: '2026-10-27' } });
    await store.saveListTask(first, fields('Daily standup', 'Agenda', '2026-10-28', 600, '2026-10-29', 'RRULE:FREQ=WEEKLY;BYDAY=TU'), 'all');
    expect(keptFor(fake.state(), first)?.repeat).toMatchObject({ on: '2026-10-28', template: { start: '2026-10-28', deadline: 1 } });
    // Stopping the repeat stops the series.
    await store.saveListTask({ ...first, due: '2026-10-28' }, { ...fields('Daily standup', 'Agenda', '2026-10-28', 600, null), kept: { time: 600, duration: null, deadline: null, rule: null } }, 'all');
    expect(keptFor(fake.state(), first)?.repeat).toBeNull();
  });

  const legacy = (extra: Record<string, unknown> = {}) => foldEvents([ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: 10 * 60, deadline: '2026-10-27', repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's9', index: 3, next: null }, ...extra } })]);

  test('a series kept before templates gets one from its open occurrence the first time it is seen, once, and nothing is made in Google', async () => {
    const open = item({ title: 'Water the plants', notes: 'Balcony', due: '2026-10-26' });
    expect(firstSightOfSeries(legacy(), [open, open])).toEqual([
      { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's9', index: 3, next: null, on: '2026-10-26', template: { title: 'Water the plants', notes: 'Balcony', time: 600, duration: null, deadline: 1, start: '2026-10-26' } } } },
    ]);
    const fake = fakeClient(legacy(), (_method, path) => (path === '/google/tasks/linked' ? { tasks: [open], missing: [] } : {}));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.syncItems([open]);
    await store.syncItems([open]);
    expect(fake.dispatched.filter((body) => body.type === 'gtask.kept')).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
    // A completed occurrence, or one whose next is made, is left as it is.
    expect(firstSightOfSeries(legacy(), [{ ...open, completed: true }])).toEqual([]);
    expect(firstSightOfSeries(legacy({ repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's9', index: 3, next: 'gt2' } }), [open])).toEqual([]);
  });

  test('a series kept before templates, edited with This task before it was seen, keeps the occurrence as it was', async () => {
    const before = item({ title: 'Water the plants', notes: 'Balcony', due: '2026-10-26' });
    const fake = fakeClient(legacy(), (method, path, body) => (method === 'PATCH' && path === '/google/tasks' ? { task: { ...before, ...body } } : {}));
    await new GoogleStore(host, fake.client, 'page').saveListTask(before, fields('Water the roses', 'Balcony', '2026-10-26', 8 * 60, '2026-10-27'), 'this');
    expect(keptFor(fake.state(), before)).toMatchObject({ time: 480, repeat: { index: 3, on: '2026-10-26', template: { title: 'Water the plants', time: 600, deadline: 1 } } });
  });

  test('a series kept before templates, completed before it was seen, goes on from the occurrence as it is', async () => {
    const done = item({ title: 'Water the plants', notes: 'Balcony', due: '2026-10-26', completed: true });
    const fake = fakeClient(legacy(), (method, path, body) => {
      if (path.startsWith('/google/tasks/all')) return { tasks: [done], complete: true };
      if (method === 'POST') return { task: item({ id: 'gt2', title: body.title, notes: body.notes, due: body.due }) };
      return {};
    });
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([done]);
    expect(fake.calls.find((call) => call.method === 'POST')?.body).toMatchObject({ title: 'Water the plants', notes: 'Balcony', due: '2026-10-27' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt2' })).toMatchObject({ time: 600, deadline: '2026-10-28', repeat: { index: 4, on: '2026-10-27', template: { title: 'Water the plants' } } });
  });
});

describe('the calendar shows deadlines and upcoming occurrences, as Google Calendar does', () => {
  const template = { title: 'Daily standup', notes: 'Agenda', time: 600, duration: null, deadline: null, start: '2026-10-27' };
  const repeat = (patch: Record<string, unknown> = {}) => ({ rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null, on: '2026-10-27', template, ...patch });
  const kept = (taskId: string, patch: Record<string, unknown>) => ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId, patch } as EventBody);
  const daily = (extra: Record<string, unknown> = {}) => foldEvents([kept('gt1', { time: 600, repeat: repeat(extra) })]).googleTasks;
  const dates = (found: { date: string }[]) => found.map((task) => task.date);
  const WEEK = ['2026-10-26', '2026-11-01'] as const;

  test('a daily task shows its upcoming occurrences in the range, from the one open now, not before today', () => {
    const found = upcomingTasks(daily(), [item({ id: 'gt1', due: '2026-10-27' })], ...WEEK, '2026-10-27');
    expect(dates(found)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(found[0]).toMatchObject({ account: ME, listId: 'L1', taskId: 'gt1', seriesId: 's1', index: 2, template: { title: 'Daily standup', time: 600 } });
    // An occurrence left undone a week: the ones after it from today on, as completing it goes on from its own date.
    expect(dates(upcomingTasks(daily({ on: '2026-10-20' }), [], ...WEEK, '2026-10-27'))[0]).toBe('2026-10-27');
    // A series that ends: after its count, or its last day.
    expect(dates(upcomingTasks(daily({ rule: 'RRULE:FREQ=DAILY;COUNT=3' }), [], ...WEEK, '2026-10-27'))).toEqual(['2026-10-28', '2026-10-29']);
    expect(dates(upcomingTasks(daily({ rule: 'RRULE:FREQ=DAILY;UNTIL=20261029' }), [], ...WEEK, '2026-10-27'))).toEqual(['2026-10-28', '2026-10-29']);
    expect(dates(upcomingTasks(daily({ rule: 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH' }), [], ...WEEK, '2026-10-27'))).toEqual(['2026-10-29']);
  });

  test('the real next occurrence replaces its projection, never two for one date; none past a deleted series', () => {
    // Completed, its next made (with what is kept for it): the series goes on from the new one.
    const made = foldEvents([kept('gt1', { time: 600, repeat: repeat({ next: 'gt2' }) }), kept('gt2', { time: 600, repeat: repeat({ index: 2, on: '2026-10-28' }) })]).googleTasks;
    expect(dates(upcomingTasks(made, [item({ id: 'gt2', due: '2026-10-28' })], ...WEEK, '2026-10-27'))).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    // Shown already on a date (one occurrence moved there, or one Google's own repeat made with the title): not projected there.
    expect(dates(upcomingTasks(daily(), [item({ id: 'gt1', due: '2026-10-29' })], ...WEEK, '2026-10-27'))).not.toContain('2026-10-29');
    expect(dates(upcomingTasks(daily(), [item({ id: 'g-own', title: 'Daily standup', due: '2026-10-30' })], ...WEEK, '2026-10-27'))).not.toContain('2026-10-30');
    // Two open occurrences of one series project each date once.
    const twice = foldEvents([kept('gt1', { repeat: repeat() }), kept('gt5', { repeat: repeat() })]).googleTasks;
    expect(dates(upcomingTasks(twice, [], ...WEEK, '2026-10-27'))).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    // Deleted (all future tasks): what is kept goes, and so do its projections.
    expect(upcomingTasks(applyEvents(foldEvents([kept('gt1', { repeat: repeat() })]), [ev({ type: 'gtask.dropped', account: ME, taskId: 'gt1' })]).googleTasks, [], ...WEEK, '2026-10-27')).toEqual([]);
    // A series kept before templates waits for its first sight.
    expect(upcomingTasks(foldEvents([kept('gt1', { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null } })]).googleTasks, [], ...WEEK, '2026-10-27')).toEqual([]);
  });

  test('an upcoming occurrence is drawn at the template’s time, or all day', () => {
    const [first] = upcomingTasks(daily(), [], ...WEEK, '2026-10-27');
    expect(upcomingEvent(first!, 'America/Los_Angeles')).toMatchObject({ id: 'gtask-upcoming:s1:2026-10-28', calendarId: 'google-tasks', title: 'Daily standup', allDay: false, start: '2026-10-28T17:00:00.000Z', end: '2026-10-28T17:30:00.000Z', busy: false });
    expect(upcomingEvent({ ...first!, template: { ...template, time: null } }, 'America/Los_Angeles')).toMatchObject({ allDay: true, start: '2026-10-28T07:00:00.000Z', end: '2026-10-29T07:00:00.000Z' });
  });

  test('a deadline shows on its day in the all-day section: alone for a task without a date, beside it for one with another date', () => {
    const state = foldEvents([kept('gt1', { deadline: '2026-10-28' }), kept('gt2', { deadline: '2026-10-30' }), kept('gt3', { deadline: '2026-10-29' }), kept('gt4', { deadline: '2026-12-01' })]).googleTasks;
    const undated = item({ id: 'gt1', title: 'Renew the passport', due: null });
    const dated = item({ id: 'gt2', due: '2026-10-27' });
    const same = item({ id: 'gt3', due: '2026-10-29' });
    const later = item({ id: 'gt4', due: null });
    const shown = deadlineEvents([undated, dated, same, later, undated], state, ...WEEK, 'America/Los_Angeles');
    expect(shown.map((event) => [event.id, event.start, event.allDay, event.taskDeadline])).toEqual([
      ['gtask-deadline:L1:gt1', '2026-10-28T07:00:00.000Z', true, true],
      ['gtask-deadline:L1:gt2', '2026-10-30T07:00:00.000Z', true, true],
    ]);
    expect(shown[0]!.googleTask).toEqual(undated);
    // What the service reads for them: by account and list, in the range only.
    expect(deadlineGroups(state, [ME], ...WEEK)).toEqual([{ account: ME, listId: 'L1', ids: ['gt1', 'gt2', 'gt3'] }]);
    expect(deadlineGroups(state, ['other@example.com'], ...WEEK)).toEqual([]);
  });
});

describe('a repeating task and subtasks never go together, as in Google Tasks', () => {
  const repeating = () => foldEvents([ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null } } })]);
  const row = (id: string, depth: 0 | 1 = 0, parent: string | null = null) => ({ item: item({ id, parent }), depth, children: 0 });

  test('dragged right under a repeating task, a task stays at the top level; a repeating task does not nest', () => {
    const repeats = (id: string) => id === 'gt1';
    const rows = [row('gt1'), row('gt2'), row('gt3')];
    expect(dropTarget(rows, 'gt3', 1, true, repeats)).toEqual({ parent: null, previous: 'gt1' });
    expect(dropTarget(rows, 'gt3', 2, true, repeats)).toEqual({ parent: 'gt2', previous: null });
    expect(dropTarget(rows, 'gt1', 2, true, repeats)).toEqual({ parent: null, previous: 'gt3' });
    expect(dropTarget(rows, 'gt3', 1, true)).toEqual({ parent: 'gt1', previous: null });
  });

  test('a subtask under a repeating task, a repeating task under another, or a repeat on a task with subtasks: refused before anything changes', async () => {
    const fake = fakeClient(repeating(), (_method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [item({ id: 'gt2' }), item({ id: 'gt3', parent: 'gt2' })], complete: true } : {}));
    const store = new GoogleStore(host, fake.client, 'page');
    const refused = (work: Promise<unknown>) => work.then(() => null, (error: Error) => error.message);
    expect(await refused(store.addListTask(ME, 'L1', { title: 'Child', parent: 'gt1' }))).toBe(REPEATING_NO_SUBTASKS);
    expect(await refused(store.moveListTask(item({ id: 'gt2' }), { parent: 'gt1', previous: null }))).toBe(REPEATING_NO_SUBTASKS);
    expect(await refused(store.moveListTask(item({ id: 'gt1' }), { parent: 'gt2', previous: null }))).toBe(REPEATING_NOT_SUBTASK);
    const daily = { title: 'Send the report', notes: 'To Ann', due: '2026-10-26', kept: { time: null, duration: null, deadline: null, rule: 'RRULE:FREQ=DAILY' } };
    expect(await refused(store.saveListTask(item({ id: 'gt2' }), daily))).toBe(SUBTASKS_NO_REPEAT);
    expect(await refused(store.saveListTask(item({ id: 'gt3', parent: 'gt2' }), daily))).toBe(SUBTASK_NO_REPEAT);
    // Nothing reached Google but a read of the list, and nothing was kept.
    expect(fake.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(fake.dispatched).toEqual([]);
    // A task without subtasks still takes a repeat, and a repeating one keeps its series on other edits.
    await store.saveListTask(item({ id: 'gt1' }), { ...daily, title: 'Send the full report' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.rule).toBe('RRULE:FREQ=DAILY');
  });
});

describe('calendar titles fit their block, as Google Calendar fits them', () => {
  test('one line reads "Title, 10am"; taller blocks give the title every whole line, the time the one after it', () => {
    // A 30-minute block at 48 px an hour: 22 px, less its padding.
    expect(blockText(18, 14)).toEqual({ inline: true, lines: 1 });
    expect(blockText(6, 14)).toEqual({ inline: true, lines: 1 });
    // 45 minutes, an hour, two hours.
    expect(blockText(30, 14)).toEqual({ inline: false, lines: 2 });
    expect(blockText(42, 14)).toEqual({ inline: false, lines: 3 });
    expect(blockText(90, 14)).toEqual({ inline: false, lines: 6 });
  });
});

describe('the service reads tasks as the Planner shows them', () => {
  test('toTaskItem keeps what a link compares against', () => {
    const read = toTaskItem({ id: 'gt1', title: 'Send the report', notes: 'To Ann', due: '2026-10-26T00:00:00.000Z', status: 'needsAction', updated: '2026-10-26T15:00:00.000Z' }, ME, 'L1')!;
    expect(gtaskSource(read)).toMatchObject({ title: 'Send the report', notes: 'To Ann', due: '2026-10-26', listId: 'L1' });
  });
});
