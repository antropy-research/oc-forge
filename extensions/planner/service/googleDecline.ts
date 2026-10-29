// Google Calendar's "Automatically decline meetings" for a task with a time
// set Busy (work and school accounts), done by the Planner: Google Calendar
// gets no time for a task the Planner times, so its own declining cannot.
// Every few minutes, and soon after such a task changes, the invitations on the
// account's own calendar that overlap the task's time (its upcoming
// occurrences' too, two weeks ahead) are answered "Declined" with the task's
// message, which Google sends the organizer, as Google Calendar does. Each is
// declined once: one the user answers again afterwards stays as answered. What
// was declined is kept a month beside the data (never in its synced
// repository), to show in the task's details and not to decline it again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PlannerState } from '../src/domain/types.ts';
import type { PlannerEvent } from '../src/domain/events.ts';
import { addDays, todayIn } from '../src/domain/dates.ts';
import type { GoogleResponse, GoogleTaskItem } from '../src/domain/google.ts';
import { invitationsToDecline, taskWindows, type DeclinedMeeting, type Invitation } from '../src/domain/gtaskAdvanced.ts';

/** How far ahead a task's meetings are declined. */
export const DECLINE_AHEAD_DAYS = 14;
const EVERY_MS = 5 * 60_000;
const AFTER_CHANGE_MS = 1500;
const KEEP_MS = 30 * 24 * 60 * 60_000;
/** At most this many tasks' times are looked at in one pass, so a pass ends well inside the host's 20 s. */
const WINDOWS_MAX = 40;

export interface DeclineReads {
  /** The work or school accounts with Google Calendar and Google Tasks. */
  accounts(): Promise<string[]>;
  /** Tasks by account, list and id, as Google has them now. */
  byIds(groups: readonly { account: string; listId: string; ids: string[] }[]): Promise<{ items: GoogleTaskItem[]; errors: string[] }>;
}

export interface DeclineCalendar {
  invitations(account: string, timeMin: string, timeMax: string): Promise<Invitation[]>;
  respond(account: string, calendarId: string, eventId: string, response: GoogleResponse, scope: 'this' | 'all', comment?: string): Promise<number>;
}

export interface DeclinePass {
  declined: DeclinedMeeting[];
  errors: string[];
}

export class MeetingDecliner {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private declined: Map<string, DeclinedMeeting> | null = null;

  constructor(
    private readonly file: string,
    private readonly state: () => PlannerState,
    private readonly reads: DeclineReads,
    private readonly calendar: DeclineCalendar,
    private readonly options: { log?: (message: string) => void; now?: () => number; onDeclined?: () => void } = {},
  ) {}

  /** Decline every few minutes, and soon after a task's time, availability or declining changes. */
  start(planner: { onPersist(listener: (events: readonly PlannerEvent[]) => void): unknown }): void {
    setInterval(() => this.soon(0), EVERY_MS).unref?.();
    planner.onPersist((events) => {
      if (events.some((event) => event.type === 'gtask.kept' && ['decline', 'time', 'duration', 'busy', 'repeat'].some((field) => field in event.patch))) this.soon(AFTER_CHANGE_MS);
    });
    this.soon(AFTER_CHANGE_MS);
  }

  private soon(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().then(
        (pass) => pass.errors.length && this.options.log?.(`declining meetings: ${pass.errors.join('; ')}`),
        (error) => this.options.log?.(`declining meetings: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, ms);
    this.timer.unref?.();
  }

  /** One pass now, after any running one: the meetings it declined. */
  run(): Promise<DeclinePass> {
    const next = this.queue.then(() => this.runNow());
    this.queue = next.catch(() => {});
    return next;
  }

  /** What was declined for a task, the latest first. */
  async declinedFor(account: string, taskId: string): Promise<DeclinedMeeting[]> {
    const declined = await this.load();
    return [...declined.values()].filter((entry) => entry.account === account && entry.taskId === taskId).sort((a, b) => b.at.localeCompare(a.at));
  }

  private async runNow(): Promise<DeclinePass> {
    const state = this.state();
    const kept = state.googleTasks;
    const wanted = Object.values(kept).filter((entry) => entry.time !== null && ((entry.busy && entry.decline) || (entry.repeat?.template?.busy && entry.repeat.template.decline && !entry.repeat.next)));
    if (!wanted.length) return { declined: [], errors: [] };
    const accounts = new Set(await this.reads.accounts());
    const groups = new Map<string, { account: string; listId: string; ids: string[] }>();
    for (const entry of wanted) {
      if (!accounts.has(entry.account)) continue;
      const key = `${entry.account}\n${entry.listId}`;
      const group = groups.get(key) ?? { account: entry.account, listId: entry.listId, ids: [] };
      group.ids.push(entry.taskId);
      groups.set(key, group);
    }
    if (!groups.size) return { declined: [], errors: [] };
    const now = this.options.now?.() ?? Date.now();
    const zone = state.settings.timezone ?? 'UTC';
    const today = todayIn(zone, new Date(now));
    const read = await this.reads.byIds([...groups.values()]);
    const errors = [...read.errors];
    const windows = taskWindows(read.items, this.state().googleTasks, today, addDays(today, DECLINE_AHEAD_DAYS), today, zone)
      .filter((window) => window.decline && accounts.has(window.account) && Date.parse(window.end) > now)
      .slice(0, WINDOWS_MAX);
    const declined = await this.load();
    const out: DeclinedMeeting[] = [];
    for (const window of windows) {
      let events: Invitation[];
      try {
        events = await this.calendar.invitations(window.account, window.start, window.end);
      } catch (error) {
        errors.push(`${window.account}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const before = new Set([...declined.values()].filter((entry) => entry.account === window.account).map((entry) => entry.eventId));
      for (const invitation of invitationsToDecline(window, events, before)) {
        try {
          await this.calendar.respond(window.account, 'primary', invitation.id, 'declined', 'this', window.decline!.message);
          const entry: DeclinedMeeting = { account: window.account, taskId: window.taskId, task: window.title, eventId: invitation.id, summary: invitation.summary, start: invitation.start, at: new Date(now).toISOString() };
          declined.set(`${window.account}\n${invitation.id}`, entry);
          out.push(entry);
        } catch (error) {
          errors.push(`"${invitation.summary}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (out.length) {
      await this.save(declined, now);
      this.options.onDeclined?.();
    }
    return { declined: out, errors };
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
