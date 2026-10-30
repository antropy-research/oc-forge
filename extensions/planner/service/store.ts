// Append-only event files in a git repository. Each write is fsynced before the
// request answers; commits are batched and only add history, never durability.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { PlannerEvent } from '../src/domain/events.ts';
import { sortEvents } from '../src/domain/reducer.ts';

export interface EventStoreOptions {
  dir: string;
  /** Keep history in git when the binary is available (default true). */
  git?: boolean;
  /** Quiet period before pending events are committed. */
  commitDelayMs?: number;
  log?: (message: string) => void;
  /** Called after each successful commit (to schedule a sync). */
  onCommit?: () => void;
  /** Loose git objects that make the history get packed (default 256); see `pack`. */
  packLooseObjects?: number;
  /** Commits between two checks for loose objects (default 20). */
  packCheckCommits?: number;
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

const README = `# Planner data

Written by the OpenChamber Planner extension. \`events/YYYY-MM.jsonl\` is an
append-only log of planner events, one JSON object per line; the planner's state
is a fold over all of them in (at, id) order. Lines from two replicas merge with
git's union driver, so a remote can be added later without conflicts.
`;

const isEventShape = (value: unknown): value is PlannerEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return event.v === 1 && typeof event.id === 'string' && typeof event.at === 'string' && typeof event.type === 'string';
};

export class EventStore {
  readonly dir: string;
  private readonly eventsDir: string;
  private readonly commitDelayMs: number;
  private readonly log: (message: string) => void;
  private gitEnabled = false;
  private gitChain: Promise<unknown> = Promise.resolve();
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSummaries: string[] = [];
  private commitsSincePackCheck = 0;
  lastCommitAt: string | null = null;
  lastError: string | null = null;
  skippedLines = 0;

  constructor(private readonly options: EventStoreOptions) {
    this.dir = options.dir;
    this.eventsDir = join(options.dir, 'events');
    this.commitDelayMs = options.commitDelayMs ?? 1500;
    this.log = options.log ?? (() => {});
  }

  get hasGit(): boolean {
    return this.gitEnabled;
  }

  async init(): Promise<void> {
    mkdirSync(this.eventsDir, { recursive: true });
    if (this.options.git !== false) this.gitEnabled = await this.ensureRepo();
    if (this.gitEnabled) void this.pack();
  }

  load(): PlannerEvent[] {
    const events: PlannerEvent[] = [];
    this.skippedLines = 0;
    for (const file of readdirSync(this.eventsDir).filter((name) => MONTH_FILE.test(name)).sort()) {
      for (const line of readFileSync(join(this.eventsDir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isEventShape(parsed)) events.push(parsed);
          else this.skippedLines++;
        } catch {
          // A torn last line from a crash, or a bad merge; the rest of the log still loads.
          this.skippedLines++;
        }
      }
    }
    if (this.skippedLines) this.log(`skipped ${this.skippedLines} unreadable event lines`);
    return sortEvents(events);
  }

