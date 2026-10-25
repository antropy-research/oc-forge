import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { actualIsFromPlan, actualMinutes, entriesFor, trackedMinutes } from '../src/domain/selectors.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import type { PlannerState } from '../src/domain/types.ts';

const at = (iso: string, body: EventBody, id = `e-${iso}`): PlannerEvent => ({ v: 1, id, at: iso, ...body }) as PlannerEvent;
const base = (): PlannerState =>
  foldEvents([
    at('2026-10-24T15:00:00.000Z', { type: 'task.created', task: { id: 'a', title: 'A', placement: { kind: 'day', date: '2026-10-24' }, position: 1, plannedMinutes: 30 } }),
    at('2026-10-24T15:00:01.000Z', { type: 'task.created', task: { id: 'b', title: 'B', placement: { kind: 'day', date: '2026-10-24' }, position: 2, plannedMinutes: 45 } }),
  ]);

describe('timer', () => {
  test('start and stop record one entry', () => {
    const state = applyEvents(base(), [
      at('2026-10-24T16:00:00.000Z', { type: 'timer.started', taskId: 'a' }),
      at('2026-10-24T16:25:00.000Z', { type: 'timer.stopped' }),
    ]);
    expect(state.timer).toBeNull();
    expect(entriesFor(state, 'a')).toHaveLength(1);
    expect(trackedMinutes(state, 'a')).toBe(25);
  });

  test('only one timer runs: starting another task closes the first', () => {
    const state = applyEvents(base(), [
      at('2026-10-24T16:00:00.000Z', { type: 'timer.started', taskId: 'a' }),
      at('2026-10-24T16:10:00.000Z', { type: 'timer.started', taskId: 'b' }),
    ]);
    expect(state.timer).toEqual({ taskId: 'b', startedAt: '2026-10-24T16:10:00.000Z' });
    expect(trackedMinutes(state, 'a')).toBe(10);
    expect(trackedMinutes(state, 'b', Date.parse('2026-10-24T16:16:00.000Z'))).toBe(6);
  });

  test('starting the running task again is a no-op', () => {
    const state = applyEvents(base(), [
      at('2026-10-24T16:00:00.000Z', { type: 'timer.started', taskId: 'a' }),
      at('2026-10-24T16:05:00.000Z', { type: 'timer.started', taskId: 'a' }),
    ]);
    expect(state.timer?.startedAt).toBe('2026-10-24T16:00:00.000Z');
    expect(entriesFor(state, 'a')).toHaveLength(0);
  });

  test('completing, deleting or archiving the task stops its timer', () => {
    for (const body of [
      { type: 'task.completed', taskId: 'a', on: '2026-10-24' },
      { type: 'task.deleted', taskId: 'a' },
      { type: 'task.archived', taskId: 'a' },
    ] as EventBody[]) {
      const state = applyEvents(base(), [at('2026-10-24T16:00:00.000Z', { type: 'timer.started', taskId: 'a' }), at('2026-10-24T16:20:00.000Z', body)]);
      expect(state.timer).toBeNull();
      expect(trackedMinutes(state, 'a')).toBe(20);
    }
  });

  test('manual time and deletion', () => {
    let state = applyEvents(base(), [at('2026-10-24T17:00:00.000Z', { type: 'time.logged', entry: { id: 'm1', taskId: 'b', start: '2026-10-24T09:00:00.000Z', end: '2026-10-24T09:40:00.000Z' } })]);
    expect(trackedMinutes(state, 'b')).toBe(40);
    expect(entriesFor(state, 'b')[0]!.source).toBe('manual');
    state = applyEvents(state, [at('2026-10-24T17:01:00.000Z', { type: 'time.deleted', entryId: 'm1' })]);
    expect(trackedMinutes(state, 'b')).toBe(0);
  });
});

describe('actual time', () => {
  test('planned counts as actual for a task completed without tracking, when enabled', () => {
    let state = applyEvents(base(), [at('2026-10-24T16:00:00.000Z', { type: 'task.completed', taskId: 'b', on: '2026-10-24' })]);
    expect(actualMinutes(state, state.tasks.b!)).toBe(45);
    expect(actualIsFromPlan(state, state.tasks.b!)).toBe(true);
    state = applyEvents(state, [at('2026-10-24T16:00:01.000Z', { type: 'settings.updated', patch: { plannedAsActual: false } })]);
    expect(actualMinutes(state, state.tasks.b!)).toBe(0);
  });
  test('tracked time wins over the plan', () => {
    const state = applyEvents(base(), [
      at('2026-10-24T16:00:00.000Z', { type: 'timer.started', taskId: 'b' }),
      at('2026-10-24T16:12:00.000Z', { type: 'task.completed', taskId: 'b', on: '2026-10-24' }),
    ]);
    expect(actualMinutes(state, state.tasks.b!)).toBe(12);
    expect(actualIsFromPlan(state, state.tasks.b!)).toBe(false);
  });
});

describe('time validation', () => {
  const state = base();
  test('rejects bad entries', () => {
    expect(validateCommand({ cmd: 'x', type: 'time.logged', entry: { id: 'q', taskId: 'a', start: '2026-10-24T10:00:00Z', end: '2026-10-24T09:00:00Z' } }, state)).toContain('between 0 and 24 hours');
    expect(validateCommand({ cmd: 'y', type: 'time.logged', entry: { id: 'q', taskId: 'zz', start: '2026-10-24T09:00:00Z', end: '2026-10-24T10:00:00Z' } }, state)).toBe('unknown task');
    expect(validateCommand({ cmd: 'z', type: 'time.deleted', entryId: 'nope' }, state)).toBe('unknown entry');
    expect(validateCommand({ cmd: 'w', type: 'timer.started', taskId: 'a' }, state)).toBeNull();
  });
});
