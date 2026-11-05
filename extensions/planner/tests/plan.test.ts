// The plan end to end (Area A): tasks, days, rituals and history, through the real service and Planner windows made of
// the panel's own client (tests/support/planner.ts, plan.ts). Each test is one thing a user does: set up through the
// service, act through a window as the UI does (its commands, its Undo, the Add task field, the modals' Small Model),
// and check the plan, each window's view and what it said. Past findings kept here as steps: review 12's P0 (subtasks
// changed in two windows at once), review 13 (a subtask turned into a task keeps all it holds, and comes once), the
// Planner's own Undo in two windows, and a history packed at start (a first push to a sync remote timed out).
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateRequest } from '@openchamber/sdk';
import { addDays, instantAt, startOfWeek } from '../src/domain/core/dates.ts';
import { SUBTASKS_ONE_BY_ONE, SUBTASK_CHANGED, type EventBody } from '../src/domain/core/events.ts';
import { newId } from '../src/domain/core/ids.ts';
import { convertSubtaskCommands, mergeItemCommands, mergeTaskCommands } from '../src/domain/plan/merge.ts';
import { instanceId } from '../src/domain/plan/recurrence.ts';
import { positionAt, tasksForDay } from '../src/domain/core/selectors.ts';
import { reorderCommands, sortTasks, type SortKey } from '../src/domain/plan/sort.ts';
import { CHANGED_SINCE, UNDO_GONE } from '../src/domain/plan/undo.ts';
import type { PlannerState, Subtask, TaskSourceRef } from '../src/domain/core/types.ts';
import { parseMarkdown, type MdBlock, type MdInline } from '../panel/lib/core/markdown.ts';
import { startPlanner, until, usePlanner, type PlannerWindow } from './support/planner.ts';
import { ZONE, addTask, askPlanner, backlog, braindump, day, dayList, daysOf, holdable, makeTask, race, sub, undoAfter } from './support/plan.ts';

let model: (request: GenerateRequest) => string = () => '';
const planner = usePlanner({ zone: ZONE, generate: (request) => model(request) });

const taskTitled = (state: PlannerState, title: string) => Object.values(state.tasks).find((task) => task.title === title && !task.deletedAt);
const subtasksOf = (state: PlannerState, taskId: string) => state.tasks[taskId]!.subtasks;
const tick = (taskId: string, subtask: Subtask, done = true) => ({ type: 'subtask.updated', taskId, subtaskId: subtask.id, patch: { done }, seen: { done: !done } }) as EventBody;
const rename = (taskId: string, subtask: Subtask, title: string, seen = subtask.title) => ({ type: 'subtask.updated', taskId, subtaskId: subtask.id, patch: { title }, seen: { title: seen } }) as EventBody;
const remove = (taskId: string, subtask: Subtask, seen = subtask.title) => ({ type: 'subtask.deleted', taskId, subtaskId: subtask.id, seen: { title: seen } }) as EventBody;
/** What a window sends for a menu action: the window's own builder output, with Undo offered as the UI labels it. */
const send = (window: PlannerWindow, bodies: EventBody[] | string, undo?: string) => window.client.dispatch(typeof bodies === 'string' ? [] : bodies, undo ? { undo } : {});
const madeIn = (bodies: readonly EventBody[]) => (bodies.find((body) => body.type === 'task.created') as { task: { id: string } }).task.id;

