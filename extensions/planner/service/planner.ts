// The service's planner core: validate commands, turn them into events, persist, fold.
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { commandBody, validateCommand, type Command, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { planRollover } from '../src/domain/rollover.ts';
import { todayIn } from '../src/domain/dates.ts';
import { newId } from '../src/domain/ids.ts';
import type { DateKey, PlannerState } from '../src/domain/types.ts';
import type { EventStore } from './store.ts';

export type ExecuteResult = { ok: true; applied: number } | { ok: false; error: string; index: number };

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
    case 'task.moved': return `Move task: ${titleOf(event.taskId)} → ${event.placement.kind === 'day' ? event.placement.date : event.placement.bucket}`;
    case 'task.completed': return `Complete task: ${titleOf(event.taskId)}`;
    case 'task.reopened': return `Reopen task: ${titleOf(event.taskId)}`;
    case 'task.deleted': return `Delete task: ${titleOf(event.taskId)}`;
    case 'task.restored': return `Restore task: ${titleOf(event.taskId)}`;
    case 'task.archived': return `Archive task: ${titleOf(event.taskId)}`;
    case 'tasks.rolledOver': return `Roll over ${event.moved.length} tasks to ${event.date}${event.archived.length ? `, archive ${event.archived.length}` : ''}`;
    case 'channel.created': return `Add channel: ${event.channel.name}`;
    case 'channel.updated': return `Edit channel: ${event.channelId}`;
    case 'channel.deleted': return `Delete channel: ${event.channelId}`;
    case 'settings.updated': return `Update settings: ${Object.keys(event.patch).join(', ')}`;
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
  private lastAt = 0;

  constructor(private readonly store: EventStore, private readonly now: () => Date = () => new Date()) {
    const events = store.load();
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

  snapshot(): Snapshot {
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
   */
  execute(commands: readonly unknown[]): ExecuteResult {
    let working = this.state;
    const events: PlannerEvent[] = [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index] as Command;
      if (command && typeof command === 'object' && typeof command.cmd === 'string' && this.applied.has(command.cmd)) continue;
      const error = validateCommand(command, working);
      if (error) return { ok: false, error, index };
      const event = this.toEvent(commandBody(command), command.cmd);
      events.push(event);
      working = applyEvents(working, [event]);
    }
    if (events.length) this.persist(events, working);
    return { ok: true, applied: events.length };
  }

  private persist(events: PlannerEvent[], next?: PlannerState): void {
    const before = this.state;
    this.store.append(events, summarize(events, (id) => (next ?? before).tasks[id]?.title ?? before.tasks[id]?.title ?? id));
    this.state = next ?? applyEvents(before, events);
    for (const event of events) if (event.cmd) this.applied.add(event.cmd);
  }

  /** Stamp an event; times strictly increase so (at, id) order equals write order. */
  private toEvent(body: EventBody, cmd?: string): PlannerEvent {
    const at = Math.max(this.now().getTime(), this.lastAt + 1);
    this.lastAt = at;
    return { v: 1, id: newId(at), at: new Date(at).toISOString(), ...(cmd ? { cmd } : {}), ...body } as PlannerEvent;
  }
}
