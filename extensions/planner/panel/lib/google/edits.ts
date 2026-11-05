// The Google store's task edits (one of its parts, store.ts): a task's form saved as the change from what it showed
// (a field changed meanwhile too is the user's to settle), a task completed or deleted wherever it is (the Tasks
// view, the calendar, Starred), and Google Tasks' Undo after either. All or nothing: what each needs is read as it is
// now first, Google writes first, and what the Planner keeps changes only once Google has taken it.
import type { GoogleTaskKeptPatch } from '../../../src/domain/core/events.ts';
import { newId } from '../../../src/domain/core/ids.ts';
import type { GoogleTaskKept } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleTaskItem } from '../../../src/domain/google/google.ts';
import { SERIES_FIELDS, formChanges, formConflicts, formValuesOf, seriesShown, type FormField, type FormValues } from '../../../src/domain/google/taskForm.ts';
import { keptFor, nextOccurrence, scheduledOn, seriesTemplate, templateOf, type MadeTask, type SeriesSide } from '../../../src/domain/google/taskKept.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { Snapshot } from '../core/client.ts';
import type { GoogleStore } from './store.ts';
import { formValuesOfFields, listKey, REPEATING_STAYS, SHARED_NO_REPEAT, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT, TaskConflict, type DeleteScope, type GoogleTaskRef, type RepeatScope, type TaskFields, type UndoEntry } from './types.ts';
import { longDay } from '../../../src/domain/core/dates.ts';

/**
 * How a form's save is made: its star and list (left out: as they were), and
 * what it shows (`series`: Edit → All tasks, its template on the open task's
 * date; else the task as it is).
 */
interface SaveExtra {
  starred?: boolean;
  listId?: string;
  shows?: 'task' | 'series';
}

/** A form's save against the task as it is now (`formCheck`). */
interface FormCheck {
  /** The task as Google has it now, and what is kept for it. */
  item: GoogleTaskItem;
  kept: GoogleTaskKept | null;
  base: FormValues;
  mine: FormValues;
  /** The task as the form would show it now. */
  now: FormValues;
  /** What the form changed from what it showed, and which of those changed meanwhile too. */
  changes: FormField[];
  conflicts: FormField[];
}

/** Whether a task has subtasks (open or done) in Google now. */
const hasSubtasks = async (google: GoogleStore, item: GoogleTaskItem): Promise<boolean> =>
  (await google.readList(item.account, item.listId, "the task's subtasks")).some((other) => other.parent === item.id);

/**
 * Undo after completing: the tasks it completed open again, the task before
 * its subtasks. A task of a series is the service's (`GoogleSeries.uncomplete`):
 * the next one its completion made goes again while it is still as it was
 * made; one changed or completed since stays, and Undo says so.
 */
const completionUndo = (google: GoogleStore, item: GoogleTaskItem, opened: readonly GoogleTaskItem[], before: GoogleTaskKept | null, made: MadeTask | null): UndoEntry => async () => {
  let note: string | null = null;
  if (before?.repeat) {
    const answer = await google.client.call<Snapshot & { nextKept: boolean }>('POST', '/google/tasks/uncomplete', { account: item.account, listId: item.listId, id: item.id, before, made });
    await google.client.adopt(answer);
    if (answer.nextKept) note = `"${item.title}" is open again; its next task${made?.due ? `, ${longDay(made.due)},` : ''} stays, as it was changed or completed since`;
  } else {
    // The task first: Google never has an open subtask under a completed task.
    await google.writeListTask([...opened].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent))), () => ({ completed: false }), true);
  }
  google.afterTaskWrite(item.account, item.listId, true);
  if (google.view.board[listKey(item.account, item.listId)]) void google.loadBoard(item.account, item.listId);
  void google.sync();
  return { done: 'Completion undone', note };
};

/**
 * Tasks Google deleted, undeleted: the task first (refused, it throws and
 * nothing comes back), then its subtasks, each under it as it was; the ids
 * of the subtasks Google refused.
 */
const undelete = async (google: GoogleStore, items: readonly GoogleTaskRef[]): Promise<string[]> => {
  const refused: string[] = [];
  for (const [index, one] of items.entries()) {
    try {
      await google.client.call('PATCH', '/google/tasks', { account: one.account, listId: one.listId, id: one.id, deleted: false });
    } catch (error) {
      if (index === 0) throw error;
      refused.push(one.id);
    }
  }
  return refused;
};