describe('days', () => {
  test('open work from past days comes to the top of today when the Planner opens, oldest first, once a day; done and backlog work stays, work carried a week is archived, and a move by hand starts the count again', async () => {
    const { today, at } = await daysOf(planner);
    const id = { stale: newId(), old: newId(), first: newId(), second: newId(), done: newId(), now: newId(), later: newId() };
    const made = (taskId: string, title: string, placement = day(at(-1)), position = 1024) => ({ type: 'task.created', task: { id: taskId, title, placement, position } }) as EventBody;
    await planner.commands(
      made(id.stale, 'Roll stale', day(at(-8))),
      made(id.old, 'Roll old', day(at(-3))),
      made(id.first, 'Roll yesterday 1'),
      made(id.second, 'Roll yesterday 2', day(at(-1)), 2048),
      made(id.done, 'Roll done', day(at(-1)), 3072),
      { type: 'task.completed', taskId: id.done, on: at(-1) },
      made(id.now, 'Roll planned today', day(today), 999_999),
      made(id.later, 'Roll someday', { kind: 'backlog', bucket: 'someday' }),
    );
    const window = await planner.window();
    const plan = window.client.getView().state;
    expect(dayList(plan, today).filter((title) => title.startsWith('Roll '))).toEqual(['Roll old', 'Roll yesterday 1', 'Roll yesterday 2', 'Roll planned today']);
    expect([plan.tasks[id.old]!.rolloverCount, plan.tasks[id.first]!.rolloverCount]).toEqual([3, 1]);
    expect([plan.tasks[id.done]!.placement, plan.tasks[id.later]!.placement.kind]).toEqual([day(at(-1)), 'backlog']);
    // Seven days carried (the setting's default) is enough: archived where it was, not carried again.
    expect(plan.tasks[id.stale]).toMatchObject({ placement: day(at(-8)), archivedAt: expect.any(String) });
    // Once a day: looking again writes nothing.
    const version = plan.version;
    await window.client.refresh();
    expect((await planner.state()).version).toBe(version);
    await window.client.dispatch([{ type: 'task.moved', taskId: id.old, placement: day(at(1)), position: 1024 }]);
    expect((await planner.state()).tasks[id.old]).toMatchObject({ placement: day(at(1)), rolloverCount: 0 });
    // Its history (the task's Activity) has the rollover and the move.
    expect((await window.client.activity(id.old)).map((event) => event.type)).toEqual(['task.created', 'tasks.rolledOver', 'task.moved']);
  });

  test("a line typed in Add task gives the task its time, day, a new channel, priority and the week's objective; with none said, similar past work gives its time and channel; then renamed, dragged to the top, completed, reopened and deleted", async () => {
    const { today, tomorrow } = await daysOf(planner);
    const objective = newId();
    await planner.commands({ type: 'objective.created', objective: { id: objective, weekStart: startOfWeek(tomorrow, 1), title: 'Ship the launch', carriedFrom: null } });
    const insurance = await makeTask(planner, 'Renew the car insurance', day(today), { channelId: 'personal' });
    await planner.commands({ type: 'time.logged', entry: { id: newId(), taskId: insurance, start: instantAt(today, 540, ZONE), end: instantAt(today, 570, ZONE) } }, { type: 'task.completed', taskId: insurance, on: today });
    const window = await planner.window();
    await addTask(window, 'Write the launch post ~45m @tomorrow #launch !high $ship');
    await addTask(window, 'Renew car insurance');
    let plan = await planner.state();
    const post = taskTitled(plan, 'Write the launch post')!;
    expect(post).toMatchObject({ plannedMinutes: 45, placement: day(tomorrow), priority: 'high', objectiveId: objective });
    expect(plan.channels[post.channelId!]?.name).toBe('launch');
    expect(taskTitled(plan, 'Renew car insurance')).toMatchObject({ plannedMinutes: 30, channelId: 'personal', placement: day(today) });

    await window.client.dispatch([{ type: 'task.updated', taskId: post.id, patch: { title: 'Write the launch post (draft)' } }]);
    await window.client.dispatch([{ type: 'task.moved', taskId: post.id, placement: day(tomorrow), position: positionAt(window.client.getView().state, day(tomorrow), 0, post.id) }]);
    expect(dayList(await planner.state(), tomorrow)[0]).toBe('Write the launch post (draft)');
    await window.client.dispatch([{ type: 'task.completed', taskId: post.id, on: today }]);
    expect((await planner.state()).tasks[post.id]!.completedOn).toBe(today);
    await window.client.dispatch([{ type: 'task.reopened', taskId: post.id }]);
    await window.client.dispatch([{ type: 'task.deleted', taskId: post.id }]);
    plan = await planner.state();
    expect(plan.tasks[post.id]).toMatchObject({ completedAt: null, deletedAt: expect.any(String) });
    expect(dayList(plan, tomorrow)).not.toContain('Write the launch post (draft)');
  });

  test('one timer runs at a time: starting another task stops the first, starting the running one again changes nothing, completing its task stops it; time logged by hand counts until deleted, and an entry ending before it starts is refused', async () => {
    const { today } = await daysOf(planner);
    const [a, b] = [await makeTask(planner, 'Timer A', day(today)), await makeTask(planner, 'Timer B', day(today))];
    const entries = (state: PlannerState, taskId: string) => Object.values(state.entries).filter((entry) => entry.taskId === taskId);
    const window = await planner.window();
    await window.client.dispatch([{ type: 'timer.started', taskId: a }]);
    await window.client.dispatch([{ type: 'timer.started', taskId: b }]);
    let plan = await planner.state();
    const startedB = plan.timer!.startedAt;
    expect(plan.timer!.taskId).toBe(b);
    expect(entries(plan, a)).toEqual([expect.objectContaining({ source: 'timer', end: startedB })]);
    await window.client.dispatch([{ type: 'timer.started', taskId: b }]);
    expect((await planner.state()).timer?.startedAt).toBe(startedB);
    await window.client.dispatch([{ type: 'task.completed', taskId: b, on: today }]);
    plan = await planner.state();
    expect([plan.timer, entries(plan, b).length]).toEqual([null, 1]);

    const entry = newId();
    await window.client.dispatch([{ type: 'time.logged', entry: { id: entry, taskId: a, start: instantAt(today, 540, ZONE), end: instantAt(today, 580, ZONE) } }]);
    expect((await planner.state()).entries[entry]).toMatchObject({ taskId: a, source: 'manual', start: instantAt(today, 540, ZONE) });
    await window.client.dispatch([{ type: 'time.deleted', entryId: entry }]);
    expect((await planner.state()).entries[entry]).toBeUndefined();
    await window.client.dispatch([{ type: 'time.logged', entry: { id: newId(), taskId: a, start: instantAt(today, 600, ZONE), end: instantAt(today, 540, ZONE) } }]);
    expect(window.client.getView().error).toBe('an entry must last between 0 and 24 hours');
  });

  test("a task repeating every day shows on today and the coming week with its subtasks; one deleted stays deleted, stopping ends the rest; yesterday's, untouched, gives way to today's, and one worked on rolls over beside it", async () => {
    const { today, yesterday, tomorrow, at } = await daysOf(planner);
    // Made yesterday and set to repeat (the task's Repeat → Every day, from its template), as the Planner had it then.
    const repeat = (title: string, extra: Record<string, unknown> = {}): [string, string, EventBody[]] => {
      const [task, series] = [newId(), newId()];
      const subtasks = [sub('Email'), sub('Slack')];
      const template = { title, notes: '', plannedMinutes: 15, priority: null, channelId: null, subtasks: subtasks.map((item) => item.title) };
      return [task, series, [
        { type: 'task.created', task: { id: task, title, placement: day(yesterday), position: 1024, plannedMinutes: 15, subtasks } },
        { type: 'series.created', series: { id: series, rule: { freq: 'daily', interval: 1 }, startDate: yesterday, template }, taskId: task },
        ...(extra.notes ? [{ type: 'task.updated', taskId: task, patch: { notes: extra.notes } } as EventBody] : []),
      ] as EventBody[]];
    };
    const [inbox, inboxSeries, makeInbox] = repeat('Inbox zero');
    const [notes, notesSeries, makeNotes] = repeat('Stand-up notes', { notes: 'Started on this' });
    await planner.commands(...makeInbox, ...makeNotes);
    const live = (state: PlannerState, series: string) => Object.values(state.tasks).filter((task) => task.recurrence?.seriesId === series && !task.deletedAt);
    let plan = await planner.state();
    expect(live(plan, inboxSeries).map((task) => task.recurrence!.date).sort()).toEqual(Array.from({ length: 8 }, (_, index) => at(index)));
    expect(plan.tasks[instanceId(inboxSeries, today)]).toMatchObject({ title: 'Inbox zero', plannedMinutes: 15, subtasks: [{ title: 'Email', done: false }, { title: 'Slack', done: false }] });
    expect(plan.tasks[inbox]!.deletedAt).toBeTruthy();
    expect(plan.tasks[notes]).toMatchObject({ placement: day(today), rolloverCount: 1, deletedAt: null });
    expect(dayList(plan, today).filter((title) => title === 'Stand-up notes')).toHaveLength(2);

    const window = await planner.window();
    await window.client.dispatch([{ type: 'task.deleted', taskId: instanceId(inboxSeries, at(2)) }]);
    await window.client.refresh();
    expect(live(await planner.state(), inboxSeries).map((task) => task.recurrence!.date)).not.toContain(at(2));
    // Stop repeating (from tomorrow), as the Repeat section stops it: the series, and its instances from then on.
    const upcoming = live(window.client.getView().state, inboxSeries).filter((task) => task.recurrence!.date >= tomorrow);
    await window.client.dispatch([{ type: 'series.stopped', seriesId: inboxSeries, from: tomorrow }, ...upcoming.map((task) => ({ type: 'task.deleted', taskId: task.id }) as EventBody)]);
    await window.client.refresh();
    plan = await planner.state();
    expect(live(plan, inboxSeries).map((task) => task.recurrence!.date)).toEqual([today]);
    expect(live(plan, notesSeries).length).toBe(9);
  });

  test('a task repeating on weekdays shows on every weekday of the coming week and on no weekend; one repeating on the last day of the month, only on last days', async () => {
    const { today, at } = await daysOf(planner);
    const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
    const lastOfMonth = (date: string) => addDays(date, 1).slice(8) === '01';
    const horizon = Array.from({ length: 8 }, (_, index) => at(index));
    // Each series starts on a day of its own rule, as the Repeat section starts one from the task's day.
    const series = (title: string, rule: Record<string, unknown>, startDate: string): [string, EventBody[]] => {
      const [task, id] = [newId(), newId()];
      return [id, [
        { type: 'task.created', task: { id: task, title, placement: day(startDate), position: 1024 } },
        { type: 'series.created', series: { id, rule, startDate, template: { title, notes: '', plannedMinutes: null, priority: null, channelId: null, subtasks: [] } }, taskId: task },
      ] as EventBody[]];
    };
    const firstWeekday = horizon.find((date) => weekday(date) >= 1 && weekday(date) <= 5)!;
    const monthEnd = (() => {
      let date = today;
      while (!lastOfMonth(date)) date = addDays(date, 1);
      return date;
    })();
    const [standUp, makeStandUp] = series('Stand-up', { freq: 'daily', interval: 1, weekdays: [1, 2, 3, 4, 5] }, firstWeekday);
    const [books, makeBooks] = series('Close the books', { freq: 'monthly', interval: 1, monthDay: -1 }, monthEnd);
    await planner.commands(...makeStandUp, ...makeBooks);
    const dates = (state: PlannerState, id: string) => Object.values(state.tasks).filter((task) => task.recurrence?.seriesId === id && !task.deletedAt).map((task) => task.recurrence!.date).sort();
    const plan = await planner.state();
    expect(dates(plan, standUp)).toEqual(horizon.filter((date) => date >= firstWeekday && weekday(date) >= 1 && weekday(date) <= 5));
    expect(dates(plan, books)).toContain(monthEnd);
    expect(dates(plan, books).every(lastOfMonth)).toBe(true);
  });

  test("the week's objectives: a task aligned, the objective completed and renamed, continued into next week; deleted, its tasks stay, unaligned; the day's rituals save field by field, and a field a ritual does not have is refused", async () => {
    const { today } = await daysOf(planner);
    const week = startOfWeek(today, 1);
    const [ship, next] = [newId(), newId()];
    const window = await planner.window();
    await window.client.dispatch([{ type: 'objective.created', objective: { id: ship, weekStart: week, title: 'Ship the planner', carriedFrom: null } }]);
    const aligned = await makeTask(planner, 'Rituals UI', day(today), { objectiveId: ship });
    await window.client.refresh();
    await window.client.dispatch([{ type: 'objective.updated', objectiveId: ship, patch: { completed: true, title: ' Ship it ' } }]);
    await window.client.dispatch([{ type: 'objective.created', objective: { id: next, weekStart: addDays(week, 7), title: 'Ship it', carriedFrom: ship } }]);
    let plan = await planner.state();
    expect(plan.objectives[ship]).toMatchObject({ title: 'Ship it', completedAt: expect.any(String) });
    expect(plan.objectives[next]).toMatchObject({ weekStart: addDays(week, 7), carriedFrom: ship });
    await window.client.dispatch([{ type: 'objective.deleted', objectiveId: ship }]);
    plan = await planner.state();
    expect(plan.objectives[ship]!.deletedAt).toBeTruthy();
    expect(plan.tasks[aligned]).toMatchObject({ objectiveId: null, deletedAt: null });

    const done = new Date().toISOString();
    await window.client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date: today, fields: { obstacles: 'meetings' } }]);
    await window.client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date: today, fields: { completedAt: done } }]);
    await window.client.dispatch([{ type: 'ritual.saved', ritual: 'highlights', date: today, fields: { items: [{ id: newId(), text: 'Shipped the rituals', taskId: aligned, starred: true }] } }]);
    plan = await planner.state();
    expect(plan.rituals[`planning:${today}`]).toEqual({ obstacles: 'meetings', completedAt: done });
    expect(plan.rituals[`highlights:${today}`]!.items).toEqual([expect.objectContaining({ text: 'Shipped the rituals', taskId: aligned, starred: true })]);
    await window.client.dispatch([{ type: 'ritual.saved', ritual: 'planning', date: today, fields: { reflection: 'x' } } as EventBody]);
    expect(window.client.getView().error).toBe('planning has no field reflection');
  });

  test('a backlog folder keeps its tasks while they move in the backlog, and a task scheduled on a day leaves it; deleting a folder or a channel keeps their tasks', async () => {
    const { today } = await daysOf(planner);
    const [folder, errands] = [newId(), newId()];
    const window = await planner.window();
    await window.client.dispatch([{ type: 'folder.created', folder: { id: folder, name: ' Reading ' } }, { type: 'channel.created', channel: { id: errands, name: 'errands', color: '#2f9e44', context: 'personal' } }]);
    const [paper, book] = [await makeTask(planner, 'Read the paper', { kind: 'backlog', bucket: 'someday' }, { folderId: folder }), await makeTask(planner, 'Read the book', backlog, { folderId: folder, channelId: errands })];
    await window.client.refresh();
    await window.client.dispatch([{ type: 'task.moved', taskId: paper, placement: { kind: 'backlog', bucket: 'next-month' }, position: 1 }]);
    expect((await planner.state()).tasks[paper]!.folderId).toBe(folder);
    await window.client.dispatch([{ type: 'task.moved', taskId: paper, placement: day(today), position: 1 }]);
    await window.client.dispatch([{ type: 'folder.deleted', folderId: folder }, { type: 'channel.deleted', channelId: errands }]);
    const plan = await planner.state();
    expect([plan.folders[folder]!.name, plan.tasks[paper]!.folderId]).toEqual(['Reading', null]);
    expect(plan.tasks[book]).toMatchObject({ folderId: null, channelId: null, deletedAt: null });
  });

  test("a day's list sorted from its menu, by priority, planned time or completed last, keeps ties in order; Undo puts the old order back, and a list already sorted writes nothing", async () => {
    const date = (await daysOf(planner)).at(9);
    const ids = [await makeTask(planner, 'Sort low', day(date), { priority: 'low', plannedMinutes: 15 }), await makeTask(planner, 'Sort urgent', day(date), { priority: 'urgent', plannedMinutes: 60 }), await makeTask(planner, 'Sort plain', day(date))];
    const window = await planner.window();
    const sort = (key: SortKey) => window.client.dispatch(reorderCommands(sortTasks(tasksForDay(window.client.getView().state, date), key)), { undo: 'List sorted' });
    await sort('priority');
    expect(dayList(await planner.state(), date)).toEqual(['Sort urgent', 'Sort low', 'Sort plain']);
    await window.client.undo();
    expect(dayList(await planner.state(), date)).toEqual(['Sort low', 'Sort urgent', 'Sort plain']);
    await sort('planned');
    expect(dayList(await planner.state(), date)).toEqual(['Sort urgent', 'Sort low', 'Sort plain']);
    await window.client.dispatch([{ type: 'task.completed', taskId: ids[1]!, on: date }]);
    await sort('completed-last');
    expect(dayList(await planner.state(), date)).toEqual(['Sort low', 'Sort plain', 'Sort urgent']);
    const version = (await planner.state()).version;
    await sort('completed-last');
    expect((await planner.state()).version).toBe(version);
  });
});

