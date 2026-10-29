// A repeating Google task's series, changed by the service for every window
// (review 8): two windows completing (or deleting) one occurrence at once get
// one next occurrence between them, linked to it, after a reload too and when
// Google refuses the first try; and "This and following tasks" and "All tasks"
// delete as Google Calendar does, the tasks before the chosen one staying as
// they were.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, listKey, type TaskFields } from '../panel/lib/google.ts';
import type { PlannerClient, Snapshot } from '../panel/lib/client.ts';
import { GoogleError } from '../service/google.ts';
import { GoogleSeries, type SeriesData } from '../service/googleSeries.ts';
import type { ExecuteResult } from '../service/planner.ts';
import { commandBody, validateCommand, type Command, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { endedBefore, keptFor, mergeOccurrence, nextRepeatDate, occurrenceIndex, ruleEndingBefore, seriesCut, seriesHeads, seriesNextIn, upcomingTasks, upcomingValues } from '../src/domain/gtaskKept.ts';
import { newId } from '../src/domain/ids.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { describeRecurrence } from '../src/domain/rrule.ts';
import { emptyState, type GoogleTaskKept, type PlannerState, type TaskAttachment } from '../src/domain/types.ts';

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
  // What Google deleted lately, which it gives back on "deleted: false" (Undo).
  const trash = new Map<string, GoogleTaskItem>();
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
  const data: SeriesData = {
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
      const task = google.get(id);
      if (!task) throw new GoogleError(404, 'This task is no longer in Google Tasks');
      trash.set(id, task);
      google.delete(id);
    },
    updateTask: async (_account, _listId, id, patch) => {
      asked.push({ what: 'update', id, ...(patch.due !== undefined ? { due: patch.due } : {}) });
      await wait('update');
      const { deleted, ...fields } = patch;
      if (deleted === false && trash.has(id)) {
        google.set(id, trash.get(id)!);
        trash.delete(id);
      }
      const task = google.get(id);
      if (!task) throw new GoogleError(404, 'This task is no longer in Google Tasks');
      const next = { ...task, ...fields };
      google.set(id, next);
      return { ...next };
    },
    // Google's other lists: what moved there in Google's own apps.
    locateTasks: async (_account, ids, except) => [...google.values()].filter((task) => ids.includes(task.id) && task.listId !== except).map((task) => ({ ...task })),
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
    const calls: { method: string; path: string; body?: any }[] = [];
    const client = {
      getView: () => ({ state: view, today: '2026-10-29' }),
      call: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        if (path === '/google/tasks/next') return { ...(await series.next(body.account, body.listId, body.id, { completed: body.completed, due: body.due })), ...snapshot() };
        if (path.startsWith('/google/tasks/series?')) return { ...(await series.remove(query(path).get('account')!, query(path).get('series')!, query(path).get('from'), query(path).get('task'))), ...snapshot() };
        if (path === '/google/tasks/occurrence') {
          await series.occurrence(body.account, body.seriesId, body.on, body.skip ? { skip: true } : 'restore' in body ? { restore: body.restore } : { before: body.before, after: body.after });
          return snapshot();
        }
        if (path === '/google/tasks/series/edit') {
          await series.edit(body.account, body.listId, body.taskId, body.seriesId, body.own, body.before, body.after);
          return snapshot();
        }
        if (path === '/google/tasks/gone') {
          await series.gone(body.account, body.listId, body.id);
          return snapshot();
        }
        if (path === '/google/tasks/series/undo') return { ...(await series.undo(body.account, body.seriesId, body.kind === 'one' ? { kind: 'one', task: body.task, made: body.made } : { kind: 'cut', from: body.from, deleted: body.deleted, before: body.before })), ...snapshot() };
        if (path === '/google/tasks/uncomplete') return { ...(await series.uncomplete(body.account, body.listId, body.id, { before: body.before, made: body.made })), ...snapshot() };
        if (method === 'GET' && path.startsWith('/google/tasks/all')) return data.allTasks(ME, query(path).get('list')!);
        if (method === 'POST' && path === '/google/tasks') return { task: await data.createTask(body.account, body.listId, body) };
        if (method === 'PATCH' && path === '/google/tasks') {
          const { account: _account, listId: _list, id: _id, ...patch } = body;
          return { task: await data.updateTask(body.account, body.listId, body.id, patch) };
        }
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
    return { store: new GoogleStore(host, client, 'page'), notes, calls, view: () => view, dispatch: (bodies: EventBody[]) => client.dispatch(bodies) };
  };

  return {
    google,
    trash,
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
    refuse: (what: 'create' | 'delete' | 'update' | null) => (refusing = what),
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

/** A series' upcoming task on `date`, as a window shows it. */
const upcomingOn = (state: PlannerState, date: string) => upcomingTasks(state.googleTasks, [], date, date, '2026-10-29')[0]!;
/** A task form's values: these title and time, the rest as given. */
const form = (title: string, due: string, time: number | null, extra: Partial<{ notes: string; deadline: string | null; rule: string | null }> = {}) => ({
  title,
  notes: extra.notes ?? 'Series notes',
  due,
  kept: { time, duration: null, deadline: extra.deadline ?? null, rule: extra.rule === undefined ? null : extra.rule },
});
const openTask = (world: ReturnType<typeof service>) => [...world.google.values()].filter((task) => !task.completed);

describe('a change to a series while another window makes its next task (review 9)', () => {
  test('tomorrow edited alone in one window while another completes today, Google slow to make the next one: the edit is kept, the next task has it, after a reload too', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Race');
    const b = world.window();
    const tomorrow = upcomingOn(b.view(), '2026-10-30');
    const release = world.hold('create', 1);
    const completing = a.store.completeListTask(first, true);
    // Google is making tomorrow's while the other window saves its edit of it.
    await flush();
    const editing = b.store.editOccurrence(tomorrow, form('Race with Ann', '2026-10-30', 900));
    await flush();
    release();
    await Promise.all([completing, editing]);
    const next = openTask(world);
    expect(next.map((task) => [task.title, task.due])).toEqual([['Race with Ann', '2026-10-30']]);
    expect(keptFor(world.state(), next[0]!)).toMatchObject({ time: 900, repeat: { seriesId, index: 2, on: '2026-10-30', next: null, template: { title: 'Race', time: 540 } } });
    expect(keptFor(world.state(), first)?.repeat?.next).toBe(next[0]!.id);
    expect(keptFor(foldEvents(world.log), next[0]!)).toMatchObject({ time: 900 });
    expect(world.creates()).toHaveLength(2);
    // The day after is the series' own again.
    expect(upcomingOn(world.state(), '2026-10-31')).toMatchObject({ on: '2026-10-31', template: { title: 'Race', time: 540 } });
    expect(upcomingOn(world.state(), '2026-10-31').change).toBeUndefined();
  });

  test('a change kept past the lock while Google makes the next task (a window not reloaded since an update, a sync): the next task is made as the series is then, in Google too', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Race');
    const release = world.hold('create', 1);
    const completing = a.store.completeListTask(first, true);
    await flush();
    // Written as commands, as an older panel writes it: tomorrow at 3pm with its own title.
    const head = keptFor(world.state(), first)!;
    await a.dispatch([{ type: 'gtask.kept', account: ME, listId: 'L1', taskId: first.id, patch: { repeat: { ...head.repeat!, exceptions: { '2026-10-30': { title: 'Race with Ann', time: 900, duration: null } } } } }]);
    release();
    await completing;
    const next = openTask(world);
    expect(next.map((task) => [task.title, task.due])).toEqual([['Race with Ann', '2026-10-30']]);
    expect(keptFor(world.state(), next[0]!)).toMatchObject({ time: 900, repeat: { on: '2026-10-30' } });
    // The link went onto the series as it was then: its change stays with it.
    expect(keptFor(world.state(), first)?.repeat).toMatchObject({ next: next[0]!.id, exceptions: { '2026-10-30': { title: 'Race with Ann' } } });
    expect(world.asked.filter((call) => call.what === 'update' && call.id === next[0]!.id)).toHaveLength(1);
  });

  test('all tasks edited in one window while another completes the open one, Google slow: the next task is made, then takes the new title and time; the series has them, after a reload too', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Race');
    const b = world.window();
    const release = world.hold('create', 1);
    const completing = a.store.completeListTask(first, true);
    await flush();
    const editing = b.store.saveListTask(first, form('Race daily', '2026-10-29', 900, { rule: 'RRULE:FREQ=DAILY' }), 'all');
    await flush();
    release();
    await Promise.all([completing, editing]);
    const next = openTask(world);
    expect(next.map((task) => [task.title, task.due])).toEqual([['Race daily', '2026-10-30']]);
    expect(keptFor(world.state(), next[0]!)).toMatchObject({ time: 900, repeat: { seriesId, on: '2026-10-30', template: { title: 'Race daily', time: 900, start: '2026-10-29' } } });
    expect(keptFor(foldEvents(world.log), next[0]!)?.repeat?.template).toMatchObject({ title: 'Race daily', time: 900 });
    expect(world.creates()).toHaveLength(2);
    // The one after it comes from the new template.
    await a.store.completeListTask(next[0]!, true);
    expect(openTask(world).map((task) => [task.title, task.due])).toEqual([['Race daily', '2026-10-31']]);
    expect(keptFor(world.state(), openTask(world)[0]!)).toMatchObject({ time: 900 });
  });

  test('an edit of all tasks that arrives first is what the next task is made with', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Race');
    const b = world.window();
    await b.store.saveListTask(first, form('Race daily', '2026-10-29', 900, { rule: 'RRULE:FREQ=DAILY' }), 'all');
    // A's view is from before the edit; the service makes the next one from the series as it is.
    await a.store.completeListTask(first, true);
    expect(openTask(world).map((task) => [task.title, task.due])).toEqual([['Race daily', '2026-10-30']]);
    expect(keptFor(world.state(), openTask(world)[0]!)).toMatchObject({ time: 900 });
  });
});

