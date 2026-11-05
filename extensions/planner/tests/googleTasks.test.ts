// Google Tasks in the Planner, end to end: the real service signed in to the fake Google, and Planner windows (the
// panel's own client and Google store) doing what the Tasks view, the calendar and Home do. A Google task and the
// Planner task planning it stay in step (moves followed, a failed read never taken for "nothing there", writes to the
// list it is in now); completing a task completes its subtasks, however cold the window; a repeating task's next
// occurrence is made once, whatever the windows race, and never confused with a lookalike; This task / All tasks,
// one upcoming task changed or deleted alone, "This and following tasks" and "All tasks"; an edit Google refuses
// changes nothing, and Save again applies it once; forms saved against what they showed (Keep theirs / Save mine);
// Undo after Delete and after completing; merged Google tasks; what the Planner keeps for a task (color, Drive files,
// Do not disturb, declining meetings); and task notifications, lent to the window that takes them until it shows them.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FreshnessError, listKey, OCCURRENCE_KEEPS_DATE, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, REPEATING_STAYS, SHARED_NO_REPEAT, SHARED_NO_SUBTASKS, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT, TaskConflict } from '../panel/lib/google.ts';
import { startTaskNotifications } from '../panel/lib/notifications.ts';
import { instantAt, todayIn, zonedDateMinutes } from '../src/domain/dates.ts';
import type { EventBody } from '../src/domain/events.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { settleConflicts } from '../src/domain/gtaskForm.ts';
import { newId } from '../src/domain/ids.ts';
import { mergeTaskCommands } from '../src/domain/merge.ts';
import type { DateKey, TaskAttachment } from '../src/domain/types.ts';
import { DEFAULT_SCOPES, defaultFakeWorld, fakeAuthCode } from './e2e/fakeGoogle.mjs';
import { usePlanner, type Planner } from './support/planner.ts';
import {
  addDays,
  addInGoogle,
  calendarOf,
  changeInGoogle,
  daytimeZone,
  deleteInGoogle,
  dueOf,
  failing,
  fields,
  heads,
  idle,
  inGoogle,
  keptOf,
  lines,
  moveInGoogle,
  occurrenceShown,
  openTitled,
  openWindow,
  sent,
  shownIn,
  taskWrites,
  until,
  upcomingOn,
  type TasksWindow,
} from './support/googleTasks.ts';

const zone = daytimeZone();
const today = todayIn(zone);
const ME = 'harness@example.com';
const DAILY = 'RRULE:FREQ=DAILY';
const day = (n: number) => addDays(today, n);
const at = (n: number) => `${day(n)}T00:00:00.000Z`;
/** The journeys' fake Google, its lists read in pages of 20 tasks (Google's are 100) so a scenario's many tasks read quickly. */
const world = (patch: Partial<ReturnType<typeof defaultFakeWorld>> = {}) => {
  const base = defaultFakeWorld({ zone, today });
  return { ...base, pageSize: { ...base.pageSize, lists: 10, tasks: 20 }, ...patch };
};
const doc = (id: string, title: string): TaskAttachment => ({ id, title, mimeType: 'application/vnd.google-apps.document', url: `https://docs.google.com/document/d/${id}/edit` });

/** The task as Google has it now, as the service reads it (what a window's next read shows). */
const taskNow = async (window: TasksWindow, listId: string, id: string): Promise<GoogleTaskItem> => {
  const answer = await window.client.call<{ tasks: GoogleTaskItem[] }>('POST', '/google/tasks/linked', { groups: [{ account: ME, listId, ids: [id] }] });
  const found = answer.tasks.find((task) => task.id === id);
  if (!found) throw new Error(`Google has no ${id}`);
  return found;
};
/** The open task of the series with this title, as Google has it. */
const openOne = async (planner: Planner, window: TasksWindow, title: string): Promise<GoogleTaskItem> => {
  const [one, ...more] = openTitled(planner, title);
  if (!one || more.length) throw new Error(`${openTitled(planner, title).length} open "${title}" tasks`);
  return taskNow(window, one.listId, one.id);
};
const kept = async (planner: Planner, id: string) => keptOf(await planner.state(), ME, id);
const plannedFor = (window: TasksWindow, googleId: string) => Object.values(window.client.getView().state.tasks).find((task) => task.source?.id === googleId && !task.deletedAt)!;
const plan = async (window: TasksWindow, item: GoogleTaskItem) => {
  await window.google.planTask(item, { kind: 'day', date: today });
  return plannedFor(window, item.id);
};
const creates = (planner: Planner, listId: string, from = 0) => taskWrites(planner, from).filter((request) => request.method === 'POST' && request.path === `/tasks/v1/lists/${listId}/tasks`);
const newList = async (window: TasksWindow, title: string) => (await window.google.createList(ME, title)).id;
const daily = async (planner: Planner, window: TasksWindow, listId: string, title: string, extra: Record<string, unknown> = {}) => {
  const first = await window.google.addListTask(ME, listId, { title, notes: 'Series notes', due: today }, { time: 540, rule: DAILY, ...extra });
  return { first, seriesId: (await kept(planner, first.id))!.repeat!.seriesId };
};

