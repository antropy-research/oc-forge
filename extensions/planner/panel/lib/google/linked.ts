// The Google store's linked tasks (one of its parts, store.ts): Planner tasks kept in step with their Google tasks,
// the way the Linear integration writes back to Linear (ask, do, or not). A task linked to a Google task, and Google
// tasks merged into a task (Sunsama's merge), follow what changed in Google and send what changed here: completed or
// reopened, a title, details or a date, a move to another list; one Google no longer has says so.
import { GOOGLE_NOTES_MAX, type Command, type EventBody } from '../../../src/domain/core/events.ts';
import type { PlannerState, Subtask, Task, TaskSourceRef } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { findMovedTask, followMergedGoogleTask, GONE_STATUS, gtaskSource, linkedGoogleTasks, planGoogleTaskSync, plannerEditTimes, TASK_GONE, type GoogleTaskItem, type GoogleTaskWrite, type SyncedField } from '../../../src/domain/google/google.ts';
import { keptFor } from '../../../src/domain/google/taskKept.ts';
import { mergedDone, mergedReopened, subtaskChange, subtasksChangedIn } from '../../../src/domain/plan/merge.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { Origin } from '../core/client.ts';
import type { GoogleStore } from './store.ts';
import type { GoogleTaskRef } from './types.ts';

/** Linked tasks are asked for in parts of at most this many lists and tasks, which the service answers in time. */
const SYNC_GROUPS = 10;
const SYNC_IDS = 50;

/** A linked or merged Google task's link says it is completed in Google (as last read or written). */
const doneThere = (source: TaskSourceRef | null | undefined): boolean => source?.status?.type === 'completed';

/** A link to a Google task Google still has, as far as the Planner knows. */
const liveGoogleTask = (source: TaskSourceRef | null | undefined): source is TaskSourceRef => source?.kind === 'gtask' && source.status?.name !== GONE_STATUS.name;

/**
 * The Google side of `writeTask` and `writeMerged`: completed or reopened,
 * its subtasks in Google, or the completed task it is under, first (as the
 * Tasks view does, however little of its list is loaded; Planner tasks
 * planning those take the change too); then it. Google's answer; a refusal
 * throws.
 */
const writeGoogleTask = async (google: GoogleStore, ref: GoogleTaskRef, patch: GoogleTaskWrite['patch'] & { completed?: boolean }): Promise<GoogleTaskItem | null> => {
  const completed = patch.completed;
  if (completed !== undefined) {
    const related = await google.relatives(ref, completed);
    if (related.length) await google.syncItems(await google.writeListTask(related, () => ({ completed }), true));
  }
  const answer = await google.client.call<{ task: GoogleTaskItem | null }>('PATCH', '/google/tasks', { ...ref, ...patch });
  return answer.task;
};

/**
 * What follows Google's answer to a write: the links and what is kept follow a
 * move to another list, the Tasks view shows it, and a repeating task just
 * completed gets its next occurrence.
 */
const followWrite = async (google: GoogleStore, ref: GoogleTaskRef, item: GoogleTaskItem, completed: boolean | undefined): Promise<void> => {
  if (item.listId !== ref.listId) await google.followMove(ref, item);
  google.remember(item);
  if (completed) await google.makeNextOccurrences([item]);
};

/**
 * Merged items changed in their tasks' subtasks as the plan has them now,
 * read again first, each by identity (`subtaskChange`): another window's
 * change to another subtask stays, and one renamed by hand meanwhile keeps
 * its name. `change` gives a subtask its new self, or itself. Nothing is
 * written when the plan can't be read (the next sync or write looks
 * again), nor for a subtask that did not change.
 */
const changeMerged = async (google: GoogleStore, change: (task: Task, subtask: Subtask) => Subtask): Promise<void> => {
  let state: PlannerState;
  try {
    state = await google.freshPlan();
  } catch (error) {
    console.warn(`[planner] Google Tasks: merged tasks not updated this time: ${messageOf(error)}`);
    return;
  }
  const bodies: EventBody[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.deletedAt || !task.subtasks.some((subtask) => subtask.source?.kind === 'gtask')) continue;
    for (const subtask of task.subtasks) {
      const next = change(task, subtask);
      const body = next === subtask ? null : subtaskChange(task.id, subtask, next);
      if (body) bodies.push(body);
    }
  }
  if (bodies.length) await google.client.dispatch(bodies, { origin: 'google' });
};

