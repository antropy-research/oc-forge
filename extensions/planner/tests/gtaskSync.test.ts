// A Google task and the Planner task planning it stay in step: the link follows
// the task to another list (moved here or seen on a read), every write goes to
// the list it is in now (a stale one is looked up once and the write retried),
// a write Google refuses leaves the Planner as Google is, and title, details
// and date merge three ways. What the Planner keeps for Google tasks (time,
// deadline, repeat, star) follows moves too; a repeating task's next
// occurrence is made once; a timed block's text fits its height. An edit is
// all or nothing (Google first, then what the Planner keeps); completing a
// task completes its subtasks, and reopening a subtask its task, however
// little the panel has loaded; a timed task's deadline has its all-day entry.
// Deleting "This task" of a series is all or nothing too (its next one first,
// then the delete); one upcoming occurrence is changed or deleted on its own,
// in the projections and when the series makes it.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, listKey, OCCURRENCE_KEEPS_DATE, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT } from '../panel/lib/google.ts';
import { dropTarget } from '../src/domain/gtasks.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { GoogleData, toTaskItem } from '../service/googleData.ts';
import { GoogleError, type GoogleAccounts } from '../service/google.ts';
import { seriesRoutes } from './seriesRoutes.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { emptyState, googleTaskKey, type GoogleTaskException, type PlannerState } from '../src/domain/types.ts';
import { findMovedTask, GONE_STATUS, gtaskSource, linkedGoogleTasks, mergeGoogleTask, planGoogleTaskSync, plannerEditTimes, TASK_GONE, taskFromGoogleTask, type GoogleTaskItem } from '../src/domain/google.ts';
import {
  deadlineEvents,
  deadlineGroups,
  dueOccurrences,
  firstSightOfSeries,
  keptFor,
  nextOccurrence,
  nextRepeatDate,
  occurrenceChange,
  occurrenceTask,
  occurrenceValues,
  seriesNextIn,
  starredKept,
  upcomingEvent,
  upcomingTasks,
  upcomingValues,
  withTaskTimes,
} from '../src/domain/gtaskKept.ts';
import { blockText } from '../src/domain/gcalendar.ts';
import type { CalendarEvent } from '../src/domain/ics.ts';

const ME = 'me@example.com';
/** A call that only reads: Google's tasks, or the plan and a task read again by a form's save. */
const reads = (call: { method: string; path: string }): boolean => call.method === 'GET' || call.path === '/google/tasks/linked';
let clock = Date.parse('2026-10-26T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id: 'gt1', title: 'Send the report', notes: 'To Ann', due: '2026-10-26', completed: false, parent: null, position: '0001', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-26T15:00:00.000Z', ...patch,
});
const planned = (google = item()) => foldEvents([ev({ type: 'task.created', task: taskFromGoogleTask(google, 't1', { kind: 'day', date: '2026-10-26' }, 1) })]);

/**
 * A Planner client whose dispatch applies (and checks) the events; Google answers through `answer`. The service's
 * series routes (`/google/tasks/next`, `/google/tasks/series`) run the service's own `GoogleSeries` here, its Google
 * calls answered by `answer` too (and listed in `calls`, as the panel's own) and its writes going into the same plan;
 * the routes asked for are in `routes`.
 */
