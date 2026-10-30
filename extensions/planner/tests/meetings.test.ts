// Round 12, Sunsama's meeting import (help.sunsama.com/docs/usage-guides/importing-meetings): which events qualify
// (the five exclusions, on at first; declined never), the calendars to import from (for suggestions, the ones shown
// when none are chosen; auto-sync needs one), daily planning's suggestions, "Add to tasks" (by start time; a removed
// one back as the user's own), auto-sync (adds, follows, removes; never re-adds one removed, keeps one with time
// recorded or of a calendar that could not be read), and auto-completion (always, never, with invitees; not while
// its timer runs), and the service that runs them.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import { MeetingImport } from '../service/meetings.ts';
import { addMeetingCommands, addMeetingsCommands, eventKey, excludedBy, importCalendars, meetingSuggestions, planMeetingCompletion, planMeetingSync, taskForEvent } from '../src/domain/meetings.ts';
import { instantAt } from '../src/domain/dates.ts';
import { actualMinutes } from '../src/domain/selectors.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { emptyState, MEETING_EXCLUSIONS, type PlannerState } from '../src/domain/types.ts';
import type { CalendarEvent } from '../src/domain/ics.ts';

const ME = 'me@x.com';
const ZONE = 'America/Los_Angeles';
const TODAY = '2026-10-29';
const TOMORROW = '2026-10-30';
let clock = Date.parse('2026-10-29T15:00:00Z');
let ids = 0;
const newId = () => `m${++ids}`;
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
const run = (state: PlannerState, bodies: readonly EventBody[]): PlannerState => {
  for (const body of bodies) {
    expect(validateCommand({ cmd: `c${clock}`, ...body }, state)).toBeNull();
    state = applyEvents(state, [ev(body)]);
  }
  return state;
};
const at = (date: string, hour: number, minute = 0) => instantAt(date, hour * 60 + minute, ZONE);

/** A Google event as the calendar feed has it: its subscription, its Google reference (my answer, others invited). */
const meeting = (id: string, title: string, start: string, end: string, options: { calendar?: 'work' | 'home'; response?: 'accepted' | 'needsAction' | 'tentative' | 'declined' | null; guests?: boolean; allDay?: boolean; transparent?: boolean } = {}): CalendarEvent => {
  const calendar = options.calendar ?? 'work';
  const calendarId = calendar === 'work' ? 'primary' : 'home@group.calendar.google.com';
  return {
    id: `${calendar}:${id}`,
    calendarId: calendar,
    title,
    location: '',
    start,
    end,
    allDay: options.allDay ?? false,
    busy: !options.transparent,
    ...(options.transparent ? { transparent: true } : {}),
    google: { account: ME, calendarId, eventId: id, recurringEventId: null, editable: true, response: options.response === undefined ? 'accepted' : options.response, guests: options.guests ?? true, color: null, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, meet: null },
  };
};

const base = (settings: Partial<PlannerState['settings']> = {}): PlannerState =>
  run(emptyState(), [
    { type: 'settings.updated', patch: { timezone: ZONE, ...settings } },
    { type: 'calendar.added', calendar: { id: 'work', name: 'Work', url: 'https://calendar.google.com/calendar/r', color: '#039be5', google: { account: ME, calendarId: 'primary' } } },
    { type: 'calendar.added', calendar: { id: 'home', name: 'Home', url: 'https://calendar.google.com/calendar/r', color: '#33b679', google: { account: ME, calendarId: 'home@group.calendar.google.com' } } },
    { type: 'calendar.updated', calendarId: 'home', patch: { visible: false } },
    { type: 'task.created', task: { id: 'focus', title: 'Write the plan', placement: { kind: 'day', date: TODAY }, position: 1024 } },
  ]);

const planning = meeting('plan', 'Quarter planning', at(TODAY, 14), at(TODAY, 15));
const standup = meeting('standup', 'Standup', at(TODAY, 9), at(TODAY, 9, 15));
const review = meeting('review', 'Design review', at(TOMORROW, 11), at(TOMORROW, 12));

