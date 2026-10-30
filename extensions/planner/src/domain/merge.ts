// Sunsama's Merge tasks (help.sunsama.com/docs/usage-guides/tasks/merge-tasks), which its Gmail page suggests for
// emails ("merge an email directly into your daily recurring task"): Alt/Option + drag a task onto another merges it
// in as a subtask that keeps its notes, planned time and integrated information; an item from an integration panel
// merges straight in; merged items stay linked and synced (a Linear issue's or a GitHub item's state and title follow);
// an event task neither merges nor takes one ("Cannot merge events"), so it has no subtasks at all; Convert to task gives
// one back as a task.
import type { EventBody } from './events.ts';
import { positionAt, tasksIn } from './selectors.ts';
import type { DateKey, PlannerState, Subtask, Task, TaskSourceRef } from './types.ts';

export const CANNOT_MERGE_EVENTS = 'Cannot merge events';

/**
 * Sunsama's FAQ: "Because merging is how subtasks get created, this also means calendar event tasks can't have
 * subtasks at all." What the service says to a subtask added to one, and what its details say instead of Add subtask
 * (Sunsama's advice: a breakdown in its notes, or a separate task for what needs real subtasks).
 */
export const EVENT_NO_SUBTASKS = "Calendar event tasks can't have subtasks";
export const EVENT_SUBTASKS_HINT = "Calendar event tasks can't have subtasks: break this one down in its notes, or make a separate task for what needs real subtasks.";

/** A task made from a calendar event (an imported meeting, Add to tasks). */
export const isEventTask = (task: Pick<Task, 'source'> | undefined): boolean => task?.source?.kind === 'event';

/** A task's subtasks as notes lines, for one merged into another (its own subtasks can't nest). */
const checklist = (subtasks: readonly Subtask[]): string => subtasks.map((subtask) => `- [${subtask.done ? 'x' : ' '}] ${subtask.title}`).join('\n');

/**
 * The open task a new one is merged into by `>` in Add task (Sunsama's): its title, then the start of it, then words in
 * it; on the day the new task is for first (a daily recurring task's instance that day), then today, then any.
 */
