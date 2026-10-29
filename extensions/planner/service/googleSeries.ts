// A repeating Google task's series, changed where every Planner window of
// this OpenChamber server meets: its service. Google Tasks' API has no repeat,
// so the Planner makes each next occurrence itself (`gtaskKept.ts`); made in
// the window that saw the task completed, two windows completing it at once
// each made one. Here one series changes at a time, by account and series: its
// next occurrence is found or made and linked in one step, so a second window
// gets the one the first made; and "This and following tasks" or "All tasks"
// deletes from it as Google Calendar does.
import type { EventBody } from '../src/domain/events.ts';
import { TASK_GONE, type GoogleTaskItem } from '../src/domain/google.ts';
import { keptFor, nextOccurrence, occurrenceTask, seriesCut, seriesNextIn } from '../src/domain/gtaskKept.ts';
import { newId } from '../src/domain/ids.ts';
import type { DateKey, GoogleTaskKept, PlannerState } from '../src/domain/types.ts';
import { GoogleError } from './google.ts';
import type { GoogleData } from './googleData.ts';
import type { ExecuteResult } from './planner.ts';

/** The Planner, as far as a series needs it. */
export interface SeriesPlanner {
  readonly state: PlannerState;
  execute(commands: readonly unknown[]): ExecuteResult;
}

export type SeriesData = Pick<GoogleData, 'allTasks' | 'createTask' | 'deleteTask'>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** How long a series' deletion goes on deleting its completed tasks before it answers (the host waits 20 s); the rest follow. */
const DONE_IN_ANSWER_MS = 5000;

export class GoogleSeries {
  /** Each series' last change, by account and series id: the next change of it waits for this one. */
  private readonly changing = new Map<string, Promise<unknown>>();
  /** The completed tasks of deleted series, deleted in Google after the answer. */
  private cleanup: Promise<void> = Promise.resolve();

  constructor(
    private readonly planner: SeriesPlanner,
    private readonly data: SeriesData,
    private readonly options: { idle?: () => Promise<void>; log?: (message: string) => void; onWrite?: () => void } = {},
  ) {}

  /** Every change asked for so far is done (or failed), in Google too. */
  async settled(): Promise<void> {
    while (this.changing.size) await Promise.all([...this.changing.values()]);
    await this.cleanup;
  }

  /**
   * The occurrence after `taskId` (completed, or about to be deleted with
   * "This task"), made once however many windows ask: one linked already
   * (`repeat.next`) is answered as Google has it; one in the list kept as a
   * later occurrence of the series (made before its link was kept, or by
   * another Planner sharing the plan) is linked; otherwise it is made in
   * Google from the series (`nextOccurrence`, `occurrenceTask`) and kept with
   * the link in the same step. A refusal throws before anything changed. A
   * completed task whose series ends there stops repeating; one being deleted
   * keeps its repeat until it goes. `made` says whether this call made it.
   */
  next(account: string, listId: string, taskId: string): Promise<{ task: GoogleTaskItem | null; made: boolean }> {
    const seriesId = keptFor(this.planner.state, { account, id: taskId })?.repeat?.seriesId;
    if (!seriesId) return Promise.resolve({ task: null, made: false });
    return this.one(account, seriesId, async () => {
      const state = this.planner.state;
      const kept = keptFor(state, { account, id: taskId });
      const repeat = kept?.repeat;
      if (!kept || !repeat) return { task: null, made: false };
      const tasks = (await this.data.allTasks(account, listId)).tasks;
      if (repeat.next) {
        const linked = keptFor(state, { account, id: repeat.next });
        const there = linked && linked.listId !== listId ? (await this.data.allTasks(account, linked.listId)).tasks : tasks;
        return { task: there.find((task) => task.id === repeat.next) ?? null, made: false };
      }
      // Gone from its list in Google meanwhile: a series with a template still goes on from what it keeps.
      const item = tasks.find((task) => task.id === taskId) ?? (repeat.on && repeat.template ? { account, listId, id: taskId, title: repeat.template.title, notes: repeat.template.notes, due: repeat.on, completed: false, parent: null, position: '', url: '', updated: '' } : null);
      if (!item) throw new GoogleError(404, TASK_GONE);
      const next = nextOccurrence(item, kept);
      if (!next.date || !next.template) {
        if (item.completed) this.write([{ type: 'gtask.kept', account, listId: kept.listId, taskId, patch: { repeat: null } }]);
        return { task: null, made: false };
      }
      const link = (id: string): EventBody => ({ type: 'gtask.kept', account, listId: kept.listId, taskId, patch: { repeat: { ...repeat, next: id } } });
      const found = seriesNextIn(state, tasks, repeat, taskId);
      if (found) {
        this.write([link(found.id)]);
        return { task: found, made: false };
      }
      const task = occurrenceTask(repeat, next.template, next.date, next.index);
      const made = await this.data.createTask(account, listId, { title: task.title.trim() || item.title, ...(task.notes ? { notes: task.notes } : {}), due: task.due });
      if (!made) throw new GoogleError(502, 'Google did not return the task');
      this.options.onWrite?.();
      try {
        this.write([link(made.id), { type: 'gtask.kept', account: made.account, listId: made.listId, taskId: made.id, patch: task.kept }]);
      } catch (error) {
        // Not kept, so not linked: it goes again, and asking again makes exactly one.
        await this.data.deleteTask(account, made.listId, made.id).catch(() => {});
        throw error;
      }
      return { task: made, made: true };
    });
  }

