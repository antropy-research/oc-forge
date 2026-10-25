import { describe, expect, test } from 'bun:test';
import { expandEvents, parseDurationIcs, parseIcs, parseIcsTime } from '../src/domain/ics.ts';
import { instantAt, zonedDateMinutes } from '../src/domain/dates.ts';
import { findFreeSlot, layoutLanes } from '../src/domain/schedule.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { inverseOfBatch } from '../src/domain/undo.ts';
import { blocksFor, blocksOnDay, tasksForDay } from '../src/domain/selectors.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';

const LA = 'America/Los_Angeles';
const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe('zoned time', () => {
  test('round trip across the DST change', () => {
    expect(instantAt('2026-10-26', 600, LA)).toBe('2026-10-26T17:00:00.000Z');
    expect(instantAt('2026-11-02', 600, LA)).toBe('2026-11-02T18:00:00.000Z');
    expect(zonedDateMinutes('2026-11-02T18:00:00.000Z', LA)).toEqual({ date: '2026-11-02', minutes: 600 });
    expect(zonedDateMinutes('2026-10-25T06:30:00.000Z', LA).date).toBe('2026-10-24');
  });
});

describe('ics parsing', () => {
  test('times, durations and text', () => {
    expect(parseIcsTime('20261026T100000', { TZID: LA })).toEqual({ date: '2026-10-26', minutes: 600, zone: LA, allDay: false });
    expect(parseIcsTime('20261026T170000Z')).toMatchObject({ zone: 'UTC', minutes: 1020 });
    expect(parseIcsTime('20261027', { VALUE: 'DATE' })).toMatchObject({ allDay: true, date: '2026-10-27' });
    expect(parseIcsTime('20261026T100000', { TZID: 'Pacific Standard Time' })!.zone).toBe(LA);
    expect(parseDurationIcs('PT1H30M')).toBe(5_400_000);
    expect(parseDurationIcs('P1D')).toBe(86_400_000);
    const [event] = parseIcs(cal('BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261026T170000Z\r\nSUMMARY:Planning\\, Q4 review with a very long\r\n  title that folds\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT'));
    expect(event!.summary).toBe('Planning, Q4 review with a very long title that folds');
  });

  test('single, all-day, cancelled and free events', () => {
    const events = parseIcs(cal([
      'BEGIN:VEVENT\r\nUID:one\r\nDTSTART;TZID=America/Los_Angeles:20261026T100000\r\nDTEND;TZID=America/Los_Angeles:20261026T110000\r\nSUMMARY:Standup\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:allday\r\nDTSTART;VALUE=DATE:20261027\r\nDTEND;VALUE=DATE:20261028\r\nSUMMARY:Offsite\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:gone\r\nDTSTART:20261026T200000Z\r\nDURATION:PT30M\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:free\r\nDTSTART:20261026T210000Z\r\nDURATION:PT30M\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Hold\r\nEND:VEVENT',
    ].join('\r\n')));
    const out = expandEvents(events, 'c', '2026-10-26', '2026-10-27', LA);
    expect(out.map((event) => event.title)).toEqual(['Standup', 'Hold', 'Offsite']);
    expect(out[0]).toMatchObject({ start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:00:00.000Z', busy: true });
    expect(out[1]!.busy).toBe(false);
    expect(out[2]).toMatchObject({ allDay: true, start: '2026-10-27T07:00:00.000Z', busy: false });
  });

  test('weekly series keeps wall-clock time across DST, with exclusions and an override', () => {
    const events = parseIcs(cal([
      'BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=America/Los_Angeles:20261026T100000\r\nDTEND;TZID=America/Los_Angeles:20261026T103000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5\r\nEXDATE;TZID=America/Los_Angeles:20261028T100000\r\nSUMMARY:Sync\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:w\r\nRECURRENCE-ID;TZID=America/Los_Angeles:20261102T100000\r\nDTSTART;TZID=America/Los_Angeles:20261102T140000\r\nDTEND;TZID=America/Los_Angeles:20261102T143000\r\nSUMMARY:Sync (moved)\r\nEND:VEVENT',
    ].join('\r\n')));
    const out = expandEvents(events, 'c', '2026-10-25', '2026-11-30', LA);
    expect(out.map((event) => [zonedDateMinutes(event.start, LA).date, zonedDateMinutes(event.start, LA).minutes, event.title])).toEqual([
      ['2026-10-26', 600, 'Sync'],
      ['2026-11-02', 840, 'Sync (moved)'],
      ['2026-11-04', 600, 'Sync'],
      ['2026-11-09', 600, 'Sync'],
    ]);
    expect(out[2]!.start).toBe('2026-11-04T18:00:00.000Z');
  });

  test('monthly nth weekday, daily until, yearly', () => {
    const events = parseIcs(cal([
      'BEGIN:VEVENT\r\nUID:m\r\nDTSTART:20261013T160000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU\r\nSUMMARY:Board\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261026T150000Z\r\nDURATION:PT15M\r\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261101T000000Z\r\nSUMMARY:Pills\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:y\r\nDTSTART;VALUE=DATE:20201215\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Birthday\r\nEND:VEVENT',
    ].join('\r\n')));
    const out = expandEvents(events, 'c', '2026-10-25', '2026-12-31', 'UTC');
    expect(out.filter((event) => event.title === 'Board').map((event) => event.start.slice(0, 10))).toEqual(['2026-11-10', '2026-12-08']);
    expect(out.filter((event) => event.title === 'Pills').map((event) => event.start.slice(0, 10))).toEqual(['2026-10-26', '2026-10-28', '2026-10-30']);
    expect(out.filter((event) => event.title === 'Birthday').map((event) => event.start.slice(0, 10))).toEqual(['2026-12-15']);
  });
});

describe('free slots and lanes', () => {
  const day = '2026-10-26';
  const at = (minutes: number) => Date.parse(instantAt(day, minutes, LA));
  test('first gap inside working hours after now', () => {
    const busy = [{ start: at(540), end: at(600) }, { start: at(615), end: at(690) }];
    expect(findFreeSlot(day, LA, 540, 1080, 30, busy, at(0))).toEqual({ start: at(690), end: at(720) });
    expect(findFreeSlot(day, LA, 540, 1080, 15, busy, at(0))).toEqual({ start: at(600), end: at(615) });
    expect(findFreeSlot(day, LA, 540, 1080, 30, [], at(727))).toEqual({ start: at(735), end: at(765) });
    expect(findFreeSlot(day, LA, 540, 600, 90, [], at(0))).toBeNull();
  });
  test('overlapping items share lanes', () => {
    const lanes = layoutLanes([{ start: 0, end: 60 }, { start: 30, end: 90 }, { start: 100, end: 120 }]);
    expect(lanes.map((entry) => [entry.lane, entry.lanes])).toEqual([[0, 2], [1, 2], [0, 1]]);
  });
});

describe('working sessions', () => {
  let clock = Date.parse('2026-10-24T16:00:00Z');
  const ev = (body: EventBody): PlannerEvent => {
    clock += 1000;
    return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
  };
  const base = () => foldEvents([
    ev({ type: 'settings.updated', patch: { timezone: LA } }),
    ev({ type: 'task.created', task: { id: 't', title: 'Write', placement: { kind: 'backlog', bucket: 'someday' }, position: 1, plannedMinutes: 30 } }),
  ]);
  const block = (id: string, date: string, from: number, to: number) => ({ id, taskId: 't', start: instantAt(date, from, LA), end: instantAt(date, to, LA) });

  test('timeboxing schedules the task on that day and sets planned time from the sessions', () => {
    let state = applyEvents(base(), [ev({ type: 'block.created', block: block('b1', '2026-10-26', 600, 660) })]);
    expect(state.tasks.t!.placement).toEqual({ kind: 'day', date: '2026-10-26' });
    expect(state.tasks.t!.plannedMinutes).toBe(60);
    state = applyEvents(state, [ev({ type: 'block.created', block: block('b2', '2026-10-26', 900, 930) })]);
    expect(state.tasks.t!.plannedMinutes).toBe(90);
    expect(blocksOnDay(state, '2026-10-26').map((item) => item.id)).toEqual(['b1', 'b2']);
  });

  test('moving a session moves the task; moving the card drops the source-day session only', () => {
    let state = applyEvents(base(), [
      ev({ type: 'block.created', block: block('mon', '2026-10-26', 600, 660) }),
      ev({ type: 'block.created', block: block('tue', '2026-10-27', 600, 630) }),
    ]);
    expect(state.tasks.t!.placement).toEqual({ kind: 'day', date: '2026-10-27' });
    state = applyEvents(state, [ev({ type: 'block.updated', blockId: 'tue', start: instantAt('2026-10-28', 540, LA), end: instantAt('2026-10-28', 600, LA) })]);
    expect(state.tasks.t!.placement).toEqual({ kind: 'day', date: '2026-10-28' });
    expect(state.tasks.t!.plannedMinutes).toBe(120);
    state = applyEvents(state, [ev({ type: 'task.moved', taskId: 't', placement: { kind: 'day', date: '2026-10-29' }, position: 1 })]);
    expect(blocksFor(state, 't').map((item) => item.id)).toEqual(['mon']);
  });

  test('undoing a timebox restores the day and planned time', () => {
    const before = base();
    const batch: EventBody[] = [{ type: 'block.created', block: block('b1', '2026-10-26', 600, 690) }];
    const after = applyEvents(before, batch.map(ev));
    const restored = applyEvents(after, inverseOfBatch(before, batch)!.map(ev));
    expect(restored.tasks.t!.placement).toEqual({ kind: 'backlog', bucket: 'someday' });
    expect(restored.tasks.t!.plannedMinutes).toBe(30);
    expect(blocksFor(restored, 't')).toHaveLength(0);
    expect(tasksForDay(restored, '2026-10-26')).toHaveLength(0);
  });
});
