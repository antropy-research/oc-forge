// Google Calendar's joint workflow with Google Tasks, beyond the task itself:
// Pending tasks (the open tasks of the past 365 days, gathered on today), task
// notifications (at a task's time, 9 AM for one without, 9 AM on its
// deadline's day; each once, after a reload or a restart too), and a timed
// task's advanced settings, availability (Busy makes the Planner plan around
// it) and visibility (given to the working sessions written for it), kept in
// the Planner as Google Tasks' API has none of them.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, type TaskFields } from '../panel/lib/google.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { seriesRoutes } from './seriesRoutes.ts';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import type { TimeboxEvent } from '../service/googleData.ts';
import { GoogleTimeboxes, sessionVisibility } from '../service/googleTimeboxes.ts';
import { TaskNotifications, type NotificationReads } from '../service/taskNotifications.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { addDays, instantAt, todayIn, zonedDateMinutes } from '../src/domain/dates.ts';
import { dueTaskEvent, taskFromGoogleTask, type GoogleTaskItem } from '../src/domain/google.ts';
import { advancedLabel, busyTaskEvents, KEPT_HINT, keptFor, occurrenceTask, templateOf, upcomingEvent, upcomingTasks, withTaskTimes } from '../src/domain/gtaskKept.ts';
import { pendingEvent, pendingRange, pendingTasks, pendingTitle } from '../src/domain/gtaskPending.ts';
import { dueNotifications, nextNotificationAt, notificationMessage, taskNotifications } from '../src/domain/gtaskNotify.ts';
import { emptyState, type GoogleTaskKept, type PlannerState } from '../src/domain/types.ts';
import { defaultFakeWorld, startFakeGoogle, type FakeGoogle } from './e2e/fakeGoogle.mjs';

const ME = 'me@example.com';
const ZONE = 'America/Los_Angeles';
const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id: 'gt1', title: 'Send the report', notes: '', due: TODAY, completed: false, parent: null, position: '0001', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-29T15:00:00.000Z', ...patch,
});
const keep = (taskId: string, patch: Record<string, unknown>, listId = 'L1'): EventBody => ({ type: 'gtask.kept', account: ME, listId, taskId, patch } as EventBody);
const stateWith = (...bodies: EventBody[]): PlannerState => applyEvents(emptyState(), bodies.map(ev));
const kept = (state: PlannerState, id = 'gt1'): GoogleTaskKept | null => keptFor(state, { account: ME, id });
const context = (state: PlannerState) => state;

describe('Pending tasks', () => {
  test('the open tasks dated in the past 365 days, latest first; today, the future, undated, done and older ones are not pending', () => {
    const items = [
      item({ id: 'a', title: 'Yesterday', due: addDays(TODAY, -1) }),
      item({ id: 'b', title: 'Last week', due: addDays(TODAY, -7) }),
      item({ id: 'c', title: 'A year ago', due: addDays(TODAY, -365) }),
      item({ id: 'd', title: 'Too old', due: addDays(TODAY, -366) }),
      item({ id: 'e', title: 'Today', due: TODAY }),
      item({ id: 'f', title: 'Tomorrow', due: addDays(TODAY, 1) }),
      item({ id: 'g', title: 'Undated', due: null }),
      item({ id: 'h', title: 'Done', due: addDays(TODAY, -2), completed: true }),
      item({ id: 'b', title: 'Last week', due: addDays(TODAY, -7) }),
      item({ id: 'i', title: 'Also last week', due: addDays(TODAY, -7), listId: 'L2' }),
    ];
    expect(pendingRange(TODAY)).toEqual({ from: addDays(TODAY, -365), to: addDays(TODAY, -1) });
    expect(pendingTasks(items, TODAY).map((one) => one.id)).toEqual(['a', 'i', 'b', 'c']);
  });

  test("today's all-day entry says how many, and holds them; none when nothing is pending", () => {
    expect(pendingEvent([], TODAY, ZONE)).toBeNull();
    const entry = pendingEvent([item({ due: addDays(TODAY, -1) }), item({ id: 'x', due: addDays(TODAY, -3) })], TODAY, ZONE)!;
    expect(entry).toMatchObject({ title: '2 pending tasks', allDay: true, busy: false, start: instantAt(TODAY, 0, ZONE), end: instantAt(addDays(TODAY, 1), 0, ZONE), calendarId: 'google-tasks' });
    expect(entry.pendingTasks).toHaveLength(2);
    expect(entry.googleTask).toBeUndefined();
    expect(pendingTitle(1)).toBe('1 pending task');
  });
});