const fakeClient = (start: PlannerState, answer: (method: string, path: string, body: any) => unknown = () => ({})) => {
  let state = start;
  let n = 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  const routes: { method: string; path: string; body?: any }[] = [];
  const notes: string[] = [];
  const dispatched: EventBody[] = [];
  const log: PlannerEvent[] = [];
  const google = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    return answer(method, path, body);
  };
  const apply = (bodies: EventBody[]) => {
    dispatched.push(...bodies);
    const events = bodies.map((body) => ev(body));
    log.push(...events);
    n += bodies.length;
    state = applyEvents(state, events);
  };
  const { series, handle } = seriesRoutes({ state: () => state, apply }, google);
  const client = {
    getView: () => ({ state, today: '2026-10-26' }),
    call: async (method: string, path: string, body?: any) => {
      const answered = await handle(path, body);
      if (answered) {
        routes.push({ method, path, ...(body === undefined ? {} : { body }) });
        return answered;
      }
      return google(method, path, body);
    },
    // The routes above wrote into this plan already.
    adopt: async () => {},
    dispatch: async (bodies: EventBody[]) => {
      for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
      apply(bodies);
    },
    activity: async (taskId: string) => log.filter((event) => 'taskId' in event && event.taskId === taskId),
    notify: (message: string) => notes.push(message),
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { client, calls, routes, series, notes, dispatched, log, state: () => state, setState: (next: PlannerState) => (state = next) };
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
    // A color is one of Google Calendar's, as #rrggbb (round 10); anything else the Planner does not keep.
    expect(check({ color: 'red' })).toMatch(/color must be #rrggbb/);
    expect(check({ priority: 'high' })).toMatch(/unknown field/);
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

  test('an unrelated task with the series’ title, due on its next date, is never taken for the next occurrence (review 5)', async () => {
    // Its own task: made separately, at 4pm, with its own details and no repeat.
    const theirs = item({ id: 'apt', due: '2026-11-02', notes: 'independent appointment' });
    const start = applyEvents(series(), [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'apt', patch: { time: 16 * 60 } })]);
    expect(seriesNextIn(start, [item({ completed: true }), theirs], { seriesId: 's1', index: 1 }, 'gt1')).toBeNull();
    const fake = fakeClient(start, (method, path, body) => {
      if (path.startsWith('/google/tasks/all')) return { tasks: [item({ completed: true }), theirs], complete: true };
      if (method === 'POST' && path === '/google/tasks') return { task: item({ id: 'gt2', due: body.due }) };
      return {};
    });
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([item({ completed: true })]);
    // The series gets an occurrence of its own; the other task keeps its time and stays a task that doesn't repeat.
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path === '/google/tasks')).toHaveLength(1);
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.next).toBe('gt2');
    expect(keptFor(fake.state(), { account: ME, id: 'apt' })).toMatchObject({ time: 16 * 60, repeat: null });
    // Seen again: no second one.
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path === '/google/tasks')).toHaveLength(1);
  });

  test('the next occurrence another window made (kept as this series’ next) is taken, not made twice', async () => {
    const made = item({ id: 'w2', due: '2026-11-02' });
    const start = applyEvents(series(), [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'w2', patch: { time: 9 * 60, repeat: { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', seriesId: 's1', index: 2, next: null } } })]);
    expect(seriesNextIn(start, [item({ completed: true }), made], { seriesId: 's1', index: 1 }, 'gt1')?.id).toBe('w2');
    const fake = fakeClient(start, (_method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [item({ completed: true }), made], complete: true } : {}));
    await new GoogleStore(host, fake.client, 'page').makeNextOccurrences([item({ completed: true })]);
    expect(fake.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.next).toBe('w2');
  });

  test('deleting a list drops what was kept for its tasks (no upcoming occurrences left) and marks linked tasks gone; a failed delete changes nothing (review 5)', async () => {
    const trip = item({ listId: 'L9', id: 'd1', title: 'Water the plants' });
    const start = applyEvents(planned(trip), [
      ev({ type: 'gtask.kept', account: ME, listId: 'L9', taskId: 'd1', patch: { time: 9 * 60, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's9', index: 1, next: null } } }),
      ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { starred: true } }),
    ]);
    const list = { account: ME, id: 'L9', title: 'Plants' };
    let refuse = true;
    const fake = fakeClient(start, (method) => {
      if (method === 'DELETE' && refuse) throw new Error('Backend Error');
      return {};
    });
    const store = new GoogleStore(host, fake.client, 'page');
    await expect(store.deleteList(list)).rejects.toThrow('Backend Error');
    expect(keptFor(fake.state(), { account: ME, id: 'd1' })?.repeat?.seriesId).toBe('s9');
    refuse = false;
    await store.deleteList(list);
    expect(keptFor(fake.state(), { account: ME, id: 'd1' })).toBeNull();
    // Another list's task keeps what it had.
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.starredAt).toBeTruthy();
    expect(fake.state().tasks['t1']?.source?.status).toEqual(GONE_STATUS);
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
    // Google's own fields did not change, so Google was not written (the save read the plan and the task again).
    expect(fake.calls.filter((call) => !reads(call))).toEqual([]);
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
    // The open one moved onto another occurrence's date (review 9): that occurrence still shows there, beside it.
    expect(dates(upcomingTasks(daily(), [item({ id: 'gt1', due: '2026-10-29' })], ...WEEK, '2026-10-27'))).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    // Its next one made and moved elsewhere: it is that occurrence, wherever it shows, so its date shows no projection.
    const movedNext = foldEvents([kept('gt1', { repeat: repeat({ next: 'gt2' }) }), kept('gt2', { repeat: repeat({ index: 2, on: '2026-10-28' }) })]).googleTasks;
    expect(dates(upcomingTasks(movedNext, [item({ id: 'gt2', due: '2026-10-31' })], ...WEEK, '2026-10-27'))).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    // Two open occurrences of one series project each date once.
    const twice = foldEvents([kept('gt1', { repeat: repeat() }), kept('gt5', { repeat: repeat() })]).googleTasks;
    expect(dates(upcomingTasks(twice, [], ...WEEK, '2026-10-27'))).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    // Deleted (all future tasks): what is kept goes, and so do its projections.
    expect(upcomingTasks(applyEvents(foldEvents([kept('gt1', { repeat: repeat() })]), [ev({ type: 'gtask.dropped', account: ME, taskId: 'gt1' })]).googleTasks, [], ...WEEK, '2026-10-27')).toEqual([]);
    // A series kept before templates waits for its first sight.
    expect(upcomingTasks(foldEvents([kept('gt1', { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null } })]).googleTasks, [], ...WEEK, '2026-10-27')).toEqual([]);
  });

  test('a task of its own that shares the title and the date never hides the series’ occurrence there (review 6)', () => {
    // A separate task: the series' title, due tomorrow at 4pm, its own details, no repeat.
    const withOther = applyEvents(foldEvents([kept('gt1', { time: 600, repeat: repeat() })]), [kept('apt', { time: 960 })]).googleTasks;
    const other = item({ id: 'apt', title: 'Daily standup', notes: 'independent appointment', due: '2026-10-28' });
    const found = upcomingTasks(withOther, [item({ id: 'gt1', title: 'Daily standup', due: '2026-10-27' }), other], ...WEEK, '2026-10-27');
    expect(dates(found)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(found[0]).toMatchObject({ seriesId: 's1', index: 2, template: { time: 600 } });
    // Renamed or not, the other task changes nothing.
    expect(dates(upcomingTasks(withOther, [{ ...other, title: 'Dentist' }], ...WEEK, '2026-10-27'))).toEqual(dates(found));
    // In the same list, in another: the same.
    expect(dates(upcomingTasks(withOther, [{ ...other, listId: 'L2' }], ...WEEK, '2026-10-27'))).toEqual(dates(found));
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

  test('a timed task’s deadline on its own day shows in the all-day section, its block staying at its time; an all-day task due that day stays one item', () => {
    const zone = 'America/Los_Angeles';
    const timed = item({ id: 'gt1', title: 'Review the deck', due: '2026-10-27' });
    const allDay = item({ id: 'gt2', title: 'Send the report', due: '2026-10-27' });
    const both = foldEvents([kept('gt1', { time: 13 * 60, deadline: '2026-10-27' }), kept('gt2', { deadline: '2026-10-27' })]);
    const entries = (state: PlannerState, items: GoogleTaskItem[]) => deadlineEvents(items, state.googleTasks, ...WEEK, zone).map((event) => [event.id, event.start, event.allDay, event.taskDeadline]);
    // The review's case: 1pm today, its deadline today.
    expect(entries(both, [timed, allDay])).toEqual([['gtask-deadline:L1:gt1', '2026-10-27T07:00:00.000Z', true, true]]);
    const due = (task: GoogleTaskItem): CalendarEvent => ({ id: `gtask:L1:${task.id}`, calendarId: 'google-tasks', title: task.title, location: '', start: `${task.due}T07:00:00.000Z`, end: '', allDay: true, busy: false, googleTask: task });
    expect(withTaskTimes([due(timed), due(allDay)], both.googleTasks, zone).map((event) => [event.id, event.allDay, event.start])).toEqual([
      ['gtask:L1:gt1', false, '2026-10-27T20:00:00.000Z'],
      ['gtask:L1:gt2', true, '2026-10-27T07:00:00.000Z'],
    ]);
    // The entries follow either date: the deadline moved to tomorrow; the all-day task moved off its deadline's day; the time cleared.
    const later = applyEvents(both, [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { deadline: '2026-10-28' } })]);
    expect(entries(later, [timed, allDay])).toEqual([['gtask-deadline:L1:gt1', '2026-10-28T07:00:00.000Z', true, true]]);
    expect(entries(both, [timed, { ...allDay, due: '2026-10-26' }]).map(([id]) => id)).toEqual(['gtask-deadline:L1:gt1', 'gtask-deadline:L1:gt2']);
    const untimed = applyEvents(both, [ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: null } })]);
    expect(entries(untimed, [timed, allDay])).toEqual([]);
  });
});