describe('an occurrence told by the date its series puts it on (review 9)', () => {
  const template = { title: 'Pair', notes: '', time: 540, duration: null, deadline: null, start: '2026-10-25' };
  test('the number a series gives a date, counting one deleted on its own; none off its schedule, at or before its open task, or past its end', () => {
    const repeat = { rule: 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261106', seriesId: 's', index: 3, next: null, on: '2026-10-29', template, exceptions: { '2026-10-31': { skip: true as const } } };
    expect(['2026-10-31', '2026-11-02', '2026-11-06'].map((date) => occurrenceIndex(repeat, date))).toEqual([4, 5, 7]);
    expect(['2026-10-30', '2026-10-29', '2026-10-27', '2026-11-08'].map((date) => occurrenceIndex(repeat, date))).toEqual([null, null, null, null]);
  });

  test('an edit of one occurrence goes over it as it is now, field by field; a time goes with its length', () => {
    const before = { title: 'Pair', notes: '', due: '2026-10-31', time: 540, duration: null, deadline: null };
    // Meanwhile another window gave it a title, 3pm for half an hour, and a deadline.
    const latest = { title: 'Pair with Ann', notes: '', due: '2026-10-31', time: 900, duration: 30, deadline: '2026-11-01' };
    expect(mergeOccurrence(latest, before, { ...before, notes: 'Bring the slides' })).toEqual({ ...latest, notes: 'Bring the slides' });
    expect(mergeOccurrence(latest, before, { ...before, time: 600 })).toEqual({ ...latest, time: 600, duration: null });
    expect(mergeOccurrence(latest, before, { ...before, title: 'Pair with Bo', due: '2026-11-01' })).toEqual({ ...latest, title: 'Pair with Bo', due: '2026-11-01' });
  });
});

describe('one occurrence, two windows, and a cut (review 9 audit)', () => {
  test('an upcoming task the series has made meanwhile, its title alone edited: Google has it, and its kept entry is written again, so every window reads it again', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Made');
    const b = world.window();
    const shown = upcomingOn(b.view(), '2026-10-30');
    await a.store.completeListTask(first, true);
    const made = openTask(world)[0]!;
    const before = keptFor(world.state(), made)!;
    await b.store.editOccurrence(shown, form('Made with Ann', '2026-10-30', 540));
    expect(world.google.get(made.id)?.title).toBe('Made with Ann');
    const after = keptFor(world.state(), made)!;
    expect(after).toMatchObject({ time: 540, repeat: before.repeat! });
    expect(after.updatedAt > before.updatedAt).toBe(true);
  });

  test('a new rule saved in a window that never saw two upcoming tasks edited alone: the edit still on its schedule stays, the one on a day it no longer makes goes', async () => {
    const world = service();
    const a = world.window();
    // Thursday, October 29.
    const { first } = await daily(world, a, 'Gym');
    const b = world.window();
    await a.store.editOccurrence(upcomingOn(a.view(), '2026-10-30'), form('Gym with Ann', '2026-10-30', 900));
    await a.store.editOccurrence(upcomingOn(a.view(), '2026-10-31'), form('Gym on Saturday', '2026-10-31', 600));
    expect(Object.keys(keptFor(b.view(), first)?.repeat?.exceptions ?? {})).toEqual([]);
    await b.store.saveListTask(first, form('Gym', '2026-10-29', 540, { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }), 'all');
    const repeat = keptFor(world.state(), first)!.repeat!;
    expect(repeat.rule).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(repeat.exceptions).toEqual({ '2026-10-30': { title: 'Gym with Ann', time: 900, duration: null } });
    expect(upcomingTasks(world.state().googleTasks, [], '2026-10-30', '2026-11-03', '2026-10-29').map((task) => [task.on, task.change?.title ?? null])).toEqual([
      ['2026-10-30', 'Gym with Ann'],
      ['2026-11-02', null],
      ['2026-11-03', null],
    ]);
    // The first window still shows Saturday: its edit of a day the rule no longer makes is refused, not kept where nothing shows it.
    await expect(a.store.editOccurrence(upcomingOn(a.view(), '2026-10-31'), form('Gym on Saturday at 11', '2026-10-31', 660))).rejects.toThrow('This task is no longer in its series');
    expect(Object.keys(keptFor(world.state(), first)!.repeat!.exceptions ?? {})).toEqual(['2026-10-30']);
  });

  test('two windows edit the same upcoming task: what each changed is kept; the same field, the last one', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Pair');
    const b = world.window();
    const shownA = upcomingOn(a.view(), '2026-10-31');
    const shownB = upcomingOn(b.view(), '2026-10-31');
    await a.store.editOccurrence(shownA, form('Pair with Ann', '2026-10-31', 540));
    await b.store.editOccurrence(shownB, form('Pair', '2026-10-31', 900));
    expect(keptFor(world.state(), first)?.repeat?.exceptions).toEqual({ '2026-10-31': { title: 'Pair with Ann', time: 900, duration: null } });
    await b.store.editOccurrence(shownB, form('Pair with Bo', '2026-10-31', 540));
    expect(keptFor(world.state(), first)?.repeat?.exceptions?.['2026-10-31']).toEqual({ title: 'Pair with Bo', time: 900, duration: null });
  });

  test('an upcoming task deleted alone, then edited from a window that still shows it: refused, it stays deleted', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Pair');
    const b = world.window();
    const shown = upcomingOn(b.view(), '2026-10-31');
    await a.store.setOccurrence(upcomingOn(a.view(), '2026-10-31'), { skip: true });
    await expect(b.store.editOccurrence(shown, form('Pair with Ann', '2026-10-31', 900))).rejects.toThrow('This task was deleted meanwhile');
    expect(keptFor(world.state(), first)?.repeat?.exceptions).toEqual({ '2026-10-31': { skip: true } });
  });

  test('while "This and following tasks" deletes the open task in Google, an edit of an upcoming task it takes waits for it and is refused, never accepted and then lost', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Cut');
    await a.store.completeListTask(first, true);
    const head = openTask(world)[0]!;
    const b = world.window();
    const shown = upcomingOn(b.view(), '2026-10-31');
    const release = world.hold('delete', 1);
    const cutting = a.store.deleteListTask(head, 'following');
    await flush();
    const editing = b.store.editOccurrence(shown, form('Cut late', '2026-10-31', 900)).then(
      () => 'accepted',
      (error: Error) => error.message,
    );
    await flush();
    // It waits for the cut: nothing of it is kept meanwhile.
    expect(keptFor(world.state(), head)?.repeat?.exceptions).toBeUndefined();
    release();
    await cutting;
    expect(await editing).toBe('This task is no longer in its series');
    expect(world.google.has(head.id)).toBe(false);
    expect(world.heads(seriesId)).toEqual([]);
    expect(upcomingTasks(world.state().googleTasks, [], '2026-10-29', '2026-11-05', '2026-10-29')).toEqual([]);
  });

  test('after "This and following tasks": an upcoming task it took is refused, one before it kept, and All tasks saved in a window that still shows the series without its end keeps the end', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Cut');
    const b = world.window();
    // Opened before the cut and not reloaded since.
    const c = world.window();
    const later = upcomingOn(b.view(), '2026-11-01');
    const earlier = upcomingOn(b.view(), '2026-10-30');
    await a.store.deleteSeries({ account: ME, seriesId, from: '2026-10-31' });
    await expect(b.store.editOccurrence(later, form('Cut late', '2026-11-01', 900))).rejects.toThrow('This task is no longer in its series');
    await b.store.editOccurrence(earlier, form('Cut early', '2026-10-30', 900));
    expect(keptFor(world.state(), first)?.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY;UNTIL=20261030', exceptions: { '2026-10-30': { title: 'Cut early', time: 900, duration: null } } });
    expect(keptFor(c.view(), first)?.repeat?.rule).toBe('RRULE:FREQ=DAILY');
    await c.store.saveListTask(first, form('Cut', '2026-10-29', 600, { rule: 'RRULE:FREQ=DAILY' }), 'all');
    expect(keptFor(world.state(), first)).toMatchObject({ time: 600, repeat: { rule: 'RRULE:FREQ=DAILY;UNTIL=20261030', template: { time: 600 }, exceptions: { '2026-10-30': { title: 'Cut early', time: 900 } } } });
    expect(upcomingTasks(world.state().googleTasks, [], '2026-10-29', '2026-11-05', '2026-10-29').map((task) => task.on)).toEqual(['2026-10-30']);
  });

  test('an upcoming task the series has made meanwhile (a window still shows it upcoming): edited alone, the task in Google changes; deleted alone, its next one is made first', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Made');
    const b = world.window();
    const shown = upcomingOn(b.view(), '2026-10-30');
    await a.store.completeListTask(first, true);
    const made = openTask(world)[0]!;
    await b.store.editOccurrence(shown, form('Made with Ann', '2026-10-30', 900));
    expect(world.google.get(made.id)).toMatchObject({ title: 'Made with Ann', due: '2026-10-30' });
    expect(keptFor(world.state(), made)).toMatchObject({ time: 900, repeat: { on: '2026-10-30', next: null } });
    await b.store.setOccurrence(shown, { skip: true });
    expect(world.google.has(made.id)).toBe(false);
    expect(openTask(world).map((task) => [task.title, task.due])).toEqual([['Made', '2026-10-31']]);
  });
});