describe('task notifications', () => {
  const nine = instantAt(TODAY, 9 * 60, ZONE);
  test('a task with a time at that time, one with a date alone at 9 AM, a deadline at 9 AM on its day; done or other days none', () => {
    const state = stateWith(keep('timed', { time: 14 * 60, duration: 60 }), keep('due-deadline', { deadline: TODAY }), keep('timed-deadline', { time: 16 * 60, deadline: TODAY }), keep('undated-deadline', { deadline: TODAY }), keep('done', { time: 10 * 60 }));
    const due = [
      item({ id: 'timed', title: 'Timed' }),
      item({ id: 'dated', title: 'Dated' }),
      item({ id: 'due-deadline', title: 'Due on its deadline' }),
      item({ id: 'timed-deadline', title: 'Timed, deadline today' }),
      item({ id: 'done', title: 'Done', completed: true }),
    ];
    const deadlines = [item({ id: 'undated-deadline', title: 'Undated, deadline today', due: null }), item({ id: 'timed-deadline', title: 'Timed, deadline today' })];
    const all = taskNotifications(due, deadlines, state.googleTasks, TODAY, ZONE);
    expect(all.map((one) => [one.kind, one.taskId, one.at])).toEqual([
      ['day', 'dated', nine],
      ['deadline', 'due-deadline', nine],
      ['deadline', 'timed-deadline', nine],
      ['deadline', 'undated-deadline', nine],
      ['time', 'timed', instantAt(TODAY, 14 * 60, ZONE)],
      ['time', 'timed-deadline', instantAt(TODAY, 16 * 60, ZONE)],
    ]);
    // A task due all day on its deadline's day gets the deadline's alone.
    expect(all.filter((one) => one.taskId === 'due-deadline')).toHaveLength(1);
    expect(all.find((one) => one.taskId === 'timed')).toMatchObject({ key: `time:${ME}:timed:${TODAY}:840`, time: 840, duration: 60 });
  });

  test("a repeating series' task for today that Google has not made yet notifies too, and not twice once Google has it", () => {
    const template = templateOf({ title: 'Standup notes', notes: '' }, { time: 9 * 60 + 30, duration: null, deadline: null }, addDays(TODAY, -1));
    const state = stateWith(keep('series-1', { time: 570, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: addDays(TODAY, -1), template } }));
    const projected = taskNotifications([], [], state.googleTasks, TODAY, ZONE);
    expect(projected).toEqual([expect.objectContaining({ kind: 'time', title: 'Standup notes', taskId: 'series-1', at: instantAt(TODAY, 570, ZONE), key: `time:upcoming:series:${TODAY}:${TODAY}:570` })]);
    // Once its occurrence for today is Google's (made when yesterday's was done), that one notifies, once.
    const made = applyEvents(state, [ev(keep('series-1', { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: 'series-2', on: addDays(TODAY, -1), template } })), ev(keep('series-2', { time: 570, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 2, next: null, on: TODAY, template } }))]);
    const real = taskNotifications([item({ id: 'series-2', title: 'Standup notes' })], [], made.googleTasks, TODAY, ZONE);
    expect(real.map((one) => [one.kind, one.taskId])).toEqual([['time', 'series-2']]);
  });

  test('none for a time that had passed when the task got it, as Google sends none for a time gone by', () => {
    // Set at 11:00 (18:00 UTC): its 10:00 and its 9 AM deadline had gone by; its 2pm has not.
    const late = (body: EventBody): PlannerEvent => ({ v: 1, id: `late-${Math.random().toString(36).slice(2)}`, at: '2026-10-29T18:00:00.000Z', ...body }) as PlannerEvent;
    const state = applyEvents(emptyState(), [late(keep('late-time', { time: 10 * 60 })), late(keep('late-deadline', { deadline: TODAY })), late(keep('later', { time: 14 * 60 }))]);
    const due = [item({ id: 'late-time', title: 'Late time' }), item({ id: 'later', title: 'Later' }), item({ id: 'late-date', title: 'Dated at 11', updated: '2026-10-29T18:00:00.000Z' })];
    const all = taskNotifications(due, [item({ id: 'late-deadline', title: 'Late deadline', due: null })], state.googleTasks, TODAY, ZONE);
    expect(all.map((one) => one.taskId)).toEqual(['later']);
    // Set before: missed while no Planner surface was open, it still comes (the same day).
    const early = taskNotifications([item({ id: 'early', updated: '2026-10-28T20:00:00.000Z' })], [], {}, TODAY, ZONE);
    expect(early.map((one) => [one.kind, one.taskId])).toEqual([['day', 'early']]);
  });

  test('each comes once its time has come; the next one says when', () => {
    const state = stateWith(keep('timed', { time: 14 * 60 }));
    const all = taskNotifications([item({ id: 'timed', title: 'Timed' }), item({ id: 'dated', title: 'Dated' })], [], state.googleTasks, TODAY, ZONE);
    const before = Date.parse(nine) - 60_000;
    expect(dueNotifications(all, before, new Set())).toEqual([]);
    expect(nextNotificationAt(all, before, new Set())).toBe(nine);
    const at = Date.parse(nine);
    expect(dueNotifications(all, at, new Set()).map((one) => one.taskId)).toEqual(['dated']);
    const given = new Set([all[0]!.key]);
    expect(dueNotifications(all, at + 3600_000, given)).toEqual([]);
    expect(nextNotificationAt(all, at, given)).toBe(instantAt(TODAY, 14 * 60, ZONE));
  });

  test('their messages', () => {
    expect(notificationMessage({ kind: 'time', title: 'Send the report', time: 14 * 60, duration: 60 })).toBe('Task at 2 – 3pm: Send the report');
    expect(notificationMessage({ kind: 'time', title: 'Send the report', time: 9 * 60 + 30, duration: null })).toBe('Task at 9:30am: Send the report');
    expect(notificationMessage({ kind: 'day', title: 'Send the report', time: null, duration: null })).toBe('Task today: Send the report');
    expect(notificationMessage({ kind: 'deadline', title: 'Send the report', time: null, duration: null })).toBe('Deadline today: Send the report');
    expect(notificationMessage({ kind: 'day', title: 'x'.repeat(900), time: null, duration: null }).length).toBeLessThanOrEqual(500);
  });
});