/**
 * Google Tasks behind the store, as Google keeps it: tasks made, changed,
 * moved and read (subtasks too, by list); `refuse` makes the next call it
 * matches fail, as Google's 503 does.
 */
const tasksWorld = (start: GoogleTaskItem[] = []) => {
  const tasks = new Map(start.map((task) => [task.id, { ...task }]));
  let n = 0;
  let refusing: ((method: string, path: string, body: any) => boolean) | null = null;
  const answer = (method: string, path: string, body: any) => {
    if (refusing?.(method, path, body)) {
      refusing = null;
      throw new Error('Backend Error');
    }
    if (method === 'POST' && path === '/google/tasks') {
      const made = item({ id: `gt${100 + ++n}`, listId: body.listId, title: body.title, notes: body.notes ?? '', due: body.due ?? null, parent: body.parent ?? null });
      tasks.set(made.id, made);
      return { task: made };
    }
    if (method === 'PATCH' && path === '/google/tasks') {
      const { account: _account, listId: _listId, id, ...rest } = body;
      const next = { ...tasks.get(id)!, ...rest };
      tasks.set(id, next);
      return { task: next };
    }
    if (method === 'POST' && path === '/google/tasks/move') {
      const moved = { ...tasks.get(body.id)!, listId: body.destinationListId ?? body.listId, parent: body.parent ?? null };
      tasks.set(body.id, moved);
      return { task: moved };
    }
    if (method === 'GET' && path.startsWith('/google/tasks/all')) {
      const list = new URLSearchParams(path.split('?')[1]).get('list');
      return { tasks: [...tasks.values()].filter((task) => task.listId === list), complete: true };
    }
    if (method === 'DELETE' && path.startsWith('/google/tasks?')) {
      const id = new URLSearchParams(path.split('?')[1]).get('id');
      for (const [key, task] of tasks) if (key === id || task.parent === id) tasks.delete(key);
      return {};
    }
    if (method === 'POST' && path === '/google/tasks/linked') return { tasks: [...tasks.values()].filter((task) => body.groups.some((group: { ids: string[] }) => group.ids.includes(task.id))), missing: [] };
    if (method === 'GET' && path === '/google/tasklists') return { lists: [{ account: ME, id: 'L1', title: 'My Tasks' }, { account: ME, id: 'L2', title: 'Errands' }], errors: [] };
    return {};
  };
  return { tasks, answer, refuse: (when: (method: string, path: string, body: any) => boolean) => (refusing = when) };
};
const refusedPatch = (method: string, path: string) => method === 'PATCH' && path === '/google/tasks';

