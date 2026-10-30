// Round 12, Sunsama's Merge tasks (help.sunsama.com/docs/usage-guides/tasks/merge-tasks): Alt/Option + drop merges a
// task, or an item straight from a panel, into another as a subtask that keeps its notes, planned time and link; an
// event neither merges nor takes one ("Cannot merge events"); Convert to task gives it back; merged items stay synced
// (state and title) and run their automations when checked off; `>` in Add task merges a new task into an open one.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { CANNOT_MERGE_EVENTS, EVENT_NO_SUBTASKS, EVENT_SUBTASKS_HINT, convertSubtaskCommands, isEventTask, mergeItemCommands, mergeTarget, mergeTaskCommands, mergedDone, mergedImports, mergedReopened, planSubtaskSourceSync, subtaskSourceIds, subtaskSources } from '../src/domain/merge.ts';
import { followMergedGoogleTask, gtaskSource, type GoogleTaskItem } from '../src/domain/google.ts';
import { parseQuickAdd } from '../src/domain/quickAdd.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { emptyState, type PlannerState, type Subtask, type Task, type TaskSourceRef } from '../src/domain/types.ts';
import { addParsedTask, type AddSources } from '../panel/lib/addTask.ts';
import { GitHubStore } from '../panel/lib/github.ts';
import { GoogleStore } from '../panel/lib/google.ts';
import type { LinearStore } from '../panel/lib/linear.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import type { GitHubItem } from '../src/domain/github.ts';

const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
let ids = 0;
const newId = () => `n${++ids}`;
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
/** Apply bodies as the service would: each validated against the plan the ones before it made. */
const run = (state: PlannerState, bodies: readonly EventBody[]): PlannerState => {
  for (const body of bodies) {
    expect(validateCommand({ cmd: `c${clock}`, ...body }, state)).toBeNull();
    state = applyEvents(state, [ev(body)]);
  }
  return state;
};
/** Subtasks added to a task, one command each, as the Planner adds them. */
const added = (taskId: string, ...subtasks: Subtask[]): EventBody[] => subtasks.map((subtask) => ({ type: 'subtask.added', taskId, subtask }));
const linear = (id: string, key: string, title = key): TaskSourceRef => ({ kind: 'linear', id, key, url: `https://linear.app/acme/issue/${key}`, title, status: { name: 'Todo', type: 'unstarted', color: '#999' } });
const day = (date = TODAY) => ({ kind: 'day' as const, date });
const base = (): PlannerState =>
  run(emptyState(), [
    { type: 'task.created', task: { id: 'triage', title: 'Inbox triage', placement: day(), position: 1024 } },
    { type: 'task.created', task: { id: 'issue', title: 'NEX-1 Fix the crash', placement: day(), position: 2048, notes: 'Repro: open twice', plannedMinutes: 45, source: linear('L1', 'NEX-1', 'NEX-1 Fix the crash') } },
    ...added('issue', { id: 's1', title: 'Write a test', done: true }),
    {
      type: 'task.created',
      task: { id: 'meeting', title: 'Standup', placement: day(), position: 512, plannedMinutes: 15, source: { kind: 'event', id: 'me@x.com|primary|ev1', key: 'Google Calendar', url: 'https://www.google.com/calendar/event?eid=ev1', title: 'Standup', account: 'me@x.com', event: { calendarId: 'primary', start: '2026-10-29T16:00:00.000Z', end: '2026-10-29T16:15:00.000Z', allDay: false, invitees: true } } },
    },
  ]);

