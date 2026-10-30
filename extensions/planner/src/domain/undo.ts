// Undo: the commands that reverse a batch, computed against the state before it ran, and what an Undo would
// overwrite that changed since the action it takes back (`changedSince`): the service makes an Undo only when
// nothing it would change was changed meanwhile, elsewhere, so a stale Undo never puts back an old value over a
// newer one.
import type { EventBody, PlannerEvent, TaskPatch } from './events.ts';
import { zonedDateMinutes } from './dates.ts';
import { applyEvents } from './reducer.ts';
import { samePlacement } from './selectors.ts';
import type { PlannerState, Task, WorkBlock } from './types.ts';

/** What an Undo says when something it would put back was changed since, in another window (or elsewhere). */
export const CHANGED_SINCE = 'Changed in another window since; not undone';
/** What an Undo says once the service no longer has what it would undo (restarted, or long ago). */
export const UNDO_GONE = 'This can no longer be undone';

/** Restore a task's day, order and planned time after a session change moved or resized it. */
const restoreTask = (state: PlannerState, taskId: string): EventBody[] => {
  const task = state.tasks[taskId];
  if (!task) return [];
  return [
    { type: 'task.moved', taskId, placement: task.placement, position: task.position },
    { type: 'task.updated', taskId, patch: { plannedMinutes: task.plannedMinutes } },
  ];
};

/** A task's working sessions on its day: what moving it off that day drops (as the reducer drops them). */
const sessionsOnItsDay = (state: PlannerState, task: Task): WorkBlock[] => {
  if (task.placement.kind !== 'day') return [];
  const day = task.placement.date;
  const zone = state.settings.timezone ?? 'UTC';
  return Object.values(state.blocks).filter((block) => block.taskId === task.id && zonedDateMinutes(block.start, zone).date === day);
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
  if (body.type === 'objective.deleted') {
    // Back, with the tasks that were aligned with it (the deletion took their alignment).
    const objective = state.objectives[body.objectiveId];
    if (!objective || objective.deletedAt) return null;
    const aligned = Object.values(state.tasks).filter((task) => task.objectiveId === objective.id);
    return [{ type: 'objective.restored', objectiveId: objective.id }, ...aligned.map((task): EventBody => ({ type: 'task.updated', taskId: task.id, patch: { objectiveId: objective.id } }))];
  }
  if (!('taskId' in body)) return null;
  const task = state.tasks[body.taskId];
  if (!task) return null;
  switch (body.type) {
    case 'task.deleted':
      // Deleted from the archive, it goes back there.
      return task.archivedAt ? [{ type: 'task.restored', taskId: task.id }, { type: 'task.archived', taskId: task.id }] : [{ type: 'task.restored', taskId: task.id }];
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
      // Moved off its day, its working sessions there were dropped: they come back, with its planned time as it was.
      const dropped = samePlacement(task.placement, body.placement) ? [] : sessionsOnItsDay(state, task);
      if (dropped.length) back.push(...dropped.map((block): EventBody => ({ type: 'block.created', block: { ...block } })), { type: 'task.updated', taskId: task.id, patch: { plannedMinutes: task.plannedMinutes } });
      // Scheduled on a day, it left its folder: it goes back into it.
      if (task.folderId && body.placement.kind === 'day') back.push({ type: 'task.updated', taskId: task.id, patch: { folderId: task.folderId } });
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

/** A batch as events, to see what it would do to a state (not stored). */
export const asEvents = (bodies: readonly EventBody[], at = new Date().toISOString()): PlannerEvent[] =>
  bodies.map((body, index) => ({ v: 1, id: `check-${index}`, at, ...body }) as PlannerEvent);

type Entity = Record<string, unknown>;

/** The collections an Undo can reach, entity by id; `timer` and `settings` are compared as one record each. */
const COLLECTIONS = ['tasks', 'blocks', 'entries', 'objectives', 'channels', 'folders', 'calendars', 'rituals', 'series', 'runs', 'googleTasks'] as const;

/**
 * Not a person's change, so never a reason to refuse: when a record was last
 * touched; a task's carry-forward count (it follows its day); a working
 * session's Google Calendar event, which the service writes and links itself
 * right after the session changes.
 */
const IGNORED: Record<string, ReadonlySet<string>> = {
  tasks: new Set(['updatedAt', 'rolloverCount']),
  blocks: new Set(['google']),
};
const ignored = (collection: string, field: string): boolean => field === 'updatedAt' || Boolean(IGNORED[collection]?.has(field));

/**
 * A field as the check compares it: a task's source is the item it links to
 * (its state there and what was last read from it follow the source, as the
 * Linear, GitHub and Google syncs keep them), the rest as it is, keys in order.
 */
const comparable = (collection: string, field: string, value: unknown): string => {
  if (collection === 'tasks' && field === 'source') {
    const source = value as { kind?: string; id?: string } | null | undefined;
    return source ? `${source.kind}:${source.id}` : 'null';
  }
  return canonical(value);
};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => (inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as Entity).sort(([a], [b]) => a.localeCompare(b))) : inner)) ?? 'undefined';

/**
 * What an Undo would overwrite that changed since the action it takes back,
 * as `collection/id/field`; empty when it may go ahead. `after` is the plan
 * right after the action, `now` the plan as it is now, `undone` the plan with
 * the Undo applied to it now. A field counts when the Undo changes it now and
 * it no longer has the value the action left: someone else changed it since,
 * and putting the old value back would overwrite theirs. Fields the Undo leaves
 * as they are never count (a title edited elsewhere does not stop a move from
 * being undone). A task the Undo deletes (taking back its creation), or a
 * session it removes, takes all it holds with it: any of it changed since
 * counts (except, for a linked task, a due date its source keeps in step).
 */
export const changedSince = (after: PlannerState, now: PlannerState, undone: PlannerState): string[] => {
  const changed: string[] = [];
  for (const collection of COLLECTIONS) {
    const was = after[collection] as Record<string, Entity | undefined>;
    const is = now[collection] as Record<string, Entity | undefined>;
    const will = undone[collection] as Record<string, Entity | undefined>;
    for (const id of new Set([...Object.keys(is), ...Object.keys(will)])) {
      const [a, n, u] = [was[id], is[id], will[id]];
      if (u === n) continue;
      const removed = !u || (collection === 'tasks' && !n?.deletedAt && Boolean(u.deletedAt));
      const linked = collection === 'tasks' && Boolean(n?.source ?? a?.source);
      for (const field of new Set([...Object.keys(a ?? {}), ...Object.keys(n ?? {}), ...Object.keys(u ?? {})])) {
        if (ignored(collection, field)) continue;
        const since = comparable(collection, field, n?.[field]) !== comparable(collection, field, a?.[field]);
        if (removed) {
          if (since && !(linked && field === 'dueDate')) changed.push(`${collection}/${id}/${field}`);
        } else if (since && comparable(collection, field, u?.[field]) !== comparable(collection, field, n?.[field])) changed.push(`${collection}/${id}/${field}`);
      }
    }
  }
  if (canonical(undone.timer) !== canonical(now.timer) && canonical(now.timer) !== canonical(after.timer)) changed.push('timer');
  for (const key of new Set([...Object.keys(now.settings), ...Object.keys(undone.settings)])) {
    const [a, n, u] = [(after.settings as unknown as Entity)[key], (now.settings as unknown as Entity)[key], (undone.settings as unknown as Entity)[key]];
    if (canonical(u) !== canonical(n) && canonical(n) !== canonical(a)) changed.push(`settings/${key}`);
  }
  return changed;
};