/**
 * Google tasks merged into tasks follow these Google tasks as linked ones
 * do (`followMergedGoogleTask`): their state there, title, details, date
 * and list, and, when completion is imported, checked off once completed
 * in Google. Only open tasks' merged items not checked off are read.
 */
const followMerged = async (google: GoogleStore, items: ReadonlyMap<string, GoogleTaskItem>): Promise<void> => {
  const { state } = google.client.getView();
  const read = (task: Task, subtask: Subtask) => !task.deletedAt && !task.archivedAt && !task.completedAt && !subtask.done && subtask.source?.kind === 'gtask' && items.get(subtask.source.id)?.account === subtask.source.account;
  const differs = Object.values(state.tasks).some((task) => task.subtasks.some((subtask) => read(task, subtask) && followMergedGoogleTask(subtask, items.get(subtask.source!.id)!, state.settings.googleTasksImportCompletion) !== subtask));
  if (!differs) return;
  await changeMerged(google, (task, subtask) => (read(task, subtask) ? followMergedGoogleTask(subtask, items.get(subtask.source!.id)!, google.client.getView().state.settings.googleTasksImportCompletion) : subtask));
};

/**
 * Linked tasks whose Google task is in none of the account's lists under its
 * id: one Google's own apps moved under a new id is found by what it last
 * said (`findMovedTask`); the rest show as deleted in Google. Google tasks
 * merged into tasks too: their links follow the move, or say deleted (and
 * are read no more).
 */
const relink = async (google: GoogleStore, missing: readonly GoogleTaskRef[]): Promise<void> => {
  const candidates: GoogleTaskItem[] = [];
  for (const account of new Set(missing.map((item) => item.account))) {
    for (const list of google.view.lists.filter((item) => item.account === account)) {
      try {
        candidates.push(...(await google.readList(account, list.id, 'a task list')));
      } catch (error) {
        // A list not read may hold the task under its new id: none is called deleted on a guess; the next sync looks again.
        console.warn(`[planner] Google Tasks: linked tasks not checked this time: ${messageOf(error)}`);
        return;
      }
    }
  }
  const state = google.client.getView().state;
  const bodies: EventBody[] = [];
  for (const gone of missing) {
    const found = Object.values(state.tasks).find((task) => task.source?.kind === 'gtask' && task.source.id === gone.id && task.source.account === gone.account && !task.deletedAt);
    const moved = found?.source ? findMovedTask(found.source, candidates, state) : null;
    if (moved) {
      await google.followMove(gone, moved);
      continue;
    }
    for (const task of Object.values(state.tasks)) {
      if (!liveGoogleTask(task.source) || task.source.id !== gone.id || task.source.account !== gone.account || task.deletedAt) continue;
      bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: { ...task.source, status: GONE_STATUS } });
    }
    if (keptFor(state, gone)) bodies.push({ type: 'gtask.dropped', account: gone.account, taskId: gone.id });
  }
  if (bodies.length) await google.client.dispatch(bodies, { origin: 'google' });
  const isGone = (source: TaskSourceRef | undefined) => liveGoogleTask(source) && missing.some((gone) => gone.id === source.id && gone.account === source.account);
  if (Object.values(state.tasks).some((task) => task.subtasks.some((subtask) => isGone(subtask.source)))) {
    await changeMerged(google, (_task, subtask) => {
      if (!isGone(subtask.source)) return subtask;
      const moved = findMovedTask(subtask.source!, candidates, state);
      return { ...subtask, source: moved ? { ...subtask.source!, ...gtaskSource(moved) } : { ...subtask.source!, status: GONE_STATUS } };
    });
  }
};

