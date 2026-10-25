import { describe, expect, test } from 'bun:test';
import { addDays, daysBetween, formatMinutes, isDateKey, nextWeekday, startOfWeek, todayIn } from '../src/domain/dates.ts';
import { parseDuration, parseQuickAdd, parseWhen } from '../src/domain/quickAdd.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { planRollover } from '../src/domain/rollover.ts';
import { channelByName, positionAt, tasksForDay, plannedTotal, workloadTotal } from '../src/domain/selectors.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { emptyState, type PlannerState } from '../src/domain/types.ts';

let clock = Date.parse('2026-10-20T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const create = (id: string, title: string, date: string, position = 1024, plannedMinutes: number | null = null) =>
  ev({ type: 'task.created', task: { id, title, placement: { kind: 'day', date }, position, plannedMinutes } });

describe('dates', () => {
  test('today follows the timezone, not UTC', () => {
    const instant = new Date('2026-10-25T02:30:00Z');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-24');
    expect(todayIn('Asia/Shanghai', instant)).toBe('2026-10-25');
  });
  test('day arithmetic ignores DST transitions', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(daysBetween('2026-10-20', '2026-10-24')).toBe(4);
  });
  test('weeks and weekdays', () => {
    expect(startOfWeek('2026-10-24', 1)).toBe('2026-10-19');
    expect(startOfWeek('2026-10-24', 0)).toBe('2026-10-18');
    expect(nextWeekday('2026-10-24', 1)).toBe('2026-10-26');
    expect(nextWeekday('2026-10-26', 1)).toBe('2026-11-02');
  });
  test('validation and formatting', () => {
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(formatMinutes(20)).toBe('0:20');
    expect(formatMinutes(135)).toBe('2:15');
  });
});

describe('quick add', () => {
  const today = '2026-10-24';
  test('durations', () => {
    expect(parseDuration('30')).toBe(30);
    expect(parseDuration('30min')).toBe(30);
    expect(parseDuration('1h')).toBe(60);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('1:15')).toBe(75);
    expect(parseDuration('abc')).toBeNull();
  });
  test('dates and buckets', () => {
    expect(parseWhen('tomorrow', today)).toEqual({ kind: 'day', date: '2026-10-25' });
    expect(parseWhen('mon', today)).toEqual({ kind: 'day', date: '2026-10-26' });
    expect(parseWhen('nextweek', today)).toEqual({ kind: 'day', date: '2026-10-26' });
    expect(parseWhen('10/30', today)).toEqual({ kind: 'day', date: '2026-10-30' });
    expect(parseWhen('oct-30', today)).toEqual({ kind: 'day', date: '2026-10-30' });
    expect(parseWhen('jan5', today)).toEqual({ kind: 'day', date: '2027-01-05' });
    expect(parseWhen('backlog', today)).toEqual({ kind: 'backlog', bucket: 'next-weeks' });
    expect(parseWhen('someday', today)).toEqual({ kind: 'backlog', bucket: 'someday' });
    expect(parseWhen('banana', today)).toBeNull();
  });
  test('full line', () => {
    const parsed = parseQuickAdd('Write weekly report ~45m @oct 30 #work !high $ship', today);
    expect(parsed).toEqual({ title: 'Write weekly report', plannedMinutes: 45, placement: { kind: 'day', date: '2026-10-30' }, channel: 'work', priority: 'high', objective: 'ship' });
    expect(parseQuickAdd('预约 hk 诊所 ~15m #personal', today).channel).toBe('personal');
    expect(parseQuickAdd('email@domain.com ~ later', today).title).toBe('email@domain.com ~ later');
  });
});