describe('the service gives each notification once', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const setup = (state: PlannerState, items: GoogleTaskItem[], at: { now: number }) => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-notify-'));
    dirs.push(dir);
    const reads: NotificationReads & { due: NotificationReads['due'] } = {
      accounts: async () => [ME],
      due: async (_accounts, from, to) => ({ items: items.filter((one) => one.due !== null && one.due >= from && one.due <= to), errors: [] }),
      byIds: async (groups) => ({ items: items.filter((one) => groups.some((group) => group.ids.includes(one.id))), errors: [] }),
    };
    const file = join(dir, 'task-notifications.json');
    const make = () => new TaskNotifications(file, () => state, reads, () => at.now);
    return { file, make, setState: (next: PlannerState) => (state = next) };
  };
  const zoned = (state: PlannerState) => applyEvents(state, [ev({ type: 'settings.updated', patch: { timezone: ZONE } })]);

  test('at its time, to one asker; never again, after a restart too; the next one is said', async () => {
    const at = { now: Date.parse(instantAt(TODAY, 14 * 60 - 5, ZONE)) };
    const state = zoned(stateWith(keep('timed', { time: 14 * 60 })));
    const { file, make } = setup(state, [item({ id: 'timed', title: 'Timed' }), item({ id: 'dated', title: 'Dated' })], at);
    const service = make();
    const first = await service.take();
    // 9 AM has passed: the date-only one comes; the timed one is next.
    expect(first.notifications.map((one) => one.taskId)).toEqual(['dated']);
    expect(first.next).toBe(instantAt(TODAY, 14 * 60, ZONE));
    expect((await service.take()).notifications).toEqual([]);
    at.now += 5 * 60_000;
    // Two surfaces ask at once: one of them gets it.
    const [a, b] = await Promise.all([service.take(), service.take()]);
    expect([...a.notifications, ...b.notifications].map((one) => one.taskId)).toEqual(['timed']);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).given)).toHaveLength(2);
    // A restarted service read what was given.
    expect((await make().take()).notifications).toEqual([]);
  });

  test('off in the settings, none come', async () => {
    const at = { now: Date.parse(instantAt(TODAY, 15 * 60, ZONE)) };
    const state = applyEvents(zoned(emptyState()), [ev({ type: 'settings.updated', patch: { googleTaskNotifications: false } })]);
    const { make } = setup(state, [item({ id: 'dated' })], at);
    expect(await make().take()).toEqual({ notifications: [], next: null, nextIn: null, errors: [] });
  });

  test('a file that does not read starts again rather than failing', async () => {
    const at = { now: Date.parse(instantAt(TODAY, 15 * 60, ZONE)) };
    const { file, make } = setup(zoned(emptyState()), [item({ id: 'dated' })], at);
    writeFileSync(file, 'not json');
    expect((await make().take()).notifications.map((one) => one.taskId)).toEqual(['dated']);
  });
});