describe('an edit Google refuses leaves everything as it was; Save again applies it once', () => {
  const fields = (title: string, due: string, time: number | null, deadline: string | null = null, rule: string | null = 'RRULE:FREQ=DAILY') => ({ title, notes: 'Agenda', due, kept: { time, duration: null, deadline, rule } });
  /** The review's series: a daily task at 1pm, and another open occurrence of it (a second window made one). */
  const daily = async () => {
    const world = tasksWorld();
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Daily standup', notes: 'Agenda', due: '2026-10-27' }, { time: 13 * 60, rule: 'RRULE:FREQ=DAILY' });
    const repeat = keptFor(fake.state(), first)!.repeat!;
    await fake.client.dispatch([{ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt9', patch: { time: 13 * 60, repeat: { ...repeat, index: 2, on: '2026-10-28' } } }]);
    return { world, fake, store, id: first.id, google: () => world.tasks.get(first.id)! };
  };
  /** What a reload shows: the service's log folded again. */
  const reloaded = (fake: ReturnType<typeof fakeClient>, id: string) => keptFor(foldEvents(fake.log), { account: ME, id });

  test('This task or All tasks, a title, a time, a date, a deadline or a repeat: Google, what is kept and the series stay as they were, after a reload too', async () => {
    const { world, fake, store, id, google } = await daily();
    const before = { google: { ...google() }, kept: keptFor(fake.state(), { account: ME, id }), other: keptFor(fake.state(), { account: ME, id: 'gt9' }) };
    const cases: [ReturnType<typeof fields>, 'this' | 'all'][] = [
      [fields('Rejected title', '2026-10-27', 16 * 60), 'all'],
      [fields('Rejected title', '2026-10-27', 16 * 60), 'this'],
      [fields('Daily standup', '2026-10-29', 13 * 60, '2026-10-30'), 'all'],
      [fields('Daily standup', '2026-10-29', 13 * 60), 'this'],
      [fields('Daily standup', '2026-10-28', 13 * 60, null, 'RRULE:FREQ=WEEKLY;BYDAY=WE'), 'all'],
    ];
    for (const [edit, scope] of cases) {
      const dispatched = fake.dispatched.length;
      world.refuse(refusedPatch);
      await expect(store.saveListTask(google(), edit, scope)).rejects.toThrow('Backend Error');
      expect(google()).toEqual(before.google);
      expect(keptFor(fake.state(), { account: ME, id })).toEqual(before.kept);
      expect(keptFor(fake.state(), { account: ME, id: 'gt9' })).toEqual(before.other);
      expect(fake.dispatched.length).toBe(dispatched);
      expect(reloaded(fake, id)).toEqual(before.kept);
    }
    // Nothing was made in Google either.
    expect(fake.calls.filter((call) => call.method === 'POST' && !reads(call))).toHaveLength(1);
  });

  test('with the list shown in the Tasks view, it shows the task as Google has it again', async () => {
    const { world, store, google } = await daily();
    await store.loadBoard(ME, 'L1');
    world.refuse(refusedPatch);
    await expect(store.saveListTask(google(), fields('Rejected title', '2026-10-27', 16 * 60), 'all')).rejects.toThrow();
    expect(store.getView().board[listKey(ME, 'L1')]!.items.find((task) => task.id === google().id)?.title).toBe('Daily standup');
  });

  test('Save again, once Google takes it: applied once, the series and its next occurrence with the new values', async () => {
    const { world, fake, store, id, google } = await daily();
    const edit = fields('Standup at four', '2026-10-27', 16 * 60);
    world.refuse(refusedPatch);
    await expect(store.saveListTask(google(), edit, 'all')).rejects.toThrow();
    // The form still has the edit and saves it again, with the task as it was.
    await store.saveListTask(google(), edit, 'all');
    expect(google()).toMatchObject({ title: 'Standup at four', due: '2026-10-27' });
    const kept = keptFor(fake.state(), { account: ME, id });
    expect(kept).toMatchObject({ time: 960, repeat: { index: 1, on: '2026-10-27', template: { title: 'Standup at four', time: 960, start: '2026-10-27' } } });
    expect(keptFor(fake.state(), { account: ME, id: 'gt9' })).toMatchObject({ time: 960, repeat: { index: 2, on: '2026-10-28', template: { title: 'Standup at four' } } });
    // One write reached Google (the other was refused); saved once more, nothing moves.
    expect(fake.calls.filter((call) => call.method === 'PATCH' && call.body.title === 'Standup at four')).toHaveLength(2);
    await store.saveListTask(google(), edit, 'all');
    expect(keptFor(fake.state(), { account: ME, id })).toMatchObject({ time: 960, repeat: kept!.repeat! });
    expect(fake.calls.filter((call) => call.method === 'PATCH' && call.body.title === 'Standup at four')).toHaveLength(2);
    // Completed: the next one is made with the new values, on the series' next date.
    await store.completeListTask(google(), true);
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path === '/google/tasks').at(-1)?.body).toMatchObject({ title: 'Standup at four', due: '2026-10-28' });
    const next = [...world.tasks.values()].find((task) => !task.completed && task.id !== 'gt9')!;
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 960, repeat: { index: 2, on: '2026-10-28' } });
  });

  test('a move to another list Google refuses puts back the fields Google took; nothing is kept until both are taken', async () => {
    const world = tasksWorld([item()]);
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const edit = { title: 'Send the full report', notes: 'To Ann', due: '2026-10-26', kept: { time: 600, duration: null, deadline: null, rule: null } };
    world.refuse((method, path) => method === 'POST' && path === '/google/tasks/move');
    await expect(store.saveListTask(item(), edit, 'this', { starred: true, listId: 'L2' })).rejects.toThrow('Backend Error');
    expect(world.tasks.get('gt1')).toMatchObject({ title: 'Send the report', listId: 'L1' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })).toBeNull();
    await store.saveListTask(item(), edit, 'this', { starred: true, listId: 'L2' });
    expect(world.tasks.get('gt1')).toMatchObject({ title: 'Send the full report', listId: 'L2' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })).toMatchObject({ listId: 'L2', time: 600, starredAt: expect.any(String) });
  });

  test('a timed task dragged to a day Google refuses keeps its time; taken, it has both', async () => {
    const world = tasksWorld([item()]);
    const fake = fakeClient(foldEvents([ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: 600 } })]), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    world.refuse(refusedPatch);
    await expect(store.moveTimedTask(item(), '2026-10-27', 840)).rejects.toThrow();
    expect([world.tasks.get('gt1')!.due, keptFor(fake.state(), { account: ME, id: 'gt1' })?.time]).toEqual(['2026-10-26', 600]);
    await store.moveTimedTask(item(), '2026-10-27', 840);
    expect([world.tasks.get('gt1')!.due, keptFor(fake.state(), { account: ME, id: 'gt1' })?.time]).toEqual(['2026-10-27', 840]);
  });
});