describe('which events are meetings to import', () => {
  test("Sunsama's five exclusions, all on at first; a declined meeting is never one", () => {
    const all = [...MEETING_EXCLUSIONS];
    expect(base().settings.meetingExclusions).toEqual(all);
    expect(excludedBy(planning, all)).toBeNull();
    expect(excludedBy(meeting('solo', 'Dentist', at(TODAY, 8), at(TODAY, 9), { guests: false }), all)).toBe('noAttendees');
    expect(excludedBy(meeting('free', 'Office hours', at(TODAY, 10), at(TODAY, 11), { transparent: true }), all)).toBe('nonBlocking');
    expect(excludedBy(meeting('ooo', 'OOO: dentist', at(TODAY, 10), at(TODAY, 11)), all)).toBe('oooHold');
    expect(excludedBy(meeting('hold', 'Hold for interviews', at(TODAY, 10), at(TODAY, 11)), all)).toBe('oooHold');
    expect(excludedBy(meeting('household', 'Household chores', at(TODAY, 10), at(TODAY, 11)), all)).toBeNull();
    expect(excludedBy(meeting('maybe', 'Vendor demo', at(TODAY, 10), at(TODAY, 11), { response: 'needsAction' }), all)).toBe('unconfirmed');
    expect(excludedBy(meeting('tent', 'Vendor demo', at(TODAY, 10), at(TODAY, 11), { response: 'tentative' }), all)).toBe('unconfirmed');
    expect(excludedBy(meeting('trip', 'Offsite', `${TODAY}T07:00:00.000Z`, `${'2026-10-31'}T07:00:00.000Z`, { allDay: true }), all)).toBe('multiDayAllDay');
    expect(excludedBy(meeting('one-day', 'Holiday', `${TODAY}T07:00:00.000Z`, `${TOMORROW}T07:00:00.000Z`, { allDay: true }), all)).toBeNull();
    expect(excludedBy(meeting('no', 'Skip-level', at(TODAY, 10), at(TODAY, 11), { response: 'declined' }), [])).toBe('declined');
    expect(excludedBy(meeting('solo2', 'Dentist', at(TODAY, 8), at(TODAY, 9), { guests: false }), [])).toBeNull();
  });

  test('the calendars to import from: the ones chosen; none chosen, the ones shown for suggestions and none for auto-sync', () => {
    expect(importCalendars(base(), 'suggest').map((calendar) => calendar.id)).toEqual(['work']);
    expect(importCalendars(base(), 'autoSync')).toEqual([]);
    expect(importCalendars(base({ meetingCalendars: ['home'] }), 'suggest').map((calendar) => calendar.id)).toEqual(['home']);
    expect(importCalendars(base({ meetingCalendars: ['home'] }), 'autoSync').map((calendar) => calendar.id)).toEqual(['home']);
  });
});

