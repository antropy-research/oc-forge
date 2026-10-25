// Undo: the commands that reverse a batch, computed against the state before it ran.
import type { EventBody, PlannerEvent, TaskPatch } from './events.ts';
import { applyEvents } from './reducer.ts';
import type { PlannerState } from './types.ts';

/** Restore a task's day, order and planned time after a session change moved or resized it. */
const restoreTask = (state: PlannerState, taskId: string): EventBody[] => {
  const task = state.tasks[taskId];
  if (!task) return [];
  return [
    { type: 'task.moved', taskId, placement: task.placement, position: task.position },
    { type: 'task.updated', taskId, patch: { plannedMinutes: task.plannedMinutes } },
  ];
};

const inverseOne = (state: PlannerState, body: EventBody): EventBody[] | null => {
  if (body.type === 'task.created') return [{ type: 'task.deleted', taskId: body.task.id }];
  if (body.type === 'block.created') return [{ type: 'block.deleted', blockId: body.block.id }, ...restoreTask(state, body.block.taskId)];
  if (body.type === 'block.updated') {
    const block = state.blocks[body.blockId];
    return block ? [{ type: 'block.updated', blockId: block.id, start: block.start, end: block.end }, ...restoreTask(state, block.taskId)] : null;
  }
  if (body.type === 'block.deleted') {
    const block = state.blocks[body.blockId];
    return block ? [{ type: 'block.created', block: { ...block } }, ...restoreTask(state, block.taskId)] : null;
  }
  if (!('taskId' in body)) return null;
  const task = state.tasks[body.taskId];
  if (!task) return null;
  switch (body.type) {
    case 'task.deleted':
    case 'task.archived':
      return [{ type: 'task.restored', taskId: task.id }];
    case 'task.restored':
      if (task.deletedAt) return [{ type: 'task.deleted', taskId: task.id }];
      if (task.archivedAt) return [{ type: 'task.archived', taskId: task.id }];
      return null;
    case 'task.completed':
      return [{ type: 'task.reopened', taskId: task.id }];
    case 'task.reopened':
      return task.completedOn ? [{ type: 'task.completed', taskId: task.id, on: task.completedOn }] : null;
    case 'task.moved': {
      const back: EventBody[] = [{ type: 'task.moved', taskId: task.id, placement: task.placement, position: task.position }];
      if (task.archivedAt) back.push({ type: 'task.archived', taskId: task.id });
      return back;
    }
    case 'task.updated': {
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(body.patch)) patch[key] = task[key as keyof typeof task];
      return [{ type: 'task.updated', taskId: task.id, patch: patch as TaskPatch }];
    }
    default:
      return null;
  }
};

/**
 * Reverse a batch: each step's inverse is taken against the state the earlier
 * steps produced, and the inverses run in reverse order. Null if any step
 * cannot be undone.
 */
export const inverseOfBatch = (state: PlannerState, bodies: readonly EventBody[]): EventBody[] | null => {
  const inverses: EventBody[][] = [];
  let working = state;
  for (const [index, body] of bodies.entries()) {
    const inverse = inverseOne(working, body);
    if (!inverse) return null;
    inverses.push(inverse);
    working = applyEvents(working, [{ v: 1, id: `undo-${index}`, at: new Date(0).toISOString(), ...body } as PlannerEvent]);
  }
  return inverses.reverse().flat();
};