export const mergeTarget = (state: PlannerState, query: string, date: DateKey | null, today: DateKey): Task | null => {
  const wanted = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return null;
  const match = (task: Task): number => {
    const title = task.title.toLowerCase().replace(/\s+/g, ' ');
    return title === wanted ? 0 : title.startsWith(wanted) ? 1 : title.includes(wanted) ? 2 : -1;
  };
  const near = (task: Task): number => (task.placement.kind !== 'day' ? 3 : task.placement.date === date ? 0 : task.placement.date === today ? 1 : 2);
  return (
    Object.values(state.tasks)
      .filter((task) => !task.deletedAt && !task.archivedAt && !task.completedAt && !isEventTask(task))
      .map((task) => ({ task, score: match(task) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score || near(a.task) - near(b.task) || a.task.position - b.task.position)[0]?.task ?? null
  );
};

/** Merge the dragged task into the target as a subtask (its notes, planned time and link kept); refused for events. */
export const mergeTaskCommands = (state: PlannerState, draggedId: string, targetId: string, newId: () => string): EventBody[] | string => {
  const dragged = state.tasks[draggedId];
  const target = state.tasks[targetId];
  if (!dragged || !target || draggedId === targetId || dragged.deletedAt || target.deletedAt) return [];
  if (isEventTask(dragged) || isEventTask(target)) return CANNOT_MERGE_EVENTS;
  const notes = [dragged.notes.trim(), dragged.subtasks.length ? checklist(dragged.subtasks) : ''].filter(Boolean).join('\n\n');
  const subtask: Subtask = {
    id: newId(),
    title: dragged.title,
    done: Boolean(dragged.completedAt),
    ...(notes ? { notes } : {}),
    ...(dragged.plannedMinutes ? { plannedMinutes: dragged.plannedMinutes } : {}),
    ...(dragged.source ? { source: dragged.source } : {}),
  };
  return [
    { type: 'task.updated', taskId: targetId, patch: { subtasks: [...target.subtasks, subtask] } },
    { type: 'task.deleted', taskId: draggedId },
  ];
};

/** Merge an item from an integration panel (an email, an issue…) straight into the target, linked as it would be as a task. */
export const mergeItemCommands = (state: PlannerState, targetId: string, item: { title: string; source: TaskSourceRef }, newId: () => string): EventBody[] | string => {
  const target = state.tasks[targetId];
  if (!target || target.deletedAt) return [];
  if (isEventTask(target) || item.source.kind === 'event') return CANNOT_MERGE_EVENTS;
  if (target.subtasks.some((subtask) => subtask.source?.kind === item.source.kind && subtask.source.id === item.source.id)) return [];
  return [{ type: 'task.updated', taskId: targetId, patch: { subtasks: [...target.subtasks, { id: newId(), title: item.title, done: false, source: item.source }] } }];
};

/** Convert to task: the subtask becomes a task again, right after its task, with what it kept (notes, planned time, link). */
export const convertSubtaskCommands = (state: PlannerState, taskId: string, subtaskId: string, newId: () => string): EventBody[] => {
  const task = state.tasks[taskId];
  const subtask = task?.subtasks.find((item) => item.id === subtaskId);
  if (!task || !subtask) return [];
  const list = tasksIn(state, task.placement);
  const index = list.findIndex((item) => item.id === task.id);
  return [
    { type: 'task.updated', taskId, patch: { subtasks: task.subtasks.filter((item) => item.id !== subtaskId) } },
    {
      type: 'task.created',
      task: {
        id: newId(),
        title: subtask.title,
        placement: task.placement,
        position: positionAt(state, task.placement, index + 1),
        ...(subtask.notes ? { notes: subtask.notes } : {}),
        ...(subtask.plannedMinutes ? { plannedMinutes: subtask.plannedMinutes } : {}),
        ...(task.channelId ? { channelId: task.channelId } : {}),
        ...(subtask.source ? { source: subtask.source } : {}),
      },
    },
  ];
};

const sourceKey = (source: Pick<TaskSourceRef, 'kind' | 'id'>): string => `${source.kind}|${source.id}`;

/** A task made from an item merged before (Convert to task): no import, its item was imported when it was merged. */
export const wasMerged = (before: PlannerState, source: Pick<TaskSourceRef, 'kind' | 'id'>): boolean =>
  Object.values(before.tasks).some((task) => task.subtasks.some((subtask) => subtask.source && sourceKey(subtask.source) === sourceKey(source)));

/** Merged items a change checked off (a subtask with a link, done now and not before): their completion automations run. */
export const mergedDone = (before: Task | undefined, after: Task | undefined): Subtask[] =>
  (after?.subtasks ?? []).filter((subtask) => {
    const was = before?.subtasks.find((item) => item.id === subtask.id);
    return Boolean(subtask.source && subtask.done && was && !was.done);
  });

/** Merged items a change opened again (a subtask with a link, done before and not now): opened again where they live. */
export const mergedReopened = (before: Task | undefined, after: Task | undefined): Subtask[] =>
  (after?.subtasks ?? []).filter((subtask) => {
    const was = before?.subtasks.find((item) => item.id === subtask.id);
    return Boolean(subtask.source && !subtask.done && was?.done);
  });

/**
 * Items a change merged straight in from a panel (an import, as Sunsama counts one): new merged subtasks whose item was
 * on no task before, nor made into one by the same change (a task merged in was imported when it was made).
 */
export const mergedImports = (before: PlannerState, after: PlannerState, taskId: string, made: readonly TaskSourceRef[] = []): Subtask[] => {
  const known = new Set([...Object.values(before.tasks).flatMap((task) => [...(task.source && !task.deletedAt ? [sourceKey(task.source)] : []), ...task.subtasks.flatMap((subtask) => (subtask.source ? [sourceKey(subtask.source)] : []))]), ...made.map(sourceKey)]);
  const had = new Set(before.tasks[taskId]?.subtasks.map((subtask) => subtask.id) ?? []);
  return (after.tasks[taskId]?.subtasks ?? []).filter((subtask) => subtask.source && !had.has(subtask.id) && !known.has(sourceKey(subtask.source)));
};

/** The items merged subtasks of open tasks are linked to, of one kind: read with the linked tasks' own, to keep them synced. */
export const subtaskSourceIds = (state: PlannerState, kind: TaskSourceRef['kind']): string[] =>
  [...new Set(Object.values(state.tasks).flatMap((task) => (task.deletedAt || task.archivedAt || task.completedAt ? [] : task.subtasks.flatMap((subtask) => (subtask.source?.kind === kind && !subtask.done ? [subtask.source.id] : [])))))];

/** A merged item's workspace (Linear), for reading it from the right one. */
export const subtaskSources = (state: PlannerState, kind: TaskSourceRef['kind']): TaskSourceRef[] =>
  Object.values(state.tasks).flatMap((task) => (task.deletedAt || task.archivedAt || task.completedAt ? [] : task.subtasks.flatMap((subtask) => (subtask.source?.kind === kind && !subtask.done ? [subtask.source] : []))));

/**
 * Merged items follow their item as linked tasks do: its state and title (a subtask still titled as the item was
 * takes the new title), and done once the item is closed or merged.
 */
export const planSubtaskSourceSync = (state: PlannerState, kind: TaskSourceRef['kind'], items: ReadonlyMap<string, { title: string; status: NonNullable<TaskSourceRef['status']>; closed: boolean }>): EventBody[] =>
  Object.values(state.tasks).flatMap((task): EventBody[] => {
    if (task.deletedAt || task.archivedAt) return [];
    let changed = false;
    const subtasks = task.subtasks.map((subtask) => {
      const source = subtask.source;
      const item = source?.kind === kind ? items.get(source.id) : undefined;
      if (!source || !item) return subtask;
      const sameStatus = source.status?.name === item.status.name && source.status?.type === item.status.type;
      const title = subtask.title === (source.title ?? subtask.title) ? item.title : subtask.title;
      const done = subtask.done || item.closed;
      if (sameStatus && source.title === item.title && title === subtask.title && done === subtask.done) return subtask;
      changed = true;
      return { ...subtask, title, done, source: { ...source, title: item.title, status: item.status } };
    });
    return changed ? [{ type: 'task.updated', taskId: task.id, patch: { subtasks } }] : [];
  });
