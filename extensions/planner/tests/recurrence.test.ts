import { describe, expect, test } from 'bun:test';
import { describeRule, instanceId, occursOn, planInstances } from '../src/domain/recurrence.ts';
import { planRollover } from '../src/domain/rollover.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { tasksForDay } from '../src/domain/selectors.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import type { PlannerState } from '../src/domain/types.ts';

describe('rules', () => {
  test('daily, weekdays, weekly, monthly, yearly', () => {
    expect(occursOn({ freq: 'daily', interval: 2 }, '2026-10-20', '2026-10-24')).toBe(true);
    expect(occursOn({ freq: 'daily', interval: 2 }, '2026-10-20', '2026-10-23')).toBe(false);
    expect(occursOn({ freq: 'daily', interval: 1, weekdays: [1, 2, 3, 4, 5] }, '2026-10-19', '2026-10-24')).toBe(false);
    expect(occursOn({ freq: 'daily', interval: 1, weekdays: [1, 2, 3, 4, 5] }, '2026-10-19', '2026-10-23')).toBe(true);
    const biweekly = { freq: 'weekly' as const, interval: 2, weekdays: [1, 3] };
    expect(['2026-10-19', '2026-10-21', '2026-10-26', '2026-11-02', '2026-11-04'].map((date) => occursOn(biweekly, '2026-10-19', date))).toEqual([true, true, false, true, true]);
    expect(occursOn({ freq: 'monthly', interval: 1, monthDay: 31 }, '2026-01-31', '2026-02-28')).toBe(true);
    expect(occursOn({ freq: 'monthly', interval: 1, monthDay: -1 }, '2026-01-31', '2026-04-30')).toBe(true);
    expect(occursOn({ freq: 'monthly', interval: 3 }, '2026-01-15', '2026-04-15')).toBe(true);
    expect(occursOn({ freq: 'monthly', interval: 3 }, '2026-01-15', '2026-03-15')).toBe(false);
    expect(occursOn({ freq: 'yearly', interval: 1 }, '2024-10-24', '2026-10-24')).toBe(true);
    expect(occursOn({ freq: 'daily', interval: 1 }, '2026-10-24', '2026-10-23')).toBe(false);
  });
  test('descriptions', () => {
    expect(describeRule({ freq: 'daily', interval: 1, weekdays: [1, 2, 3, 4, 5] }, '2026-10-19')).toBe('Every weekday');
    expect(describeRule({ freq: 'weekly', interval: 2, weekdays: [3, 1] }, '2026-10-19')).toBe('Every 2 weeks on Mon, Wed');
    expect(describeRule({ freq: 'monthly', interval: 1, monthDay: 22 }, '2026-10-22')).toBe('Every month on the 22nd');
    expect(describeRule({ freq: 'yearly', interval: 1 }, '2026-10-24')).toBe('Every year on October 24');
  });
});

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const template = { title: 'Inbox zero', notes: '', plannedMinutes: 15, priority: null, channelId: null, subtasks: ['Email', 'Slack'] };
const withSeries = (): PlannerState =>
  foldEvents([
    ev({ type: 'task.created', task: { id: 'first', title: 'Inbox zero', placement: { kind: 'day', date: '2026-10-22' }, position: 1, plannedMinutes: 15 } }),
    ev({ type: 'series.created', series: { id: 's1', rule: { freq: 'daily', interval: 1 }, startDate: '2026-10-22', template }, taskId: 'first' }),
  ]);

describe('instances', () => {
  test('the source task becomes the first instance; the horizon fills from today', () => {
    const state = withSeries();
    expect(state.tasks.first!.recurrence).toEqual({ seriesId: 's1', date: '2026-10-22' });
    const planned = planInstances(state, '2026-10-24', 3);
    expect(planned.map((task) => task.placement.kind === 'day' && task.placement.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(planned[0]!.id).toBe(instanceId('s1', '2026-10-24'));
    expect(planned[0]!.subtasks!.map((subtask) => subtask.title)).toEqual(['Email', 'Slack']);
  });
  test('creating is idempotent, a deleted instance stays deleted, stopping ends the series', () => {
    let state = withSeries();
    state = applyEvents(state, [ev({ type: 'tasks.recurred', instances: planInstances(state, '2026-10-24', 2) })]);
    expect(planInstances(state, '2026-10-24', 2)).toHaveLength(0);
    state = applyEvents(state, [ev({ type: 'task.deleted', taskId: instanceId('s1', '2026-10-25') })]);
    expect(planInstances(state, '2026-10-24', 2)).toHaveLength(0);
    state = applyEvents(state, [ev({ type: 'series.stopped', seriesId: 's1', from: '2026-10-28' })]);
    expect(planInstances(state, '2026-10-24', 7).map((task) => task.recurrence!.date)).toEqual(['2026-10-27']);
  });
  test('an untouched old instance gives way to today\'s; an edited one rolls over', () => {
    let state = withSeries();
    state = applyEvents(state, [ev({ type: 'tasks.recurred', instances: planInstances(state, '2026-10-23', 0) })]);
    state = applyEvents(state, [ev({ type: 'task.updated', taskId: instanceId('s1', '2026-10-23'), patch: { notes: 'started on this' } })]);
    state = applyEvents(state, [ev({ type: 'tasks.recurred', instances: planInstances(state, '2026-10-24', 0) })]);
    const rollover = planRollover(state, '2026-10-24')!;
    expect(rollover.superseded).toEqual(['first']);
    expect(rollover.moved.map((item) => item.taskId)).toEqual([instanceId('s1', '2026-10-23')]);
    state = applyEvents(state, [ev(rollover)]);
    expect(state.tasks.first!.deletedAt).not.toBeNull();
    expect(tasksForDay(state, '2026-10-24').map((task) => task.id)).toEqual([instanceId('s1', '2026-10-23'), instanceId('s1', '2026-10-24')]);
  });
  test('series validation', () => {
    const state = withSeries();
    expect(validateCommand({ cmd: 'a', type: 'series.created', series: { id: 's2', rule: { freq: 'weekly', interval: 1, weekdays: [9] }, startDate: '2026-10-24', template }, taskId: 'first' }, state)).toBe('rule is invalid');
    expect(validateCommand({ cmd: 'b', type: 'series.created', series: { id: 's2', rule: { freq: 'daily', interval: 1 }, startDate: '2026-10-24', template }, taskId: 'first' }, state)).toBe('task already repeats');
    expect(validateCommand({ cmd: 'c', type: 'tasks.recurred', instances: [] }, state)).toContain('service only');
    expect(validateCommand({ cmd: 'd', type: 'task.created', task: { id: 'x', title: 'X', placement: { kind: 'day', date: '2026-10-24' }, position: 1, recurrence: { seriesId: 's1', date: '2026-10-24' } } }, state)).toBe('recurrence is set through a series');
    expect(validateCommand({ cmd: 'e', type: 'series.updated', seriesId: 's1', patch: { template: { title: 'Inbox', plannedMinutes: 20 } } }, state)).toBeNull();
  });
});