describe('importing meetings by hand and in daily planning', () => {
  test("daily planning's suggestions: the day's events of the calendars to import from, by start, each saying what excludes it", () => {
    const solo = meeting('solo', 'Dentist', at(TODAY, 8), at(TODAY, 9), { guests: false });
    const homeOne = meeting('home1', 'Family call', at(TODAY, 18), at(TODAY, 19), { calendar: 'home' });
    const suggestions = meetingSuggestions(base(), [planning, review, solo, standup, homeOne], TODAY, ZONE);
    expect(suggestions.map((item) => [item.event.title, item.excluded, item.task])).toEqual([['Dentist', 'noAttendees', null], ['Standup', null, null], ['Quarter planning', null, null]]);
  });

  test("the green button imports them in time order: by start among the day's meetings, at the top when there are none, linked to their event", () => {
    let state = run(base(), [{ type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } }, { type: 'settings.updated', patch: { meetingChannels: { work: 'work' } } }]);
    state = run(state, addMeetingsCommands(state, [planning, standup], ZONE, newId));
    const list = Object.values(state.tasks).filter((task) => task.placement.kind === 'day' && task.placement.date === TODAY).sort((a, b) => a.position - b.position);
    expect(list.map((task) => task.title)).toEqual(['Standup', 'Quarter planning', 'Write the plan']);
    const made = taskForEvent(state, eventKey(planning)!)!;
    expect([made.plannedMinutes, made.channelId, made.source]).toEqual([
      60,
      'work',
      { kind: 'event', id: `${ME}|primary|plan`, key: 'Google Calendar', url: planning.google!.htmlLink, title: 'Quarter planning', account: ME, event: { calendarId: 'primary', start: planning.start, end: planning.end, allDay: false, invitees: true } },
    ]);
    // Added once: the suggestions say it is in, and adding again does nothing.
    expect(meetingSuggestions(state, [planning], TODAY, ZONE)[0]!.task?.id).toBe(made.id);
    expect(addMeetingCommands(state, planning, ZONE, newId)).toEqual([]);
    // A meeting in between goes in between.
    const lunch = meeting('lunch', 'Team lunch', at(TODAY, 12), at(TODAY, 13));
    state = run(state, addMeetingCommands(state, lunch, ZONE, newId));
    expect(Object.values(state.tasks).filter((task) => task.placement.kind === 'day' && task.placement.date === TODAY).sort((a, b) => a.position - b.position).map((task) => task.title)).toEqual(['Standup', 'Team lunch', 'Quarter planning', 'Write the plan']);
  });

  test('"Remove from tasks", then "Add to tasks": the same task back, the user\'s own from then on', () => {
    let state = base({ meetingImport: 'autoSync', meetingCalendars: ['work'] });
    state = run(state, planMeetingSync(state, [planning], { from: TODAY, days: 7, zone: ZONE, newId }));
    const auto = taskForEvent(state, eventKey(planning)!)!;
    expect(auto.source?.event?.auto).toBe(true);
    state = run(state, [{ type: 'task.deleted', taskId: auto.id }]);
    state = run(state, addMeetingCommands(state, planning, ZONE, newId));
    const back = state.tasks[auto.id]!;
    expect([back.deletedAt, back.source?.event?.auto]).toEqual([null, undefined]);
  });
});