describe("one task's subtasks changed in two windows at once (review 12's P0; window A's commands held on their way)", () => {
  const setup = async (...names: string[]) => {
    const subtasks = names.map((name) => sub(name));
    const taskId = await makeTask(planner, 'Two windows', day((await daysOf(planner)).today), { subtasks });
    return { taskId, subtasks, a: await holdable(planner), b: await planner.window() };
  };

  test("the reviewer's case and its probes: A ticks one while B adds one, ticks another or the same, or A renames one B ticks: all of it is kept, in the service and both windows, and nobody is asked", async () => {
    const { taskId, subtasks: [childA, childB], a, b } = await setup('child A', 'child B');
    const added = sub('review12-newly-accepted-subtask');
    const first = await race(planner, a, b, [tick(taskId, childA!)], [{ type: 'subtask.added', taskId, subtask: added }]);
    expect(subtasksOf(first.service, taskId)).toEqual([{ ...childA!, done: true }, childB!, added]);
    expect([subtasksOf(first.a.state, taskId), subtasksOf(first.b.state, taskId)]).toEqual([subtasksOf(first.service, taskId), subtasksOf(first.service, taskId)]);
    expect([first.told, first.a.error, first.b.error]).toEqual([{ a: [], b: [] }, null, null]);
    const told = [
      (await race(planner, a, b, [tick(taskId, added)], [tick(taskId, childB!)])).told,
      (await race(planner, a, b, [tick(taskId, childA!, false)], [tick(taskId, childA!, false)])).told,
      (await race(planner, a, b, [rename(taskId, childB!, 'child B, renamed in A')], [tick(taskId, childB!, false)])).told,
    ];
    expect(told).toEqual([{ a: [], b: [] }, { a: [], b: [] }, { a: [], b: [] }]);
    expect(subtasksOf(await planner.state(), taskId)).toEqual([childA!, { ...childB!, title: 'child B, renamed in A' }, { ...added, done: true }]);
  });

  test('a delete or rename meeting a subtask renamed or deleted elsewhere since is refused whole: A is told what it is now and shows theirs, and Save mine acts on it as it is now; a whole list from an older window is refused, so their add stays', async () => {
    const { taskId, subtasks: [childA, childB, childC], a, b } = await setup('child A', 'child B', 'child C');
    const version = (await planner.state()).version;
    const deleted = await race(planner, a, b, [remove(taskId, childB!)], [rename(taskId, childB!, 'child B, renamed in B')]);
    expect((await planner.state()).version - version).toBe(1);
    expect(deleted.told).toEqual({ a: [{ taskId, subtaskId: childB!.id, now: { ...childB!, title: 'child B, renamed in B' } }], b: [] });
    expect([deleted.a.error, subtasksOf(deleted.a.state, taskId)[1]!.title]).toEqual([null, 'child B, renamed in B']);
    await a.client.dispatch([remove(taskId, childB!, 'child B, renamed in B')]);
    expect(subtasksOf(await planner.state(), taskId).map((subtask) => subtask.title)).toEqual(['child A', 'child C']);

    const renamed = await race(planner, a, b, [rename(taskId, childA!, 'A, renamed in A')], [rename(taskId, childA!, 'A, renamed in B')]);
    expect([renamed.told.a[0]?.now?.title, subtasksOf(renamed.service, taskId)[0]!.title]).toEqual(['A, renamed in B', 'A, renamed in B']);
    const same = await race(planner, a, b, [rename(taskId, childC!, 'the same')], [rename(taskId, childC!, 'the same')]);
    expect(same.told).toEqual({ a: [], b: [] });
    const gone = await race(planner, a, b, [tick(taskId, childC!)], [remove(taskId, childC!, 'the same')]);
    expect([gone.told.a, subtasksOf(gone.service, taskId).map((subtask) => subtask.id)]).toEqual([[{ taskId, subtaskId: childC!.id, now: null }], [childA!.id]]);

    // As the service answers it: 409, what the subtask is now and the plan as it is; nothing of the batch written.
    const made = newId();
    const answer = await planner.call('POST', '/commands', { commands: [{ cmd: newId(), type: 'task.created', task: { id: made, title: 'child A', placement: backlog, position: 1 } }, { cmd: newId(), ...remove(taskId, childA!) }] });
    expect([answer.status, answer.body.error, answer.body.index, answer.body.conflict.now.title, answer.body.state.tasks[made]]).toEqual([409, SUBTASK_CHANGED, 1, 'A, renamed in B', undefined]);
    // A window from before subtask commands sends the whole list as it read it: refused, and B's add stays.
    const seenByA = subtasksOf(a.client.getView().state, taskId);
    const theirs = sub('added in B');
    await b.client.dispatch([{ type: 'subtask.added', taskId, subtask: theirs }]);
    const stale = await planner.call('POST', '/commands', { commands: [{ cmd: newId(), type: 'task.updated', taskId, patch: { subtasks: seenByA.map((subtask) => ({ ...subtask, done: true })) } }] });
    expect([stale.status, stale.body.error]).toEqual([400, SUBTASKS_ONE_BY_ONE]);
    expect(subtasksOf(await planner.state(), taskId).map((subtask) => subtask.title)).toContain('added in B');
  });

  test('turning a subtask into a task keeps all it holds (review 13): its notes, planned time, link of any kind and done (completed today), in its task\'s channel, folder and objective, right after it; Undo puts the subtask back whole', async () => {
    const { today } = await daysOf(planner);
    const [channel, folder, objective] = [newId(), newId(), newId()];
    await planner.commands(
      { type: 'channel.created', channel: { id: channel, name: 'deep', color: '#2f9e44', context: 'work' } },
      { type: 'folder.created', folder: { id: folder, name: 'Harness folder' } },
      { type: 'objective.created', objective: { id: objective, weekStart: startOfWeek(today, 1), title: 'Convert it all', carriedFrom: null } },
    );
    const sources: TaskSourceRef[] = [
      { kind: 'linear', id: 'iss-h-1', key: 'HAR-1', url: 'https://linear.app/harness/issue/HAR-1/x', title: 'harness first', teamId: 'team-h', status: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' }, workspaceId: 'org-h' },
      { kind: 'github', id: 'I_harness_1', key: 'harness/app#1', url: 'https://github.com/harness/app/issues/1', title: 'harness issue', status: { name: 'Open', type: 'open', color: '#2da44e' } },
      { kind: 'gtask', id: 'g-harness-1', key: 'Google Tasks', url: 'https://tasks.google.com/task/g-harness-1', title: 'harness google task', account: 'harness@example.com', listId: 'list-1' },
      { kind: 'email', id: 'm-harness-1', key: 'Gmail', url: 'https://mail.google.com/mail/u/0/#all/t-harness-1', title: 'harness email', account: 'harness@example.com' },
      { kind: 'link', id: 'https://example.com/harness', key: 'example.com', url: 'https://example.com/harness', title: 'harness page' },
    ];
    const merged: Subtask[] = [...sources.map((source, index) => sub(`merged ${source.kind}`, { done: index % 2 === 1, notes: `notes of ${source.kind}`, plannedMinutes: 15 * (index + 1), source })), sub('plain one', { done: true })];
    const parent = await makeTask(planner, 'Convert parent', backlog, { channelId: channel, folderId: folder, objectiveId: objective, subtasks: merged });
    const window = await planner.window();
    for (const subtask of merged) {
      const bodies = convertSubtaskCommands(window.client.getView().state, parent, subtask.id, newId, today);
      await window.client.dispatch(bodies, { undo: 'Converted to a task' });
      const plan = await planner.state();
      const made = plan.tasks[madeIn(bodies)]!;
      expect({ notes: made.notes, plannedMinutes: made.plannedMinutes, source: made.source, completedOn: made.completedOn }).toEqual({ notes: subtask.notes ?? '', plannedMinutes: subtask.plannedMinutes ?? null, source: subtask.source ?? null, completedOn: subtask.done ? today : null });
      expect([made.channelId, made.folderId, made.objectiveId, made.placement]).toEqual([channel, folder, objective, backlog]);
      const list = Object.values(plan.tasks).filter((task) => !task.deletedAt && task.placement.kind === 'backlog' && task.placement.bucket === 'next-weeks').sort((x, y) => x.position - y.position).map((task) => task.id);
      expect(list.indexOf(made.id)).toBe(list.indexOf(parent) + 1);
      expect(subtasksOf(plan, parent).some((item) => item.id === subtask.id)).toBe(false);
    }
    // The last one's Undo: the subtask back as it was, the task it became gone.
    await window.client.undo();
    expect(subtasksOf(await planner.state(), parent)).toEqual([merged.at(-1)!]);
  });

  test("a subtask becomes one task at most: turned into a task in both windows at once, the other is told which task it became; after another window deleted it, or by a window from before another's conversion, it is refused", async () => {
    const { today } = await daysOf(planner);
    const { taskId, subtasks: [childA, childB, childC], a, b } = await setup('child A', 'child B', 'child C');
    const convert = (window: PlannerWindow, subtask: Subtask) => convertSubtaskCommands(window.client.getView().state, taskId, subtask.id, newId, today);
    const [mine, theirs] = [convert(a, childB!), convert(b, childB!)];
    const both = await race(planner, a, b, mine, theirs);
    const live = (state: PlannerState) => [madeIn(mine), madeIn(theirs)].filter((id) => state.tasks[id] && !state.tasks[id]!.deletedAt);
    expect(live(both.service)).toEqual([madeIn(theirs)]);
    expect(both.told).toEqual({ a: [{ taskId, subtaskId: childB!.id, now: null, became: madeIn(theirs) }], b: [] });
    expect([live(both.a.state), live(both.b.state)]).toEqual([[madeIn(theirs)], [madeIn(theirs)]]);

    const conversion = convert(a, childA!);
    const deleted = await race(planner, a, b, conversion, [remove(taskId, childA!)]);
    expect(deleted.service.tasks[madeIn(conversion)]).toBeUndefined();
    expect(deleted.told.a).toEqual([{ taskId, subtaskId: childA!.id, now: null }]);
    // A window from before conversions named their task: its batch is the task, then a delete that does not name it.
    const older = [{ type: 'task.created', task: { id: newId(), title: 'child C', placement: day(today), position: 4096 } }, remove(taskId, childC!)] as EventBody[];
    const afterTheirs = await race(planner, a, b, older, convert(b, childC!));
    expect(afterTheirs.service.tasks[madeIn(older)]).toBeUndefined();
    expect(afterTheirs.told.a[0]?.now).toBeNull();
  });
});

describe("the Planner's own Undo, with another window changing things meanwhile", () => {
  test("a move is undone while nothing it puts back was changed (another window's rename stays); moved again there first, the Undo leaves theirs, writes nothing, says so, and this window shows theirs", async () => {
    const { today, tomorrow } = await daysOf(planner);
    const t = await makeTask(planner, 'Undo move', day(today));
    const move = [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 2048 }] as EventBody[];
    const plain = await undoAfter(planner, move, 'Task moved');
    expect([plain.offered, plain.said, plain.state.tasks[t]!.placement]).toEqual(['Task moved', null, day(today)]);
    const renamed = await undoAfter(planner, move, 'Task moved', [{ type: 'task.updated', taskId: t, patch: { title: 'Undo move, renamed there' } }]);
    expect([renamed.said, renamed.state.tasks[t]!.placement, renamed.state.tasks[t]!.title]).toEqual([null, day(today), 'Undo move, renamed there']);
    const moved = await undoAfter(planner, move, 'Task moved', [{ type: 'task.moved', taskId: t, placement: backlog, position: 1 }]);
    expect([moved.said, moved.written, moved.state.tasks[t]!.placement, moved.a.client.getView().state.tasks[t]!.placement]).toEqual([CHANGED_SINCE, 0, backlog, backlog]);
  });

  test("an Undo that would drop or overwrite another window's work since is not done, whatever the action: nothing is written, theirs stays, and it says so", async () => {
    const { today, tomorrow, at } = await daysOf(planner);
    const at9 = (date: string, minutes = 540) => ({ start: instantAt(date, minutes, ZONE), end: instantAt(date, minutes + 60, ZONE) });
    const cases: Array<() => Promise<{ act: EventBody[]; label: string; theirs: EventBody[]; kept: (state: PlannerState) => unknown; expected: unknown }>> = [
      async () => {
        const t = await makeTask(planner, 'Undo timeboxed there', day(today));
        const block = newId();
        return { act: [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], label: 'Task moved', theirs: [{ type: 'block.created', block: { id: block, taskId: t, ...at9(tomorrow) } }], kept: (s) => [s.tasks[t]!.placement, Boolean(s.blocks[block])], expected: [day(tomorrow), true] };
      },
      async () => {
        const t = await makeTask(planner, 'Undo archived', day(today));
        return { act: [{ type: 'task.archived', taskId: t }], label: 'Task archived', theirs: [{ type: 'task.deleted', taskId: t }], kept: (s) => Boolean(s.tasks[t]!.deletedAt), expected: true };
      },
      async () => {
        const t = await makeTask(planner, 'Undo completed', day(today));
        return { act: [{ type: 'task.completed', taskId: t, on: today }], label: 'Task completed', theirs: [{ type: 'task.reopened', taskId: t }, { type: 'task.completed', taskId: t, on: tomorrow }], kept: (s) => s.tasks[t]!.completedOn, expected: tomorrow };
      },
      async () => {
        const t = newId();
        return { act: [{ type: 'task.created', task: { id: t, title: 'Undo added', placement: day(today), position: 9999 } }], label: 'Task added', theirs: [{ type: 'task.updated', taskId: t, patch: { title: 'Undo added, renamed there' } }], kept: (s) => [s.tasks[t]!.title, s.tasks[t]!.deletedAt], expected: ['Undo added, renamed there', null] };
      },
      async () => {
        const t = newId();
        return { act: [{ type: 'task.created', task: { id: t, title: 'Undo added, timed', placement: day(today), position: 9999 } }], label: 'Task added', theirs: [{ type: 'timer.started', taskId: t }], kept: (s) => [s.timer?.taskId, s.tasks[t]!.deletedAt], expected: [t, null] };
      },
      async () => {
        const ids = [await makeTask(planner, 'Undo estimate 1', day(today)), await makeTask(planner, 'Undo estimate 2', day(today))];
        return { act: ids.map((id) => ({ type: 'task.updated', taskId: id, patch: { plannedMinutes: 30 } }) as EventBody), label: 'Estimates filled', theirs: [{ type: 'task.updated', taskId: ids[0]!, patch: { plannedMinutes: 45 } }], kept: (s) => ids.map((id) => s.tasks[id]!.plannedMinutes), expected: [45, 30] };
      },
      async () => {
        const [t, block] = [await makeTask(planner, 'Undo timebox', day(today)), newId()];
        return { act: [{ type: 'block.created', block: { id: block, taskId: t, ...at9(today) } }], label: 'Timeboxed', theirs: [{ type: 'block.updated', blockId: block, ...at9(today, 600) }], kept: (s) => s.blocks[block]?.start, expected: instantAt(today, 600, ZONE) };
      },
      async () => {
        const t = await makeTask(planner, 'Undo session removed', day(today));
        const block = newId();
        await planner.commands({ type: 'block.created', block: { id: block, taskId: t, ...at9(today, 480) } });
        return { act: [{ type: 'block.deleted', blockId: block }], label: 'Session removed', theirs: [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], kept: (s) => [s.tasks[t]!.placement, s.blocks[block]], expected: [day(tomorrow), undefined] };
      },
      async () => {
        const source = { kind: 'github' as const, id: 'gh-undo-1', key: 'harness/repo#1', url: 'https://github.com/harness/repo/issues/1' };
        const t = await makeTask(planner, 'Undo linked', day(today), { source });
        return { act: [{ type: 'task.updated', taskId: t, patch: { source: null } }], label: 'Link removed', theirs: [{ type: 'task.updated', taskId: t, patch: { source: { ...source, id: 'gh-undo-2', key: 'harness/repo#2', url: 'https://github.com/harness/repo/issues/2' } } }], kept: (s) => s.tasks[t]!.source?.id, expected: 'gh-undo-2' };
      },
      async () => {
        const ids = [await makeTask(planner, 'Undo sort c', day(at(3))), await makeTask(planner, 'Undo sort a', day(at(3)))];
        return { act: ids.map((id, index) => ({ type: 'task.moved', taskId: id, placement: day(at(3)), position: (2 - index) * 1024 }) as EventBody), label: 'List sorted', theirs: [{ type: 'task.moved', taskId: ids[1]!, placement: day(tomorrow), position: 1 }], kept: (s) => s.tasks[ids[1]!]!.placement, expected: day(tomorrow) };
      },
      async () => {
        const [objective, other] = [newId(), newId()];
        await planner.commands({ type: 'objective.created', objective: { id: objective, weekStart: today, title: 'Undo objective', carriedFrom: null } }, { type: 'objective.created', objective: { id: other, weekStart: today, title: 'Undo other objective', carriedFrom: null } });
        const t = await makeTask(planner, 'Undo aligned', day(today), { objectiveId: objective });
        return { act: [{ type: 'objective.deleted', objectiveId: objective }], label: 'Objective deleted', theirs: [{ type: 'task.updated', taskId: t, patch: { objectiveId: other } }], kept: (s) => [Boolean(s.objectives[objective]!.deletedAt), s.tasks[t]!.objectiveId], expected: [true, other] };
      },
      async () => {
        const [target, dragged] = [await makeTask(planner, 'Undo merge target', day(today)), await makeTask(planner, 'Undo merged in', day(today))];
        const window = await planner.window();
        const act = mergeTaskCommands(window.client.getView().state, dragged, target, newId) as EventBody[];
        const merged = (act[0] as { subtask: Subtask }).subtask;
        return { act, label: 'Merged into "Undo merge target"', theirs: [tick(target, merged)], kept: (s) => [subtasksOf(s, target)[0]!.done, Boolean(s.tasks[dragged]!.deletedAt)], expected: [true, true] };
      },
      async () => {
        const child = sub('Undo sub two');
        const parent = await makeTask(planner, 'Undo parent', day(today), { subtasks: [sub('Undo sub one'), child] });
        const window = await planner.window();
        const act = convertSubtaskCommands(window.client.getView().state, parent, child.id, newId, today);
        return { act, label: 'Converted to a task', theirs: [{ type: 'task.updated', taskId: madeIn(act), patch: { title: 'Undo sub two, renamed there' } }], kept: (s) => [subtasksOf(s, parent).length, s.tasks[madeIn(act)]!.deletedAt], expected: [1, null] };
      },
      async () => {
        const middle = sub('Undo middle');
        const t = await makeTask(planner, 'Undo ticked', day(today), { subtasks: [sub('Undo first'), middle] });
        return { act: [tick(t, middle)], label: 'Subtask checked off', theirs: [remove(t, middle)], kept: (s) => subtasksOf(s, t).map((item) => item.title), expected: ['Undo first'] };
      },
    ];
    for (const make of cases) {
      const { act, label, theirs, kept, expected } = await make();
      const result = await undoAfter(planner, act, label, theirs);
      expect([label, result.offered, result.said, result.written, kept(result.state)]).toEqual([label, label, CHANGED_SINCE, 0, expected]);
    }
  });

  test('what the service and the sources write is no change of anyone\'s: a planned issue\'s state synced, a session written to Google Calendar, another subtask ticked, a subtask added to a merge target: each Undo goes ahead, and theirs stays', async () => {
    const { today } = await daysOf(planner);
    const issue = { kind: 'linear' as const, id: 'iss-undo-1', key: 'UNDO-1', url: 'https://linear.app/harness/issue/UNDO-1/x', status: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' } };
    const planned = newId();
    const synced = await undoAfter(planner, [{ type: 'task.created', task: { id: planned, title: 'Undo planned issue', placement: day(today), position: 9998, source: issue } }], 'Planned UNDO-1', [{ type: 'task.sourceSynced', taskId: planned, source: { ...issue, status: { name: 'In Progress', type: 'started', color: '#f2c94c' } }, dueDate: today }]);
    expect([synced.said, Boolean(synced.state.tasks[planned]!.deletedAt)]).toEqual([null, true]);

    const [boxed, block] = [await makeTask(planner, 'Undo timebox linked', day(today)), newId()];
    const linked = await undoAfter(planner, [{ type: 'block.created', block: { id: block, taskId: boxed, start: instantAt(today, 540, ZONE), end: instantAt(today, 600, ZONE) } }], 'Timeboxed', [{ type: 'block.linked', blockId: block, google: { account: 'harness@example.com', calendarId: 'primary', eventId: 'evt1' } }]);
    expect(linked.said).toBeNull();
    expect(linked.state.blocks[block]).toBeUndefined();

    const subtasks = [sub('Undo one'), sub('Undo two'), sub('Undo three')];
    const parent = await makeTask(planner, 'Undo convert parent', day(today), { subtasks });
    const window = await planner.window();
    const convert = convertSubtaskCommands(window.client.getView().state, parent, subtasks[1]!.id, newId, today);
    const ticked = await undoAfter(planner, convert, 'Converted to a task', [tick(parent, subtasks[2]!)]);
    expect([ticked.said, subtasksOf(ticked.state, parent), Boolean(ticked.state.tasks[madeIn(convert)]!.deletedAt)]).toEqual([null, [subtasks[0]!, subtasks[1]!, { ...subtasks[2]!, done: true }], true]);

    const [target, dragged] = [await makeTask(planner, 'Undo merge into', day(today), { subtasks: [sub('Undo kept')] }), await makeTask(planner, 'Undo dragged', day(today))];
    await window.client.refresh();
    const theirs = sub('Undo added there');
    const merge = await undoAfter(planner, mergeTaskCommands(window.client.getView().state, dragged, target, newId) as EventBody[], 'Merged into "Undo merge into"', [{ type: 'subtask.added', taskId: target, subtask: theirs }]);
    expect([merge.said, subtasksOf(merge.state, target).map((item) => item.title), merge.state.tasks[dragged]!.deletedAt]).toEqual([null, ['Undo kept', 'Undo added there'], null]);
  });

  test('an Undo puts back all its action took: each kind of change; the sessions a move off the day dropped, and its planned time; a task deleted from the archive back to the archive; one moved from a folder back in its folder; an objective with its tasks aligned; a deleted subtask where it was', async () => {
    const { today, tomorrow } = await daysOf(planner);
    const [a, b, c] = [await makeTask(planner, 'Back A', day(today), { priority: 'low', plannedMinutes: 15 }), await makeTask(planner, 'Back B', day(today), { priority: 'urgent' }), await makeTask(planner, 'Back C', day(today))];
    const shape = (state: PlannerState) => [a, b, c].map((id) => { const { placement, position, title, deletedAt, archivedAt, completedOn, priority, subtasks } = state.tasks[id]!; return { placement, position, title, deletedAt, archivedAt, completedOn, priority, subtasks }; });
    const before = shape(await planner.state());
    for (const [label, act] of [
      ['Task moved', [{ type: 'task.moved', taskId: a, placement: { kind: 'backlog', bucket: 'someday' }, position: 5 }]],
      ['Task deleted', [{ type: 'task.deleted', taskId: b }]],
      ['Task completed', [{ type: 'task.completed', taskId: c, on: today }]],
      ['Task edited', [{ type: 'task.updated', taskId: a, patch: { title: 'Back A2', priority: 'high' } }, { type: 'subtask.added', taskId: a, subtask: sub('step') }]],
      ['Archived', [{ type: 'task.archived', taskId: c }, { type: 'task.moved', taskId: b, placement: day(tomorrow), position: 1 }]],
    ] as Array<[string, EventBody[]]>) {
      const result = await undoAfter(planner, act, label);
      expect([label, result.said, shape(result.state)]).toEqual([label, null, before]);
    }

    const t = await makeTask(planner, 'Back with sessions', day(today), { plannedMinutes: 45 });
    const block = newId();
    await planner.commands({ type: 'block.created', block: { id: block, taskId: t, start: instantAt(today, 480, ZONE), end: instantAt(today, 540, ZONE) } });
    const planned = (await planner.state()).tasks[t]!.plannedMinutes;
    const moved = await undoAfter(planner, [{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], 'Task moved');
    expect([moved.state.blocks[block]?.start, moved.state.tasks[t]!.placement, moved.state.tasks[t]!.plannedMinutes]).toEqual([instantAt(today, 480, ZONE), day(today), planned]);

    const archived = await makeTask(planner, 'Back to the archive', day(today));
    await planner.commands({ type: 'task.archived', taskId: archived });
    const deleted = await undoAfter(planner, [{ type: 'task.deleted', taskId: archived }], 'Task deleted');
    expect([deleted.state.tasks[archived]!.deletedAt, Boolean(deleted.state.tasks[archived]!.archivedAt)]).toEqual([null, true]);
    const folder = newId();
    await planner.commands({ type: 'folder.created', folder: { id: folder, name: 'Back folder' } });
    const filed = await makeTask(planner, 'Back filed', backlog, { folderId: folder });
    const scheduled = await undoAfter(planner, [{ type: 'task.moved', taskId: filed, placement: day(today), position: 1 }], 'Moved to today');
    expect(scheduled.state.tasks[filed]).toMatchObject({ placement: backlog, folderId: folder });

    const objective = newId();
    await planner.commands({ type: 'objective.created', objective: { id: objective, weekStart: today, title: 'Back objective', carriedFrom: null } });
    const aligned = await makeTask(planner, 'Back aligned', day(today), { objectiveId: objective });
    const restored = await undoAfter(planner, [{ type: 'objective.deleted', objectiveId: objective }], 'Objective deleted');
    expect([restored.offered, restored.state.objectives[objective]!.deletedAt, restored.state.tasks[aligned]!.objectiveId]).toEqual(['Objective deleted', null, objective]);

    const subtasks = [sub('Back first'), sub('Back last')];
    const parent = await makeTask(planner, 'Back subtasks', day(today), { subtasks });
    for (const subtask of subtasks) {
      const result = await undoAfter(planner, [remove(parent, subtask)], 'Subtask deleted');
      expect(subtasksOf(result.state, parent).map((item) => item.title)).toEqual(['Back first', 'Back last']);
    }
  });

  test("a window's Undo ends once it changes the same thing again (never saying another window did), not on a sync; clicked before its action reached the service, it waits its turn; deleting a channel offers none", async () => {
    const { today, tomorrow } = await daysOf(planner);
    const t = await makeTask(planner, 'Undo own change', day(today));
    const window = await planner.window();
    await window.client.dispatch([{ type: 'task.moved', taskId: t, placement: day(tomorrow), position: 1 }], { undo: 'Task moved' });
    await window.client.dispatch([{ type: 'task.updated', taskId: t, patch: { notes: 'Typed after the move' } }]);
    await window.client.dispatch([{ type: 'task.updated', taskId: t, patch: { notes: 'A sync' } }], { origin: 'linear' });
    expect(window.client.getView().undoLabel).toBe('Task moved');
    await window.client.dispatch([{ type: 'task.moved', taskId: t, placement: backlog, position: 1 }]);
    expect(window.client.getView().undoLabel).toBeNull();

    const quick = await makeTask(planner, 'Undo quick', day(today));
    await window.client.refresh();
    void window.client.dispatch([{ type: 'task.moved', taskId: quick, placement: day(tomorrow), position: 1 }], { undo: 'Task moved' });
    await window.client.undo();
    expect([window.client.getView().error, (await planner.state()).tasks[quick]!.placement]).toEqual([null, day(today)]);

    const channel = newId();
    await window.client.dispatch([{ type: 'channel.created', channel: { id: channel, name: 'undo-channel', color: '#2f9e44', context: 'work' } }]);
    await window.client.dispatch([{ type: 'channel.deleted', channelId: channel }], { undo: 'Channel deleted' });
    expect(window.client.getView().undoLabel).toBeNull();
  });

  test('the service keeps an Undo once, and only for a batch offered with it: another, or one never offered, is no longer possible (410); a refused one answers what changed and the plan (409); a step no longer valid, a session deleted since, refuses it', async () => {
    const { today, tomorrow, at } = await daysOf(planner);
    const t = await makeTask(planner, 'Undo once', day(today));
    const moveCommand = (cmd: string, date = tomorrow) => ({ cmd, type: 'task.moved', taskId: t, placement: day(date), position: 1 });
    const [offered, notOffered] = [newId(), newId()];
    await planner.call('POST', '/commands', { commands: [moveCommand(offered)], undo: true });
    expect((await planner.call('POST', '/undo', { batch: offered })).status).toBe(200);
    const again = await planner.call('POST', '/undo', { batch: offered });
    expect([again.status, again.body.error]).toEqual([410, UNDO_GONE]);
    await planner.call('POST', '/commands', { commands: [moveCommand(notOffered, at(2))] });
    expect((await planner.call('POST', '/undo', { batch: notOffered })).status).toBe(410);

    const moved = newId();
    await planner.call('POST', '/commands', { commands: [moveCommand(moved)], undo: true });
    await planner.commands({ type: 'task.moved', taskId: t, placement: backlog, position: 1 });
    const refused = await planner.call('POST', '/undo', { batch: moved });
    expect([refused.status, refused.body.error, refused.body.changed, refused.body.state.tasks[t].placement]).toEqual([409, CHANGED_SINCE, [`tasks/${t}/placement`], backlog]);

    const [block, update] = [newId(), newId()];
    await planner.commands({ type: 'block.created', block: { id: block, taskId: t, start: instantAt(today, 540, ZONE), end: instantAt(today, 600, ZONE) } });
    await planner.call('POST', '/commands', { commands: [{ cmd: update, type: 'block.updated', blockId: block, start: instantAt(today, 660, ZONE), end: instantAt(today, 720, ZONE) }], undo: true });
    await planner.commands({ type: 'block.deleted', blockId: block });
    const invalid = await planner.call('POST', '/undo', { batch: update });
    expect([invalid.status, invalid.body.changed]).toEqual([409, ['unknown block']]);
  });
});

describe('merging tasks', () => {
  test("Alt/Option + drop merges a task into another as a subtask with its notes (its own subtasks as a checklist), planned time and link, and the task goes; Undo takes it back; an item dropped from a panel merges in linked, once; Convert to task gives the task back right after its task, with all it kept", async () => {
    const { today } = await daysOf(planner);
    const source: TaskSourceRef = { kind: 'linear', id: 'L-merge-1', key: 'NEX-1', url: 'https://linear.app/acme/issue/NEX-1', title: 'NEX-1 Fix the crash', status: { name: 'Todo', type: 'unstarted', color: '#999' } };
    const triage = await makeTask(planner, 'Merge triage', day(today));
    const issue = await makeTask(planner, 'NEX-1 Fix the crash', day(today), { notes: 'Repro: open twice', plannedMinutes: 45, source, subtasks: [sub('Write a test', { done: true })] });
    const window = await planner.window();
    const drop = () => send(window, mergeTaskCommands(window.client.getView().state, issue, triage, newId), 'Merged into "Merge triage"');
    await drop();
    let plan = await planner.state();
    expect(subtasksOf(plan, triage)).toEqual([{ id: expect.any(String), title: 'NEX-1 Fix the crash', done: false, notes: 'Repro: open twice\n\n- [x] Write a test', plannedMinutes: 45, source }]);
    expect([Boolean(plan.tasks[issue]!.deletedAt), window.client.getView().undoLabel]).toEqual([true, 'Merged into "Merge triage"']);
    await window.client.undo();
    plan = await planner.state();
    expect([subtasksOf(plan, triage), plan.tasks[issue]!.deletedAt]).toEqual([[], null]);

    await drop();
    const item = { title: 'Quarterly numbers', source: { kind: 'link' as const, id: 'https://example.com/q3', key: 'example.com', url: 'https://example.com/q3', title: 'Quarterly numbers' } };
    await send(window, mergeItemCommands(window.client.getView().state, triage, item, newId), 'Merged into "Merge triage"');
    await send(window, mergeItemCommands(window.client.getView().state, triage, item, newId), 'Merged into "Merge triage"');
    plan = await planner.state();
    expect(subtasksOf(plan, triage).map((subtask) => [subtask.title, subtask.source?.kind])).toEqual([['NEX-1 Fix the crash', 'linear'], ['Quarterly numbers', 'link']]);
    const convert = convertSubtaskCommands(plan, triage, subtasksOf(plan, triage)[0]!.id, newId, today);
    await window.client.dispatch(convert, { undo: 'Converted to a task' });
    plan = await planner.state();
    const back = plan.tasks[madeIn(convert)]!;
    expect([back.title, back.notes, back.plannedMinutes, back.source?.key, back.placement]).toEqual(['NEX-1 Fix the crash', 'Repro: open twice\n\n- [x] Write a test', 45, 'NEX-1', day(today)]);
    const list = dayList(plan, today);
    expect(list.indexOf('NEX-1 Fix the crash')).toBe(list.indexOf('Merge triage') + 1);
  });

  test('">" in Add task merges the new task into the open task it names, with its planned time, in one step Undo takes back; when no open task matches, it is a task of its own and the Planner says so', async () => {
    const { today } = await daysOf(planner);
    const triage = await makeTask(planner, 'Mailbox triage', day(today));
    const window = await planner.window();
    await addTask(window, 'Reply to Ann ~10m >mailbox tri');
    let plan = await planner.state();
    expect(subtasksOf(plan, triage).map((subtask) => [subtask.title, subtask.plannedMinutes, subtask.done])).toEqual([['Reply to Ann', 10, false]]);
    expect([taskTitled(plan, 'Reply to Ann'), window.client.getView().undoLabel]).toEqual([undefined, 'Merged into "Mailbox triage"']);
    await window.client.undo();
    plan = await planner.state();
    expect([subtasksOf(plan, triage), taskTitled(plan, 'Reply to Ann')]).toEqual([[], undefined]);
    await addTask(window, 'Call the bank >groceries');
    expect(window.client.getView().error).toBe('No open task matches "groceries": added it as its own task');
    expect(taskTitled(await planner.state(), 'Call the bank')?.placement).toEqual(day(today));
  });
});

describe("the Small Model's answers are read strictly (only what they say well is applied)", () => {
  test('Braindump with the Small Model adds its items as it read them, a time over ten hours, an unknown channel and an empty title dropped; an answer that is not a list makes each line a task, read as Add task reads it', async () => {
    const { tomorrow } = await daysOf(planner);
    const window = await planner.window();
    model = () => 'Here you go:\n[{"title":"Call the bank about the card","minutes":15,"when":"tomorrow","channel":"Personal"},{"title":"","minutes":5},{"title":"Fix the flaky login test","minutes":9999,"when":"next-month","channel":"ops","priority":"high"}]';
    await braindump(window, 'call the bank about the card\nfix the flaky login test, it takes forever');
    let plan = await planner.state();
    expect(taskTitled(plan, 'Call the bank about the card')).toMatchObject({ plannedMinutes: 15, placement: day(tomorrow), channelId: 'personal' });
    expect(taskTitled(plan, 'Fix the flaky login test')).toMatchObject({ plannedMinutes: null, placement: { kind: 'backlog', bucket: 'next-month' }, channelId: null, priority: 'high' });
    expect([taskTitled(plan, ''), window.client.getView().undoLabel]).toEqual([undefined, 'Added 2 tasks']);
    model = () => 'no json here';
    await braindump(window, '- renew the passport ~15m @tomorrow #personal\n\n2. water the plants !high');
    plan = await planner.state();
    expect(taskTitled(plan, 'renew the passport')).toMatchObject({ plannedMinutes: 15, placement: day(tomorrow), channelId: 'personal' });
    expect(taskTitled(plan, 'water the plants')).toMatchObject({ priority: 'high', placement: backlog });
  });

  test('Ask Planner applies only known operations on known tasks: one on a task that is not there, a delete and an unknown channel are dropped; the model was given the plan by task id; Undo takes the rest back; an answer it cannot read changes nothing', async () => {
    const { today, tomorrow } = await daysOf(planner);
    const gym = await makeTask(planner, 'Gym session', day(today), { plannedMinutes: 60 });
    const report = await makeTask(planner, 'Weekly report', backlog, { channelId: 'work' });
    const window = await planner.window();
    let prompt = '';
    model = (request) => {
      prompt = request.prompt;
      return `Sure! {"reply":"Moved the gym.","ops":[{"op":"move","taskId":"${gym}","when":"tomorrow"},{"op":"move","taskId":"ghost","when":"tomorrow"},{"op":"delete","taskId":"${report}"},{"op":"create","title":"Stretch","when":"today","minutes":10,"channel":"WORK"},{"op":"estimate","taskId":"${report}","minutes":45},{"op":"channel","taskId":"${gym}","channel":"nope"},{"op":"move","taskId":"${report}","when":"someday"}]}`;
    };
    expect(await askPlanner(window, 'Move the gym to tomorrow')).toBe('Moved the gym.');
    expect(prompt).toContain(`- [${gym}] Gym session (1:00)`);
    let plan = await planner.state();
    expect(plan.tasks[gym]).toMatchObject({ placement: day(tomorrow), channelId: null });
    expect(plan.tasks[report]).toMatchObject({ deletedAt: null, plannedMinutes: 45, placement: { kind: 'backlog', bucket: 'someday' } });
    expect(taskTitled(plan, 'Stretch')).toMatchObject({ placement: day(today), plannedMinutes: 10, channelId: 'work' });
    expect(window.client.getView().undoLabel).toBe('Assistant made 4 changes');
    await window.client.undo();
    plan = await planner.state();
    expect([plan.tasks[gym]!.placement, plan.tasks[report]!.plannedMinutes, plan.tasks[report]!.placement, taskTitled(plan, 'Stretch')]).toEqual([day(today), null, backlog, undefined]);
    model = () => 'no json';
    const version = plan.version;
    expect(await askPlanner(window, 'Anything')).toBeNull();
    expect((await planner.state()).version).toBe(version);
  });
});

describe('the plan on disk', () => {
  test('the plan outlives the service: a restart keeps it and rolls nothing over twice; a command sent twice applies once; a bad command, or one only the service writes, rejects its whole batch; a torn last line is skipped and said; an older Planner\'s log replays as it did; a history left loose is packed at start', async () => {
    const { today, yesterday } = await daysOf(planner);
    const kept = await makeTask(planner, 'Survives a restart', day(yesterday));
    const once = { cmd: newId(), type: 'task.created', task: { id: newId(), title: 'Sent twice', placement: backlog, position: 1 } };
    const answers = [await planner.call('POST', '/commands', { commands: [once] }), await planner.call('POST', '/commands', { commands: [once] })];
    expect(answers.map((answer) => answer.body.applied)).toEqual([1, 0]);
    const fine = newId();
    const bad = await planner.call('POST', '/commands', { commands: [{ cmd: newId(), type: 'task.created', task: { id: fine, title: 'Fine', placement: day(today), position: 1 } }, { cmd: newId(), type: 'task.completed', taskId: 'missing', on: today }] });
    expect([bad.status, bad.body]).toEqual([400, { error: 'unknown task', index: 1 }]);
    const serviceOnly = await planner.call('POST', '/commands', { commands: [{ cmd: newId(), type: 'tasks.rolledOver', date: today, moved: [], archived: [] }] });
    expect([serviceOnly.status, serviceOnly.body.error]).toEqual([400, 'tasks.rolledOver is written by the service only']);
    const before = await planner.state();
    expect(before.tasks[fine]).toBeUndefined();

    await planner.restart();
    const after = await planner.state();
    expect([after.version, after.tasks[kept]!.placement, after.tasks[kept]!.rolloverCount, after.settings.timezone]).toEqual([before.version, day(today), 1, ZONE]);

    // A crash mid-write left half a line: skipped, said, the rest loads; and an older Planner's log (whole subtask
    // lists, conversions without the task they made) replays as it did, then subtasks change one by one.
    const data = join(planner.home, 'data');
    appendFileSync(join(data, 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), '{"v":1,"id":"torn","at":');
    const [old, older, ta, tb] = [newId(), newId(), newId(), newId()];
    let clock = Date.parse('2026-09-30T15:00:00Z');
    const line = (body: Record<string, unknown>) => JSON.stringify({ v: 1, id: `old${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body });
    const task = (id: string, title: string, subtasks: unknown[] = []) => ({ type: 'task.created', task: { id, title, placement: backlog, position: 1, subtasks } });
    writeFileSync(join(data, 'events', '2026-09.jsonl'), [
      line(task(old, 'Old lists', [{ id: 'a', title: 'Alpha', done: false }])),
      line({ type: 'task.updated', taskId: old, patch: { subtasks: [{ id: 'a', title: 'Alpha', done: true }, { id: 'b', title: 'Beta', done: false }] } }),
      line({ type: 'task.updated', taskId: old, patch: { subtasks: [{ id: 'b', title: 'Beta renamed', done: false }] } }),
      line(task(older, 'Old conversions', [{ id: 'a2', title: 'Alpha', done: true }, { id: 'b2', title: 'Beta', done: false }])),
      line(task(ta, 'Alpha')),
      line({ type: 'task.updated', taskId: older, patch: { subtasks: [{ id: 'b2', title: 'Beta', done: false }] } }),
      line({ type: 'subtask.deleted', taskId: older, subtaskId: 'b2', seen: { title: 'Beta' } }),
      line(task(tb, 'Beta')),
      line({ type: 'subtask.deleted', taskId: older, subtaskId: 'b2', seen: { title: 'Beta' } }),
    ].join('\n') + '\n');
    await planner.restart();
    const snapshot = (await planner.call('GET', '/state')).body;
    expect([snapshot.storage.skippedLines, snapshot.state.tasks[kept].title]).toEqual([1, 'Survives a restart']);
    expect([subtasksOf(snapshot.state, old).map((item) => item.title), subtasksOf(snapshot.state, older)]).toEqual([['Beta renamed'], []]);
    expect([ta, tb].map((id) => [snapshot.state.tasks[id].title, snapshot.state.tasks[id].completedAt])).toEqual([['Alpha', null], ['Beta', null]]);
    const window = await planner.window();
    await window.client.dispatch([{ type: 'subtask.added', taskId: old, subtask: { id: 'c', title: 'Gamma', done: false } }, tick(old, { id: 'b', title: 'Beta renamed', done: false })]);
    expect(subtasksOf(await planner.state(), old)).toEqual([{ id: 'b', title: 'Beta renamed', done: true }, { id: 'c', title: 'Gamma', done: false }]);

    // As older Planners left a long history: hundreds of loose objects (here on a side ref), packed when it starts.
    // With an identity of its own: a machine without one (CI) refuses commit-tree.
    const git = (...args: string[]) => execFileSync('git', ['-C', data, '-c', 'user.name=Planner e2e', '-c', 'user.email=e2e@example.invalid', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const count = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(git('count-objects', '-v'))?.[1]);
    const blobs = mkdtempSync(join(tmpdir(), 'planner-loose-'));
    const files = Array.from({ length: 300 }, (_, index) => join(blobs, `b${index}`));
    files.forEach((file, index) => writeFileSync(file, `loose ${index}\n`));
    const shas = git('hash-object', '-w', ...files).trim().split('\n');
    const tree = execFileSync('git', ['-C', data, 'mktree'], { input: shas.map((sha, index) => `100644 blob ${sha}\tb${index}`).join('\n') + '\n', encoding: 'utf8' }).trim();
    git('update-ref', 'refs/planner-test/loose', git('commit-tree', tree, '-m', 'loose history').trim());
    rmSync(blobs, { recursive: true, force: true });
    expect(count('count')).toBeGreaterThan(256);
    await planner.restart();
    expect(await until(() => count('packs') >= 1 && count('count') < 256, 15_000)).toBe(true);
    // Intact once the service's `gc --auto` after the repack is through (a history broken for good never passes).
    const intact = () => {
      try {
        return git('fsck', '--no-progress') === '';
      } catch {
        return false;
      }
    };
    expect(await until(intact, 10_000, 100)).toBe(true);
  }, 30_000);

  // Found by this suite (2026-11-05): the store appended after a torn last line without ending it first, so the first
  // event written after the crash joined the torn line, and the next start skipped it with it.
  test('an event written after a crash tore the last line is still there after the next restart', async () => {
    appendFileSync(join(planner.home, 'data', 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), '{"v":1,"id":"torn-again","at":');
    await planner.restart();
    const id = await makeTask(planner, 'Written after a crash', backlog);
    await planner.restart();
    const snapshot = (await planner.call('GET', '/state')).body;
    expect(snapshot.state.tasks[id]?.title).toBe('Written after a crash');
    expect(snapshot.storage.skippedLines).toBeGreaterThanOrEqual(1);
  });

  test('two machines share one plan through a git remote: work from both sides merges, also written in the same month before syncing, and the plans converge with one of each default channel; the same day rolled over on both counts once; a bad remote is refused, and one that is not there says so and changes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-remote-'));
    const remote = join(root, 'plan.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    const [a, b] = await Promise.all([startPlanner({ zone: ZONE }), startPlanner({ zone: ZONE })]);
    try {
      const { today, at } = await daysOf(a);
      const [wa, wb] = [await a.window(), await b.window()];
      await wa.client.setRemote(remote);
      await wb.client.setRemote(remote);
      const add = (window: PlannerWindow, title: string) => window.client.dispatch([{ type: 'task.created', task: { id: newId(), title, placement: day(today), position: 1024 } }]);
      await add(wa, 'From machine A');
      await wa.client.syncNow();
      await add(wb, 'From machine B');
      await wb.client.syncNow();
      expect(taskTitled(wb.client.getView().state, 'From machine A')).toBeDefined();
      await add(wa, 'A again');
      await add(wb, 'B again');
      for (const window of [wb, wa, wb]) await window.client.syncNow();
      const titles = (window: PlannerWindow) => Object.values(window.client.getView().state.tasks).map((task) => task.title).sort();
      expect(titles(wa)).toEqual(['A again', 'B again', 'From machine A', 'From machine B']);
      expect(titles(wb)).toEqual(titles(wa));
      expect([Object.keys(wa.client.getView().state.channels).sort(), wa.client.getView().sync?.lastError]).toEqual([['personal', 'work'], null]);

      // Both had a task planned two days ago (synced then), and both open today: each rolls it over, once in all.
      const carried = newId();
      const event = JSON.stringify({ v: 1, id: newId(Date.now() - 3 * 86_400_000), at: new Date(Date.now() - 3 * 86_400_000).toISOString(), type: 'task.created', task: { id: carried, title: 'Carried on both', placement: day(at(-2)), position: 1024 } });
      for (const machine of [a, b]) appendFileSync(join(machine.home, 'data', 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`), `${event}\n`);
      await Promise.all([a.restart(), b.restart()]);
      // Each opens: its own rollover, before either syncs.
      await Promise.all([a.state(), b.state()]);
      for (const window of [wa, wb, wa]) await window.client.syncNow();
      for (const window of [wa, wb]) expect(window.client.getView().state.tasks[carried]).toMatchObject({ placement: day(today), rolloverCount: 2 });

      await expect(wb.client.setRemote('--upload-pack=evil')).rejects.toThrow();
      await wb.client.setRemote(join(root, 'missing.git'));
      const version = (await b.state()).version;
      await wb.client.syncNow();
      expect(wb.client.getView().sync?.lastError).toBeTruthy();
      expect((await b.state()).version).toBe(version);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// Rubric 3, not end to end: notes from Linear, GitHub and Gmail, written by others, are drawn from this tree in the
// browser, and no scenario without a browser reaches the drawing. That they can't run script, link anywhere but the web
// or mail, or load an image is a security property, worth its own cases.
describe('Markdown in notes is drawn from a safe tree (security)', () => {
  const inlines = (blocks: MdBlock[]): MdInline[] =>
    blocks.flatMap((block): MdInline[] => {
      const walk = (nodes: MdInline[]): MdInline[] => nodes.flatMap((node) => [node, ...('children' in node ? walk(node.children) : [])]);
      if (block.kind === 'heading' || block.kind === 'paragraph') return walk(block.children);
      if (block.kind === 'quote') return inlines(block.children);
      if (block.kind === 'list') return block.items.flatMap((item) => inlines(item.children));
      if (block.kind === 'table') return [...block.header, ...block.rows.flat()].flatMap(walk);
      return [];
    });

  test('raw HTML stays text, inline and as a block; only web and mail links survive; images become links, never loaded', () => {
    const { blocks } = parseMarkdown('Hi <img src=x onerror=alert(1)> there\n\n<div onclick="x()">block</div>\n\nSee [docs](https://example.com/docs), [bad](javascript:alert(1)), [data](data:text/html,<b>x</b>), [mail](mailto:me@example.com), [rel](/relative) and <https://auto.example>\n\n![screen](https://uploads.linear.app/a.png) ![x](javascript:1)');
    const nodes = inlines(blocks);
    const text = nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).toContain('<div onclick="x()">block</div>');
    expect(nodes.flatMap((node) => (node.kind === 'link' ? [node.href] : []))).toEqual(['https://example.com/docs', 'mailto:me@example.com', 'https://auto.example']);
    expect(text).toContain('bad');
    expect(nodes.filter((node) => node.kind === 'image')).toEqual([{ kind: 'image', href: 'https://uploads.linear.app/a.png', alt: 'screen' }, { kind: 'image', href: null, alt: 'x' }]);
    expect(new Set(nodes.map((node) => node.kind))).toEqual(new Set(['text', 'link', 'image']));
  });
});
