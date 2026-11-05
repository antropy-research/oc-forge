// The Google store's repeating tasks (one of its parts, store.ts): Google Tasks' API has no repeat for other apps, so
// the Planner keeps each series (its rule, template, schedule and exceptions) and the service changes one series at a
// time for every window (`GoogleSeries`): the next occurrence made once a task is done, a series' open task Google no
// longer has looked for, "This and following tasks" and "All tasks" deleted with their Undo, and one upcoming
// occurrence changed or deleted on its own ("This task" on the calendar).
import { GOOGLE_NOTES_MAX } from '../../../src/domain/core/events.ts';
import type { DateKey, GoogleTaskException, GoogleTaskKept } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleTaskItem } from '../../../src/domain/google/google.ts';
import { formConflicts, occurrenceNow, occurrenceOf, withOccurrence } from '../../../src/domain/google/taskForm.ts';
import { dueOccurrences, firstSightOfSeries, keptFor, seriesCut, upcomingValues, type MadeTask, type OccurrenceValues, type UpcomingTask } from '../../../src/domain/google/taskKept.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { Snapshot } from '../core/client.ts';
import type { GoogleStore } from './store.ts';
import { formValuesOfFields, listKey, OCCURRENCE_KEEPS_DATE, TaskConflict, type TaskFields, type UndoEntry } from './types.ts';

type Upcoming = Pick<UpcomingTask, 'account' | 'listId' | 'seriesId' | 'on'>;

/** One upcoming occurrence as it is now: as its series has it, or as the task the series made for it meanwhile; null when it is gone. */
const occurrenceAsItIs = async (google: GoogleStore, upcoming: UpcomingTask): Promise<OccurrenceValues | null> => {
  const found = occurrenceNow(await google.freshPlan(), upcoming.account, upcoming.seriesId, upcoming.on, upcoming.taskId);
  if (!found) return null;
  if ('values' in found) return found.values;
  const made = found.task;
  // The task the series made for it meanwhile, as Google has it now (gone from Google, or unreadable: said, not guessed).
  const task = await google.freshTask({ account: made.account, listId: made.listId, id: made.taskId });
  return { title: task.title, notes: task.notes, due: task.due ?? upcoming.on, time: made.time, duration: made.duration, deadline: made.deadline, attachments: made.attachments ?? [] };
};

/** What the service replaced for that occurrence (its own change before this one, null: none), for Undo. */
const changeOccurrence = async (google: GoogleStore, upcoming: Upcoming, edit: Record<string, unknown>): Promise<GoogleTaskException | null> => {
  const answer = await google.client.call<Snapshot & { before?: GoogleTaskException | null }>('POST', '/google/tasks/occurrence', { account: upcoming.account, seriesId: upcoming.seriesId, on: upcoming.on, ...edit });
  await google.client.adopt(answer);
  // A task the series had made for it meanwhile changed in Google: its list as Google has it now.
  if (google.view.board[listKey(upcoming.account, upcoming.listId)]) void google.loadBoard(upcoming.account, upcoming.listId);
  calendarUi.refresh();
  return answer.before ?? null;
};