describe('an occurrence moved onto another one, and its task gone from Google (review 9)', () => {
  test('today moved alone to tomorrow at 1pm: tomorrow shows it and its own 9am; completing either leaves the other as it is, after a reload too', async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Water');
    await window.store.saveListTask(first, form('Water', '2026-10-30', 780, { rule: 'RRULE:FREQ=DAILY' }), 'this');
    const moved = world.google.get(first.id)!;
    expect(moved.due).toBe('2026-10-30');
    expect(keptFor(world.state(), first)).toMatchObject({ time: 780, repeat: { on: '2026-10-29', template: { time: 540 } } });
    const shownTomorrow = (state: PlannerState, items: GoogleTaskItem[]) => upcomingTasks(state.googleTasks, items, '2026-10-30', '2026-10-30', '2026-10-29').map((task) => [task.on, task.date]);
    expect(shownTomorrow(world.state(), [moved])).toEqual([['2026-10-30', '2026-10-30']]);
    expect(shownTomorrow(foldEvents(world.log), [moved])).toEqual([['2026-10-30', '2026-10-30']]);
    // Moved again in Google's own apps (the day after): still today's occurrence, wherever it shows; tomorrow and the day after keep theirs.
    expect(upcomingTasks(world.state().googleTasks, [{ ...moved, due: '2026-10-31' }], '2026-10-30', '2026-10-31', '2026-10-29').map((task) => task.on)).toEqual(['2026-10-30', '2026-10-31']);
    // The moved one done: tomorrow's own is made, at 9am, beside it.
    await window.store.completeListTask(moved, true);
    const own = openTask(world);
    expect(own.map((task) => task.due)).toEqual(['2026-10-30']);
    expect(keptFor(world.state(), own[0]!)).toMatchObject({ time: 540, repeat: { on: '2026-10-30', index: 2 } });
    expect(world.google.get(first.id)).toMatchObject({ completed: true, due: '2026-10-30' });
    expect(keptFor(world.state(), first)?.time).toBe(780);
    // Tomorrow's own done: the day after's, and the moved one stays as it was.
    await window.store.completeListTask(own[0]!, true);
    expect(openTask(world).map((task) => task.due)).toEqual(['2026-10-31']);
    expect(world.creates()).toHaveLength(3);
    expect(world.heads(seriesId)).toHaveLength(1);
  });

  test('moved alone past tomorrow, then deleted alone: tomorrow’s own is made first, once', async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Water');
    await window.store.saveListTask(first, form('Water', '2026-10-31', 780, { rule: 'RRULE:FREQ=DAILY' }), 'this');
    // Moved past tomorrow: deleting it alone makes tomorrow's (its next by the series) first.
    await window.store.deleteListTask(world.google.get(first.id)!, 'this');
    expect(openTask(world).map((task) => task.due)).toEqual(['2026-10-30']);
    expect(keptFor(world.state(), openTask(world)[0]!)).toMatchObject({ time: 540, repeat: { on: '2026-10-30' } });
    expect(world.heads(seriesId)).toHaveLength(1);
  });

  test('its open task deleted in Google’s own apps: a read of its list makes the next one (as This task) instead of showing upcoming tasks after a task Google no longer has; one moved to another list there is followed', async () => {
    const world = service();
    const window = world.window();
    const { first, seriesId } = await daily(world, window, 'Gone');
    world.google.delete(first.id);
    await window.store.loadBoard(ME, 'L1');
    await world.series.settled();
    expect(openTask(world).map((task) => [task.title, task.due])).toEqual([['Gone', '2026-10-30']]);
    expect(keptFor(world.state(), first)).toBeNull();
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([openTask(world)[0]!.id]);
    // Moved to another list there: the series goes with it, nothing is made.
    const next = openTask(world)[0]!;
    world.google.set(next.id, { ...next, listId: 'L2' });
    await window.store.loadBoard(ME, 'L1');
    await world.series.settled();
    expect(keptFor(world.state(), next)).toMatchObject({ listId: 'L2', repeat: { seriesId, next: null } });
    expect(world.creates()).toHaveLength(2);
  });
});