describe('merging tasks (Alt/Option + drop)', () => {
  test('a task merged in becomes a subtask with its notes (its own subtasks as a checklist), planned time and link; the task goes', () => {
    const state = base();
    const bodies = mergeTaskCommands(state, 'issue', 'triage', newId);
    expect(Array.isArray(bodies)).toBe(true);
    const after = run(state, bodies as EventBody[]);
    expect(after.tasks.issue!.deletedAt).not.toBeNull();
    expect(after.tasks.triage!.subtasks).toEqual([{ id: 'n1', title: 'NEX-1 Fix the crash', done: false, notes: 'Repro: open twice\n\n- [x] Write a test', plannedMinutes: 45, source: linear('L1', 'NEX-1', 'NEX-1 Fix the crash') }]);
    // Convert to task: a task again, right after its task, with what it kept.
    const back = run(after, convertSubtaskCommands(after, 'triage', 'n1', newId));
    expect(back.tasks.triage!.subtasks).toEqual([]);
    const made = back.tasks.n2!;
    expect([made.title, made.notes, made.plannedMinutes, made.source?.key, made.placement]).toEqual(['NEX-1 Fix the crash', 'Repro: open twice\n\n- [x] Write a test', 45, 'NEX-1', day()]);
    expect(made.position).toBeGreaterThan(back.tasks.triage!.position);
  });

  test('an item straight from a panel merges in linked, once; events neither merge nor take one: "Cannot merge events"', () => {
    const state = base();
    const item = { title: 'Quarterly numbers', source: { kind: 'email' as const, id: 'm1', key: 'Gmail', url: 'https://mail.google.com/mail/u/me%40x.com/#all/t1', title: 'Quarterly numbers', account: 'me@x.com' } };
    const after = run(state, mergeItemCommands(state, 'triage', item, newId) as EventBody[]);
    expect(after.tasks.triage!.subtasks.map((subtask) => [subtask.title, subtask.source?.kind, subtask.done])).toEqual([['Quarterly numbers', 'email', false]]);
    expect(mergeItemCommands(after, 'triage', item, newId)).toEqual([]);
    expect(mergeTaskCommands(state, 'meeting', 'triage', newId)).toBe(CANNOT_MERGE_EVENTS);
    expect(mergeTaskCommands(state, 'triage', 'meeting', newId)).toBe(CANNOT_MERGE_EVENTS);
    expect(mergeItemCommands(state, 'meeting', item, newId)).toBe(CANNOT_MERGE_EVENTS);
    expect(mergeTaskCommands(state, 'triage', 'triage', newId)).toEqual([]);
  });

  test("merged items stay synced: their item's state and title follow it, a subtask renamed by hand keeps its name, done once the item closes", () => {
    let state = run(base(), added('triage', { id: 'a', title: 'NEX-2', done: false, source: linear('L2', 'NEX-2') }, { id: 'b', title: 'My own name', done: false, source: linear('L3', 'NEX-3') }));
    expect(subtaskSourceIds(state, 'linear')).toEqual(['L2', 'L3']);
    expect(subtaskSources(state, 'linear').map((source) => source.key)).toEqual(['NEX-2', 'NEX-3']);
    const items = new Map([
      ['L2', { title: 'NEX-2 renamed', status: { name: 'In Progress', type: 'started', color: '#f2c94c' }, closed: false }],
      ['L3', { title: 'NEX-3 new title', status: { name: 'Done', type: 'completed', color: '#5e6ad2' }, closed: true }],
    ]);
    state = run(state, planSubtaskSourceSync(state, 'linear', items));
    expect(state.tasks.triage!.subtasks.map((subtask) => [subtask.title, subtask.done, subtask.source?.status?.name])).toEqual([['NEX-2 renamed', false, 'In Progress'], ['My own name', true, 'Done']]);
    // In step now: nothing more to write; a done one is no longer read.
    expect(planSubtaskSourceSync(state, 'linear', items)).toEqual([]);
    expect(subtaskSourceIds(state, 'linear')).toEqual(['L2']);
  });

  test('a merged item checked off runs its completion automations; one merged straight in runs the import ones, a task merged in does not', () => {
    const state = run(base(), added('triage', { id: 'a', title: 'NEX-2', done: false, source: linear('L2', 'NEX-2') }, { id: 'p', title: 'Plain', done: false }));
    const checked = run(state, state.tasks.triage!.subtasks.map((subtask): EventBody => ({ type: 'subtask.updated', taskId: 'triage', subtaskId: subtask.id, patch: { done: true }, seen: { done: false } })));
    expect(mergedDone(state.tasks.triage, checked.tasks.triage).map((subtask) => subtask.id)).toEqual(['a']);
    // Straight from the panel: an import (L2 is merged already, so not again).
    expect(mergedImports(base(), state, 'triage').map((subtask) => subtask.id)).toEqual(['a']);
    // A task merged in (its issue was on a task before): not an import.
    const merged = run(state, mergeTaskCommands(state, 'issue', 'triage', newId) as EventBody[]);
    expect(mergedImports(state, merged, 'triage')).toEqual([]);
    // Made and merged in the same change (`>`): the task's creation was the import.
    expect(mergedImports(base(), state, 'triage', [linear('L2', 'NEX-2')])).toEqual([]);
  });
});