describe('a Google task and the Planner task planning it', () => {
  const planner = usePlanner({ google: world(), zone });

  test("moved to another list in the Tasks view or in Google's own apps (under a new id too): the Planner task and what is kept for it follow, and writes go to the list it is in now", async () => {
    const w = await openWindow(planner);
    // Dragged to Errands in the Tasks view, a deadline kept for it.
    const invoice = await w.google.addListTask(ME, 'L1', { title: 'Send the invoice', notes: 'To Ann', due: today });
    const planned = await plan(w, invoice);
    await w.google.setKept(invoice, { deadline: day(4) });
    await w.google.loadBoard(ME, 'L1');
    await w.google.moveListTask(invoice, { parent: null, previous: null }, 'L2');
    expect(inGoogle(planner, invoice.id)?.listId).toBe('L2');
    expect(w.client.getView().state.tasks[planned.id]!.source).toMatchObject({ id: invoice.id, listId: 'L2' });
    expect(await kept(planner, invoice.id)).toMatchObject({ listId: 'L2', deadline: day(4) });
    // Completed in Home: completed in Google, in Errands.
    let mark = planner.google!.requests.length;
    await w.client.dispatch([{ type: 'task.completed', taskId: planned.id, on: today }]);
    expect(await until(() => inGoogle(planner, invoice.id)?.status === 'completed')).toBe(true);
    expect(taskWrites(planner, mark).map((request) => request.path)).toEqual([`/tasks/v1/lists/L2/tasks/${invoice.id}`]);

    // Moved in Google's own apps: a read finds it in the other list; the link and its kept time follow.
    const lease = await w.google.addListTask(ME, 'L1', { title: 'Renew the lease', due: today }, { time: 600 });
    const leasePlanned = await plan(w, lease);
    moveInGoogle(planner, lease.id, 'L2');
    await w.google.sync();
    expect(w.client.getView().state.tasks[leasePlanned.id]!.source?.listId).toBe('L2');
    expect(await kept(planner, lease.id)).toMatchObject({ listId: 'L2', time: 600 });

    // Moved there and renamed here before any read: the write misses in My Tasks, finds it in Errands once, and goes there.
    const visa = await w.google.addListTask(ME, 'L1', { title: 'Apply for the visa', due: today });
    const visaPlanned = await plan(w, visa);
    moveInGoogle(planner, visa.id, 'L2');
    mark = planner.google!.requests.length;
    await w.client.dispatch([{ type: 'task.updated', taskId: visaPlanned.id, patch: { title: 'Apply for the visa today' } }]);
    expect(await until(() => inGoogle(planner, visa.id)?.title === 'Apply for the visa today')).toBe(true);
    expect(taskWrites(planner, mark).map((request) => `${request.method} ${request.path}`)).toEqual([`PATCH /tasks/v1/lists/L1/tasks/${visa.id}`, `PATCH /tasks/v1/lists/L2/tasks/${visa.id}`]);
    expect(await until(() => w.client.getView().state.tasks[visaPlanned.id]!.source?.listId === 'L2')).toBe(true);

    // Moved under a new id: the one open task elsewhere that reads as it did is followed; two such are not guessed between.
    const keys = await w.google.addListTask(ME, 'L1', { title: 'Copy the keys', notes: 'Two sets', due: today });
    const keysPlanned = await plan(w, keys);
    moveInGoogle(planner, keys.id, 'L2', 'moved-keys');
    const card = await w.google.addListTask(ME, 'L1', { title: 'Post the card', due: today });
    const cardPlanned = await plan(w, card);
    deleteInGoogle(planner, card.id);
    addInGoogle(planner, 'L2', { id: 'card-a', title: 'Post the card', due: at(0) });
    addInGoogle(planner, 'L2', { id: 'card-b', title: 'Post the card', due: at(0) });
    await w.google.sync();
    expect(w.client.getView().state.tasks[keysPlanned.id]!.source).toMatchObject({ id: 'moved-keys', listId: 'L2' });
    expect(w.client.getView().state.tasks[cardPlanned.id]!.source).toMatchObject({ id: card.id, status: { name: 'Deleted' } });
    await idle(planner);
  }, 20_000);

  test('a read that fails is never taken for "nothing there" (review 11)', async () => {
    const w = await openWindow(planner);
    // A linked task Google has no more, while a list can't be read to look for it under a new id: not called deleted.
    const badge = await w.google.addListTask(ME, 'L1', { title: 'Renew the badge', due: today }, { time: 600 });
    const badgePlanned = await plan(w, badge);
    deleteInGoogle(planner, badge.id);
    let stop = failing(w, '/google/tasks/all');
    await w.google.sync();
    stop();
    expect(w.client.getView().state.tasks[badgePlanned.id]!.source?.status?.name).not.toBe('Deleted');
    expect((await kept(planner, badge.id))?.time).toBe(600);
    // The next sync, reading, does.
    await w.google.sync();
    expect(w.client.getView().state.tasks[badgePlanned.id]!.source?.status?.name).toBe('Deleted');

    // A title changed on both sides while the task's activity can't be read: neither side is picked on a guess.
    const report = await w.google.addListTask(ME, 'L1', { title: 'Send the report', due: today });
    const reportPlanned = await plan(w, report);
    changeInGoogle(planner, report.id, { title: 'Send the full report', updated: new Date(Date.now() - 60_000).toISOString() });
    await planner.commands({ type: 'task.updated', taskId: reportPlanned.id, patch: { title: 'Send the report today' } });
    await w.look();
    stop = failing(w, '/activity');
    let mark = planner.google!.requests.length;
    await w.google.sync();
    stop();
    expect(taskWrites(planner, mark)).toEqual([]);
    expect((await planner.state()).tasks[reportPlanned.id]!.title).toBe('Send the report today');
    // The next sync decides: the Planner's change is the newer one, so Google gets it.
    await w.google.sync();
    expect(await until(() => inGoogle(planner, report.id)?.title === 'Send the report today')).toBe(true);
    expect((await planner.state()).tasks[reportPlanned.id]!.title).toBe('Send the report today');

    // Completing a task Google's own apps moved, while where it is can't be read: nothing is completed, and it says so.
    const move = await w.google.addListTask(ME, 'L1', { title: 'Plan the move', due: today });
    const boxes = await w.google.addListTask(ME, 'L1', { title: 'Buy boxes', parent: move.id });
    moveInGoogle(planner, move.id, 'L2');
    stop = failing(w, '/google/tasks/linked');
    mark = planner.google!.requests.length;
    await expect(w.google.completeListTask(move, true)).rejects.toThrow(/couldn't read the task in Google Tasks as it is now/);
    stop();
    expect(taskWrites(planner, mark)).toEqual([]);
    // Readable again: its subtasks are found where it is now and completed first.
    await w.google.completeListTask(move, true);
    expect(taskWrites(planner, mark)[0]).toMatchObject({ method: 'PATCH', path: `/tasks/v1/lists/L2/tasks/${boxes.id}` });
    expect([inGoogle(planner, boxes.id)?.status, inGoogle(planner, move.id)?.status]).toEqual(['completed', 'completed']);

    // A repeating task deleted or completed while the plan can't be read: nothing changes, in Google or in the plan.
    const plants = await w.google.addListTask(ME, 'L1', { title: 'Water the plants', due: today }, { time: 540, rule: DAILY });
    stop = failing(w, '/state');
    await expect(w.google.deleteListTask(plants, 'this')).rejects.toBeInstanceOf(FreshnessError);
    await expect(w.google.completeListTask(plants, true)).rejects.toBeInstanceOf(FreshnessError);
    stop();
    expect(inGoogle(planner, plants.id)?.status).toBe('needsAction');
    expect(openTitled(planner, 'Water the plants')).toHaveLength(1);
    expect(heads(await planner.state(), (await kept(planner, plants.id))!.repeat!.seriesId)).toEqual([plants.id]);
    await idle(planner);
  }, 20_000);

  test('changes reach the other side: from Google on a read, from the Planner at once; a write Google refuses is undone here, and a task Google no longer has shows as deleted', async () => {
    const w = await openWindow(planner);
    const gift = await w.google.addListTask(ME, 'L1', { title: 'Buy a gift', notes: 'For Bo', due: today });
    const planned = await plan(w, gift);
    // Changed in Google only: the Planner takes the title, details and date; read again, nothing is left to do.
    changeInGoogle(planner, gift.id, { title: 'Buy a birthday gift', notes: 'For Bo, by Friday', due: at(1) });
    await w.google.sync();
    expect(w.client.getView().state.tasks[planned.id]).toMatchObject({ title: 'Buy a birthday gift', notes: 'For Bo, by Friday', dueDate: day(1) });
    let mark = planner.google!.requests.length;
    await w.google.sync();
    expect(taskWrites(planner, mark)).toEqual([]);
    // Changed in the Planner only: Google gets it.
    await w.client.dispatch([{ type: 'task.updated', taskId: planned.id, patch: { notes: 'For Bo and Ann', dueDate: day(2) } }]);
    expect(await until(() => inGoogle(planner, gift.id)?.notes === 'For Bo and Ann' && dueOf(inGoogle(planner, gift.id)) === day(2))).toBe(true);
    // Completed here, it keeps what it was done with: a later change in Google moves only its link.
    await w.client.dispatch([{ type: 'task.completed', taskId: planned.id, on: today }]);
    expect(await until(() => inGoogle(planner, gift.id)?.status === 'completed')).toBe(true);
    changeInGoogle(planner, gift.id, { notes: 'Changed later in Google' });
    await w.google.sync();
    expect(w.client.getView().state.tasks[planned.id]!.notes).toBe('For Bo and Ann');

    // Google refuses the completion: the Planner task stays open too, and the window says so.
    const bank = await w.google.addListTask(ME, 'L1', { title: 'Call the bank', due: today });
    const bankPlanned = await plan(w, bank);
    planner.google!.failNext('PATCH', `/tasks/v1/lists/L1/tasks/${bank.id}`, 503, 'Backend Error');
    await w.client.dispatch([{ type: 'task.completed', taskId: bankPlanned.id, on: today }]);
    expect(await until(() => w.notes.includes('Google Tasks did not complete "Call the bank" (Backend Error), so it stays open here too'))).toBe(true);
    expect(await until(() => w.client.getView().state.tasks[bankPlanned.id]!.completedAt === null)).toBe(true);
    expect(inGoogle(planner, bank.id)?.status).toBe('needsAction');
    // Deleted in Google meanwhile: completing it says so, and its link shows it deleted.
    deleteInGoogle(planner, bank.id);
    await w.client.dispatch([{ type: 'task.completed', taskId: bankPlanned.id, on: today }]);
    expect(await until(() => w.client.getView().state.tasks[bankPlanned.id]!.source?.status?.name === 'Deleted')).toBe(true);
    expect(w.notes).toContain('"Call the bank" is no longer in Google Tasks');

    // Planned as a task, a Google task with a kept time and length is planned for that long (review 13).
    const call = await w.google.addListTask(ME, 'L1', { title: 'Timed call', due: today }, { time: 600, duration: 45 });
    const errand = await w.google.addListTask(ME, 'L1', { title: 'Plain errand', due: today });
    expect([(await plan(w, call)).plannedMinutes, (await plan(w, errand)).plannedMinutes]).toEqual([45, null]);
    mark = planner.google!.requests.length;
    await idle(planner);
  }, 20_000);

  test('a Google task merged into a task stays synced: checked off, or done with its task, it is completed in Google (its subtasks first) and reopened with it, unless checked off on its own', async () => {
    const w = await openWindow(planner);
    const own = await w.google.addListTask(ME, 'L1', { title: 'Inbox triage in Google', due: today });
    const inbox = await plan(w, own);
    const trip = await w.google.addListTask(ME, 'L1', { title: 'Plan the trip', due: today });
    const hotel = await w.google.addListTask(ME, 'L1', { title: 'Book the hotel', parent: trip.id });
    const stamps = await w.google.addListTask(ME, 'L1', { title: 'Buy stamps', due: today });
    const merge = async (item: GoogleTaskItem) => {
      const dragged = await plan(w, item);
      const bodies = mergeTaskCommands(w.client.getView().state, dragged.id, inbox.id, newId);
      if (typeof bodies === 'string') throw new Error(bodies);
      await w.client.dispatch(bodies);
      return w.client.getView().state.tasks[inbox.id]!.subtasks.find((subtask) => subtask.source?.id === item.id)!;
    };
    const subtask = (id: string) => w.client.getView().state.tasks[inbox.id]!.subtasks.find((one) => one.id === id)!;
    const tick = (id: string, done: boolean) => w.client.dispatch([{ type: 'subtask.updated', taskId: inbox.id, subtaskId: id, patch: { done }, seen: { done: subtask(id).done } }]);
    const mark = planner.google!.requests.length;
    const mergedTrip = await merge(trip);
    const mergedStamps = await merge(stamps);
    // The merge alone writes nothing to Google.
    expect(taskWrites(planner, mark)).toEqual([]);
    // Checked off: completed in Google, its own subtask there first, and its link says so.
    await tick(mergedTrip.id, true);
    expect(await until(() => subtask(mergedTrip.id).source?.status?.type === 'completed')).toBe(true);
    expect(taskWrites(planner, mark).map((request) => request.path)).toEqual([`/tasks/v1/lists/L1/tasks/${hotel.id}`, `/tasks/v1/lists/L1/tasks/${trip.id}`]);
    // Opened again: reopened there.
    await tick(mergedTrip.id, false);
    expect(await until(() => inGoogle(planner, trip.id)?.status === 'needsAction' && subtask(mergedTrip.id).source?.status?.type === 'open')).toBe(true);
    // Stamps checked off on its own, then the task completed: the trip and the task's own completed with it.
    await tick(mergedStamps.id, true);
    expect(await until(() => inGoogle(planner, stamps.id)?.status === 'completed')).toBe(true);
    await w.client.dispatch([{ type: 'task.completed', taskId: inbox.id, on: today }]);
    expect(await until(() => inGoogle(planner, trip.id)?.status === 'completed' && inGoogle(planner, own.id)?.status === 'completed')).toBe(true);
    expect(subtask(mergedTrip.id).done).toBe(false);
    // Reopened: the ones not checked off on their own reopen; stamps stays completed in Google.
    await w.client.dispatch([{ type: 'task.reopened', taskId: inbox.id }]);
    expect(await until(() => inGoogle(planner, trip.id)?.status === 'needsAction' && inGoogle(planner, own.id)?.status === 'needsAction')).toBe(true);
    await idle(planner);
    expect(inGoogle(planner, stamps.id)?.status).toBe('completed');
    expect(taskWrites(planner, mark).filter((request) => request.path.endsWith(`/${stamps.id}`))).toHaveLength(1);

    // Completed in Google: a read checks it off here, its title following; not when completion is not imported.
    const card = await w.google.addListTask(ME, 'L1', { title: 'Post the card', due: today });
    const mergedCard = await merge(card);
    changeInGoogle(planner, card.id, { status: 'completed', title: 'Post the birthday card' });
    await w.google.sync();
    expect(await until(() => subtask(mergedCard.id).done)).toBe(true);
    expect(subtask(mergedCard.id)).toMatchObject({ title: 'Post the birthday card', source: { status: { type: 'completed' } } });
    await w.client.dispatch([{ type: 'settings.updated', patch: { googleTasksImportCompletion: false } }]);
    const milk = await w.google.addListTask(ME, 'L1', { title: 'Buy milk', due: today });
    const mergedMilk = await merge(milk);
    changeInGoogle(planner, milk.id, { status: 'completed' });
    await w.google.sync();
    expect(await until(() => subtask(mergedMilk.id).source?.status?.type === 'completed')).toBe(true);
    expect(subtask(mergedMilk.id).done).toBe(false);
    await w.client.dispatch([{ type: 'settings.updated', patch: { googleTasksImportCompletion: true } }]);
    await idle(planner);
  }, 20_000);

  test('merged Google tasks: "Ask" asks once for the task and them, a question declined is not asked again; refused, the tick goes back and it says so; gone, its link says so; "Do nothing" writes nothing', async () => {
    const w = await openWindow(planner);
    const created = async (title: string) => {
      const id = newId();
      await w.client.dispatch([{ type: 'task.created', task: { id, title, placement: { kind: 'day', date: today }, position: 1024 } }]);
      return id;
    };
    const into = async (taskId: string, item: GoogleTaskItem) => {
      const dragged = await plan(w, item);
      const bodies = mergeTaskCommands(w.client.getView().state, dragged.id, taskId, newId);
      if (typeof bodies === 'string') throw new Error(bodies);
      await w.client.dispatch(bodies);
      return w.client.getView().state.tasks[taskId]!.subtasks.find((subtask) => subtask.source?.id === item.id)!;
    };
    const subtask = (taskId: string, id: string) => w.client.getView().state.tasks[taskId]!.subtasks.find((one) => one.id === id)!;
    const tick = (taskId: string, id: string, done: boolean) => w.client.dispatch([{ type: 'subtask.updated', taskId, subtaskId: id, patch: { done }, seen: { done: subtask(taskId, id).done } }]);
    const setting = (googleTasksOnComplete: 'ask' | 'complete' | 'nothing') => w.client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnComplete } }]);

    await setting('ask');
    const review = await created('Weekly review');
    const slides = await into(review, await w.google.addListTask(ME, 'L1', { title: 'Make the slides', due: today }));
    const notes = await into(review, await w.google.addListTask(ME, 'L1', { title: 'Write the notes', due: today }));
    // Notes checked off on its own: asked about alone; declined.
    await tick(review, notes.id, true);
    expect(w.google.getView().prompt).toMatchObject({ title: 'Write the notes', own: false, subtaskIds: [notes.id], by: 'tick' });
    w.google.answerPrompt('no');
    // The task completed: asked once, for the slides alone; Complete completes it in Google.
    const mark = planner.google!.requests.length;
    await w.client.dispatch([{ type: 'task.completed', taskId: review, on: today }]);
    expect(w.google.getView().prompt).toMatchObject({ taskId: review, title: 'Make the slides', own: false, subtaskIds: [slides.id], by: 'task' });
    expect(taskWrites(planner, mark)).toEqual([]);
    w.google.answerPrompt('yes');
    expect(await until(() => inGoogle(planner, slides.source!.id)?.status === 'completed')).toBe(true);
    expect(inGoogle(planner, notes.source!.id)?.status).toBe('needsAction');

    // Refused by Google: checked off on its own, the tick goes back and it says so; with its task, the task stays done.
    await setting('complete');
    const errands = await created('Errands run');
    const parcel = await into(errands, await w.google.addListTask(ME, 'L1', { title: 'Pick up the parcel', due: today }));
    planner.google!.failNext('PATCH', `/tasks/v1/lists/L1/tasks/${parcel.source!.id}`, 503, 'Backend Error');
    await tick(errands, parcel.id, true);
    expect(await until(() => w.notes.includes('Google Tasks did not complete "Pick up the parcel" (Backend Error), so it stays open here too'))).toBe(true);
    expect(await until(() => subtask(errands, parcel.id).done === false)).toBe(true);
    planner.google!.failNext('PATCH', `/tasks/v1/lists/L1/tasks/${parcel.source!.id}`, 503, 'Backend Error');
    await w.client.dispatch([{ type: 'task.completed', taskId: errands, on: today }]);
    expect(await until(() => w.notes.includes('Google Tasks did not complete "Pick up the parcel" (Backend Error)'))).toBe(true);
    expect(w.client.getView().state.tasks[errands]!.completedAt).toBeTruthy();
    // Gone from Google: checked off, its link says so.
    const chores = await created('Chores');
    const shelf = await into(chores, await w.google.addListTask(ME, 'L1', { title: 'Fix the shelf', due: today }));
    deleteInGoogle(planner, shelf.source!.id);
    await tick(chores, shelf.id, true);
    expect(await until(() => subtask(chores, shelf.id).source?.status?.name === 'Deleted')).toBe(true);
    expect(w.notes).toContain('"Fix the shelf" is no longer in Google Tasks');
    // "Do nothing": checked off and completed, nothing goes to Google.
    await setting('nothing');
    const quiet = await created('Quiet task');
    const lamp = await into(quiet, await w.google.addListTask(ME, 'L1', { title: 'Buy a lamp', due: today }));
    const before = planner.google!.requests.length;
    await tick(quiet, lamp.id, true);
    await w.client.dispatch([{ type: 'task.completed', taskId: quiet, on: today }]);
    await idle(planner);
    expect(taskWrites(planner, before)).toEqual([]);
    await setting('complete');

    // A calendar event task takes no subtasks, as in Sunsama; a plain task does.
    const meeting = newId();
    await planner.commands({ type: 'task.created', task: { id: meeting, title: 'Harness 1:1', placement: { kind: 'day', date: today }, position: 4096, source: { kind: 'event', id: `${ME}|primary|e1`, key: 'Google Calendar', url: 'https://calendar.google.com/calendar/r/eventedit/e1' } } });
    await expect(planner.commands({ type: 'subtask.added', taskId: meeting, subtask: { id: newId(), title: 'Agenda', done: false } } as EventBody)).rejects.toThrow("Calendar event tasks can't have subtasks");
    await planner.commands({ type: 'subtask.added', taskId: quiet, subtask: { id: newId(), title: 'Agenda', done: false } } as EventBody);
  }, 20_000);
});

describe('completing a task completes its subtasks, and reopening a subtask reopens its task, however cold the window is', () => {
  const planner = usePlanner({ google: world(), zone });

  test('from a fresh window, a warm one and a linked Planner task; refused half way, nothing is left completed over an open subtask', async () => {
    const setup = await openWindow(planner);
    const listId = await newList(setup, 'Trip');
    const trip = await setup.google.addListTask(ME, listId, { title: 'Plan the trip', due: day(3) });
    const hotel = await setup.google.addListTask(ME, listId, { title: 'Book the hotel', parent: trip.id });
    const bags = await setup.google.addListTask(ME, listId, { title: 'Pack the bags', parent: trip.id, previous: hotel.id });
    const passport = await setup.google.addListTask(ME, listId, { title: 'Renew the passport', parent: trip.id, previous: bags.id });
    await setup.google.completeListTask(passport, true);
    const report = await setup.google.addListTask(ME, listId, { title: 'Send the report', due: today });
    const states = () => [trip, hotel, bags, passport, report].map((task) => inGoogle(planner, task.id)?.status === 'completed');
    const patches = (from: number) => taskWrites(planner, from).filter((request) => request.method === 'PATCH').map((request) => `${request.path.split('/').at(-1)}:${request.body.status}`);
    const reads = (window: TasksWindow, from: number) => window.calls.slice(from).filter((call) => call.path.startsWith('/google/tasks/all')).length;
    await idle(planner);

    // A fresh window, on its calendar (no list loaded): the subtasks read from Google and completed first, then the task.
    const cold = await openWindow(planner);
    let mark = planner.google!.requests.length;
    let asked = cold.calls.length;
    await cold.google.completeListTask(await taskNow(cold, listId, trip.id), true);
    expect(states()).toEqual([true, true, true, true, false]);
    expect(patches(mark)).toEqual([`${hotel.id}:completed`, `${bags.id}:completed`, `${trip.id}:completed`]);
    expect(reads(cold, asked)).toBe(1);
    await idle(planner);
    // Reopening a subtask of the completed task reopens that task first.
    mark = planner.google!.requests.length;
    await (await openWindow(planner)).google.completeListTask(await taskNow(cold, listId, hotel.id), false);
    expect(states()).toEqual([false, false, true, true, false]);
    expect(patches(mark)).toEqual([`${trip.id}:needsAction`, `${hotel.id}:needsAction`]);
    // A subtask completed, or a task at the top reopened, reads nothing.
    const quiet = await openWindow(planner);
    asked = quiet.calls.length;
    await quiet.google.completeListTask(await taskNow(quiet, listId, trip.id), false);
    await quiet.google.completeListTask(await taskNow(quiet, listId, hotel.id), true);
    expect(reads(quiet, asked)).toBe(0);
    await idle(planner);
    // With the list shown in the Tasks view, the list is read again for the completion, and the view shows the result.
    const warm = await openWindow(planner);
    await warm.google.loadBoard(ME, listId);
    asked = warm.calls.length;
    await warm.google.completeListTask(await taskNow(warm, listId, trip.id), true);
    expect(states()).toEqual([true, true, true, true, false]);
    expect(reads(warm, asked)).toBeGreaterThanOrEqual(1);
    expect(await until(() => warm.google.getView().board[listKey(ME, listId)]!.items.filter((task) => task.completed).length === 4)).toBe(true);
    await idle(planner);

    // A linked Planner task completed in Home completes its Google task's subtasks; the Planner task planning a subtask follows.
    await warm.google.completeListTask(await taskNow(warm, listId, trip.id), false);
    for (const task of [hotel, bags, passport]) await warm.google.completeListTask(await taskNow(warm, listId, task.id), false);
    await idle(planner);
    const home = await openWindow(planner);
    const tripPlanned = await plan(home, await taskNow(home, listId, trip.id));
    const hotelPlanned = await plan(home, await taskNow(home, listId, hotel.id));
    await home.client.dispatch([{ type: 'task.completed', taskId: tripPlanned.id, on: today }]);
    expect(await until(() => states().slice(0, 4).every(Boolean))).toBe(true);
    expect(await until(() => Boolean(home.client.getView().state.tasks[hotelPlanned.id]!.completedAt))).toBe(true);
    // The subtask's Planner task reopened under the completed task: Google reopens the task first.
    mark = planner.google!.requests.length;
    await home.client.dispatch([{ type: 'task.reopened', taskId: hotelPlanned.id }]);
    expect(await until(() => !states()[0] && !states()[1])).toBe(true);
    expect(patches(mark).slice(0, 2)).toEqual([`${trip.id}:needsAction`, `${hotel.id}:needsAction`]);
    await idle(planner);

    // Refused half way (Google refuses the hotel, the open subtask left): the task stays open, and so does its Planner task.
    await home.client.dispatch([{ type: 'task.reopened', taskId: tripPlanned.id }]);
    await idle(planner);
    const fresh = await openWindow(planner);
    planner.google!.failNext('PATCH', `/tasks/v1/lists/${listId}/tasks/${hotel.id}`, 503, 'Backend Error');
    await fresh.client.dispatch([{ type: 'task.completed', taskId: tripPlanned.id, on: today }]);
    expect(await until(() => fresh.notes.some((note) => note.includes('Google Tasks did not complete "Plan the trip"')))).toBe(true);
    expect(states().slice(0, 2)).toEqual([false, false]);
    expect(await until(() => fresh.client.getView().state.tasks[tripPlanned.id]!.completedAt === null)).toBe(true);
    await idle(planner);
  }, 20_000);

  test('a repeating task and subtasks never go together, nor a shared task and either; a repeating task stays in its list: refused before anything changes', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Rules');
    const repeating = await w.google.addListTask(ME, listId, { title: 'Daily check', due: today }, { rule: DAILY });
    const parent = await w.google.addListTask(ME, listId, { title: 'Big job', due: today });
    const child = await w.google.addListTask(ME, listId, { title: 'Small step', parent: parent.id });
    addInGoogle(planner, listId, { id: 'shared-1', title: 'Review the draft', due: at(0), assignmentInfo: { surfaceType: 'DOCUMENT', linkToTask: 'https://docs.google.com/document/d/x/edit?disco=1' } });
    await w.google.loadBoard(ME, listId);
    await idle(planner);
    const mark = planner.google!.requests.length;
    const state = await planner.state();
    const refused = (work: Promise<unknown>) => work.then(() => null, (error: Error) => error.message);
    const daily = fields('x', today, null, { rule: DAILY, notes: '' });
    expect(await refused(w.google.addListTask(ME, listId, { title: 'Child', parent: repeating.id }))).toBe(REPEATING_NO_SUBTASKS);
    expect(await refused(w.google.moveListTask(parent, { parent: repeating.id, previous: null }))).toBe(REPEATING_NO_SUBTASKS);
    expect(await refused(w.google.moveListTask(repeating, { parent: parent.id, previous: null }))).toBe(REPEATING_NOT_SUBTASK);
    expect(await refused(w.google.moveListTask(repeating, { parent: null, previous: null }, 'L2'))).toBe(REPEATING_STAYS);
    expect(await refused(w.google.saveListTask(parent, { ...daily, title: parent.title }))).toBe(SUBTASKS_NO_REPEAT);
    expect(await refused(w.google.saveListTask(child, { ...daily, title: child.title, due: today }))).toBe(SUBTASK_NO_REPEAT);
    const shared = w.google.getView().board[listKey(ME, listId)]!.items.find((task) => task.id === 'shared-1')!;
    expect(shared.assigned).toMatchObject({ surface: 'document' });
    expect(await refused(w.google.addListTask(ME, listId, { title: 'Sub', parent: shared.id }))).toBe(SHARED_NO_SUBTASKS);
    expect(await refused(w.google.saveListTask(shared, { ...daily, title: shared.title }))).toBe(SHARED_NO_REPEAT);
    // Nothing reached Google but reads, and nothing was kept.
    expect(taskWrites(planner, mark)).toEqual([]);
    expect((await planner.state()).googleTasks).toEqual(state.googleTasks);
    // A repeating task still moves within its list and keeps its series on other edits; a task without subtasks takes a repeat.
    await w.google.moveListTask(repeating, { parent: null, previous: child.id === parent.id ? null : parent.id });
    await w.google.saveListTask(repeating, { ...daily, title: 'Daily check, renamed' });
    expect((await kept(planner, repeating.id))?.repeat?.rule).toBe(DAILY);
    await w.google.saveListTask(child, fields('Small step', today, null, { notes: '' }));
    const single = await w.google.addListTask(ME, listId, { title: 'Single', due: today });
    await w.google.saveListTask(single, { ...daily, title: 'Single' });
    expect((await kept(planner, single.id))?.repeat?.rule).toBe(DAILY);
    await idle(planner);
  }, 20_000);
});

