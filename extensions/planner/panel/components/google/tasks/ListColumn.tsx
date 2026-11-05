// One Google task list in the Tasks view, as a Google Tasks column: "Add a task", its tasks in their order with
// subtasks one level in (or by date, deadline, starred recently or title), dragged to reorder, nest or move to another
// list, edited in place, Google Tasks' keyboard shortcuts on the selected task, List options, and "Completed".
import { useEffect, useRef, useState } from 'preact/hooks';
import { messageOf } from '../../../../src/domain/core/values.ts';
import { taskForGoogleTask, type GoogleTaskItem, type GoogleTaskList } from '../../../../src/domain/google/google.ts';
import { keptFor } from '../../../../src/domain/google/taskKept.ts';
import { printedList } from '../../../../src/domain/google/taskPrint.ts';
import { byTitle, completedItems, dateGroups, deadlineSections, dropTarget, dueChip, indentTarget, moveBottomTarget, moveDownTarget, moveTopTarget, moveUpTarget, openRows, outdentTarget, type MoveTarget, type TaskRow } from '../../../../src/domain/google/tasks.ts';
import { calendarUi } from '../../../lib/calendar/calendarUi.ts';
import { useGoogle, usePlanner, useView } from '../../../lib/core/context.ts';
import { useUi } from '../../../lib/core/ui.ts';
import { dragGoogle } from '../../../lib/google/sources.ts';
import { completeWithUndo } from '../../../lib/google/store.ts';
import { listKey, REPEATING_NO_SUBTASKS, SHARED_NO_SUBTASKS, type TaskFields } from '../../../lib/google/types.ts';
import { useForge } from '../../../lib/openchamber/forge.ts';
import { PRINT_NEEDS_HOST, canPrint, printNow } from '../../../lib/openchamber/print.ts';
import { Icon } from '../../calendar/Icon.tsx';
import { addFromForm, beingAdded, deleteWithUndo, indentProblem, inGoogle, repeatBlock, useTaskSave } from './actions.ts';
import { placeMenu, placed, useOutside, type MenuPlace } from './menu.ts';
import { TaskListSheet, usePrintable } from './PrintSheet.tsx';
import { TaskForm } from './TaskForm.tsx';
import { RowMenu, StarButton, TaskBody } from './TaskRow.tsx';

/** A task row dragged within or between lists: account, list and task ids. */
const ROW_DRAG_TYPE = 'application/x-planner-gtask-row';
/** The task row being dragged, which a drop marker cannot read from the drag while it is over a list. */
let draggedRow: string | null = null;

type SortBy = 'mine' | 'date' | 'deadline' | 'starred' | 'title';
/** Google Tasks' "Sort by", in its order. */
const SORTS: readonly { id: SortBy; label: string }[] = [
  { id: 'mine', label: 'My order' },
  { id: 'date', label: 'Date' },
  { id: 'deadline', label: 'Deadline' },
  { id: 'starred', label: 'Starred recently' },
  { id: 'title', label: 'Title' },
];