describe('completing a task completes its subtasks, and reopening a subtask reopens its task, however cold the panel is', () => {
  const trip = () =>
    tasksWorld([
      item({ id: 'p', title: 'Plan the trip', due: '2026-10-29' }),
      item({ id: 'c1', title: 'Book the hotel', due: null, parent: 'p' }),
      item({ id: 'c2', title: 'Pack the bags', due: null, parent: 'p' }),
      item({ id: 'c3', title: 'Renew the passport', due: null, parent: 'p', completed: true }),
      item({ id: 'x', title: 'Send the report' }),
    ]);
  const done = (world: ReturnType<typeof trip>) => ['p', 'c1', 'c2', 'c3', 'x'].map((id) => world.tasks.get(id)!.completed);
  const patched = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((call) => call.method === 'PATCH').map((call) => `${call.body.id}:${call.body.completed}`);
  const reads = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((call) => call.method === 'GET' && call.path.startsWith('/google/tasks/all')).length;

  test("a task Google's own apps moved to another list since the last read: its subtasks are found where it is now", async () => {
    const world = tasksWorld([
      item({ id: 'p', title: 'Plan the trip', listId: 'L2' }),
      item({ id: 'c1', title: 'Book the hotel', due: null, parent: 'p', listId: 'L2' }),
    ]);
    const fake = fakeClient(emptyState(), world.answer);
    // The Planner still names L1, the list the task was in when it last read it.
    await new GoogleStore(host, fake.client, 'page').completeListTask({ ...world.tasks.get('p')!, listId: 'L1' }, true);
    expect(world.tasks.get('c1')!.completed).toBe(true);
    expect(fake.calls.filter((call) => call.method === 'PATCH').map((call) => call.body.id)).toEqual(['c1', 'p']);
  });

  test('from the calendar of a fresh panel (no list loaded): its subtasks are read from Google and completed first, then the task', async () => {
    const world = trip();
    const fake = fakeClient(emptyState(), world.answer);
    await new GoogleStore(host, fake.client, 'page').completeListTask(world.tasks.get('p')!, true);
    expect(done(world)).toEqual([true, true, true, true, false]);
    expect(reads(fake)).toBe(1);
    // The one done already is left alone; no open subtask is ever under a completed task.
    expect(patched(fake)).toEqual(['c1:true', 'c2:true', 'p:true']);
  });

  test('reopening a subtask of a completed task reopens that task first, cold or warm; a subtask completed, or a task at the top reopened, reads nothing', async () => {
    const world = trip();
    for (const id of ['p', 'c1', 'c2']) world.tasks.set(id, { ...world.tasks.get(id)!, completed: true });
    const cold = fakeClient(emptyState(), world.answer);
    await new GoogleStore(host, cold.client, 'page').completeListTask(world.tasks.get('c1')!, false);
    expect(done(world)).toEqual([false, false, true, true, false]);
    expect(patched(cold)).toEqual(['p:false', 'c1:false']);
    const warm = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, warm.client, 'page');
    await store.completeListTask(world.tasks.get('c2')!, false);
    expect(patched(warm)).toEqual(['c2:false']);
    await store.loadBoard(ME, 'L1');
    await store.completeListTask(world.tasks.get('p')!, true);
    expect(done(world)).toEqual([true, true, true, true, false]);
    // The list as the Tasks view read it served, and shows the result.
    expect(reads(warm)).toBe(2);
    expect(store.getView().board[listKey(ME, 'L1')]!.items.filter((task) => task.completed).map((task) => task.id).sort()).toEqual(['c1', 'c2', 'c3', 'p']);
    const quiet = fakeClient(emptyState(), world.answer);
    const other = new GoogleStore(host, quiet.client, 'page');
    await other.completeListTask(world.tasks.get('p')!, false);
    await other.completeListTask(world.tasks.get('c1')!, true);
    expect(reads(quiet)).toBe(0);
  });

  test('a linked Planner task completed (Home, Today, Focus) completes its Google task’s subtasks; one reopened under a completed task reopens it', async () => {
    const world = trip();
    const linked = (id: string, taskId: string) => ev({ type: 'task.created', task: taskFromGoogleTask(world.tasks.get(id)!, taskId, { kind: 'day', date: '2026-10-29' }, 1) });
    const fake = fakeClient(foldEvents([linked('p', 't1'), linked('c1', 't2')]), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    expect(await store.writeTask(fake.state().tasks.t1!, { completed: true })).toBe(true);
    expect(done(world)).toEqual([true, true, true, true, false]);
    expect(patched(fake)).toEqual(['c1:true', 'c2:true', 'p:true']);
    // The Planner task planning a subtask takes the completion too.
    expect(fake.state().tasks.t2!.completedAt).toBeTruthy();
    expect(await store.writeTask(fake.state().tasks.t2!, { completed: false })).toBe(true);
    expect(done(world)).toEqual([false, false, true, true, false]);
    expect(patched(fake).slice(-2)).toEqual(['p:false', 'c1:false']);
  });

  test('refused half way: the task stays open (never completed over an open subtask), and a linked Planner task stays open too', async () => {
    const world = trip();
    const fake = fakeClient(emptyState(), world.answer);
    world.refuse((method, _path, body) => method === 'PATCH' && body.id === 'c2');
    await expect(new GoogleStore(host, fake.client, 'page').completeListTask(world.tasks.get('p')!, true)).rejects.toThrow('Backend Error');
    expect(done(world)).toEqual([false, true, false, true, false]);
    const start = applyEvents(foldEvents([ev({ type: 'task.created', task: taskFromGoogleTask(world.tasks.get('p')!, 't1', { kind: 'day', date: '2026-10-29' }, 1) })]), [ev({ type: 'task.completed', taskId: 't1', on: '2026-10-26' })]);
    const linked = fakeClient(start, world.answer);
    world.refuse((method, _path, body) => method === 'PATCH' && body.id === 'c2');
    expect(await new GoogleStore(host, linked.client, 'page').writeTask(linked.state().tasks.t1!, { completed: true })).toBe(false);
    expect(world.tasks.get('p')!.completed).toBe(false);
    expect(linked.state().tasks.t1!.completedAt).toBeNull();
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
    // Nothing reached Google but reads (of the list, and of the task by the save), and nothing was kept.
    expect(fake.calls.every(reads)).toBe(true);
    expect(fake.dispatched).toEqual([]);
    // A task without subtasks still takes a repeat, and a repeating one keeps its series on other edits.
    await store.saveListTask(item({ id: 'gt1' }), { ...daily, title: 'Send the full report' });
    expect(keptFor(fake.state(), { account: ME, id: 'gt1' })?.repeat?.rule).toBe('RRULE:FREQ=DAILY');
  });
});

