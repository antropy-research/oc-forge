// Sunsama's meeting import, kept by the service so it happens with no Planner open: meetings whose event has ended
// are completed (every minute; no Google read), and auto-sync adds the week's qualifying meetings of the chosen
// calendars, follows the ones it added and removes those that no longer qualify (every five minutes, and at once
// when the settings change: POST /meetings/sync). The rules are src/domain/meetings.ts's.
import { randomBytes } from 'node:crypto';
import type { Planner } from './planner.ts';
import type { GoogleCalendars } from './googleTimeboxes.ts';
import { MEETING_SYNC_DAYS, importCalendars, planMeetingCompletion, planMeetingSync } from '../src/domain/meetings.ts';
import { addDays, instantAt, todayIn } from '../src/domain/dates.ts';
import { newId } from '../src/domain/ids.ts';
import type { EventBody } from '../src/domain/events.ts';

export interface MeetingRun {
  added: number;
  moved: number;
  removed: number;
  completed: number;
  errors: string[];
}

const COMPLETE_MS = 60_000;
const SYNC_MS = 5 * 60_000;

export class MeetingImport {
  private running: Promise<MeetingRun> | null = null;

  constructor(
    private readonly planner: Pick<Planner, 'state' | 'execute'>,
    private readonly calendars: Pick<GoogleCalendars, 'read'>,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Apply the changes as the service's own commands; a refused one is logged, never thrown. */
  private apply(bodies: readonly EventBody[]): number {
    if (!bodies.length) return 0;
    const result = this.planner.execute(bodies.map((body) => ({ cmd: `meetings-${randomBytes(8).toString('hex')}`, ...body })));
    if (!result.ok) {
      this.log(`Meeting import: ${result.error}`);
      return 0;
    }
    return result.applied;
  }

  /** Complete the meetings whose event has ended, as the setting says. */
  complete(now = this.now()): number {
    const zone = this.planner.state.settings.timezone;
    return zone ? this.apply(planMeetingCompletion(this.planner.state, now, zone)) : 0;
  }

  /** Complete ended meetings, then (with auto-sync on and a calendar chosen) add, follow and remove the week's. One run at a time. */
  run(): Promise<MeetingRun> {
    this.running ??= this.once().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async once(): Promise<MeetingRun> {
    const outcome: MeetingRun = { added: 0, moved: 0, removed: 0, completed: this.complete(), errors: [] };
    const state = this.planner.state;
    const zone = state.settings.timezone;
    if (!zone || state.settings.meetingImport !== 'autoSync') return outcome;
    const calendars = importCalendars(state, 'autoSync');
    if (!calendars.length) return outcome;
    const today = todayIn(zone, new Date(this.now()));
    const timeMin = instantAt(today, 0, zone);
    const timeMax = instantAt(addDays(today, MEETING_SYNC_DAYS), 0, zone);
    // A chosen calendar is read even when it is hidden on the calendar.
    const { events, errors } = await this.calendars.read(calendars.map((calendar) => ({ ...calendar, visible: true })), [], timeMin, timeMax, zone, true);
    outcome.errors = errors.map((error) => error.message);
    const failed = new Set(errors.map((error) => error.calendarId));
    const read = new Set(calendars.map((calendar) => calendar.id).filter((id) => !failed.has(id)));
    const bodies = planMeetingSync(this.planner.state, events, { from: today, days: MEETING_SYNC_DAYS, zone, newId, read });
    const applied = this.apply(bodies);
    if (applied) {
      outcome.added = bodies.filter((body) => body.type === 'task.created').length;
      outcome.moved = bodies.filter((body) => body.type === 'task.moved' || body.type === 'task.updated').length;
      outcome.removed = bodies.filter((body) => body.type === 'task.deleted').length;
    }
    if (outcome.errors.length) this.log(`Meeting import: ${outcome.errors.join('; ')}`);
    return outcome;
  }

  /** Every minute the ended meetings; every five minutes auto-sync; once now. */
  start(): void {
    setInterval(() => this.complete(), COMPLETE_MS).unref?.();
    setInterval(() => void this.run().catch((error) => this.log(`Meeting import: ${error instanceof Error ? error.message : String(error)}`)), SYNC_MS).unref?.();
    void this.run().catch(() => {});
  }
}