describe("a repeating task's next occurrence", () => {
  const planner = usePlanner({ google: world(), zone });

  test("completing one makes the next once: in its list, on the series' next date, from its template (title, details, time, the deadline as days after); seen again, in another window too, nothing more", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Weekly');
    const first = await w.google.addListTask(ME, listId, { title: 'Weekly review', notes: 'Agenda', due: today }, { time: 540, deadline: day(2), rule: 'RRULE:FREQ=WEEKLY' });
    // Before it is done, the calendar shows its next one a week on, at 9am, and nothing between.
    expect(lines(await calendarOf(w, day(1), day(7)), ['upcoming'])).toEqual([`upcoming: Weekly review ${day(7)} 540`]);
    await w.google.completeListTask(first, true);
    const next = await openOne(planner, w, 'Weekly review');
    expect([next.listId, next.due, next.notes]).toEqual([listId, day(7), 'Agenda']);
    expect(await kept(planner, next.id)).toMatchObject({ time: 540, deadline: day(9), repeat: { index: 2, next: null } });
    expect((await kept(planner, first.id))?.repeat?.next).toBe(next.id);
    // The real one replaces its projection: one item that day.
    await w.look();
    expect(lines(await calendarOf(w, day(7), day(7)))).toEqual([`Weekly review ${day(7)} 540`, `deadline: Weekly review ${day(9)}`].slice(0, 1));
    await idle(planner);
    const mark = planner.google!.requests.length;
    const other = await openWindow(planner);
    await other.google.loadBoard(ME, listId);
    await other.google.makeNextOccurrences([{ ...first, completed: true }]);
    await w.google.syncItems([{ ...first, completed: true }]);
    await idle(planner);
    expect(creates(planner, listId, mark)).toEqual([]);
  }, 20_000);

  test("the next date, as Google Tasks steps the rule: weekdays, every other week, the 31st, the last Friday, February 29th; its count or its last day ends it", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Rules');
    const cases: [string, DateKey, DateKey | null][] = [
      ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH', '2027-03-01', '2027-03-04'],
      ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2027-03-04', '2027-03-15'],
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31', '2027-01-31', '2027-03-31'],
      ['RRULE:FREQ=MONTHLY;BYDAY=-1FR', '2027-01-29', '2027-02-26'],
      ['RRULE:FREQ=YEARLY', '2028-02-29', '2032-02-29'],
      ['RRULE:FREQ=DAILY;COUNT=1', '2027-03-01', null],
      ['RRULE:FREQ=DAILY;UNTIL=20270301', '2027-03-01', null],
    ];
    const seen: (DateKey | null)[] = [];
    for (const [index, [rule, due]] of cases.entries()) {
      const task = await w.google.addListTask(ME, listId, { title: `Rule ${index}`, due }, { rule });
      await w.google.completeListTask(task, true);
      seen.push(dueOf(openTitled(planner, `Rule ${index}`)[0]));
      // A series that ends there stops repeating.
      if (!cases[index]![2]) expect((await kept(planner, task.id))?.repeat ?? null).toBeNull();
    }
    expect(seen).toEqual(cases.map(([, , next]) => next));
    await idle(planner);
  }, 20_000);

  test('a task of its own with the series\' title, due on its next date, is never taken for the next occurrence (review 5) nor hides it on the calendar (review 6)', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Standups');
    const first = await w.google.addListTask(ME, listId, { title: 'Daily standup', notes: 'Agenda', due: today }, { time: 600, rule: DAILY });
    const theirs = await w.google.addListTask(ME, listId, { title: 'Daily standup', notes: 'independent appointment', due: day(1) }, { time: 960 });
    // Tomorrow shows the series' 10am beside the other task's 4pm.
    expect(lines(await calendarOf(w, day(1), day(1)))).toEqual([`upcoming: Daily standup ${day(1)} 600`, `Daily standup ${day(1)} 960`]);
    const mark = planner.google!.requests.length;
    await w.google.completeListTask(first, true);
    expect(creates(planner, listId, mark)).toHaveLength(1);
    const made = (await kept(planner, first.id))!.repeat!.next!;
    expect(made).not.toBe(theirs.id);
    expect(inGoogle(planner, made)).toMatchObject({ title: 'Daily standup', notes: 'Agenda' });
    expect(await kept(planner, theirs.id)).toMatchObject({ time: 960 });
    expect((await kept(planner, theirs.id))?.repeat ?? null).toBeNull();
    // Each once on the calendar, the series' own now a real task; read again, no second.
    await w.look();
    expect(lines(await calendarOf(w, day(1), day(1)))).toEqual([`Daily standup ${day(1)} 600`, `Daily standup ${day(1)} 960`]);
    await w.google.loadBoard(ME, listId);
    await w.google.syncItems([{ ...first, completed: true }]);
    await idle(planner);
    expect(creates(planner, listId, mark)).toHaveLength(1);
  }, 20_000);

  test('deleting a list takes what was kept for its tasks and their upcoming ones with it, read from the plan as it is (review 5, review 11); a delete Google refuses changes nothing', async () => {
    const a = await openWindow(planner);
    const b = await openWindow(planner);
    const listId = await newList(a, 'Plants');
    // Added in another window since this one looked.
    const water = await b.google.addListTask(ME, listId, { title: 'Water the plants', due: today }, { time: 540, rule: DAILY });
    const fern = await b.google.addListTask(ME, listId, { title: 'Repot the fern', due: today });
    const fernPlanned = await plan(b, fern);
    const list = a.google.getView().lists.find((one) => one.id === listId) ?? { account: ME, id: listId, title: 'Plants' };
    planner.google!.failNext('DELETE', `/tasks/v1/users/@me/lists/${listId}`, 503, 'Backend Error');
    await expect(a.google.deleteList(list)).rejects.toThrow('Backend Error');
    expect((await kept(planner, water.id))?.repeat?.rule).toBe(DAILY);
    await a.google.deleteList(list);
    expect(await kept(planner, water.id)).toBeNull();
    expect((await planner.state()).tasks[fernPlanned.id]!.source?.status?.name).toBe('Deleted');
    expect((await calendarOf(a, today, day(6))).filter((item) => item.title === 'Water the plants')).toEqual([]);
    await idle(planner);
  });

  test('a new rule numbers the open task from 1 again: completing it makes its next one, never taking a completed one before it for that', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Stretching');
    const { first, seriesId } = await daily(planner, w, listId, 'Stretch');
    await w.google.completeListTask(first, true);
    await w.google.completeListTask(await openOne(planner, w, 'Stretch'), true);
    const third = await openOne(planner, w, 'Stretch');
    expect((await kept(planner, third.id))?.repeat?.index).toBe(3);
    // All tasks, weekly from its day on.
    await w.google.saveListTask(third, fields('Stretch', third.due, 540, { rule: 'RRULE:FREQ=WEEKLY' }), 'all');
    expect((await kept(planner, third.id))?.repeat).toMatchObject({ rule: 'RRULE:FREQ=WEEKLY', index: 1 });
    await w.google.completeListTask(await taskNow(w, listId, third.id), true);
    const fourth = await openOne(planner, w, 'Stretch');
    expect(fourth.due).toBe(addDays(third.due!, 7));
    expect((await kept(planner, third.id))?.repeat?.next).toBe(fourth.id);
    expect(heads(await planner.state(), seriesId)).toEqual([fourth.id]);
    await idle(planner);
  });
});

