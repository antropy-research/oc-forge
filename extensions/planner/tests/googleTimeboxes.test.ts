import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../service/store.ts';
import { Planner } from '../service/planner.ts';
import { GoogleError } from '../service/google.ts';
import type { TimeboxEvent } from '../service/googleData.ts';
import { GoogleCalendars, GoogleDueTasks, GoogleTimeboxes, calendarKey, timeboxTarget, type CalendarRead } from '../service/googleTimeboxes.ts';
import type { RawGoogleEvent } from '../src/domain/google.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ME = 'me@example.com';
const TARGET = { account: ME, calendarId: 'primary' };
let seq = 0;
const cmd = () => `c${String(++seq).padStart(6, '0')}x`;

/** A calendar in memory that answers like Google, and records what was asked. */
const fakeGoogle = () => {
  const events = new Map<string, { calendarId: string; timebox: TimeboxEvent }>();
  const calls: string[] = [];
  let next = 1;
  let hold: Promise<void> | null = null;
  return {
    events,
    calls,
    /** Keep the next writes waiting until the returned function is called. */
    pause() {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
    async putTimebox(_account: string, calendarId: string, timebox: TimeboxEvent, eventId: string | null): Promise<string> {
      if (hold) await hold;
      if (eventId && !events.has(eventId)) throw new GoogleError(404, 'Not Found');
      const id = eventId ?? `ev${next++}`;
      events.set(id, { calendarId, timebox });
      calls.push(`${eventId ? 'patch' : 'create'} ${id} ${timebox.title} ${timebox.start.slice(11, 16)}`);
      return id;
    },
    async deleteTimebox(_account: string, _calendarId: string, eventId: string): Promise<void> {
      events.delete(eventId);
      calls.push(`delete ${eventId}`);
    },
    async event(_account: string, _calendarId: string, eventId: string): Promise<RawGoogleEvent | null> {
      const found = events.get(eventId);
      return found ? { id: eventId, start: { dateTime: found.timebox.start }, end: { dateTime: found.timebox.end } } : null;
    },
  };
};

const setup = async (withTarget = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-timebox-'));
  dirs.push(dir);
  const store = new EventStore({ dir, commitDelayMs: 5 });
  await store.init();
  const planner = new Planner(store, () => new Date('2026-10-26T15:00:00Z'));
  const google = fakeGoogle();
  const timeboxes = new GoogleTimeboxes(planner, google);
  const run = (...bodies: Record<string, unknown>[]) => {
    const result = planner.execute(bodies.map((body) => ({ cmd: cmd(), ...body })));
    if (!result.ok) throw new Error(result.error);
  };
  run(
    { type: 'task.created', task: { id: 't1', title: 'Write tests', placement: { kind: 'day', date: '2026-10-26' }, position: 1024 } },
    ...(withTarget ? [{ type: 'settings.updated', patch: { googleTimebox: TARGET } }] : []),
  );
  return { planner, google, timeboxes, run };
};

const block = (id: string, start: string, end: string) => ({ type: 'block.created', block: { id, taskId: 't1', start, end } });

describe('working sessions as Google Calendar events', () => {
  test('without a calendar chosen, nothing is written', async () => {
    const { google, timeboxes, run } = await setup(false);
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    await timeboxes.settled();
    expect(google.calls).toEqual([]);
  });

  test('a session is written, linked, moved, renamed and removed with its event', async () => {
    const { planner, google, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    await timeboxes.settled();
    expect(planner.state.blocks.b1!.google).toEqual({ ...TARGET, eventId: 'ev1' });
    run({ type: 'block.updated', blockId: 'b1', start: '2026-10-26T19:00:00.000Z', end: '2026-10-26T20:00:00.000Z' });
    await timeboxes.settled();
    run({ type: 'task.updated', taskId: 't1', patch: { title: 'Write more tests' } });
    await timeboxes.settled();
    run({ type: 'block.deleted', blockId: 'b1' });
    await timeboxes.settled();
    expect(google.calls).toEqual(['create ev1 Write tests 17:00', 'patch ev1 Write tests 19:00', 'patch ev1 Write more tests 19:00', 'delete ev1']);
    expect(google.events.size).toBe(0);
  });

  test('a session deleted while its event is being made takes the event with it', async () => {
    const { google, timeboxes, run } = await setup();
    const release = google.pause();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    // The event is on its way to Google when the session goes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    run({ type: 'block.deleted', blockId: 'b1' });
    release();
    await timeboxes.settled();
    expect(google.calls).toEqual(['create ev1 Write tests 17:00', 'delete ev1']);
    expect(google.events.size).toBe(0);
  });

  test('a session made and deleted before its turn comes writes nothing', async () => {
    const { google, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    run({ type: 'block.deleted', blockId: 'b1' });
    await timeboxes.settled();
    expect(google.calls).toEqual([]);
  });

  test("a channel's sessions go to its calendar (Sunsama's Timeboxing Channel), over the default and without one; the rest to the default", async () => {
    const { planner, google, timeboxes, run } = await setup(false);
    const PERSONAL = { account: ME, calendarId: 'personal@group.calendar.google.com' };
    run(
      { type: 'channel.created', channel: { id: 'family', name: 'family', color: '#1c7ed6', context: 'personal' } },
      { type: 'task.created', task: { id: 't2', title: 'Dentist', placement: { kind: 'day', date: '2026-10-26' }, position: 2048, channelId: 'family' } },
      { type: 'settings.updated', patch: { channelTimebox: { family: PERSONAL } } },
    );
    // No default ("Default for tasks" off): only the channel's sessions are written, to its calendar.
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'), { type: 'block.created', block: { id: 'b2', taskId: 't2', start: '2026-10-26T19:00:00.000Z', end: '2026-10-26T20:00:00.000Z' } });
    await timeboxes.settled();
    expect(planner.state.blocks.b1!.google).toBeUndefined();
    expect(planner.state.blocks.b2!.google).toEqual({ ...PERSONAL, eventId: 'ev1' });
    // With a default, the channel's still goes to its own; another task's to the default.
    run({ type: 'settings.updated', patch: { googleTimebox: TARGET } }, { type: 'block.created', block: { id: 'b3', taskId: 't2', start: '2026-10-26T21:00:00.000Z', end: '2026-10-26T22:00:00.000Z' } }, block('b4', '2026-10-26T15:00:00.000Z', '2026-10-26T16:00:00.000Z'));
    await timeboxes.settled();
    expect([planner.state.blocks.b3!.google?.calendarId, planner.state.blocks.b4!.google?.calendarId]).toEqual([PERSONAL.calendarId, 'primary']);
    expect([...google.events.values()].map((event) => [event.calendarId, event.timebox.title])).toEqual([[PERSONAL.calendarId, 'Dentist'], [PERSONAL.calendarId, 'Dentist'], ['primary', 'Write tests']]);
    // Both calendars are read for sessions moved or deleted there; a deleted channel's link is not followed.
    expect(timeboxes.calendarsFor(planner.state, '2026-10-26T07:00:00.000Z', '2026-10-27T07:00:00.000Z')).toEqual([TARGET, PERSONAL]);
    run({ type: 'channel.deleted', channelId: 'family' });
    expect(timeboxTarget(planner.state, 't2')).toEqual(TARGET);
  });

  test('an event deleted in Google, then its session moved here, is made again', async () => {
    const { planner, google, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    await timeboxes.settled();
    google.events.delete('ev1');
    run({ type: 'block.updated', blockId: 'b1', start: '2026-10-26T18:00:00.000Z', end: '2026-10-26T19:00:00.000Z' });
    await timeboxes.settled();
    expect(planner.state.blocks.b1!.google?.eventId).toBe('ev2');
    expect(google.calls.at(-1)).toBe('create ev2 Write tests 18:00');
  });
});

describe('Google Calendar changes come back', () => {
  const range = ['2026-10-26T07:00:00.000Z', '2026-10-27T07:00:00.000Z'] as const;
  const later = Date.now() + 60_000;
  const reads = (sessions: CalendarRead['sessions'], readAt = later) => new Map([[calendarKey(ME, 'primary'), { sessions, readAt }]]);

  test('moved there: moved here; deleted there: deleted here; moved out of the range: still moved', async () => {
    const { planner, google, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'), block('b2', '2026-10-26T19:00:00.000Z', '2026-10-26T20:00:00.000Z'), block('b3', '2026-10-26T21:00:00.000Z', '2026-10-26T22:00:00.000Z'));
    await timeboxes.settled();
    const [ev1, ev2, ev3] = ['b1', 'b2', 'b3'].map((id) => planner.state.blocks[id]!.google!.eventId);
    google.calls.length = 0;
    // b1 moved in Google; b2 deleted there; b3 moved to tomorrow, so it is missing from today's read.
    google.events.delete(ev2!);
    google.events.get(ev3!)!.timebox = { ...google.events.get(ev3!)!.timebox, start: '2026-10-27T16:00:00.000Z', end: '2026-10-27T17:00:00.000Z' };
    const applied = await timeboxes.reconcile(reads([{ blockId: 'b1', eventId: ev1!, start: '2026-10-26T16:00:00.000Z', end: '2026-10-26T17:30:00.000Z' }]), ...range);
    expect(applied).toBe(3);
    expect(planner.state.blocks.b1).toMatchObject({ start: '2026-10-26T16:00:00.000Z', end: '2026-10-26T17:30:00.000Z' });
    expect(planner.state.blocks.b2).toBeUndefined();
    expect(planner.state.blocks.b3).toMatchObject({ start: '2026-10-27T16:00:00.000Z' });
    await timeboxes.settled();
    // What came from Google is not sent back to it.
    expect(google.calls).toEqual([]);
  });

  test('more sessions missing from a read than it asks Google about: each has its turn, ten at a time, the longest unasked first', async () => {
    const { planner, google, timeboxes, run } = await setup();
    const ids = Array.from({ length: 12 }, (_, n) => `b${n + 1}`);
    run(...ids.map((id, n) => block(id, `2026-10-26T${String(8 + n).padStart(2, '0')}:00:00.000Z`, `2026-10-26T${String(8 + n).padStart(2, '0')}:30:00.000Z`)));
    await timeboxes.settled();
    const events = ids.map((id) => planner.state.blocks[id]!.google!.eventId);
    // The first ten's events do not read (Google fails on them); the last two were deleted in Google.
    google.events.delete(events[10]!);
    google.events.delete(events[11]!);
    const asked: string[] = [];
    const event = google.event.bind(google);
    google.event = async (account, calendarId, eventId) => {
      asked.push(eventId);
      if (events.indexOf(eventId) < 10) throw new GoogleError(500, 'Google answered HTTP 500');
      return event(account, calendarId, eventId);
    };
    expect(await timeboxes.reconcile(reads([]), ...range)).toBe(0);
    expect(asked).toEqual(events.slice(0, 10));
    // The next read asks about the two not asked about yet first: they were deleted there, so here too.
    expect(await timeboxes.reconcile(reads([]), ...range)).toBe(2);
    expect(asked.slice(10, 12).sort()).toEqual(events.slice(10).sort());
    expect(['b11', 'b12'].filter((id) => planner.state.blocks[id])).toEqual([]);
  });

  test('a read older than the last write here is not believed', async () => {
    const { planner, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    await timeboxes.settled();
    const eventId = planner.state.blocks.b1!.google!.eventId;
    const stale = reads([{ blockId: 'b1', eventId, start: '2026-10-26T10:00:00.000Z', end: '2026-10-26T11:00:00.000Z' }], Date.now() - 5000);
    expect(await timeboxes.reconcile(stale, ...range)).toBe(0);
    expect(planner.state.blocks.b1!.start).toBe('2026-10-26T17:00:00.000Z');
  });

  test('the calendars to read are the chosen one and those linked sessions are in', async () => {
    const { planner, timeboxes, run } = await setup();
    run(block('b1', '2026-10-26T17:00:00.000Z', '2026-10-26T18:00:00.000Z'));
    await timeboxes.settled();
    run({ type: 'settings.updated', patch: { googleTimebox: { account: ME, calendarId: 'work' } } });
    expect(timeboxes.calendarsFor(planner.state, ...range)).toEqual([{ account: ME, calendarId: 'work' }, { account: ME, calendarId: 'primary' }]);
  });
});

describe('reading Google calendars', () => {
  test('visible calendars give events; the others only their sessions; reads are kept a while', async () => {
    const asked: string[] = [];
    const reader = new GoogleCalendars({
      events: async (account, calendarId, _min, _max, _zone, subscriptionId) => {
        asked.push(calendarId);
        if (calendarId === 'broken') throw new Error('Google answered HTTP 500');
        return {
          events: [{ id: `${subscriptionId}:e`, calendarId: subscriptionId, title: 'Meeting', location: '', start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z', allDay: false, busy: true }],
          sessions: [{ blockId: 'b1', eventId: `${calendarId}-s`, start: '2026-10-26T19:00:00.000Z', end: '2026-10-26T20:00:00.000Z' }],
        };
      },
    });
    const google = (id: string, calendarId: string, visible = true) => ({ id, name: id, url: 'https://calendar.google.com/', color: '#4285f4', visible, google: { account: ME, calendarId } });
    const subscriptions = [google('s1', 'primary'), google('s2', 'hidden', false), google('s3', 'broken'), { id: 's4', name: 'ICS', url: 'https://x/a.ics', color: '#000000', visible: true }];
    const first = await reader.read(subscriptions, [{ account: ME, calendarId: 'work' }], 'a', 'b', 'UTC', false);
    expect(first.events.map((event) => event.id)).toEqual(['s1:e']);
    expect(first.errors).toEqual([{ calendarId: 's3', message: 'Google answered HTTP 500' }]);
    expect([...first.reads.keys()].sort()).toEqual([calendarKey(ME, 'primary'), calendarKey(ME, 'work')]);
    expect(asked.sort()).toEqual(['broken', 'primary', 'work']);
    await reader.read(subscriptions, [{ account: ME, calendarId: 'work' }], 'a', 'b', 'UTC', false);
    expect(asked).toHaveLength(4);
    await reader.read(subscriptions, [], 'a', 'b', 'UTC', true);
    expect(asked).toHaveLength(6);
  });
});

describe('Google tasks read for the calendar', () => {
  test('a read begun before a write is answered but not kept, so the next read has what was written', async () => {
    let reads = 0;
    let release = () => {};
    const data = {
      dueTasks: async () => {
        reads++;
        if (reads === 1) await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
      tasksById: async () => [],
    };
    const due = new GoogleDueTasks(data);
    const first = due.read([ME], '2026-10-26', '2026-11-01', false);
    // A task is made while the first read is out (the next occurrence of a repeating one).
    due.forget();
    release();
    await first;
    await due.read([ME], '2026-10-26', '2026-11-01', false);
    expect(reads).toBe(2);
    // That one began after the write: it is kept a while.
    await due.read([ME], '2026-10-26', '2026-11-01', false);
    expect(reads).toBe(2);
  });
});
