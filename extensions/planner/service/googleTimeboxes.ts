// Google Calendar beside the plan: the events of the Google calendars shown in
// the Planner, and working sessions as events, both ways. With a calendar
// chosen in the settings, each working session becomes an event there, keyed
// back to the session, and moves, renames and goes with it; when the calendar
// is next read, an event moved or deleted in Google moves or deletes its session.
import type { CalendarEvent } from '../src/domain/ics.ts';
import type { EventBody } from '../src/domain/events.ts';
import type { CalendarSubscription, GoogleEventLink, PlannerState } from '../src/domain/types.ts';
import { newId } from '../src/domain/ids.ts';
import { GoogleError } from './google.ts';
import type { GoogleData, TimeboxEvent } from './googleData.ts';
import type { ExecuteResult, PersistListener } from './planner.ts';

/** A working session's event, as read from its calendar. */
export interface SessionEvent {
  blockId: string;
  eventId: string;
  start: string;
  end: string;
}

/** What one Google calendar held between two instants, and when it was read. */
export interface CalendarRead {
  sessions: SessionEvent[];
  readAt: number;
}

export const calendarKey = (account: string, calendarId: string): string => `${account}\n${calendarId}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isGone = (error: unknown): boolean => error instanceof GoogleError && error.status === 404;

/** The host restarts a service that takes 20 seconds to answer; a slow calendar gives up first. */
const READ_DEADLINE_MS = 14_000;
/** A write that ended after a read began, give or take this, makes that read too old for its session. */
const SLACK_MS = 10_000;
const MAX_LOOKUPS = 10;

const withDeadline = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took too long to answer`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Reads Google calendars for the calendar view, keeping each read a short while. */
export class GoogleCalendars {
  private readonly cache = new Map<string, { at: number; events: CalendarEvent[]; sessions: SessionEvent[] }>();

  constructor(private readonly data: Pick<GoogleData, 'events'>, private readonly ttlMs = 90_000) {}

  /**
   * Events of the visible Google calendars between two instants, and the
   * session events of those and of `alsoRead` (the calendar sessions are
   * written to, and those linked sessions are in).
   */
  async read(
    subscriptions: readonly CalendarSubscription[],
    alsoRead: readonly { account: string; calendarId: string }[],
    timeMin: string,
    timeMax: string,
    zone: string,
    refresh: boolean,
  ): Promise<{ events: CalendarEvent[]; errors: { calendarId: string; message: string }[]; reads: Map<string, CalendarRead> }> {
    const targets = new Map<string, { account: string; calendarId: string; subscriptionId: string | null }>();
    for (const subscription of subscriptions) {
      if (!subscription.visible || !subscription.google) continue;
      const key = calendarKey(subscription.google.account, subscription.google.calendarId);
      if (!targets.has(key)) targets.set(key, { ...subscription.google, subscriptionId: subscription.id });
    }
    for (const extra of alsoRead) {
      const key = calendarKey(extra.account, extra.calendarId);
      if (!targets.has(key)) targets.set(key, { ...extra, subscriptionId: null });
    }
    const events: CalendarEvent[] = [];
    const errors: { calendarId: string; message: string }[] = [];
    const reads = new Map<string, CalendarRead>();
    await Promise.all(
      [...targets].map(async ([key, target]) => {
        const cacheKey = `${key}\n${target.subscriptionId ?? ''}\n${timeMin}\n${timeMax}\n${zone}`;
        let hit = this.cache.get(cacheKey);
        if (!hit || refresh || Date.now() - hit.at > this.ttlMs) {
          const at = Date.now();
          try {
            const read = await withDeadline(this.data.events(target.account, target.calendarId, timeMin, timeMax, zone, target.subscriptionId ?? key), READ_DEADLINE_MS, 'Google Calendar');
            hit = { at, ...read };
            this.cache.set(cacheKey, hit);
          } catch (error) {
            if (target.subscriptionId) errors.push({ calendarId: target.subscriptionId, message: messageOf(error) });
            return;
          }
        }
        reads.set(key, { sessions: hit.sessions, readAt: hit.at });
        if (target.subscriptionId) events.push(...hit.events);
      }),
    );
    return { events, errors, reads };
  }