describe('This task and All tasks', () => {
  const planner = usePlanner({ google: world(), zone });

  test("This task changes one occurrence, the series' next date staying; All tasks changes the series and this one; a new rule is for all; no repeat ends it", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Standups');
    const first = await w.google.addListTask(ME, listId, { title: 'Daily standup', notes: 'Agenda', due: today }, { time: 600, deadline: day(1), rule: DAILY });
    // This task: a one-off title, details, time, date and deadline for it alone.
    await w.google.saveListTask(first, fields('One-off', day(2), 720, { notes: 'Just today', deadline: day(3), rule: DAILY }), 'this');
    expect(inGoogle(planner, first.id)).toMatchObject({ title: 'One-off', notes: 'Just today', due: at(2) });
    expect(await kept(planner, first.id)).toMatchObject({ time: 720, deadline: day(3) });
    await w.look();
    expect(lines(await calendarOf(w, day(1), day(1)), ['upcoming'])).toEqual([`upcoming: Daily standup ${day(1)} 600`]);
    // Completed: the next one is the series', tomorrow (the one-off move does not shift the series).
    await w.google.completeListTask(await taskNow(w, listId, first.id), true);
    const second = await openOne(planner, w, 'Daily standup');
    expect([second.due, second.notes]).toEqual([day(1), 'Agenda']);
    expect(await kept(planner, second.id)).toMatchObject({ time: 600, deadline: day(2), repeat: { index: 2 } });
    // All tasks: a new title, details, 9am and a deadline two days after, for this one and the following ones.
    await w.google.saveListTask(second, fields('Standup', day(1), 540, { notes: 'New agenda', deadline: day(3), rule: DAILY }), 'all');
    expect(inGoogle(planner, second.id)).toMatchObject({ title: 'Standup', notes: 'New agenda' });
    expect(await kept(planner, second.id)).toMatchObject({ time: 540, deadline: day(3) });
    await w.google.completeListTask(await taskNow(w, listId, second.id), true);
    const third = await openOne(planner, w, 'Standup');
    expect([third.due, third.notes]).toEqual([day(2), 'New agenda']);
    expect(await kept(planner, third.id)).toMatchObject({ time: 540, deadline: day(4) });
    // A new rule (weekly) saved as This task is for all tasks, its schedule from this one's date.
    await w.google.saveListTask(third, fields('Standup', day(2), 540, { notes: 'New agenda', deadline: day(4), rule: 'RRULE:FREQ=WEEKLY' }), 'this');
    await w.look();
    expect(lines(await calendarOf(w, day(3), day(9)), ['upcoming'])).toEqual([`upcoming: Standup ${day(9)} 540`]);
    // No repeat any more: the series ends; nothing upcoming.
    await w.google.saveListTask(await taskNow(w, listId, third.id), fields('Standup', day(2), 540, { notes: 'New agenda', deadline: day(4), rule: null }), 'all');
    expect((await kept(planner, third.id))?.repeat ?? null).toBeNull();
    await w.look();
    expect(lines(await calendarOf(w, day(3), day(9)), ['upcoming'])).toEqual([]);
    await idle(planner);
  }, 20_000);

  test('an edit Google refuses (This task or All tasks: a title, a time, a date, a deadline, a repeat) leaves Google, what is kept and the series as they were, after a restart too; Save again applies it once', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Pottery');
    const { first } = await daily(planner, w, listId, 'Pottery class', { time: 780 });
    await w.google.loadBoard(ME, listId);
    await idle(planner);
    const before = { google: inGoogle(planner, first.id), kept: await kept(planner, first.id) };
    const cases: [ReturnType<typeof fields>, 'this' | 'all'][] = [
      [fields('Rejected title', today, 960, { rule: DAILY }), 'all'],
      [fields('Rejected title', today, 960, { rule: DAILY }), 'this'],
      [fields('Pottery class', day(2), 780, { deadline: day(3), rule: DAILY }), 'all'],
      [fields('Pottery class', day(2), 780, { rule: DAILY }), 'this'],
      [fields('Pottery class', day(1), 780, { rule: 'RRULE:FREQ=WEEKLY;BYDAY=WE' }), 'all'],
    ];
    for (const [edit, scope] of cases) {
      planner.google!.failNext('PATCH', `/tasks/v1/lists/${listId}/tasks/${first.id}`, 503, 'Backend Error');
      await expect(w.google.saveListTask(first, edit, scope)).rejects.toThrow('Backend Error');
      expect(inGoogle(planner, first.id)).toEqual(before.google);
      expect(await kept(planner, first.id)).toEqual(before.kept);
    }
    // The Tasks view shows the task as Google has it.
    expect(w.google.getView().board[listKey(ME, listId)]!.items.find((task) => task.id === first.id)?.title).toBe('Pottery class');
    // Nothing was made in Google either; and every window reloaded (a restart) shows it as it was.
    expect(creates(planner, listId).filter((request) => request.body?.title === 'Pottery class')).toHaveLength(1);
    await idle(planner);
    await planner.restart();
    expect(await kept(planner, first.id)).toEqual(before.kept);
    // Save again, once Google takes it: applied once; the next occurrence has the new values.
    const edit = fields('Pottery at four', today, 960, { rule: DAILY });
    planner.google!.failNext('PATCH', `/tasks/v1/lists/${listId}/tasks/${first.id}`, 503, 'Backend Error');
    await expect(w.google.saveListTask(first, edit, 'all')).rejects.toThrow('Backend Error');
    await w.google.saveListTask(first, edit, 'all');
    expect(inGoogle(planner, first.id)?.title).toBe('Pottery at four');
    const keptNow = await kept(planner, first.id);
    expect(keptNow).toMatchObject({ time: 960, repeat: { index: 1, template: { title: 'Pottery at four', time: 960 } } });
    const titled = () => taskWrites(planner).filter((request) => request.method === 'PATCH' && request.body?.title === 'Pottery at four');
    expect(titled()).toHaveLength(2);
    await w.google.saveListTask(await taskNow(w, listId, first.id), edit, 'all');
    expect(titled()).toHaveLength(2);
    expect((await kept(planner, first.id))?.repeat).toEqual(keptNow!.repeat);
    await w.google.completeListTask(await taskNow(w, listId, first.id), true);
    const next = await openOne(planner, w, 'Pottery at four');
    expect(next.due).toBe(day(1));
    expect(await kept(planner, next.id)).toMatchObject({ time: 960, repeat: { index: 2 } });
    await idle(planner);
  }, 20_000);

  test('a move to another list Google refuses puts back what Google took, and nothing is kept until both are taken; a timed task dragged to a day Google refuses keeps its time', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Moves');
    const report = await w.google.addListTask(ME, listId, { title: 'Send the report', notes: 'To Ann', due: today });
    const edit = fields('Send the full report', today, 600, { notes: 'To Ann' });
    planner.google!.failNext('POST', `/tasks/v1/lists/${listId}/tasks/${report.id}/move`, 503, 'Backend Error');
    await expect(w.google.saveListTask(report, edit, 'this', { starred: true, listId: 'L2' })).rejects.toThrow('Backend Error');
    expect(inGoogle(planner, report.id)).toMatchObject({ title: 'Send the report', listId });
    expect(await kept(planner, report.id)).toBeNull();
    await w.google.saveListTask(report, edit, 'this', { starred: true, listId: 'L2' });
    expect(inGoogle(planner, report.id)).toMatchObject({ title: 'Send the full report', listId: 'L2' });
    expect(await kept(planner, report.id)).toMatchObject({ listId: 'L2', time: 600, starredAt: expect.any(String) });

    const call = await w.google.addListTask(ME, listId, { title: 'Call the plumber', due: today }, { time: 600 });
    planner.google!.failNext('PATCH', `/tasks/v1/lists/${listId}/tasks/${call.id}`, 503, 'Backend Error');
    await expect(w.google.moveTimedTask(call, day(1), 840)).rejects.toThrow('Backend Error');
    expect([dueOf(inGoogle(planner, call.id)), (await kept(planner, call.id))?.time]).toEqual([today, 600]);
    await w.google.moveTimedTask(call, day(1), 840);
    expect([dueOf(inGoogle(planner, call.id)), (await kept(planner, call.id))?.time]).toEqual([day(1), 840]);
    await idle(planner);
  });

  test('a form saved against what it showed, while another window changed the task (review 10): what it left alone keeps their change, what both changed is asked about, Keep theirs or Save mine', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Forms');
    const { first } = await daily(planner, a, listId, 'Stale');
    const shown = shownIn(a, first);
    const b = await openWindow(planner);
    await b.google.saveListTask(first, sent({ ...shownIn(b, first), time: 780 }, shownIn(b, first)), 'all');
    // A has not looked again: its form still shows 9am, and it moves the task to 10am.
    expect(keptOf(a.client.getView().state, ME, first.id)!.time).toBe(540);
    const conflict = (await a.google.saveListTask(first, sent({ ...shown, time: 600, notes: 'New notes' }, shown), 'all').catch((error: unknown) => error)) as TaskConflict;
    expect(conflict).toBeInstanceOf(TaskConflict);
    expect([conflict.fields, conflict.now.time]).toEqual([['time'], 780]);
    expect(await kept(planner, first.id)).toMatchObject({ time: 780 });
    expect(inGoogle(planner, first.id)?.notes).toBe('Series notes');
    // Keep theirs: 1pm stays, the notes it changed alone are saved.
    const theirs = settleConflicts(conflict.base, conflict.mine, conflict.now, conflict.fields, 'theirs');
    await a.google.saveListTask(first, sent(theirs.mine, theirs.base), 'all');
    expect(await kept(planner, first.id)).toMatchObject({ time: 780, repeat: { template: { notes: 'New notes', time: 780 } } });
    expect(inGoogle(planner, first.id)?.notes).toBe('New notes');
    // B moves it to 3pm; A's form, still open, asked again, Save mine: its 10am.
    await b.look();
    await b.google.saveListTask(first, sent({ ...shownIn(b, await taskNow(b, listId, first.id)), time: 900 }, shownIn(b, await taskNow(b, listId, first.id))), 'all');
    const again = (await a.google.saveListTask(first, sent({ ...theirs.mine, time: 600 }, theirs.mine), 'all').catch((error: unknown) => error)) as TaskConflict;
    expect([again.fields, again.now.time]).toEqual([['time'], 900]);
    const mine = settleConflicts(again.base, again.mine, again.now, again.fields, 'mine');
    await a.google.saveListTask(first, sent(mine.mine, mine.base), 'all');
    expect(await kept(planner, first.id)).toMatchObject({ time: 600, repeat: { template: { time: 600, notes: 'New notes' } } });
    await idle(planner);
  }, 20_000);

  test('forms open while the series changed (review 10): This task after a cut keeps the cut; Edit → All tasks after a move to 1pm keeps 1pm; one upcoming task\'s editor after its time changed keeps that time', async () => {
    const a = await openWindow(planner);
    const b = await openWindow(planner);
    const listId = await newList(a, 'Open forms');
    // Cut short while the form was open; This task: the new title is this task's alone, and the cut stays.
    const cut = await daily(planner, a, listId, 'Cut alone');
    const cutShown = shownIn(a, cut.first);
    await b.look();
    await b.google.deleteSeries({ account: ME, seriesId: cut.seriesId, from: day(2) });
    await a.look();
    expect((await a.google.formCheck(cut.first, sent({ ...cutShown, title: 'Cut alone, this one' }, cutShown))).changes).toEqual(['title']);
    await a.google.saveListTask(cut.first, sent({ ...cutShown, title: 'Cut alone, this one' }, cutShown), 'this');
    expect(inGoogle(planner, cut.first.id)?.title).toBe('Cut alone, this one');
    expect((await kept(planner, cut.first.id))!.repeat).toMatchObject({ template: { title: 'Cut alone' } });
    expect(lines(await calendarOf(a, day(1), day(4)), ['upcoming'], /^Cut alone/)).toEqual([`upcoming: Cut alone ${day(1)} 540`]);

    // Edit → All tasks shows the series; another window moves it to 1pm; a new title alone keeps 1pm, a 10am is asked about.
    const series = await daily(planner, a, listId, 'Series form');
    const seriesShown = { ...shownIn(a, series.first) };
    await b.look();
    await b.google.saveListTask(series.first, sent({ ...shownIn(b, series.first), time: 780 }, shownIn(b, series.first)), 'all');
    await a.look();
    await a.google.saveListTask(series.first, sent({ ...seriesShown, title: 'Series form, renamed' }, seriesShown), 'all', { shows: 'series' });
    expect(await kept(planner, series.first.id)).toMatchObject({ time: 780, repeat: { template: { title: 'Series form, renamed', time: 780 } } });
    const refused = (await a.google.saveListTask(series.first, sent({ ...seriesShown, time: 600 }, seriesShown), 'all', { shows: 'series' }).catch((error: unknown) => error)) as TaskConflict;
    expect([refused.fields, refused.now.time]).toEqual([['time'], 780]);

    // One upcoming task's editor open while another window gives that task 3pm: a new title alone keeps 3pm; a 4pm is asked about.
    const one = await daily(planner, a, listId, 'One day');
    await b.look();
    const shownA = await upcomingOn(a, day(1), 'One day');
    const baseA = occurrenceShown(a, shownA, one.first);
    const shownB = await upcomingOn(b, day(1), 'One day');
    const baseB = occurrenceShown(b, shownB, one.first);
    await b.google.editOccurrence(shownB, sent({ ...baseB, time: 900 }, baseB));
    await a.google.editOccurrence(shownA, sent({ ...baseA, title: 'One day with Ann' }, baseA));
    expect((await upcomingOn(a, day(1), 'One day'))).toMatchObject({ change: { title: 'One day with Ann', time: 900 } });
    const late = (await a.google.editOccurrence(shownA, sent({ ...baseA, time: 960 }, baseA)).catch((error: unknown) => error)) as TaskConflict;
    expect([late.fields, late.now.time]).toEqual([['time'], 900]);
    // Made meanwhile (the task before it completed): the made task as it is now is what the editor is checked against.
    await b.google.completeListTask(await taskNow(b, listId, one.first.id), true);
    expect((await openOne(planner, b, 'One day with Ann')).due).toBe(day(1));
    const made = (await a.google.editOccurrence(shownA, sent({ ...baseA, title: 'One day, late' }, baseA)).catch((error: unknown) => error)) as TaskConflict;
    expect([made.fields, made.now.title]).toEqual([['title'], 'One day with Ann']);
    await idle(planner);
  }, 20_000);
});

