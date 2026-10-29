// Google Calendar's "Automatically decline meetings" for a task with a time
// set Busy (work and school accounts), done by the Planner: Google Calendar
// gets no time for a task the Planner times, so its own declining cannot.
// Every few minutes, and soon after such a task changes, the invitations on the
// account's own calendar that overlap the task's time (its upcoming
// occurrences' too, two weeks ahead) are answered "Declined" with the task's
// message, which Google sends the organizer, as Google Calendar does. A pass
// reads the account's own calendar once over all those times, page after page,
// and matches every task's times to it, so none is left out. It is bounded
// (pages read, time spent declining) to end well inside the host's 20 s; one
// that stops at a bound says where (`more`), and the next pass, a few seconds
// later, carries on from there. Each is declined once: one the user answers
// again afterwards stays as answered. What was declined is kept a month beside
// the data (never in its synced repository), to show in the task's details and
// not to decline it again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlannerState } from '../src/domain/types.ts';
import type { PlannerEvent } from '../src/domain/events.ts';
import { addDays, todayIn } from '../src/domain/dates.ts';
import type { GoogleResponse, GoogleTaskItem } from '../src/domain/google.ts';
import { meetingsToDecline, taskWindows, type DeclinedMeeting, type Invitation, type TaskWindow } from '../src/domain/gtaskAdvanced.ts';

/** How far ahead a task's meetings are declined: its times in the next two weeks; a later one's once it comes within them. */
export const DECLINE_AHEAD_DAYS = 14;
const EVERY_MS = 5 * 60_000;
const AFTER_CHANGE_MS = 1500;
/** A pass that stopped at a bound is followed this soon by one that carries on. */
const CARRY_ON_MS = 5000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
/** Pages of an account's calendar one pass reads at most (Google gives up to 2500 events a page). */
const PAGES_MAX = 4;
/**
 * A pass reads no further page and declines no further meeting after this long (each account gets its share), so
 * that it ends well inside the host's 20 s with another pass queued before it.
 */
const BUDGET_MS = 5000;

export interface DeclineReads {
  /** The work or school accounts with Google Calendar and Google Tasks. */
  accounts(): Promise<string[]>;
  /** Tasks by account, list and id, as Google has them now. */
  byIds(groups: readonly { account: string; listId: string; ids: string[] }[]): Promise<{ items: GoogleTaskItem[]; errors: string[] }>;
}

export interface DeclineCalendar {
  /** One page of the events on the account's own calendar between two instants, in the order they start. */
  invitationPage(account: string, timeMin: string, timeMax: string, pageToken?: string): Promise<{ items: Invitation[]; next: string | null }>;
  respond(account: string, calendarId: string, eventId: string, response: GoogleResponse, scope: 'this' | 'all', comment?: string): Promise<number>;
}

/** Where a pass stopped at one of its bounds, for an account: the meetings from `from` on are still to be looked at. */
export interface DeclineProgress {
  account: string;
  from: string;
}

export interface DeclinePass {
  declined: DeclinedMeeting[];
  errors: string[];
  /** The accounts whose meetings this pass did not get through: the next pass, a few seconds later, carries on. */
  more: DeclineProgress[];
}

/** Where an account's reading carries on: the range it was reading, from one of its pages. */
interface Cursor {
  timeMin: string;
  timeMax: string;
  /** The page to read first (undefined: the first). */
  page?: string;
  /** Where the meetings still to be looked at start, as the Planner says it. */
  from: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class MeetingDecliner {
  private queue: Promise<unknown> = Promise.resolve();
  /** The pass waiting for the running one, which any further caller shares. */
  private waiting: Promise<DeclinePass> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private declined: Map<string, DeclinedMeeting> | null = null;
  /** Accounts a pass stopped in, by account. */
  private readonly cursors = new Map<string, Cursor>();
  /** Meetings Google would not take a decline for in this round (account and event): tried again in the next one. */
  private readonly failed = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly state: () => PlannerState,
    private readonly reads: DeclineReads,
    private readonly calendar: DeclineCalendar,
    private readonly options: { log?: (message: string) => void; now?: () => number; onDeclined?: () => void; pagesMax?: number; budgetMs?: number; clock?: () => number } = {},
  ) {}