  /**
   * Google Calendar's "This and following tasks" (from the date the series
   * put `chosen` on, or an upcoming occurrence on) and "All tasks" (`from`
   * null), as `seriesCut` plans them. Its open tasks, and `chosen`, are
   * deleted in Google first, then the series as kept here changes in one step:
   * the tasks deleted are dropped, the ones before `from` end the day before.
   * A refused delete changes nothing more than what Google had deleted by
   * then. Its completed tasks from `from` on go from Google next, those left
   * after a few seconds once the answer is on its way, as a long series has
   * many. The ids of the tasks deleted.
   */
  remove(account: string, seriesId: string, from: DateKey | null, chosen: string | null): Promise<{ deleted: string[] }> {
    const until = Date.now() + DONE_IN_ANSWER_MS;
    return this.one(account, seriesId, async () => {
      const { remove, keep } = seriesCut(this.planner.state.googleTasks, account, seriesId, from, chosen);
      if (!remove.length && !keep.length) throw new GoogleError(404, 'Google Tasks no longer has this series');
      const first = remove.filter((kept) => !kept.repeat?.next || kept.taskId === chosen);
      const gone: string[] = [];
      try {
        for (const kept of first) {
          await this.data.deleteTask(account, kept.listId, kept.taskId);
          gone.push(kept.taskId);
        }
      } catch (error) {
        if (gone.length) this.write(gone.map((taskId) => ({ type: 'gtask.dropped', account, taskId })));
        throw error;
      } finally {
        if (gone.length) this.options.onWrite?.();
      }
      this.write([...remove.map((kept): EventBody => ({ type: 'gtask.dropped', account, taskId: kept.taskId })), ...keep]);
      const left = await this.deleteDone(account, remove.filter((kept) => !first.includes(kept)), until);
      if (left.length) this.cleanup = this.cleanup.then(() => this.deleteDone(account, left, Infinity)).then(() => undefined);
      return { deleted: remove.map((kept) => kept.taskId) };
    });
  }

  /**
   * Completed tasks of a deleted series, deleted in Google one after another
   * until `until`; one Google refuses stays there, as a task done. Those not
   * reached by then.
   */
  private async deleteDone(account: string, tasks: readonly GoogleTaskKept[], until: number): Promise<GoogleTaskKept[]> {
    const failed: string[] = [];
    let done = 0;
    for (; done < tasks.length && Date.now() < until; done++) {
      try {
        await this.data.deleteTask(account, tasks[done]!.listId, tasks[done]!.taskId);
      } catch (error) {
        failed.push(messageOf(error));
      }
    }
    if (done) this.options.onWrite?.();
    if (failed.length) this.options.log?.(`Google Tasks kept ${failed.length} completed tasks of a deleted series: ${failed[0]}`);
    return tasks.slice(done);
  }

  /** One change of a series at a time: each waits for the one before it, and for a sync merging the plan. */
  private one<T>(account: string, seriesId: string, work: () => Promise<T>): Promise<T> {
    const key = `${account}\n${seriesId}`;
    const run = (this.changing.get(key) ?? Promise.resolve()).then(async () => {
      await this.options.idle?.();
      return work();
    });
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.changing.set(key, done);
    void done.then(() => {
      if (this.changing.get(key) === done) this.changing.delete(key);
    });
    return run;
  }

  /** Into the plan, checked as any command is; a refusal throws. */
  private write(bodies: EventBody[]): void {
    const result = this.planner.execute(bodies.map((body) => ({ cmd: newId(), ...body })));
    if (!result.ok) throw new GoogleError(500, `The Planner did not keep it: ${result.error}`);
  }
}
