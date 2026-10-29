// A repeating Google task's series, changed where every Planner window of
// this OpenChamber server meets: its service. Google Tasks' API has no repeat,
// so the Planner makes each next occurrence itself (`gtaskKept.ts`). Here one
// series changes at a time, by account and series, and every change is
// worked out from the plan as it is when it is written, never from what a
// window last saw, nor from what the plan was before Google answered: its
// next occurrence, found or made and linked in one step (a second window gets
// the first one's); one upcoming occurrence changed or deleted on its own;
// an edit of all its tasks, or no repeat any more; "This and following tasks"
// and "All tasks", as Google Calendar deletes them; and its open task deleted
// or moved in Google's own apps.
import type { EventBody } from '../src/domain/events.ts';
import { TASK_GONE, type GoogleTaskItem } from '../src/domain/google.ts';
import {
  keptFor,
  mergeOccurrence,
  nextOccurrence,
  occurrenceChange,
  occurrenceIndex,
  occurrenceTask,
  occurrenceValues,
  seriesCut,
  seriesEdit,
  seriesNextIn,
  withException,
  withExceptions,
  type OccurrenceValues,
  type SeriesSide,
} from '../src/domain/gtaskKept.ts';
import { GTASK_EXCEPTIONS_MAX, type GoogleTaskKeptPatch } from '../src/domain/events.ts';
import { newId } from '../src/domain/ids.ts';
import type { DateKey, GoogleTaskException, GoogleTaskKept, PlannerState } from '../src/domain/types.ts';
import { GoogleError } from './google.ts';
import type { GoogleData } from './googleData.ts';
import type { ExecuteResult } from './planner.ts';

/** The Planner, as far as a series needs it. */
export interface SeriesPlanner {
  readonly state: PlannerState;
  execute(commands: readonly unknown[]): ExecuteResult;
}

export type SeriesData = Pick<GoogleData, 'allTasks' | 'createTask' | 'deleteTask' | 'updateTask' | 'locateTasks'>;

/** What a window knows of a task it asks for the next occurrence of: done, and its date (for a series kept before its dates were). */
export interface NextHint {
  completed?: boolean;
  due?: DateKey | null;
}

/** One upcoming occurrence changed on its own: deleted, put back as it was (Undo), or edited from what a window showed to its form. */
export type OccurrenceEdit = { skip: true } | { restore: GoogleTaskException | null } | { before: OccurrenceValues; after: OccurrenceValues };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isGone = (error: unknown): boolean => error instanceof GoogleError && error.status === 404;
/** How long a series' deletion goes on deleting its completed tasks before it answers (the host waits 20 s); the rest follow. */
const DONE_IN_ANSWER_MS = 5000;
export const SERIES_GONE = 'Google Tasks no longer has this series';
export const OCCURRENCE_GONE = 'This task is no longer in its series';
export const OCCURRENCE_DONE = 'This task was completed meanwhile';

