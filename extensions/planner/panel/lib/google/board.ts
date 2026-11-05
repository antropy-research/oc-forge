// The Google store's board (one of its parts, store.ts): the Tasks view's lists, as the Google Tasks app has them.
// Each list read with its completed tasks; lists made, renamed and deleted; tasks added, moved and written, shown at
// once and put back when Google refuses; and the reads a change makes first, as Google and the service have the
// task, its list and the plan now, never this window's copy (`FreshnessError` when they can't be read).
import type { EventBody, GoogleTaskKeptPatch } from '../../../src/domain/core/events.ts';
import { newId } from '../../../src/domain/core/ids.ts';
import type { DateKey, PlannerState } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { GONE_STATUS, TASK_GONE, type GoogleTaskItem, type GoogleTaskList } from '../../../src/domain/google/google.ts';
import { keptFor, templateOf } from '../../../src/domain/google/taskKept.ts';
import { applyMove, type MoveTarget } from '../../../src/domain/google/tasks.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { Snapshot } from '../core/client.ts';
import type { GoogleStore } from './store.ts';
import { FreshnessError, listKey, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, REPEATING_STAYS, SHARED_NO_SUBTASKS, SUBTASK_NO_REPEAT, type GoogleTaskRef, type TaskBoardList } from './types.ts';

