// The Google Tasks app in the Planner: lists in a sidebar (all of them side by
// side, one, or Starred; create, rename, delete, put in order), each list's
// tasks in their order with subtasks one level in (or by date, deadline,
// starred recently or title), drag to reorder, nest or move to another list,
// edit in place, Google Tasks' keyboard shortcuts, Delete with Undo, and a
// "Completed" section. A task has Google's date and what Google Tasks' API
// does not let other apps set, kept in the Planner and said so where it is
// set: a time (and an end), a deadline, a repeat, a star, Drive attachments,
// and its advanced settings (color, availability, Do not disturb, declining
// meetings, visibility). A shared task, or one from Gmail or Keep, says where
// it came from. Each task shows the Planner task planning it, and can be
// planned from here.
//
// This file is the view: the lists in the sidebar and the ones shown, Starred, and the view's own keys. Its parts are
// in tasks/: a list's column (ListColumn), Starred (StarredColumn), a task's row (TaskRow) and its form (TaskForm,
// with its color and Drive attachments in TaskExtras), what they do to tasks (actions), their menus (menu), the
// printed list (PrintSheet) and the shortcuts dialog.
import { useEffect, useState } from 'preact/hooks';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleTaskList } from '../../../src/domain/google/google.ts';
import { moveList, orderedLists, taskListKey } from '../../../src/domain/google/taskAdvanced.ts';
import { KEPT_HINT, starredKept } from '../../../src/domain/google/taskKept.ts';
import { calendarUi } from '../../lib/calendar/calendarUi.ts';
import { useGoogle, usePlanner, useView } from '../../lib/core/context.ts';
import { listKey } from '../../lib/google/types.ts';
import { forgeNow } from '../../lib/openchamber/forge.ts';
import { PRINT_NEEDS_HOST, canPrint, printShown } from '../../lib/openchamber/print.ts';
import { Icon } from '../calendar/Icon.tsx';
import { ListColumn } from './tasks/ListColumn.tsx';
import { ShortcutsDialog } from './tasks/ShortcutsDialog.tsx';
import { StarredColumn } from './tasks/StarredColumn.tsx';

// The calendar's task editor (calendar/TaskEditor.tsx) edits a Google task with the Tasks view's own form.
export { TaskForm } from './tasks/TaskForm.tsx';
export { repeatBlock, useTaskSave } from './tasks/actions.ts';

/** A task list dragged to another place in the sidebar: its key. */
const LIST_DRAG_TYPE = 'application/x-planner-gtask-list';
const REFRESH_MS = 2 * 60_000;