describe('reducer', () => {
  test('create, edit, complete, reopen, delete', () => {
    let state = foldEvents([create('a', ' Draft ', '2026-10-20', 1024, 30)]);
    expect(state.tasks.a!.title).toBe('Draft');
    state = applyEvents(state, [ev({ type: 'task.updated', taskId: 'a', patch: { title: 'Draft plan', plannedMinutes: 45 } })]);
    state = applyEvents(state, [ev({ type: 'task.completed', taskId: 'a', on: '2026-10-20' })]);
    expect(state.tasks.a).toMatchObject({ title: 'Draft plan', plannedMinutes: 45, completedOn: '2026-10-20' });
    state = applyEvents(state, [ev({ type: 'task.reopened', taskId: 'a' })]);
    expect(state.tasks.a!.completedAt).toBeNull();
    state = applyEvents(state, [ev({ type: 'task.deleted', taskId: 'a' })]);
    expect(tasksForDay(state, '2026-10-20')).toHaveLength(0);
  });
  test('events for an unknown task are ignored', () => {
    const state = foldEvents([ev({ type: 'task.completed', taskId: 'ghost', on: '2026-10-20' })]);
    expect(state.tasks).toEqual({});
    expect(state.version).toBe(1);
  });
  test('positions order a day and drops land where aimed', () => {
    const state = foldEvents([create('a', 'A', '2026-10-20', 1024, 30), create('b', 'B', '2026-10-20', 2048, 15), create('c', 'C', '2026-10-20', 3072)]);
    expect(tasksForDay(state, '2026-10-20').map((task) => task.id)).toEqual(['a', 'b', 'c']);
    expect(plannedTotal(tasksForDay(state, '2026-10-20'))).toBe(45);
    const position = positionAt(state, { kind: 'day', date: '2026-10-20' }, 0, 'c');
    const moved = applyEvents(state, [ev({ type: 'task.moved', taskId: 'c', placement: { kind: 'day', date: '2026-10-20' }, position })]);
    expect(tasksForDay(moved, '2026-10-20').map((task) => task.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('rollover', () => {
  const base = (): PlannerState => foldEvents([
    create('old', 'Old', '2026-10-20', 1024),
    create('y1', 'Yesterday 1', '2026-10-23', 1024),
    create('y2', 'Yesterday 2', '2026-10-23', 2048),
    create('done', 'Done', '2026-10-23', 3072),
    ev({ type: 'task.completed', taskId: 'done', on: '2026-10-23' }),
    create('today', 'Planned today', '2026-10-24', 1024),
    ev({ type: 'task.created', task: { id: 'bl', title: 'Backlog', placement: { kind: 'backlog', bucket: 'someday' }, position: 1024 } }),
  ]);

  test('carries open past work to the top of today, oldest first', () => {
    const body = planRollover(base(), '2026-10-24')!;
    expect(body.moved.map((item) => item.taskId)).toEqual(['old', 'y1', 'y2']);
    const state = applyEvents(base(), [ev(body)]);
    expect(tasksForDay(state, '2026-10-24').map((task) => task.id)).toEqual(['old', 'y1', 'y2', 'today']);
    expect(state.tasks.old!.rolloverCount).toBe(4);
    expect(state.tasks.y1!.rolloverCount).toBe(1);
    expect(state.tasks.done!.placement).toEqual({ kind: 'day', date: '2026-10-23' });
    expect(state.tasks.bl!.placement.kind).toBe('backlog');
    expect(planRollover(state, '2026-10-24')).toBeNull();
  });

  test('archives a task that reaches the rollover threshold', () => {
    const state = applyEvents(base(), [ev({ type: 'settings.updated', patch: { archiveAfterRollovers: 3 } })]);
    const body = planRollover(state, '2026-10-24')!;
    expect(body.archived).toEqual(['old']);
    expect(body.moved.map((item) => item.taskId)).toEqual(['y1', 'y2']);
  });

  test('a manual move resets the count', () => {
    let state = applyEvents(base(), [ev(planRollover(base(), '2026-10-24')!)]);
    state = applyEvents(state, [ev({ type: 'task.moved', taskId: 'old', placement: { kind: 'day', date: '2026-10-25' }, position: 1024 })]);
    expect(state.tasks.old!.rolloverCount).toBe(0);
  });
});

describe('command validation', () => {
  const state = foldEvents([create('a', 'A', '2026-10-20')]);
  test('accepts well-formed commands', () => {
    expect(validateCommand({ cmd: 'c1', type: 'task.moved', taskId: 'a', placement: { kind: 'backlog', bucket: 'never' }, position: 5 }, state)).toBeNull();
    expect(validateCommand({ cmd: 'c2', type: 'settings.updated', patch: { timezone: 'America/Los_Angeles' } }, state)).toBeNull();
  });
  test('rejects bad input', () => {
    expect(validateCommand({ cmd: 'c3', type: 'tasks.rolledOver', date: '2026-10-24', moved: [], archived: [] }, state)).toContain('service only');
    expect(validateCommand({ cmd: 'c4', type: 'task.completed', taskId: 'zzz', on: '2026-10-20' }, state)).toBe('unknown task');
    expect(validateCommand({ cmd: 'c5', type: 'task.moved', taskId: 'a', placement: { kind: 'day', date: '2026-13-01' }, position: 1 }, state)).toBe('placement is invalid');
    expect(validateCommand({ cmd: 'c6', type: 'settings.updated', patch: { timezone: 'Mars/Base' } }, state)).toContain('IANA');
    expect(validateCommand({ cmd: 'c7', type: 'task.created', task: { id: 'a', title: 'dup', placement: { kind: 'day', date: '2026-10-20' }, position: 1 } }, state)).toBe('task id already exists');
    expect(validateCommand({ type: 'task.reopened', taskId: 'a' }, emptyState())).toBe('command needs a cmd id');
  });
});

describe('channels', () => {
  const state = foldEvents([
    ev({ type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } }),
    ev({ type: 'channel.created', channel: { id: 'personal', name: 'personal', color: '#1c7ed6', context: 'personal' } }),
    ev({ type: 'task.created', task: { id: 'w', title: 'Work', placement: { kind: 'day', date: '2026-10-24' }, position: 1, plannedMinutes: 60, channelId: 'work' } }),
    ev({ type: 'task.created', task: { id: 'p', title: 'Gym', placement: { kind: 'day', date: '2026-10-24' }, position: 2, plannedMinutes: 45, channelId: 'personal' } }),
    ev({ type: 'task.created', task: { id: 'n', title: 'No channel', placement: { kind: 'day', date: '2026-10-24' }, position: 3, plannedMinutes: 15 } }),
  ]);
  test('personal time stays out of the workload', () => {
    const day = tasksForDay(state, '2026-10-24');
    expect(plannedTotal(day)).toBe(120);
    expect(workloadTotal(state, day)).toBe(75);
  });
  test('lookup by name and delete keeps the tasks', () => {
    expect(channelByName(state, 'WORK')?.id).toBe('work');
    const after = applyEvents(state, [ev({ type: 'channel.deleted', channelId: 'work' })]);
    expect(after.tasks.w!.channelId).toBeNull();
    expect(after.tasks.w!.deletedAt).toBeNull();
    expect(channelByName(after, 'work')).toBeNull();
  });
  test('channel commands are validated', () => {
    expect(validateCommand({ cmd: 'x1', type: 'channel.created', channel: { id: 'w2', name: 'Work', color: '#000000', context: 'work' } }, state)).toBe('a channel with that name exists');
    expect(validateCommand({ cmd: 'x2', type: 'channel.created', channel: { id: 'r', name: 'research', color: '#2f9e44', context: 'work' } }, state)).toBeNull();
    expect(validateCommand({ cmd: 'x3', type: 'task.updated', taskId: 'n', patch: { channelId: 'nope' } }, state)).toBe('unknown channel');
    expect(validateCommand({ cmd: 'x4', type: 'task.updated', taskId: 'n', patch: { priority: 'high' } }, state)).toBeNull();
  });
});
