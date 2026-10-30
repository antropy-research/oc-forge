// Sunsama's Merge tasks keeps a merged integration task "fully integrated, synced": a Google task merged into a task
// is completed in Google Tasks when it is checked off, or when the task it is merged into is completed, and reopened
// when opened again (or its task reopened, unless it was checked off on its own), as "Complete in Google Tasks" does
// for a linked one; completed in Google, it is checked off here. And a calendar event task has no subtasks at all:
// the service adds none to one. (Only names older builds have are used, so this file runs against them as a control.)
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { validateCommand, type Command, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { gtaskSource, linkedGoogleTasks, TASK_GONE, type GoogleTaskItem } from '../src/domain/google.ts';
import { mergeTaskCommands } from '../src/domain/merge.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { emptyState, type PlannerState, type TaskSourceRef } from '../src/domain/types.ts';
import { GoogleStore } from '../panel/lib/google.ts';
import type { CommitListener, Origin, PlannerClient } from '../panel/lib/client.ts';

const ME = 'me@example.com';
const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
let ids = 0;
const newId = () => `n${++ids}`;
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
const google = (id: string, title: string, patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id, title, notes: '', due: null, completed: false, parent: null, position: id, url: `https://tasks.google.com/task/${id}`, updated: '2026-10-29T14:00:00.000Z', ...patch,
});
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;

/**
 * Google Tasks in memory, answering the service's routes as it does: a write completes or reopens a task (refused
 * once with `refuseNext`); a task deleted there is gone (TASK_GONE); reads by list and by id.
 */
const fakeGoogle = (items: GoogleTaskItem[]) => {
  const tasks = new Map(items.map((item) => [item.id, { ...item }]));
  const writes: { id: string; completed?: boolean }[] = [];
  let refuseNext: string | null = null;
  const answer = (method: string, path: string, body: any): unknown => {
    if (path === '/google/status') return { client: { id: 'harness' }, accounts: [{ email: ME, features: ['tasks'], addedAt: '2026-10-01T00:00:00.000Z' }] };
    if (path === '/google/tasklists') return { lists: [{ account: ME, id: 'L1', title: 'My Tasks' }], errors: [] };
    if (path.startsWith('/google/tasks/all')) return { tasks: [...tasks.values()].map((task) => ({ ...task })), complete: true };
    if (path === '/google/tasks/linked') {
      const wanted = (body.groups as { account: string; listId: string; ids: string[] }[]).flatMap((group) => group.ids.map((id) => ({ ...group, id })));
      return { tasks: wanted.flatMap(({ id }) => (tasks.has(id) ? [{ ...tasks.get(id)! }] : [])), missing: wanted.filter(({ id }) => !tasks.has(id)).map(({ account, listId, id }) => ({ account, listId, id })), errors: [] };
    }
    if (method === 'PATCH' && path === '/google/tasks') {
      if (refuseNext) {
        const message = refuseNext;
        refuseNext = null;
        throw new Error(message);
      }
      const task = tasks.get(body.id);
      if (!task) throw new Error(TASK_GONE);
      if (body.completed !== undefined) task.completed = body.completed;
      writes.push({ id: body.id, completed: body.completed });
      return { task: { ...task } };
    }
    return {};
  };
  return { tasks, writes, answer, refuse: (message: string) => (refuseNext = message) };
};

/**
 * A Planner window: its client applies the batches (checked as the service checks them) and tells the commit
 * listeners, as the real one does once the service took them; the Google store follows them (its own listener).
 */
