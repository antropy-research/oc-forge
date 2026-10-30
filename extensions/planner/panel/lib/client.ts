// Panel-side planner client: talks to the local service and keeps an optimistic view.
// Commands apply locally through the same reducer the service uses, then the
// service's answer replaces the view, so the UI never waits on a round trip.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import type { Command, EventBody, PlannerEvent } from '../../src/domain/events.ts';
import { applyEvents } from '../../src/domain/reducer.ts';
import { CHANGED_SINCE, asEvents, changedSince, inverseOfBatch } from '../../src/domain/undo.ts';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { GoogleTaskItem } from '../../src/domain/google.ts';
import { todayIn } from '../../src/domain/dates.ts';
import { newId } from '../../src/domain/ids.ts';
import { DEFAULT_SETTINGS, emptyState, type DateKey, type PlannerState } from '../../src/domain/types.ts';

export interface StorageInfo {
  dir: string;
  git: boolean;
  lastCommitAt: string | null;
  lastError: string | null;
  skippedLines: number;
}

export interface SyncStatus {
  remote: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
}

export interface Snapshot {
  state: PlannerState;
  today: DateKey | null;
  storage: StorageInfo;
  sync?: SyncStatus;
}

/** Why the service cannot answer, in terms the user can act on. */
export type ServiceProblem = 'not-approved' | 'disabled' | 'failed' | 'unavailable';

export interface ClientView {
  loaded: boolean;
  problem: ServiceProblem | null;
  error: string | null;
  state: PlannerState;
  today: DateKey;
  storage: StorageInfo | null;
  sync: SyncStatus | null;
  saving: boolean;
  /** Label of the last undoable action, while it can still be undone. */
  undoLabel: string | null;
}

export interface DispatchOptions {
  /**
   * Offer Undo for this batch with this label (e.g. "Task deleted"). The
   * service keeps what takes it back and undoes it only while nobody has
   * changed since what it would put back (`undo`).
   */
  undo?: string;
  /**
   * Who caused the batch. `linear` marks changes that came from Linear, so they
   * are not sent back; `agent` marks facts observed about agent sessions. Only
   * a user's batch reports a failure; automation that loses a race with another
   * surface just reloads.
   */
  origin?: Origin;
}

export type Origin = 'user' | 'linear' | 'github' | 'google' | 'agent';

/** Called after the service accepted a batch, with the confirmed state before and after it. */
export type CommitListener = (commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin) => void;

const POLL_MS = 5000;
/** A sync the service answered as still running is followed every two seconds, for up to five minutes. */
const SYNC_FOLLOW_MS = 2000;
const SYNC_FOLLOW_CHECKS = 150;