/** Google Tasks: "All tasks" (every ticked list side by side), Starred, or one list, and the lists to choose from. */
export const TasksView = () => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const [selected, setSelected] = useState<string>('all');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [draggedList, setDraggedList] = useState<string | null>(null);
  /** The list the focus was last in: Print list's target from the keyboard, among several. */
  const [focusedList, setFocusedList] = useState<string | null>(null);
  // The lists in the order the user put them (dragged, or Alt+Up/Down), as Google Tasks keeps it; the Planner's.
  const lists = orderedLists(gv.lists, view.state.settings.googleTaskListOrder);
  const reorder = (from: number, to: number, focus = false) => {
    const order = moveList(lists, from, to);
    void client.dispatch([{ type: 'settings.updated', patch: { googleTaskListOrder: order } }]);
    if (focus) setTimeout(() => document.querySelector<HTMLElement>(`.tasks-lists li[data-list="${CSS.escape(order[to]!)}"] .tasks-nav`)?.focus(), 0);
  };
  /**
   * Ctrl/⌘+/: the shortcuts; Ctrl/⌘+Z: Undo the last deletion or completion (a text field keeps its own undo). From
   * the Tasks view, or with nothing focused while it is shown.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      if (!mod || event.altKey || event.defaultPrevented || !(target === document.body || target.closest?.('.tasks-app'))) return;
      if (event.key === '/') {
        event.preventDefault();
        setShortcuts(true);
        return;
      }
      if (event.key.toLowerCase() === 'p' && !event.shiftKey) {
        // Ctrl/⌘+P outside a list (a list prints itself): the list shown, the one the focus was last in, or Starred.
        event.preventDefault();
        if (!canPrint(forgeNow())) client.notify(PRINT_NEEDS_HOST);
        else printShown();
        return;
      }
      if (event.key.toLowerCase() === 'z' && !event.shiftKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !target.isContentEditable && google.canUndo()) {
        event.preventDefault();
        void google
          .undoLast()
          .then((done) => {
            if (done) calendarUi.snack(done.done);
            if (done?.note) client.notify(done.note);
          })
          .catch((error: unknown) => client.notify(`Google Tasks did not undo it: ${messageOf(error)}`));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const accounts = gv.status ? google.accountsWith('tasks') : [];
  const [account, setAccount] = useState<string | null>(null);
  const starredKeys = [...new Set(starredKept(view.state).map((kept) => listKey(kept.account, kept.listId)))];
  const shownKeys = selected === 'starred' ? starredKeys : (selected === 'all' ? gv.lists.filter((list) => !hidden.has(listKey(list.account, list.id))) : gv.lists.filter((list) => listKey(list.account, list.id) === selected)).map((list) => listKey(list.account, list.id));
  // Changes made in Google Tasks come in while the view is open: every two minutes, and when the window comes back.
  useEffect(() => {
    const reload = () => {
      if (document.hidden) return;
      for (const key of shownKeys) {
        const [owner, listId] = key.split('\n');
        if (owner && listId) void google.loadBoard(owner, listId);
      }
    };
    const timer = setInterval(reload, REFRESH_MS);
    document.addEventListener('visibilitychange', reload);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [shownKeys.join('|')]);
  if (!gv.status) return <p class="hint tasks-hint">Checking Google…</p>;
  if (!accounts.length) return <p class="hint tasks-hint">Connect a Google account with Tasks in Settings → Google to see Google Tasks here.</p>;
  const several = accounts.length > 1;
  const shown = selected === 'all' ? lists.filter((list) => !hidden.has(listKey(list.account, list.id))) : lists.filter((list) => listKey(list.account, list.id) === selected);
  const openCount = (list: GoogleTaskList) => gv.board[listKey(list.account, list.id)]?.items.filter((item) => !item.completed).length;
  // What prints (print media, Print list from the keyboard): the list with the focus, else the first shown.
  const printKey = shown.some((list) => listKey(list.account, list.id) === focusedList) ? focusedList : shown[0] ? listKey(shown[0].account, shown[0].id) : null;
  const create = (title: string) => {
    const owner = account ?? accounts[0]!.email;
    setCreating(false);
    google
      .createList(owner, title)
      .then((list) => setSelected(listKey(list.account, list.id)))
      .catch((error) => client.notify(`Google Tasks did not make the list: ${messageOf(error)}`));
  };
  return (
    <div class="tasks-app">
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      <nav class="tasks-side" aria-label="Task lists">
        <button class={`tasks-nav${selected === 'all' ? ' is-active' : ''}`} aria-current={selected === 'all' ? 'page' : undefined} onClick={() => setSelected('all')}>
          <Icon name="task" size={18} /> All tasks
        </button>
        <button class={`tasks-nav${selected === 'starred' ? ' is-active' : ''}`} aria-current={selected === 'starred' ? 'page' : undefined} title={KEPT_HINT} onClick={() => setSelected('starred')}>
          <Icon name="star" size={18} /> Starred
        </button>
        <div class="tasks-nav-head">Lists</div>
        <ul class="tasks-lists" aria-label="Lists">
          {lists.map((list, index) => {
            const key = listKey(list.account, list.id);
            const count = openCount(list);
            return (
              <li
                key={key}
                data-list={taskListKey(list.account, list.id)}
                class={`${selected === key ? 'is-active' : ''}${draggedList === key ? ' is-dragging' : ''}`}
                draggable
                onDragStart={(event) => {
                  setDraggedList(key);
                  event.dataTransfer?.setData(LIST_DRAG_TYPE, key);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDraggedList(null)}
                onDragOver={(event) => {
                  if (!event.dataTransfer?.types.includes(LIST_DRAG_TYPE)) return;
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  const from = lists.findIndex((other) => listKey(other.account, other.id) === event.dataTransfer?.getData(LIST_DRAG_TYPE));
                  setDraggedList(null);
                  if (from < 0 || from === index) return;
                  event.preventDefault();
                  reorder(from, index);
                }}
              >
                <input type="checkbox" aria-label={`Show ${list.title} in All tasks`} checked={!hidden.has(key)} onChange={(event) => {
                  const next = new Set(hidden);
                  if (event.currentTarget.checked) next.delete(key);
                  else next.add(key);
                  setHidden(next);
                }} />
                <button
                  class="tasks-nav"
                  aria-current={selected === key ? 'page' : undefined}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title="Drag, or Alt + Up / Down, to move the list"
                  onClick={() => setSelected(key)}
                  onKeyDown={(event) => {
                    // Google Tasks' Alt + Up / Down moves the highlighted list.
                    if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                    event.preventDefault();
                    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
                    if (to >= 0 && to < lists.length) reorder(index, to, true);
                  }}
                >
                  <span class="tasks-list-name">{list.title}</span>
                  {several && <span class="muted"> · {list.account}</span>}
                </button>
                {count !== undefined && count > 0 && <span class="nav-badge">{count}</span>}
              </li>
            );
          })}
        </ul>
        {creating ? (
          <div class="tasks-new-list">
            {several && (
              <select aria-label="Account for the new list" value={account ?? accounts[0]!.email} onChange={(event) => setAccount(event.currentTarget.value)}>
                {accounts.map((item) => <option key={item.email} value={item.email}>{item.email}</option>)}
              </select>
            )}
            <input
              class="nav-input"
              aria-label="New list name"
              placeholder="Enter name"
              ref={(element) => element?.focus()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false);
                if (event.key === 'Enter' && event.currentTarget.value.trim()) create(event.currentTarget.value.trim());
              }}
            />
          </div>
        ) : (
          <button class="tasks-nav" onClick={() => setCreating(true)}><Icon name="add" size={18} /> Create new list</button>
        )}
        <button class="tasks-nav tasks-shortcuts" aria-keyshortcuts="Control+/ Meta+/" onClick={() => setShortcuts(true)}>
          <Icon name="info" size={18} /> Keyboard shortcuts
        </button>
        {gv.tasksError && <p class="feed-errors" role="alert">{gv.tasksError}</p>}
      </nav>
      <div class="tasks-board">
        {selected === 'starred' ? (
          <StarredColumn lists={lists} />
        ) : (
          shown.map((list) => <ListColumn key={listKey(list.account, list.id)} list={list} several={several} printTarget={printKey === listKey(list.account, list.id)} onFocus={() => setFocusedList(listKey(list.account, list.id))} />)
        )}
        {selected !== 'starred' && !shown.length && <p class="hint tasks-hint">{gv.lists.length ? 'Tick a list to show it here.' : 'No task lists yet: create one.'}</p>}
      </div>
    </div>
  );
};
