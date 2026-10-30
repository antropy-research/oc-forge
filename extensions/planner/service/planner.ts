// The service's planner core: validate commands, turn them into events, persist, fold.
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { SUBTASK_CHANGED, commandBody, subtaskConflict, validateCommand, type Command, type EventBody, type PlannerEvent, type SubtaskConflict } from '../src/domain/events.ts';
import { planRollover } from '../src/domain/rollover.ts';
import { planInstances } from '../src/domain/recurrence.ts';
import { touchesTask } from '../src/domain/activity.ts';
import { changedSince, inverseOfBatch } from '../src/domain/undo.ts';
import { todayIn } from '../src/domain/dates.ts';
import { newId } from '../src/domain/ids.ts';
import type { DateKey, PlannerState } from '../src/domain/types.ts';
import type { EventStore } from './store.ts';

/** `conflict`: a subtask the batch changes was changed elsewhere since (`subtaskConflict`); nothing of it was written. */
export type ExecuteResult = { ok: true; applied: number } | { ok: false; error: string; index: number; conflict?: SubtaskConflict };

/**
 * An Undo, as the service decides it: done (the commands it wrote, for the
 * window's follow-ups), refused because something it would put back was
 * changed since (`changed`: what), or no longer possible (`gone`).
 */
export type UndoResult = { ok: true; applied: number; commands: Command[] } | { ok: false; reason: 'changed'; changed: string[] } | { ok: false; reason: 'gone' };

/** How long, and how many, Undos are kept: a window offers one for eight seconds. */
const UNDO_KEEP_MS = 60_000;
const UNDO_KEEP_MAX = 50;

/** Told after events are written here, with the state before and after them. */
export type PersistListener = (events: readonly PlannerEvent[], before: PlannerState, after: PlannerState) => void;

export interface Snapshot {
  state: PlannerState;
  today: DateKey | null;
  storage: { dir: string; git: boolean; lastCommitAt: string | null; lastError: string | null; skippedLines: number };
}

const summarize = (events: readonly PlannerEvent[], titleOf: (id: string) => string): string => {
  if (events.length > 1) return `${events.length} changes`;
  const event = events[0]!;
  switch (event.type) {
    case 'task.created': return `Add task: ${event.task.title}`;
    case 'task.updated': return `Edit task: ${titleOf(event.taskId)}`;
    case 'subtask.added': return `Add subtask: ${event.subtask.title} (${titleOf(event.taskId)})`;
    case 'subtask.updated': return `Edit subtask: ${titleOf(event.taskId)}`;
    case 'subtask.deleted': return `Delete subtask: ${titleOf(event.taskId)}`;
    case 'subtask.moved': return `Move subtask: ${titleOf(event.taskId)}`;
    case 'task.moved': return `Move task: ${titleOf(event.taskId)} → ${event.placement.kind === 'day' ? event.placement.date : event.placement.bucket}`;
    case 'task.completed': return `Complete task: ${titleOf(event.taskId)}`;
    case 'task.reopened': return `Reopen task: ${titleOf(event.taskId)}`;
    case 'task.deleted': return `Delete task: ${titleOf(event.taskId)}`;
    case 'task.restored': return `Restore task: ${titleOf(event.taskId)}`;
    case 'task.archived': return `Archive task: ${titleOf(event.taskId)}`;
    case 'task.sourceSynced': return `Sync ${event.source.key}: ${event.source.status?.name ?? ''}`.trim();
    case 'tasks.rolledOver': return `Roll over ${event.moved.length} tasks to ${event.date}${event.archived.length ? `, archive ${event.archived.length}` : ''}${event.superseded?.length ? `, replace ${event.superseded.length} repeats` : ''}`;
    case 'tasks.recurred': return `Create ${event.instances.length} recurring instances`;
    case 'series.created': return `Repeat: ${event.series.template.title}`;
    case 'series.updated': return 'Edit recurring task';
    case 'series.stopped': return `Stop repeating from ${event.from}`;
    case 'timer.started': return `Start timer: ${titleOf(event.taskId)}`;
    case 'timer.stopped': return 'Stop timer';
    case 'time.logged': return `Log time: ${titleOf(event.entry.taskId)}`;
    case 'time.deleted': return 'Delete time entry';
    case 'block.created': return `Timebox: ${titleOf(event.block.taskId)}`;
    case 'block.updated': return 'Move working session';
    case 'block.deleted': return 'Remove working session';
    case 'block.linked': return event.google ? 'Write a working session to Google Calendar' : 'Unlink a working session from Google Calendar';
    case 'objective.created': return `Add objective: ${event.objective.title}`;
    case 'objective.updated': return 'Edit objective';
    case 'objective.deleted': return 'Delete objective';
    case 'objective.restored': return 'Restore objective';
    case 'ritual.saved': return `Save ${event.ritual} for ${event.date}`;
    case 'calendar.added': return `Subscribe to calendar: ${event.calendar.name}`;
    case 'calendar.updated': return 'Edit calendar';
    case 'calendar.removed': return 'Remove calendar';
    case 'folder.created': return `Add folder: ${event.folder.name}`;
    case 'folder.renamed': return `Rename folder: ${event.name}`;
    case 'folder.deleted': return 'Delete folder';
    case 'run.started': return `${event.run.wantsPr ? 'Assign to agent' : 'Start agent'}: ${titleOf(event.run.taskId)}`;
    case 'run.outcome': return `Agent run ${event.outcome}`;
    case 'run.reviewed': return `Review agent run: ${event.verdict}`;
    case 'run.removed': return 'Unlink agent run';
    case 'run.pullRequest': return `Pull request ${event.pullRequest.repo}#${event.pullRequest.number} ${event.pullRequest.state}: ${titleOf(event.taskId)}`;
    case 'channel.created': return `Add channel: ${event.channel.name}`;
    case 'channel.updated': return `Edit channel: ${event.channelId}`;
    case 'channel.deleted': return `Delete channel: ${event.channelId}`;
    case 'settings.updated': return `Update settings: ${Object.keys(event.patch).join(', ')}`;
    case 'gtask.kept': return `Keep for a Google task: ${Object.keys(event.patch).join(', ')}`;
    case 'gtask.moved': return 'A Google task moved';
    case 'gtask.dropped': return 'Forget a Google task';
  }
};

