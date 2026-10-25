// Read models over PlannerState.
import type { BacklogBucket, DateKey, Placement, PlannerState, Task, TimeEntry } from './types.ts';

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

// Entries grouped by task, cached per entries object so renders stay linear.
const entryIndex = new WeakMap<Record<string, TimeEntry>, Map<string, TimeEntry[]>>();
const entriesByTask = (state: PlannerState): Map<string, TimeEntry[]> => {
  let index = entryIndex.get(state.entries);
  if (!index) {
    index = new Map();
    for (const entry of Object.values(state.entries)) {
      const list = index.get(entry.taskId) ?? [];
      list.push(entry);
      index.set(entry.taskId, list);
    }
    for (const list of index.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    entryIndex.set(state.entries, index);
  }
  return index;
};

export const entriesFor = (state: PlannerState, taskId: string): TimeEntry[] => entriesByTask(state).get(taskId) ?? [];

/** Minutes tracked for a task; with `now`, includes the running timer. */
export const trackedMinutes = (state: PlannerState, taskId: string, now?: number): number => {
  let ms = 0;
  for (const entry of entriesFor(state, taskId)) ms += Date.parse(entry.end) - Date.parse(entry.start);
  if (now !== undefined && state.timer?.taskId === taskId) ms += Math.max(0, now - Date.parse(state.timer.startedAt));
  return ms / 60_000;
};

/**
 * Actual time as Sunsama reports it: tracked time, or, for a task completed
 * without any tracking, its planned time when that setting is on.
 */
export const actualMinutes = (state: PlannerState, task: Task, now?: number): number => {
  const tracked = trackedMinutes(state, task.id, now);
  if (tracked > 0) return tracked;
  return state.settings.plannedAsActual && task.completedAt && task.plannedMinutes ? task.plannedMinutes : 0;
};

/** Whether an actual figure is an estimate filled in from the plan. */
export const actualIsFromPlan = (state: PlannerState, task: Task): boolean =>
  trackedMinutes(state, task.id) === 0 && state.settings.plannedAsActual && Boolean(task.completedAt && task.plannedMinutes);

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
