// Sunsama's Linear automation, as the Planner does it: what a change to the plan (completing a task, checking off an
// issue merged into one, planning or importing an issue) asks or does in Linear, as the settings say, and what an
// answer to the prompt ("Show prompt to update status in Linear") does. Pure: the store (store.ts) asks and moves.
import { mergedDone, mergedImports, subtasksChangedIn, wasMerged } from '../../../src/domain/plan/merge.ts';
import { isClosedType } from '../../../src/domain/linear/linear.ts';
import type { Command } from '../../../src/domain/core/events.ts';
import type { PlannerState, Settings, Subtask, Task, TaskSourceRef } from '../../../src/domain/core/types.ts';
import type { LinearPrompt } from './types.ts';

/** An issue to move in Linear: to one of its team's states, or to its team's first of a type. */
export interface LinearMove {
  source: TaskSourceRef;
  to: 'completed' | 'started' | { stateId: string };
  /** The task whose own issue it is, which follows the issue's new state; none for an issue merged into a task. */
  task: Task | null;
}

/** What a change asks (the prompt), or does, in Linear. */
type LinearAction = { ask: LinearPrompt } | { move: LinearMove };

const isLinear = (source: TaskSourceRef | null | undefined): source is TaskSourceRef => source?.kind === 'linear';

/**
 * A task completed, or issues merged into it checked off: each moved to its team's Done, as the settings say
 * (Sunsama's "Show prompt to update status in Linear"): at once, or asked, once for all of them. One issue keeps the
 * status picker; several each go to their team's first completed state.
 */
const completing = (task: Task, own: boolean, merged: readonly Subtask[], settings: Settings): LinearAction[] => {
  const keys = [...(own ? [task.source!.key] : []), ...merged.map((subtask) => subtask.source!.key)];
  if (!keys.length) return [];
  if (settings.linearOnComplete === 'complete') {
    return [
      ...(own ? [{ move: { source: task.source!, to: 'completed' as const, task } }] : []),
      ...merged.map((subtask) => ({ move: { source: subtask.source!, to: 'completed' as const, task: null } })),
    ];
  }
  if (settings.linearOnComplete !== 'ask') return [];
  if (keys.length === 1) return [{ ask: own ? { kind: 'complete', taskId: task.id, key: keys[0]! } : { kind: 'complete', taskId: task.id, key: keys[0]!, subtaskId: merged[0]!.id } }];
  return [{ ask: { kind: 'complete', taskId: task.id, key: `${keys[0]} and ${keys.length - 1} more`, many: { own, subtaskIds: merged.map((subtask) => subtask.id) } } }];
};

/** What a commit of the user's asks or does in Linear, in the order of its commands. */
export const linearActions = (commands: readonly Command[], before: PlannerState, after: PlannerState): LinearAction[] => {
  const settings = after.settings;
  const actions: LinearAction[] = [];
  const made = commands.flatMap((command) => (command.type === 'task.created' && command.task.source ? [command.task.source] : []));
  const seen = new Set<string>();
  for (const command of commands) {
    // Issues merged into a task stay integrated (Sunsama's merge): checking one off, or merging one straight in from
    // the panel, asks as the task's own would (once a task, for all of a batch's changes to its subtasks).
    const subtasksOf = subtasksChangedIn(command);
    if (subtasksOf) {
      if (seen.has(subtasksOf)) continue;
      seen.add(subtasksOf);
      const ticked = mergedDone(before.tasks[subtasksOf], after.tasks[subtasksOf]).filter((subtask) => subtask.source?.kind === 'linear' && !isClosedType(subtask.source.status?.type));
      const task = after.tasks[subtasksOf];
      if (task && ticked.length) actions.push(...completing(task, false, ticked, settings));
      if (settings.linearImportPrompt) {
        for (const subtask of mergedImports(before, after, subtasksOf, made)) {
          if (subtask.source?.kind === 'linear') actions.push({ ask: { kind: 'import', taskId: subtasksOf, key: subtask.source.key, subtaskId: subtask.id } });
        }
      }
      continue;
    }
    // Completing a task: its own issue, and the issues merged into it that were not checked off on their own (that
    // ran their automation, or asked, then) nor closed in Linear, as checking each off would. Reopening it does
    // nothing in Linear, as unchecking one does not (Sunsama's Linear automation is for completing).
    if (command.type === 'task.completed') {
      const task = after.tasks[command.taskId];
      if (!task) continue;
      const own = task.source?.kind === 'linear' && !isClosedType(task.source.status?.type);
      const merged = task.subtasks.filter((subtask) => !subtask.done && subtask.source?.kind === 'linear' && !isClosedType(subtask.source.status?.type));
      actions.push(...completing(task, own, merged, settings));
      continue;
    }
    // Sunsama's import automation: right after an issue is imported, a prompt to update its status in Linear.
    if (command.type === 'task.created' && command.task.source?.kind === 'linear' && settings.linearImportPrompt && !before.tasks[command.task.id] && !wasMerged(before, command.task.source)) {
      actions.push({ ask: { kind: 'import', taskId: command.task.id, key: command.task.source.key } });
      continue;
    }
    const plannedId = command.type === 'task.created' ? command.task.id : command.type === 'task.moved' ? command.taskId : null;
    if (!plannedId) continue;
    const task = after.tasks[plannedId];
    const previous = before.tasks[plannedId];
    // Only the first time an issue lands on a day, and only while it has not started.
    // (Not a task made completed: a ticked merged issue turned back into a task.)
    if (task?.source?.kind !== 'linear' || task.placement.kind !== 'day' || previous?.placement.kind === 'day' || task.completedAt) continue;
    if (!['backlog', 'unstarted', 'triage'].includes(task.source.status?.type ?? '')) continue;
    if (settings.linearOnPlan === 'start') actions.push({ move: { source: task.source, to: 'started', task } });
    else if (settings.linearOnPlan === 'ask') actions.push({ ask: { kind: 'start', taskId: task.id, key: task.source.key } });
  }
  return actions;
};

/**
 * What an answer to a prompt about `task` does: the issues it moves (to the state chosen, or else to Done or In
 * Progress), and the setting Always changes so that completing or planning does it by itself.
 */
export const answerActions = (prompt: LinearPrompt, always: boolean, stateId: string | undefined, task: Task): { settings: Partial<Settings> | null; moves: LinearMove[] } => {
  const subtaskSource = (id: string) => task.subtasks.find((subtask) => subtask.id === id)?.source;
  if (prompt.many) {
    const merged = prompt.many.subtaskIds.map(subtaskSource).filter(isLinear);
    return {
      settings: always ? { linearOnComplete: 'complete' } : null,
      moves: [...(prompt.many.own && isLinear(task.source) ? [{ source: task.source, to: 'completed' as const, task }] : []), ...merged.map((source) => ({ source, to: 'completed' as const, task: null }))],
    };
  }
  const to = stateId ? { stateId } : prompt.kind === 'complete' ? ('completed' as const) : ('started' as const);
  if (prompt.subtaskId) {
    const source = subtaskSource(prompt.subtaskId);
    return { settings: always && prompt.kind === 'complete' ? { linearOnComplete: 'complete' } : null, moves: isLinear(source) ? [{ source, to, task: null }] : [] };
  }
  const settings: Partial<Settings> | null = !always || prompt.kind === 'import' ? null : prompt.kind === 'complete' ? { linearOnComplete: 'complete' } : { linearOnPlan: 'start' };
  return { settings, moves: isLinear(task.source) ? [{ source: task.source, to, task }] : [] };
};