const plannerWith = async (start: EventBody[], googleTasks: GoogleTaskItem[], settings: Partial<PlannerState['settings']> = {}) => {
  let state = applyEvents(emptyState(), [ev({ type: 'settings.updated', patch: { timezone: 'UTC', ...settings } }), ...start.map(ev)]);
  const g = fakeGoogle(googleTasks);
  const listeners: CommitListener[] = [];
  const notes: string[] = [];
  const client = {
    getView: () => ({ state, today: TODAY }),
    call: async (method: string, path: string, body?: any) => (path === '/state' ? { state, today: TODAY } : g.answer(method, path, body)),
    adopt: async () => {},
    refresh: async () => state,
    dispatch: async (bodies: EventBody[], options: { origin?: Origin; undo?: string } = {}) => {
      const before = state;
      for (const body of bodies) {
        const error = validateCommand({ cmd: `c${clock}`, ...body }, state);
        if (error) throw new Error(error);
        state = applyEvents(state, [ev(body)]);
      }
      for (const listener of listeners) listener(bodies.map((body, index) => ({ cmd: `c${index}`, ...body }) as Command), before, state, options.origin ?? 'user');
    },
    onCommitted: (listener: CommitListener) => {
      listeners.push(listener);
      return () => {};
    },
    activity: async () => [],
    notify: (message: string) => notes.push(message),
  } as unknown as PlannerClient;
  const store = new GoogleStore(host, client, 'page');
  // As start() does, without its timer: the store hears the user's changes, and knows the account has Google Tasks.
  client.onCommitted((commands, before, after, origin) => (store as unknown as { afterCommit: CommitListener }).afterCommit(commands, before, after, origin));
  await store.checkStatus();
  return { client, store, google: g, notes, state: () => state };
};
const until = async (test: () => boolean): Promise<boolean> => {
  for (let tick = 0; tick < 400; tick++) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return test();
};
const day = { kind: 'day' as const, date: TODAY };
/** A task linked to a Google task, as the Google panel plans one. */
const linked = (id: string, item: GoogleTaskItem): EventBody => ({ type: 'task.created', task: { id, title: item.title, placement: day, position: 2048, source: gtaskSource(item) } });
const inbox: EventBody = { type: 'task.created', task: { id: 'inbox', title: 'Inbox triage', placement: day, position: 1024 } };
/** Alt/Option + drop: the linked task merged into Inbox triage. */
const merge = async (p: Awaited<ReturnType<typeof plannerWith>>, draggedId: string) => {
  const bodies = mergeTaskCommands(p.state(), draggedId, 'inbox', newId);
  if (typeof bodies === 'string') throw new Error(bodies);
  await p.client.dispatch(bodies);
  return p.state().tasks.inbox!.subtasks.find((subtask) => subtask.source?.kind === 'gtask' && subtask.title === p.state().tasks[draggedId]?.title)!;
};
const tick = (p: Awaited<ReturnType<typeof plannerWith>>, subtaskId: string, done: boolean) =>
  p.client.dispatch([{ type: 'task.updated', taskId: 'inbox', patch: { subtasks: p.state().tasks.inbox!.subtasks.map((subtask) => (subtask.id === subtaskId ? { ...subtask, done } : subtask)) } }]);
const sourceOf = (p: Awaited<ReturnType<typeof plannerWith>>, subtaskId: string): TaskSourceRef | undefined => p.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === subtaskId)?.source;