  /** Durably append events, then schedule a commit. */
  append(events: readonly PlannerEvent[], summary: string): void {
    const byFile = new Map<string, string>();
    for (const event of events) {
      const file = `${event.at.slice(0, 7)}.jsonl`;
      byFile.set(file, (byFile.get(file) ?? '') + JSON.stringify(event) + '\n');
    }
    for (const [file, text] of byFile) {
      const fd = openSync(join(this.eventsDir, file), 'a');
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.pendingSummaries.push(summary);
    this.scheduleCommit();
  }

  /** Commit anything pending now; used on shutdown and by tests. */
  async flush(): Promise<void> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
      await this.commit();
    }
    await this.gitChain;
  }

  private scheduleCommit(): void {
    if (!this.gitEnabled) return;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.commit();
    }, this.commitDelayMs);
  }

  private async commit(): Promise<void> {
    const summaries = this.pendingSummaries.splice(0);
    if (!this.gitEnabled || summaries.length === 0) return;
    const message = summaries.length === 1 ? summaries[0]! : `${summaries.length} planner changes\n\n${summaries.map((line) => `- ${line}`).join('\n')}`;
    try {
      await this.git(['add', 'events']);
      await this.git(['commit', '-q', '-m', message]);
      this.lastCommitAt = new Date().toISOString();
      this.lastError = null;
      this.options.onCommit?.();
      if (++this.commitsSincePackCheck >= (this.options.packCheckCommits ?? 20)) {
        this.commitsSincePackCheck = 0;
        void this.pack();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/nothing to commit/.test(text)) {
        this.lastError = text.slice(0, 500);
        this.log(`git commit failed: ${this.lastError}`);
      }
    }
  }

  /** The `origin` remote, or null when none is set. */
  async remoteUrl(): Promise<string | null> {
    if (!this.gitEnabled) return null;
    try {
      return (await this.git(['remote', 'get-url', 'origin'])).trim() || null;
    } catch {
      return null;
    }
  }

  async setRemote(url: string | null): Promise<void> {
    if (!this.gitEnabled) throw new Error('git is not available on this machine');
    const current = await this.remoteUrl();
    if (!url) {
      if (current) await this.git(['remote', 'remove', 'origin']);
      return;
    }
    await this.git(current ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  }

  /** Commit what is pending right away (before a merge rewrites the files). */
  async commitNow(): Promise<void> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    await this.commit();
    await this.gitChain;
  }

  fetchRemote(): Promise<string> {
    return this.git(['fetch', '--quiet', 'origin'], 120_000);
  }

  /**
   * Merge `origin/main` into the local history. Event files merge by git's
   * union driver (one event per line); any other conflicting file keeps the
   * local copy. Returns whether anything new came in.
   */
  async mergeRemote(): Promise<boolean> {
    const remote = (await this.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).catch(() => '')).trim();
    if (!remote) return false;
    const before = (await this.git(['rev-parse', 'HEAD'])).trim();
    try {
      await this.git(['merge', '--quiet', '--no-edit', '--allow-unrelated-histories', '-m', 'Merge planner data from origin', 'refs/remotes/origin/main']);
    } catch (error) {
      const conflicted = (await this.git(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      if (conflicted.length === 0 || conflicted.some((file) => file.startsWith('events/'))) {
        await this.git(['merge', '--abort']).catch(() => undefined);
        throw error;
      }
      await this.git(['checkout', '--ours', '--', ...conflicted]);
      await this.git(['add', '--', ...conflicted]);
      await this.git(['commit', '--quiet', '--no-edit']);
    }
    return (await this.git(['rev-parse', 'HEAD'])).trim() !== before;
  }

  pushRemote(): Promise<string> {
    return this.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], 120_000);
  }

  private git(args: string[], timeout = 30_000): Promise<string> {
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          ['-c', 'user.name=OpenChamber Planner', '-c', 'user.email=planner@localhost', '-c', 'commit.gpgsign=false', ...args],
          { cwd: this.dir, timeout },
          (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}${stdout}`)) : resolve(stdout)),
        );
      });
    const next = this.gitChain.then(run, run);
    this.gitChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Keep the history packed. Every commit adds a few loose objects, and git
   * packs on its own (`gc --auto`) only past about 6,700, which it estimates
   * from a sample: a busy plan reached 1,100 commits and 285 MB of loose
   * objects (4.9 MB once packed), and a first push to a new sync remote no
   * longer fit in the time OpenChamber waits for an answer. So the loose
   * objects are counted exactly, at start and every few commits, and packed
   * past a small number; `gc --auto` then merges the packs once there are many.
   */
  private async pack(): Promise<void> {
    try {
      const count = Number(/^count: (\d+)$/m.exec(await this.git(['count-objects', '-v']))?.[1] ?? 0);
      if (count < (this.options.packLooseObjects ?? 256)) return;
      await this.git(['repack', '-d', '-q'], 120_000);
      await this.git(['-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet'], 120_000);
    } catch (error) {
      this.log(`git pack failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }

  private async ensureRepo(): Promise<boolean> {
    try {
      await this.git(['--version']);
    } catch {
      this.log('git not found; events are stored without history');
      return false;
    }
    if (existsSync(join(this.dir, '.git'))) return true;
    try {
      await this.git(['init', '-q', '-b', 'main']);
      writeFileSync(join(this.dir, '.gitattributes'), 'events/*.jsonl merge=union\n');
      writeFileSync(join(this.dir, 'README.md'), README);
      await this.git(['add', '-A']);
      await this.git(['commit', '-q', '-m', 'Initialize planner data']);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`git init failed: ${this.lastError}`);
      return false;
    }
  }
}