describe('auto-sync', () => {
  const options = (read?: Set<string>) => ({ from: TODAY, days: 7, zone: ZONE, newId, ...(read ? { read } : {}) });
  const synced = (state: PlannerState, events: CalendarEvent[], read?: Set<string>) => run(state, planMeetingSync(state, events, options(read)));

  test('only with Auto-sync, and from the calendars chosen: the qualifying events of today and the six days after', () => {
    const later = meeting('later', 'Next month', at('2026-11-20', 10), at('2026-11-20', 11));
    const homeOne = meeting('home1', 'Family call', at(TODAY, 18), at(TODAY, 19), { calendar: 'home' });
    const solo = meeting('solo', 'Dentist', at(TODAY, 8), at(TODAY, 9), { guests: false });
    expect(planMeetingSync(base(), [planning], options())).toEqual([]);
    expect(planMeetingSync(base({ meetingImport: 'autoSync' }), [planning], options())).toEqual([]);
    const state = synced(base({ meetingImport: 'autoSync', meetingCalendars: ['work'] }), [planning, standup, review, later, homeOne, solo]);
    expect(Object.values(state.tasks).filter((task) => task.source?.kind === 'event').map((task) => [task.title, task.placement.kind === 'day' ? task.placement.date : '']).sort()).toEqual([['Design review', TOMORROW], ['Quarter planning', TODAY], ['Standup', TODAY]]);
    // Run again: nothing to do.
    expect(planMeetingSync(state, [planning, standup, review], options())).toEqual([]);
  });

  test("the meetings it added follow their event (moved, renamed) and go when it no longer qualifies; time recorded, completed or the user's own stay", () => {
    let state = synced(base({ meetingImport: 'autoSync', meetingCalendars: ['work'] }), [planning, standup, review]);
    const planningTask = taskForEvent(state, eventKey(planning)!)!;
    const standupTask = taskForEvent(state, eventKey(standup)!)!;
    const reviewTask = taskForEvent(state, eventKey(review)!)!;
    // Time recorded on the standup; the review completed.
    state = run(state, [{ type: 'time.logged', entry: { id: 'te1', taskId: standupTask.id, start: at(TODAY, 9), end: at(TODAY, 9, 15) } }, { type: 'task.completed', taskId: reviewTask.id, on: TODAY }]);
    const moved = meeting('plan', 'Quarter planning (moved)', at(TOMORROW, 15), at(TOMORROW, 16, 30));
    state = synced(state, [moved]);
    const after = state.tasks[planningTask.id]!;
    expect([after.title, after.placement, after.plannedMinutes, after.source?.event?.start]).toEqual(['Quarter planning (moved)', { kind: 'day', date: TOMORROW }, 90, moved.start]);
    // The standup and the review are gone from the calendar: one has its time, the other is done; both stay.
    expect([state.tasks[standupTask.id]!.deletedAt, state.tasks[reviewTask.id]!.deletedAt]).toEqual([null, null]);
    // Now held (HOLD in its title): it no longer qualifies, so it goes.
    state = synced(state, [meeting('plan', 'HOLD quarter planning', at(TOMORROW, 15), at(TOMORROW, 16, 30))]);
    expect(state.tasks[planningTask.id]!.deletedAt).not.toBeNull();
    // Removed, it is never added back while it still qualifies.
    expect(planMeetingSync(state, [moved], options())).toEqual([]);
  });

  test("an import channel chosen after they were added: the meetings it added take it, unless given one", () => {
    let state = run(base({ meetingImport: 'autoSync', meetingCalendars: ['work'] }), [
      { type: 'channel.created', channel: { id: 'meet', name: 'meetings', color: '#e8590c', context: 'work' } },
      { type: 'channel.created', channel: { id: 'mine', name: 'mine', color: '#1c7ed6', context: 'personal' } },
    ]);
    state = synced(state, [planning, standup]);
    const planningId = taskForEvent(state, eventKey(planning)!)!.id;
    const standupId = taskForEvent(state, eventKey(standup)!)!.id;
    state = run(state, [{ type: 'task.updated', taskId: standupId, patch: { channelId: 'mine' } }, { type: 'settings.updated', patch: { meetingChannels: { work: 'meet' } } }]);
    state = synced(state, [planning, standup]);
    expect([state.tasks[planningId]!.channelId, state.tasks[standupId]!.channelId]).toEqual(['meet', 'mine']);
    expect(planMeetingSync(state, [planning, standup], options())).toEqual([]);
  });

  test('a calendar that could not be read keeps its meetings; one no longer chosen takes them off', () => {
    let state = synced(base({ meetingImport: 'autoSync', meetingCalendars: ['work'] }), [planning]);
    const task = taskForEvent(state, eventKey(planning)!)!;
    state = synced(state, [], new Set());
    expect(state.tasks[task.id]!.deletedAt).toBeNull();
    state = run(state, [{ type: 'settings.updated', patch: { meetingCalendars: ['home'] } }]);
    state = synced(state, [], new Set(['home']));
    expect(state.tasks[task.id]!.deletedAt).not.toBeNull();
  });
});

describe("the day's stats", () => {
  test('a meeting checked off without its timer counts its length as time spent ("planned as actual", on at first)', () => {
    let state = base();
    state = run(state, addMeetingCommands(state, planning, ZONE, newId));
    const task = taskForEvent(state, eventKey(planning)!)!;
    state = run(state, [{ type: 'task.completed', taskId: task.id, on: TODAY }]);
    expect(state.settings.plannedAsActual).toBe(true);
    expect(actualMinutes(state, state.tasks[task.id]!, Date.parse(at(TODAY, 16)))).toBe(60);
  });
});

