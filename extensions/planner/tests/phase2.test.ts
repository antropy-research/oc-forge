import { describe, expect, test } from 'bun:test';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { inverseOfBatch } from '../src/domain/undo.ts';
import { reorderCommands, sortTasks } from '../src/domain/sort.ts';
import { describe as describeEvent, timeAgo, touchesTask } from '../src/domain/activity.ts';
import { tasksForDay } from '../src/domain/selectors.ts';
import type { EventBody, PlannerEvent } from '../src/domain/events.ts';
import type { PlannerState } from '../src/domain/types.ts';

let clock = Date.parse('2026-10-24T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const apply = (state: PlannerState, bodies: EventBody[]) => applyEvents(state, bodies.map(ev));

const base = () =>
  foldEvents([
    ev({ type: 'task.created', task: { id: 'a', title: 'A', placement: { kind: 'day', date: '2026-10-24' }, position: 1024, plannedMinutes: 15, priority: 'low' } }),
    ev({ type: 'task.created', task: { id: 'b', title: 'B', placement: { kind: 'day', date: '2026-10-24' }, position: 2048, plannedMinutes: 60, priority: 'urgent' } }),
    ev({ type: 'task.created', task: { id: 'c', title: 'C', placement: { kind: 'day', date: '2026-10-24' }, position: 3072 } }),
  ]);

const strip = (state: PlannerState) =>
  Object.fromEntries(Object.values(state.tasks).map((task) => [task.id, { placement: task.placement, position: task.position, title: task.title, deletedAt: task.deletedAt, archivedAt: task.archivedAt, completedOn: task.completedOn, priority: task.priority, subtasks: task.subtasks }]));

describe('undo', () => {
  test('reverses moves, deletes, completions and edits back to the original state', () => {
    const before = base();
    const batches: EventBody[][] = [
      [{ type: 'task.moved', taskId: 'a', placement: { kind: 'backlog', bucket: 'someday' }, position: 5 }],
      [{ type: 'task.deleted', taskId: 'b' }],
      [{ type: 'task.completed', taskId: 'c', on: '2026-10-24' }],
      [{ type: 'task.updated', taskId: 'a', patch: { title: 'A2', priority: 'high' } }, { type: 'subtask.added', taskId: 'a', subtask: { id: 's', title: 'step', done: false } }],
      [{ type: 'task.archived', taskId: 'c' }, { type: 'task.moved', taskId: 'b', placement: { kind: 'day', date: '2026-10-25' }, position: 1 }],
    ];
    for (const batch of batches) {
      const inverse = inverseOfBatch(before, batch);
      expect(inverse).not.toBeNull();
      const after = apply(apply(before, batch), inverse!);
      expect(strip(after)).toEqual(strip(before));
    }
  });
  test('channel changes are not undoable', () => {
    expect(inverseOfBatch(base(), [{ type: 'channel.deleted', channelId: 'work' }])).toBeNull();
  });
});

describe('auto-sort', () => {
  test('priority, planned time, completed last; stable ties', () => {
    let state = base();
    expect(sortTasks(tasksForDay(state, '2026-10-24'), 'priority').map((task) => task.id)).toEqual(['b', 'a', 'c']);
    expect(sortTasks(tasksForDay(state, '2026-10-24'), 'planned').map((task) => task.id)).toEqual(['b', 'a', 'c']);
    state = apply(state, [{ type: 'task.completed', taskId: 'a', on: '2026-10-24' }]);
    const ordered = sortTasks(tasksForDay(state, '2026-10-24'), 'completed-last');
    expect(ordered.map((task) => task.id)).toEqual(['b', 'c', 'a']);
    const sorted = apply(state, reorderCommands(ordered));
    expect(tasksForDay(sorted, '2026-10-24').map((task) => task.id)).toEqual(['b', 'c', 'a']);
  });
  test('tasks already in place produce no moves', () => {
    const state = base();
    expect(reorderCommands(tasksForDay(state, '2026-10-24'))).toHaveLength(0);
  });
});

describe('activity', () => {
  test('describes a task history', () => {
    const state = base();
    const created = ev({ type: 'task.created', task: { id: 'x', title: 'X', placement: { kind: 'backlog', bucket: 'next-weeks' }, position: 1 } });
    const moved = ev({ type: 'task.moved', taskId: 'x', placement: { kind: 'day', date: '2026-10-27' }, position: 1 });
    const planned = ev({ type: 'task.updated', taskId: 'x', patch: { plannedMinutes: 45, dueDate: '2026-10-30' } });
    const rolled = ev({ type: 'tasks.rolledOver', date: '2026-10-28', moved: [{ taskId: 'x', from: '2026-10-27', position: 1 }], archived: [] });
    expect(describeEvent(created, 'x', state)).toBe('created this in someday in the next week or two');
    expect(describeEvent(moved, 'x', state)).toBe('moved this to October 27');
    expect(describeEvent(planned, 'x', state)).toBe('set planned time to 0:45, set the due date to October 30');
    expect(describeEvent(rolled, 'x', state)).toBe('rolled this over to October 28');
    expect(touchesTask(rolled, 'x')).toBe(true);
    expect(touchesTask(rolled, 'a')).toBe(false);
  });
  test('relative times', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(timeAgo('2026-10-24T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-24T11:15:00Z', now)).toBe('45m ago');
    expect(timeAgo('2026-10-24T02:00:00Z', now)).toBe('10h ago');
    expect(timeAgo('2026-09-20T12:00:00Z', now)).toBe('1mo ago');
  });
});
