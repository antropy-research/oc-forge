// A repeating Google task's series, changed by the service for every window
// (review 8): two windows completing (or deleting) one occurrence at once get
// one next occurrence between them, linked to it, after a reload too and when
// Google refuses the first try; and "This and following tasks" and "All tasks"
// delete as Google Calendar does, the tasks before the chosen one staying as
// they were.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, listKey } from '../panel/lib/google.ts';
import type { PlannerClient, Snapshot } from '../panel/lib/client.ts';
import { GoogleSeries, type SeriesData } from '../service/googleSeries.ts';
import type { ExecuteResult } from '../service/planner.ts';
import { commandBody, validateCommand, type Command, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { endedBefore, keptFor, nextRepeatDate, ruleEndingBefore, seriesCut, seriesHeads, seriesNextIn, upcomingTasks } from '../src/domain/gtaskKept.ts';
import { newId } from '../src/domain/ids.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { describeRecurrence } from '../src/domain/rrule.ts';
import { emptyState, type GoogleTaskKept, type PlannerState } from '../src/domain/types.ts';

const ME = 'me@example.com';
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * One service (its plan and the series it changes) and the Google Tasks behind
 * it, for any number of windows. `hold` makes Google's next matching calls wait
 * until let go, as a slow Google does; `refuse` fails the next matching one.
 */
const service = () => {
  const google = new Map<string, GoogleTaskItem>();
  const asked: { what: 'read' | 'create' | 'update' | 'delete'; id?: string; due?: string | null }[] = [];
  let made = 0;
  let clock = Date.parse('2026-10-29T16:00:00Z');
  let held: { what: string; gate: Promise<void>; times: number } | null = null;
  let refusing: string | null = null;
  const wait = async (what: string) => {
    if (held && held.what === what && held.times > 0) {
      held.times -= 1;
      await held.gate;
    }
    if (refusing === what) {
      refusing = null;
      throw new Error('Backend Error');
    }
  };
  const data: SeriesData & { updateTask(account: string, listId: string, id: string, patch: { completed?: boolean }): Promise<GoogleTaskItem | null> } = {
    allTasks: async (_account, listId) => {
      asked.push({ what: 'read' });
      await wait('read');
      return { tasks: [...google.values()].filter((task) => task.listId === listId).map((task) => ({ ...task })), complete: true };
    },
    createTask: async (account, listId, task) => {
      asked.push({ what: 'create', due: task.due ?? null });
      await wait('create');
      const item: GoogleTaskItem = { account, listId, id: `t${++made}`, title: task.title, notes: task.notes ?? '', due: task.due ?? null, completed: false, parent: null, position: String(made).padStart(4, '0'), url: `https://tasks.google.com/task/t${made}`, updated: '' };
      google.set(item.id, item);
      return { ...item };
    },
    deleteTask: async (_account, _listId, id) => {
      asked.push({ what: 'delete', id });
      await wait('delete');
      google.delete(id);
    },
    updateTask: async (_account, _listId, id, patch) => {
      asked.push({ what: 'update', id });
      await wait('update');
      const task = google.get(id);
      if (!task) throw new Error('This task is no longer in Google Tasks');
      const next = { ...task, ...(patch.completed !== undefined ? { completed: patch.completed } : {}) };
      google.set(id, next);
      return { ...next };
    },
  };
  // The plan, as the service keeps it: an event log folded in order.
  const log: PlannerEvent[] = [];
  let state: PlannerState = emptyState();
  const planner = {
    get state() {
      return state;
    },
    execute(commands: readonly unknown[]): ExecuteResult {
      let working = state;
      const events: PlannerEvent[] = [];
      for (const [index, command] of commands.entries()) {
        const error = validateCommand(command, working);
        if (error) return { ok: false, error, index };
        clock += 1000;
        const event = { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...commandBody(command as Command) } as PlannerEvent;
        events.push(event);
        working = applyEvents(working, [event]);
      }
      log.push(...events);
      state = working;
      return { ok: true, applied: events.length };
    },
  };
  const series = new GoogleSeries(planner, data);
  const snapshot = (): Snapshot => ({ state, today: '2026-10-29', storage: { dir: '', git: false, lastCommitAt: null, lastError: null, skippedLines: 0 } });
  const enc = encodeURIComponent;
  const query = (path: string) => new URLSearchParams(path.split('?')[1] ?? '');

  /** A Planner window: its own view of the plan, which moves on only with the service's answers to it, as the panel's does. */
  const window = () => {
    let view = state;
    const notes: string[] = [];
    const client = {
      getView: () => ({ state: view, today: '2026-10-29' }),
      call: async (method: string, path: string, body?: any) => {
        if (path === '/google/tasks/next') return { ...(await series.next(body.account, body.listId, body.id)), ...snapshot() };
        if (path.startsWith('/google/tasks/series?')) return { ...(await series.remove(query(path).get('account')!, query(path).get('series')!, query(path).get('from'), query(path).get('task'))), ...snapshot() };
        if (method === 'GET' && path.startsWith('/google/tasks/all')) return data.allTasks(ME, query(path).get('list')!);
        if (method === 'POST' && path === '/google/tasks') return { task: await data.createTask(body.account, body.listId, body) };
        if (method === 'PATCH' && path === '/google/tasks') return { task: await data.updateTask(body.account, body.listId, body.id, body) };
        if (method === 'DELETE' && path.startsWith('/google/tasks?')) {
          await data.deleteTask(ME, query(path).get('list')!, query(path).get('id')!);
          return { deleted: true };
        }
        if (path === '/google/tasks/linked') return { tasks: [...google.values()].filter((task) => body.groups.some((group: { ids: string[] }) => group.ids.includes(task.id))), missing: [] };
        return {};
      },
      adopt: async (answer: Snapshot) => {
        if (answer.state.version >= view.version) view = answer.state;
      },
      dispatch: async (bodies: EventBody[]) => {
        const result = planner.execute(bodies.map((body) => ({ cmd: newId(), ...body })));
        if (!result.ok) throw new Error(result.error);
        view = state;
      },
      activity: async () => [],
      notify: (message: string) => notes.push(message),
      onCommitted: () => () => {},
    } as unknown as PlannerClient;
    return { store: new GoogleStore(host, client, 'page'), notes, view: () => view, dispatch: (bodies: EventBody[]) => client.dispatch(bodies) };
  };

  return {
    google,
    asked,
    series,
    log,
    state: () => state,
    window,
    /** Google's next `times` calls of this kind wait until `release()`. */
    hold: (what: 'read' | 'create' | 'update' | 'delete', times = 2) => {
      let release!: () => void;
      held = { what, gate: new Promise<void>((resolve) => (release = resolve)), times };
      return () => release();
    },
    refuse: (what: 'create' | 'delete' | null) => (refusing = what),
    open: (title: string) => [...google.values()].filter((task) => task.title === title && !task.completed),
    creates: () => asked.filter((call) => call.what === 'create'),
    /** The series' open tasks as kept: where it goes on from. */
    heads: (seriesId: string) => seriesHeads(state, seriesId),
  };
};

/** A daily task at 9am from `due`, added in `window`: it, and its series. */
const daily = async (world: ReturnType<typeof service>, window: ReturnType<ReturnType<typeof service>['window']>, title: string, due = '2026-10-29') => {
  const first = await window.store.addListTask(ME, 'L1', { title, notes: 'Series notes', due }, { time: 9 * 60, rule: 'RRULE:FREQ=DAILY' });
  return { first, seriesId: keptFor(world.state(), first)!.repeat!.seriesId };
};

describe('two windows complete one occurrence at once (review 8)', () => {
  test('one next occurrence between them, in Google and in the plan, linked to it; both windows show that one', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Twin');
    const b = world.window();
    await Promise.all([a.store.loadBoard(ME, 'L1'), b.store.loadBoard(ME, 'L1')]);
    // Google takes its time making the next one, so both windows ask while the first is being made.
    const release = world.hold('create');
    const both = Promise.all([a.store.completeListTask(first, true), b.store.completeListTask(first, true)]);
    await flush();
    release();
    await both;
    await flush();
    expect(world.creates()).toHaveLength(2);
    const open = world.open('Twin');
    expect(open).toHaveLength(1);
    const next = open[0]!;
    expect(next).toMatchObject({ due: '2026-10-30', notes: 'Series notes' });
    expect(keptFor(world.state(), first)?.repeat?.next).toBe(next.id);
    expect(keptFor(world.state(), next)).toMatchObject({ time: 540, repeat: { seriesId, index: 2, next: null, on: '2026-10-30' } });
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([next.id]);
    expect(Object.values(world.state().googleTasks).filter((kept) => kept.repeat?.seriesId === seriesId && kept.repeat.index === 2)).toHaveLength(1);
    for (const window of [a, b]) {
      expect(keptFor(window.view(), first)?.repeat?.next).toBe(next.id);
      expect(window.store.getView().board[listKey(ME, 'L1')]!.items.filter((task) => !task.completed).map((task) => task.id)).toEqual([next.id]);
      expect(window.notes.filter((note) => note.startsWith('Google Tasks did not take'))).toEqual([]);
    }
  });

  test('after a reload both complete the next one at once, Google refusing the first try: one more, no second series head; asked again, nothing more', async () => {
    const world = service();
    const { first, seriesId } = await daily(world, world.window(), 'Twin');
    await world.window().store.completeListTask(first, true);
    const second = world.open('Twin')[0]!;
    // Reloaded: two fresh windows from the plan as the service has it.
    const a = world.window();
    const b = world.window();
    await Promise.all([a.store.loadBoard(ME, 'L1'), b.store.loadBoard(ME, 'L1')]);
    const release = world.hold('create');
    world.refuse('create');
    const both = Promise.all([a.store.completeListTask(second, true), b.store.completeListTask(second, true)]);
    await flush();
    release();
    await both;
    await flush();
    // The task, its next one; then the first try refused, and the window that asked second made it.
    expect(world.creates().map((call) => call.due)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-10-31']);
    const third = world.open('Twin');
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ due: '2026-10-31' });
    expect(keptFor(world.state(), second)?.repeat?.next).toBe(third[0]!.id);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([third[0]!.id]);
    expect([...a.notes, ...b.notes].filter((note) => note.startsWith('Google Tasks did not take the next "Twin"'))).toHaveLength(1);
    // The window that was refused tries again (its next read), and a reload folds the log again: nothing more is made.
    await a.store.makeNextOccurrences([{ ...second, completed: true }]);
    await b.store.syncItems([{ ...second, completed: true }]);
    await world.window().store.loadBoard(ME, 'L1');
    expect(world.creates()).toHaveLength(4);
    expect(seriesHeads(foldEvents(world.log), seriesId).map((kept) => kept.taskId)).toEqual([third[0]!.id]);
  });

  test('one window deletes "This task" while the other completes it: one next occurrence, which both get', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Twin');
    const b = world.window();
    const release = world.hold('create');
    const both = Promise.all([a.store.deleteListTask(first, 'this'), b.store.completeListTask(first, true).catch(() => {})]);
    await flush();
    release();
    await both;
    await flush();
    expect(world.open('Twin').map((task) => task.due)).toEqual(['2026-10-30']);
    expect(world.heads(seriesId)).toHaveLength(1);
    expect(world.creates()).toHaveLength(2);
  });

  test('the service, asked again at once or after a stale window wrote the link away: always the one it made', async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Twin');
    await window.store.completeListTask(first, true);
    const made = world.open('Twin')[0]!;
    const answers = await Promise.all([1, 2, 3].map(() => world.series.next(ME, 'L1', first.id)));
    expect(answers.map((answer) => [answer.task?.id, answer.made])).toEqual([[made.id, false], [made.id, false], [made.id, false]]);
    // A window that read the series before it was linked writes it back whole: the one in Google is linked again, not made twice.
    const repeat = keptFor(world.state(), first)!.repeat!;
    await window.dispatch([{ type: 'gtask.kept', account: ME, listId: 'L1', taskId: first.id, patch: { repeat: { ...repeat, next: null } } }]);
    expect(await world.series.next(ME, 'L1', first.id)).toMatchObject({ task: { id: made.id }, made: false });
    expect(keptFor(world.state(), first)?.repeat?.next).toBe(made.id);
    expect(world.creates()).toHaveLength(2);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([made.id]);
  });

  test('a later occurrence is found by the date the series put it on, whatever a new rule numbered it; the earliest such, never a completed one before it', () => {
    const kept = (taskId: string, index: number, on?: string): GoogleTaskKept => ({ account: ME, listId: 'L1', taskId, time: null, duration: null, deadline: null, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index, next: null, ...(on ? { on } : {}) }, starredAt: null, updatedAt: '' });
    // A new rule numbered the open task 1 again; the completed ones before it kept 4 and 5.
    const state = { googleTasks: Object.fromEntries([kept('renumbered', 1, '2026-10-30'), kept('later', 3, '2026-10-31'), kept('done4', 4, '2026-10-27'), kept('done5', 5, '2026-10-28')].map((entry) => [`${ME}\n${entry.taskId}`, entry])) };
    const items = ['done5', 'later', 'done4', 'renumbered', 'gt1'].map((id) => ({ account: ME, listId: 'L1', id, title: 'Twin', notes: '', due: null, completed: false, parent: null, position: '', url: '', updated: '' }));
    expect(seriesNextIn(state, items, { seriesId: 's1', index: 1, on: '2026-10-29' }, 'gt1')?.id).toBe('renumbered');
    expect(seriesNextIn(state, items, { seriesId: 's1', index: 1, on: '2026-10-31' }, 'gt1')).toBeNull();
    expect(seriesNextIn(state, items, { seriesId: 's2', index: 1, on: '2026-10-29' }, 'gt1')).toBeNull();
    // Kept before those dates were: by number.
    const legacy = { googleTasks: { [`${ME}\nold3`]: kept('old3', 3) } };
    expect(seriesNextIn(legacy, [{ ...items[0]!, id: 'old3' }], { seriesId: 's1', index: 2 }, 'gt1')?.id).toBe('old3');
  });
});

