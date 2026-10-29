// Round 10's inventory of Google Tasks: what its help documents beyond a
// task's settings, and the Planner did not do yet: "Sort by" Deadline and
// Title, Move to top / bottom, Undo after Delete, the order of the lists,
// Starred's own sort, shared tasks (assigned from a Doc or a Chat space: no
// repeat, no subtasks) and a task's origin in Gmail or Keep, Gmail's "Add to
// Tasks", and its keyboard shortcuts kept from OpenChamber in the Tasks view.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, SHARED_NO_REPEAT, SHARED_NO_SUBTASKS, type TaskFields } from '../panel/lib/google.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { plannerKeeps } from '../panel/lib/forge.ts';
import { TASK_SHORTCUTS, repeatBlock } from '../panel/components/TasksView.tsx';
import { toTaskItem } from '../service/googleData.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import type { GoogleTaskItem, MailItem } from '../src/domain/google.ts';
import { byTitle, deadlineSections, moveBottomTarget, moveTopTarget, openRows } from '../src/domain/gtasks.ts';
import { keptFor, templateOf } from '../src/domain/gtaskKept.ts';
import { taskOrigins } from '../src/domain/gtaskAdvanced.ts';
import { emptyState, type PlannerState } from '../src/domain/types.ts';

const ME = 'me@example.com';
const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `i${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id: 'gt1', title: 'Task', notes: '', due: null, completed: false, parent: null, position: '0001', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-28T15:00:00.000Z', ...patch,
});
const keep = (taskId: string, patch: Record<string, unknown>, listId = 'L1'): EventBody => ({ type: 'gtask.kept', account: ME, listId, taskId, patch } as EventBody);
const stateWith = (...bodies: EventBody[]): PlannerState => applyEvents(emptyState(), bodies.map(ev));
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;

const fakeClient = (start: PlannerState, answer: (method: string, path: string, body: any) => unknown = () => ({ tasks: [] })) => {
  let state = start;
  let n = 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  const client = {
    getView: () => ({ state, today: TODAY }),
    call: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return answer(method, path, body);
    },
    dispatch: async (bodies: EventBody[]) => {
      for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
      n += bodies.length;
      state = applyEvents(state, bodies.map(ev));
    },
    adopt: async () => {},
    activity: async () => [],
    notify: () => {},
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { client, calls, state: () => state };
};

describe('Sort by Deadline and Title, Move to top and bottom', () => {
  const items = [
    item({ id: 'a', title: 'Zebra report', position: '0001' }),
    item({ id: 'b', title: 'apple pie', position: '0002' }),
    item({ id: 'c', title: 'Item 10', position: '0003' }),
    item({ id: 'd', title: 'Item 9', position: '0004' }),
    item({ id: 'e', title: 'Done', position: '0005', completed: true }),
    item({ id: 'f', title: 'Sub', position: '0001', parent: 'a' }),
  ];
  test('Deadline: the ones whose deadline passed ("Past"), then by deadline, then the ones without one', () => {
    const deadlines: Record<string, string> = { a: '2026-10-27', c: '2026-11-02', d: '2026-10-30', f: '2026-10-30' };
    const sections = deadlineSections(items, TODAY, (one) => deadlines[one.id] ?? null);
    expect(sections.map((section) => [section.kind, section.date, section.items.map((one) => one.id)])).toEqual([
      ['past', null, ['a']],
      ['day', '2026-10-30', ['f', 'd']],
      ['day', '2026-11-02', ['c']],
      ['none', null, ['b']],
    ]);
  });

  test('Title: A to Z whatever the case, numbers in order, open tasks only', () => {
    expect(byTitle(items).map((one) => one.title)).toEqual(['apple pie', 'Item 9', 'Item 10', 'Sub', 'Zebra report']);
  });

  test("Move to top / bottom: first or last among its siblings, a subtask under its parent; none where it is already", () => {
    const rows = openRows([...items, item({ id: 'g', title: 'Sub 2', position: '0002', parent: 'a' })]);
    expect(moveTopTarget(rows, 'd')).toEqual({ parent: null, previous: null });
    expect(moveBottomTarget(rows, 'a')).toEqual({ parent: null, previous: 'd' });
    expect(moveTopTarget(rows, 'a')).toBeNull();
    expect(moveBottomTarget(rows, 'd')).toBeNull();
    expect(moveTopTarget(rows, 'g')).toEqual({ parent: 'a', previous: null });
    expect(moveBottomTarget(rows, 'f')).toEqual({ parent: 'a', previous: 'g' });
  });
});

describe('shared tasks, and where a task came from', () => {
  test("Google's assignment and links are read: a shared task from a Doc, an email added to Tasks, a Keep reminder", () => {
    const shared = toTaskItem({ id: 's1', title: 'Review the draft', assignmentInfo: { surfaceType: 'DOCUMENT', linkToTask: 'https://docs.google.com/document/d/x/edit?disco=1' } }, ME, 'L1')!;
    expect(shared.assigned).toEqual({ surface: 'document', link: 'https://docs.google.com/document/d/x/edit?disco=1' });
    const mailed = toTaskItem({ id: 'm1', title: 'Reply to Ann', links: [{ type: 'email', description: 'Quarterly numbers', link: 'https://mail.google.com/mail/#all/abc' }, { type: 'email', link: 'javascript:alert(1)' }] }, ME, 'L1')!;
    expect(mailed.links).toEqual([{ type: 'email', description: 'Quarterly numbers', link: 'https://mail.google.com/mail/#all/abc' }]);
    expect(taskOrigins(shared)).toEqual([{ label: 'Assigned in Google Docs', detail: '', url: 'https://docs.google.com/document/d/x/edit?disco=1' }]);
    expect(taskOrigins(mailed)).toEqual([{ label: 'From Gmail', detail: 'Quarterly numbers', url: 'https://mail.google.com/mail/#all/abc' }]);
    expect(taskOrigins({ links: [{ type: 'other', description: 'Groceries', link: 'https://keep.google.com/#NOTE/1' }] })[0]!.label).toBe('From Keep');
    expect(toTaskItem({ id: 'p1', title: 'Plain' }, ME, 'L1')).not.toHaveProperty('assigned');
  });

  test("a shared task neither repeats nor takes subtasks, as in Google Tasks", async () => {
    const shared = item({ id: 's1', assigned: { surface: 'space', link: null } });
    expect(repeatBlock(shared, [])).toBe(SHARED_NO_REPEAT);
    const fake = fakeClient(emptyState(), (method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [shared], complete: true } : method === 'POST' ? { task: item({ id: 'new' }) } : { tasks: [] }));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.loadBoard(ME, 'L1');
    await expect(store.addListTask(ME, 'L1', { title: 'Sub', parent: 's1' })).rejects.toThrow(SHARED_NO_SUBTASKS);
    const fields: TaskFields = { title: shared.title, notes: '', due: TODAY, kept: { time: null, duration: null, deadline: null, rule: 'RRULE:FREQ=DAILY' } };
    await expect(store.saveListTask(shared, fields)).rejects.toThrow(SHARED_NO_REPEAT);
    expect(fake.calls.filter((call) => call.method === 'POST' || call.method === 'PATCH')).toEqual([]);
  });
});

describe('Undo after Delete', () => {
  test("Google undeletes the task and its subtasks, and what the Planner kept for them comes back", async () => {
    const parent = item({ id: 'p', title: 'Trip' });
    const kid = item({ id: 'k', title: 'Hotel', parent: 'p' });
    const start = stateWith(keep('p', { time: 600, deadline: '2026-11-02', starred: true, color: '#d50000' }));
    const fake = fakeClient(start, (method, path) => (path.startsWith('/google/tasks/all') ? { tasks: [parent, kid], complete: true } : method === 'PATCH' ? { task: parent } : { deleted: true }));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.loadBoard(ME, 'L1');
    expect(store.canUndoDelete()).toBe(false);
    await store.deleteListTask(parent);
    expect(keptFor(fake.state(), parent)).toBeNull();
    expect(store.canUndoDelete()).toBe(true);
    expect(await store.undoDelete()).toBe(true);
    expect(fake.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
      { account: ME, listId: 'L1', id: 'p', deleted: false },
      { account: ME, listId: 'L1', id: 'k', deleted: false },
    ]);
    expect(keptFor(fake.state(), parent)).toMatchObject({ time: 600, deadline: '2026-11-02', color: '#d50000' });
    expect(keptFor(fake.state(), parent)!.starredAt).toBeTruthy();
    // Once.
    expect(await store.undoDelete()).toBe(false);
  });

  test('a repeating task deleted alone ("This task"): Undo deletes the next one its deletion made and gives this one back as it was', async () => {
    const template = templateOf({ title: 'Standup', notes: '' }, { time: 570, duration: null, deadline: null }, TODAY);
    const repeat = { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template };
    const today = item({ id: 's1', title: 'Standup', due: TODAY });
    const next = item({ id: 's2', title: 'Standup', due: '2026-10-30' });
    let state = stateWith(keep('s1', { time: 570, repeat }));
    const fake = fakeClient(state, (method, path, body) => {
      if (path === '/google/tasks/next') return { task: next, state: undefined };
      if (path.startsWith('/google/tasks/all')) return { tasks: [today], complete: true };
      if (method === 'PATCH') return { task: today };
      return { deleted: true, body };
    });
    // The service makes the next one (GoogleSeries) and answers with the plan: here, kept as the panel would adopt it.
    (fake.client as unknown as { adopt: () => Promise<void> }).adopt = async () => {};
    const store = new GoogleStore(host, fake.client, 'page');
    (store as unknown as { makeSuccessor: (one: GoogleTaskItem) => Promise<GoogleTaskItem> }).makeSuccessor = async () => {
      await fake.client.dispatch([keep('s1', { repeat: { ...repeat, next: 's2' } }), keep('s2', { time: 570, repeat: { ...repeat, index: 2, on: '2026-10-30' } })]);
      return next;
    };
    await store.deleteListTask(today, 'this');
    state = fake.state();
    expect(keptFor(state, next)).toBeTruthy();
    await store.undoDelete();
    const deletes = fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(deletes).toEqual([`/google/tasks?account=${encodeURIComponent(ME)}&list=L1&id=s1`, `/google/tasks?account=${encodeURIComponent(ME)}&list=L1&id=s2`]);
    expect(keptFor(fake.state(), next)).toBeNull();
    expect(keptFor(fake.state(), today)!.repeat).toMatchObject({ next: null, index: 1, on: TODAY });
  });
});

describe("Gmail's Add to Tasks", () => {
  test("a task in the account's default list, titled as the message, its link in the details", async () => {
    const fake = fakeClient(emptyState(), (method, path, body) => (path === '/google/tasklists' ? { lists: [{ account: ME, id: 'L2', title: 'Errands' }, { account: ME, id: 'L1', title: 'My Tasks', isDefault: true }], errors: [] } : method === 'POST' ? { task: item({ id: 'new', title: body.title, notes: body.notes }) } : { tasks: [] }));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.loadLists();
    const mail: MailItem = { account: ME, id: 'm1', threadId: 't1', subject: 'Quarterly numbers', from: 'Ann <ann@example.com>', date: '2026-10-29T10:00:00.000Z', snippet: '', unread: true, url: 'https://mail.google.com/mail/u/?authuser=me%40example.com#all/t1' };
    const added = await store.addMailToTasks(mail);
    expect(added.title).toBe('Quarterly numbers');
    expect(fake.calls.find((call) => call.method === 'POST' && call.path === '/google/tasks')!.body).toMatchObject({ account: ME, listId: 'L1', title: 'Quarterly numbers', notes: `From Gmail: ${mail.url}` });
  });
});

describe("Google Tasks' keyboard shortcuts", () => {
  const press = (key: string, where: 'task' | 'view' | 'outside', mods: Partial<KeyboardEvent> = {}) => {
    const row = { dataset: { task: 'gt1' } };
    const closest = (selector: string) => (selector === '.tasks-app' && where !== 'outside' ? {} : selector === 'li[data-task]' && where === 'task' ? row : null);
    const target = { tagName: 'BUTTON', isContentEditable: false, closest };
    return plannerKeeps({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target, ...mods } as unknown as KeyboardEvent, { surface: 'page', page: 'calendar', mac: false });
  };
  test("on a task the Planner keeps them from OpenChamber (indent, move, subtask), and the list and Undo anywhere in the Tasks view; elsewhere they are OpenChamber's", () => {
    for (const key of [']', '[', 'ArrowUp', 'ArrowDown', '/', 'z']) expect(press(key, 'task')).toBe(true);
    expect(press('Enter', 'task', { altKey: true })).toBe(true);
    for (const key of ['/', 'z']) expect(press(key, 'view')).toBe(true);
    for (const key of [']', '[', 'ArrowUp']) expect(press(key, 'view')).toBe(false);
    expect(press(']', 'outside')).toBe(false);
    expect(press('Tab', 'task')).toBe(false);
  });
  test('the list of them is Google\'s, with the two this surface cannot do and why', () => {
    expect(TASK_SHORTCUTS).toHaveLength(17);
    expect(TASK_SHORTCUTS.filter((shortcut) => shortcut.note).map((shortcut) => shortcut.action)).toEqual(['Print a task list', 'Report spam']);
  });
});
