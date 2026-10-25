// Read models over PlannerState.
import type { BacklogBucket, DateKey, Placement, PlannerState, Task } from './types.ts';

const POSITION_STEP = 1024;

const isLive = (task: Task): boolean => !task.deletedAt && !task.archivedAt;
const byPosition = (a: Task, b: Task): number => a.position - b.position || a.createdAt.localeCompare(b.createdAt);

export const samePlacement = (a: Placement, b: Placement): boolean =>
  a.kind === 'day' ? b.kind === 'day' && a.date === b.date : b.kind === 'backlog' && a.bucket === b.bucket;

/** Live tasks in one placement, in list order. */
export const tasksIn = (state: PlannerState, placement: Placement): Task[] =>
  Object.values(state.tasks).filter((task) => isLive(task) && samePlacement(task.placement, placement)).sort(byPosition);

export const tasksForDay = (state: PlannerState, date: DateKey): Task[] => tasksIn(state, { kind: 'day', date });

export const backlogTasks = (state: PlannerState, bucket: BacklogBucket): Task[] => tasksIn(state, { kind: 'backlog', bucket });

export const archivedTasks = (state: PlannerState): Task[] =>
  Object.values(state.tasks).filter((task) => task.archivedAt && !task.deletedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

export const deletedTasks = (state: PlannerState): Task[] =>
  Object.values(state.tasks).filter((task) => task.deletedAt).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));

/** Planned minutes committed to a day; completed tasks still count toward the day's load. */
export const plannedTotal = (tasks: readonly Task[]): number => tasks.reduce((sum, task) => sum + (task.plannedMinutes ?? 0), 0);

/** Planned minutes that count toward the workload threshold: personal-context channels are left out. */
export const workloadTotal = (state: PlannerState, tasks: readonly Task[]): number =>
  plannedTotal(tasks.filter((task) => !task.channelId || state.channels[task.channelId]?.context !== 'personal'));

export const liveChannels = (state: PlannerState) =>
  Object.values(state.channels).filter((channel) => !channel.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const channelByName = (state: PlannerState, name: string) => {
  const lower = name.toLowerCase();
  return liveChannels(state).find((channel) => channel.name.toLowerCase() === lower) ?? null;
};

/** Planned minutes of the day's tasks that are still open. */
export const remainingTotal = (tasks: readonly Task[]): number =>
  tasks.reduce((sum, task) => sum + (task.completedAt ? 0 : task.plannedMinutes ?? 0), 0);

/** A position at the top or bottom of a placement. */
export const edgePosition = (state: PlannerState, placement: Placement, edge: 'top' | 'bottom'): number => {
  const list = tasksIn(state, placement);
  if (list.length === 0) return POSITION_STEP;
  return edge === 'top' ? list[0]!.position - POSITION_STEP : list[list.length - 1]!.position + POSITION_STEP;
};

/** A position between two neighbours (either may be missing). */
export const positionBetween = (before: number | undefined, after: number | undefined): number => {
  if (before === undefined && after === undefined) return POSITION_STEP;
  if (before === undefined) return after! - POSITION_STEP;
  if (after === undefined) return before + POSITION_STEP;
  return (before + after) / 2;
};

/**
 * Position for dropping a task at `index` in `placement`, ignoring the task itself
 * so a move within the same list lands where the user dropped it.
 */
export const positionAt = (state: PlannerState, placement: Placement, index: number, movingId?: string): number => {
  const list = tasksIn(state, placement).filter((task) => task.id !== movingId);
  const clamped = Math.max(0, Math.min(index, list.length));
  return positionBetween(list[clamped - 1]?.position, list[clamped]?.position);
};