const RED = '#d50000';
const doc = (id: string, title: string): TaskAttachment => ({ id, title, mimeType: 'application/vnd.google-apps.document', url: `https://docs.google.com/document/d/${id}/edit` });
/** A task form's values with the advanced settings given (left out: as they are), repeating daily. */
const formWith = (title: string, due: string, time: number | null, extra: Partial<TaskFields['kept']> = {}): TaskFields => ({
  title,
  notes: 'Series notes',
  due,
  kept: { time, duration: null, deadline: null, rule: 'RRULE:FREQ=DAILY', ...extra },
});
const ADVANCED = { busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new' as const, message: 'Heads down' }, attachments: [doc('a1', 'Plan')] };

describe("round 10's fields through the series (merge)", () => {
  test('All tasks: color, Do not disturb, declining and attachments go to the series and its open task; a window that never saw them, saving All tasks, leaves them; the next task has them', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Focus');
    const b = world.window();
    await a.store.saveListTask(first, formWith('Focus', '2026-10-29', 540, ADVANCED), 'all');
    const head = keptFor(world.state(), first)!;
    expect(head).toMatchObject({ busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')] });
    expect(head.repeat!.template).toMatchObject({ busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')] });
    // B's view is from before: its form has none of them, and it changes the title alone.
    await b.store.saveListTask(first, formWith('Focus time', '2026-10-29', 540, { busy: false, color: null, doNotDisturb: false, decline: null, attachments: [] }), 'all');
    expect(keptFor(world.state(), first)!.repeat!.template).toMatchObject({ title: 'Focus time', busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new' }, attachments: [doc('a1', 'Plan')] });
    expect(keptFor(world.state(), first)).toMatchObject({ busy: true, color: RED, doNotDisturb: true, attachments: [doc('a1', 'Plan')] });
    await a.store.completeListTask(world.google.get(first.id)!, true);
    const next = openTask(world)[0]!;
    expect(next.title).toBe('Focus time');
    expect(keptFor(world.state(), next)).toMatchObject({ time: 540, busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')], repeat: { seriesId, on: '2026-10-30' } });
  });

  test('All tasks with a color and an attachment saved while another window completes the task and Google is slow to make the next: the next task takes them', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Sync');
    const b = world.window();
    const release = world.hold('create', 1);
    const completing = a.store.completeListTask(first, true);
    await flush();
    const editing = b.store.saveListTask(first, formWith('Sync', '2026-10-29', 540, { color: RED, attachments: [doc('a2', 'Agenda')] }), 'all');
    await flush();
    release();
    await Promise.all([completing, editing]);
    const next = openTask(world)[0]!;
    expect(keptFor(world.state(), next)).toMatchObject({ color: RED, attachments: [doc('a2', 'Agenda')], repeat: { template: { color: RED, attachments: [doc('a2', 'Agenda')] } } });
    expect(world.creates()).toHaveLength(2);
  });

  test('This task on an upcoming task attaches files to it alone, merged over another window\'s change of its title; the series makes it with them, and the next ones with the series\' own; none ([]) is kept as none', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Review');
    await a.store.saveListTask(first, formWith('Review', '2026-10-29', 540, { attachments: [doc('s1', 'Series doc')] }), 'all');
    const b = world.window();
    const shownA = upcomingOn(a.view(), '2026-10-30');
    const shownB = upcomingOn(b.view(), '2026-10-30');
    expect(upcomingValues(shownA).attachments).toEqual([doc('s1', 'Series doc')]);
    await b.store.editOccurrence(shownB, { ...form('Review with Ann', '2026-10-30', 540), kept: { ...form('Review with Ann', '2026-10-30', 540).kept, attachments: [doc('s1', 'Series doc')] } });
    await a.store.editOccurrence(shownA, { ...form('Review', '2026-10-30', 540), kept: { ...form('Review', '2026-10-30', 540).kept, attachments: [doc('s1', 'Series doc'), doc('o1', 'Notes for Ann')] } });
    expect(keptFor(world.state(), first)!.repeat!.exceptions!['2026-10-30']).toEqual({ title: 'Review with Ann', attachments: [doc('s1', 'Series doc'), doc('o1', 'Notes for Ann')] });
    // The day after: no attachments at all, on its own.
    await a.store.editOccurrence(upcomingOn(a.view(), '2026-10-31'), { ...form('Review', '2026-10-31', 540), kept: { ...form('Review', '2026-10-31', 540).kept, attachments: [] } });
    expect(keptFor(world.state(), first)!.repeat!.exceptions!['2026-10-31']).toEqual({ attachments: [] });
    await a.store.completeListTask(world.google.get(first.id)!, true);
    const second = openTask(world)[0]!;
    expect(second.title).toBe('Review with Ann');
    expect(keptFor(world.state(), second)!.attachments).toEqual([doc('s1', 'Series doc'), doc('o1', 'Notes for Ann')]);
    await a.store.completeListTask(second, true);
    const third = openTask(world)[0]!;
    expect(third.due).toBe('2026-10-31');
    expect(keptFor(world.state(), third)!.attachments).toBeUndefined();
    expect(upcomingValues(upcomingOn(world.state(), '2026-11-01')).attachments).toEqual([doc('s1', 'Series doc')]);
  });

  test('an upcoming task the series has made meanwhile, its attachments edited alone: the task takes them', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Made');
    const b = world.window();
    const shown = upcomingOn(b.view(), '2026-10-30');
    await a.store.completeListTask(first, true);
    const made = openTask(world)[0]!;
    await b.store.editOccurrence(shown, { ...form('Made', '2026-10-30', 540), kept: { ...form('Made', '2026-10-30', 540).kept, attachments: [doc('m1', 'Minutes')] } });
    expect(keptFor(world.state(), made)).toMatchObject({ attachments: [doc('m1', 'Minutes')], repeat: { on: '2026-10-30', next: null } });
  });

  test('an upcoming task with attachments of its own deleted alone loses them; Undo gives them back; its open task deleted in Google\'s own apps: the next one has the series\' fields, and nothing of the old one stays', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Plan');
    await a.store.saveListTask(first, formWith('Plan', '2026-10-29', 540, { color: RED, attachments: [doc('s1', 'Series doc')] }), 'all');
    await a.store.editOccurrence(upcomingOn(a.view(), '2026-10-31'), { ...form('Plan', '2026-10-31', 540), kept: { ...form('Plan', '2026-10-31', 540).kept, attachments: [doc('o1', 'Own')] } });
    const before = keptFor(world.state(), first)!.repeat!.exceptions!['2026-10-31']!;
    await a.store.setOccurrence(upcomingOn(a.view(), '2026-10-31'), { skip: true });
    expect(keptFor(world.state(), first)!.repeat!.exceptions!['2026-10-31']).toEqual({ skip: true });
    await a.store.setOccurrence({ account: ME, listId: 'L1', seriesId, on: '2026-10-31' }, before);
    expect(keptFor(world.state(), first)!.repeat!.exceptions!['2026-10-31']).toEqual({ attachments: [doc('o1', 'Own')] });
    world.google.delete(first.id);
    await a.store.loadBoard(ME, 'L1');
    await world.series.settled();
    const next = openTask(world)[0]!;
    expect(keptFor(world.state(), first)).toBeNull();
    expect(keptFor(world.state(), next)).toMatchObject({ color: RED, attachments: [doc('s1', 'Series doc')], repeat: { on: '2026-10-30', exceptions: { '2026-10-31': { attachments: [doc('o1', 'Own')] } } } });
  });

  test('a color or declining set with This task goes to the series (All tasks), through the series route, and the meetings it overlaps are declined at once', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Deep');
    await a.store.saveListTask(first, formWith('Deep', '2026-10-29', 540, { busy: true, color: RED, decline: { mode: 'all', message: 'Busy' } }), 'this');
    expect(a.calls.filter((call) => call.path === '/google/tasks/series/edit')).toHaveLength(1);
    expect(keptFor(world.state(), first)!.repeat!.template).toMatchObject({ busy: true, color: RED, decline: { mode: 'all', message: 'Busy' } });
    await flush();
    expect(a.calls.some((call) => call.path === '/google/tasks/decline')).toBe(true);
  });
});

describe('Undo after Delete, through the series (merge)', () => {
  test('This task: the next one its deletion made goes again, the task comes back as it was kept, color and attachments included, and the series goes on from it', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Water');
    await a.store.saveListTask(first, formWith('Water', '2026-10-29', 540, { color: RED, attachments: [doc('a1', 'Plan')] }), 'all');
    await a.store.deleteListTask(world.google.get(first.id)!, 'this');
    const made = openTask(world)[0]!;
    expect(world.google.has(first.id)).toBe(false);
    expect(await a.store.undoLast()).toEqual({ done: 'Deletion undone', note: null });
    expect(world.google.has(first.id)).toBe(true);
    expect(world.google.has(made.id)).toBe(false);
    expect(keptFor(world.state(), first)).toMatchObject({ color: RED, attachments: [doc('a1', 'Plan')], repeat: { seriesId, on: '2026-10-29', next: null } });
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([first.id]);
    expect(await a.store.undoLast()).toBeNull();
    // It goes on from it: completing it makes one next task.
    await a.store.completeListTask(world.google.get(first.id)!, true);
    expect(openTask(world).map((task) => task.due)).toEqual(['2026-10-30']);
  });

  test('This task, its next task changed in another window meanwhile: Undo brings the task back beside it, linked, and says so', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Water');
    await a.store.deleteListTask(world.google.get(first.id)!, 'this');
    const made = openTask(world)[0]!;
    const b = world.window();
    await b.store.saveListTask(made, form('Water the ferns', '2026-10-30', 540, { rule: 'RRULE:FREQ=DAILY' }), 'this');
    const undone = await a.store.undoLast();
    expect(undone?.note).toContain('stays');
    expect(world.google.get(made.id)).toMatchObject({ title: 'Water the ferns' });
    expect(world.google.has(first.id)).toBe(true);
    expect(keptFor(world.state(), first)!.repeat!.next).toBe(made.id);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([made.id]);
  });

  test('This and following tasks: Undo gives the series its rule and the changes it dropped back; one made meanwhile before the cut stays', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Cut');
    await a.store.editOccurrence(upcomingOn(a.view(), '2026-11-01'), form('Cut late', '2026-11-01', 900));
    await a.store.deleteSeries({ account: ME, seriesId, from: '2026-10-31' });
    expect(keptFor(world.state(), first)!.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY;UNTIL=20261030' });
    const b = world.window();
    await b.store.editOccurrence(upcomingOn(b.view(), '2026-10-30'), form('Cut early', '2026-10-30', 600));
    expect(await a.store.undoLast()).toEqual({ done: 'Deletion undone', note: null });
    expect(keptFor(world.state(), first)!.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY', exceptions: { '2026-10-30': { title: 'Cut early' }, '2026-11-01': { title: 'Cut late' } } });
    expect(upcomingTasks(world.state().googleTasks, [], '2026-10-30', '2026-11-02', '2026-10-29').map((task) => task.on)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  test('All tasks, a completed task among them: Undo gives every task back in Google, as it was kept', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'All');
    await a.store.completeListTask(first, true);
    const second = openTask(world)[0]!;
    await a.store.deleteSeries({ account: ME, seriesId, from: null });
    await world.series.settled();
    expect([world.google.has(first.id), world.google.has(second.id)]).toEqual([false, false]);
    await a.store.undoLast();
    expect([world.google.has(first.id), world.google.has(second.id)]).toEqual([true, true]);
    expect(keptFor(world.state(), first)!.repeat!.next).toBe(second.id);
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([second.id]);
  });
});

describe('Undo after completing (merge)', () => {
  test('a task of a series: the next one its completion made goes again, the task is open and the series goes on from it; Undo once', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Run');
    await a.store.completeListTask(first, true);
    const made = openTask(world)[0]!;
    expect(a.store.canUndo()).toBe(true);
    expect(await a.store.undoLast()).toEqual({ done: 'Completion undone', note: null });
    expect(world.google.get(first.id)!.completed).toBe(false);
    expect(world.google.has(made.id)).toBe(false);
    expect(keptFor(world.state(), made)).toBeNull();
    expect(keptFor(world.state(), first)!.repeat).toMatchObject({ next: null, on: '2026-10-29' });
    expect(world.heads(seriesId).map((kept) => kept.taskId)).toEqual([first.id]);
    expect(a.store.canUndo()).toBe(false);
    await a.store.completeListTask(world.google.get(first.id)!, true);
    expect(openTask(world).map((task) => task.due)).toEqual(['2026-10-30']);
  });

  test('its next task completed in another window meanwhile: Undo opens the task again beside it and says so; the series goes on from that one', async () => {
    const world = service();
    const a = world.window();
    const { first, seriesId } = await daily(world, a, 'Run');
    await a.store.completeListTask(first, true);
    const made = openTask(world)[0]!;
    const b = world.window();
    await b.store.completeListTask(made, true);
    const undone = await a.store.undoLast();
    expect(undone?.note).toContain('stays');
    expect(world.google.get(first.id)!.completed).toBe(false);
    expect(world.google.get(made.id)!.completed).toBe(true);
    expect(world.heads(seriesId)).toHaveLength(1);
    expect(world.heads(seriesId)[0]!.taskId).not.toBe(first.id);
  });

  test('a task opened again by hand leaves nothing to undo', async () => {
    const world = service();
    const a = world.window();
    const { first } = await daily(world, a, 'Run');
    await a.store.completeListTask(first, true);
    await a.store.completeListTask(world.google.get(first.id)!, false);
    expect(a.store.canUndo()).toBe(false);
    expect(openTask(world)).toHaveLength(2);
  });

  test('the last task of a series that ends with it: open again, and it repeats again', async () => {
    const world = service();
    const a = world.window();
    const first = await a.store.addListTask(ME, 'L1', { title: 'Last', notes: '', due: '2026-10-29' }, { time: 540, rule: 'RRULE:FREQ=DAILY;COUNT=1' });
    await a.store.completeListTask(first, true);
    expect(keptFor(world.state(), first)?.repeat ?? null).toBeNull();
    await a.store.undoLast();
    expect(world.google.get(first.id)!.completed).toBe(false);
    expect(keptFor(world.state(), first)!.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY;COUNT=1', next: null });
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