/** What the Planner kept for tasks, as it was (Undo). */
const restoreKept = async (google: GoogleStore, entries: readonly GoogleTaskKept[]): Promise<void> => {
  if (!entries.length) return;
  await google.client.dispatch(
    entries.map((entry) => ({
      type: 'gtask.kept' as const,
      account: entry.account,
      listId: entry.listId,
      taskId: entry.taskId,
      patch: {
        time: entry.time,
        duration: entry.duration,
        deadline: entry.deadline,
        repeat: entry.repeat,
        starred: Boolean(entry.starredAt),
        busy: Boolean(entry.busy),
        visibility: entry.visibility ?? 'default',
        color: entry.color ?? null,
        attachments: entry.attachments ?? [],
        doNotDisturb: Boolean(entry.doNotDisturb),
        decline: entry.decline ?? null,
      },
    })),
  );
};

export const editMethods = {
  /**
   * A form's save against the task as it is now: the plan read again from the
   * service and the task from Google, as the form would show it now (`shows`).
   * What the form changed from what it showed (`fields.base`), and which of
   * those changed meanwhile too. Without a baseline, the task as this window
   * had it is taken for what the form showed, and nothing conflicts. Either
   * read failing throws (`FreshnessError`), so a save never writes over a
   * task it could not see as it is.
   */
  async formCheck(item: GoogleTaskItem, fields: TaskFields, extra: SaveExtra = {}): Promise<FormCheck> {
    const had = keptFor(this.client.getView().state, item);
    const state = await this.freshPlan();
    const task = await this.freshTask(item);
    const kept = keptFor(state, task);
    const shown = (at: GoogleTaskItem, entry: GoogleTaskKept | null) => (extra.shows === 'series' && entry ? seriesShown(at, entry) : null) ?? { item: at, kept: entry };
    const now = formValuesOf(shown(task, kept).item, shown(task, kept).kept);
    const base = fields.base ?? formValuesOf(shown(item, had).item, shown(item, had).kept);
    const mine = formValuesOfFields(fields, base, extra);
    return { item: task, kept, base, mine, now, changes: formChanges(base, mine), conflicts: fields.base ? formConflicts(base, mine, now) : [] };
  },

  /**
   * A task's form saved, all or nothing, as the change from what the form
   * showed (`fields.base`) over the task as it is now: a field the form left
   * alone keeps what another window, the service or Google gave it meanwhile,
   * and one the form changed that changed meanwhile too is not written but
   * thrown (`TaskConflict`), for the user to settle. Google's fields (title,
   * details, date) and a move to another list are written first, and what the
   * Planner keeps (time, deadline, repeat with the series' template, star)
   * changes only once Google has taken them, so an edit Google refuses leaves
   * the task, what is kept for it and its series as they were, for the form to
   * try again. A change of what the Planner keeps alone needs no Google write.
   * For a repeating task, `scope` says whether the change is for this task or
   * all of the series, as Google Tasks asks (a new rule is for all); either
   * way it is all or nothing. "This task" changes this occurrence alone, in
   * Google and in what is kept for it; the series' template and schedule
   * stay. "All tasks" is the service's (`GoogleSeries.edit`): the series as
   * the form showed it and as it leaves it, which the service puts over the
   * series as it is then (a rule the form left alone stays as it is then, a
   * cut by This and following tasks included). Upcoming occurrences changed
   * on their own (`setOccurrence`) keep their changes, but for those a new
   * rule or start no longer has. A subtask, or a task with subtasks, does not
   * repeat, and a repeating task stays in its list, as in Google Tasks:
   * refused before anything changes.
   */
  async saveListTask(item: GoogleTaskItem, fields: TaskFields, scope: RepeatScope = 'this', extra: SaveExtra = {}): Promise<void> {
    // Changed meanwhile (while it was asked which tasks it is for, say): the user's to settle, before anything is written.
    const check = await this.formCheck(item, fields, extra);
    if (check.conflicts.length) throw new TaskConflict(check.conflicts, check.now, check.mine, check.base);
    const { base, mine, kept } = check;
    const task = check.item;
    const changed = (field: FormField) => check.changes.includes(field);
    const repeat = kept?.repeat ?? null;
    const rule = mine.rule;
    const ruleChanged = changed('rule');
    const moveTo = changed('listId') && mine.listId !== task.listId ? mine.listId : null;
    if (ruleChanged && rule && !repeat && task.parent) throw new Error(SUBTASK_NO_REPEAT);
    if (ruleChanged && rule && !repeat && task.assigned) throw new Error(SHARED_NO_REPEAT);
    if (moveTo && (repeat || rule)) throw new Error(REPEATING_STAYS);
    if (ruleChanged && rule && !repeat && (await hasSubtasks(this, task))) throw new Error(SUBTASKS_NO_REPEAT);
    const google = { ...(changed('title') ? { title: mine.title } : {}), ...(changed('notes') ? { notes: mine.notes } : {}), ...(changed('due') ? { due: mine.due } : {}) };
    // Declining stays on since it was turned on; a new message or mode keeps that.
    const decline = mine.decline ? { mode: mine.decline.mode, message: mine.decline.message, since: kept?.decline?.since ?? mine.decline.since ?? new Date().toISOString() } : null;
    // What the Planner keeps for it: what the form changed, over what is kept now. Availability, visibility, Do not
    // disturb and declining come with a time, and they and its color are a series' own, as Google Calendar keeps one for
    // a whole series: a change of them is for all its tasks. Attachments are this task's, or (All tasks) the series'.
    const patch: GoogleTaskKeptPatch = {
      ...(changed('time') ? { time: mine.time, duration: mine.time === null ? null : mine.duration } : {}),
      ...(changed('deadline') ? { deadline: mine.deadline } : {}),
      ...(changed('busy') ? { busy: mine.busy } : {}),
      ...(changed('visibility') ? { visibility: mine.visibility } : {}),
      ...(changed('doNotDisturb') ? { doNotDisturb: mine.doNotDisturb } : {}),
      ...(changed('decline') ? { decline } : {}),
      ...(changed('color') ? { color: mine.color } : {}),
      ...(changed('attachments') ? { attachments: mine.attachments } : {}),
      // A star is the Planner's alone: no Google write.
      ...(changed('starred') ? { starred: mine.starred } : {}),
    };
    const advanced = check.changes.some((field) => field !== 'rule' && SERIES_FIELDS.includes(field));
    const all = scope === 'all' || Boolean(repeat && ((ruleChanged && rule) || advanced));
    // An edit of all tasks of a series, or no repeat any more, is the service's, against the series as it is then
    // (`GoogleSeries.edit`): the series as the form showed it (`before`) and as the form leaves it (`after`), so what the
    // form left alone (a rule cut short meanwhile, a time given meanwhile) stays as it is then.
    let series: { before: SeriesSide; after: SeriesSide } | null = null;
    if (kept && repeat) {
      const on = scheduledOn(kept, task) ?? mine.due ?? base.due ?? this.client.getView().today;
      const template = seriesTemplate(kept, task) ?? templateOf(task, kept, on);
      // A rule the form showed none of (given meanwhile) is the one it has now: left alone, it stays.
      const shownRule = base.rule ?? repeat.rule;
      const nextRule = ruleChanged ? rule : shownRule;
      const shown = templateOf(base, base, base.due ?? on, template.start);
      if (nextRule === null || (changed('due') && !mine.due)) {
        series = { before: { rule: shownRule, template: shown, due: base.due }, after: { rule: null, template: shown, due: mine.due } };
      } else if (all) {
        const moved = (ruleChanged && rule !== null) || (changed('due') && mine.due !== on);
        series = { before: { rule: shownRule, template: shown, due: base.due }, after: { rule: nextRule, template: templateOf(mine, { ...mine, decline }, mine.due ?? on, moved && mine.due ? mine.due : template.start), due: mine.due } };
      } else if (!repeat.on || !repeat.template) {
        // First sight of a series kept before templates: kept as this occurrence was, before this one-off change.
        patch.repeat = { ...repeat, on, template };
      }
    } else if (ruleChanged && rule && mine.due) {
      patch.repeat = { rule, seriesId: newId(), index: 1, next: null, on: mine.due, template: templateOf(mine, { ...mine, decline }, mine.due) };
    }
    // What Google has now, put back when the rest of the edit cannot be made.
    const back = { ...(google.title !== undefined ? { title: task.title } : {}), ...(google.notes !== undefined ? { notes: task.notes } : {}), ...(google.due !== undefined ? { due: task.due } : {}) };
    // Google first. A refusal throws here, before anything kept in the Planner has changed.
    const answers = Object.keys(google).length ? await this.writeListTask([task], () => google, google.due !== undefined || google.title !== undefined) : [];
    // Google took the fields but not the move, or the series did not change: they go back as they were, so nothing of
    // the edit stays.
    const putBack = async () => {
      if (answers[0] && Object.keys(back).length) await this.writeListTask([answers[0]], () => back, true).catch(() => {});
    };
    let now: GoogleTaskItem | null = answers[0] ?? null;
    if (moveTo) {
      try {
        now = await this.moveListTask(now ?? task, { parent: null, previous: null }, moveTo);
      } catch (error) {
        await putBack();
        throw error;
      }
    }
    // Google has it: now what the Planner keeps, for the task where it is now.
    const at = now ?? task;
    if (series && repeat) {
      const { repeat: _none, ...own } = patch;
      try {
        await this.client.adopt(await this.client.call<Snapshot>('POST', '/google/tasks/series/edit', { account: at.account, listId: at.listId, taskId: at.id, seriesId: repeat.seriesId, own, ...series }));
      } catch (error) {
        await putBack();
        throw error;
      }
    } else if (Object.keys(patch).length) await this.client.dispatch([{ type: 'gtask.kept', account: at.account, listId: at.listId, taskId: at.id, patch }]);
    // Meetings it overlaps are declined now, not at the next pass.
    if (decline && (patch.decline !== undefined || patch.time !== undefined || patch.duration !== undefined || patch.busy !== undefined || google.due !== undefined)) this.declineSoon();
    // Linked Planner tasks take Google's change at once.
    if (now) await this.syncItems([now]);
    else calendarUi.refresh();
  },

  /**
   * Complete or reopen a task, wherever it is done (the Tasks view, the
   * calendar, Starred). As in Google Tasks, completing a task completes its
   * subtasks, and reopening a subtask reopens the task it is under, read from
   * Google when its list is not loaded (`relatives`). Those are written
   * first, so Google never has an open subtask under a completed task, even
   * when a write fails half way. A repeating task's next occurrence appears.
   * A completion can be undone, as Google Tasks and Google Calendar offer it
   * ("Task completed · Undo", and Ctrl/⌘+Z): `undoLast`. What it needs is
   * read as it is now (the plan, the task's list), not from what this window
   * loaded; one that cannot be read changes nothing (`FreshnessError`).
   */
  async completeListTask(item: GoogleTaskItem, completed: boolean): Promise<void> {
    const state = await this.freshPlan();
    const related = await this.relatives(item, completed);
    // What Undo takes back: the tasks this completes, and what was kept for it before (a series that ends with it).
    const opened = [...related, item].filter((one) => !one.completed);
    const before = keptFor(state, item);
    // A task opened again by hand is what an earlier Undo would have done: that Undo goes.
    this.lastUndo = null;
    const answers = await this.writeListTask([...related, item], () => ({ completed }), true);
    if (completed) {
      const made = await this.makeNextOccurrences(answers);
      this.lastUndo = completionUndo(this, item, opened, before, made.get(item.id) ?? null);
    }
    void this.sync();
  },

  /**
   * Delete a task and its subtasks. A repeating task asks first, as Google
   * Calendar does: "This task" (the series goes on with the next one), "This
   * and following tasks" (the series ends before it) or "All tasks" (the
   * series goes, its completed tasks too); the last two are `deleteSeries`.
   * "This task", all or nothing: on an occurrence whose next one is not made
   * yet, the series makes it first, as when it is done (`makeSuccessor`), and
   * only then is this one deleted; when the next one can't be made, nothing is
   * deleted and the series stays as it was, to delete again. The series'
   * template, schedule and exceptions go on with the next one; deleting this
   * one never drops them while the series goes on. What Undo gives back is
   * read first from where it is kept, never from what this window happened
   * to load: the plan as the service has it, the task as Google has it, and
   * (a task at the top) its subtasks as its list in Google has them now,
   * which Google deletes with it. When one of those cannot be read, nothing
   * is deleted (`FreshnessError`), to try again.
   */
  async deleteListTask(item: GoogleTaskItem, scope: DeleteScope = 'this'): Promise<void> {
    const key = listKey(item.account, item.listId);
    const before = this.view.board[key]?.items ?? [];
    const state = await this.freshPlan();
    const task = await this.freshTask(item);
    const kept = keptFor(state, task);
    if (kept?.repeat && scope !== 'this') {
      const from = scope === 'following' ? scheduledOn(kept, task) : null;
      return this.deleteSeries({ account: task.account, seriesId: kept.repeat.seriesId, from, task: task.id });
    }
    // What Undo gives back: the task and its subtasks as Google has them now (a subtask, or a repeating task, has
    // none), in their order, and what the Planner kept for each.
    const children = task.parent || kept?.repeat ? [] : (await this.readList(task.account, task.listId, "the task's subtasks")).filter((other) => other.parent === task.id).sort((a, b) => a.position.localeCompare(b.position));
    const subtree = [task, ...children];
    const keptBefore = subtree.flatMap((one) => keptFor(state, one) ?? []);
    this.lastUndo = null;
    const next = kept?.repeat && !kept.repeat.next ? nextOccurrence(task, kept) : null;
    this.patchBoard(key, before.filter((other) => other.id !== item.id && other.parent !== item.id));
    let made: GoogleTaskItem | null = null;
    let madeNow: MadeTask | null = null;
    try {
      if (next?.date && next.template) {
        try {
          ({ task: made, made: madeNow } = await this.makeSuccessor(task));
        } catch (error) {
          throw new Error(`the next "${task.title}" couldn't be made, so this one stays (${messageOf(error)})`);
        }
      }
      // A task of a series as kept now, linked to its next one: what the series' Undo gives back.
      const inSeries = keptFor(this.client.getView().state, task);
      try {
        await this.client.call('DELETE', `/google/tasks?account=${encodeURIComponent(task.account)}&list=${encodeURIComponent(task.listId)}&id=${encodeURIComponent(task.id)}`);
      } catch (error) {
        // The next one stays, linked: a DELETE that fails may still have reached Google (the service gives up after
        // 12 s), so deleting the next one too could leave the series with no task at all. Kept, the series goes on
        // from it whatever Google did, and deleting this one again makes no second one (its `repeat.next` is set).
        if (made) throw new Error(`${messageOf(error)}; its next task, ${longDay(made.due ?? next!.date!)}, is made, so deleting this one again finishes`);
        throw error;
      }
      // Google deleted its subtasks with it: what the Planner kept for them goes too (Undo gives it back).
      const dropped = subtree.filter((one) => keptFor(this.client.getView().state, one));
      if (dropped.length) await this.client.dispatch(dropped.map((one) => ({ type: 'gtask.dropped' as const, account: one.account, taskId: one.id })), { origin: 'google' });
      this.afterTaskWrite(item.account, item.listId, true);
      // Read once this one is gone (a read before it could bring it back): Google may renumber the places around them.
      if (made && this.view.board[key]) void this.loadBoard(item.account, item.listId);
      // Undo, as Google Tasks offers it: Google undeletes the task (and its subtasks) and what the Planner kept for it
      // comes back. A task of a series is the service's, one change of the series at a time (`GoogleSeries.undo`): the
      // next one this deletion made goes again while it is still as it was made.
      this.lastUndo = inSeries?.repeat
        ? this.seriesUndo({ account: task.account, seriesId: inSeries.repeat.seriesId, kind: 'one', task: inSeries, made: madeNow }, [task.listId, ...(made ? [made.listId] : [])])
        : async () => {
            const refused = await undelete(this, subtree);
            await restoreKept(this, keptBefore.filter((entry) => !refused.includes(entry.taskId)));
            this.afterTaskWrite(task.account, task.listId, true);
            for (const listId of new Set([item.listId, task.listId])) if (this.view.board[listKey(task.account, listId)]) void this.loadBoard(task.account, listId);
            const note = refused.length ? `Google Tasks did not give back ${refused.length} of its ${children.length} subtask${children.length === 1 ? '' : 's'}` : null;
            return { done: 'Deletion undone', note };
          };
    } catch (error) {
      this.patchBoard(key, before);
      if (made) this.remember(made, true);
      throw error;
    }
  },

  /** Whether there is a deletion or a completion to undo. */
  canUndo(): boolean {
    return Boolean(this.lastUndo);
  },

  /**
   * Google Tasks' "Undo" after Delete or after completing (and Ctrl/⌘+Z):
   * the tasks come back as they were (Google undeletes them, or they are open
   * again) with what the Planner kept for them. Once; null when there is
   * nothing to undo. What to say once done, and (`note`) what stayed as it is.
   */
  async undoLast(): Promise<{ done: string; note: string | null } | null> {
    const last = this.lastUndo;
    this.lastUndo = null;
    return last ? last() : null;
  },
} satisfies ThisType<GoogleStore>;