describe('the next occurrence after a new rule', () => {
  test('a new rule numbers the open task from 1 again: completing it makes its next one, never taking a completed one before it for that', async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Stretch');
    await window.store.completeListTask(first, true);
    const second = world.open('Stretch')[0]!;
    await window.store.completeListTask(second, true);
    const third = world.open('Stretch')[0]!;
    expect(keptFor(world.state(), third)?.repeat?.index).toBe(3);
    // All tasks, weekly on its day from now on: its number starts again, the completed ones keep 1 and 2.
    await window.store.saveListTask(third, { title: 'Stretch', notes: 'Series notes', due: '2026-10-31', kept: { time: 540, duration: null, deadline: null, rule: 'RRULE:FREQ=WEEKLY;BYDAY=SA' } }, 'all');
    expect(keptFor(world.state(), third)?.repeat).toMatchObject({ rule: 'RRULE:FREQ=WEEKLY;BYDAY=SA', index: 1, on: '2026-10-31' });
    await window.store.completeListTask(third, true);
    const fourth = world.open('Stretch');
    expect(fourth.map((task) => task.due)).toEqual(['2026-11-07']);
    expect(keptFor(world.state(), third)?.repeat?.next).toBe(fourth[0]!.id);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([fourth[0]!.id]);
  });
});

