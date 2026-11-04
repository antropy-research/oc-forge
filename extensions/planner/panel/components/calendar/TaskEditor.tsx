// A Google task's editor over the calendar, as Google Calendar's task details
// have one: the Tasks view's own form (title, details, date and time,
// deadline, repeat, star, advanced settings) and the task's list, in a dialog
// (a repeating task's availability and visibility are its series'). The calendar stays
// on the view and date it was on. A repeating task asks This task or All
// tasks; opened from an upcoming occurrence it edits all of its series, which
// the form shows as the series has it, or (This task) that occurrence alone,
// as it is: kept with its series until the series makes it. Either way the
// save is the change from what it showed, over the task or the series as it
// is then; a field changed meanwhile too is asked about. It closes once
// Google has the edit; a refusal stays in it, with the edit, to save again.
import { useEffect } from 'preact/hooks';
import { keptFor, upcomingValues } from '../../../src/domain/gtaskKept.ts';
import { seriesShown, templateAdvanced } from '../../../src/domain/gtaskForm.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { calendarUi, type TaskEditorTarget } from '../../lib/gcal.ts';
import { listKey, REPEATING_STAYS } from '../../lib/google.ts';
import { repeatBlock, TaskForm, useTaskSave } from '../TasksView.tsx';
import { Icon } from './Icon.tsx';

/** Why one task of a series does not change the repeat: its series has it. */
const SERIES_REPEATS = 'This task alone: its series repeats as before (Edit → All tasks changes it)';
/** Why one task of a series does not change its advanced settings: Google Calendar keeps one for the whole series. */
const SERIES_ADVANCED = "A repeating task's availability, visibility and other advanced settings are its series' (Edit → All tasks changes them)";

export const TaskEditor = ({ target }: { target: TaskEditorTarget }) => {
  const { google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const save = useTaskSave();
  const item = target.item;
  const occurrence = target.occurrence;
  const key = listKey(item.account, item.listId);
  const board = gv.board[key];
  // Its list, read as the Tasks view reads it: a task with subtasks does not repeat.
  useEffect(() => {
    if (!board) void google.loadBoard(item.account, item.listId);
  }, [key]);
  const close = () => calendarUi.editTask(null);
  const kept = keptFor(view.state, item);
  const block = board ? repeatBlock(item, board.items) : item.parent ? repeatBlock(item, []) : null;
  // Until its list is read, a task that does not repeat yet is not offered one; one occurrence keeps its series' repeat.
  const canRepeat = !occurrence && (Boolean(kept?.repeat) || (Boolean(board) && !block));
  // One upcoming occurrence: as it is, its series' values with its own changes.
  const values = occurrence ? upcomingValues(occurrence) : null;
  // All tasks of a series: its template's title, details, time, deadline and advanced settings, on the open
  // occurrence's date (`seriesShown`, as the save reads the series again). One occurrence's availability, visibility,
  // color, Do not disturb and declining are the series' template's, as it makes each task.
  const series = target.series && kept && !occurrence ? seriesShown(item, kept) : null;
  const shown = values && kept
    ? { item: { ...item, title: values.title, notes: values.notes, due: values.due }, kept: { ...kept, time: values.time, duration: values.duration, deadline: values.deadline, ...templateAdvanced(occurrence!.template, kept, new Date().toISOString()), attachments: values.attachments } }
    : series ?? { item, kept };
  const title = target.series ? 'Edit all tasks' : 'Edit task';
  return (
    <div class="modal-backdrop is-top" onMouseDown={(click) => click.target === click.currentTarget && close()}>
      <div class="modal gt-task-editor" role="dialog" aria-modal="true" aria-label={`${title}: ${item.title}`}>
        <div class="gt-editor-bar">
          <h2>{title}</h2>
          <button class="icon-button" aria-label="Close" title="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <TaskForm
          item={shown.item}
          kept={shown.kept}
          depth={0}
          canRepeat={canRepeat}
          repeatNote={occurrence ? SERIES_REPEATS : block}
          advancedNote={occurrence ? SERIES_ADVANCED : null}
          star={!occurrence}
          lists={{ lists: gv.lists.filter((list) => list.account === item.account), locked: kept?.repeat ? REPEATING_STAYS : null }}
          onCancel={close}
          // Open until Google has it: a refusal shows in the form, with the edit, to try again.
          onSave={(fields, starred, listId) =>
            occurrence ? google.editOccurrence(occurrence, fields).then(close) : save(item, fields, starred, target.series ? 'all' : undefined, listId, series ? 'series' : 'task').then((saved) => saved && close())
          }
        />
      </div>
    </div>
  );
};