describe('two windows, one series (review 8, review 9)', () => {
  const planner = usePlanner({ google: world(), zone });
  /** Until Google holds a request making a task titled so, in the list (Google is slow). */
  const making = (listId: string, title: string) =>
    until(() => planner.google!.requests.some((request) => request.method === 'POST' && request.path === `/tasks/v1/lists/${listId}/tasks` && request.body?.title === title && !(request as { answeredAt?: number }).answeredAt), 5000, 5);

  test('both complete one occurrence at once, Google slow: one next occurrence between them, linked; reloaded, both complete that one, Google refusing the first try: one more, said once; read again, nothing more', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Twins');
    const { first, seriesId } = await daily(planner, a, listId, 'Twin');
    const b = await openWindow(planner);
    await Promise.all([a.google.loadBoard(ME, listId), b.google.loadBoard(ME, listId)]);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250, 2);
    await Promise.all([a.google.completeListTask(first, true), b.google.completeListTask(first, true)]);
    await idle(planner);
    const second = await openOne(planner, a, 'Twin');
    expect([second.due, second.notes]).toEqual([day(1), 'Series notes']);
    expect(creates(planner, listId)).toHaveLength(2);
    expect((await kept(planner, first.id))?.repeat?.next).toBe(second.id);
    expect(await kept(planner, second.id)).toMatchObject({ time: 540, repeat: { seriesId, index: 2, next: null } });
    expect(heads(await planner.state(), seriesId)).toEqual([second.id]);
    for (const window of [a, b]) {
      expect(window.google.getView().board[listKey(ME, listId)]!.items.filter((task) => !task.completed).map((task) => task.id)).toEqual([second.id]);
      expect(window.notes.filter((note) => note.startsWith('Google Tasks did not take'))).toEqual([]);
    }

    // Reloaded: two fresh windows on the plan as the service has it.
    const [c, d] = [await openWindow(planner), await openWindow(planner)];
    await Promise.all([c.google.loadBoard(ME, listId), d.google.loadBoard(ME, listId)]);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 200, 2);
    planner.google!.failNext('POST', `/tasks/v1/lists/${listId}/tasks`, 503, 'Backend Error');
    await Promise.all([c.google.completeListTask(second, true), d.google.completeListTask(second, true)]);
    await idle(planner);
    expect(creates(planner, listId).map((request) => dueOf(request.body))).toEqual([today, day(1), day(2), day(2)]);
    const third = await openOne(planner, c, 'Twin');
    expect(third.due).toBe(day(2));
    expect((await kept(planner, second.id))?.repeat?.next).toBe(third.id);
    expect(heads(await planner.state(), seriesId)).toEqual([third.id]);
    expect([...c.notes, ...d.notes].filter((note) => note.startsWith('Google Tasks did not take the next "Twin"'))).toHaveLength(1);
    // The window that was refused tries again (its next read), and a fresh window reads the list: nothing more is made.
    await c.google.makeNextOccurrences([{ ...second, completed: true }]);
    await d.google.syncItems([{ ...second, completed: true }]);
    await (await openWindow(planner)).google.loadBoard(ME, listId);
    await idle(planner);
    expect(creates(planner, listId)).toHaveLength(4);
    expect(heads(await planner.state(), seriesId)).toEqual([third.id]);
  }, 20_000);

  test('one window deletes "This task" while the other completes it: one next occurrence; the service asked again at once, or after a stale window wrote the link away, answers the one it made', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Twins again');
    const { first, seriesId } = await daily(planner, a, listId, 'Twin two');
    const b = await openWindow(planner);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 200);
    await Promise.all([a.google.deleteListTask(first, 'this'), b.google.completeListTask(first, true).catch(() => {})]);
    await idle(planner);
    expect(openTitled(planner, 'Twin two').map((task) => dueOf(task))).toEqual([day(1)]);
    expect(heads(await planner.state(), seriesId)).toHaveLength(1);
    expect(creates(planner, listId)).toHaveLength(2);

    const second = await openOne(planner, a, 'Twin two');
    await a.google.completeListTask(second, true);
    const made = await openOne(planner, a, 'Twin two');
    const answers = await Promise.all([1, 2, 3].map(() => planner.call('POST', '/google/tasks/next', { account: ME, listId, id: second.id })));
    expect(answers.map((answer) => [answer.body.task?.id, answer.body.made])).toEqual([[made.id, false], [made.id, false], [made.id, false]]);
    // A window that read the series before it was linked writes it back whole: the one in Google is linked again, not made twice.
    const repeat = (await kept(planner, second.id))!.repeat!;
    await planner.commands({ type: 'gtask.kept', account: ME, listId, taskId: second.id, patch: { repeat: { ...repeat, next: null } } });
    expect((await planner.call('POST', '/google/tasks/next', { account: ME, listId, id: second.id })).body).toMatchObject({ task: { id: made.id }, made: false });
    expect((await kept(planner, second.id))?.repeat?.next).toBe(made.id);
    expect(creates(planner, listId)).toHaveLength(3);
    expect(heads(await planner.state(), seriesId)).toEqual([made.id]);
  }, 20_000);

  test("tomorrow edited alone in one window, or All tasks, while another completes today and Google is slow to make tomorrow's (review 9): the one next task has the edit", async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Races');
    // This task on tomorrow's upcoming one.
    const race = await daily(planner, a, listId, 'Race');
    const b = await openWindow(planner);
    const tomorrow = await upcomingOn(b, day(1), 'Race');
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250);
    const completing = a.google.completeListTask(race.first, true);
    await making(listId, 'Race');
    await Promise.all([completing, b.google.editOccurrence(tomorrow, fields('Race with Ann', day(1), 900))]);
    await idle(planner);
    const next = await openOne(planner, a, 'Race with Ann');
    expect(next.due).toBe(day(1));
    expect(await kept(planner, next.id)).toMatchObject({ time: 900, repeat: { seriesId: race.seriesId, index: 2, next: null, template: { title: 'Race', time: 540 } } });
    expect((await kept(planner, race.first.id))?.repeat?.next).toBe(next.id);
    expect(creates(planner, listId).filter((request) => request.body?.title !== undefined)).toHaveLength(2);
    // The day after is the series' own again.
    await b.look();
    expect(await upcomingOn(b, day(2), 'Race')).toMatchObject({ on: day(2) });
    expect((await upcomingOn(b, day(2), 'Race')).change).toBeUndefined();

    // All tasks (a new title and 3pm) saved from the other window while Google makes the next one.
    const sprint = await daily(planner, a, listId, 'Sprint');
    const c = await openWindow(planner);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250);
    const done = a.google.completeListTask(sprint.first, true);
    await making(listId, 'Sprint');
    await Promise.all([done, c.google.saveListTask(sprint.first, fields('Sprint daily', today, 900, { rule: DAILY }), 'all')]);
    await idle(planner);
    const made = await openOne(planner, a, 'Sprint daily');
    expect(made.due).toBe(day(1));
    expect(await kept(planner, made.id)).toMatchObject({ time: 900, repeat: { seriesId: sprint.seriesId, template: { title: 'Sprint daily', time: 900 } } });
    // The one after it comes from the new template.
    await a.google.completeListTask(made, true);
    const after = await openOne(planner, a, 'Sprint daily');
    expect([after.due, (await kept(planner, after.id))?.time]).toEqual([day(2), 900]);
    await idle(planner);
  }, 20_000);

  test("a change that arrives first is what the next one is made with; one kept past the series' lock while Google makes it (an older window's commands) is put on it in Google too (review 9)", async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Firsts');
    const first = await daily(planner, a, listId, 'Early');
    const b = await openWindow(planner);
    await b.google.saveListTask(first.first, fields('Early bird', today, 900, { rule: DAILY }), 'all');
    // A's view is from before the edit; the service makes the next one from the series as it is.
    await a.google.completeListTask(first.first, true);
    const next = await openOne(planner, a, 'Early bird');
    expect([next.due, (await kept(planner, next.id))?.time]).toEqual([day(1), 900]);

    const late = await daily(planner, a, listId, 'Late');
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250);
    const completing = a.google.completeListTask(late.first, true);
    await making(listId, 'Late');
    // Written as commands, as an older window writes it: tomorrow at 3pm with its own title.
    const head = (await kept(planner, late.first.id))!;
    await planner.commands({ type: 'gtask.kept', account: ME, listId, taskId: late.first.id, patch: { repeat: { ...head.repeat!, exceptions: { [day(1)]: { title: 'Late with Ann', time: 900, duration: null } } } } });
    await completing;
    await idle(planner);
    const made = await openOne(planner, a, 'Late with Ann');
    expect([made.due, (await kept(planner, made.id))?.time]).toEqual([day(1), 900]);
    expect((await kept(planner, late.first.id))?.repeat).toMatchObject({ next: made.id, exceptions: { [day(1)]: { title: 'Late with Ann' } } });
    expect(taskWrites(planner).filter((request) => request.method === 'PATCH' && request.path.endsWith(`/${made.id}`))).toHaveLength(1);
  }, 20_000);

  test('an upcoming task the series made meanwhile, still upcoming in a window (review 9 audit): edited alone, Google has it and its kept entry is written again; deleted alone, its next one is made first', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Made meanwhile');
    const { first } = await daily(planner, a, listId, 'Made');
    const b = await openWindow(planner);
    const shown = await upcomingOn(b, day(1), 'Made');
    await a.google.completeListTask(first, true);
    const made = await openOne(planner, a, 'Made');
    const before = (await kept(planner, made.id))!;
    await b.google.editOccurrence(shown, { ...fields('Made with Ann', day(1), 900), kept: { ...fields('Made with Ann', day(1), 900).kept, attachments: [doc('m1', 'Minutes')] } });
    expect(inGoogle(planner, made.id)).toMatchObject({ title: 'Made with Ann', due: at(1) });
    const after = (await kept(planner, made.id))!;
    expect(after).toMatchObject({ time: 900, attachments: [doc('m1', 'Minutes')], repeat: { on: day(1), next: null } });
    expect(after.updatedAt > before.updatedAt).toBe(true);
    await b.google.setOccurrence(shown, { skip: true });
    expect(inGoogle(planner, made.id)).toBeNull();
    const next = await openOne(planner, a, 'Made');
    expect(next.due).toBe(day(2));
    await idle(planner);
  }, 20_000);

  test('two windows edit one upcoming task: what each changed is kept, the same field the last; deleted alone, an edit from a window still showing it is refused; a new rule from a window that never saw two edits keeps the one still on its schedule', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Pairs');
    const pair = await daily(planner, a, listId, 'Pair');
    const b = await openWindow(planner);
    const shownA = await upcomingOn(a, day(2), 'Pair');
    const shownB = await upcomingOn(b, day(2), 'Pair');
    await a.google.editOccurrence(shownA, fields('Pair with Ann', day(2), 540));
    await b.google.editOccurrence(shownB, fields('Pair', day(2), 900));
    await a.look();
    expect(await upcomingOn(a, day(2), 'Pair')).toMatchObject({ change: { title: 'Pair with Ann', time: 900 } });
    await b.google.editOccurrence(shownB, fields('Pair with Bo', day(2), 540));
    await a.look();
    expect(await upcomingOn(a, day(2), 'Pair')).toMatchObject({ change: { title: 'Pair with Bo', time: 900 } });
    // Deleted alone in one window; the other, still showing it, edits it: refused, it stays deleted.
    const showing = await upcomingOn(b, day(3), 'Pair');
    await a.google.setOccurrence(await upcomingOn(a, day(3), 'Pair'), { skip: true });
    await expect(b.google.editOccurrence(showing, fields('Pair late', day(3), 900))).rejects.toThrow('This task was deleted meanwhile');
    await a.look();
    expect(lines(await calendarOf(a, day(3), day(3)), ['upcoming'], /^Pair/)).toEqual([]);

    // A new rule (weekdays) saved in a window that never saw two upcoming tasks edited alone, tomorrow and on a weekend day.
    const gym = await daily(planner, a, listId, 'Gym');
    const c = await openWindow(planner);
    const weekday = [1, 2, 3, 4, 5, 6, 7].map(day).find((date) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()))!;
    const weekend = [1, 2, 3, 4, 5, 6, 7].map(day).find((date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()))!;
    await a.google.editOccurrence(await upcomingOn(a, weekday, 'Gym'), fields('Gym with Ann', weekday, 900));
    await a.google.editOccurrence(await upcomingOn(a, weekend, 'Gym'), fields('Gym on the weekend', weekend, 600));
    const staleWeekend = await upcomingOn(a, weekend, 'Gym');
    await c.google.saveListTask(gym.first, fields('Gym', today, 540, { rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }), 'all');
    await a.look();
    const week = await calendarOf(a, day(1), day(7));
    expect(week.filter((item) => item.upcoming?.seriesId === gym.seriesId && item.upcoming.change).map((item) => [item.date, item.title])).toEqual([[weekday, 'Gym with Ann']]);
    // The weekend one is gone with its day: editing it again from a window that still shows it is refused.
    await expect(a.google.editOccurrence(staleWeekend, fields('Gym on the weekend at 11', weekend, 660))).rejects.toThrow('This task is no longer in its series');
    await idle(planner);
  }, 20_000);

  test('"This and following tasks" while an edit of an upcoming task it takes waits: the edit is refused, never accepted and then lost; after it, one it took is refused, one before it kept, and All tasks from a stale window keeps the end', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Cuts');
    const cut = await daily(planner, a, listId, 'Cut');
    await a.google.completeListTask(cut.first, true);
    const head = await openOne(planner, a, 'Cut');
    const b = await openWindow(planner);
    const shown = await upcomingOn(b, day(2), 'Cut');
    planner.google!.delayNext('DELETE', `/tasks/v1/lists/${listId}/tasks/${head.id}`, 250);
    const cutting = a.google.deleteListTask(head, 'following');
    await until(() => planner.google!.requests.some((request) => request.method === 'DELETE' && request.path.endsWith(`/${head.id}`)), 5000, 5);
    const editing = b.google.editOccurrence(shown, fields('Cut late', day(2), 900)).then(() => 'accepted', (error: Error) => error.message);
    await cutting;
    expect(await editing).toBe('This task is no longer in its series');
    expect(inGoogle(planner, head.id)).toBeNull();
    expect(heads(await planner.state(), cut.seriesId)).toEqual([]);
    await b.look();
    expect(lines(await calendarOf(b, today, day(6)), ['upcoming'], /^Cut/)).toEqual([]);

    // Cut from a later date: an upcoming task it took is refused, one before it kept; All tasks from a window opened
    // before the cut (its form shows the series without its end) keeps the end.
    const end = await daily(planner, a, listId, 'Ends');
    const c = await openWindow(planner);
    const d = await openWindow(planner);
    const later = await upcomingOn(c, day(4), 'Ends');
    const earlier = await upcomingOn(c, day(1), 'Ends');
    await a.google.deleteSeries({ account: ME, seriesId: end.seriesId, from: day(3) });
    await expect(c.google.editOccurrence(later, fields('Ends late', day(4), 900))).rejects.toThrow('This task is no longer in its series');
    await c.google.editOccurrence(earlier, fields('Ends early', day(1), 900));
    await d.google.saveListTask(end.first, fields('Ends', today, 600, { rule: DAILY }), 'all');
    await a.look();
    expect(lines(await calendarOf(a, day(1), day(6)), ['upcoming']).filter((line) => line.includes('Ends'))).toEqual([`upcoming: Ends early ${day(1)} 900`, `upcoming: Ends ${day(2)} 600`]);
    expect(await kept(planner, end.first.id)).toMatchObject({ time: 600, repeat: { template: { time: 600 } } });
    await idle(planner);
  }, 20_000);

  test("an occurrence moved alone onto tomorrow, and the series' open task gone from Google (review 9): each date keeps its own task, made once", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Moved');
    // Today's moved alone to tomorrow at 1pm: tomorrow shows it and its own 9am.
    const water = await daily(planner, w, listId, 'Water');
    await w.google.saveListTask(water.first, fields('Water', day(1), 780, { rule: DAILY }), 'this');
    await w.look();
    expect(lines(await calendarOf(w, day(1), day(1)), undefined, /^Water$/)).toEqual([`upcoming: Water ${day(1)} 540`, `Water ${day(1)} 780`]);
    // The moved one done: tomorrow's own is made, at 9am, beside it; then that one done: the day after's.
    await w.google.completeListTask(await taskNow(w, listId, water.first.id), true);
    const own = await openOne(planner, w, 'Water');
    expect([own.due, (await kept(planner, own.id))?.time]).toEqual([day(1), 540]);
    expect([dueOf(inGoogle(planner, water.first.id)), (await kept(planner, water.first.id))?.time]).toEqual([day(1), 780]);
    await w.google.completeListTask(own, true);
    expect((await openOne(planner, w, 'Water')).due).toBe(day(2));
    expect(creates(planner, listId).filter((request) => request.body?.title === 'Water')).toHaveLength(3);
    expect(heads(await planner.state(), water.seriesId)).toHaveLength(1);

    // Moved alone past tomorrow, then deleted alone: tomorrow's own is made first, once.
    const fern = await daily(planner, w, listId, 'Fern');
    await w.google.saveListTask(fern.first, fields('Fern', day(2), 780, { rule: DAILY }), 'this');
    await w.google.deleteListTask(await taskNow(w, listId, fern.first.id), 'this');
    expect((await openOne(planner, w, 'Fern')).due).toBe(day(1));
    expect(heads(await planner.state(), fern.seriesId)).toHaveLength(1);

    // Its open task deleted in Google's own apps: a read of its list makes the next one (as This task); moved to another list there, followed.
    const gone = await daily(planner, w, listId, 'Gone');
    deleteInGoogle(planner, gone.first.id);
    await w.google.loadBoard(ME, listId);
    expect(await until(async () => openTitled(planner, 'Gone').length === 1)).toBe(true);
    await idle(planner);
    const next = await openOne(planner, w, 'Gone');
    expect(next.due).toBe(day(1));
    expect(await kept(planner, gone.first.id)).toBeNull();
    expect(heads(await planner.state(), gone.seriesId)).toEqual([next.id]);
    moveInGoogle(planner, next.id, 'L2');
    await w.google.loadBoard(ME, listId);
    expect(await until(async () => (await kept(planner, next.id))?.listId === 'L2')).toBe(true);
    await idle(planner);
    expect(openTitled(planner, 'Gone')).toHaveLength(1);
  }, 20_000);
});