describe('This and following tasks, All tasks (review 8)', () => {
  /** The review's series: daily from the 29th at 9am, its 31st chosen (two days ahead). */
  const reviewSeries = async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Water the plants');
    await window.store.loadBoard(ME, 'L1');
    return { world, window, first, seriesId };
  };
  const shown = (state: PlannerState, items: GoogleTaskItem[] = []) => upcomingTasks(state.googleTasks, items, '2026-10-26', '2026-11-08', '2026-10-29').map((task) => task.date);

  test('from an upcoming one two days ahead: the open task and the day before it stay as they were; it and the days after go, after a reload and once the earlier ones are done too', async () => {
    const { world, window, first, seriesId } = await reviewSeries();
    expect(shown(world.state())).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    const before = { google: { ...world.google.get(first.id)! }, kept: keptFor(world.state(), first)! };
    await window.store.deleteSeries({ account: ME, seriesId, from: '2026-10-31' });
    // Nothing in Google changed: the open task is the 29th's.
    expect(world.asked.filter((call) => call.what === 'delete')).toEqual([]);
    expect(world.google.get(first.id)).toEqual(before.google);
    const kept = keptFor(world.state(), first)!;
    expect(kept).toMatchObject({ time: 540, repeat: { ...before.kept.repeat, rule: 'RRULE:FREQ=DAILY;UNTIL=20261030' } });
    expect(describeRecurrence([kept.repeat!.rule], '2026-10-29')).toBe('Daily, until Oct 30, 2026');
    expect(shown(world.state())).toEqual(['2026-10-30']);
    expect(shown(foldEvents(world.log))).toEqual(['2026-10-30']);
    expect(keptFor(window.view(), first)?.repeat?.rule).toBe('RRULE:FREQ=DAILY;UNTIL=20261030');
    // The 29th done: the 30th is made, from the series; the 30th done: the series ends, nothing after it.
    await window.store.completeListTask(world.google.get(first.id)!, true);
    const thirtieth = world.open('Water the plants');
    expect(thirtieth.map((task) => task.due)).toEqual(['2026-10-30']);
    expect(keptFor(world.state(), thirtieth[0]!)).toMatchObject({ time: 540, repeat: { index: 2, on: '2026-10-30', rule: 'RRULE:FREQ=DAILY;UNTIL=20261030' } });
    expect(shown(world.state(), thirtieth)).toEqual([]);
    await window.store.completeListTask(thirtieth[0]!, true);
    await flush();
    expect(world.open('Water the plants')).toEqual([]);
    expect(world.creates()).toHaveLength(2);
    expect(keptFor(world.state(), thirtieth[0]!)?.repeat).toBeNull();
    expect(shown(foldEvents(world.log))).toEqual([]);
  });

  test('changes kept for later dates go with them; a COUNT that ends sooner stays; a later UNTIL is brought forward', () => {
    expect(ruleEndingBefore('RRULE:FREQ=DAILY', '2026-10-31')).toBe('RRULE:FREQ=DAILY;UNTIL=20261030');
    expect(ruleEndingBefore('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231', '2026-11-09')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261108');
    expect(ruleEndingBefore('RRULE:FREQ=DAILY;UNTIL=20261029', '2026-10-31')).toBe('RRULE:FREQ=DAILY;UNTIL=20261029');
    // Ten from the 27th reach the 31st: they end the day before it. Two from the 27th end on the 28th anyway.
    expect(ruleEndingBefore('RRULE:FREQ=DAILY;COUNT=10', '2026-10-31', '2026-10-27', 1)).toBe('RRULE:FREQ=DAILY;UNTIL=20261030');
    expect(ruleEndingBefore('RRULE:FREQ=DAILY;COUNT=2', '2026-10-31', '2026-10-27', 1)).toBe('RRULE:FREQ=DAILY;COUNT=2');
    expect(nextRepeatDate('RRULE:FREQ=DAILY;UNTIL=20261030', '2026-10-30', 2)).toBeNull();
    const repeat = { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index: 1, next: null, on: '2026-10-29', exceptions: { '2026-10-30': { title: 'Water the roses' }, '2026-10-31': { skip: true as const }, '2026-11-02': { time: 600, duration: null } } };
    expect(endedBefore(repeat, '2026-10-31')).toEqual({ ...repeat, rule: 'RRULE:FREQ=DAILY;UNTIL=20261030', exceptions: { '2026-10-30': { title: 'Water the roses' } } });
    expect(endedBefore(repeat, '2026-10-30').exceptions).toBeUndefined();
  });

  test('what each choice takes: from an upcoming date nothing in Google; from a task, it and its later ones; All tasks every one, the open ones first', () => {
    const kept = (taskId: string, on: string, index: number, next: string | null): GoogleTaskKept => ({ account: ME, listId: 'L1', taskId, time: 540, duration: null, deadline: null, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's1', index, next, on }, starredAt: null, updatedAt: '' });
    const plan = { a: kept('a', '2026-10-27', 1, 'b'), b: kept('b', '2026-10-28', 2, 'c'), c: kept('c', '2026-10-29', 3, null), other: { ...kept('x', '2026-10-29', 1, null), repeat: { ...kept('x', '2026-10-29', 1, null).repeat!, seriesId: 's2' } } };
    const byKey = Object.fromEntries(Object.values(plan).map((entry) => [`${ME}\n${entry.taskId}`, entry]));
    const upcoming = seriesCut(byKey, ME, 's1', '2026-10-31');
    expect(upcoming.remove).toEqual([]);
    expect(upcoming.keep.map((body) => [(body as { taskId: string }).taskId, (body as { patch: { repeat: { rule: string } } }).patch.repeat.rule])).toEqual([['a', 'RRULE:FREQ=DAILY;UNTIL=20261030'], ['b', 'RRULE:FREQ=DAILY;UNTIL=20261030'], ['c', 'RRULE:FREQ=DAILY;UNTIL=20261030']]);
    const fromDone = seriesCut(byKey, ME, 's1', '2026-10-28', 'b');
    expect(fromDone.remove.map((entry) => entry.taskId)).toEqual(['c', 'b']);
    expect(fromDone.keep.map((body) => (body as { taskId: string }).taskId)).toEqual(['a']);
    const all = seriesCut(byKey, ME, 's1', null);
    expect(all.remove.map((entry) => entry.taskId)).toEqual(['c', 'b', 'a']);
    expect(all.keep).toEqual([]);
    // A series kept before its dates were: the task asked from goes, by its id.
    const legacy = { ...plan.c, repeat: { ...plan.c.repeat!, on: undefined } };
    expect(seriesCut({ [`${ME}\nc`]: legacy }, ME, 's1', '2026-10-29', 'c').remove.map((entry) => entry.taskId)).toEqual(['c']);
  });

  test('from the open task: it goes in Google, the completed ones before it stay, ended the day before; nothing repeats', async () => {
    const { world, window, first, seriesId } = await reviewSeries();
    await window.store.completeListTask(first, true);
    const open = world.open('Water the plants')[0]!;
    await window.store.loadBoard(ME, 'L1');
    await window.store.deleteListTask(world.google.get(open.id)!, 'following');
    expect(world.google.has(open.id)).toBe(false);
    expect(world.google.get(first.id)).toMatchObject({ completed: true });
    expect(keptFor(world.state(), open)).toBeNull();
    expect(keptFor(world.state(), first)?.repeat).toMatchObject({ seriesId, next: open.id, rule: 'RRULE:FREQ=DAILY;UNTIL=20261029' });
    expect(world.heads(seriesId)).toEqual([]);
    expect(shown(world.state())).toEqual([]);
    expect(window.store.getView().board[listKey(ME, 'L1')]!.items.map((task) => task.id)).toEqual([first.id]);
  });

  test('All tasks from an upcoming one: the open task and the completed ones go in Google, nothing is kept or shown', async () => {
    const { world, window, first, seriesId } = await reviewSeries();
    await window.store.completeListTask(first, true);
    const second = world.open('Water the plants')[0]!;
    await window.store.completeListTask(second, true);
    const third = world.open('Water the plants')[0]!;
    await window.store.loadBoard(ME, 'L1');
    await window.store.deleteSeries({ account: ME, seriesId, from: null });
    await world.series.settled();
    expect([...world.google.values()].filter((task) => task.title === 'Water the plants')).toEqual([]);
    expect(world.asked.filter((call) => call.what === 'delete').map((call) => call.id)).toEqual([third.id, second.id, first.id]);
    expect(Object.values(world.state().googleTasks).filter((kept) => kept.repeat?.seriesId === seriesId)).toEqual([]);
    expect(shown(world.state())).toEqual([]);
    expect(window.store.getView().board[listKey(ME, 'L1')]!.items).toEqual([]);
  });

  test('a delete Google refuses changes nothing: the task, its series and what the Tasks view shows stay', async () => {
    const { world, window, first, seriesId } = await reviewSeries();
    const before = keptFor(world.state(), first);
    world.refuse('delete');
    await expect(window.store.deleteListTask(world.google.get(first.id)!, 'following')).rejects.toThrow('Backend Error');
    expect(world.google.has(first.id)).toBe(true);
    expect(keptFor(world.state(), first)).toEqual(before);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([first.id]);
    expect(window.store.getView().board[listKey(ME, 'L1')]!.items.map((task) => task.id)).toEqual([first.id]);
    // Asked again with Google answering: it goes.
    await window.store.deleteListTask(world.google.get(first.id)!, 'following');
    expect(world.google.has(first.id)).toBe(false);
    expect(world.heads(seriesId)).toEqual([]);
  });

  test('two windows: one ends the series at the 31st while the other is making the 30th; the 30th stays, nothing after it', async () => {
    const { world, window: a, first, seriesId } = await reviewSeries();
    const b = world.window();
    const release = world.hold('create', 1);
    const completing = b.store.completeListTask(first, true);
    // The 30th is being made, the series' change under way; the other window ends the series meanwhile.
    await flush();
    const cutting = a.store.deleteSeries({ account: ME, seriesId, from: '2026-10-31' });
    await flush();
    release();
    await Promise.all([completing, cutting]);
    await flush();
    const open = world.open('Water the plants');
    expect(open.map((task) => task.due)).toEqual(['2026-10-30']);
    expect(keptFor(world.state(), open[0]!)?.repeat?.rule).toBe('RRULE:FREQ=DAILY;UNTIL=20261030');
    expect(keptFor(world.state(), first)?.repeat?.next).toBe(open[0]!.id);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([open[0]!.id]);
    expect(shown(world.state(), open)).toEqual([]);
  });
});