describe("a timed task's availability and visibility", () => {
  test('kept as Google Calendar has them: Busy or Free, a visibility; a task without a time is free and private', () => {
    expect(validateCommand({ cmd: 'c1', ...keep('gt1', { busy: true, visibility: 'private' }) }, context(emptyState()))).toBeNull();
    expect(validateCommand({ cmd: 'c1', ...keep('gt1', { busy: 'yes' }) }, context(emptyState()))).toContain('busy');
    expect(validateCommand({ cmd: 'c1', ...keep('gt1', { visibility: 'secret' }) }, context(emptyState()))).toContain('visibility');
    const timed = stateWith(keep('gt1', { time: 600, busy: true, visibility: 'private' }));
    expect(kept(timed)).toMatchObject({ time: 600, busy: true, visibility: 'private' });
    const free = applyEvents(timed, [ev(keep('gt1', { busy: false, visibility: 'default' }))]);
    expect(kept(free)).toMatchObject({ time: 600 });
    expect(kept(free)!.busy).toBeUndefined();
    expect(kept(free)!.visibility).toBeUndefined();
    // All day: they go with the time (and nothing is kept any more).
    expect(kept(applyEvents(timed, [ev(keep('gt1', { time: null }))]))).toBeNull();
    expect(kept(applyEvents(stateWith(keep('gt1', { time: 600, busy: true, deadline: '2026-11-02' })), [ev(keep('gt1', { time: null }))]))).toMatchObject({ deadline: '2026-11-02' });
    expect(kept(applyEvents(stateWith(keep('gt1', { time: 600, busy: true, deadline: '2026-11-02' })), [ev(keep('gt1', { time: null }))]))!.busy).toBeUndefined();
    expect(advancedLabel(kept(timed))).toBe('Busy · Private');
    expect(advancedLabel(kept(stateWith(keep('gt1', { time: 600 }))))).toBeNull();
    expect(KEPT_HINT).toContain('availability or visibility');
  });

  test("a series' template keeps them (with a time) and gives them to each task it makes", () => {
    const template = templateOf({ title: 'Standup', notes: '' }, { time: 570, duration: null, deadline: null, busy: true, visibility: 'public' }, TODAY);
    expect(template).toMatchObject({ busy: true, visibility: 'public' });
    expect(templateOf({ title: 'Standup', notes: '' }, { time: null, duration: null, deadline: null, busy: true, visibility: 'public' }, TODAY)).not.toHaveProperty('busy');
    expect(validateCommand({ cmd: 'c1', ...keep('gt1', { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template } }) }, context(emptyState()))).toBeNull();
    expect(validateCommand({ cmd: 'c1', ...keep('gt1', { repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template: { ...template, busy: false } } }) }, context(emptyState()))).toContain('busy');
    const next = occurrenceTask({ rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template }, template, addDays(TODAY, 1), 2);
    expect(next.kept).toMatchObject({ time: 570, busy: true, visibility: 'public' });
    // An occurrence changed to all day on its own has neither.
    const allDay = occurrenceTask({ rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template, exceptions: { [addDays(TODAY, 1)]: { time: null, duration: null } } }, template, addDays(TODAY, 1), 2);
    expect(allDay.kept).not.toHaveProperty('busy');
  });

  test('Busy makes the Planner plan around it: a Busy timed task and the upcoming tasks of a Busy series, never a Free, done or all-day one', () => {
    const template = templateOf({ title: 'Standup', notes: '' }, { time: 570, duration: null, deadline: null, busy: true }, TODAY);
    const state = stateWith(
      keep('busy', { time: 600, duration: 60, busy: true }),
      keep('free', { time: 720 }),
      keep('done', { time: 780, busy: true }),
      keep('series-1', { time: 570, busy: true, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template } }),
    );
    const feed = [item({ id: 'busy' }), item({ id: 'free' }), item({ id: 'done', completed: true }), item({ id: 'series-1' }), item({ id: 'allday' })].map((one) => dueTaskEvent({ ...one, due: one.due! }, ZONE));
    expect(withTaskTimes(feed, state.googleTasks, ZONE).map((event) => [event.googleTask!.id, event.busy])).toEqual([['busy', true], ['free', false], ['done', false], ['series-1', true], ['allday', false]]);
    const tomorrow = addDays(TODAY, 1);
    const busyToday = busyTaskEvents(feed, state.googleTasks, TODAY, TODAY, TODAY, ZONE);
    expect(busyToday.map((event) => [event.googleTask?.id ?? 'upcoming', zonedDateMinutes(event.start, ZONE).minutes])).toEqual([['busy', 600], ['series-1', 570]]);
    const busyTomorrow = busyTaskEvents([], state.googleTasks, tomorrow, tomorrow, TODAY, ZONE);
    expect(busyTomorrow.map((event) => [event.upcoming?.on, zonedDateMinutes(event.start, ZONE).minutes, (Date.parse(event.end) - Date.parse(event.start)) / 60_000])).toEqual([[tomorrow, 570, 30]]);
    const free = upcomingTasks(stateWith(keep('s', { time: 570, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's', index: 1, next: null, on: TODAY, template: { ...template, busy: undefined } } })).googleTasks, [], tomorrow, tomorrow, TODAY);
    expect(upcomingEvent(free[0]!, ZONE).busy).toBe(false);
  });

  test('saved from the form: kept once Google has the rest; for a repeating task, for all of its series', async () => {
    const start = stateWith(keep('gt1', { time: 600 }));
    const fake = fakeClient(start, (method, _path, body) => (method === 'PATCH' ? { task: item({ ...body, id: 'gt1' }) } : { tasks: [] }));
    const store = new GoogleStore(host, fake.client, 'page');
    const fields = (patch: Partial<TaskFields['kept']> = {}): TaskFields => ({ title: 'Send the report', notes: '', due: TODAY, kept: { time: 600, duration: null, deadline: null, rule: null, busy: true, visibility: 'private', ...patch } });
    await store.saveListTask(item(), fields());
    expect(kept(fake.state())).toMatchObject({ busy: true, visibility: 'private' });
    // No Google write for them: they are the Planner's alone.
    expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // Fields that leave them out leave them as they are.
    await store.saveListTask(item(), { ...fields(), kept: { time: 660, duration: null, deadline: null, rule: null } });
    expect(kept(fake.state())).toMatchObject({ time: 660, busy: true, visibility: 'private' });
    await store.saveListTask(item(), fields({ time: null }));
    expect(kept(fake.state())).toBeNull();

    const template = templateOf({ title: 'Standup', notes: '' }, { time: 570, duration: null, deadline: null }, TODAY);
    const series = fakeClient(stateWith(keep('gt1', { time: 570, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template } })));
    const repeating = new GoogleStore(host, series.client, 'page');
    await repeating.saveListTask(item({ title: 'Standup' }), { title: 'Standup', notes: '', due: TODAY, kept: { time: 570, duration: null, deadline: null, rule: 'RRULE:FREQ=DAILY', busy: true, visibility: 'default' } }, 'this');
    expect(kept(series.state())).toMatchObject({ busy: true });
    expect(kept(series.state())!.repeat!.template).toMatchObject({ busy: true });
  });

  test("the working sessions of a task planning a Google task are written with that task's visibility, again when it changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-visibility-'));
    try {
      const store = new EventStore({ dir, commitDelayMs: 5 });
      await store.init();
      const planner = new Planner(store, () => new Date('2026-10-29T15:00:00Z'));
      const written: TimeboxEvent[] = [];
      let next = 1;
      const timeboxes = new GoogleTimeboxes(planner, {
        putTimebox: async (_account: string, _calendarId: string, timebox: TimeboxEvent, eventId: string | null) => {
          written.push(timebox);
          return eventId ?? `ev${next++}`;
        },
        deleteTimebox: async () => {},
        event: async () => null,
      });
      const run = (...bodies: EventBody[]) => {
        const result = planner.execute(bodies.map((body, index) => ({ cmd: `v${Date.now()}${index}${Math.random().toString(36).slice(2, 8)}`, ...body })));
        if (!result.ok) throw new Error(result.error);
      };
      const google = item({ id: 'gt1', title: 'Performance review' });
      run(
        { type: 'settings.updated', patch: { googleTimebox: { account: ME, calendarId: 'primary' } } },
        { type: 'task.created', task: taskFromGoogleTask(google, 't1', { kind: 'day', date: TODAY }, 1) },
        { type: 'task.created', task: { id: 't2', title: 'Write tests', placement: { kind: 'day', date: TODAY }, position: 2 } },
        keep('gt1', { time: 600, visibility: 'private' }),
      );
      expect(sessionVisibility(planner.state, 't1')).toBe('private');
      expect(sessionVisibility(planner.state, 't2')).toBeUndefined();
      run({ type: 'block.created', block: { id: 'b1', taskId: 't1', start: '2026-10-29T17:00:00.000Z', end: '2026-10-29T18:00:00.000Z' } }, { type: 'block.created', block: { id: 'b2', taskId: 't2', start: '2026-10-29T19:00:00.000Z', end: '2026-10-29T20:00:00.000Z' } });
      await timeboxes.settled();
      expect(written.map((one) => [one.blockId, one.visibility])).toEqual([['b1', 'private'], ['b2', undefined]]);
      run(keep('gt1', { visibility: 'public' }));
      await timeboxes.settled();
      expect(written.at(-1)).toMatchObject({ blockId: 'b1', visibility: 'public' });
      expect(written).toHaveLength(3);
      await store.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the setting for task notifications is on unless turned off', () => {
    expect(emptyState().settings.googleTaskNotifications).toBe(true);
    expect(validateCommand({ cmd: 'c1', type: 'settings.updated', patch: { googleTaskNotifications: false } }, context(emptyState()))).toBeNull();
    expect(validateCommand({ cmd: 'c1', type: 'settings.updated', patch: { googleTaskNotifications: 'no' } }, context(emptyState()))).toContain('googleTaskNotifications');
  });
});