/** Sunsama starts every account with a work and a personal channel. */
const DEFAULT_CHANNELS: EventBody[] = [
  { type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } },
  { type: 'channel.created', channel: { id: 'personal', name: 'personal', color: '#1c7ed6', context: 'personal' } },
];

export class Planner {
  state: PlannerState;
  private readonly applied = new Set<string>();
  /**
   * Batches that can be undone, by their first command: the commands that take
   * each back, against the plan as it was just before it, and the plan right
   * after it, which an Undo is checked against.
   */
  private readonly undos = new Map<string, { inverse: EventBody[]; after: PlannerState; at: number }>();
  private readonly log: PlannerEvent[];
  private lastAt = 0;
  private readonly persistListeners = new Set<PersistListener>();
  /** When the log was last read again after a merge brought in events from elsewhere. */
  reloadedAt = 0;

  constructor(private readonly store: EventStore, private readonly now: () => Date = () => new Date()) {
    const events = store.load();
    this.log = events;
    for (const event of events) {
      if (event.cmd) this.applied.add(event.cmd);
      this.lastAt = Math.max(this.lastAt, Date.parse(event.at) || 0);
    }
    this.state = foldEvents(events);
    // Only a brand-new log gets the defaults, so deleting them later sticks.
    if (events.length === 0) this.persist(DEFAULT_CHANNELS.map((body) => this.toEvent(body)));
  }

  today(): DateKey | null {
    const zone = this.state.settings.timezone;
    return zone ? todayIn(zone, this.now()) : null;
  }

  /** Bring yesterday's open work onto today; a no-op once done for the day. */
  ensureRollover(): void {
    const today = this.today();
    if (!today) return;
    const body = planRollover(this.state, today);
    if (body) this.persist([this.toEvent(body)]);
  }

  /** Create recurring instances from today through the horizon. */
  ensureRecurrence(): void {
    const today = this.today();
    if (!today) return;
    const instances = planInstances(this.state, today);
    if (instances.length) this.persist([this.toEvent({ type: 'tasks.recurred', instances })]);
  }

  snapshot(): Snapshot {
    // Instances first, so rollover can tell an old instance has a newer one today.
    this.ensureRecurrence();
    this.ensureRollover();
    return {
      state: this.state,
      today: this.today(),
      storage: {
        dir: this.store.dir,
        git: this.store.hasGit,
        lastCommitAt: this.store.lastCommitAt,
        lastError: this.store.lastError,
        skippedLines: this.store.skippedLines,
      },
    };
  }

