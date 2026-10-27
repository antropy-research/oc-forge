// A Google task's editor over the calendar, as Google Calendar's task details
// have one: the Tasks view's own form (title, details, date and time,
// deadline, repeat, star) and the task's list, in a dialog. The calendar stays
// on the view and date it was on. A repeating task asks This task or All
// tasks; opened from an upcoming occurrence it edits all of its series, which
// the form shows as the series has it.
import { useEffect } from 'preact/hooks';
import { addDays } from '../../../src/domain/dates.ts';
import { keptFor, seriesTemplate } from '../../../src/domain/gtaskKept.ts';
import { useGoogle, usePlanner, useView } from '../../lib/context.ts';
import { calendarUi, type TaskEditorTarget } from '../../lib/gcal.ts';
import { listKey, REPEATING_STAYS } from '../../lib/google.ts';
import { repeatBlock, TaskForm, useTaskSave } from '../TasksView.tsx';
import { Icon } from './Icon.tsx';

export const TaskEditor = ({ target }: { target: TaskEditorTarget }) => {
  const { google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const save = useTaskSave();
  const item = target.item;
  const key = listKey(item.account, item.listId);
  const board = gv.board[key];
  // Its list, read as the Tasks view reads it: a task with subtasks does not repeat.
  useEffect(() => {
    if (!board) void google.loadBoard(item.account, item.listId);
  }, [key]);
  const close = () => calendarUi.editTask(null);
  const kept = keptFor(view.state, item);
  const block = board ? repeatBlock(item, board.items) : item.parent ? repeatBlock(item, []) : null;
  // Until its list is read, a task that does not repeat yet is not offered one.
  const canRepeat = Boolean(kept?.repeat) || (Boolean(board) && !block);
  // All tasks of a series: its template's title, details, time and deadline, on the open occurrence's date.
  const template = target.series && kept ? seriesTemplate(kept, item) : null;
  const shown = template && kept ? { item: { ...item, title: template.title, notes: template.notes }, kept: { ...kept, time: template.time, duration: template.duration, deadline: template.deadline !== null && item.due ? addDays(item.due, template.deadline) : null } } : { item, kept };
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
          repeatNote={block}
          lists={{ lists: gv.lists.filter((list) => list.account === item.account), locked: kept?.repeat ? REPEATING_STAYS : null }}
          onCancel={close}
          onSave={(fields, starred, listId) => void save(item, fields, starred, target.series ? 'all' : undefined, listId).then((done) => done && close())}
        />
      </div>
    </div>
  );
};
