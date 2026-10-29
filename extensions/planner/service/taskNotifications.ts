// Google Calendar's task notifications, given by the Planner (Google gets no
// time or deadline the Planner keeps, so its own apps cannot give these): the
// panel's open surfaces ask, every minute and at the next one's time, and get
// each notification once, whichever asks first, in any window. What was given
// is kept a few days beside the data (never in its synced repository), so a
// reload or a restart does not give one again; one missed while no Planner
// surface was open comes when one opens, the same day. One that comes while a
// task with Do not disturb is on waits until that task ends.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DateKey, PlannerState } from '../src/domain/types.ts';
import { todayIn } from '../src/domain/dates.ts';
import { deadlineGroups } from '../src/domain/gtaskKept.ts';
import { dueNotifications, nextNotificationAt, taskNotifications, type TaskNotification } from '../src/domain/gtaskNotify.ts';
import { quietNotifications, taskWindows } from '../src/domain/gtaskAdvanced.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';

/** How long a given notification is remembered: past its day, whatever the zone. */
const KEEP_MS = 3 * 24 * 60 * 60_000;

export interface NotificationReads {
  /** The accounts that have Google Tasks. */
  accounts(): Promise<string[]>;
  /** Tasks due on `date` in those accounts, completed ones too. */
  due(accounts: readonly string[], date: DateKey): Promise<{ items: GoogleTaskItem[]; errors: string[] }>;
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
  /** Given notifications, by key, with when they were given. */
  private given: Map<string, number> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly state: () => PlannerState,
    private readonly reads: NotificationReads,
    private readonly now: () => number = Date.now,
  ) {}

  /** The notifications come by now that no surface has had yet, now given; one take at a time, so none comes twice. */
  take(): Promise<TakenNotifications> {
    const next = this.queue.then(() => this.takeNow());
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
    const [due, deadlines] = await Promise.all([this.reads.due(accounts, today), this.reads.byIds(deadlineGroups(state.googleTasks, accounts, today, today))]);
    const kept = this.state().googleTasks;
    // Do not disturb: what comes during a task with it on waits until the task ends.
    const all = quietNotifications(taskNotifications(due.items, deadlines.items, kept, today, zone), taskWindows(due.items, kept, today, today, today, zone));
    const given = await this.load();
    const now = this.now();
    const keys = new Set(given.keys());
    const fresh = dueNotifications(all, now, keys);
    if (fresh.length) {
      for (const item of fresh) given.set(item.key, now);
      await this.save(given, now);
    }
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