  /** Decline every few minutes, and soon after a task's time, availability or declining changes. */
  start(planner: { onPersist(listener: (events: readonly PlannerEvent[]) => void): unknown }): void {
    setInterval(() => this.soon(0), EVERY_MS).unref?.();
    planner.onPersist((events) => {
      if (events.some((event) => event.type === 'gtask.kept' && ['decline', 'time', 'duration', 'busy', 'repeat'].some((field) => field in event.patch))) {
        // Times changed: the next pass looks at all of them again, from the start.
        this.cursors.clear();
        this.failed.clear();
        this.soon(AFTER_CHANGE_MS);
      }
    });
    this.soon(AFTER_CHANGE_MS);
  }

  private soon(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().then(
        (pass) => {
          if (pass.errors.length) this.options.log?.(`declining meetings: ${pass.errors.join('; ')}`);
          for (const left of pass.more) this.options.log?.(`declining meetings: ${left.account}'s meetings from ${left.from} on come in the next pass`);
        },
        (error) => this.options.log?.(`declining meetings: ${messageOf(error)}`),
      );
    }, ms);
    this.timer.unref?.();
  }

  /** One pass after any running one (callers meanwhile share it): the meetings it declined. */
  run(): Promise<DeclinePass> {
    if (this.waiting) return this.waiting;
    const next = this.queue.then(() => {
      this.waiting = null;
      return this.runNow();
    });
    this.waiting = next;
    this.queue = next.catch(() => {});
    return next;
  }

  /** What was declined for a task, the latest first. */
  async declinedFor(account: string, taskId: string): Promise<DeclinedMeeting[]> {
    const declined = await this.load();
    return [...declined.values()].filter((entry) => entry.account === account && entry.taskId === taskId).sort((a, b) => b.at.localeCompare(a.at));
  }

  /** The time a pass's bound is measured in. */
  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }

  /** Where the account's meetings are still to be looked at, while a pass that stopped at a bound has more to do; else null. */
  progress(account: string): string | null {
    return this.cursors.get(account)?.from ?? null;
  }

  private async runNow(): Promise<DeclinePass> {
    const started = this.clock();
    const state = this.state();
    const kept = state.googleTasks;
    const wanted = Object.values(kept).filter((entry) => entry.time !== null && ((entry.busy && entry.decline) || (entry.repeat?.template?.busy && entry.repeat.template.decline && !entry.repeat.next)));
    const accounts = new Set(wanted.length ? await this.reads.accounts() : []);
    const groups = new Map<string, { account: string; listId: string; ids: string[] }>();
    for (const entry of wanted) {
      if (!accounts.has(entry.account)) continue;
      const key = `${entry.account}\n${entry.listId}`;
      const group = groups.get(key) ?? { account: entry.account, listId: entry.listId, ids: [] };
      group.ids.push(entry.taskId);
      groups.set(key, group);
    }
    if (!groups.size) {
      this.cursors.clear();
      return { declined: [], errors: [], more: [] };
    }
    const now = this.options.now?.() ?? Date.now();
    const zone = state.settings.timezone ?? 'UTC';
    const today = todayIn(zone, new Date(now));
    const read = await this.reads.byIds([...groups.values()]);
    const errors = [...read.errors];
    const byAccount = new Map<string, TaskWindow[]>();
    for (const window of taskWindows(read.items, this.state().googleTasks, today, addDays(today, DECLINE_AHEAD_DAYS), today, zone)) {
      if (window.decline && accounts.has(window.account) && Date.parse(window.end) > now) byAccount.set(window.account, [...(byAccount.get(window.account) ?? []), window]);
    }
    for (const account of [...this.cursors.keys()]) if (!byAccount.has(account)) this.cursors.delete(account);
    const declined = await this.load();
    const out: DeclinedMeeting[] = [];
    const more: DeclineProgress[] = [];
    const budget = this.options.budgetMs ?? BUDGET_MS;
    const order = [...byAccount.keys()];
    for (const [index, account] of order.entries()) {
      // Each account has its share of the pass's time; one that needs less leaves the rest to the next.
      const deadline = started + ((index + 1) * budget) / order.length;
      const left = await this.decline(account, byAccount.get(account)!, now, deadline, declined, out, errors);
      if (left) more.push({ account, from: left });
    }
    if (out.length) {
      await this.save(declined, now);
      this.options.onDeclined?.();
    }
    if (more.length) this.soon(CARRY_ON_MS);
    return { declined: out, errors, more };
  }

  /**
   * One account's part of a pass: its calendar read once over all its windows, page after page (from where the last
   * pass stopped), and the invitations they decline declined, in the order they come, until a bound. Returns where
   * the meetings still to be looked at start when it stopped at one, else null.
   */
  private async decline(account: string, windows: TaskWindow[], now: number, deadline: number, declined: Map<string, DeclinedMeeting>, out: DeclinedMeeting[], errors: string[]): Promise<string | null> {
    const range = { timeMin: new Date(Math.max(now, Date.parse(windows[0]!.start))).toISOString(), timeMax: windows.reduce((last, window) => (window.end > last ? window.end : last), windows[0]!.end) };
    const fresh = (): Cursor => ({ ...range, from: range.timeMin });
    let cursor = this.cursors.get(account) ?? fresh();
    let pages = 0;
    let tried = 0;
    let again = Boolean(cursor.page);
    for (;;) {
      if (pages > 0 && (pages >= (this.options.pagesMax ?? PAGES_MAX) || this.clock() > deadline)) {
        this.cursors.set(account, cursor);
        return cursor.from;
      }
      let page: { items: Invitation[]; next: string | null };
      try {
        page = await this.calendar.invitationPage(account, cursor.timeMin, cursor.timeMax, cursor.page);
      } catch (error) {
        // A page Google no longer has (its token expired): read again from the start, once.
        if (again) {
          again = false;
          cursor = fresh();
          continue;
        }
        this.cursors.delete(account);
        errors.push(`${account}: ${messageOf(error)}`);
        return null;
      }
      pages++;
      const before = new Set([...declined.values()].filter((entry) => entry.account === account).map((entry) => entry.eventId));
      for (const { invitation, window } of meetingsToDecline(windows, page.items, before)) {
        const key = `${account}\n${invitation.id}`;
        if (this.failed.has(key)) continue;
        if (tried > 0 && this.clock() > deadline) {
          // Out of time: the next pass reads this page again and goes on from this meeting.
          cursor = { ...cursor, from: invitation.start };
          this.cursors.set(account, cursor);
          return cursor.from;
        }
        tried++;
        try {
          await this.calendar.respond(account, 'primary', invitation.id, 'declined', 'this', window.decline!.message);
          const entry: DeclinedMeeting = { account, taskId: window.taskId, task: window.title, eventId: invitation.id, summary: invitation.summary, start: invitation.start, at: new Date(now).toISOString() };
          declined.set(key, entry);
          out.push(entry);
        } catch (error) {
          this.failed.add(key);
          errors.push(`"${invitation.summary}": ${messageOf(error)}`);
        }
      }
      if (!page.next) {
        // A whole round: the next pass starts again from the start, and tries again the ones that failed.
        this.cursors.delete(account);
        for (const key of [...this.failed]) if (key.startsWith(`${account}\n`)) this.failed.delete(key);
        return null;
      }
      cursor = { ...cursor, page: page.next, from: page.items.at(-1)?.start ?? cursor.from };
    }
  }

  private async load(): Promise<Map<string, DeclinedMeeting>> {
    if (this.declined) return this.declined;
    const declined = new Map<string, DeclinedMeeting>();
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { declined?: unknown };
      for (const entry of Array.isArray(parsed.declined) ? parsed.declined : []) {
        const item = entry as DeclinedMeeting;
        if (typeof item?.account === 'string' && typeof item.eventId === 'string' && typeof item.taskId === 'string' && typeof item.at === 'string') declined.set(`${item.account}\n${item.eventId}`, item);
      }
    } catch {
      // None declined yet, or a file that does not read: start again (an invitation declined before stays declined in Google).
    }
    this.declined = declined;
    return declined;
  }

  private async save(declined: Map<string, DeclinedMeeting>, now: number): Promise<void> {
    for (const [key, entry] of declined) if (now - Date.parse(entry.at) > KEEP_MS) declined.delete(key);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, declined: [...declined.values()] })}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}