const UNDO_WINDOW_MS = 8000;

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const problemOf = (error: unknown): ServiceProblem => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE') return 'not-approved';
    if (error.code === 'DISABLED') return 'disabled';
    if (error.code === 'SERVICE_FAILED') return 'failed';
  }
  return 'unavailable';
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class PlannerClient {
  private view: ClientView;
  private readonly listeners = new Set<() => void>();
  private confirmed: PlannerState = emptyState();
  private pending: Command[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** The batch the toast's Undo takes back (its first command), and what takes it back as this window sees it. */
  private undoOffer: { batch: string; inverse: EventBody[] } | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly commitListeners = new Set<CommitListener>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: HostClient) {
    this.view = {
      loaded: false,
      problem: null,
      error: null,
      state: this.confirmed,
      today: todayIn(browserZone()),
      storage: null,
      sync: null,
      saving: false,
      undoLabel: null,
    };
  }

  getView = (): ClientView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    try {
      this.accept(await this.request<Snapshot>('GET', '/state'));
      // The service decides "today" in the user's zone; tell it which zone that is.
      if (!this.confirmed.settings.timezone) await this.dispatch([{ type: 'settings.updated', patch: { timezone: browserZone() } }]);
    } catch (error) {
      this.set({ problem: problemOf(error), error: messageOf(error) });
    }
  }

  /** Apply now, persist in order. Resolves when the service has answered. */
  dispatch(bodies: EventBody[], options: DispatchOptions = {}): Promise<void> {
    if (bodies.length === 0) return this.queue;
    const commands = bodies.map((body) => ({ ...body, cmd: newId() }) as Command);
    const before = this.view.state;
    const offered = options.undo ? inverseOfBatch(before, bodies) : null;
    if (options.undo && offered) this.offerUndo(options.undo, { batch: commands[0]!.cmd, inverse: offered });
    this.pending = [...this.pending, ...commands];
    this.recompute();
    // This window changing again what its Undo would put back (the same task moved again): that Undo goes, as it would
    // be refused, so its toast never says another window did it. Automation (a sync) never ends it.
    if (!offered && this.undoOffer && (options.origin ?? 'user') === 'user') {
      const after = this.view.state;
      if (changedSince(before, after, applyEvents(after, asEvents(this.undoOffer.inverse))).length) this.clearUndo();
    }
    this.queue = this.queue.then(() => this.send(commands, options.origin ?? 'user', Boolean(offered)));
    return this.queue;
  }

  onCommitted(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /**
   * Follow changes made elsewhere (another surface, another window, midnight):
   * a cheap version check, and a full reload only when something changed.
   */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.view.loaded || this.pending.length > 0 || document.hidden) return;
    try {
      const health = await this.request<{ version: number; today: DateKey | null }>('GET', '/health');
      const stale = health.version !== this.confirmed.version || (health.today !== null && health.today !== this.view.today);
      if (stale && this.pending.length === 0) this.accept(await this.request<Snapshot>('GET', '/state'));
    } catch {
      // The next command or reload reports a real problem.
    }
  }

  /**
   * Reverse the last undoable batch, as the service decides against its plan
   * as it is then, in its turn after this window's batches on their way:
   * undone, or, when something it would put back was changed since in another
   * window, left as it is ("Changed in another window since; not undone").
   */
  undo(): Promise<void> {
    const offer = this.undoOffer;
    this.clearUndo();
    if (!offer) return this.queue;
    this.queue = this.queue.then(() => this.sendUndo(offer.batch));
    return this.queue;
  }

  clearUndo(): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
    this.undoOffer = null;
    if (this.view.undoLabel) this.set({ undoLabel: null });
  }

  /**
   * The plan as the service has it now: this window's view moves on to it (a
   * change made in another window since it last looked included), in its
   * turn after this window's batches on their way.
   */
  async refresh(): Promise<PlannerState> {
    await this.adopt(await this.request<Snapshot>('GET', '/state'));
    return this.view.state;
  }

  /** A raw call to the local service, for modules with their own endpoints. */
  call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
  }

  /**
   * The plan a service route answered with after changing it itself (a
   * repeating Google task's series, changed there for every window at once):
   * taken in its turn after this window's batches on their way, unless one of
   * their answers brought a later plan already.
   */
  adopt(snapshot: Snapshot): Promise<void> {
    this.queue = this.queue.then(() => {
      if (snapshot.state && snapshot.state.version >= this.confirmed.version) this.accept(snapshot);
    });
    return this.queue;
  }

  /** Set (or clear) the git remote the planner data syncs with. */
  async setRemote(remote: string | null): Promise<void> {
    const status = await this.request<SyncStatus>('PUT', '/sync', { remote });
    this.set({ sync: status });
  }

  /** Sync with the remote now; merged events from other machines come back in the snapshot. */
  async syncNow(): Promise<void> {
    if (this.view.sync) this.set({ sync: { ...this.view.sync, syncing: true } });
    const answer = await this.request<Snapshot & { status: SyncStatus }>('POST', '/sync');
    this.accept(answer);
    this.set({ sync: answer.status });
    // The service answers before a long sync ends (a first push of a long history): follow it to its end, then take
    // what it merged.
    for (let check = 0; check < SYNC_FOLLOW_CHECKS && this.view.sync?.syncing; check++) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_FOLLOW_MS));
      const status = await this.request<SyncStatus>('GET', '/sync').catch(() => null);
      if (!status) continue;
      if (!status.syncing) this.accept(await this.request<Snapshot>('GET', '/state'));
      this.set({ sync: status });
    }
  }

  /** Occurrences from the subscribed calendars for [from, to]. */
  /** Events between two days, and the Google tasks read for a deadline in them. */
  async calendarEvents(from: DateKey, to: DateKey, refresh = false): Promise<{ events: CalendarEvent[]; deadlineTasks?: GoogleTaskItem[]; errors: { calendarId: string; message: string }[] }> {
    return this.request('GET', `/calendar?from=${from}&to=${to}${refresh ? '&refresh=1' : ''}`);
  }

  /** The task's history from the event log, oldest first. */
  async activity(taskId: string): Promise<PlannerEvent[]> {
    const result = await this.request<{ events: PlannerEvent[] }>('GET', `/activity?task=${encodeURIComponent(taskId)}`);
    return result.events;
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** Show a short message in the toast slot; unlike errors, it goes away on its own. */
  notify(message: string): void {
    this.set({ error: message });
    setTimeout(() => {
      if (this.view.error === message) this.set({ error: null });
    }, 6000);
  }

  private offerUndo(label: string, offer: { batch: string; inverse: EventBody[] }): void {
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoOffer = offer;
    this.undoTimer = setTimeout(() => this.clearUndo(), UNDO_WINDOW_MS);
    this.set({ undoLabel: label });
  }

  private async send(commands: Command[], origin: Origin, undoable = false): Promise<void> {
    this.set({ saving: true });
    try {
      const snapshot = await this.request<Snapshot>('POST', '/commands', { commands, ...(undoable ? { undo: true } : {}) });
      this.pending = this.pending.filter((command) => !commands.includes(command));
      const before = this.confirmed;
      this.accept(snapshot);
      for (const listener of this.commitListeners) {
        try {
          listener(commands, before, this.confirmed, origin);
        } catch (error) {
          console.error('[planner] commit listener failed', error);
        }
      }
    } catch (error) {
      // Drop the optimistic change and show what the service actually has; nothing was done, so nothing to undo.
      this.pending = this.pending.filter((command) => !commands.includes(command));
      if (this.undoOffer?.batch === commands[0]?.cmd) this.clearUndo();
      this.recompute();
      if (origin === 'user') this.set({ error: messageOf(error), ...(error instanceof HostRequestError ? { problem: problemOf(error) } : {}) });
      else console.warn(`[planner] ${origin} update skipped: ${messageOf(error)}`);
      await this.load();
    } finally {
      this.set({ saving: this.pending.length > 0 });
    }
  }

  /**
   * The service's Undo of a batch: done, the plan after it (and this window's
   * follow-ups, as for any change of the user's: Google and Linear hear of a
   * task reopened); refused, what it says shows and the plan as it is (theirs
   * included) replaces the view.
   */
  private async sendUndo(batch: string): Promise<void> {
    this.set({ saving: true });
    try {
      const response = await this.host.serviceRequest({ method: 'POST', path: '/undo', body: JSON.stringify({ batch }) });
      const data = (response.body ? JSON.parse(response.body) : {}) as Partial<Snapshot> & { commands?: Command[]; error?: string };
      if (response.status === 200 && data.state) {
        const before = this.confirmed;
        this.accept(data as Snapshot);
        for (const listener of this.commitListeners) {
          try {
            listener(data.commands ?? [], before, this.confirmed, 'user');
          } catch (error) {
            console.error('[planner] commit listener failed', error);
          }
        }
        return;
      }
      if (data.state) this.accept(data as Snapshot);
      if (response.status === 409 || response.status === 410) this.notify(data.error ?? CHANGED_SINCE);
      else this.set({ error: data.error ?? `Planner service answered ${response.status}` });
    } catch (error) {
      this.set({ error: messageOf(error), ...(error instanceof HostRequestError ? { problem: problemOf(error) } : {}) });
    } finally {
      this.set({ saving: this.pending.length > 0 });
    }
  }

  private accept(snapshot: Snapshot): void {
    // An older service (mid-update) may not know newer collections or settings yet.
    const fresh = emptyState();
    this.confirmed = { ...fresh, ...snapshot.state, settings: { ...DEFAULT_SETTINGS, ...snapshot.state.settings } };
    this.recompute({
      loaded: true,
      problem: null,
      today: snapshot.today ?? todayIn(snapshot.state.settings.timezone ?? browserZone()),
      storage: snapshot.storage,
      sync: snapshot.sync ?? null,
    });
  }

  private recompute(extra: Partial<ClientView> = {}): void {
    const now = new Date().toISOString();
    const synthetic = this.pending.map((command) => ({ v: 1, id: command.cmd, at: now, ...command }) as PlannerEvent);
    this.set({ ...extra, state: applyEvents(this.confirmed, synthetic) });
  }

  private set(patch: Partial<ClientView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.host.serviceRequest({ method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.body ? (JSON.parse(response.body) as T & { error?: string }) : ({} as T & { error?: string });
    if (response.status >= 400) throw new Error(data.error ?? `Planner service answered ${response.status}`);
    return data;
  }
}