type Repeat = NonNullable<GoogleTaskKept['repeat']>;
/** Where a series goes after a task, by the plan as it is now. */
type Plan =
  | { kind: 'none' }
  | { kind: 'linked'; id: string }
  | { kind: 'ends'; completed: boolean }
  | { kind: 'make'; repeat: Repeat; item: GoogleTaskItem; task: ReturnType<typeof occurrenceTask> };

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
   * the link in the same step. What it is made with is worked out again once
   * Google has made it, from the plan as it is then: Google gets what changed
   * meanwhile (a change written past this lock, a sync merging the plan), and
   * a task the series no longer wants is deleted again. A refusal throws
   * before anything changed. A completed task whose series ends there stops
   * repeating; one being deleted keeps its repeat until it goes. `made` says
   * whether this call made it.
   */
  next(account: string, listId: string, taskId: string, hint: NextHint = {}): Promise<{ task: GoogleTaskItem | null; made: boolean }> {
    const seriesId = keptFor(this.planner.state, { account, id: taskId })?.repeat?.seriesId;
    if (!seriesId) return Promise.resolve({ task: null, made: false });
    return this.one(account, seriesId, () => this.nextNow(account, listId, taskId, hint));
  }

  private async nextNow(account: string, listId: string, taskId: string, hint: NextHint): Promise<{ task: GoogleTaskItem | null; made: boolean }> {
    let listed: GoogleTaskItem[] | null = null;
    const read = async (list = listId): Promise<GoogleTaskItem[]> => {
      if (list !== listId) return (await this.data.allTasks(account, list)).tasks;
      return (listed ??= (await this.data.allTasks(account, listId)).tasks);
    };
    const plan = (): Plan => {
      const kept = keptFor(this.planner.state, { account, id: taskId });
      const repeat = kept?.repeat;
      if (!kept || !repeat) return { kind: 'none' };
      if (repeat.next) return { kind: 'linked', id: repeat.next };
      // As Google has it once read; until then (and once gone from its list) as the series keeps it and the window saw it.
      const item = listed?.find((task) => task.id === taskId) ?? { account, listId, id: taskId, title: repeat.template?.title ?? '', notes: repeat.template?.notes ?? '', due: repeat.on ?? hint.due ?? null, completed: hint.completed ?? false, parent: null, position: '', url: '', updated: '' };
      const next = nextOccurrence(item, kept);
      if (!next.date || !next.template) return { kind: 'ends', completed: item.completed };
      return { kind: 'make', repeat, item, task: occurrenceTask(repeat, next.template, next.date, next.index) };
    };
    const linked = async (id: string) => {
      const there = keptFor(this.planner.state, { account, id })?.listId ?? listId;
      return { task: (await read(there)).find((task) => task.id === id) ?? null, made: false };
    };
    const end = (completed: boolean) => {
      if (completed) this.write([{ type: 'gtask.kept', account, listId: keptFor(this.planner.state, { account, id: taskId })?.listId ?? listId, taskId, patch: { repeat: null } }]);
      return { task: null, made: false };
    };
    const link = (repeat: Repeat, id: string): EventBody => ({ type: 'gtask.kept', account, listId: keptFor(this.planner.state, { account, id: taskId })?.listId ?? listId, taskId, patch: { repeat: { ...repeat, next: id } } });
    const titleOf = (planned: Extract<Plan, { kind: 'make' }>) => planned.task.title.trim() || planned.item.title;

    let planned = plan();
    // A series kept before templates goes on from the task as Google has it; whether it is done, too, when its window did not say.
    if ((planned.kind === 'make' && (!planned.repeat.template || !planned.repeat.on)) || (planned.kind === 'ends' && hint.completed === undefined)) {
      await read();
      planned = plan();
    }
    if (planned.kind === 'none') return { task: null, made: false };
    if (planned.kind === 'linked') return linked(planned.id);
    if (planned.kind === 'ends') return end(planned.completed);
    const tasks = await read();
    planned = plan();
    if (planned.kind === 'none') return { task: null, made: false };
    if (planned.kind === 'linked') return linked(planned.id);
    if (planned.kind === 'ends') return end(planned.completed);
    const found = seriesNextIn(this.planner.state, tasks, planned.repeat, taskId);
    if (found) {
      this.write([link(planned.repeat, found.id)]);
      return { task: found, made: false };
    }
    const created = await this.data.createTask(account, listId, { title: titleOf(planned), ...(planned.task.notes ? { notes: planned.task.notes } : {}), due: planned.task.due });
    if (!created) throw new GoogleError(502, 'Google did not return the task');
    let made: GoogleTaskItem = created;
    this.options.onWrite?.();
    // Google has made it: what it is now comes from the plan as it is now.
    for (let round = 0; ; round++) {
      const now = plan();
      if (now.kind !== 'make') {
        // Not wanted any more (ended, cut or deleted meanwhile, or linked to another): it goes again.
        await this.data.deleteTask(account, made.listId, made.id).catch((error) => this.options.log?.(`Google Tasks kept a next task no series wants: ${messageOf(error)}`));
        if (now.kind === 'linked') return linked(now.id);
        return now.kind === 'ends' ? end(now.completed) : { task: null, made: false };
      }
      const fix: { title?: string; notes?: string; due?: DateKey } = {
        ...(made.title !== titleOf(now) ? { title: titleOf(now) } : {}),
        ...(made.notes !== now.task.notes ? { notes: now.task.notes } : {}),
        ...(made.due !== now.task.due ? { due: now.task.due } : {}),
      };
      if (Object.keys(fix).length && round < 3) {
        const answer: GoogleTaskItem | null = await this.data.updateTask(account, made.listId, made.id, fix);
        made = answer ?? { ...made, ...fix };
        continue;
      }
      try {
        this.write([link(now.repeat, made.id), { type: 'gtask.kept', account: made.account, listId: made.listId, taskId: made.id, patch: now.task.kept }]);
      } catch (error) {
        // Not kept, so not linked: it goes again, and asking again makes exactly one.
        await this.data.deleteTask(account, made.listId, made.id).catch(() => {});
        throw error;
      }
      return { task: made, made: true };
    }
  }

  /**
   * One upcoming occurrence of a series changed on its own ("This task" on
   * the calendar), against the series as it is now: deleted (`skip`), put
   * back as it was (`restore`: Undo), or edited from what a window showed
   * (`before`) to its form (`after`), what the edit changed going over what
   * changed meanwhile (another window's edit of it, an edit of the series).
   * Kept with each open task of the series, by the date the series puts it
   * on. One the series has made meanwhile (a task in Google now, by that
   * date) is changed as that task: its title, details and date in Google, its
   * time and deadline here; deleted, its next one is made first, as "This
   * task" deletes one. Refused when the series puts nothing on that date any
   * more (cut, ended, a new rule), or that task was completed meanwhile.
   */
  occurrence(account: string, seriesId: string, on: DateKey, edit: OccurrenceEdit): Promise<void> {
    return this.one(account, seriesId, async () => {
      const tasks = Object.values(this.planner.state.googleTasks).filter((entry) => entry.account === account && entry.repeat?.seriesId === seriesId);
      if (!tasks.length) throw new GoogleError(404, SERIES_GONE);
      const real = tasks.find((entry) => entry.repeat!.on === on);
      if (real) return this.occurrenceMade(real, edit);
      const heads = tasks.filter((entry) => !entry.repeat!.next);
      // Its tasks done or cut, nothing upcoming: the occurrence went with them.
      if (!heads.length) throw new GoogleError(409, OCCURRENCE_GONE);
      if (!heads[0]!.repeat!.template) throw new GoogleError(404, SERIES_GONE);
      if (occurrenceIndex(heads[0]!.repeat!, on) === null) throw new GoogleError(409, OCCURRENCE_GONE);
      const template = heads[0]!.repeat!.template;
      const current = heads[0]!.repeat!.exceptions?.[on];
      let change: GoogleTaskException | null;
      if ('skip' in edit) change = { skip: true };
      else if ('restore' in edit) change = edit.restore;
      else {
        if (current?.skip) throw new GoogleError(409, 'This task was deleted meanwhile');
        change = occurrenceChange(template, on, mergeOccurrence(occurrenceValues(template, on, current), edit.before, edit.after));
      }
      const repeats = heads.map((head) => withExceptions(head.repeat!, withException(head.repeat!.exceptions, on, change)));
      if (repeats.some((repeat) => Object.keys(repeat.exceptions ?? {}).length > GTASK_EXCEPTIONS_MAX)) throw new GoogleError(400, `A series keeps at most ${GTASK_EXCEPTIONS_MAX} of its tasks changed on their own`);
      this.write(heads.map((head, index) => ({ type: 'gtask.kept', account, listId: head.listId, taskId: head.taskId, patch: { repeat: repeats[index]! } })));
    });
  }

  /** An occurrence changed on its own that the series has made meanwhile: changed as the task it is now. */
  private async occurrenceMade(real: GoogleTaskKept, edit: OccurrenceEdit): Promise<void> {
    const { account, listId, taskId } = real;
    if (real.repeat!.next) throw new GoogleError(409, OCCURRENCE_DONE);
    if ('restore' in edit) throw new GoogleError(409, 'This task is in Google Tasks now: change it there');
    const google = (await this.data.allTasks(account, listId)).tasks.find((task) => task.id === taskId);
    if (!google) throw new GoogleError(404, TASK_GONE);
    if (google.completed) throw new GoogleError(409, OCCURRENCE_DONE);
    if ('skip' in edit) {
      // As "This task" deletes one: its next one first, so the series never goes.
      await this.nextNow(account, listId, taskId, { completed: false, due: google.due });
      await this.data.deleteTask(account, listId, taskId);
      this.options.onWrite?.();
      this.write([{ type: 'gtask.dropped', account, taskId }]);
      return;
    }
    const latest: OccurrenceValues = { title: google.title, notes: google.notes, due: google.due ?? real.repeat!.on!, time: real.time, duration: real.duration, deadline: real.deadline };
    const merged = mergeOccurrence(latest, edit.before, edit.after);
    const fix = { ...(merged.title !== latest.title ? { title: merged.title } : {}), ...(merged.notes !== latest.notes ? { notes: merged.notes } : {}), ...(merged.due !== latest.due ? { due: merged.due } : {}) };
    if (Object.keys(fix).length) {
      await this.data.updateTask(account, listId, taskId, fix);
      this.options.onWrite?.();
    }
    const patch: GoogleTaskKeptPatch = {
      ...(merged.time !== real.time || merged.duration !== real.duration ? { time: merged.time, duration: merged.time === null ? null : merged.duration } : {}),
      ...(merged.deadline !== real.deadline ? { deadline: merged.deadline } : {}),
    };
    // Kept as changed now even when Google alone has the change (its title), so every window reads it again.
    if (Object.keys(patch).length || Object.keys(fix).length) this.write([{ type: 'gtask.kept', account, listId, taskId, patch: Object.keys(patch).length ? patch : { time: real.time } }]);
  }

  /**
   * An edit of all tasks of a series (Edit → All tasks, a new rule, or no
   * repeat any more), from `taskId`: Google has that task's own title,
   * details and date already (written by its window first, all or nothing).
   * The series as kept here takes what the edit changed, against the series
   * as it is now (`seriesEdit`), and its other open tasks, a next one made
   * meanwhile among them, take its new title and details in Google too.
   */
  edit(account: string, listId: string, taskId: string, seriesId: string, own: GoogleTaskKeptPatch, before: SeriesSide, after: SeriesSide): Promise<void> {
    return this.one(account, seriesId, async () => {
      const planned = seriesEdit(this.planner.state, account, seriesId, taskId, own, before, after);
      if (!planned) throw new GoogleError(404, SERIES_GONE);
      if (planned.google.length) {
        const lists = new Map<string, GoogleTaskItem[]>();
        for (const write of planned.google) {
          const tasks = lists.get(write.listId) ?? (await this.data.allTasks(account, write.listId)).tasks;
          lists.set(write.listId, tasks);
          const there = tasks.find((task) => task.id === write.taskId);
          const fix = { ...(there && write.title !== undefined && there.title !== write.title ? { title: write.title } : {}), ...(there && write.notes !== undefined && there.notes !== write.notes ? { notes: write.notes } : {}) };
          if (!there || there.completed || !Object.keys(fix).length) continue;
          await this.data.updateTask(account, write.listId, write.taskId, fix).catch((error) => {
            if (!isGone(error)) throw error;
          });
          this.options.onWrite?.();
        }
      }
      // From the plan as it is once Google has answered.
      this.write((seriesEdit(this.planner.state, account, seriesId, taskId, own, before, after) ?? planned).bodies);
    });
  }

  /**
   * A series' open task that a complete read of its list no longer has:
   * moved to another list in Google's own apps (it is followed there), or
   * deleted there, which is taken as "This task" deleted: the series goes on
   * from its next one, as when the Planner deletes one. Nothing changes when
   * Google has it after all, or it is no open task of a series.
   */
  gone(account: string, listId: string, taskId: string): Promise<void> {
    const seriesId = keptFor(this.planner.state, { account, id: taskId })?.repeat?.seriesId;
    if (!seriesId) return Promise.resolve();
    return this.one(account, seriesId, async () => {
      const kept = keptFor(this.planner.state, { account, id: taskId });
      if (!kept?.repeat || kept.repeat.next || kept.listId !== listId) return;
      const read = await this.data.allTasks(account, listId);
      if (!read.complete || read.tasks.some((task) => task.id === taskId)) return;
      const [moved] = await this.data.locateTasks(account, [taskId], listId);
      if (moved) {
        this.write([{ type: 'gtask.moved', account, taskId, listId: moved.listId }]);
        return;
      }
      if (kept.repeat.on && kept.repeat.template) await this.nextNow(account, listId, taskId, { completed: false });
      this.write([{ type: 'gtask.dropped', account, taskId }]);
    });
  }

  /**
   * Google Calendar's "This and following tasks" (from the date the series
   * put `chosen` on, or an upcoming occurrence on) and "All tasks" (`from`
   * null), as `seriesCut` plans them. Its open tasks, and `chosen`, are
   * deleted in Google first, then the series as kept here changes in one step,
   * worked out again from the plan as it is then: the tasks deleted are
   * dropped, the ones before `from` end the day before. A refused delete
   * changes nothing more than what Google had deleted by then. Its completed
   * tasks from `from` on go from Google next, those left after a few seconds
   * once the answer is on its way, as a long series has many. The ids of the
   * tasks deleted.
   */
  remove(account: string, seriesId: string, from: DateKey | null, chosen: string | null): Promise<{ deleted: string[] }> {
    const until = Date.now() + DONE_IN_ANSWER_MS;
    return this.one(account, seriesId, async () => {
      const { remove, keep } = seriesCut(this.planner.state.googleTasks, account, seriesId, from, chosen);
      if (!remove.length && !keep.length) throw new GoogleError(404, SERIES_GONE);
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
      const removed = new Set(remove.map((kept) => kept.taskId));
      const kept = from === null ? keep : seriesCut(this.planner.state.googleTasks, account, seriesId, from, chosen).keep.filter((body) => !removed.has((body as { taskId: string }).taskId));
      this.write([...remove.map((entry): EventBody => ({ type: 'gtask.dropped', account, taskId: entry.taskId })), ...kept]);
      const left = await this.deleteDone(account, remove.filter((entry) => !first.includes(entry)), until);
      if (left.length) this.cleanup = this.cleanup.then(() => this.deleteDone(account, left, Infinity)).then(() => undefined);
      return { deleted: remove.map((entry) => entry.taskId) };
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
    if (!bodies.length) return;
    const result = this.planner.execute(bodies.map((body) => ({ cmd: newId(), ...body })));
    if (!result.ok) throw new GoogleError(500, `The Planner did not keep it: ${result.error}`);
  }
}
