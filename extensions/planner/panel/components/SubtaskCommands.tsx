// A task's subtasks changed one at a time, by identity (`subtask.*`), for every control that changes them: Subtasks in
// the task's details and Focus, and Merged in. Each section asks about its own conflicts (`SubtaskProblems`).
import { useState } from 'preact/hooks';
import type { EventBody, NewTask, SubtaskConflict } from '../../src/domain/events.ts';
import type { Subtask, Task } from '../../src/domain/types.ts';
import { convertSubtaskCommands } from '../../src/domain/merge.ts';
import { newId } from '../../src/domain/ids.ts';
import { usePlanner } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { ConflictBanner, quoted } from './Conflicts.tsx';

/** A subtask change the service found changed elsewhere since, as the section asks it: what, and Save mine (or Show it). */
interface SubtaskProblem {
  /** The subtask it is about: a newer question about it replaces this one. */
  id: string;
  line: string;
  mine: () => void;
  mineLabel?: string;
}

/**
 * The service applies each change to the plan as it has it then, so a subtask
 * added, ticked or renamed in another window meanwhile stays. A tick or a
 * rename says what it saw, a delete the title it saw: a subtask renamed or
 * deleted elsewhere since is asked as an edit's conflict is (`problems`: Keep
 * theirs, or Save mine), nothing of it written. Each resolves to that
 * conflict, or null.
 */
export const useSubtaskCommands = (task: Task) => {
  const { client } = usePlanner();
  const { setUi } = useUi();
  const [problems, setProblems] = useState<SubtaskProblem[]>([]);
  const ask = (id: string, line: string, mine: () => void, mineLabel?: string) => setProblems((list) => [...list.filter((item) => item.id !== id), { id, line, mine, ...(mineLabel ? { mineLabel } : {}) }]);
  const settle = (id: string) => setProblems((list) => list.filter((item) => item.id !== id));
  const send = (bodies: EventBody[], undo?: string) =>
    new Promise<SubtaskConflict | null>((resolve) => {
      let found: SubtaskConflict | null = null;
      void client.dispatch(bodies, { ...(undo ? { undo } : {}), onConflict: (conflict) => (found = conflict) }).then(() => resolve(found));
    });
  /** Where a subtask is in this window's list: after the one before it (null: first). */
  const placeOf = (subtask: Subtask) => {
    const index = task.subtasks.findIndex((item) => item.id === subtask.id);
    return index > 0 ? task.subtasks[index - 1]!.id : index === 0 ? null : undefined;
  };
  /** Deleted elsewhere since: Save mine puts it back where it was, with this change. */
  const deleted = (subtask: Subtask, yours: string, mine: Subtask, after: string | null | undefined) =>
    ask(subtask.id, `${quoted(subtask.title)} was deleted elsewhere (yours: ${yours})`, () => void send([{ type: 'subtask.added', taskId: task.id, subtask: mine, after }]));
  const tick = async (subtask: Subtask) => {
    const done = !subtask.done;
    const after = placeOf(subtask);
    const conflict = await send([{ type: 'subtask.updated', taskId: task.id, subtaskId: subtask.id, patch: { done }, seen: { done: subtask.done } }]);
    if (conflict && !conflict.now) deleted(subtask, done ? 'checked off' : 'unchecked', { ...subtask, done }, after);
  };
  const rename = async (subtask: Subtask, title: string, seen: string) => {
    const after = placeOf(subtask);
    const conflict = await send([{ type: 'subtask.updated', taskId: task.id, subtaskId: subtask.id, patch: { title }, seen: { title: seen } }]);
    if (conflict && !conflict.now) deleted({ ...subtask, title: seen }, `renamed ${quoted(title)}`, { ...subtask, title }, after);
    return conflict;
  };
  const remove = async (subtask: Subtask, seen = subtask.title) => {
    const conflict = await send([{ type: 'subtask.deleted', taskId: task.id, subtaskId: subtask.id, seen: { title: seen } }]);
    const now = conflict?.now;
    if (now) ask(subtask.id, `${quoted(seen)} was renamed ${quoted(now.title)} elsewhere (yours: deleted)`, () => void remove(subtask, now.title));
  };
  /**
   * ↗ Turn into a task (Subtasks) and Convert to task (Merged in): one step,
   * with all the subtask holds (`convertSubtaskCommands`), that Undo takes
   * back. Renamed elsewhere since: asked (Save mine turns it into a task as it
   * is now). Turned into a task in another window: said, with Show it; there
   * is no second one. Deleted in another window: Keep theirs, or Save mine,
   * which makes the task from what this window saw.
   */
  const toTask = async (subtask: Subtask) => {
    const { state, today } = client.getView();
    const bodies = convertSubtaskCommands(state, task.id, subtask.id, newId, today);
    if (!bodies.length) return;
    const conflict = await send(bodies, 'Converted to a task');
    if (!conflict) return;
    const { now, became } = conflict;
    if (now) ask(subtask.id, `${quoted(subtask.title)} was renamed ${quoted(now.title)} elsewhere (yours: turned into a task)`, () => void toTask(now));
    else if (became) ask(subtask.id, `${quoted(subtask.title)} was already turned into a task in another window`, () => setUi({ openTaskId: became }), 'Show it');
    else {
      const made = (bodies[0] as { task: NewTask }).task;
      ask(subtask.id, `${quoted(subtask.title)} was deleted in another window`, () => void send([{ type: 'task.created', task: { ...made, id: newId() } }], 'Converted to a task'));
    }
  };
  const add = (title: string) => send([{ type: 'subtask.added', taskId: task.id, subtask: { id: newId(), title, done: false } }]);
  return { problems, settle, add, tick, rename, remove, toTask };
};

/** A section's questions about its subtask changes, with the edits' Keep theirs / Save mine. */
export const SubtaskProblems = ({ commands }: { commands: ReturnType<typeof useSubtaskCommands> }) => (
  <>
    {commands.problems.map((problem) => (
      <ConflictBanner
        key={problem.id}
        lines={[problem.line]}
        {...(problem.mineLabel ? { mineLabel: problem.mineLabel } : {})}
        onTheirs={() => commands.settle(problem.id)}
        onMine={() => {
          commands.settle(problem.id);
          problem.mine();
        }}
      />
    ))}
  </>
);