/**
 * A task completed, or Google tasks merged into it checked off: completed
 * in Google too, as the settings say (Sunsama's "Complete in Google Tasks"):
 * at once, or asked first, where there is room to ask.
 */
const completeInGoogle = (google: GoogleStore, settings: PlannerState['settings'], task: Task, own: boolean, merged: readonly Subtask[], by: 'tick' | 'task'): void => {
  if (!own && !merged.length) return;
  if (settings.googleTasksOnComplete === 'complete') {
    if (own) void google.writeTask(task, { completed: true });
    if (merged.length) void google.writeMerged(task.id, merged.map((subtask) => subtask.id), true, by);
  } else if (settings.googleTasksOnComplete === 'ask' && google.surface !== 'status') {
    const titles = [...(own ? [task.title] : []), ...merged.map((subtask) => subtask.title)];
    const title = titles.length === 1 ? titles[0]! : `${titles[0]} and ${titles.length - 1} more`;
    google.set({ prompt: { taskId: task.id, title, own, subtaskIds: merged.map((subtask) => subtask.id), by } });
  }
};

export const linkedMethods = {
  /** Make a Google task from a Planner task, and link the two. */
  async createTask(task: Task, account: string, listId: string): Promise<void> {
    const due = task.placement.kind === 'day' ? task.placement.date : task.dueDate ?? null;
    const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks', { account, listId, title: task.title, ...(task.notes.trim() ? { notes: task.notes.slice(0, 8000) } : {}), ...(due ? { due } : {}) });
    if (!answer.task) throw new Error('Google did not return the task');
    await this.client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: gtaskSource(answer.task) } }], { undo: 'Added to Google Tasks' });
    this.remember(answer.task, true);
    if (this.view.list?.account === account && this.view.list.id === listId) void this.refreshTasks();
  },

  /**
   * Complete or reopen the Google task behind a linked task, set its due date,
   * or send it the task's title, details or date. Written to the list the link
   * names; the service looks a task its list no longer has up in the account's
   * other lists once and writes there, and the link follows. A write that
   * still fails says so, and the Planner does not keep claiming what Google
   * does not have: a completion or reopening Google refused is undone here, a
   * task Google no longer has shows as deleted there. Completed or reopened,
   * it takes its subtasks or the task it is under along first, as the Tasks
   * view does (`completeListTask`), however little of its list is loaded.
   */
  async writeTask(task: Task, patch: GoogleTaskWrite['patch'] & { completed?: boolean }, quiet = false): Promise<boolean> {
    const source = task.source;
    if (source?.kind !== 'gtask' || !source.account || !source.listId) return false;
    const ref = { account: source.account, listId: source.listId, id: source.id };
    try {
      const item = await writeGoogleTask(this, ref, patch);
      if (item) {
        const current = this.client.getView().state.tasks[task.id] ?? task;
        // What was written is what both sides now agree on; a date set from the plan becomes the task's date here too.
        const planner = patch.due !== undefined && current.dueDate !== item.due ? { dueDate: item.due } : {};
        await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: gtaskSource(item), ...planner }], { origin: 'google' });
        await followWrite(this, ref, item, patch.completed);
      }
      if (!quiet && patch.completed !== undefined) this.client.notify(patch.completed ? `Completed "${task.title}" in Google Tasks` : `Reopened "${task.title}" in Google Tasks`);
      if (this.view.list?.account === source.account && (this.view.list.id === source.listId || this.view.list.id === item?.listId)) void this.refreshTasks();
      calendarUi.refresh();
      return true;
    } catch (error) {
      const message = messageOf(error);
      const current = this.client.getView().state.tasks[task.id];
      if (message === TASK_GONE) {
        this.client.notify(`"${task.title}" is no longer in Google Tasks`);
        if (current?.source?.kind === 'gtask') await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: { ...current.source, status: GONE_STATUS } }], { origin: 'google' });
      } else if (patch.completed === true && current?.completedAt) {
        this.client.notify(`Google Tasks did not complete "${task.title}" (${message}), so it stays open here too`);
        await this.client.dispatch([{ type: 'task.reopened', taskId: task.id }], { origin: 'google' });
      } else if (patch.completed === false && current && !current.completedAt) {
        this.client.notify(`Google Tasks did not reopen "${task.title}" (${message}), so it stays completed here too`);
        await this.client.dispatch([{ type: 'task.completed', taskId: task.id, on: current.completedOn ?? this.client.getView().today }], { origin: 'google' });
      } else this.client.notify(`Couldn't update "${task.title}" in Google Tasks: ${message}`);
      return false;
    }
  },

  /**
   * Complete or reopen Google tasks merged into a task: Sunsama's merge keeps
   * them "fully integrated, synced tasks", so they are written as a linked
   * one is (`writeTask`): each with its own subtasks in Google first, one at
   * a time, then the links the subtasks keep follow what Google answered (its
   * state there, its list). One Google refused is said; checked off or opened
   * again on its own (`by: 'tick'`), its tick goes back, as a refused
   * completion of a linked task does; with its task (`by: 'task'`), the task
   * stays as it is. One Google no longer has shows as deleted there.
   */
  writeMerged(taskId: string, subtaskIds: readonly string[], completed: boolean, by: 'tick' | 'task', quiet = false): Promise<void> {
    const write = async () => {
      const results = new Map<string, { source: TaskSourceRef } | { refused: true }>();
      for (const subtaskId of subtaskIds) {
        const subtask = this.client.getView().state.tasks[taskId]?.subtasks.find((item) => item.id === subtaskId);
        const source = subtask?.source;
        if (!subtask || !liveGoogleTask(source) || !source.account || !source.listId) continue;
        const ref = { account: source.account, listId: source.listId, id: source.id };
        try {
          const item = await writeGoogleTask(this, ref, { completed });
          if (item) {
            results.set(subtaskId, { source: { ...source, ...gtaskSource(item) } });
            await followWrite(this, ref, item, completed);
          }
          if (!quiet) this.client.notify(completed ? `Completed "${subtask.title}" in Google Tasks` : `Reopened "${subtask.title}" in Google Tasks`);
        } catch (error) {
          const message = messageOf(error);
          if (message === TASK_GONE) {
            this.client.notify(`"${subtask.title}" is no longer in Google Tasks`);
            results.set(subtaskId, { source: { ...source, status: GONE_STATUS } });
          } else {
            const stays = by === 'tick' ? `, so it stays ${completed ? 'open' : 'completed'} here too` : '';
            this.client.notify(`Google Tasks did not ${completed ? 'complete' : 'reopen'} "${subtask.title}" (${message})${stays}`);
            if (by === 'tick') results.set(subtaskId, { refused: true });
          }
        }
      }
      if (!results.size) return;
      await changeMerged(this, (task, subtask) => {
        const result = task.id === taskId ? results.get(subtask.id) : undefined;
        if (!result) return subtask;
        if ('refused' in result) return subtask.done === completed ? { ...subtask, done: !completed } : subtask;
        return { ...subtask, source: result.source };
      });
      if (this.view.list) void this.refreshTasks();
      calendarUi.refresh();
    };
    // One task's merged items are written in turn (checked off and opened again at once: the second waits).
    const next = (this.mergedWrites.get(taskId) ?? Promise.resolve()).then(write, write);
    this.mergedWrites.set(taskId, next);
    void next.then(() => {
      if (this.mergedWrites.get(taskId) === next) this.mergedWrites.delete(taskId);
    });
    return next;
  },

  /**
   * A Google task moved to another list (and, when Google gave it a new id,
   * under that id): the Planner tasks linked to it and what the Planner keeps
   * for it follow.
   */
  async followMove(from: GoogleTaskRef, to: GoogleTaskItem): Promise<void> {
    const state = this.client.getView().state;
    const bodies: EventBody[] = [];
    for (const task of Object.values(state.tasks)) {
      const source = task.source;
      if (source?.kind !== 'gtask' || source.id !== from.id || (source.account && source.account !== from.account) || task.deletedAt) continue;
      if (source.listId === to.listId && source.id === to.id) continue;
      bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: gtaskSource(to) });
    }
    const kept = keptFor(state, { account: from.account, id: from.id });
    if (kept && (kept.listId !== to.listId || from.id !== to.id)) bodies.push({ type: 'gtask.moved', account: from.account, taskId: from.id, listId: to.listId, ...(to.id !== from.id ? { newTaskId: to.id } : {}) });
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
  },

  answerPrompt(answer: 'yes' | 'no' | 'always'): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || answer === 'no') return;
    if (answer === 'always') void this.client.dispatch([{ type: 'settings.updated', patch: { googleTasksOnComplete: 'complete' } }]);
    const task = this.client.getView().state.tasks[prompt.taskId];
    if (task && prompt.own) void this.writeTask(task, { completed: true });
    if (task && prompt.subtaskIds.length) void this.writeMerged(task.id, prompt.subtaskIds, true, prompt.by);
  },

  /**
   * Bring linked tasks and their Google tasks into step, asked for in parts
   * the service answers in time: links follow tasks moved to other lists,
   * changes on either side reach the other (`planGoogleTaskSync`), repeating
   * tasks completed in Google get their next occurrence, and links to tasks
   * Google no longer has say so.
   */
  async sync(): Promise<void> {
    const parts = linkedGoogleTasks(this.client.getView().state).flatMap((group) => Array.from({ length: Math.ceil(group.ids.length / SYNC_IDS) }, (_, index) => ({ ...group, ids: group.ids.slice(index * SYNC_IDS, (index + 1) * SYNC_IDS) })));
    if (!parts.length) return;
    try {
      const tasks: GoogleTaskItem[] = [];
      const missing: GoogleTaskRef[] = [];
      for (let index = 0; index < parts.length; index += SYNC_GROUPS) {
        const answer = await this.client.call<{ tasks: GoogleTaskItem[]; missing?: GoogleTaskRef[] }>('POST', '/google/tasks/linked', { groups: parts.slice(index, index + SYNC_GROUPS) });
        tasks.push(...answer.tasks);
        missing.push(...(answer.missing ?? []));
      }
      await this.syncItems(tasks);
      if (missing.length) await relink(this, missing);
    } catch (error) {
      console.warn(`[planner] Google Tasks sync skipped: ${messageOf(error)}`);
    }
  },

  /**
   * Linked tasks against these Google tasks, field by field: what changed in
   * Google comes in, what changed here goes out, and a field changed on both
   * sides takes the newer change (the Planner's from the task's activity).
   */
  async syncItems(items: readonly GoogleTaskItem[]): Promise<void> {
    if (!items.length) return;
    const { state, today } = this.client.getView();
    const byId = new Map(items.map((item) => [item.id, item]));
    const options = { today, importCompletion: state.settings.googleTasksImportCompletion };
    let plan = planGoogleTaskSync(state, byId, options);
    if (plan.conflicts.length) {
      const times = new Map<string, Partial<Record<SyncedField, string>>>();
      const unread = new Set<string>();
      for (const { taskId } of plan.conflicts) {
        try {
          times.set(taskId, plannerEditTimes(await this.client.activity(taskId)));
        } catch {
          // Which side changed last is not known: neither side is picked on a guess; the next sync decides.
          unread.add(taskId);
        }
      }
      plan = planGoogleTaskSync(state, byId, { ...options, editedAt: (taskId, field) => times.get(taskId)?.[field] ?? null });
      if (unread.size) {
        const taskOf = (body: EventBody) => ('taskId' in body ? (body as { taskId: string }).taskId : null);
        plan = { ...plan, bodies: plan.bodies.filter((body) => !unread.has(taskOf(body) ?? '')), writes: plan.writes.filter((write) => !unread.has(write.taskId)) };
      }
    }
    if (plan.bodies.length) await this.client.dispatch(plan.bodies, { origin: 'google' });
    for (const write of plan.writes) {
      const task = this.client.getView().state.tasks[write.taskId];
      if (task) await this.writeTask(task, write.patch, true);
    }
    await followMerged(this, byId);
    await this.keepSeries(items);
    await this.makeNextOccurrences(items);
  },

  /** The user's own changes, from the surface they were made in, reach Google (`start` hears every commit). */
  afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    if (origin !== 'user' || !this.accountsWith('tasks').length) return;
    const settings = after.settings;
    const seen = new Set<string>();
    for (const command of commands) {
      if (command.type === 'task.completed' || command.type === 'task.reopened') {
        const task = after.tasks[command.taskId];
        if (!task) continue;
        const own = liveGoogleTask(task.source);
        // Google tasks merged into it (Sunsama's merge) go with it, as its own does: completed with it, and reopened with
        // it, unless checked off on their own (that completed it, or asked, then; as Linear's and Gmail's merged items).
        const merged = task.subtasks.filter((subtask) => liveGoogleTask(subtask.source));
        if (command.type === 'task.completed') completeInGoogle(this, settings, task, own && !doneThere(task.source), merged.filter((subtask) => !subtask.done && !doneThere(subtask.source)), 'task');
        else if (settings.googleTasksOnComplete === 'complete') {
          if (own && doneThere(task.source)) void this.writeTask(task, { completed: false });
          const reopen = merged.filter((subtask) => !subtask.done && doneThere(subtask.source));
          if (reopen.length) void this.writeMerged(task.id, reopen.map((subtask) => subtask.id), false, 'task');
        }
        continue;
      }
      // A Google task merged into a task checked off, or opened again, on its own: completed or reopened in Google as
      // a linked one is (opened again only while its task is open: a completed task's merged items are done with it).
      // (Once a task, for all of a batch's changes to its subtasks.)
      const subtasksOf = subtasksChangedIn(command);
      if (subtasksOf && !seen.has(subtasksOf)) {
        seen.add(subtasksOf);
        const task = after.tasks[subtasksOf];
        if (task && !task.deletedAt) {
          const ticked = mergedDone(before.tasks[subtasksOf], task).filter((subtask) => liveGoogleTask(subtask.source) && !doneThere(subtask.source));
          if (ticked.length) completeInGoogle(this, settings, task, false, ticked, 'tick');
          const opened = mergedReopened(before.tasks[subtasksOf], task).filter((subtask) => liveGoogleTask(subtask.source) && doneThere(subtask.source));
          if (opened.length && !task.completedAt && settings.googleTasksOnComplete === 'complete') void this.writeMerged(task.id, opened.map((subtask) => subtask.id), false, 'tick');
        }
      }
      // Its title, details or date changed here: Google gets them too (a link just made is in step already).
      if (command.type === 'task.updated' && command.patch.source === undefined) {
        const task = after.tasks[command.taskId];
        const previous = before.tasks[command.taskId];
        if (!task || !previous || task.completedAt || !liveGoogleTask(task.source)) continue;
        const patch: GoogleTaskWrite['patch'] = {
          ...(command.patch.title !== undefined && task.title !== previous.title ? { title: task.title } : {}),
          ...(command.patch.notes !== undefined && task.notes !== previous.notes ? { notes: task.notes.slice(0, GOOGLE_NOTES_MAX) } : {}),
          ...(command.patch.dueDate !== undefined && task.dueDate !== previous.dueDate ? { due: task.dueDate } : {}),
        };
        if (Object.keys(patch).length) void this.writeTask(task, patch, true);
        continue;
      }
      // Planned on a day: Google Calendar shows the task that day too.
      const plannedId = command.type === 'task.created' ? command.task.id : command.type === 'task.moved' ? command.taskId : null;
      if (!plannedId || !settings.googleTasksDueFromPlan) continue;
      const task = after.tasks[plannedId];
      const previous = before.tasks[plannedId];
      if (task?.source?.kind !== 'gtask' || task.placement.kind !== 'day' || task.completedAt) continue;
      if (previous?.placement.kind === 'day' && previous.placement.date === task.placement.date) continue;
      // Planned on the day it is due in Google already.
      if (command.type === 'task.created' && command.task.dueDate === task.placement.date) continue;
      void this.writeTask(task, { due: task.placement.date }, true);
    }
  },
} satisfies ThisType<GoogleStore>;