describe('deleting a repeating task, and Undo', () => {
  const planner = usePlanner({ google: world(), zone });

  test('"This task" is all or nothing (review 7): its next one is made first; Google refusing it, nothing is deleted, after a restart too, and deleting again makes exactly one', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'This task');
    const { first } = await daily(planner, w, listId, 'Daily standup', { time: 660 });
    await w.google.deleteListTask(first, 'this');
    expect(inGoogle(planner, first.id)).toBeNull();
    const next = await openOne(planner, w, 'Daily standup');
    expect([next.due, next.notes]).toEqual([day(1), 'Series notes']);
    expect(await kept(planner, next.id)).toMatchObject({ time: 660, repeat: { index: 2, next: null } });
    expect(await kept(planner, first.id)).toBeNull();
    const writes = taskWrites(planner).filter((request) => request.path.startsWith(`/tasks/v1/lists/${listId}/`)).map((request) => request.method);
    expect(writes).toEqual(['POST', 'POST', 'DELETE']);

    const again = await daily(planner, w, listId, 'Standup two', { time: 660 });
    await w.google.loadBoard(ME, listId);
    const keptBefore = await kept(planner, again.first.id);
    planner.google!.failNext('POST', `/tasks/v1/lists/${listId}/tasks`, 503, 'Backend Error');
    await expect(w.google.deleteListTask(again.first, 'this')).rejects.toThrow(`the next "Standup two" couldn't be made, so this one stays (Backend Error)`);
    expect(taskWrites(planner).some((request) => request.method === 'DELETE' && request.path.endsWith(`/${again.first.id}`))).toBe(false);
    expect(inGoogle(planner, again.first.id)).toMatchObject({ status: 'needsAction', due: at(0) });
    expect(await kept(planner, again.first.id)).toEqual(keptBefore);
    expect(w.google.getView().board[listKey(ME, listId)]!.items.map((task) => task.id)).toContain(again.first.id);
    await idle(planner);
    await planner.restart();
    expect(await kept(planner, again.first.id)).toEqual(keptBefore);
    await w.google.deleteListTask(again.first, 'this');
    expect(inGoogle(planner, again.first.id)).toBeNull();
    expect((await openOne(planner, w, 'Standup two')).due).toBe(day(1));
    expect(creates(planner, listId).filter((request) => request.body?.title === 'Standup two' && dueOf(request.body) === day(1))).toHaveLength(2);
    await idle(planner);
  }, 20_000);

  test('"This task", Google refusing the delete once the next is made: both stay, linked, and it says so; deleting again finishes with no second; completed with its next refused, the next read makes exactly one', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Refusals');
    const { first } = await daily(planner, w, listId, 'Evening standup', { time: 660 });
    planner.google!.failNext('DELETE', `/tasks/v1/lists/${listId}/tasks/${first.id}`, 503, 'Backend Error');
    await expect(w.google.deleteListTask(first, 'this')).rejects.toThrow(/^Backend Error; its next task, .+, is made, so deleting this one again finishes$/);
    const next = openTitled(planner, 'Evening standup').find((task) => task.id !== first.id)!;
    expect(inGoogle(planner, first.id)).not.toBeNull();
    expect(dueOf(next)).toBe(day(1));
    expect((await kept(planner, first.id))?.repeat?.next).toBe(next.id);
    await w.google.deleteListTask(await taskNow(w, listId, first.id), 'this');
    expect(inGoogle(planner, first.id)).toBeNull();
    expect(openTitled(planner, 'Evening standup').map((task) => task.id)).toEqual([next.id]);
    expect(creates(planner, listId).filter((request) => request.body?.title === 'Evening standup')).toHaveLength(2);

    // Completed with its next refused: it keeps its series and its upcoming ones; the next read makes exactly one.
    const run = await daily(planner, w, listId, 'Morning run');
    planner.google!.failNext('POST', `/tasks/v1/lists/${listId}/tasks`, 503, 'Backend Error');
    await w.google.completeListTask(run.first, true);
    expect(w.notes.some((note) => note.startsWith('Google Tasks did not take the next "Morning run"'))).toBe(true);
    expect(openTitled(planner, 'Morning run')).toEqual([]);
    await w.look();
    expect(lines(await calendarOf(w, day(1), day(2)), ['upcoming'], /^Morning run/)).toEqual([`upcoming: Morning run ${day(1)} 540`, `upcoming: Morning run ${day(2)} 540`]);
    const done = await taskNow(w, listId, run.first.id);
    await w.google.syncItems([done]);
    await w.google.syncItems([done]);
    expect((await openOne(planner, w, 'Morning run')).due).toBe(day(1));
    // The same, deleted with This task before a read: its next one first, so the series never goes.
    const swim = await daily(planner, w, listId, 'Swim');
    planner.google!.failNext('POST', `/tasks/v1/lists/${listId}/tasks`, 503, 'Backend Error');
    await w.google.completeListTask(swim.first, true);
    await idle(planner);
    await w.google.deleteListTask(await taskNow(w, listId, swim.first.id), 'this');
    expect(inGoogle(planner, swim.first.id)).toBeNull();
    const made = await openOne(planner, w, 'Swim');
    expect([made.due, (await kept(planner, made.id))?.time]).toEqual([day(1), 540]);
    await idle(planner);
  }, 20_000);

  test('"This and following tasks" and "All tasks", as Google Calendar deletes them (review 8): what came before stays, nothing is made past the cut; a delete Google refuses changes nothing', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Series cuts');
    // From an upcoming one two days ahead: today's task and tomorrow's stay; that day and the ones after go.
    const plants = await daily(planner, w, listId, 'Water the plants');
    const beforeCut = inGoogle(planner, plants.first.id);
    await w.google.deleteSeries({ account: ME, seriesId: plants.seriesId, from: day(2) });
    expect(taskWrites(planner).filter((request) => request.method === 'DELETE' && request.path.startsWith(`/tasks/v1/lists/${listId}/`))).toEqual([]);
    expect(inGoogle(planner, plants.first.id)).toEqual(beforeCut);
    expect(lines(await calendarOf(w, day(1), day(6)), ['upcoming'], /^Water the plants/)).toEqual([`upcoming: Water the plants ${day(1)} 540`]);
    const reloaded = await openWindow(planner);
    expect(lines(await calendarOf(reloaded, day(1), day(6)), ['upcoming'], /^Water the plants/)).toEqual([`upcoming: Water the plants ${day(1)} 540`]);
    // Today's done: tomorrow's is made; tomorrow's done: the series ends.
    await w.google.completeListTask(plants.first, true);
    const tomorrow = await openOne(planner, w, 'Water the plants');
    expect(tomorrow.due).toBe(day(1));
    await w.google.completeListTask(tomorrow, true);
    await idle(planner);
    expect(openTitled(planner, 'Water the plants')).toEqual([]);
    expect(creates(planner, listId).filter((request) => request.body?.title === 'Water the plants')).toHaveLength(2);

    // From the open task: it goes in Google; the completed ones before it stay; nothing repeats.
    const ferns = await daily(planner, w, listId, 'Mist the ferns');
    await w.google.completeListTask(ferns.first, true);
    const open = await openOne(planner, w, 'Mist the ferns');
    await w.google.loadBoard(ME, listId);
    await w.google.deleteListTask(open, 'following');
    expect(inGoogle(planner, open.id)).toBeNull();
    expect(inGoogle(planner, ferns.first.id)).toMatchObject({ status: 'completed' });
    expect(heads(await planner.state(), ferns.seriesId)).toEqual([]);
    await w.look();
    expect(lines(await calendarOf(w, day(1), day(6)), ['upcoming']).filter((line) => line.includes('ferns'))).toEqual([]);

    // All tasks: the open task and the completed ones go in Google, open ones first; a delete Google refuses changes nothing.
    const herbs = await daily(planner, w, listId, 'Cut the herbs');
    await w.google.completeListTask(herbs.first, true);
    const second = await openOne(planner, w, 'Cut the herbs');
    planner.google!.failNext('DELETE', `/tasks/v1/lists/${listId}/tasks/${second.id}`, 503, 'Backend Error');
    await expect(w.google.deleteListTask(second, 'all')).rejects.toThrow('Backend Error');
    expect(inGoogle(planner, second.id)).not.toBeNull();
    expect(heads(await planner.state(), herbs.seriesId)).toEqual([second.id]);
    await w.google.deleteListTask(second, 'all');
    expect(await until(() => !inGoogle(planner, herbs.first.id))).toBe(true);
    const deletes = taskWrites(planner).filter((request) => request.method === 'DELETE' && [second.id, herbs.first.id].some((id) => request.path.endsWith(`/${id}`)));
    expect(deletes.map((request) => request.path.split('/').at(-1))).toEqual([second.id, second.id, herbs.first.id]);
    expect(Object.values((await planner.state()).googleTasks).filter((entry) => entry.repeat?.seriesId === herbs.seriesId)).toEqual([]);
    await idle(planner);
  }, 20_000);

  test('two windows: one ends the series from the day after tomorrow while the other is making tomorrow\'s; tomorrow\'s stays, nothing after it (review 8)', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Cut race');
    const { first, seriesId } = await daily(planner, a, listId, 'Feed the cat');
    const b = await openWindow(planner);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250);
    const completing = b.google.completeListTask(first, true);
    await until(() => planner.google!.requests.some((request) => request.method === 'POST' && request.body?.title === 'Feed the cat' && dueOf(request.body) === day(1)), 5000, 5);
    await Promise.all([completing, a.google.deleteSeries({ account: ME, seriesId, from: day(2) })]);
    await idle(planner);
    const open = await openOne(planner, a, 'Feed the cat');
    expect(open.due).toBe(day(1));
    expect((await kept(planner, first.id))?.repeat?.next).toBe(open.id);
    expect(heads(await planner.state(), seriesId)).toEqual([open.id]);
    await a.look();
    expect(lines(await calendarOf(a, day(1), day(6)), ['upcoming']).filter((line) => line.includes('cat'))).toEqual([]);
  }, 20_000);

  test("Undo after Delete: a task comes back with its subtasks and what was kept for them, from a window that never read its list too; a subtask Google refuses is said; a list that can't be read deletes nothing", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Undo');
    const trip = await w.google.addListTask(ME, listId, { title: 'Trip', due: today }, { time: 600, deadline: day(5), color: '#d50000' });
    const hotel = await w.google.addListTask(ME, listId, { title: 'Hotel', parent: trip.id });
    const flight = await w.google.addListTask(ME, listId, { title: 'Flight', parent: trip.id, previous: hotel.id, due: today }, { time: 540 });
    await w.google.toggleStar(flight);
    // From the calendar of a fresh window (no list loaded).
    const cold = await openWindow(planner);
    expect(cold.google.canUndo()).toBe(false);
    await cold.google.deleteListTask(await taskNow(cold, listId, trip.id));
    expect([inGoogle(planner, trip.id), inGoogle(planner, hotel.id), await kept(planner, trip.id)]).toEqual([null, null, null]);
    expect(await cold.google.undoLast()).toEqual({ done: 'Deletion undone', note: null });
    expect([inGoogle(planner, trip.id)?.title, inGoogle(planner, hotel.id)?.parent, inGoogle(planner, flight.id)?.parent]).toEqual(['Trip', trip.id, trip.id]);
    expect(await kept(planner, trip.id)).toMatchObject({ time: 600, deadline: day(5), color: '#d50000' });
    expect(await kept(planner, flight.id)).toMatchObject({ time: 540, starredAt: expect.any(String) });
    expect(await cold.google.undoLast()).toBeNull();
    // The service gives back only "deleted: false", what Undo writes.
    expect((await planner.call('PATCH', '/google/tasks', { account: ME, listId, id: trip.id, deleted: true })).status).toBe(400);

    // A subtask Google refuses to give back is said; the task and the other come back.
    await w.google.loadBoard(ME, listId);
    await w.google.deleteListTask(await taskNow(w, listId, trip.id));
    planner.google!.failNext('PATCH', `/tasks/v1/lists/${listId}/tasks/${hotel.id}`, 503, 'Backend Error');
    expect(await w.google.undoLast()).toEqual({ done: 'Deletion undone', note: 'Google Tasks did not give back 1 of its 2 subtasks' });
    expect([Boolean(inGoogle(planner, trip.id)), Boolean(inGoogle(planner, hotel.id)), Boolean(inGoogle(planner, flight.id))]).toEqual([true, false, true]);
    // Its list can't be read now: nothing is deleted, to try again.
    const stop = failing(w, '/google/tasks/all');
    await expect(w.google.deleteListTask(await taskNow(w, listId, trip.id))).rejects.toBeInstanceOf(FreshnessError);
    stop();
    expect(inGoogle(planner, trip.id)).not.toBeNull();
    expect(w.google.canUndo()).toBe(false);

    // Delete all completed tasks: the ones Google has completed now; one reopened in another window since stays.
    const done = await w.google.addListTask(ME, listId, { title: 'Done' });
    const reopened = await w.google.addListTask(ME, listId, { title: 'Reopened elsewhere' });
    await w.google.completeListTask(done, true);
    await w.google.completeListTask(reopened, true);
    await w.google.loadBoard(ME, listId);
    changeInGoogle(planner, reopened.id, { status: 'needsAction', completed: null });
    expect(await w.google.clearCompleted(ME, listId)).toBe(1);
    expect([inGoogle(planner, done.id), Boolean(inGoogle(planner, reopened.id))]).toEqual([null, true]);
    await idle(planner);
  }, 20_000);

  test('Undo after Delete, a series: This task (its next goes again, the task back as kept, color and attachments too), its next changed meanwhile (it stays, said), This and following (rule and changes back), All tasks (every task back)', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Series undo');
    const water = await daily(planner, a, listId, 'Water', { color: '#d50000', attachments: [doc('a1', 'Plan')] });
    await a.google.deleteListTask(water.first, 'this');
    const made = await openOne(planner, a, 'Water');
    expect(await a.google.undoLast()).toEqual({ done: 'Deletion undone', note: null });
    expect([Boolean(inGoogle(planner, water.first.id)), inGoogle(planner, made.id)]).toEqual([true, null]);
    expect(await kept(planner, water.first.id)).toMatchObject({ color: '#d50000', attachments: [doc('a1', 'Plan')], repeat: { seriesId: water.seriesId, next: null } });
    expect(heads(await planner.state(), water.seriesId)).toEqual([water.first.id]);
    expect(await a.google.undoLast()).toBeNull();
    // It goes on from it: completing it makes one next task.
    await a.google.completeListTask(await taskNow(a, listId, water.first.id), true);
    expect((await openOne(planner, a, 'Water')).due).toBe(day(1));

    // Its next one changed in another window meanwhile: Undo brings the task back beside it, linked, and says so.
    const ferns = await daily(planner, a, listId, 'Ferns');
    await a.google.deleteListTask(ferns.first, 'this');
    const next = await openOne(planner, a, 'Ferns');
    const b = await openWindow(planner);
    await b.google.saveListTask(next, fields('Water the ferns', day(1), 540, { rule: DAILY }), 'this');
    expect((await a.google.undoLast())?.note).toContain('stays');
    expect([inGoogle(planner, next.id)?.title, Boolean(inGoogle(planner, ferns.first.id))]).toEqual(['Water the ferns', true]);
    expect((await kept(planner, ferns.first.id))?.repeat?.next).toBe(next.id);
    expect(heads(await planner.state(), ferns.seriesId)).toEqual([next.id]);

    // This and following tasks: Undo gives the series its rule and the changes it dropped back; one made meanwhile before the cut stays.
    const cut = await daily(planner, a, listId, 'Cut');
    await a.google.editOccurrence(await upcomingOn(a, day(3), 'Cut'), fields('Cut late', day(3), 900));
    await a.google.deleteSeries({ account: ME, seriesId: cut.seriesId, from: day(2) });
    const c = await openWindow(planner);
    await c.google.editOccurrence(await upcomingOn(c, day(1), 'Cut'), fields('Cut early', day(1), 600));
    expect(await a.google.undoLast()).toEqual({ done: 'Deletion undone', note: null });
    await a.look();
    expect(lines(await calendarOf(a, day(1), day(4)), ['upcoming']).filter((line) => line.includes('Cut'))).toEqual([`upcoming: Cut early ${day(1)} 600`, `upcoming: Cut ${day(2)} 540`, `upcoming: Cut late ${day(3)} 900`, `upcoming: Cut ${day(4)} 540`]);

    // All tasks, a completed task among them: Undo gives every task back in Google, as it was kept.
    const all = await daily(planner, a, listId, 'All of it');
    await a.google.completeListTask(all.first, true);
    const second = await openOne(planner, a, 'All of it');
    await a.google.deleteSeries({ account: ME, seriesId: all.seriesId, from: null });
    expect(await until(() => !inGoogle(planner, all.first.id) && !inGoogle(planner, second.id))).toBe(true);
    await a.google.undoLast();
    expect([Boolean(inGoogle(planner, all.first.id)), Boolean(inGoogle(planner, second.id))]).toEqual([true, true]);
    expect((await kept(planner, all.first.id))?.repeat?.next).toBe(second.id);
    expect(heads(await planner.state(), all.seriesId)).toEqual([second.id]);
    await idle(planner);
  }, 20_000);

  test('Undo after completing: a task opens again before its subtasks; a series\' next one goes again, unless it was completed meanwhile (said); reopened by hand, nothing is left to undo; the last of a series repeats again', async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Completion undo');
    const trip = await a.google.addListTask(ME, listId, { title: 'Trip' });
    const hotel = await a.google.addListTask(ME, listId, { title: 'Hotel', parent: trip.id });
    await a.google.loadBoard(ME, listId);
    let mark = planner.google!.requests.length;
    await a.google.completeListTask(trip, true);
    expect(await a.google.undoLast()).toEqual({ done: 'Completion undone', note: null });
    const patched = taskWrites(planner, mark).filter((request) => request.method === 'PATCH').map((request) => `${request.path.split('/').at(-1)}:${request.body.status}`);
    expect(patched).toEqual([`${hotel.id}:completed`, `${trip.id}:completed`, `${trip.id}:needsAction`, `${hotel.id}:needsAction`]);
    expect(a.google.canUndo()).toBe(false);

    const run = await daily(planner, a, listId, 'Run');
    await a.google.completeListTask(run.first, true);
    const made = await openOne(planner, a, 'Run');
    expect(a.google.canUndo()).toBe(true);
    expect(await a.google.undoLast()).toEqual({ done: 'Completion undone', note: null });
    expect([inGoogle(planner, run.first.id)?.status, inGoogle(planner, made.id), await kept(planner, made.id)]).toEqual(['needsAction', null, null]);
    expect(heads(await planner.state(), run.seriesId)).toEqual([run.first.id]);
    await a.google.completeListTask(await taskNow(a, listId, run.first.id), true);
    expect((await openOne(planner, a, 'Run')).due).toBe(day(1));

    // Its next one completed in another window meanwhile: Undo opens the task again beside it, and says so.
    const jog = await daily(planner, a, listId, 'Jog');
    await a.google.completeListTask(jog.first, true);
    const next = await openOne(planner, a, 'Jog');
    await (await openWindow(planner)).google.completeListTask(next, true);
    expect((await a.google.undoLast())?.note).toContain('stays');
    expect([inGoogle(planner, jog.first.id)?.status, inGoogle(planner, next.id)?.status]).toEqual(['needsAction', 'completed']);
    expect(heads(await planner.state(), jog.seriesId)).toHaveLength(1);
    // Opened again by hand: nothing to undo.
    const walk = await daily(planner, a, listId, 'Walk');
    await a.google.completeListTask(walk.first, true);
    await a.google.completeListTask(await taskNow(a, listId, walk.first.id), false);
    expect(a.google.canUndo()).toBe(false);
    // The last task of a series that ends with it: open again, it repeats again.
    mark = planner.google!.requests.length;
    const last = await a.google.addListTask(ME, listId, { title: 'Last', due: today }, { time: 540, rule: 'RRULE:FREQ=DAILY;COUNT=1' });
    await a.google.completeListTask(last, true);
    expect((await kept(planner, last.id))?.repeat ?? null).toBeNull();
    await a.google.undoLast();
    expect(inGoogle(planner, last.id)?.status).toBe('needsAction');
    expect((await kept(planner, last.id))?.repeat).toMatchObject({ rule: 'RRULE:FREQ=DAILY;COUNT=1', next: null });
    await idle(planner);
  }, 20_000);
});

