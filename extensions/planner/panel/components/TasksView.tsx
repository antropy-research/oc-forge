// The Google Tasks app in the Planner: lists in a sidebar (all of them side by
// side, or one; create, rename, delete), each list's tasks in their order with
// subtasks one level in, drag to reorder, nest or move to another list, edit in
// place, and a "Completed" section. Each task shows the Planner task planning
// it, and can be planned from here. Google's Tasks API keeps no due time and
// no stars; where a user would look for those, the view says so.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, isDateKey } from '../../src/domain/dates.ts';
import { shortDay, weekdayShort } from '../../src/domain/gcalendar.ts';
import { taskForGoogleTask, type GoogleTaskItem, type GoogleTaskList } from '../../src/domain/google.ts';
import { completedItems, dropTarget, indentTarget, moveDownTarget, moveUpTarget, openRows, outdentTarget, type MoveTarget, type TaskRow } from '../../src/domain/gtasks.ts';
import { GOOGLE_DRAG_TYPE, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { listKey } from '../lib/google.ts';
import { useUi } from '../lib/ui.ts';
import { plannedLabel } from './GitHubPanel.tsx';
import { Icon } from './calendar/Icon.tsx';

/** A task row dragged within or between lists: account, list and task ids. */
const ROW_DRAG_TYPE = 'application/x-planner-gtask-row';
const NO_STARS = "Google's Tasks API does not let other apps read or set stars: star tasks in Google Tasks";
const NO_TIME = "Date only: Google's Tasks API keeps no time for a task";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "Today", "Tomorrow", "Wed, Oct 28", as Google Tasks labels a date. */
export const dueChip = (due: DateKey, today: DateKey): string => {
  if (due === today) return 'Today';
  if (due === addDays(today, 1)) return 'Tomorrow';
  if (due === addDays(today, -1)) return 'Yesterday';
  const label = `${weekdayShort(due).slice(0, 1)}${weekdayShort(due).slice(1).toLowerCase()}, ${shortDay(due)}`;
  return due.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${due.slice(0, 4)}`;
};

const useOutside = (open: boolean, onClose: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return ref;
};

/** Title, details and date of a task, edited in place. */
const TaskForm = ({ item, depth, onSave, onCancel, onSubtask }: { item: Partial<GoogleTaskItem>; depth: 0 | 1; onSave: (fields: { title: string; notes: string; due: DateKey | null }) => void; onCancel: () => void; onSubtask?: () => void }) => {
  const [title, setTitle] = useState(item.title ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [due, setDue] = useState<DateKey | null>(item.due ?? null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const save = () => (title.trim() ? onSave({ title: title.trim(), notes, due }) : onCancel());
  return (
    <div class={`gt-form depth-${depth}`} role="group" aria-label={item.id ? `Edit ${item.title}` : 'New task'} onKeyDown={(event) => event.key === 'Escape' && onCancel()}>
      <input ref={titleRef} class="gt-form-title" aria-label="Title" placeholder="Title" value={title} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && save()} />
      <textarea class="gt-form-notes" aria-label="Details" placeholder="Details" rows={2} value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
      <div class="gt-form-row">
        <Icon name="calendar" size={16} />
        <input type="date" aria-label="Date" value={due ?? ''} onChange={(event) => setDue(isDateKey(event.currentTarget.value) ? event.currentTarget.value : null)} />
        {due && <button class="link" aria-label="Remove the date" onClick={() => setDue(null)}>Clear</button>}
        <span class="hint gt-no-time" title={NO_TIME}>No time: Google Tasks keeps only the date</span>
      </div>
      <div class="gt-form-row gt-form-actions">
        {onSubtask && <button class="link" onClick={onSubtask}><Icon name="indent" size={16} /> Add subtask</button>}
        <span class="nav-spacer" />
        <button class="link" onClick={onCancel}>Cancel</button>
        <button class="primary" onClick={save}>{item.id ? 'Done' : 'Add'}</button>
      </div>
    </div>
  );
};

const RowMenu = ({ row, rows, list, lists, onClose, onEdit, onSubtask }: { row: TaskRow; rows: TaskRow[]; list: GoogleTaskList; lists: GoogleTaskList[]; onClose: () => void; onEdit: () => void; onSubtask: () => void }) => {
  const { google, client, host } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const ref = useOutside(true, onClose);
  const item = row.item;
  const linked = taskForGoogleTask(view.state, item);
  const act = (work: () => Promise<unknown>) => {
    onClose();
    work().catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`));
  };
  const move = (target: MoveTarget | null) => target && act(() => google.moveListTask(item, target));
  const elsewhere = lists.filter((other) => other.account === list.account && other.id !== list.id);
  return (
    <div class="menu gt-menu" ref={ref} role="menu" aria-label={`Actions for ${item.title}`}>
      <button role="menuitem" onClick={() => { onClose(); onEdit(); }}>Edit</button>
      {row.depth === 0 && <button role="menuitem" onClick={() => { onClose(); onSubtask(); }}>Add a subtask</button>}
      {indentTarget(rows, item.id) && <button role="menuitem" onClick={() => move(indentTarget(rows, item.id))}>Indent</button>}
      {row.depth === 1 && <button role="menuitem" onClick={() => move(outdentTarget(rows, item.id))}>Unindent</button>}
      {moveUpTarget(rows, item.id) && <button role="menuitem" onClick={() => move(moveUpTarget(rows, item.id))}>Move up</button>}
      {moveDownTarget(rows, item.id) && <button role="menuitem" onClick={() => move(moveDownTarget(rows, item.id))}>Move down</button>}
      {elsewhere.map((other) => <button key={other.id} role="menuitem" onClick={() => act(() => google.moveListTask(item, { parent: null, previous: null }, other.id))}>Move to {other.title}</button>)}
      <hr />
      {linked ? (
        <button role="menuitem" onClick={() => { onClose(); setUi({ openTaskId: linked.id }); }}>Open the Planner task</button>
      ) : (
        <>
          <button role="menuitem" onClick={() => act(() => google.planTask(item, { kind: 'day', date: view.today }))}>Plan today</button>
          <button role="menuitem" onClick={() => act(() => google.planTask(item, { kind: 'day', date: addDays(view.today, 1) }))}>Plan tomorrow</button>
        </>
      )}
      <button role="menuitem" onClick={() => { onClose(); void host.openUrl(item.url); }}>Open in Google Tasks</button>
      <hr />
      <button role="menuitem" class="danger" onClick={() => act(() => google.deleteListTask(item))}>Delete</button>
    </div>
  );
};