describe("`>` in Add task (Sunsama's merge during task creation)", () => {
  test('the words after > name the task (up to the next token); a > alone or before a symbol stays in the title', () => {
    expect(parseQuickAdd('Reply to Ann >Inbox triage ~10m', TODAY)).toMatchObject({ title: 'Reply to Ann', merge: 'Inbox triage', plannedMinutes: 10 });
    expect(parseQuickAdd('https://github.com/acme/app/issues/51 >inbox', TODAY)).toMatchObject({ title: 'https://github.com/acme/app/issues/51', merge: 'inbox' });
    expect(parseQuickAdd('Compare A > B', TODAY)).toMatchObject({ title: 'Compare A > B' });
    expect(parseQuickAdd('Check x >= 3', TODAY).merge).toBeUndefined();
  });

  test('the task found: its title, then its start, then words in it; on the day asked for first, then today; never done, deleted or an event', () => {
    let state = base();
    state = run(state, [
      { type: 'task.created', task: { id: 'triage-fri', title: 'Inbox triage', placement: day('2026-10-30'), position: 1024 } },
      { type: 'task.created', task: { id: 'done', title: 'Inbox zero', placement: day(), position: 4096 } },
      { type: 'task.completed', taskId: 'done', on: TODAY },
    ]);
    expect(mergeTarget(state, 'inbox triage', TODAY, TODAY)?.id).toBe('triage');
    expect(mergeTarget(state, 'Inbox', '2026-10-30', TODAY)?.id).toBe('triage-fri');
    expect(mergeTarget(state, 'crash', TODAY, TODAY)?.id).toBe('issue');
    expect(mergeTarget(state, 'zero', TODAY, TODAY)).toBeNull();
    expect(mergeTarget(state, 'Standup', TODAY, TODAY)).toBeNull();
  });

  const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;
  const setup = (answer: (method: string, path: string, body: any) => unknown = () => ({})) => {
    let state = base();
    const notes: string[] = [];
    const undo: (string | undefined)[] = [];
    const client = {
      getView: () => ({ state, today: TODAY }),
      call: async (method: string, path: string, body?: unknown) => {
        const answered = answer(method, path, body);
        if (answered instanceof Error) throw answered;
        return answered;
      },
      dispatch: async (bodies: EventBody[], options: { undo?: string } = {}) => {
        undo.push(options.undo);
        state = run(state, bodies);
      },
      notify: (message: string) => notes.push(message),
      onCommitted: () => () => {},
    } as unknown as PlannerClient;
    const github = new GitHubStore(client, 'page');
    (github as unknown as { view: { status: unknown } }).view.status = { available: true, login: 'me', message: null };
    const google = Object.create(new GoogleStore(host, client, 'page')) as GoogleStore;
    const sources: AddSources = { client, linear: { available: () => false } as unknown as LinearStore, github, google };
    const add = (text: string) => addParsedTask(sources, parseQuickAdd(text, TODAY), day(), 'bottom', TODAY);
    return { add, notes, undo, state: () => state };
  };

  test('a new task goes into the task named, as a subtask with its planned time, in one step that Undo takes back', async () => {
    const fake = setup();
    await fake.add('Reply to Ann ~10m >inbox tri');
    const triage = fake.state().tasks.triage!;
    expect(triage.subtasks.map((subtask) => [subtask.title, subtask.plannedMinutes, subtask.done])).toEqual([['Reply to Ann', 10, false]]);
    expect(Object.values(fake.state().tasks).filter((task) => task.title === 'Reply to Ann' && !task.deletedAt)).toEqual([]);
    expect(fake.undo).toEqual(['Merged into "Inbox triage"']);
  });

  test('a pasted GitHub issue is imported straight into it, linked; no task matching: its own task, and the Planner says so', async () => {
    const item: GitHubItem = { id: 'I_51', kind: 'issue', repo: 'acme/app', number: 51, key: 'acme/app#51', title: 'Issue 51', url: 'https://github.com/acme/app/issues/51', state: 'OPEN', draft: false, updatedAt: '2026-10-01T00:00:00Z' };
    const fake = setup((_method, path) => (path === '/github/resolve' ? { item } : {}));
    await fake.add('https://github.com/acme/app/issues/51 >Inbox triage');
    expect(fake.state().tasks.triage!.subtasks.map((subtask) => [subtask.title, subtask.source?.kind, subtask.source?.key])).toEqual([['Issue 51', 'github', 'acme/app#51']]);
    await fake.add('Call the bank >groceries');
    expect(fake.notes).toEqual(['No open task matches "groceries": added it as its own task']);
    expect(Object.values(fake.state().tasks).some((task) => task.title === 'Call the bank' && !task.deletedAt)).toBe(true);
  });
});