/** A Planner client whose dispatch applies (and checks) the events; Google answers through `answer`. */
const fakeClient = (start: PlannerState, answer: (method: string, path: string, body: any) => unknown = () => ({ tasks: [] })) => {
  let state = start;
  let n = 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  // A repeating task's series changes in the service: its routes run the service's own code here (`seriesRoutes`).
  const { handle } = seriesRoutes({ state: () => state, apply: (bodies) => (state = applyEvents(state, bodies.map(ev))) }, async (method, path, body) => answer(method, path, body));
  const client = {
    getView: () => ({ state, today: TODAY }),
    call: async (method: string, path: string, body?: unknown) => {
      const answered = await handle(path, body);
      if (answered) return answered;
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return answer(method, path, body);
    },
    adopt: async () => {},
    dispatch: async (bodies: EventBody[]) => {
      for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
      n += bodies.length;
      state = applyEvents(state, bodies.map(ev));
    },
    activity: async () => [],
    notify: () => {},
    onCommitted: () => () => {},
  } as unknown as PlannerClient;
  return { client, calls, state: () => state };
};
const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;

/** A zone where it is between 10 AM and 10 PM now, so the 9 AM notifications of today have come and today lasts the test. */
const daytimeZone = (now = Date.now()): string =>
  ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Honolulu'].find((zone) => {
    const hour = zonedDateMinutes(now, zone).minutes / 60;
    return hour >= 10 && hour < 22;
  }) ?? 'UTC';

