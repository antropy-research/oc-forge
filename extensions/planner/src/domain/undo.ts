// Undo: the commands that reverse a batch, computed against the state before it ran.
import type { EventBody, PlannerEvent, TaskPatch } from './events.ts';
import { applyEvents } from './reducer.ts';
import type { PlannerState } from './types.ts';

const inverseOne = (state: PlannerState, body: EventBody): EventBody[] | null => {
  if (body.type === 'task.created') return [{ type: 'task.deleted', taskId: body.task.id }];
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