describe('merged Google tasks, and event tasks without subtasks', () => {
  const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
    account: 'me@example.com', listId: 'L1', id: 'g1', title: 'Plan the trip', notes: '', due: null, completed: false, parent: null, position: '1', url: 'https://tasks.google.com/task/g1', updated: '2026-10-29T14:00:00.000Z', ...patch,
  });
  const merged = { id: 's1', title: 'Plan the trip', done: false, source: gtaskSource(item()) };

  test("a merged Google task follows Google: its link, its title while it is Google's, checked off on a completion new there (and imported)", () => {
    expect(followMergedGoogleTask(merged, item(), true)).toBe(merged);
    const renamed = followMergedGoogleTask(merged, item({ title: 'Plan the trip to Lisbon', listId: 'L2' }), true);
    expect(renamed).toMatchObject({ title: 'Plan the trip to Lisbon', done: false, source: { title: 'Plan the trip to Lisbon', listId: 'L2' } });
    // Renamed here, it keeps its own title.
    expect(followMergedGoogleTask({ ...merged, title: 'Trip' }, item({ title: 'Plan the trip to Lisbon' }), true).title).toBe('Trip');
    expect(followMergedGoogleTask(merged, item({ completed: true }), true)).toMatchObject({ done: true, source: { status: { type: 'completed' } } });
    expect(followMergedGoogleTask(merged, item({ completed: true }), false)).toMatchObject({ done: false, source: { status: { type: 'completed' } } });
    // Its link said completed already (the Planner wrote it, or a read saw it before it was opened again here): not new.
    const written = { ...merged, source: gtaskSource(item({ completed: true })) };
    expect(followMergedGoogleTask(written, item({ completed: true }), true)).toBe(written);
  });

  test('opened again: merged items unticked by a change (a subtask without a link is not one)', () => {
    const before = { subtasks: [{ ...merged, done: true }, { id: 's2', title: 'Pack', done: true }] } as unknown as Task;
    const after = { subtasks: [merged, { id: 's2', title: 'Pack', done: false }] } as unknown as Task;
    expect(mergedReopened(before, after).map((subtask) => subtask.id)).toEqual(['s1']);
    expect(mergedReopened(after, before)).toEqual([]);
  });

  test("an event task has no subtasks: Sunsama's words, and its advice instead of Add subtask", () => {
    expect(isEventTask({ source: { kind: 'event', id: 'e', key: 'Google Calendar', url: 'https://calendar.google.com/' } })).toBe(true);
    expect(isEventTask({ source: null })).toBe(false);
    expect(EVENT_NO_SUBTASKS).toBe("Calendar event tasks can't have subtasks");
    expect(EVENT_SUBTASKS_HINT).toContain('notes');
    expect(CANNOT_MERGE_EVENTS).toBe('Cannot merge events');
  });
});