export const seriesMethods = {
  /**
   * The next occurrence of each repeating task just completed (here, in
   * Google, or found so on a read), made by `makeSuccessor`. A series that
   * ends there stops repeating. One Google refuses is said, and the completed
   * occurrence keeps its series (template, schedule and exceptions) as it
   * was: the next read makes it (`dueOccurrences`).
   */
  async makeNextOccurrences(items: readonly GoogleTaskItem[]): Promise<Map<string, MadeTask | null>> {
    // For each task, the next one this call made (Undo after completing takes that one back).
    const out = new Map<string, MadeTask | null>();
    for (const next of dueOccurrences(this.client.getView().state, items)) {
      const { item, kept } = next;
      const key = `${item.account}\n${item.id}`;
      if (this.making.has(key) || !kept.repeat) continue;
      this.making.add(key);
      try {
        // The service also ends a series that ends here, by the series as it is now (another window may have changed its rule).
        const { task, made } = await this.makeSuccessor(item);
        out.set(item.id, made);
        // Google may renumber the other tasks' places: read the list as Google has it now.
        if (task && this.view.board[listKey(task.account, task.listId)]) void this.loadBoard(task.account, task.listId);
      } catch (error) {
        this.client.notify(`Google Tasks did not take the next "${item.title}": ${messageOf(error)}`);
      } finally {
        this.making.delete(key);
      }
    }
    return out;
  },

  /**
   * The occurrence a series has after `item`, made by the service, which
   * changes one series at a time for every window (`GoogleSeries.next`): a
   * new Google task in the same list, on the series' next date (past the
   * dates deleted on their own) from its template, or as that occurrence was
   * changed on its own, as Google Tasks makes it, kept with its link
   * (`repeat.next`) in the same step. Another window asking at the same time
   * gets the one this one made, and one made already (kept as this series'
   * later occurrence) is taken, never a second; a task that only shares the
   * title and the date is never taken for it. A refusal throws before
   * anything changed. The task made or taken (null when the series has none
   * after `item`), and (`made`) the one this call made, as it was made.
   */
  async makeSuccessor(item: GoogleTaskItem): Promise<{ task: GoogleTaskItem | null; made: MadeTask | null }> {
    const answer = await this.client.call<Snapshot & { task: GoogleTaskItem | null; made?: boolean }>('POST', '/google/tasks/next', { account: item.account, listId: item.listId, id: item.id, completed: item.completed, due: item.due });
    await this.client.adopt(answer);
    const task = answer.task;
    if (task) this.remember(task, true);
    calendarUi.refresh();
    const kept = task && answer.made && answer.state ? keptFor(answer.state, task) : null;
    return { task, made: task && kept ? { listId: task.listId, id: task.id, title: task.title, notes: task.notes, due: task.due, updatedAt: kept.updatedAt } : null };
  },

  /** A series kept before templates gets its template from its open occurrence the first time it is seen (`firstSightOfSeries`). */
  async keepSeries(items: readonly GoogleTaskItem[]): Promise<void> {
    const bodies = firstSightOfSeries(this.client.getView().state, items);
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'google' });
  },

  /**
   * The open tasks of series in a list that a complete read of it no longer
   * has: moved to another list or deleted in Google's own apps. The service
   * looks (`GoogleSeries.gone`): one moved is followed, one deleted is taken
   * as "This task" deleted there, so its series goes on from its next one
   * instead of showing upcoming tasks after a task Google no longer has.
   */
  missingHeads(account: string, listId: string, tasks: readonly GoogleTaskItem[]): void {
    for (const kept of Object.values(this.client.getView().state.googleTasks ?? {})) {
      const key = `${account}\n${kept.taskId}`;
      if (kept.account !== account || kept.listId !== listId || !kept.repeat || kept.repeat.next || this.looking.has(key) || tasks.some((task) => task.id === kept.taskId)) continue;
      this.looking.add(key);
      void this.client
        .call<Snapshot>('POST', '/google/tasks/gone', { account, listId, id: kept.taskId })
        .then((answer) => this.client.adopt(answer))
        .then(() => calendarUi.refresh())
        .catch((error) => console.warn(`[planner] Google Tasks: where a series' task went is not known: ${messageOf(error)}`))
        .finally(() => this.looking.delete(key));
    }
  },

  /**
   * "This and following tasks" of a series, from the date it puts an
   * occurrence on (`from`; `task`, when asked from a task Google has, goes
   * too), or "All tasks" (`from` null), as Google Calendar deletes them. The
   * service does it, one change of a series at a time for every window
   * (`GoogleSeries.remove`): the open tasks go in Google first, then the
   * series as kept here, its tasks before `from` ending the day before, so
   * those and their upcoming occurrences stay and nothing is made past it;
   * the completed tasks from `from` on (all of them for All tasks) go too.
   * Shown at once in the Tasks view, and back when Google refuses.
   */
  async deleteSeries(target: { account: string; seriesId: string; from: DateKey | null; task?: string }): Promise<void> {
    const { remove } = seriesCut(this.client.getView().state.googleTasks, target.account, target.seriesId, target.from, target.task ?? null);
    // What Undo gives back, as this window has it (the service answers with the series as it was just before).
    let keptBefore = Object.values(this.client.getView().state.googleTasks).filter((entry) => entry.account === target.account && entry.repeat?.seriesId === target.seriesId);
    this.lastUndo = null;
    const boards = Object.entries(this.view.board).filter(([key]) => key.startsWith(`${target.account}\n`));
    const without = (ids: Iterable<string>) => {
      const gone = new Set(ids);
      for (const [key] of boards) {
        const list = this.view.board[key];
        if (list) this.patchBoard(key, list.items.filter((other) => !gone.has(other.id) && !(other.parent && gone.has(other.parent))));
      }
    };
    without([...remove.map((kept) => kept.taskId), ...(target.task ? [target.task] : [])]);
    let deleted: string[];
    try {
      const query = new URLSearchParams({ account: target.account, series: target.seriesId, ...(target.from ? { from: target.from } : {}), ...(target.task ? { task: target.task } : {}) });
      const answer = await this.client.call<Snapshot & { deleted: string[]; before?: GoogleTaskKept[] }>('DELETE', `/google/tasks/series?${query}`);
      await this.client.adopt(answer);
      deleted = answer.deleted ?? [];
      keptBefore = answer.before ?? keptBefore;
    } catch (error) {
      for (const [key, list] of boards) this.patchBoard(key, list.items);
      throw error;
    }
    // What the service deleted, which another window may have added to since this one read the series.
    without(deleted);
    for (const listId of new Set(remove.map((kept) => kept.listId))) this.afterTaskWrite(target.account, listId, false);
    calendarUi.refresh();
    const listOf = (id: string) => keptBefore.find((entry) => entry.taskId === id)?.listId ?? remove.find((entry) => entry.taskId === id)?.listId ?? null;
    const gone = deleted.flatMap((id) => (listOf(id) ? [{ listId: listOf(id)!, id }] : []));
    this.lastUndo = this.seriesUndo({ account: target.account, seriesId: target.seriesId, kind: 'cut', from: target.from, deleted: gone, before: keptBefore }, keptBefore.map((entry) => entry.listId));
  },

  /**
   * Undo after deleting tasks of a series, which the service takes back, one
   * change of the series at a time and against the series as it is then
   * (`GoogleSeries.undo`); the lists it touches read again.
   */
  seriesUndo(body: { account: string; seriesId: string } & Record<string, unknown>, lists: readonly string[]): UndoEntry {
    return async () => {
      const answer = await this.client.call<Snapshot & { nextKept: boolean; failed: number }>('POST', '/google/tasks/series/undo', body);
      await this.client.adopt(answer);
      for (const listId of new Set(lists)) {
        this.afterTaskWrite(body.account, listId, true);
        if (this.view.board[listKey(body.account, listId)]) void this.loadBoard(body.account, listId);
      }
      calendarUi.refresh();
      const note = answer.failed ? `Google Tasks did not give back ${answer.failed} of the tasks` : answer.nextKept ? 'Its next task stays, as it was changed or completed since' : null;
      return { done: 'Deletion undone', note };
    };
  },

  /**
   * One upcoming occurrence of a series changed on its own, as Google Calendar
   * changes one ("This task" on the calendar): deleted (`{ skip: true }`: the
   * series passes over its date and goes on), or (Undo) put back as it was:
   * `change` is what it had, null as its series has it. The service keeps it
   * with the series as the series is then (`GoogleSeries.occurrence`), by the
   * date the series puts it on, applied when the series makes it; one the
   * series has made meanwhile is deleted as "This task" deletes one. The
   * series and its other occurrences stay as they are.
   */
  setOccurrence(upcoming: Upcoming, change: GoogleTaskException | null): Promise<GoogleTaskException | null> {
    return changeOccurrence(this, upcoming, change?.skip ? { skip: true } : { restore: change });
  },

  /**
   * One upcoming occurrence edited on its own ("This task"), from what the
   * editor showed (`fields.base`, else the occurrence as it was opened) to its
   * form: the service puts what the edit changed over the occurrence as it is
   * then (a change made meanwhile in another window, or of the series, stays),
   * and a task the series has made for it meanwhile is changed instead, in
   * Google too. A field the edit changed that changed meanwhile too is not
   * written but thrown (`TaskConflict`), for the user to settle.
   */
  async editOccurrence(upcoming: UpcomingTask, fields: TaskFields): Promise<void> {
    if (!fields.due) throw new Error(OCCURRENCE_KEEPS_DATE);
    if (fields.title.length > 1024 || fields.notes.length > GOOGLE_NOTES_MAX) throw new Error(`Google Tasks takes a title of at most 1024 characters and details of at most ${GOOGLE_NOTES_MAX}`);
    // Its attachments too: This task attaches files to this occurrence alone, as Google Calendar does.
    const after = { title: fields.title, notes: fields.notes, due: fields.due, time: fields.kept.time, duration: fields.kept.duration, deadline: fields.kept.deadline, ...(fields.kept.attachments ? { attachments: fields.kept.attachments } : {}) };
    const base = fields.base;
    if (base) {
      const now = await occurrenceAsItIs(this, upcoming);
      // Deleted alone or gone with its series meanwhile: the service refuses the edit, and says so.
      if (now) {
        const mine = formValuesOfFields(fields, base);
        const values = withOccurrence(base, now);
        const conflicts = formConflicts(base, mine, values);
        if (conflicts.length) throw new TaskConflict(conflicts, values, mine, base);
      }
    }
    await changeOccurrence(this, upcoming, { before: base ? occurrenceOf(base, upcoming.on) : upcomingValues(upcoming), after });
  },
} satisfies ThisType<GoogleStore>;