/** Lets what a write started in the background (its sync) finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('deleting "This task" of a repeating task is all or nothing (review 7)', () => {
  /** The review's case: a daily task on the 27th at 11am in Google Tasks behind the store; `refuse` fails each matching call until cleared. */
  const daily = async () => {
    const world = tasksWorld();
    let refusing: ((method: string, path: string) => boolean) | null = null;
    const fake = fakeClient(emptyState(), (method, path, body) => {
      if (refusing?.(method, path)) throw new Error('Backend Error');
      return world.answer(method, path, body);
    });
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Daily standup', notes: 'Agenda', due: '2026-10-27' }, { time: 11 * 60, rule: 'RRULE:FREQ=DAILY' });
    return { world, fake, store, id: first.id, google: () => world.tasks.get(first.id) ?? null, refuse: (when: typeof refusing) => (refusing = when) };
  };
  const posts = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((call) => call.method === 'POST' && call.path === '/google/tasks');
  const open = (world: ReturnType<typeof tasksWorld>) => [...world.tasks.values()].filter((task) => !task.completed);
  /** The dates the series shows upcoming this week, from the 27th. */
  const projected = (state: PlannerState) => upcomingTasks(state.googleTasks, [], '2026-10-26', '2026-11-01', '2026-10-27').map((task) => task.date);
  const WEEK = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  const refusedPost = (method: string, path: string) => method === 'POST' && path === '/google/tasks';

  test('the next one is made first, from the series on its next date, with its kept record and the link; only then is this one deleted', async () => {
    const { world, fake, store, id, google } = await daily();
    await store.deleteListTask(google()!, 'this');
    // The task added, its next one, then the delete.
    expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(google()).toBeNull();
    expect(open(world)).toHaveLength(1);
    const next = open(world)[0]!;
    expect(next).toMatchObject({ title: 'Daily standup', notes: 'Agenda', due: '2026-10-28' });
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 660, repeat: { index: 2, next: null, on: '2026-10-28', template: { title: 'Daily standup', notes: 'Agenda', time: 660, start: '2026-10-27' } } });
    expect(keptFor(fake.state(), { account: ME, id })).toBeNull();
    expect(projected(fake.state())).toEqual(WEEK.slice(1));
  });

  test('Google refuses the next one: nothing is deleted; the task, its series and its projections stay, after a reload too; deleting again makes exactly one', async () => {
    const { world, fake, store, id, google, refuse } = await daily();
    await store.loadBoard(ME, 'L1');
    const kept = keptFor(fake.state(), { account: ME, id });
    expect(projected(fake.state())).toEqual(WEEK);
    refuse(refusedPost);
    await expect(store.deleteListTask(google()!, 'this')).rejects.toThrow(`the next "Daily standup" couldn't be made, so this one stays (Backend Error)`);
    expect(fake.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(google()).toMatchObject({ title: 'Daily standup', due: '2026-10-27', completed: false });
    expect(open(world)).toHaveLength(1);
    expect(keptFor(fake.state(), { account: ME, id })).toEqual(kept);
    expect(projected(fake.state())).toEqual(WEEK);
    // A reload folds the service's log again: the same.
    expect(keptFor(foldEvents(fake.log), { account: ME, id })).toEqual(kept);
    expect(projected(foldEvents(fake.log))).toEqual(WEEK);
    // The Tasks view shows it again.
    expect(store.getView().board[listKey(ME, 'L1')]!.items.map((task) => task.id)).toEqual([id]);
    // Google takes it now: Delete → This task again deletes it and makes exactly one, on the 28th, as the series has it.
    refuse(null);
    await store.deleteListTask(google()!, 'this');
    expect(google()).toBeNull();
    expect(open(world)).toHaveLength(1);
    const next = open(world)[0]!;
    expect(next).toMatchObject({ title: 'Daily standup', notes: 'Agenda', due: '2026-10-28' });
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 660, repeat: { index: 2, on: '2026-10-28', template: kept!.repeat!.template } });
    // The refused one and the one made.
    expect(posts(fake).filter((call) => call.body.due === '2026-10-28')).toHaveLength(2);
    expect(projected(fake.state())).toEqual(WEEK.slice(1));
  });

  test('Google refuses the delete once the next one is made: both stay, linked, and it says so; deleting again finishes, with no second one', async () => {
    const { world, fake, store, id, google, refuse } = await daily();
    refuse((method) => method === 'DELETE');
    await expect(store.deleteListTask(google()!, 'this')).rejects.toThrow('Backend Error; its next task, Wednesday, October 28, is made, so deleting this one again finishes');
    const next = open(world).find((task) => task.id !== id)!;
    expect(google()).not.toBeNull();
    expect(next).toMatchObject({ title: 'Daily standup', due: '2026-10-28' });
    expect(keptFor(fake.state(), { account: ME, id })?.repeat).toMatchObject({ next: next.id, template: { title: 'Daily standup' } });
    expect(keptFor(fake.state(), next)).toMatchObject({ time: 660, repeat: { index: 2, next: null, on: '2026-10-28' } });
    // The series goes on from the next one: each date once.
    expect(projected(fake.state())).toEqual(WEEK.slice(1));
    refuse(null);
    await store.deleteListTask(google()!, 'this');
    expect(google()).toBeNull();
    expect(open(world).map((task) => task.id)).toEqual([next.id]);
    expect(posts(fake)).toHaveLength(2);
    expect(keptFor(fake.state(), { account: ME, id })).toBeNull();
    expect(keptFor(fake.state(), next)?.repeat).toMatchObject({ next: null, on: '2026-10-28' });
  });

  test('completed, its next refused: it keeps its series and projections, the next read makes exactly one; deleted first, it makes that one before it goes', async () => {
    const { world, fake, store, id, google, refuse } = await daily();
    refuse(refusedPost);
    await store.completeListTask(google()!, true);
    // Its sync in the background tries again, refused too.
    await flush();
    expect(fake.notes.filter((note) => note.startsWith('Google Tasks did not take the next "Daily standup"')).length).toBeGreaterThanOrEqual(1);
    expect(google()).toMatchObject({ completed: true });
    expect(open(world)).toEqual([]);
    expect(keptFor(foldEvents(fake.log), { account: ME, id })?.repeat).toMatchObject({ next: null, on: '2026-10-27', template: { title: 'Daily standup', time: 660 } });
    expect(projected(foldEvents(fake.log))).toEqual(WEEK);
    // The next read, once Google takes it: one, from the series, on the 28th; read again, no second.
    refuse(null);
    await store.syncItems([google()!]);
    await store.syncItems([google()!]);
    expect(open(world)).toHaveLength(1);
    expect(open(world)[0]).toMatchObject({ title: 'Daily standup', due: '2026-10-28' });
    expect(keptFor(fake.state(), { account: ME, id })?.repeat?.next).toBe(open(world)[0]!.id);

    // The same, deleted with This task before a read: its next one first, so the series never goes.
    const other = await daily();
    other.refuse(refusedPost);
    await other.store.completeListTask(other.google()!, true);
    await flush();
    other.refuse(null);
    await other.store.deleteListTask(other.google()!, 'this');
    expect(other.google()).toBeNull();
    expect(open(other.world)).toHaveLength(1);
    expect(keptFor(other.fake.state(), open(other.world)[0]!)).toMatchObject({ time: 660, repeat: { index: 2, on: '2026-10-28', template: { title: 'Daily standup' } } });
  });
});

