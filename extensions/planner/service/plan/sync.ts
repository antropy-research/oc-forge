// Sync the planner's git repository with a remote, for example a private
// GitHub repository, so several machines share one plan.
import type { EventStore } from './store.ts';
import type { Planner } from './planner.ts';

export interface SyncStatus {
  remote: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
}

/** A git remote we are willing to hand to `git`: https, ssh, scp-style, file, or an absolute path. Never an option. */
export const isRemoteUrl = (url: string): boolean => {
  if (!url || url.length > 500 || /\s/.test(url) || url.startsWith('-')) return false;
  return /^(https|ssh|git|file):\/\/\S+$/i.test(url) || /^[\w.-]+@[\w.-]+:[\w.~/-]+$/.test(url) || /^\/[^\0]+$/.test(url);
};

const AUTO_DELAY_MS = 15_000;
const PERIOD_MS = 5 * 60_000;

export class SyncManager {
  private remote: string | null = null;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private running: Promise<SyncStatus> | null = null;
  private lock: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: EventStore, private readonly planner: Planner, private readonly log: (message: string) => void = () => {}) {}

  async init(): Promise<void> {
    this.remote = await this.store.remoteUrl();
    if (this.remote) this.schedule(5_000);
    setInterval(() => {
      if (this.remote) void this.run().catch(() => undefined);
    }, PERIOD_MS).unref?.();
  }

  status(): SyncStatus {
    return { remote: this.remote, lastSyncAt: this.lastSyncAt, lastError: this.lastError, syncing: this.running !== null };
  }

  /** Resolves when no merge is rewriting the event files; commands wait on it. */
  idle(): Promise<void> {
    return this.lock ?? Promise.resolve();
  }

  /** Sync soon, after a quiet period (called after each commit). */
  schedule(delay = AUTO_DELAY_MS): void {
    if (!this.remote) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().catch(() => undefined);
    }, delay);
    this.timer.unref?.();
  }

  async setRemote(url: string | null): Promise<SyncStatus> {
    const clean = url?.trim() || null;
    if (clean && !isRemoteUrl(clean)) throw new Error('Use an https, ssh, git@host:path, file:// URL or an absolute path.');
    await this.store.setRemote(clean);
    this.remote = clean;
    this.lastError = null;
    this.lastSyncAt = null;
    if (clean) this.schedule(1_000);
    return this.status();
  }

  /**
   * Fetch and push outside the lock (they can be slow and do not touch the
   * files); commit, merge and reload inside it, so no command lands mid-merge.
   */
  run(): Promise<SyncStatus> {
    if (!this.remote) return Promise.reject(new Error('No sync remote is set.'));
    this.running ??= this.sync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sync(): Promise<SyncStatus> {
    try {
      await this.store.fetchRemote();
      let release!: () => void;
      this.lock = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await this.store.commitNow();
        if (await this.store.mergeRemote()) this.planner.reload();
      } finally {
        this.lock = null;
        release();
      }
      await this.store.pushRemote();
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 3).join(' ').slice(0, 400);
      this.log(`sync failed: ${this.lastError}`);
    }
    return { ...this.status(), syncing: false };
  }
}