describe('one upcoming task changed or deleted on its own, as in Google Calendar (review 7)', () => {
  const planner = usePlanner({ google: world(), zone });

  test('deleted, edited or moved alone: the calendar shows each so, the rest as the series has them; completing one after another makes each as shown; a deleted one given back shows again; it keeps a date', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Occurrences');
    const { first } = await daily(planner, w, listId, 'Daily standup', { time: 660 });
    await w.google.setOccurrence(await upcomingOn(w, day(1), 'Daily standup'), { skip: true });
    await w.google.editOccurrence(await upcomingOn(w, day(3), 'Daily standup'), fields('Standup with Ann', day(3), 900));
    await w.google.editOccurrence(await upcomingOn(w, day(4), 'Daily standup'), fields('Daily standup', day(6), 660, { notes: 'Moved on' }));
    // Only those dates changed: Google got nothing new, and the open task is as it was.
    expect(taskWrites(planner).filter((request) => request.path.startsWith(`/tasks/v1/lists/${listId}/`))).toHaveLength(1);
    expect(lines(await calendarOf(w, day(1), day(6)), ['upcoming'])).toEqual([
      `upcoming: Daily standup ${day(2)} 660`,
      `upcoming: Standup with Ann ${day(3)} 900`,
      `upcoming: Daily standup ${day(5)} 660`,
      `upcoming: Daily standup ${day(6)} 660`,
      `upcoming: Daily standup ${day(6)} 660`,
    ]);
    // Completed one after another: past the deleted date, the edited one with its own values, then the series' again.
    const complete = async () => {
      await w.google.completeListTask(await openOne(planner, w, openTitled(planner, 'Daily standup')[0] ? 'Daily standup' : 'Standup with Ann'), true);
      await idle(planner, 60);
      const open = [...openTitled(planner, 'Daily standup'), ...openTitled(planner, 'Standup with Ann')];
      expect(open).toHaveLength(1);
      return open[0]!;
    };
    void first;
    const second = await complete();
    expect([second.title, dueOf(second), (await kept(planner, second.id))?.time]).toEqual(['Daily standup', day(2), 660]);
    const third = await complete();
    expect([third.title, dueOf(third), (await kept(planner, third.id))?.time]).toEqual(['Standup with Ann', day(3), 900]);
    const fourth = await complete();
    expect([fourth.title, dueOf(fourth), fourth.notes]).toEqual(['Daily standup', day(6), 'Moved on']);
    // Deleted alone, then given back (Undo): it shows again; edited back to its series, it is the series' again.
    await w.look();
    const fifth = await upcomingOn(w, day(5), 'Daily standup');
    const before = await w.google.setOccurrence(fifth, { skip: true });
    await w.look();
    expect(lines(await calendarOf(w, day(5), day(5)), ['upcoming'])).toEqual([]);
    await w.google.setOccurrence(fifth, before);
    await w.look();
    expect(lines(await calendarOf(w, day(5), day(5)), ['upcoming'])).toEqual([`upcoming: Daily standup ${day(5)} 660`]);
    // A date of its own is required: deleting is how one goes.
    await expect(w.google.editOccurrence(fifth, fields('Daily standup', null, 660))).rejects.toThrow(OCCURRENCE_KEEPS_DATE);
    await idle(planner);
  }, 20_000);

  test("All tasks keeps the upcoming tasks changed alone, each with its own and the series' new values; a new rule or start keeps only those still on it; This task leaves them; Undo after deleting one alone gives back what the service had", async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Weekly');
    const WEEKLY = /Weekly sync|Monthly review|Weekly review/;
    const review = await a.google.addListTask(ME, listId, { title: 'Weekly review', due: today }, { time: 660, rule: 'RRULE:FREQ=WEEKLY' });
    await a.google.setOccurrence(await upcomingOn(a, day(7), 'Weekly review'), { skip: true });
    await a.google.editOccurrence(await upcomingOn(a, day(14), 'Weekly review'), fields('Monthly review', day(14), 660, { notes: '' }));
    // All tasks, a new title and 9am: the changed ones stay; the edited one keeps its title and takes the new time.
    await a.google.saveListTask(review, fields('Weekly sync', today, 540, { rule: 'RRULE:FREQ=WEEKLY', notes: '' }), 'all');
    await a.look();
    expect(lines(await calendarOf(a, day(1), day(21)), ['upcoming'], WEEKLY)).toEqual([`upcoming: Monthly review ${day(14)} 540`, `upcoming: Weekly sync ${day(21)} 540`]);
    // A new rule both dates are still on (daily): both stay.
    await a.google.saveListTask(await taskNow(a, listId, review.id), fields('Weekly sync', today, 540, { rule: DAILY, notes: '' }), 'all');
    await a.look();
    const dailyWeek = lines(await calendarOf(a, day(6), day(8)), ['upcoming'], WEEKLY);
    expect(dailyWeek).toEqual([`upcoming: Weekly sync ${day(6)} 540`, `upcoming: Weekly sync ${day(8)} 540`]);
    // Weekly again from tomorrow: neither date is on it any more.
    await a.google.saveListTask(await taskNow(a, listId, review.id), fields('Weekly sync', day(1), 540, { rule: 'RRULE:FREQ=WEEKLY', notes: '' }), 'all');
    await a.look();
    expect(lines(await calendarOf(a, day(2), day(15)), ['upcoming'], WEEKLY)).toEqual([`upcoming: Weekly sync ${day(8)} 540`, `upcoming: Weekly sync ${day(15)} 540`]);
    // This task leaves them alone.
    await a.google.setOccurrence(await upcomingOn(a, day(8), 'Weekly sync'), { skip: true });
    await a.google.saveListTask(await taskNow(a, listId, review.id), fields('Just this one', day(1), 540, { rule: 'RRULE:FREQ=WEEKLY', notes: '' }), 'this');
    await a.look();
    expect(lines(await calendarOf(a, day(2), day(15)), ['upcoming'], WEEKLY)).toEqual([`upcoming: Weekly sync ${day(15)} 540`]);

    // Deleted alone from a window that has not looked since another window changed it: Undo gives back that change (review 11).
    const stale = await daily(planner, a, listId, 'Stale day');
    const shownA = await upcomingOn(a, day(1), 'Stale day');
    const b = await openWindow(planner);
    const shownB = await upcomingOn(b, day(1), 'Stale day');
    const baseB = occurrenceShown(b, shownB, stale.first);
    await b.google.editOccurrence(shownB, sent({ ...baseB, title: 'Stale day with Ann' }, baseB));
    expect(shownA.change).toBeUndefined();
    const replaced = await a.google.setOccurrence(shownA, { skip: true });
    expect(replaced).toEqual({ title: 'Stale day with Ann' });
    await a.google.setOccurrence(shownA, replaced);
    await a.look();
    expect(lines(await calendarOf(a, day(1), day(1)), ['upcoming']).filter((line) => line.includes('Stale'))).toEqual([`upcoming: Stale day with Ann ${day(1)} 540`]);
    // Its edit whose read of the plan fails writes nothing, and says so; it saves once it can read.
    const baseA = occurrenceShown(a, await upcomingOn(a, day(2), 'Stale day'), stale.first);
    const stop = failing(a, '/state');
    const refused = await a.google.editOccurrence(await upcomingOn(a, day(2), 'Stale day'), sent({ ...baseA, title: 'Stale day, renamed' }, baseA)).catch((error: unknown) => error);
    stop();
    expect(refused).toBeInstanceOf(FreshnessError);
    expect((refused as FreshnessError).what).toBe("the Planner's plan");
    await a.look();
    expect(lines(await calendarOf(a, day(2), day(2)), ['upcoming']).filter((line) => line.includes('Stale'))).toEqual([`upcoming: Stale day ${day(2)} 540`]);
    await a.google.editOccurrence(await upcomingOn(a, day(2), 'Stale day'), sent({ ...baseA, title: 'Stale day, renamed' }, baseA));
    await a.look();
    expect(lines(await calendarOf(a, day(2), day(2)), ['upcoming']).filter((line) => line.includes('Stale'))).toEqual([`upcoming: Stale day, renamed ${day(2)} 540`]);
    await idle(planner);
  }, 20_000);
});