  /**
   * Apply a batch atomically. Each command is validated against the state the
   * earlier ones produced, so one batch can create a task and then move it.
   * A command id seen before is skipped, which makes client retries safe.
   * With `undo`, what takes it back is kept, by its first command (`undo`).
   * A subtask command meeting a change made elsewhere since refuses the
   * batch with that conflict (`subtaskConflict`).
   */
  execute(commands: readonly unknown[], options: { undo?: boolean } = {}): ExecuteResult {
    const before = this.state;
    let working = this.state;
    const events: PlannerEvent[] = [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index] as Command;
      if (command && typeof command === 'object' && typeof command.cmd === 'string' && this.applied.has(command.cmd)) continue;
      const error = validateCommand(command, working);
      if (error) return { ok: false, error, index };
      const conflict = subtaskConflict(command, working);
      if (conflict) return { ok: false, error: SUBTASK_CHANGED, index, conflict };
      const event = this.toEvent(commandBody(command), command.cmd);
      events.push(event);
      working = applyEvents(working, [event]);
    }
    if (events.length) this.persist(events, working);
    if (options.undo && events.length) this.keepUndo((commands[0] as Command).cmd, before, events, working);
    return { ok: true, applied: events.length };
  }

  /**
   * Take back a batch run with `undo`, as one batch against the plan as it is
   * now, only if it changes nothing that was changed since the batch by
   * anyone else (`changedSince`): a field the batch set and someone has set
   * again since keeps their value, and nothing is written. A command of it
   * that is no longer valid (a working session deleted since), or that meets
   * a subtask deleted since, is a change since too. Once: kept no longer,
   * done or not.
   */
  undo(batch: string): UndoResult {
    const record = this.undos.get(batch);
    this.undos.delete(batch);
    if (!record || this.now().getTime() - record.at > UNDO_KEEP_MS) return { ok: false, reason: 'gone' };
    let working = this.state;
    const events: PlannerEvent[] = [];
    for (const body of record.inverse) {
      const command = { ...body, cmd: newId() } as Command;
      const error = validateCommand(command, working);
      if (error) return { ok: false, reason: 'changed', changed: [error] };
      const conflict = subtaskConflict(body, working);
      if (conflict) return { ok: false, reason: 'changed', changed: [`tasks/${conflict.taskId}/subtasks/${conflict.subtaskId}`] };
      const event = this.toEvent(body, command.cmd);
      events.push(event);
      working = applyEvents(working, [event]);
    }
    const changed = changedSince(record.after, this.state, working);
    if (changed.length) return { ok: false, reason: 'changed', changed };
    if (events.length) this.persist(events, working);
    return {
      ok: true,
      applied: events.length,
      commands: events.map(({ v: _v, id: _id, at: _at, ...command }) => command as Command),
    };
  }

  private keepUndo(batch: string, before: PlannerState, events: readonly PlannerEvent[], after: PlannerState): void {
    const now = this.now().getTime();
    for (const [key, record] of this.undos) if (now - record.at > UNDO_KEEP_MS || this.undos.size >= UNDO_KEEP_MAX) this.undos.delete(key);
    const inverse = inverseOfBatch(before, events);
    if (inverse) this.undos.set(batch, { inverse, after, at: now });
  }

  /** Read the whole log again, after a merge brought in events from another machine. */
  reload(): void {
    const events = this.store.load();
    this.log.length = 0;
    this.log.push(...events);
    this.applied.clear();
    for (const event of events) {
      if (event.cmd) this.applied.add(event.cmd);
      this.lastAt = Math.max(this.lastAt, Date.parse(event.at) || 0);
    }
    this.state = foldEvents(events);
    this.reloadedAt = Date.now();
  }

  /** Hear about events written here (not ones a merge brings in: their machine acts on them). */
  onPersist(listener: PersistListener): () => void {
    this.persistListeners.add(listener);
    return () => this.persistListeners.delete(listener);
  }

  /** The latest events that concern one task, oldest first. */
  activity(taskId: string, limit = 200): PlannerEvent[] {
    return this.log.filter((event) => touchesTask(event, taskId)).slice(-limit);
  }

  private persist(events: PlannerEvent[], next?: PlannerState): void {
    const before = this.state;
    this.store.append(events, summarize(events, (id) => (next ?? before).tasks[id]?.title ?? before.tasks[id]?.title ?? id));
    this.state = next ?? applyEvents(before, events);
    this.log.push(...events);
    for (const event of events) if (event.cmd) this.applied.add(event.cmd);
    for (const listener of this.persistListeners) {
      try {
        listener(events, before, this.state);
      } catch (error) {
        // A listener's trouble never undoes a write.
        console.error(`[planner] after a write: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Stamp an event; times strictly increase so (at, id) order equals write order. */
  private toEvent(body: EventBody, cmd?: string): PlannerEvent {
    const at = Math.max(this.now().getTime(), this.lastAt + 1);
    this.lastAt = at;
    return { v: 1, id: newId(at), at: new Date(at).toISOString(), ...(cmd ? { cmd } : {}), ...body } as PlannerEvent;
  }
}