describe('one upcoming task of a series changed or deleted on its own, as in Google Calendar (review 7)', () => {
  const template = { title: 'Daily standup', notes: 'Agenda', time: 660, duration: null, deadline: 0, start: '2026-10-27' };
  const series = (exceptions: Record<string, GoogleTaskException>, rule = 'RRULE:FREQ=DAILY') =>
    foldEvents([ev({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { time: 660, deadline: '2026-10-27', repeat: { rule, seriesId: 's1', index: 1, next: null, on: '2026-10-27', template, exceptions } } })]);
  const seen = (found: ReturnType<typeof upcomingTasks>) => found.map((task) => [task.on, task.date, upcomingValues(task).title, upcomingValues(task).time]);

  test('in the projections: a deleted date shows nothing, an edited one its own values, a moved one on its new date; the others as the series has them', () => {
    const state = series({
      '2026-10-28': { skip: true },
      '2026-10-29': { title: 'Standup with Ann', time: 900, duration: null },
      '2026-10-30': { date: '2026-11-03' },
      '2026-11-05': { date: '2026-10-31', notes: 'Moved up' },
    });
    const week = upcomingTasks(state.googleTasks, [item({ id: 'gt1', due: '2026-10-27' })], '2026-10-26', '2026-11-01', '2026-10-27');
    expect(seen(week)).toEqual([
      ['2026-10-29', '2026-10-29', 'Standup with Ann', 900],
      ['2026-10-31', '2026-10-31', 'Daily standup', 660],
      ['2026-11-01', '2026-11-01', 'Daily standup', 660],
      // A later one moved into this week.
      ['2026-11-05', '2026-10-31', 'Daily standup', 660],
    ]);
    const events = week.map((task) => upcomingEvent(task, 'America/Los_Angeles'));
    expect(events[0]).toMatchObject({ id: 'gtask-upcoming:s1:2026-10-29', title: 'Standup with Ann', start: '2026-10-29T22:00:00.000Z', allDay: false });
    expect(events[3]).toMatchObject({ id: 'gtask-upcoming:s1:2026-11-05', start: '2026-10-31T18:00:00.000Z' });
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
    expect(upcomingValues(week[3]!)).toMatchObject({ notes: 'Moved up', deadline: '2026-11-05' });
    // The next week: the one moved there beside that date's own, and nothing on the date moved away.
    const next = upcomingTasks(state.googleTasks, [], '2026-11-02', '2026-11-08', '2026-10-27');
    expect(next.filter((task) => task.date === '2026-11-03').map((task) => task.on)).toEqual(['2026-10-30', '2026-11-03']);
    expect(next.map((task) => task.date)).not.toContain('2026-11-05');
  });

  test('an occurrence edited alone keeps only what differs from its series there', () => {
    const own = occurrenceValues(template, '2026-10-29');
    expect(own).toEqual({ title: 'Daily standup', notes: 'Agenda', due: '2026-10-29', time: 660, duration: null, deadline: '2026-10-29', attachments: [] });
    expect(occurrenceChange(template, '2026-10-29', own)).toBeNull();
    expect(occurrenceChange(template, '2026-10-29', { ...own, title: 'Standup with Ann', time: 900 })).toEqual({ title: 'Standup with Ann', time: 900, duration: null });
    expect(occurrenceChange(template, '2026-10-29', { ...own, due: '2026-10-31', deadline: null })).toEqual({ date: '2026-10-31', deadline: null });
  });

  test('made by the series: past a deleted date (which counts, as an EXDATE does); a moved one on its new date, the series going on from the one it put it on', () => {
    const skipped = series({ '2026-10-28': { skip: true } });
    const done = item({ id: 'gt1', due: '2026-10-27', completed: true });
    expect(nextOccurrence(done, keptFor(skipped, done)!)).toMatchObject({ date: '2026-10-29', index: 3 });
    expect(dueOccurrences(skipped, [done])).toMatchObject([{ date: '2026-10-29', index: 3 }]);
    // Its last occurrence deleted: the series ends with this one.
    expect(nextOccurrence(done, keptFor(series({ '2026-10-28': { skip: true } }, 'RRULE:FREQ=DAILY;COUNT=2'), done)!).date).toBeNull();
    const moved = series({ '2026-10-28': { date: '2026-10-29', deadline: '2026-10-30' }, '2026-11-02': { skip: true } });
    const repeat = keptFor(moved, done)!.repeat!;
    const next = nextOccurrence(done, keptFor(moved, done)!);
    expect(next).toMatchObject({ date: '2026-10-28', index: 2 });
    expect(occurrenceTask(repeat, template, next.date!, next.index)).toEqual({
      title: 'Daily standup',
      notes: 'Agenda',
      due: '2026-10-29',
      kept: { time: 660, duration: null, deadline: '2026-10-30', repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 2, next: null, on: '2026-10-28', template, exceptions: { '2026-11-02': { skip: true } } } },
    });
  });

  test('completed one after another: past the deleted date, the edited one with its own values, the one after it as the series has it', async () => {
    const world = tasksWorld();
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Daily standup', notes: 'Agenda', due: '2026-10-27' }, { time: 660, rule: 'RRULE:FREQ=DAILY' });
    const at = (on: string) => upcomingTasks(fake.state().googleTasks, [], '2026-10-26', '2026-11-08', '2026-10-27').find((task) => task.on === on)!;
    await store.setOccurrence(at('2026-10-28'), { skip: true });
    await store.editOccurrence(at('2026-10-30'), { title: 'Standup with Ann', notes: 'Agenda', due: '2026-10-30', kept: { time: 900, duration: null, deadline: null, rule: null } });
    // Only those two dates changed: the open task and the series are as they were, and Google has nothing new.
    expect(keptFor(fake.state(), first)).toMatchObject({ time: 660, repeat: { index: 1, on: '2026-10-27', template: { title: 'Daily standup', time: 660 }, exceptions: { '2026-10-28': { skip: true }, '2026-10-30': { title: 'Standup with Ann', time: 900, duration: null } } } });
    expect(fake.calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
    expect(seen(upcomingTasks(fake.state().googleTasks, [], '2026-10-26', '2026-11-01', '2026-10-27')).map(([on, , title]) => `${on} ${title}`)).toEqual(['2026-10-29 Daily standup', '2026-10-30 Standup with Ann', '2026-10-31 Daily standup', '2026-11-01 Daily standup']);
    const complete = async () => {
      await store.completeListTask([...world.tasks.values()].find((task) => !task.completed)!, true);
      await flush();
      const open = [...world.tasks.values()].filter((task) => !task.completed);
      expect(open).toHaveLength(1);
      return open[0]!;
    };
    const second = await complete();
    expect(second).toMatchObject({ title: 'Daily standup', notes: 'Agenda', due: '2026-10-29' });
    expect(keptFor(fake.state(), second)).toMatchObject({ time: 660, repeat: { index: 3, on: '2026-10-29', exceptions: { '2026-10-30': { title: 'Standup with Ann' } } } });
    expect(keptFor(fake.state(), second)?.repeat?.exceptions?.['2026-10-28']).toBeUndefined();
    const third = await complete();
    expect(third).toMatchObject({ title: 'Standup with Ann', due: '2026-10-30' });
    expect(keptFor(fake.state(), third)).toMatchObject({ time: 900, repeat: { index: 4, on: '2026-10-30', template: { title: 'Daily standup', time: 660 } } });
    expect(keptFor(fake.state(), third)?.repeat?.exceptions).toBeUndefined();
    const fourth = await complete();
    expect(fourth).toMatchObject({ title: 'Daily standup', due: '2026-10-31' });
    expect(keptFor(fake.state(), fourth)).toMatchObject({ time: 660, repeat: { index: 5, on: '2026-10-31' } });
    // Deleted with This task, the series passes over a deleted date the same way.
    await store.setOccurrence(at('2026-11-01'), { skip: true });
    await store.deleteListTask(fourth, 'this');
    const fifth = [...world.tasks.values()].find((task) => !task.completed)!;
    expect(fifth).toMatchObject({ title: 'Daily standup', due: '2026-11-02' });
    expect(keptFor(fake.state(), fifth)?.repeat).toMatchObject({ index: 7, on: '2026-11-02' });
  });

  test('a deleted date given back (Undo) shows again; one edited back to its series keeps nothing', async () => {
    const world = tasksWorld();
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Daily standup', notes: '', due: '2026-10-27' }, { time: 660, rule: 'RRULE:FREQ=DAILY' });
    const week = () => upcomingTasks(fake.state().googleTasks, [], '2026-10-26', '2026-11-01', '2026-10-27');
    const tomorrow = week()[0]!;
    await store.setOccurrence(tomorrow, { skip: true });
    expect(week().map((task) => task.on)).not.toContain('2026-10-28');
    await store.setOccurrence(tomorrow, null);
    expect(week()[0]).toMatchObject({ on: '2026-10-28', date: '2026-10-28' });
    await store.editOccurrence(tomorrow, { title: 'Daily standup', notes: '', due: '2026-10-28', kept: { time: 660, duration: null, deadline: null, rule: null } });
    expect(keptFor(fake.state(), first)?.repeat?.exceptions).toBeUndefined();
    // A date of its own is required: deleting is how one goes.
    await expect(store.editOccurrence(tomorrow, { title: 'Daily standup', notes: '', due: null, kept: { time: 660, duration: null, deadline: null, rule: null } })).rejects.toThrow(OCCURRENCE_KEEPS_DATE);
  });

  test('All tasks keeps the exceptions (each its own, the rest of it the series’ new values); a new rule or start keeps only those still on its schedule', async () => {
    const world = tasksWorld();
    const fake = fakeClient(emptyState(), world.answer);
    const store = new GoogleStore(host, fake.client, 'page');
    const first = await store.addListTask(ME, 'L1', { title: 'Weekly review', notes: '', due: '2026-10-27' }, { time: 660, rule: 'RRULE:FREQ=WEEKLY' });
    const shown = () => upcomingTasks(fake.state().googleTasks, [], '2026-10-26', '2026-11-30', '2026-10-27');
    await store.setOccurrence(shown().find((task) => task.on === '2026-11-03')!, { skip: true });
    await store.editOccurrence(shown().find((task) => task.on === '2026-11-10')!, { title: 'Monthly review', notes: '', due: '2026-11-10', kept: { time: 660, duration: null, deadline: null, rule: null } });
    const exceptions: Record<string, GoogleTaskException> = { '2026-11-03': { skip: true }, '2026-11-10': { title: 'Monthly review' } };
    const fields = (due: string, rule: string) => ({ title: 'Weekly sync', notes: '', due, kept: { time: 9 * 60, duration: null, deadline: null, rule } });
    // All tasks, a new title and time: the exceptions stay; the edited one keeps its title and takes the new time.
    await store.saveListTask(world.tasks.get(first.id)!, fields('2026-10-27', 'RRULE:FREQ=WEEKLY'), 'all');
    expect(keptFor(fake.state(), first)?.repeat?.exceptions).toEqual(exceptions);
    expect(seen(shown())).toEqual([
      ['2026-11-10', '2026-11-10', 'Monthly review', 540],
      ['2026-11-17', '2026-11-17', 'Weekly sync', 540],
      ['2026-11-24', '2026-11-24', 'Weekly sync', 540],
    ]);
    // A new rule both dates are still on (daily from the 27th): both stay.
    await store.saveListTask(world.tasks.get(first.id)!, fields('2026-10-27', 'RRULE:FREQ=DAILY'), 'all');
    expect(keptFor(fake.state(), first)?.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY', index: 1, exceptions });
    // Weekly again from a new start (the 28th: the 4th, the 11th…): neither date is on it any more.
    await store.saveListTask(world.tasks.get(first.id)!, fields('2026-10-28', 'RRULE:FREQ=WEEKLY'), 'all');
    expect(keptFor(fake.state(), first)?.repeat).toMatchObject({ rule: 'RRULE:FREQ=WEEKLY', on: '2026-10-28' });
    expect(keptFor(fake.state(), first)?.repeat?.exceptions).toBeUndefined();
    // This task leaves them alone.
    await store.setOccurrence(shown().find((task) => task.on === '2026-11-04')!, { skip: true });
    await store.saveListTask(world.tasks.get(first.id)!, { ...fields('2026-10-28', 'RRULE:FREQ=WEEKLY'), title: 'Just this one' }, 'this');
    expect(keptFor(fake.state(), first)?.repeat?.exceptions).toEqual({ '2026-11-04': { skip: true } });
  });

  test('what is kept for an occurrence is checked: skip alone, its own fields, by date', () => {
    const command = (exceptions: unknown) => ({ cmd: 'c1', type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'gt1', patch: { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null, on: '2026-10-27', template, exceptions } } });
    const state = emptyState();
    expect(validateCommand(command({ '2026-10-28': { skip: true }, '2026-10-29': { title: 'Standup with Ann', notes: '', date: '2026-10-30', time: 900, duration: null, deadline: null } }), state)).toBeNull();
    expect(validateCommand(command({ '2026-10-28': { skip: true, title: 'Standup' } }), state)).toBe('a skipped occurrence is skip: true alone');
    expect(validateCommand(command({ tomorrow: { skip: true } }), state)).toBe('repeat exceptions are by date');
    expect(validateCommand(command({ '2026-10-28': {} }), state)).toBe('an occurrence change needs a field');
    expect(validateCommand(command({ '2026-10-28': { color: 'red' } }), state)).toBe('an occurrence change has an unknown field');
    expect(validateCommand(command({ '2026-10-28': { time: 1440 } }), state)).toBe('an occurrence time must be minutes after midnight, or null');
    expect(validateCommand(command({ '2026-10-28': { title: ' ' } }), state)).toBe('an occurrence title must be 1-1024 characters');
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
