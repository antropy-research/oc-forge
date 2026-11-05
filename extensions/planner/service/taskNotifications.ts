// Google Calendar's task notifications, given by the Planner (Google gets no
// time or deadline the Planner keeps, so its own apps cannot give these): the
// panel's open surfaces ask, every minute and at the next one's time, and get
// each notification once, whichever asks first, in any window. A surface that
// takes some says when it has shown them (`ack`); until then they are lent to
// it for LEASE_MS and nobody else gets them, and one never shown (its frame
// went: the Work Status card hides while the right panel is open) comes to the
// next surface that asks. What was shown is kept a few days beside the data
// (never in its synced repository), so a reload or a restart does not give one
// again; one missed while no Planner surface was open comes when one opens,
// the same day. One that comes while a
// task with Do not disturb is on waits until that task ends, past midnight too
// (a task that runs to midnight holds the last ones of its day until then).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DateKey, PlannerState } from '../src/domain/types.ts';
import { addDays, instantAt, todayIn } from '../src/domain/dates.ts';
import { deadlineGroups } from '../src/domain/gtaskKept.ts';
import { dueNotifications, nextNotificationAt, taskNotifications, type TaskNotification } from '../src/domain/gtaskNotify.ts';
import { quietNotifications, taskWindows } from '../src/domain/gtaskAdvanced.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';

/** How long a given notification is remembered: past its day, whatever the zone. */
const KEEP_MS = 3 * 24 * 60 * 60_000;
/** How long the surface that took a notification has to show it, before another may. */
export const LEASE_MS = 20_000;
/** At most this many acknowledged at once, each a key of at most this many characters. */
export const ACK_LIMITS = { keys: 200, key: 300 } as const;

export interface NotificationReads {
  /** The accounts that have Google Tasks. */
  accounts(): Promise<string[]>;
  /** Tasks due between two days (inclusive) in those accounts, completed ones too. */
  due(accounts: readonly string[], from: DateKey, to: DateKey): Promise<{ items: GoogleTaskItem[]; errors: string[] }>;
  /** Tasks by id, for the deadlines kept on `date`. */
  byIds(groups: readonly { account: string; listId: string; ids: string[] }[]): Promise<{ items: GoogleTaskItem[]; errors: string[] }>;
}

export interface TakenNotifications {
  notifications: TaskNotification[];
  /** When the next one comes today; null when none is left (or they are off). */
  next: string | null;
  /** In how many milliseconds, by this machine's clock (the browser's may differ). */
  nextIn: number | null;
  errors: string[];
}

export class TaskNotifications {
  /** Shown notifications, by key, with when they were acknowledged. */
  private given: Map<string, number> | null = null;
  /** Taken and not yet acknowledged, by key, with until when (in memory: a restart lends them again). */
  private readonly lent = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly state: () => PlannerState,
    private readonly reads: NotificationReads,
    private readonly now: () => number = Date.now,
  ) {}

  /** The notifications come by now that no surface has had yet, now lent to the caller; one take at a time, so none comes twice. */
  take(): Promise<TakenNotifications> {
    const next = this.queue.then(() => this.takeNow());
    this.queue = next.catch(() => {});
    return next;
  }

  /** The caller has shown these: they are given, for good. */
  ack(keys: readonly string[]): Promise<void> {
    const next = this.queue.then(async () => {
      const given = await this.load();
      const now = this.now();
      let changed = false;
      for (const key of keys) {
        this.lent.delete(key);
        if (!given.has(key)) {
          given.set(key, now);
          changed = true;
        }
      }
      if (changed) await this.save(given, now);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async takeNow(): Promise<TakenNotifications> {
    const state = this.state();
    const none = { notifications: [], next: null, nextIn: null, errors: [] };
    if (!state.settings.googleTaskNotifications) return none;
    const accounts = await this.reads.accounts();
    if (!accounts.length) return none;
    const zone = state.settings.timezone ?? 'UTC';
    const today = todayIn(zone, new Date(this.now()));
    // Yesterday's tasks too, for the ones Do not disturb held until midnight: they come today.
    const yesterday = addDays(today, -1);
    const [due, deadlines] = await Promise.all([this.reads.due(accounts, yesterday, today), this.reads.byIds(deadlineGroups(state.googleTasks, accounts, yesterday, today))]);
    const kept = this.state().googleTasks;
    // Do not disturb: what comes during a task with it on waits until the task ends.
    const windows = taskWindows(due.items, kept, yesterday, today, today, zone);
    const midnight = Date.parse(instantAt(today, 0, zone));
    const held = quietNotifications(taskNotifications(due.items, deadlines.items, kept, yesterday, zone), windows).filter((item) => item.held && Date.parse(item.at) >= midnight);
    const all = [...held, ...quietNotifications(taskNotifications(due.items, deadlines.items, kept, today, zone), windows)].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
    const given = await this.load();
    const now = this.now();
    for (const [key, until] of this.lent) if (until <= now) this.lent.delete(key);
    const keys = new Set([...given.keys(), ...this.lent.keys()]);
    const fresh = dueNotifications(all, now, keys);
    for (const item of fresh) this.lent.set(item.key, now + LEASE_MS);
    const next = nextNotificationAt(all, now, keys);
    return { notifications: fresh, next, nextIn: next ? Date.parse(next) - now : null, errors: [...due.errors, ...deadlines.errors] };
  }

  private async load(): Promise<Map<string, number>> {
    if (this.given) return this.given;
    const given = new Map<string, number>();
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { given?: Record<string, unknown> };
      for (const [key, at] of Object.entries(parsed.given ?? {})) if (typeof at === 'number') given.set(key, at);
    } catch {
      // None given yet, or a file that does not read: start again (at worst, today's come once more).
    }
    this.given = given;
    return given;
  }

  private async save(given: Map<string, number>, now: number): Promise<void> {
    for (const [key, at] of given) if (now - at > KEEP_MS) given.delete(key);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, given: Object.fromEntries(given) })}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}