/** One list, as a Google Tasks column: "Add a task", its tasks and subtasks, "Completed". */
export const ListColumn = ({ list, several, printTarget, onFocus }: { list: GoogleTaskList; several: boolean; printTarget: boolean; onFocus: () => void }) => {
  const { google, client } = usePlanner();
  const forge = useForge();
  const gv = useGoogle();
  const view = useView();
  const { setUi } = useUi();
  const saveTask = useTaskSave();
  const key = listKey(list.account, list.id);
  const board = gv.board[key];
  useEffect(() => {
    if (!board) void google.loadBoard(list.account, list.id);
  }, [key]);
  const items = board?.items ?? [];
  const rows = openRows(items);
  const done = completedItems(items);
  const [adding, setAdding] = useState<{ parent: string | null; previous: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [listMenu, setListMenu] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuPlace | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [drop, setDrop] = useState<{ index: number; child: boolean } | null>(null);
  /** Google Tasks' "Sort by": the list's own order, by date, by deadline, starred recently or by title (where dragging does not reorder). */
  const [sort, setSort] = useState<SortBy>('mine');
  const [clearing, setClearing] = useState(false);
  /**
   * What Print list prints of this list, as it shows now: its tasks in its order (as sorted), each subtask under its
   * task, and its completed ones when Completed is open, as Google Tasks prints them.
   */
  const sheet = () =>
    printedList({ title: list.title, account: several ? list.account : null, items, kept: (item) => keptFor(view.state, item), sort, today: view.today, zone: view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, showCompleted: showDone, complete: board?.complete ?? true });
  usePrintable(printTarget, sheet);
  /** List options → Print list, and Ctrl/⌘+P in the list: the browser's print dialog, for this list alone. */
  const printList = () => (canPrint(forge) ? printNow(<TaskListSheet sheet={sheet()} />) : client.notify(PRINT_NEEDS_HOST));
  const listRef = useRef<HTMLUListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const listMenuRef = useOutside(listMenu, () => {
    setListMenu(false);
    setClearing(false);
  });
  const run = (work: () => Promise<unknown>) => inGoogle(client.notify, work);
  /** A repeating task of this account: it takes no subtasks and is no subtask. */
  const repeats = (id: string | null): boolean => Boolean(id && keptFor(view.state, { account: list.account, id })?.repeat);
  /** A shared task (assigned from a Doc or a Chat space): it takes no subtasks. */
  const shared = (id: string | null): boolean => Boolean(id && items.find((one) => one.id === id)?.assigned);
  /** The focus back on a task's row (after a move from the keyboard). */
  const focusTask = (id: string) => setTimeout(() => sectionRef.current?.querySelector<HTMLElement>(`li[data-task="${CSS.escape(id)}"] .gt-body-edit`)?.focus(), 0);

  /**
   * Google Tasks' keyboard shortcuts on the selected task (the row with the focus), never while typing in a form:
   * Up/Down, Home/End (Opt+Up/Down) select; Space completes; Ctrl/⌘+] and [ indent and unindent; Ctrl/⌘+Alt+Enter
   * adds a subtask; Ctrl/⌘(+Shift)+Up/Down move (to the top or the bottom, in "My order"); s, + and = star, s and -
   * unstar; . and v open its menu (more actions, move to list). Enter edits it; Enter in its title adds one below.
   */
  const onKey = (event: KeyboardEvent) => {
    // Ctrl/⌘+P anywhere in the list, a field too: Print list, as Google Tasks binds it.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      return printList();
    }
    const target = event.target as HTMLElement;
    if (target.closest('.gt-form, .menu, .modal') || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const rowEl = target.closest<HTMLElement>('li[data-task]');
    const item = rowEl ? items.find((one) => one.id === rowEl.dataset.task) : undefined;
    if (!rowEl || !item || item.completed || beingAdded(item)) return;
    const mod = event.metaKey || event.ctrlKey;
    const { key, altKey: alt, shiftKey: shift } = event;
    const shown = Array.from(sectionRef.current?.querySelectorAll<HTMLElement>('ul.gt-rows:not([hidden]) > li[data-task]') ?? []);
    const at = shown.indexOf(rowEl);
    const select = (element: HTMLElement | undefined) => element?.querySelector<HTMLElement>('.gt-body-edit')?.focus();
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const kept = keptFor(view.state, item);
    const row = rows.find((one) => one.item.id === item.id);
    const ordered = sort === 'mine' && Boolean(row);
    const move = (to: MoveTarget | null, problem: string | null = null) => {
      if (problem) return client.notify(problem);
      if (to) void run(() => google.moveListTask(item, to)).then(() => focusTask(item.id));
    };
    if (!mod && !alt && !shift && (key === 'ArrowDown' || key === 'ArrowUp')) {
      take();
      return select(shown[at + (key === 'ArrowDown' ? 1 : -1)]);
    }
    if ((!mod && !alt && key === 'Home') || (alt && !mod && key === 'ArrowUp')) {
      take();
      return select(shown[0]);
    }
    if ((!mod && !alt && key === 'End') || (alt && !mod && key === 'ArrowDown')) {
      take();
      return select(shown.at(-1));
    }
    if (!mod && !alt && key === ' ') {
      take();
      // The selection goes on to the next task, as the completed one leaves the list.
      select(shown[at + 1] ?? shown[at - 1]);
      return void run(() => completeWithUndo(google, client.notify, item));
    }
    if (mod && alt && key === 'Enter') {
      take();
      if (row?.depth !== 0 || item.parent) return;
      if (kept?.repeat) return client.notify(REPEATING_NO_SUBTASKS);
      if (item.assigned) return client.notify(SHARED_NO_SUBTASKS);
      return subtaskOf(item);
    }
    if (mod && !alt && (key === ']' || key === '[')) {
      take();
      if (!ordered) return client.notify('Tasks move in "My order": List options → Sort by → My order');
      if (key === ']') {
        const to = indentTarget(rows, item.id);
        return move(to, indentProblem(view.state, rows, item, to));
      }
      return move(outdentTarget(rows, item.id));
    }
    if (mod && !alt && (key === 'ArrowUp' || key === 'ArrowDown')) {
      take();
      if (!ordered) return client.notify('Tasks move in "My order": List options → Sort by → My order');
      const up = key === 'ArrowUp';
      return move(shift ? (up ? moveTopTarget : moveBottomTarget)(rows, item.id) : (up ? moveUpTarget : moveDownTarget)(rows, item.id));
    }
    if (mod || alt) return;
    const starred = Boolean(kept?.starredAt);
    if (key === 's' || key === '+' || key === '=' || key === '-') {
      take();
      const want = key === 's' ? !starred : key !== '-';
      if (want !== starred) void google.toggleStar(item).catch((error) => client.notify(messageOf(error)));
      return;
    }
    if (key === '.' || key === 'v') {
      take();
      rowEl.querySelector<HTMLElement>('button.more')?.click();
    }
  };

  const dropIndex = (clientY: number): number => {
    const elements = Array.from(listRef.current?.querySelectorAll<HTMLElement>(':scope > li[data-task]') ?? []);
    const index = elements.findIndex((element) => {
      const box = element.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return index === -1 ? elements.length : index;
  };
  const addRow = (parent: string | null, previous: string | null) => {
    setEditing(null);
    setAdding({ parent, previous });
  };
  const subtaskOf = (item: GoogleTaskItem) => {
    setSort('mine');
    addRow(item.id, rows.filter((row) => row.item.parent === item.id).at(-1)?.item.id ?? null);
  };
  /** A new task from its form, which shows Google's refusal (and keeps what was typed). */
  const addTask = (fields: TaskFields, starred: boolean, where: { parent: string | null; previous: string | null }) => addFromForm(google, list.account, list.id, fields, starred, where);
  /** The form of the new task `adding` asks for, below a task (`depth` 0) or a subtask (1), until Google has it. */
  const newRow = (key: string, depth: 0 | 1) => (
    <li key={key} class={`gt-row depth-${depth} is-editing`}>
      <TaskForm item={{}} account={list.account} kept={null} depth={depth} canRepeat={depth === 0} onCancel={() => setAdding(null)} onSave={(fields, starred) => addTask(fields, starred, adding!).then(() => setAdding(null))} />
    </li>
  );

  /** One open task: check, title, details, date and time, deadline, repeat, the Planner task planning it, star and menu; edited in place. */
  const openRow = (row: TaskRow) => {
    const item = row.item;
    const kept = keptFor(view.state, item);
    const linked = taskForGoogleTask(view.state, item);
    if (editing === item.id) {
      return (
        <li key={item.id} data-task={item.id} class={`gt-row depth-${row.depth} is-editing`}>
          <TaskForm
            item={item}
            kept={kept}
            depth={row.depth}
            canRepeat={Boolean(kept?.repeat) || (row.depth === 0 && !repeatBlock(item, items))}
            repeatNote={repeatBlock(item, items)}
            onCancel={() => setEditing(null)}
            onSubtask={row.depth === 0 && !item.parent && !kept?.repeat && !item.assigned ? () => subtaskOf(item) : undefined}
            subtaskNote={row.depth === 0 && !item.parent ? (kept?.repeat ? REPEATING_NO_SUBTASKS : item.assigned ? SHARED_NO_SUBTASKS : null) : null}
            // Open until Google has it: a refusal shows here, with the edit, to try again.
            onSave={(fields, starred) => saveTask(item, fields, starred).then((saved) => saved && setEditing(null))}
            // Enter in its title: saved, and a new task below it, as Google Tasks adds one ("Add below").
            onAddBelow={sort === 'mine' ? () => addRow(item.parent ?? null, item.id) : undefined}
          />
        </li>
      );
    }
    return (
      <li
        key={item.id}
        data-task={item.id}
        class={`gt-row depth-${row.depth}${menu === item.id ? ' has-menu' : ''}`}
        draggable
        aria-label={item.title}
        onDragEnd={() => (draggedRow = null)}
        onDragStart={(event) => {
          draggedRow = item.id;
          event.dataTransfer?.setData(ROW_DRAG_TYPE, `${item.account}\n${item.listId}\n${item.id}`);
          // Onto the calendar or a day, the task is planned there.
          dragGoogle(event, { kind: 'gtask', item });
        }}
      >
        <span class="gt-handle" aria-hidden="true"><Icon name="drag" size={16} /></span>
        <button class="gt-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} onClick={() => void run(() => completeWithUndo(google, client.notify, item))}>
          <Icon name="circle" size={20} />
          <span class="gt-check-hover"><Icon name="check" size={14} /></span>
        </button>
        <TaskBody item={item} kept={kept} onEdit={() => { setAdding(null); setEditing(item.id); }} />
        {linked && <button class="link gt-open" aria-label={`Open the Planner task for ${item.title}`} onClick={() => setUi({ openTaskId: linked.id })}>Open</button>}
        <StarButton item={item} kept={kept} />
        <div class="menu-anchor">
          <button
            class="more"
            aria-label={`Actions for ${item.title}`}
            aria-haspopup="menu"
            onClick={(click) => {
              setMenuAt(placeMenu(click.currentTarget));
              setMenu(menu === item.id ? null : item.id);
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {menu === item.id && <RowMenu row={row} rows={rows} list={list} lists={gv.lists} ordered={sort === 'mine'} place={menuAt} onClose={() => setMenu(null)} onEdit={() => setEditing(item.id)} onSubtask={() => subtaskOf(item)} />}
        </div>
      </li>
    );
  };

  // "Starred recently": the starred tasks first, the newest star first, then the rest in the list's order.
  const starredFirst = sort === 'starred' ? [...rows.map((row) => row.item)].sort((a, b) => (keptFor(view.state, b)?.starredAt ?? '').localeCompare(keptFor(view.state, a)?.starredAt ?? '')) : [];
  const sections = sort === 'date' ? dateGroups(items, view.today) : sort === 'deadline' ? deadlineSections(items, view.today, (item) => keptFor(view.state, item)?.deadline ?? null) : [];
  /** "Add below" a top-level task: the new task's form under it and its subtasks. */
  const addsBelow = (index: number): boolean => {
    if (!adding || adding.parent !== null || !adding.previous) return false;
    const row = rows[index]!;
    const next = rows[index + 1];
    const mine = row.item.id === adding.previous || (row.depth === 1 && row.item.parent === adding.previous);
    return mine && !(next?.depth === 1 && next.item.parent === adding.previous);
  };

  return (
    <section
      class="gt-list"
      aria-label={list.title}
      ref={sectionRef}
      onKeyDown={onKey}
      onFocusIn={onFocus}
      // Space completed the selected task on its way down: on its way up it must not click (edit) it too.
      onKeyUp={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === ' ' && target.closest('li[data-task]') && !target.closest('.gt-form, .menu')) event.preventDefault();
      }}
    >
      <header class="gt-list-head">
        {renaming ? (
          <input
            class="gt-rename"
            aria-label="List name"
            defaultValue={list.title}
            ref={(element) => element?.focus()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRenaming(false);
              if (event.key !== 'Enter') return;
              const title = event.currentTarget.value.trim();
              setRenaming(false);
              if (title && title !== list.title) void run(() => google.renameList(list, title));
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <h2>{list.title}{several && <span class="muted gt-account"> · {list.account}</span>}</h2>
        )}
        <div class="menu-anchor" ref={listMenuRef}>
          <button
            class="more is-visible"
            aria-label={`List options for ${list.title}`}
            aria-haspopup="menu"
            onClick={(click) => {
              setMenuAt(placeMenu(click.currentTarget));
              setListMenu(!listMenu);
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {listMenu && (
            <div class="menu" role="menu" aria-label={`List options for ${list.title}`} style={placed(menuAt)}>
              <div class="menu-label">Sort by</div>
              {SORTS.map((choice) => (
                <button key={choice.id} role="menuitemradio" aria-checked={sort === choice.id} onClick={() => { setListMenu(false); setSort(choice.id); }}>
                  <span class="menu-check">{sort === choice.id ? '✓' : ''}</span>{choice.label}
                </button>
              ))}
              <hr />
              <button role="menuitem" onClick={() => { setListMenu(false); setRenaming(true); }}>Rename list</button>
              <button
                role="menuitem"
                class="danger"
                disabled={list.isDefault}
                title={list.isDefault ? 'Google does not let anyone delete the default list' : undefined}
                onClick={() => {
                  setListMenu(false);
                  void run(() => google.deleteList(list));
                }}
              >
                Delete list{list.isDefault ? ' (the default list stays)' : ''}
              </button>
              {clearing ? (
                <div class="menu-confirm" role="group" aria-label="Delete all completed tasks?">
                  <span>Delete {done.length} completed task{done.length === 1 ? '' : 's'}?</span>
                  <button class="link" onClick={() => setClearing(false)}>Cancel</button>
                  <button
                    class="link danger"
                    onClick={() => {
                      setClearing(false);
                      setListMenu(false);
                      void run(() => google.clearCompleted(list.account, list.id).then((count) => calendarUi.snack(`${count} completed task${count === 1 ? '' : 's'} deleted`)));
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <button role="menuitem" class="danger" disabled={!done.length} onClick={() => setClearing(true)}>Delete all completed tasks</button>
              )}
              <button
                role="menuitem"
                disabled={!canPrint(forge)}
                aria-describedby={canPrint(forge) ? undefined : `print-note-${encodeURIComponent(key)}`}
                aria-keyshortcuts="Control+P Meta+P"
                title={canPrint(forge) ? 'Ctrl/⌘ + P' : PRINT_NEEDS_HOST}
                onClick={() => {
                  setListMenu(false);
                  printList();
                }}
              >
                Print list
              </button>
              {!canPrint(forge) && <div class="menu-note" id={`print-note-${encodeURIComponent(key)}`}>{PRINT_NEEDS_HOST}</div>}
              <button role="menuitem" onClick={() => { setListMenu(false); void google.loadBoard(list.account, list.id); }}>Refresh</button>
            </div>
          )}
        </div>
      </header>
      <button class="gt-add" onClick={() => addRow(null, null)}>
        <Icon name="task" size={20} />
        <span>Add a task</span>
      </button>
      {board?.error && <p class="feed-errors" role="alert">{board.error}</p>}
      {board && !board.complete && <p class="hint">This list is longer than the Planner reads at once; Google Tasks shows the rest.</p>}
      {!board?.items.length && board?.loading && <p class="hint">Loading…</p>}
      {adding && !adding.parent && !adding.previous && (
        <TaskForm item={{}} account={list.account} kept={null} depth={0} canRepeat keepOpen onCancel={() => setAdding(null)} onSave={(fields, starred) => addTask(fields, starred, { parent: null, previous: null })} />
      )}
      {(sort === 'date' || sort === 'deadline') && (
        <ul class="gt-rows" aria-label={`${list.title} tasks by ${sort}`}>
          {sections.map((group) => [
            <li key={`head-${group.kind}-${group.date}`} class={`gt-group-head${group.kind === 'past' ? ' is-overdue' : ''}`} role="presentation">
              {group.kind === 'past' ? 'Past' : group.kind === 'none' ? (sort === 'date' ? 'No date' : 'No deadline') : dueChip(group.date!, view.today)}
            </li>,
            ...group.items.map((item) => openRow({ item, depth: 0, children: 0 })),
          ])}
        </ul>
      )}
      {sort === 'starred' && <ul class="gt-rows" aria-label={`${list.title} tasks, starred recently`}>{starredFirst.map((item) => openRow({ item, depth: 0, children: 0 }))}</ul>}
      {sort === 'title' && <ul class="gt-rows" aria-label={`${list.title} tasks by title`}>{byTitle(items).map((item) => openRow({ item, depth: 0, children: 0 }))}</ul>}
      <ul
        class={`gt-rows${drop ? ' is-drop-target' : ''}`}
        ref={listRef}
        aria-label={`${list.title} tasks`}
        hidden={sort !== 'mine'}
        onDragOver={(event) => {
          if (sort !== 'mine' || !event.dataTransfer?.types.includes(ROW_DRAG_TYPE)) return;
          event.preventDefault();
          const box = listRef.current?.getBoundingClientRect();
          const index = dropIndex(event.clientY);
          // Dragged to the right it nests under the task above, unless one of the two repeats (as in Google Tasks).
          const shown = rows.filter((row) => row.item.id !== draggedRow);
          const above = shown[index - (rows.slice(0, index).some((row) => row.item.id === draggedRow) ? 2 : 1)];
          const parent = above ? (above.depth === 1 ? above.item.parent : above.item.id) : null;
          setDrop({ index, child: Boolean(box && event.clientX - box.left > 56) && Boolean(parent) && !repeats(parent) && !shared(parent) && !(draggedRow && repeats(draggedRow)) });
        }}
        onDragLeave={(event) => {
          if (!listRef.current?.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const at = drop;
          setDrop(null);
          const [account, fromList, id] = (event.dataTransfer?.getData(ROW_DRAG_TYPE) ?? '').split('\n');
          if (!at || !id || !fromList || account !== list.account) return;
          const sourceItems = fromList === list.id ? items : gv.board[listKey(account, fromList)]?.items ?? [];
          const source = sourceItems.find((item) => item.id === id);
          if (!source) return;
          // The index counts rows as shown, the dragged one still among them; its subtasks travel with it.
          const before = rows.slice(0, at.index).filter((row) => row.item.id !== id && row.item.parent !== id).length;
          const dragged: TaskRow = { item: source, depth: source.parent ? 1 : 0, children: sourceItems.filter((item) => item.parent === id && !item.completed).length };
          const target = dropTarget([...rows.filter((row) => row.item.id !== id), dragged], id, before, at.child, (other) => repeats(other) || (other !== id && shared(other)));
          void run(() => google.moveListTask(source, target, list.id));
        }}
      >
        {sort === 'mine' &&
          rows.map((row, index) => {
            const item = row.item;
            return [
              drop?.index === index && <li key={`drop-${item.id}`} class={`gt-drop${drop.child ? ' is-child' : ''}`} aria-hidden="true" />,
              openRow(row),
              // "Add below" a task: the new one's form under it (and its subtasks).
              addsBelow(index) && newRow(`below-${item.id}`, 0),
              // A new subtask goes after its parent's last subtask; the one on its way to Google does not move the form, which stays until Google has it.
              adding?.parent && !beingAdded(item) && adding.parent === (row.depth === 0 ? item.id : item.parent) && !(rows[index + 1]?.depth === 1 && rows[index + 1]?.item.parent === adding.parent && !beingAdded(rows[index + 1]!.item)) && newRow(`add-${item.id}`, 1),
            ];
          })}
        {drop?.index === rows.length && <li class={`gt-drop${drop.child ? ' is-child' : ''}`} aria-hidden="true" />}
      </ul>
      {board && !board.loading && rows.length === 0 && !adding && <p class="gt-empty">No tasks yet. Add one above.</p>}
      {done.length > 0 && (
        <div class="gt-done">
          <button class="gt-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <Icon name={showDone ? 'up' : 'down'} size={18} />
            Completed ({done.length})
          </button>
          {showDone && (
            <ul class="gt-rows" aria-label={`${list.title} completed tasks`}>
              {done.map((item) => (
                <li key={item.id} class="gt-row is-done" aria-label={item.title}>
                  <button class="gt-check is-checked" role="checkbox" aria-checked="true" aria-label={`Mark ${item.title} not complete`} onClick={() => void run(() => google.completeListTask(item, false))}>
                    <Icon name="check" size={18} />
                  </button>
                  <span class="gt-body">
                    <span class="gt-title">{item.title}</span>
                    {item.completedAt && <span class="gt-notes">Completed: {dueChip(item.completedAt.slice(0, 10), view.today)}</span>}
                  </span>
                  <button class="icon-button gt-delete" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => void run(() => deleteWithUndo(google, client.notify, item, 'this'))}><Icon name="delete" size={18} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