describe('a Google task merged into a task stays a synced Google task', () => {
  test('checked off: completed in Google Tasks (its own subtasks there first), and its link says so; opened again: reopened there', async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip'))], [google('g-trip', 'Plan the trip'), google('g-hotel', 'Book the hotel', { parent: 'g-trip' })]);
    const merged = await merge(p, 'trip');
    expect(merged.source).toMatchObject({ kind: 'gtask', id: 'g-trip', account: ME, listId: 'L1' });
    // The merge alone writes nothing to Google.
    expect(p.google.writes).toEqual([]);
    await tick(p, merged.id, true);
    expect(await until(() => sourceOf(p, merged.id)?.status?.type === 'completed')).toBe(true);
    expect(p.google.writes).toEqual([{ id: 'g-hotel', completed: true }, { id: 'g-trip', completed: true }]);
    expect(p.google.tasks.get('g-trip')!.completed).toBe(true);
    await tick(p, merged.id, false);
    expect(await until(() => sourceOf(p, merged.id)?.status?.type === 'open')).toBe(true);
    expect(p.google.writes.at(-1)).toEqual({ id: 'g-trip', completed: false });
    expect(p.google.tasks.get('g-trip')!.completed).toBe(false);
  });

  test("its task completed: each merged Google task completed there too, with the task's own; reopened: the ones not checked off on their own reopened", async () => {
    const own = google('g-own', 'Inbox triage in Google');
    const p = await plannerWith(
      [{ type: 'task.created', task: { id: 'inbox', title: 'Inbox triage', placement: day, position: 1024, source: gtaskSource(own) } }, linked('trip', google('g-trip', 'Plan the trip')), linked('stamps', google('g-stamps', 'Buy stamps'))],
      [own, google('g-trip', 'Plan the trip'), google('g-stamps', 'Buy stamps')],
    );
    const trip = await merge(p, 'trip');
    const stamps = await merge(p, 'stamps');
    // Stamps checked off on its own first.
    await tick(p, stamps.id, true);
    expect(await until(() => p.google.tasks.get('g-stamps')!.completed)).toBe(true);
    await p.client.dispatch([{ type: 'task.completed', taskId: 'inbox', on: TODAY }]);
    expect(await until(() => p.google.tasks.get('g-trip')!.completed && p.google.tasks.get('g-own')!.completed)).toBe(true);
    expect(await until(() => sourceOf(p, trip.id)?.status?.type === 'completed')).toBe(true);
    // The trip stays unticked here (its task is done); stamps was written once only.
    expect(p.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === trip.id)!.done).toBe(false);
    expect(p.google.writes.filter((write) => write.id === 'g-stamps')).toEqual([{ id: 'g-stamps', completed: true }]);
    await p.client.dispatch([{ type: 'task.reopened', taskId: 'inbox' }]);
    expect(await until(() => !p.google.tasks.get('g-trip')!.completed && !p.google.tasks.get('g-own')!.completed)).toBe(true);
    // Checked off on its own, stamps stays completed in Google.
    expect(p.google.tasks.get('g-stamps')!.completed).toBe(true);
    expect(await until(() => sourceOf(p, trip.id)?.status?.type === 'open')).toBe(true);
  });

  test('"Ask" asks once for the task and its merged Google tasks; Complete completes them all', async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip')), linked('stamps', google('g-stamps', 'Buy stamps'))], [google('g-trip', 'Plan the trip'), google('g-stamps', 'Buy stamps')], { googleTasksOnComplete: 'ask' });
    await merge(p, 'trip');
    await merge(p, 'stamps');
    await p.client.dispatch([{ type: 'task.completed', taskId: 'inbox', on: TODAY }]);
    const prompt = p.store.getView().prompt;
    expect(prompt).toMatchObject({ taskId: 'inbox', title: 'Plan the trip and 1 more', own: false, by: 'task' });
    expect(p.google.writes).toEqual([]);
    p.store.answerPrompt('yes');
    expect(await until(() => p.google.tasks.get('g-trip')!.completed && p.google.tasks.get('g-stamps')!.completed)).toBe(true);
  });

  test('one checked off on its own (its question declined) is not asked about again when its task is completed, as with Linear and Gmail', async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip')), linked('stamps', google('g-stamps', 'Buy stamps'))], [google('g-trip', 'Plan the trip'), google('g-stamps', 'Buy stamps')], { googleTasksOnComplete: 'ask' });
    const trip = await merge(p, 'trip');
    const stamps = await merge(p, 'stamps');
    await tick(p, stamps.id, true);
    expect(p.store.getView().prompt).toMatchObject({ title: 'Buy stamps', own: false, subtaskIds: [stamps.id], by: 'tick' });
    p.store.answerPrompt('no');
    await p.client.dispatch([{ type: 'task.completed', taskId: 'inbox', on: TODAY }]);
    expect(p.store.getView().prompt).toMatchObject({ title: 'Plan the trip', own: false, subtaskIds: [trip.id], by: 'task' });
  });

  test('refused by Google: checked off on its own, the tick goes back and it says so; with its task, the task stays completed and it says so', async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip'))], [google('g-trip', 'Plan the trip')]);
    const trip = await merge(p, 'trip');
    p.google.refuse('Backend Error');
    await tick(p, trip.id, true);
    expect(await until(() => p.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === trip.id)!.done === false)).toBe(true);
    expect(p.notes).toContain('Google Tasks did not complete "Plan the trip" (Backend Error), so it stays open here too');
    p.google.refuse('Backend Error');
    await p.client.dispatch([{ type: 'task.completed', taskId: 'inbox', on: TODAY }]);
    expect(await until(() => p.notes.includes('Google Tasks did not complete "Plan the trip" (Backend Error)'))).toBe(true);
    expect(p.state().tasks.inbox!.completedAt).toBeTruthy();
  });

  test('gone from Google: its link says so, and the sync reads it no more; "Do nothing" writes nothing', async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip'))], [google('g-trip', 'Plan the trip')]);
    const trip = await merge(p, 'trip');
    p.google.tasks.delete('g-trip');
    await tick(p, trip.id, true);
    expect(await until(() => sourceOf(p, trip.id)?.status?.name === 'Deleted')).toBe(true);
    expect(p.notes).toContain('"Plan the trip" is no longer in Google Tasks');
    expect(linkedGoogleTasks(p.state())).toEqual([]);

    const quiet = await plannerWith([inbox, linked('stamps', google('g-stamps', 'Buy stamps'))], [google('g-stamps', 'Buy stamps')], { googleTasksOnComplete: 'nothing' });
    const stamps = await merge(quiet, 'stamps');
    await tick(quiet, stamps.id, true);
    await quiet.client.dispatch([{ type: 'task.completed', taskId: 'inbox', on: TODAY }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quiet.google.writes).toEqual([]);
  });

  test("completed in Google: the sync reads open tasks' merged Google tasks and checks it off (completion imported), its title following; not when completion isn't imported", async () => {
    const p = await plannerWith([inbox, linked('trip', google('g-trip', 'Plan the trip'))], [google('g-trip', 'Plan the trip')]);
    const trip = await merge(p, 'trip');
    expect(linkedGoogleTasks(p.state())).toEqual([{ account: ME, listId: 'L1', ids: ['g-trip'] }]);
    p.google.tasks.set('g-trip', { ...p.google.tasks.get('g-trip')!, completed: true, title: 'Plan the trip to Lisbon' });
    await p.store.sync();
    expect(await until(() => p.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === trip.id)!.done)).toBe(true);
    expect(p.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === trip.id)).toMatchObject({ title: 'Plan the trip to Lisbon', source: { status: { type: 'completed' } } });
    // Checked off by Google: nothing is written back.
    expect(p.google.writes).toEqual([]);

    const off = await plannerWith([inbox, linked('stamps', google('g-stamps', 'Buy stamps'))], [google('g-stamps', 'Buy stamps')], { googleTasksImportCompletion: false });
    const stamps = await merge(off, 'stamps');
    off.google.tasks.set('g-stamps', { ...off.google.tasks.get('g-stamps')!, completed: true });
    await off.store.sync();
    expect(await until(() => sourceOf(off, stamps.id)?.status?.type === 'completed')).toBe(true);
    expect(off.state().tasks.inbox!.subtasks.find((subtask) => subtask.id === stamps.id)!.done).toBe(false);
  });
});