/** One list, as a Google Tasks column: "Add a task", its tasks and subtasks, "Completed". */
const ListColumn = ({ list, lists, several }: { list: GoogleTaskList; lists: GoogleTaskList[]; several: boolean }) => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const { setUi } = useUi();
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
  const [renaming, setRenaming] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [drop, setDrop] = useState<{ index: number; child: boolean } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listMenuRef = useOutside(listMenu, () => setListMenu(false));
  const run = (work: () => Promise<unknown>) => work().catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`));

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
  const subtaskOf = (item: GoogleTaskItem) => addRow(item.id, rows.filter((row) => row.item.parent === item.id).at(-1)?.item.id ?? null);

  return (
    <section class="gt-list" aria-label={list.title}>
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
          <button class="more is-visible" aria-label={`List options for ${list.title}`} aria-haspopup="menu" onClick={() => setListMenu(!listMenu)}><Icon name="more" size={18} /></button>
          {listMenu && (
            <div class="menu" role="menu" aria-label={`List options for ${list.title}`}>
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
        <TaskForm
          item={{}}
          depth={0}
          onCancel={() => setAdding(null)}
          onSave={(fields) => {
            setAdding(null);
            void run(() => google.addListTask(list.account, list.id, { ...fields, parent: null, previous: null }));
          }}
        />
      )}
      <ul
        class={`gt-rows${drop ? ' is-drop-target' : ''}`}
        ref={listRef}
        aria-label={`${list.title} tasks`}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes(ROW_DRAG_TYPE)) return;
          event.preventDefault();
          const box = listRef.current?.getBoundingClientRect();
          setDrop({ index: dropIndex(event.clientY), child: Boolean(box && event.clientX - box.left > 56) });
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
          const target = dropTarget([...rows.filter((row) => row.item.id !== id), dragged], id, before, at.child);
          void run(() => google.moveListTask(source, target, list.id));
        }}
      >
        {rows.map((row, index) => {
          const item = row.item;
          const linked = taskForGoogleTask(view.state, item);
          const overdue = item.due !== null && item.due < view.today;
          return [
            drop?.index === index && <li key={`drop-${item.id}`} class={`gt-drop${drop.child ? ' is-child' : ''}`} aria-hidden="true" />,
            editing === item.id ? (
              <li key={item.id} data-task={item.id} class={`gt-row depth-${row.depth} is-editing`}>
                <TaskForm
                  item={item}
                  depth={row.depth}
                  onCancel={() => setEditing(null)}
                  onSubtask={row.depth === 0 ? () => subtaskOf(item) : undefined}
                  onSave={(fields) => {
                    setEditing(null);
                    const patch = { ...(fields.title !== item.title ? { title: fields.title } : {}), ...(fields.notes !== item.notes ? { notes: fields.notes } : {}), ...(fields.due !== item.due ? { due: fields.due } : {}) };
                    if (Object.keys(patch).length) void run(() => google.editListTask(item, patch));
                  }}
                />
              </li>
            ) : (
              <li
                key={item.id}
                data-task={item.id}
                class={`gt-row depth-${row.depth}${menu === item.id ? ' has-menu' : ''}`}
                draggable
                aria-label={item.title}
                onDragStart={(event) => {
                  event.dataTransfer?.setData(ROW_DRAG_TYPE, `${item.account}\n${item.listId}\n${item.id}`);
                  // Onto the calendar or a day, the task is planned there.
                  event.dataTransfer?.setData(GOOGLE_DRAG_TYPE, JSON.stringify({ kind: 'gtask', item }));
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
                }}
              >
                <span class="gt-handle" aria-hidden="true"><Icon name="drag" size={16} /></span>
                <button class="gt-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} onClick={() => void run(() => google.completeListTask(item, true))}>
                  <Icon name="circle" size={20} />
                  <span class="gt-check-hover"><Icon name="check" size={14} /></span>
                </button>
                <button class="gt-body" onClick={() => { setAdding(null); setEditing(item.id); }} aria-label={`Edit ${item.title}`}>
                  <span class="gt-title">{item.title}</span>
                  {item.notes && <span class="gt-notes">{item.notes.split('\n').slice(0, 2).join(' ')}</span>}
                  {(item.due || linked) && (
                    <span class="gt-chips">
                      {item.due && <span class={`gt-due${overdue ? ' is-overdue' : ''}`} title={NO_TIME}>{dueChip(item.due, view.today)}</span>}
                      {linked && (
                        <span class="gt-planned">
                          <Icon name="link" size={14} /> Planned: {plannedLabel(linked, view.today)}
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {linked && <button class="link gt-open" aria-label={`Open the Planner task for ${item.title}`} onClick={() => setUi({ openTaskId: linked.id })}>Open</button>}
                <button class="gt-star" aria-label={`Star ${item.title} (not available: ${NO_STARS})`} title={NO_STARS} aria-disabled="true" onClick={() => client.notify(NO_STARS)}>
                  <Icon name="star" size={18} />
                </button>
                <div class="menu-anchor">
                  <button class="more" aria-label={`Actions for ${item.title}`} aria-haspopup="menu" onClick={() => setMenu(menu === item.id ? null : item.id)}><Icon name="more" size={18} /></button>
                  {menu === item.id && <RowMenu row={row} rows={rows} list={list} lists={gv.lists} onClose={() => setMenu(null)} onEdit={() => setEditing(item.id)} onSubtask={() => subtaskOf(item)} />}
                </div>
              </li>
            ),
            // A new subtask goes after its parent's last subtask.
            adding?.parent && adding.parent === (row.depth === 0 ? item.id : item.parent) && !(rows[index + 1]?.depth === 1 && rows[index + 1]?.item.parent === adding.parent) && (
              <li key={`add-${item.id}`} class="gt-row depth-1 is-editing">
                <TaskForm
                  item={{}}
                  depth={1}
                  onCancel={() => setAdding(null)}
                  onSave={(fields) => {
                    const where = adding;
                    setAdding(null);
                    void run(() => google.addListTask(list.account, list.id, { ...fields, parent: where.parent, previous: where.previous }));
                  }}
                />
              </li>
            ),
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
                  <button class="icon-button gt-delete" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => void run(() => google.deleteListTask(item))}><Icon name="delete" size={18} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

/** Google Tasks: "All tasks" (every ticked list side by side) or one list, and the lists to choose from. */
export const TasksView = () => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const [selected, setSelected] = useState<string>('all');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const accounts = gv.status ? google.accountsWith('tasks') : [];
  const [account, setAccount] = useState<string | null>(null);
  if (!gv.status) return <p class="hint tasks-hint">Checking Google…</p>;
  if (!accounts.length) return <p class="hint tasks-hint">Connect a Google account with Tasks in Settings → Google to see Google Tasks here.</p>;
  const several = accounts.length > 1;
  const shown = selected === 'all' ? gv.lists.filter((list) => !hidden.has(listKey(list.account, list.id))) : gv.lists.filter((list) => listKey(list.account, list.id) === selected);
  const openCount = (list: GoogleTaskList) => gv.board[listKey(list.account, list.id)]?.items.filter((item) => !item.completed).length;
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
      <nav class="tasks-side" aria-label="Task lists">
        <button class={`tasks-nav${selected === 'all' ? ' is-active' : ''}`} aria-current={selected === 'all' ? 'page' : undefined} onClick={() => setSelected('all')}>
          <Icon name="task" size={18} /> All tasks
        </button>
        <button class="tasks-nav is-unavailable" aria-disabled="true" title={NO_STARS} onClick={() => client.notify(NO_STARS)}>
          <Icon name="star" size={18} /> Starred <span class="muted">· not in the API</span>
        </button>
        <div class="tasks-nav-head">Lists</div>
        <ul class="tasks-lists" aria-label="Lists">
          {gv.lists.map((list) => {
            const key = listKey(list.account, list.id);
            const count = openCount(list);
            return (
              <li key={key} class={selected === key ? 'is-active' : ''}>
                <input type="checkbox" aria-label={`Show ${list.title} in All tasks`} checked={!hidden.has(key)} onChange={(event) => {
                  const next = new Set(hidden);
                  if (event.currentTarget.checked) next.delete(key);
                  else next.add(key);
                  setHidden(next);
                }} />
                <button class="tasks-nav" aria-current={selected === key ? 'page' : undefined} onClick={() => setSelected(key)}>
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
        {gv.tasksError && <p class="feed-errors" role="alert">{gv.tasksError}</p>}
      </nav>
      <div class="tasks-board">
        {shown.map((list) => <ListColumn key={listKey(list.account, list.id)} list={list} lists={gv.lists} several={several} />)}
        {!shown.length && <p class="hint tasks-hint">{gv.lists.length ? 'Tick a list to show it here.' : 'No task lists yet: create one.'}</p>}
      </div>
    </div>
  );
};