  /** Forget what was read, as after a session was written: the next read asks Google again. */
  forget(): void {
    this.cache.clear();
  }
}

/** The Planner, as far as the sessions need it. */
export interface TimeboxPlanner {
  readonly state: PlannerState;
  readonly reloadedAt: number;
  onPersist(listener: PersistListener): () => void;
  execute(commands: readonly unknown[]): ExecuteResult;
}

export type TimeboxData = Pick<GoogleData, 'putTimebox' | 'deleteTimebox' | 'event'>;

export class GoogleTimeboxes {
  private readonly queues = new Map<string, Promise<void>>();
  /** When each session was last written to Google from here. */
  private readonly written = new Map<string, number>();
  /** Events made for sessions whose link is not in the log yet. */
  private readonly created = new Map<string, GoogleEventLink>();
  private internal = false;
  /** The last write that failed, until one works. */
  lastError: string | null = null;

  constructor(
    private readonly planner: TimeboxPlanner,
    private readonly data: TimeboxData,
    private readonly options: { idle?: () => Promise<void>; log?: (message: string) => void; onWrite?: () => void } = {},
  ) {
    planner.onPersist((_events, before, after) => {
      if (!this.internal) this.observe(before, after);
    });
  }

  /** Every write asked for so far is done (or failed). */
  async settled(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  /** The calendars linked sessions between two instants are in, plus the one new sessions go to. */
  calendarsFor(state: PlannerState, timeMin: string, timeMax: string): { account: string; calendarId: string }[] {
    const found = new Map<string, { account: string; calendarId: string }>();
    const target = state.settings.googleTimebox;
    if (target) found.set(calendarKey(target.account, target.calendarId), target);
    for (const block of Object.values(state.blocks)) {
      if (!block.google || block.start < timeMin || block.start >= timeMax) continue;
      found.set(calendarKey(block.google.account, block.google.calendarId), { account: block.google.account, calendarId: block.google.calendarId });
    }
    return [...found.values()];
  }

  /**
   * Bring linked sessions between `timeMin` and `timeMax` in step with their
   * events as read from Google. An event moved there moves its session; one
   * deleted there deletes it. An event missing from the read is asked for on
   * its own first: it may have moved out of the range.
   */
  async reconcile(reads: ReadonlyMap<string, CalendarRead>, timeMin: string, timeMax: string): Promise<number> {
    const state = this.planner.state;
    const bodies: EventBody[] = [];
    const missing: { blockId: string; link: GoogleEventLink; readAt: number }[] = [];
    for (const block of Object.values(state.blocks)) {
      const link = block.google;
      if (!link || block.start < timeMin || block.start >= timeMax) continue;
      const read = reads.get(calendarKey(link.account, link.calendarId));
      if (!read || this.busy(block.id, read.readAt)) continue;
      const session = read.sessions.find((item) => item.eventId === link.eventId);
      if (!session) missing.push({ blockId: block.id, link, readAt: read.readAt });
      else if (session.start !== block.start || session.end !== block.end) bodies.push({ type: 'block.updated', blockId: block.id, start: session.start, end: session.end });
    }
    await Promise.all(
      missing.slice(0, MAX_LOOKUPS).map(async ({ blockId, link }) => {
        let event: Awaited<ReturnType<TimeboxData['event']>>;
        try {
          event = await withDeadline(this.data.event(link.account, link.calendarId, link.eventId), READ_DEADLINE_MS, 'Google Calendar');
        } catch {
          // Could not tell; leave the session as it is.
          return;
        }
        if (!event) bodies.push({ type: 'block.deleted', blockId });
        else if (event.start?.dateTime && event.end?.dateTime) {
          const start = new Date(event.start.dateTime).toISOString();
          const end = new Date(event.end.dateTime).toISOString();
          const block = this.planner.state.blocks[blockId];
          if (block && (block.start !== start || block.end !== end)) bodies.push({ type: 'block.updated', blockId, start, end });
        }
      }),
    );
    const readAt = new Map([...reads].map(([key, read]) => [key, read.readAt]));
    let applied = 0;
    for (const body of bodies) {
      const blockId = (body as { blockId: string }).blockId;
      const block = this.planner.state.blocks[blockId];
      // Changed here while Google was being asked: the change here is newer.
      if (!block?.google || this.busy(blockId, readAt.get(calendarKey(block.google.account, block.google.calendarId)) ?? 0)) continue;
      if (await this.apply(body)) applied++;
    }
    return applied;
  }

  private busy(blockId: string, readAt: number): boolean {
    return this.queues.has(blockId) || (this.written.get(blockId) ?? 0) >= readAt - SLACK_MS || this.planner.reloadedAt >= readAt - SLACK_MS;
  }

  private observe(before: PlannerState, after: PlannerState): void {
    const target = after.settings.googleTimebox;
    const renamed = new Set(Object.values(after.tasks).filter((task) => before.tasks[task.id] && before.tasks[task.id]!.title !== task.title).map((task) => task.id));
    for (const block of Object.values(after.blocks)) {
      const previous = before.blocks[block.id];
      const moved = !previous || previous.start !== block.start || previous.end !== block.end;
      const linked = Boolean(block.google ?? this.created.get(block.id));
      if (linked ? moved || renamed.has(block.taskId) : Boolean(target) && moved) this.enqueue(block.id, () => this.write(block.id));
    }
    for (const previous of Object.values(before.blocks)) {
      if (after.blocks[previous.id]) continue;
      if (previous.google || this.created.has(previous.id) || this.queues.has(previous.id)) this.enqueue(previous.id, () => this.remove(previous.id, previous.google ?? null));
    }
  }

  private enqueue(blockId: string, job: () => Promise<void>): void {
    const next = (this.queues.get(blockId) ?? Promise.resolve()).then(job).then(
      () => {
        this.lastError = null;
      },
      (error) => {
        this.lastError = messageOf(error);
        this.options.log?.(`Google Calendar: ${this.lastError}`);
      },
    );
    this.queues.set(blockId, next);
    void next.then(() => {
      if (this.queues.get(blockId) === next) this.queues.delete(blockId);
    });
  }

  private async write(blockId: string): Promise<void> {
    const state = this.planner.state;
    const block = state.blocks[blockId];
    // Gone meanwhile; its removal comes next in the queue.
    if (!block) return;
    const link = block.google ?? this.created.get(blockId) ?? null;
    const target = link ?? state.settings.googleTimebox;
    if (!target) return;
    const timebox: TimeboxEvent = { blockId, taskId: block.taskId, title: state.tasks[block.taskId]?.title ?? 'Planner', start: block.start, end: block.end };
    let eventId: string;
    try {
      eventId = await this.data.putTimebox(target.account, target.calendarId, timebox, link?.eventId ?? null);
    } catch (error) {
      // Deleted in Google, then changed here: the change here is the newer word.
      if (!(link && isGone(error))) throw error;
      eventId = await this.data.putTimebox(target.account, target.calendarId, timebox, null);
    }
    this.written.set(blockId, Date.now());
    this.options.onWrite?.();
    if (link?.eventId === eventId) return;
    const fresh: GoogleEventLink = { account: target.account, calendarId: target.calendarId, eventId };
    this.created.set(blockId, fresh);
    // A session deleted while its event was being made keeps the link here, for its removal.
    if (this.planner.state.blocks[blockId] && (await this.apply({ type: 'block.linked', blockId, google: fresh }))) this.created.delete(blockId);
  }

  private async remove(blockId: string, link: GoogleEventLink | null): Promise<void> {
    const target = link ?? this.created.get(blockId);
    this.created.delete(blockId);
    this.written.delete(blockId);
    if (!target) return;
    await this.data.deleteTimebox(target.account, target.calendarId, target.eventId);
    this.options.onWrite?.();
  }

  /** Write what Google said into the log, without sending it back to Google. */
  private async apply(body: EventBody): Promise<boolean> {
    await this.options.idle?.();
    this.internal = true;
    try {
      const result = this.planner.execute([{ cmd: newId(), ...body }]);
      if (!result.ok) this.options.log?.(`Google Calendar: could not record ${body.type}: ${result.error}`);
      return result.ok;
    } finally {
      this.internal = false;
    }
  }
}