export const boardMethods = {
  /**
   * Read a list with its completed tasks. What the Planner keeps for a task
   * seen here follows it from another list, and a repeating task completed in
   * Google gets its next occurrence.
   */
  async loadBoard(account: string, listId: string): Promise<void> {
    const key = listKey(account, listId);
    const seq = (this.boardSeq.get(key) ?? 0) + 1;
    this.boardSeq.set(key, seq);
    const current = this.view.board[key];
    this.setBoard(key, { items: current?.items ?? [], loading: true, error: null, complete: current?.complete ?? true });
    try {
      const answer = await this.client.call<{ tasks: GoogleTaskItem[]; complete: boolean }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}`);
      // Read again meanwhile (after a change made here): the newer read shows the list, and follows it up.
      if (this.boardSeq.get(key) !== seq) return;
      this.setBoard(key, { items: answer.tasks, loading: false, error: null, complete: answer.complete });
      const state = this.client.getView().state;
      const moved: EventBody[] = answer.tasks.flatMap((item) => {
        const kept = keptFor(state, item);
        return kept && kept.listId !== item.listId ? [{ type: 'gtask.moved' as const, account: item.account, taskId: item.id, listId: item.listId }] : [];
      });
      if (moved.length) await this.client.dispatch(moved, { origin: 'google' });
      await this.keepSeries(answer.tasks);
      await this.makeNextOccurrences(answer.tasks);
      if (answer.complete) this.missingHeads(account, listId, answer.tasks);
    } catch (error) {
      if (this.boardSeq.get(key) === seq) this.setBoard(key, { items: current?.items ?? [], loading: false, error: messageOf(error), complete: true });
    }
  },

  async createList(account: string, title: string): Promise<GoogleTaskList> {
    const answer = await this.client.call<{ list: GoogleTaskList }>('POST', '/google/tasklists', { account, title });
    this.set({ lists: [...this.view.lists, answer.list] });
    this.setBoard(listKey(account, answer.list.id), { items: [], loading: false, error: null, complete: true });
    return answer.list;
  },

  async renameList(list: GoogleTaskList, title: string): Promise<void> {
    const rename = (to: string) => this.set({ lists: this.view.lists.map((item) => (item.account === list.account && item.id === list.id ? { ...item, title: to } : item)) });
    rename(title);
    try {
      await this.client.call('PATCH', '/google/tasklists', { account: list.account, listId: list.id, title });
    } catch (error) {
      rename(list.title);
      throw error;
    }
  },

  /**
   * A list deleted in Google, with its tasks (Google can't give a list back,
   * so there is no Undo). What the Planner kept for its tasks goes too, read
   * from the plan as the service has it first, not this window's copy (a
   * repeating task kept there since would go on showing upcoming tasks of a
   * list that is gone); when the plan can't be read, nothing is deleted.
   */
  async deleteList(list: GoogleTaskList): Promise<void> {
    await this.freshPlan();
    await this.client.call('DELETE', `/google/tasklists?account=${encodeURIComponent(list.account)}&list=${encodeURIComponent(list.id)}`);
    // Its tasks went with it in Google: what the Planner kept for them (their repeats' upcoming occurrences on the
    // calendar too) goes now, not on the next read, and Planner tasks linked to them say they are gone.
    const state = this.client.getView().state;
    const bodies: EventBody[] = [
      ...Object.values(state.googleTasks ?? {})
        .filter((kept) => kept.account === list.account && kept.listId === list.id)
        .map((kept) => ({ type: 'gtask.dropped' as const, account: kept.account, taskId: kept.taskId })),
      ...Object.values(state.tasks)
        .filter((task) => task.source?.kind === 'gtask' && task.source.account === list.account && task.source.listId === list.id && !task.deletedAt && task.source.status?.name !== GONE_STATUS.name)
        .map((task) => ({ type: 'task.sourceSynced' as const, taskId: task.id, source: { ...task.source!, status: GONE_STATUS } })),
    ];
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
    const lists = this.view.lists.filter((item) => !(item.account === list.account && item.id === list.id));
    const { [listKey(list.account, list.id)]: _gone, ...board } = this.view.board;
    const selected = this.view.list?.account === list.account && this.view.list.id === list.id;
    this.set({ lists, board, ...(selected ? { list: lists[0] ? { account: lists[0].account, id: lists[0].id } : null, tasks: [] } : {}) });
    if (selected) void this.refreshTasks();
    calendarUi.refresh();
  },

  /**
   * Google Tasks' "Delete all completed tasks": each task of a list completed
   * in Google now, gone at once. Which ones is read from Google first, not
   * taken from this window's copy (a task reopened in another window since
   * stays); when the list can't be read, nothing is deleted.
   */
  async clearCompleted(account: string, listId: string): Promise<number> {
    const key = listKey(account, listId);
    const now = await this.readList(account, listId, 'the list');
    // Subtasks first: deleting a task deletes its subtasks, which would then not be found.
    const done = now.filter((item) => item.completed).sort((a, b) => Number(Boolean(b.parent)) - Number(Boolean(a.parent)));
    this.patchBoard(key, now.filter((item) => !item.completed));
    try {
      for (const item of done) await this.client.call('DELETE', `/google/tasks?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}&id=${encodeURIComponent(item.id)}`);
      this.afterTaskWrite(account, listId, true);
      return done.length;
    } catch (error) {
      void this.loadBoard(account, listId);
      throw error;
    }
  },

  /**
   * A new task: at the top of the list, or under `parent` after `previous`.
   * Shown at once. What Google Tasks' API cannot take (a time, a deadline, a
   * repeat with its series' template, a star) is kept in the Planner for it.
   * As in Google Tasks, a repeating task takes no subtask and a subtask does
   * not repeat: refused before anything changes.
   */
  async addListTask(account: string, listId: string, fields: { title: string; notes?: string; due?: DateKey | null; parent?: string | null; previous?: string | null }, kept: Omit<GoogleTaskKeptPatch, 'repeat'> & { rule?: string | null } = {}): Promise<GoogleTaskItem> {
    if (fields.parent && keptFor(this.client.getView().state, { account, id: fields.parent })?.repeat) throw new Error(REPEATING_NO_SUBTASKS);
    if (fields.parent && kept.rule) throw new Error(SUBTASK_NO_REPEAT);
    const key = listKey(account, listId);
    if (fields.parent && this.view.board[key]?.items.find((item) => item.id === fields.parent)?.assigned) throw new Error(SHARED_NO_SUBTASKS);
    const temp: GoogleTaskItem = { account, listId, id: `new-${newId()}`, title: fields.title, notes: fields.notes ?? '', due: fields.due ?? null, completed: false, parent: fields.parent ?? null, position: '', url: 'https://tasks.google.com/', updated: new Date().toISOString() };
    const items = this.view.board[key]?.items ?? [];
    this.patchBoard(key, applyMove([...items, temp], temp.id, { parent: temp.parent, previous: fields.previous ?? null }));
    try {
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks', { account, listId, ...fields, ...(fields.notes ? {} : { notes: undefined }) });
      if (!answer.task) throw new Error('Google did not return the task');
      const { rule, busy, visibility, color, attachments, doNotDisturb, decline, ...rest } = kept;
      // Availability, visibility, Do not disturb and declining come with a time (declining with Busy); Free, the
      // default visibility, its list's color and no attachments are kept as nothing.
      const timed = (rest.time ?? null) !== null;
      const advanced = {
        ...(timed && busy ? { busy: true } : {}),
        ...(timed && visibility && visibility !== 'default' ? { visibility } : {}),
        ...(timed && doNotDisturb ? { doNotDisturb: true } : {}),
        ...(timed && busy && decline ? { decline: { ...decline, since: decline.since ?? new Date().toISOString() } } : {}),
        ...(color ? { color } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
      const template = fields.due ? templateOf({ title: fields.title, notes: fields.notes ?? '' }, { time: rest.time ?? null, duration: rest.duration ?? null, deadline: rest.deadline ?? null, ...advanced }, fields.due) : null;
      const patch: GoogleTaskKeptPatch = { ...rest, ...advanced, ...(rule && fields.due && template ? { repeat: { rule, seriesId: newId(), index: 1, next: null, on: fields.due, template } } : {}) };
      if (Object.values(patch).some((value) => value !== null && value !== undefined && value !== false)) await this.setKept(answer.task, patch);
      if (advanced.decline) this.declineSoon();
      this.patchBoard(key, (this.view.board[key]?.items ?? []).map((item) => (item.id === temp.id ? answer.task! : item)));
      this.afterTaskWrite(account, listId, Boolean(fields.due));
      // Google may renumber the other tasks' places: read the list as Google has it now.
      if (this.view.board[key]) void this.loadBoard(account, listId);
      return answer.task;
    } catch (error) {
      this.patchBoard(key, (this.view.board[key]?.items ?? []).filter((item) => item.id !== temp.id));
      throw error;
    }
  },

  /**
   * Put a task under `parent` after `previous`, in its list or another of the
   * same account. Shown at once. As in Google Tasks, a repeating task stays in
   * its list, takes no subtasks and is no subtask: such a move is refused
   * before anything moves. The task as Google has it after the move.
   */
  async moveListTask(item: GoogleTaskItem, target: MoveTarget, destinationListId: string = item.listId): Promise<GoogleTaskItem> {
    const state = this.client.getView().state;
    if (destinationListId !== item.listId && keptFor(state, item)?.repeat) throw new Error(REPEATING_STAYS);
    if (target.parent && keptFor(state, item)?.repeat) throw new Error(REPEATING_NOT_SUBTASK);
    if (target.parent && keptFor(state, { account: item.account, id: target.parent })?.repeat) throw new Error(REPEATING_NO_SUBTASKS);
    const from = listKey(item.account, item.listId);
    const to = listKey(item.account, destinationListId);
    const before = { from: this.view.board[from]?.items ?? [], to: this.view.board[to]?.items ?? [] };
    if (from === to) this.patchBoard(from, applyMove(before.from, item.id, target));
    else {
      const moving = before.from.filter((other) => other.id === item.id || other.parent === item.id).map((other) => ({ ...other, listId: destinationListId }));
      this.patchBoard(from, before.from.filter((other) => other.id !== item.id && other.parent !== item.id));
      this.patchBoard(to, applyMove([...before.to, ...moving], item.id, target));
    }
    try {
      const answer = await this.client.call<{ task: GoogleTaskItem | null }>('POST', '/google/tasks/move', { account: item.account, listId: item.listId, id: item.id, parent: target.parent, previous: target.previous, ...(to !== from ? { destinationListId } : {}) });
      const movedTask = answer.task ?? { ...item, listId: destinationListId, parent: target.parent };
      if (to !== from) {
        // The Planner tasks planning it (and its subtasks), and what is kept for them, follow it to the other list.
        await this.followMove(item, movedTask);
        for (const kid of before.from.filter((other) => other.parent === item.id)) await this.followMove(kid, { ...kid, listId: destinationListId });
      }
      this.afterTaskWrite(item.account, item.listId, to !== from);
      // A move can renumber the places of the tasks around it: read the lists as Google has them now.
      if (this.view.board[from]) void this.loadBoard(item.account, item.listId);
      if (to !== from && this.view.board[to]) void this.loadBoard(item.account, destinationListId);
      return movedTask;
    } catch (error) {
      this.patchBoard(from, before.from);
      if (to !== from) this.patchBoard(to, before.to);
      throw error;
    }
  },

  /** A Google task shown on the calendar, due another day (from a drag in the calendar); a Planner task planning it takes the date. */
  async setTaskDue(item: GoogleTaskItem, due: DateKey): Promise<void> {
    await this.syncItems(await this.writeListTask([item], () => ({ due }), true));
  },

  /** Several tasks patched alike: shown at once, put back when Google refuses; Google's answers. */
  async writeListTask(items: readonly GoogleTaskItem[], patchOf: (item: GoogleTaskItem) => { title?: string; notes?: string; due?: DateKey | null; completed?: boolean }, calendar: boolean): Promise<GoogleTaskItem[]> {
    const first = items[0];
    if (!first) return [];
    const answers: GoogleTaskItem[] = [];
    const key = listKey(first.account, first.listId);
    const before = this.view.board[key]?.items ?? null;
    const now = new Date().toISOString();
    const shown = (item: GoogleTaskItem): GoogleTaskItem => {
      const patch = patchOf(item);
      return { ...item, ...patch, ...(patch.completed !== undefined ? { completedAt: patch.completed ? now : null } : {}) } as GoogleTaskItem;
    };
    if (before) this.patchBoard(key, before.map((item) => (items.some((target) => target.id === item.id) ? shown(item) : item)));
    try {
      for (const item of items) {
        const answer = await this.client.call<{ task: GoogleTaskItem | null }>('PATCH', '/google/tasks', { account: item.account, listId: item.listId, id: item.id, ...patchOf(item) });
        if (answer.task) {
          this.remember(answer.task);
          answers.push(answer.task);
        }
      }
      this.afterTaskWrite(first.account, first.listId, calendar);
      return answers;
    } catch (error) {
      if (before) this.patchBoard(key, before);
      // Refused half way: the list as Google has it now.
      if (before && answers.length) void this.loadBoard(first.account, first.listId);
      throw error;
    }
  },

  /** Google's answer for a task, where the Tasks view shows its list; a new one joins it. */
  remember(item: GoogleTaskItem, add = false): void {
    const key = listKey(item.account, item.listId);
    const list = this.view.board[key];
    if (!list) return;
    const known = list.items.some((other) => other.id === item.id);
    if (!known && !add) return;
    this.patchBoard(key, known ? list.items.map((other) => (other.id === item.id ? item : other)) : [...list.items, item]);
  },

  /** After a write to a list: the sources panel's copy of it read again, and (`calendar`) the calendar. */
  afterTaskWrite(account: string, listId: string, calendar: boolean): void {
    if (this.view.list?.account === account && this.view.list.id === listId) void this.refreshTasks();
    if (calendar) calendarUi.refresh();
  },

  setBoard(key: string, list: TaskBoardList): void {
    this.set({ board: { ...this.view.board, [key]: list } });
  },

  /** New items for a list the Tasks view has read; lists it has not read stay unread. */
  patchBoard(key: string, items: GoogleTaskItem[]): void {
    const current = this.view.board[key];
    if (current) this.setBoard(key, { ...current, items });
  },

  /** A Google task as Google has it now: the Tasks view's copy of its list, else read (following a move to another list). */
  async findTask(account: string, listId: string, id: string): Promise<GoogleTaskItem | null> {
    const known = this.view.board[listKey(account, listId)]?.items.find((item) => item.id === id);
    if (known) return known;
    const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('POST', '/google/tasks/linked', { groups: [{ account, listId, ids: [id] }] });
    return answer.tasks.find((item) => item.id === id) ?? null;
  },

  /**
   * A list's tasks as Google has them now, completed ones too: read from
   * Google, never a window's copy (another window may have added a subtask
   * since it was read). One that cannot be read, or is read only in part,
   * throws (`FreshnessError`): never taken for a list without them.
   */
  async readList(account: string, listId: string, what: string): Promise<GoogleTaskItem[]> {
    let answer: { tasks?: GoogleTaskItem[]; complete?: boolean } | null;
    try {
      answer = await this.client.call<{ tasks?: GoogleTaskItem[]; complete?: boolean }>('GET', `/google/tasks/all?account=${encodeURIComponent(account)}&list=${encodeURIComponent(listId)}`);
    } catch (error) {
      throw new FreshnessError(what, messageOf(error));
    }
    if (!Array.isArray(answer?.tasks)) throw new FreshnessError(what);
    if (answer.complete === false) throw new FreshnessError(what, 'its list has more tasks than the Planner reads');
    return answer.tasks;
  },

  /**
   * The plan as the service has it now: this window's view moves on to it
   * (another window's change since it last looked included). One that cannot
   * be read throws (`FreshnessError`): never taken for this window's view.
   */
  async freshPlan(): Promise<PlannerState> {
    let answer: Snapshot | null;
    try {
      answer = await this.client.call<Snapshot>('GET', '/state');
    } catch (error) {
      throw new FreshnessError("the Planner's plan", messageOf(error));
    }
    if (!answer?.state) throw new FreshnessError("the Planner's plan");
    await this.client.adopt(answer);
    return this.client.getView().state;
  },

  /**
   * A Google task as Google has it now, read again (wherever it is in its
   * account). One Google no longer has throws `TASK_GONE`; one that cannot be
   * read (the read failed, Google answered with an error for its account, or
   * the answer does not say) throws `FreshnessError`: never taken for the task
   * as this window has it.
   */
  async freshTask(task: GoogleTaskRef): Promise<GoogleTaskItem> {
    let answer: { tasks?: GoogleTaskItem[]; missing?: { id: string }[]; errors?: { account: string; message: string }[] } | null;
    try {
      answer = await this.client.call('POST', '/google/tasks/linked', { groups: [{ account: task.account, listId: task.listId, ids: [task.id] }] });
    } catch (error) {
      throw new FreshnessError('the task in Google Tasks', messageOf(error));
    }
    const found = answer?.tasks?.find((one) => one.id === task.id);
    if (found) return found;
    if (answer?.missing?.some((one) => one.id === task.id)) throw new Error(TASK_GONE);
    throw new FreshnessError('the task in Google Tasks', answer?.errors?.find((one) => one.account === task.account)?.message);
  },

  /**
   * What changes with a task completed or reopened, as in Google Tasks: its
   * open subtasks when it is completed, the completed task it is under when it
   * is reopened. Its list as Google has it now, so the result is the same
   * however little (or however long ago) the panel read it. A task whose
   * parent is known needs no read when it can have none: a subtask has no
   * subtasks, a task at the top is under none.
   */
  async relatives(task: GoogleTaskRef & { parent?: string | null }, completed: boolean): Promise<GoogleTaskItem[]> {
    if (task.parent !== undefined && (completed ? task.parent !== null : task.parent === null)) return [];
    let items = await this.readList(task.account, task.listId, "the task's list");
    if (!items.some((other) => other.id === task.id)) {
      // Moved to another list in Google's own apps since the Planner last read it (the write finds it there too):
      // its relatives are in the list it is in now, wherever Google says it is.
      const found = await this.freshTask(task);
      if (found.listId !== task.listId) items = await this.readList(task.account, found.listId, "the task's list");
    }
    if (completed) return items.filter((other) => other.parent === task.id && !other.completed);
    const parent = task.parent ?? items.find((other) => other.id === task.id)?.parent ?? null;
    return parent ? items.filter((other) => other.id === parent && other.completed) : [];
  },
} satisfies ThisType<GoogleStore>;
