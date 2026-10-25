// Sunsama-style auto-sort of one list: a new order expressed as position moves.
import type { EventBody } from './events.ts';
import type { Priority, Task } from './types.ts';

export type SortKey = 'priority' | 'planned' | 'completed-last';

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const rank = (task: Task): number => (task.priority ? PRIORITY_RANK[task.priority] : 4);

/** Stable: ties keep the current order. */
export const sortTasks = (tasks: readonly Task[], key: SortKey): Task[] => {
  const indexed = tasks.map((task, index) => ({ task, index }));
  const compare = {
    priority: (a: Task, b: Task) => rank(a) - rank(b),
    // Longest first; unplanned tasks go last.
    planned: (a: Task, b: Task) => (b.plannedMinutes ?? -1) - (a.plannedMinutes ?? -1),
    'completed-last': (a: Task, b: Task) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)),
  }[key];
  return indexed.sort((a, b) => compare(a.task, b.task) || a.index - b.index).map((item) => item.task);
};

/** Moves that give `ordered` evenly spaced positions, skipping tasks already in place. */
export const reorderCommands = (ordered: readonly Task[]): EventBody[] =>
  ordered.flatMap((task, index) => {
    const position = (index + 1) * 1024;
    return task.position === position ? [] : [{ type: 'task.moved', taskId: task.id, placement: task.placement, position } as EventBody];
  });