describe('the routes, against a fake Google', () => {
  const token = 'tasks-calendar-test-token';
  const zone = daytimeZone();
  const today = todayIn(zone);
  const account = 'harness@example.com';
  let child: ChildProcess;
  let fake: FakeGoogle;
  let base = '';
  let root = '';
  let seq = 0;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const commands = (...bodies: Record<string, unknown>[]) => call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `tc${String(++seq).padStart(8, '0')}`, ...body })) });
  const start = async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port: free } = server.address() as AddressInfo;
        server.close(() => resolve(free));
      });
    });
    child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
      env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), PLANNER_GOOGLE_API_BASE: fake.base },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const stop = async () => {
    const exited = new Promise((resolve) => child?.once('exit', resolve));
    child?.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  };

  const minutesNow = () => Math.floor(zonedDateMinutes(Date.now(), zone).minutes);
  beforeAll(async () => {
    const world = defaultFakeWorld({ account, today, zone });
    const due = (days: number) => `${addDays(today, days)}T00:00:00.000Z`;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // Send the report (due today) was last changed in Google yesterday.
    world.tasks.L1![0]!.updated = yesterday;
    world.tasks.L1!.push(
      { id: 't-overdue', title: 'Renew the passport', notes: '', due: due(-3), status: 'needsAction' },
      { id: 't-ancient', title: 'Older than a year', notes: '', due: due(-400), status: 'needsAction' },
      { id: 't-done-late', title: 'Done late', notes: '', due: due(-2), status: 'completed', completed: new Date().toISOString() },
      { id: 't-call', title: 'Call the bank', notes: '', due: due(0), status: 'needsAction', updated: yesterday },
    );
    world.tasks.L2!.push({ id: 't-errand', title: 'Return the books', notes: '', due: due(-10), status: 'needsAction' });
    fake = await startFakeGoogle(world);
    root = mkdtempSync(join(tmpdir(), 'planner-tasks-calendar-'));
    writeFileSync(join(root, 'google-accounts.json'), fake.accountsFile(), { mode: 0o600 });
    // What the Planner kept yesterday: Send the report's time (two minutes ago, today) and Buy stamps' deadline (today).
    const seeded = [
      { type: 'settings.updated', patch: { timezone: zone } },
      { type: 'gtask.kept', account, listId: 'L1', taskId: 't-report', patch: { time: minutesNow() - 2 } },
      { type: 'gtask.kept', account, listId: 'L2', taskId: 't-stamps', patch: { deadline: today } },
    ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
    mkdirSync(join(root, 'data', 'events'), { recursive: true });
    writeFileSync(join(root, 'data', 'events', `${yesterday.slice(0, 7)}.jsonl`), `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n`);
    await start();
  });

  afterAll(async () => {
    await stop();
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Pending tasks: every list's open tasks of the past 365 days, read without the completed ones", async () => {
    const { status, body } = await call('GET', '/google/tasks/pending');
    expect(status).toBe(200);
    expect(body.tasks.map((one: GoogleTaskItem) => one.id)).toEqual(['t-overdue', 't-errand']);
    expect(body).toMatchObject({ today, from: addDays(today, -365), to: addDays(today, -1) });
    const reads = fake.requests.filter((request) => request.method === 'GET' && /\/tasks$/.test(request.path) && request.query.dueMin);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((request) => request.query.showCompleted === 'false')).toBe(true);
    // Rescheduled to today, it is no longer pending (a write forgets what was read).
    expect((await call('PATCH', '/google/tasks', { account, listId: 'L1', id: 't-overdue', due: today })).status).toBe(200);
    expect((await call('GET', '/google/tasks/pending')).body.tasks.map((one: GoogleTaskItem) => one.id)).toEqual(['t-errand']);
  });

  test("notifications: today's missed ones come once, the next one is said, and a restarted service gives none again", async () => {
    const kinds = (answer: { body: Record<string, any> }) => answer.body.notifications.map((one: { kind: string; taskId: string }) => [one.kind, one.taskId]).sort();
    // Set yesterday, come while no surface asked: Send the report's time, Buy stamps' deadline (it has no date) and
    // Call the bank's 9 AM (a date alone). Renew the passport was rescheduled to today after 9 AM, above: none for it.
    const first = await call('POST', '/google/tasks/notifications');
    expect(first.status).toBe(200);
    expect(kinds(first)).toEqual([['day', 't-call'], ['deadline', 't-stamps'], ['time', 't-report']]);
    expect((await call('POST', '/google/tasks/notifications')).body.notifications).toEqual([]);
    // Times set now: one later today is next; one gone by already never comes.
    const later = minutesNow() + 60;
    expect((await commands({ type: 'gtask.kept', account, listId: 'L1', taskId: 't-overdue', patch: { time: later } }, { type: 'gtask.kept', account, listId: 'L1', taskId: 't-call', patch: { time: minutesNow() - 5 } })).status).toBe(200);
    const after = await call('POST', '/google/tasks/notifications');
    expect(after.body.notifications).toEqual([]);
    expect(after.body.next).toBe(instantAt(today, later, zone));
    expect(after.body.nextIn).toBeGreaterThan(55 * 60_000);
    await stop();
    await start();
    expect((await call('POST', '/google/tasks/notifications')).body.notifications).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(join(root, 'task-notifications.json'), 'utf8')).given)).toHaveLength(3);
  });
});