describe('what the Planner keeps for a Google task: color, Drive files, Do not disturb, declining meetings (a work account)', () => {
  const work = world({ hostedDomain: 'example.com', granted: [...DEFAULT_SCOPES], driveFiles: [
    { id: 'd-plan', name: 'Q4 plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/d-plan/edit', modifiedTime: '2026-10-20T10:00:00Z' },
    { id: 'd-budget', name: 'Budget 2027', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://docs.google.com/spreadsheets/d/d-budget/edit', modifiedTime: '2026-10-25T10:00:00Z' },
    { id: 'd-folder', name: 'Budget folder', mimeType: 'application/vnd.google-apps.folder', webViewLink: 'https://drive.google.com/drive/folders/d-folder' },
    { id: 'd-old', name: 'Old budget', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/d-old/view', trashed: true },
    ...Array.from({ length: 35 }, (_, n) => ({ id: `d-notes-${n}`, name: `Notes ${n}`, mimeType: 'application/pdf', webViewLink: `https://drive.google.com/file/d/d-notes-${n}/view`, modifiedTime: `2026-09-${String((n % 28) + 1).padStart(2, '0')}T10:00:00Z` })),
  ] });
  const planner = usePlanner({ google: work, zone });
  const RED = '#d50000';
  const minutesNow = () => Math.floor(zonedDateMinutes(Date.now(), zone).minutes);
  const invite = (id: string, summary: string, date: DateKey, from: number, to: number, created: string, mine = false) => ({
    id, summary, created, start: { dateTime: instantAt(date, from, zone) }, end: { dateTime: instantAt(date, to, zone) },
    organizer: { email: mine ? ME : 'lead@example.com', ...(mine ? { self: true } : {}) },
    attendees: mine ? [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', responseStatus: 'needsAction' }] : [{ email: 'lead@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'needsAction' }],
  });
  const events = () => planner.google!.calendars.get('primary')!.events;
  const self = (id: string) => events().get(id).attendees.find((guest: { self?: boolean }) => guest.self);

  test("saved from the form: color, attachments, availability, visibility, Do not disturb and declining are kept in the Planner, never sent to Google; left out they stay; Free ends declining", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Deep work');
    const task = await w.google.addListTask(ME, listId, { title: 'Deep work', due: today }, { time: 600, duration: 60, busy: true });
    const mark = planner.google!.requests.length;
    await w.google.saveListTask(task, fields('Deep work', today, 600, { notes: '', duration: 60, busy: true, visibility: 'private', color: '#0b8043', attachments: [doc('a1', 'Q4 plan')], doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } }));
    expect(await kept(planner, task.id)).toMatchObject({ busy: true, visibility: 'private', color: '#0b8043', attachments: [doc('a1', 'Q4 plan')], doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } });
    expect(Date.parse((await kept(planner, task.id))!.decline!.since)).toBeGreaterThan(0);
    expect(taskWrites(planner, mark)).toEqual([]);
    // Declining is asked for at once, not at the service's next pass.
    expect(await until(() => w.calls.some((call) => call.path === '/google/tasks/decline'))).toBe(true);
    // Fields that leave them out leave them as they are; Free ends declining, Do not disturb stays.
    await w.google.saveListTask(task, { title: 'Deep work', notes: '', due: today, kept: { time: 600, duration: 60, deadline: null, rule: null } });
    expect(await kept(planner, task.id)).toMatchObject({ color: '#0b8043', doNotDisturb: true, visibility: 'private', decline: { mode: 'new' } });
    await w.google.saveListTask(task, fields('Deep work', today, 600, { notes: '', duration: 60, busy: false }));
    expect((await kept(planner, task.id))!.decline).toBeUndefined();
    expect((await kept(planner, task.id))!.doNotDisturb).toBe(true);
    // All day: what comes with a time goes with it; the color stays.
    await w.google.saveListTask(task, fields('Deep work', today, null, { notes: '' }));
    expect(await kept(planner, task.id)).toMatchObject({ color: '#0b8043' });
    expect([(await kept(planner, task.id))!.doNotDisturb, (await kept(planner, task.id))!.visibility]).toEqual([undefined, undefined]);
    await idle(planner);
  });

  test("a repeating task's color, availability, Do not disturb and declining are its series' (All tasks, even from This task, declined at once); its files are this task's or all of them; a window that never saw them leaves them; the next task has them, Google slow or not", async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Focus');
    const focus = await daily(planner, a, listId, 'Focus');
    const b = await openWindow(planner);
    await a.google.saveListTask(focus.first, fields('Focus', today, 540, { rule: DAILY, busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')] }), 'all');
    expect(await kept(planner, focus.first.id)).toMatchObject({ busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')] });
    // B's view is from before: its form has none of them, and it renames the series alone.
    await b.google.saveListTask(focus.first, fields('Focus time', today, 540, { rule: DAILY, busy: false, color: null, doNotDisturb: false, decline: null, attachments: [] }), 'all');
    expect(await kept(planner, focus.first.id)).toMatchObject({ busy: true, color: RED, doNotDisturb: true, attachments: [doc('a1', 'Plan')], repeat: { template: { title: 'Focus time', color: RED, doNotDisturb: true } } });
    await a.google.completeListTask(await taskNow(a, listId, focus.first.id), true);
    const next = await openOne(planner, a, 'Focus time');
    expect(await kept(planner, next.id)).toMatchObject({ time: 540, busy: true, color: RED, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' }, attachments: [doc('a1', 'Plan')], repeat: { seriesId: focus.seriesId } });

    // This task with a color and declining: for the whole series, through the service, and declined at once.
    const deep = await daily(planner, a, listId, 'Deep');
    const asked = a.calls.length;
    await a.google.saveListTask(deep.first, fields('Deep', today, 540, { rule: DAILY, busy: true, color: RED, decline: { mode: 'all', message: 'Busy' } }), 'this');
    expect(a.calls.slice(asked).filter((call) => call.path === '/google/tasks/series/edit')).toHaveLength(1);
    expect((await kept(planner, deep.first.id))!.repeat!.template).toMatchObject({ busy: true, color: RED, decline: { mode: 'all', message: 'Busy' } });
    expect(await until(() => a.calls.slice(asked).some((call) => call.path === '/google/tasks/decline'))).toBe(true);
    // Files with This task are this task's alone; with All tasks the series'.
    await a.google.saveListTask(await taskNow(a, listId, deep.first.id), fields('Deep', today, 540, { rule: DAILY, busy: true, color: RED, attachments: [doc('o1', 'Own notes')] }), 'this');
    expect((await kept(planner, deep.first.id))!.attachments).toEqual([doc('o1', 'Own notes')]);
    expect((await kept(planner, deep.first.id))!.repeat!.template!.attachments).toBeUndefined();
    await a.google.saveListTask(await taskNow(a, listId, deep.first.id), fields('Deep', today, 540, { rule: DAILY, busy: true, color: RED, attachments: [doc('o1', 'Own notes'), doc('a2', 'Agenda')] }), 'all');
    expect((await kept(planner, deep.first.id))!.repeat!.template).toMatchObject({ attachments: [doc('o1', 'Own notes'), doc('a2', 'Agenda')] });

    // All tasks with a color and a file saved while another window completes the task and Google is slow: the next takes them.
    const sync = await daily(planner, a, listId, 'Sync');
    const c = await openWindow(planner);
    planner.google!.delayNext('POST', `/tasks/v1/lists/${listId}/tasks`, 250);
    const completing = a.google.completeListTask(sync.first, true);
    await until(() => planner.google!.requests.some((request) => request.method === 'POST' && request.body?.title === 'Sync' && dueOf(request.body) === day(1)), 5000, 5);
    await Promise.all([completing, c.google.saveListTask(sync.first, fields('Sync', today, 540, { rule: DAILY, color: RED, attachments: [doc('a3', 'Agenda')] }), 'all')]);
    await idle(planner);
    const made = await openOne(planner, a, 'Sync');
    expect(await kept(planner, made.id)).toMatchObject({ color: RED, attachments: [doc('a3', 'Agenda')], repeat: { template: { color: RED, attachments: [doc('a3', 'Agenda')] } } });
    await idle(planner);
  }, 20_000);

  test("one upcoming task's files are its own: merged over another window's change of its title, made with them, none ([]) kept as none; deleted alone it loses them and Undo gives them back; its open task deleted in Google, the next one has the series' own", async () => {
    const a = await openWindow(planner);
    const listId = await newList(a, 'Reviews');
    const review = await daily(planner, a, listId, 'Review', { color: RED, attachments: [doc('s1', 'Series doc')] });
    const b = await openWindow(planner);
    const shownA = await upcomingOn(a, day(1), 'Review');
    const shownB = await upcomingOn(b, day(1), 'Review');
    await b.google.editOccurrence(shownB, { ...fields('Review with Ann', day(1), 540), kept: { ...fields('Review with Ann', day(1), 540).kept, attachments: [doc('s1', 'Series doc')] } });
    await a.google.editOccurrence(shownA, { ...fields('Review', day(1), 540), kept: { ...fields('Review', day(1), 540).kept, attachments: [doc('s1', 'Series doc'), doc('o1', 'Notes for Ann')] } });
    await a.google.editOccurrence(await upcomingOn(a, day(2), 'Review'), { ...fields('Review', day(2), 540), kept: { ...fields('Review', day(2), 540).kept, attachments: [] } });
    await a.google.completeListTask(review.first, true);
    const second = await openOne(planner, a, 'Review with Ann');
    expect((await kept(planner, second.id))!.attachments).toEqual([doc('s1', 'Series doc'), doc('o1', 'Notes for Ann')]);
    await a.google.completeListTask(second, true);
    const third = await openOne(planner, a, 'Review');
    expect([third.due, (await kept(planner, third.id))!.attachments]).toEqual([day(2), undefined]);
    await a.look();
    expect((await upcomingOn(a, day(3), 'Review')).template.attachments).toEqual([doc('s1', 'Series doc')]);

    // Its own files on the day after: deleted alone they go; Undo gives them back.
    await a.google.editOccurrence(await upcomingOn(a, day(4), 'Review'), { ...fields('Review', day(4), 540), kept: { ...fields('Review', day(4), 540).kept, attachments: [doc('o2', 'Own')] } });
    const own = await upcomingOn(a, day(4), 'Review');
    const before = await a.google.setOccurrence(own, { skip: true });
    expect(before).toEqual({ attachments: [doc('o2', 'Own')] });
    await a.google.setOccurrence(own, before);
    await a.look();
    expect((await upcomingOn(a, day(4), 'Review')).change).toEqual({ attachments: [doc('o2', 'Own')] });
    // Its open task deleted in Google's own apps: the next one has the series' color and files; nothing of the old one stays.
    deleteInGoogle(planner, third.id);
    await a.google.loadBoard(ME, listId);
    expect(await until(async () => openTitled(planner, 'Review').length === 1 && (await kept(planner, third.id)) === null)).toBe(true);
    await idle(planner);
    const fourth = await openOne(planner, a, 'Review');
    expect(fourth.due).toBe(day(3));
    expect(await kept(planner, fourth.id)).toMatchObject({ color: RED, attachments: [doc('s1', 'Series doc')], repeat: { exceptions: { [day(4)]: { attachments: [doc('o2', 'Own')] } } } });
    await idle(planner);
  }, 20_000);

  test("Google Drive's files are searched only once Drive is allowed; then by name, newest first, no folders or trashed files, a page at a time", async () => {
    const w = await openWindow(planner);
    const mark = planner.google!.requests.length;
    await expect(w.google.searchDrive(ME, 'plan')).rejects.toThrow(/allow it first/);
    expect(planner.google!.requests.slice(mark).filter((request) => request.path.startsWith('/drive/'))).toEqual([]);
    // Allow Google Drive: a sign-in for what the account has plus Drive.
    await w.google.allow(ME, 'drive');
    const signIn = w.google.getView().signIn!;
    const auth = new URL(signIn.authUrl);
    expect(w.opened).toContain(signIn.authUrl);
    await w.google.finishSignIn(`${signIn.redirectUri}?${new URLSearchParams({ state: auth.searchParams.get('state')!, code: fakeAuthCode(auth.searchParams.get('scope')!) })}`);
    expect(w.google.getView().status?.accounts[0]?.features).toEqual(['calendar', 'tasks', 'mail', 'drive']);
    expect((await w.google.searchDrive(ME, '')).files.slice(0, 2).map((file) => file.id)).toEqual(['d-budget', 'd-plan']);
    expect((await w.google.searchDrive(ME, 'budget')).files.map((file) => file.title)).toEqual(['Budget 2027']);
    const first = await w.google.searchDrive(ME, 'notes');
    const second = await w.google.searchDrive(ME, 'notes', first.next);
    expect([first.files.length, first.next, second.files.length, second.next]).toEqual([30, '30', 5, null]);
    expect(new Set([...first.files, ...second.files].map((file) => file.id)).size).toBe(35);
    w.google.cancelSignIn();
  });

  test('a Busy task declines the invitations that overlap it, once, with its message for the organizer; "only new" leaves older ones; one answered again is left', async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Declines');
    const start = minutesNow() + 120;
    events().set('ev-existing', invite('ev-existing', 'Existing sync', today, start + 15, start + 45, '2026-01-01T00:00:00.000Z'));
    events().set('ev-outside', invite('ev-outside', 'Later sync', today, start + 90, start + 120, '2026-01-01T00:00:00.000Z'));
    events().set('ev-mine', invite('ev-mine', 'My own review', today, start, start + 30, '2026-01-01T00:00:00.000Z', true));
    const message = 'Declined: heads down on the Q4 plan';
    const task = await w.google.addListTask(ME, listId, { title: 'Write the plan', due: today }, { time: start, duration: 60, busy: true, decline: { mode: 'all', message } });
    expect(await until(() => self('ev-existing').responseStatus === 'declined', 8000)).toBe(true);
    expect(self('ev-existing')).toMatchObject({ comment: message });
    const patches = planner.google!.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/events/ev-existing'));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.query.sendUpdates).toBe('all');
    expect(self('ev-outside').responseStatus).toBe('needsAction');
    expect(planner.google!.requests.some((request) => request.method === 'PATCH' && request.path.endsWith('/events/ev-mine'))).toBe(false);
    expect((await w.google.declinedFor(ME, task.id)).declined).toEqual([expect.objectContaining({ eventId: 'ev-existing', summary: 'Existing sync', task: 'Write the plan' })]);
    // Only new invitations: the older one, answered again by the user, stays as answered; a new one is declined.
    self('ev-existing').responseStatus = 'needsAction';
    await w.google.saveListTask(task, fields('Write the plan', today, start, { notes: '', duration: 60, busy: true, decline: { mode: 'new', message } }));
    events().set('ev-new', invite('ev-new', 'New sync', today, start + 30, start + 50, new Date(Date.now() + 1000).toISOString()));
    await planner.call('POST', '/google/tasks/decline');
    expect(await until(() => self('ev-new').responseStatus === 'declined', 8000)).toBe(true);
    expect(self('ev-existing').responseStatus).toBe('needsAction');

    await idle(planner);
  }, 20_000);
  // Review 10: three daily Busy series at 9, 10 and 11 make 45 times in the two weeks, and a pass looked at the first
  // 40 alone. Found by this suite (2026-11-05): a pass that was reading when the times changed kept its old range as
  // where to carry on, so the round it finished never looked past the old times' end (the meeting on day 14).
  test("review 10: three daily Busy series at 9, 10 and 11 decline the meetings at 11 on day 1 and day 14, each once, with the 11 o'clock series' message, among 40 others read over several passes; series added while a pass reads are looked at too", async () => {
    const w = await openWindow(planner);
    const listId = await newList(w, 'Busy series');
    const created = '2026-01-01T00:00:00.000Z';
    events().set('day-1', invite('day-1', 'Day 1 at 11', day(1), 660, 690, created));
    events().set('day-14', invite('day-14', 'Day 14 at 11', day(14), 660, 690, created));
    for (let n = 0; n < 40; n++) events().set(`other-${n}`, invite(`other-${n}`, `Other ${n}`, day(n % 15), 780 + (n % 4) * 30, 810 + (n % 4) * 30, created, n % 2 === 0));
    const series = (title: string, minutes: number) => w.google.addListTask(ME, listId, { title, notes: '', due: today }, { time: minutes, duration: 30, rule: DAILY, busy: true, decline: { mode: 'all', message: `At ${title}` } });
    const mark = planner.google!.requests.length;
    await series('nine', 540);
    // A pass is still reading the calendar (its first page held) when the other two series come.
    planner.google!.delayNext('GET', '/calendars/primary/events', 1500);
    await series('ten', 600);
    await series('eleven', 660);
    expect(await until(() => self('day-1').responseStatus === 'declined' && self('day-14').responseStatus === 'declined', 20_000)).toBe(true);
    // Once the times changed, the calendar is read afresh over all of them: no pass carries on through the range of the
    // times as they were (the held pass reads its own four pages, no more).
    const reads = planner.google!.requests.slice(mark).filter((request) => request.method === 'GET' && request.path.endsWith('/calendars/primary/events'));
    const now = instantAt(day(14), 690, zone);
    expect(reads.filter((request) => request.query.timeMax !== now).length).toBeLessThanOrEqual(4);
    for (const id of ['day-1', 'day-14']) {
      expect(self(id)).toMatchObject({ comment: 'At eleven' });
      expect(planner.google!.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith(`/events/${id}`))).toHaveLength(1);
    }
    // The others overlap no Busy time: left as they are.
    expect(Array.from({ length: 40 }, (_, n) => `other-${n}`).filter((id) => self(id).responseStatus === 'declined')).toEqual([]);
    await idle(planner);
  }, 30_000);
});

describe('task notifications, from the Planner (Google gets no time or deadline it keeps)', () => {
  const zoneNow = () => Math.floor(zonedDateMinutes(Date.now(), zone).minutes);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const notified = world();
  notified.tasks.L1![0]!.updated = yesterday;
  notified.tasks.L1!.push(
    { id: 't-call', title: 'Call the bank', notes: '', due: at(0), status: 'needsAction', updated: yesterday },
    { id: 't-late', title: 'Pay the rent', notes: '', status: 'needsAction', updated: yesterday },
    { id: 't-later', title: 'Pick up the kids', notes: '', status: 'needsAction', updated: yesterday },
  );
  // Kept yesterday: Send the report's time (two minutes ago, today) and Buy stamps' deadline (today; it has no date).
  const seeded = [
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-report', patch: { time: zoneNow() - 2 } },
    { type: 'gtask.kept', account: ME, listId: 'L2', taskId: 't-stamps', patch: { deadline: today } },
  ].map((body, index) => JSON.stringify({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const planner = usePlanner({ google: notified, zone, files: { [join('data', 'events', `${yesterday.slice(0, 7)}.jsonl`)]: `${seeded.join('\n')}\n` } });
  // The panel's notifications ask while the window is shown.
  (globalThis as { document?: unknown }).document ??= { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };

  test("missed ones come as OpenChamber notifications when a window opens, once: lent to a window whose frame went before showing them, they come to the next once the loan ends; never again after a restart; one set after its time never comes; off, none", async () => {
    // A window whose frame goes before it shows them (OpenChamber takes none).
    const gone = await openWindow(planner);
    (gone.host as unknown as { toast: () => Promise<void> }).toast = () => Promise.reject(new Error('the frame went'));
    const stopGone = startTaskNotifications(gone.host, gone.client, 'panel');
    expect(await until(() => gone.calls.some((call) => call.path === '/google/tasks/notifications'))).toBe(true);
    stopGone();
    // Another window meanwhile: told to ask again when the loan ends, then shown them, once.
    const shown = await openWindow(planner);
    const asked = await shown.client.call<{ notifications: unknown[]; nextIn: number | null }>('POST', '/google/tasks/notifications');
    expect(asked.notifications).toEqual([]);
    expect(asked.nextIn).toBeGreaterThan(0);
    expect(asked.nextIn).toBeLessThanOrEqual(5000);
    const stopShown = startTaskNotifications(shown.host, shown.client, 'panel');
    expect(await until(() => shown.toasts.length >= 3, 9000)).toBe(true);
    stopShown();
    expect(shown.toasts.map((toast) => toast.message).sort()).toEqual(['Deadline today: Buy stamps', expect.stringMatching(/^Task at .+: Send the report$/), 'Task today: Call the bank']);
    expect(shown.toasts.every((toast) => toast.persistent)).toBe(true);
    // A time set now that has gone by never comes; one later today is next (dated today now, after 9 AM: no 9 AM one).
    const later = zoneNow() + 60;
    for (const id of ['t-late', 't-later']) expect((await planner.call('PATCH', '/google/tasks', { account: ME, listId: 'L1', id, due: today })).status).toBe(200);
    await planner.commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-late', patch: { time: zoneNow() - 5 } }, { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-later', patch: { time: later } });
    const after = await planner.call('POST', '/google/tasks/notifications');
    expect(after.body.notifications).toEqual([]);
    expect(after.body.next).toBe(instantAt(today, later, zone));
    // After a restart, a new window gets none of them again.
    await planner.restart();
    const reloaded = await openWindow(planner);
    expect((await reloaded.client.call<{ notifications: unknown[] }>('POST', '/google/tasks/notifications')).notifications).toEqual([]);
    // Off in Settings → Google: none come.
    await reloaded.client.dispatch([{ type: 'settings.updated', patch: { googleTaskNotifications: false } }]);
    expect((await planner.call('POST', '/google/tasks/notifications')).body).toEqual({ notifications: [], next: null, nextIn: null, errors: [] });
  }, 20_000);
});