describe('a calendar event task has no subtasks at all, as in Sunsama', () => {
  const event: TaskSourceRef = { kind: 'event', id: `${ME}|primary|e1`, key: 'Google Calendar', url: 'https://calendar.google.com/calendar/r/eventedit/e1' };
  const state = () => applyEvents(emptyState(), [ev({ type: 'task.created', task: { id: 'meeting', title: 'Harness 1:1', placement: day, position: 1024, source: event } }), ev({ type: 'task.created', task: { id: 'plain', title: 'Write notes', placement: day, position: 2048 } })]);
  test("the service adds none to one (Sunsama's words); a plain task takes them", () => {
    const added = { cmd: 'c1', type: 'task.updated', taskId: 'meeting', patch: { subtasks: [{ id: 's1', title: 'Agenda', done: false }] } };
    expect(validateCommand(added, state())).toBe("Calendar event tasks can't have subtasks");
    expect(validateCommand({ ...added, taskId: 'plain' }, state())).toBeNull();
  });

  test('the ones an event task had before stay: ticked, renamed, removed', () => {
    // Made before the rule (as one could be).
    const before = applyEvents(state(), [ev({ type: 'task.updated', taskId: 'meeting', patch: { subtasks: [{ id: 's1', title: 'Agenda', done: false }, { id: 's2', title: 'Notes', done: false }] } })]);
    expect(validateCommand({ cmd: 'c2', type: 'task.updated', taskId: 'meeting', patch: { subtasks: [{ id: 's1', title: 'Agenda for Ann', done: true }] } }, before)).toBeNull();
    expect(validateCommand({ cmd: 'c3', type: 'task.updated', taskId: 'meeting', patch: { subtasks: [{ id: 's1', title: 'Agenda', done: false }, { id: 's3', title: 'More', done: false }] } }, before)).toBe("Calendar event tasks can't have subtasks");
  });
});
