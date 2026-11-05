// What the Tasks view does to tasks, shared by its columns and the calendar's task editor: a form saved (asking This
// task or All tasks of a repeating one, as Google Calendar does), a task added from its form, a task deleted with
// Undo (asking which tasks of a repeating one), a refusal said; and Google Tasks' rules on repeats, subtasks and
// shared tasks, said where an action is unavailable.
import type { PlannerState } from '../../../../src/domain/core/types.ts';
import { messageOf } from '../../../../src/domain/core/values.ts';
import type { GoogleTaskItem } from '../../../../src/domain/google/google.ts';
import { SERIES_FIELDS } from '../../../../src/domain/google/taskForm.ts';
import { keptFor } from '../../../../src/domain/google/taskKept.ts';
import type { MoveTarget, TaskRow } from '../../../../src/domain/google/tasks.ts';
import { calendarUi } from '../../../lib/calendar/calendarUi.ts';
import { usePlanner } from '../../../lib/core/context.ts';
import { undoAction, type GoogleStore } from '../../../lib/google/store.ts';
import { DELETE_CHOICES, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, SHARED_NO_REPEAT, SHARED_NO_SUBTASKS, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT, TaskConflict, type DeleteScope, type RepeatScope, type TaskFields } from '../../../lib/google/types.ts';

/** A task shown while Google adds it, until it answers with the task (`GoogleStore.addListTask`). */
export const beingAdded = (item: GoogleTaskItem): boolean => item.id.startsWith('new-');

/** Why a task cannot repeat, as Google Tasks has it: a shared task, a subtask, or a task with subtasks (open or done); null when it can. */
export const repeatBlock = (item: GoogleTaskItem, items: readonly GoogleTaskItem[]): string | null =>
  item.assigned ? SHARED_NO_REPEAT : item.parent ? SUBTASK_NO_REPEAT : items.some((other) => other.parent === item.id) ? SUBTASKS_NO_REPEAT : null;

/** Why a task cannot be indented under the task above, as Google Tasks has it: a repeating or shared task is no subtask and takes none. */
export const indentProblem = (state: PlannerState, rows: readonly TaskRow[], item: GoogleTaskItem, indent: MoveTarget | null): string | null => {
  if (!indent) return null;
  if (keptFor(state, item)?.repeat) return REPEATING_NOT_SUBTASK;
  if (indent.parent && keptFor(state, { account: item.account, id: indent.parent })?.repeat) return REPEATING_NO_SUBTASKS;
  if (indent.parent && rows.find((row) => row.item.id === indent.parent)?.item.assigned) return SHARED_NO_SUBTASKS;
  return null;
};

/** A change to Google Tasks; one Google refuses is said in the message line. */
export const inGoogle = (notify: (message: string) => void, work: () => Promise<unknown>): Promise<unknown> => work().catch((error) => notify(`Google Tasks did not take it: ${messageOf(error)}`));

/**
 * Ask which tasks of a series a change is for, as Google Calendar asks (This task or All tasks; a new rule, or a
 * change of the series' own settings, is for all: `forAll`); null when cancelled.
 */
const askRepeat = async (forAll = false): Promise<RepeatScope | null> => {
  const choices = forAll ? [{ id: 'all', label: 'All tasks' }] : [{ id: 'this', label: 'This task' }, { id: 'all', label: 'All tasks' }];
  const choice = await calendarUi.ask({ title: 'Edit repeating task', style: 'radio', choices });
  return choice === 'this' || choice === 'all' ? choice : null;
};

/** Ask which tasks of a series a deletion is for, as Google Calendar asks (This task, This and following tasks, All tasks); null when cancelled. */
export const askDelete = async (): Promise<DeleteScope | null> => {
  const choice = await calendarUi.ask({ title: 'Delete repeating task', style: 'radio', choices: DELETE_CHOICES });
  return DELETE_CHOICES.find((option) => option.id === choice)?.id ?? null;
};

/** Delete, with Google Tasks' "Undo" in the snackbar (and on Ctrl/⌘+Z). */
export const deleteWithUndo = async (google: GoogleStore, notify: (message: string) => void, item: GoogleTaskItem, scope: DeleteScope) => {
  await google.deleteListTask(item, scope);
  calendarUi.snack(scope === 'this' ? 'Task deleted' : 'Tasks deleted', undoAction(google, notify));
};

/**
 * A new task from its form, in a list (`where`: under a task, after another),
 * with what the Planner keeps for it; Google's refusal is thrown, for the form
 * to show beside what was typed.
 */
export const addFromForm = (google: GoogleStore, account: string, listId: string, fields: TaskFields, starred: boolean, where?: { parent: string | null; previous: string | null }) =>
  google.addListTask(account, listId, { title: fields.title, notes: fields.notes, due: fields.due, ...where }, {
    time: fields.kept.time,
    duration: fields.kept.duration,
    deadline: fields.kept.deadline,
    rule: fields.kept.rule,
    starred,
    busy: fields.kept.busy,
    visibility: fields.kept.visibility,
    color: fields.kept.color,
    attachments: fields.kept.attachments,
    doNotDisturb: fields.kept.doNotDisturb,
    decline: fields.kept.decline,
  });

/**
 * Save a task's form, as the change from what it showed (`fields.base`) over
 * the task as it is now: a field changed meanwhile too (in another window, by
 * the service, in Google) is thrown (`TaskConflict`) for the form to ask
 * about. A repeating one asks which tasks the change is for (unless `scope`
 * says), as its series is now: a new rule, or a change of what the series
 * keeps for all its tasks, is for all of them; and a new list moves it there.
 * All or nothing, as `saveListTask` writes it: Google takes its fields and
 * the move first, and what the Planner keeps, the star too, changes only once
 * it has. True when saved (or nothing changed), false when the question was
 * cancelled; Google's refusal is thrown, for the form to show beside what was
 * typed. `shows`: what the form showed (Edit → All tasks: the series').
 */
export const useTaskSave = () => {
  const { google } = usePlanner();
  return async (item: GoogleTaskItem, fields: TaskFields, starred: boolean, scope?: RepeatScope, listId?: string, shows: 'task' | 'series' = 'task'): Promise<boolean> => {
    const extra = { starred, listId, shows };
    const check = await google.formCheck(item, fields, extra);
    if (check.conflicts.length) throw new TaskConflict(check.conflicts, check.now, check.mine, check.base);
    const changes = check.changes;
    if (!changes.length) return true;
    if (changes.every((field) => field === 'starred' || field === 'listId')) {
      // Only its list or its star: the move is Google's, made first; the star is the Planner's alone, with no Google write.
      const now = changes.includes('listId') && check.mine.listId !== check.item.listId ? await google.moveListTask(check.item, { parent: null, previous: null }, check.mine.listId) : check.item;
      if (changes.includes('starred')) await google.setKept(now, { starred: check.mine.starred });
      return true;
    }
    const chosen = scope ?? (check.kept?.repeat ? await askRepeat(changes.some((field) => SERIES_FIELDS.includes(field))) : 'this');
    if (!chosen) return false;
    await google.saveListTask(check.item, fields, chosen, extra);
    return true;
  };
};