describe('auto-completion when the event ends', () => {
  test('Always (at first), Never, Only if the event has invitees; never while its timer runs, nor before it ends', () => {
    const solo = meeting('solo', 'Dentist', at(TODAY, 8), at(TODAY, 9), { guests: false });
    let state = base();
    state = run(state, addMeetingsCommands(state, [solo, standup, planning], ZONE, newId));
    const idOf = (event: CalendarEvent) => taskForEvent(state, eventKey(event)!)!.id;
    const noon = Date.parse(at(TODAY, 12));
    expect(base().settings.meetingAutoComplete).toBe('always');
    expect(planMeetingCompletion(state, noon, ZONE).map((body) => (body as { taskId: string }).taskId).sort()).toEqual([idOf(solo), idOf(standup)].sort());
    expect(planMeetingCompletion(state, noon, ZONE, 'never')).toEqual([]);
    expect(planMeetingCompletion(state, noon, ZONE, 'invitees').map((body) => (body as { taskId: string }).taskId)).toEqual([idOf(standup)]);
    state = run(state, [{ type: 'timer.started', taskId: idOf(standup) }]);
    expect(planMeetingCompletion(state, noon, ZONE).map((body) => (body as { taskId: string }).taskId)).toEqual([idOf(solo)]);
    expect(planMeetingCompletion(state, noon, ZONE)[0]).toEqual({ type: 'task.completed', taskId: idOf(solo), on: TODAY });
  });
});

describe('the service keeps it, with no Planner open', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('a run completes ended meetings, then auto-syncs the chosen calendars it read (a hidden one too); one run at a time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-meetings-'));
    dirs.push(dir);
    const store = new EventStore({ dir, commitDelayMs: 5 });
    await store.init();
    const planner = new Planner(store, () => new Date(at(TODAY, 12)));
    let n = 0;
    const execute = (...bodies: EventBody[]) => {
      const result = planner.execute(bodies.map((body) => ({ cmd: `seed${String(++n).padStart(4, '0')}x`, ...body })));
      if (!result.ok) throw new Error(result.error);
    };
    execute(
      { type: 'settings.updated', patch: { timezone: ZONE, meetingImport: 'autoSync', meetingCalendars: ['work', 'home'] } },
      { type: 'calendar.added', calendar: { id: 'work', name: 'Work', url: 'https://calendar.google.com/calendar/r', color: '#039be5', google: { account: ME, calendarId: 'primary' } } },
      { type: 'calendar.added', calendar: { id: 'home', name: 'Home', url: 'https://calendar.google.com/calendar/r', color: '#33b679', google: { account: ME, calendarId: 'home@group.calendar.google.com' } } },
      { type: 'calendar.updated', calendarId: 'home', patch: { visible: false } },
    );
    const reads: { visible: boolean[]; timeMin: string }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calendars = {
      read: async (subscriptions: readonly { visible: boolean; id: string }[], _also: unknown, timeMin: string) => {
        reads.push({ visible: subscriptions.map((item) => item.visible), timeMin });
        await gate;
        return { events: [standup, planning, review], errors: [{ calendarId: 'home', message: 'Home: 503' }], reads: new Map() };
      },
    };
    const lines: string[] = [];
    const meetings = new MeetingImport(planner, calendars as never, (line) => lines.push(line), () => Date.parse(at(TODAY, 12)));
    const first = meetings.run();
    expect(meetings.run()).toBe(first);
    release();
    const outcome = await first;
    expect(outcome).toEqual({ added: 3, moved: 0, removed: 0, completed: 0, errors: ['Home: 503'] });
    expect(reads).toEqual([{ visible: [true, true], timeMin: instantAt(TODAY, 0, ZONE) }]);
    expect(lines).toEqual(['Meeting import: Home: 503']);
    // At noon the standup has ended: the minute's check completes it.
    expect(meetings.complete()).toBe(1);
    const standupTask = taskForEvent(planner.state, eventKey(standup)!)!;
    expect(standupTask.completedOn).toBe(TODAY);
  });
});
