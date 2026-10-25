// Midnight rollover: unfinished work on past days moves to today.
import type { DateKey, PlannerState, Task } from './types.ts';
import type { EventBody, RolledTask } from './events.ts';
import { daysBetween } from './dates.ts';
import { tasksForDay } from './selectors.ts';

/**
 * The rollover event that brings every open task planned before `today` onto today.
 * Catch-up is implicit: a task planned four days ago moves once and counts four days,
 * so a service that was down over several midnights converges to the same result.
 * Carried tasks go to the top of today, keeping their relative order; a task whose
 * consecutive rollovers reach the archive threshold is archived instead.
 */
export const planRollover = (state: PlannerState, today: DateKey): Extract<EventBody, { type: 'tasks.rolledOver' }> | null => {
  const stale = Object.values(state.tasks)
    .filter((task) => !task.deletedAt && !task.archivedAt && !task.completedAt && task.placement.kind === 'day' && task.placement.date < today)
    .sort((a, b) => dayOf(a).localeCompare(dayOf(b)) || a.position - b.position);
  if (stale.length === 0) return null;

  const threshold = state.settings.archiveAfterRollovers;
  const archived: string[] = [];
  const carried: Task[] = [];
  for (const task of stale) {
    const count = task.rolloverCount + Math.max(1, daysBetween(dayOf(task), today));
    if (threshold !== null && count >= threshold) archived.push(task.id);
    else carried.push(task);
  }

  const first = tasksForDay(state, today)[0]?.position;
  const moved: RolledTask[] = carried.map((task, index) => ({
    taskId: task.id,
    from: dayOf(task),
    position: first === undefined ? (index + 1) * 1024 : first - (carried.length - index) * 1024,
  }));
  return { type: 'tasks.rolledOver', date: today, moved, archived };
};

const dayOf = (task: Task): DateKey => (task.placement.kind === 'day' ? task.placement.date : '');
