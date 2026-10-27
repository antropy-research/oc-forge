// The Google Tasks app in the Planner: lists in a sidebar (all of them side by
// side, one, or Starred; create, rename, delete), each list's tasks in their
// order with subtasks one level in, drag to reorder, nest or move to another
// list, edit in place, and a "Completed" section. A task has Google's date and
// what Google Tasks' API does not let other apps set, kept in the Planner and
// said so where it is set: a time (and an end), a deadline, a repeat and a
// star. Each task shows the Planner task planning it, and can be planned from here.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey, GoogleTaskKept } from '../../src/domain/types.ts';
import { addDays, isDateKey } from '../../src/domain/dates.ts';
import { shortDay, weekdayShort } from '../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../src/domain/rrule.ts';
import { taskForGoogleTask, type GoogleTaskItem, type GoogleTaskList } from '../../src/domain/google.ts';
import { KEPT_HINT, TASKS_API_REFERENCE, keptFor, keptTimeLabel, starredKept, taskRepeatPresets } from '../../src/domain/gtaskKept.ts';
import { completedItems, dateGroups, dropTarget, indentTarget, moveDownTarget, moveUpTarget, openRows, outdentTarget, type MoveTarget, type TaskRow } from '../../src/domain/gtasks.ts';
import { GOOGLE_DRAG_TYPE, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { calendarUi } from '../lib/gcal.ts';
import { REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, REPEATING_STAYS, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT, listKey, type RepeatScope, type TaskFields } from '../lib/google.ts';
import { useUi } from '../lib/ui.ts';
import { plannedLabel } from './GitHubPanel.tsx';
import { Icon } from './calendar/Icon.tsx';
import { CustomRepeat } from './calendar/EventEditor.tsx';
import { endChoices, startChoices } from './calendar/form.ts';

/** A task row dragged within or between lists: account, list and task ids. */
const ROW_DRAG_TYPE = 'application/x-planner-gtask-row';
/** The task row being dragged, which a drop marker cannot read from the drag while it is over a list. */
let draggedRow: string | null = null;
const REFRESH_MS = 2 * 60_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "Today", "Tomorrow", "Wed, Oct 28", as Google Tasks labels a date. */
export const dueChip = (due: DateKey, today: DateKey): string => {
  if (due === today) return 'Today';
  if (due === addDays(today, 1)) return 'Tomorrow';
  if (due === addDays(today, -1)) return 'Yesterday';
  const label = `${weekdayShort(due).slice(0, 1)}${weekdayShort(due).slice(1).toLowerCase()}, ${shortDay(due)}`;
  return due.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${due.slice(0, 4)}`;
};

/** What the Planner keeps for Google tasks, and why it is kept here: Google's reference, opened in the browser. */
export const KeptHint = () => {
  const { host } = usePlanner();
  return (
    <p class="hint gt-kept-hint">
      <Icon name="info" size={14} />
      <span>{KEPT_HINT}.</span>
      <button class="link" onClick={() => void host.openUrl(TASKS_API_REFERENCE)}>Google's API reference</button>
    </p>
  );
};

/** Closes a menu on a click elsewhere, or when what is under it scrolls away. */
const useOutside = (open: boolean, onClose: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => !ref.current?.contains(event.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open]);
  return ref;
};

type MenuPlace = { top?: number; bottom?: number; right: number; maxHeight: number };

/** A menu fixed under its button (over it, near the bottom), so a list's scrolling does not cut it off. */
const placeMenu = (button: Element): MenuPlace => {
  const box = button.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - box.right);
  const below = window.innerHeight - box.bottom - 12;
  const above = box.top - 12;
  return below >= 280 || below >= above ? { top: box.bottom + 4, right, maxHeight: below } : { bottom: window.innerHeight - box.top + 4, right, maxHeight: above };
};
const placed = (place: MenuPlace | null) => (place ? { position: 'fixed', ...place, overflowY: 'auto' } : undefined);

/**
 * Title, details, date and time (or all day), deadline, repeat and star of a
 * task, edited in place, as Google Tasks' task form. A new task's form stays
 * open after Enter for the next one, as Google Tasks keeps adding. Subtasks,
 * and tasks with subtasks, do not repeat, nor does a repeating task take
 * subtasks (nor in Google Tasks): those controls are unavailable, with the
 * reason.
 */
const TaskForm = ({ item, kept, depth, canRepeat, repeatNote = null, onSave, onCancel, onSubtask, subtaskNote = null, keepOpen = false }: {
  item: Partial<GoogleTaskItem>;
  kept: GoogleTaskKept | null;
  depth: 0 | 1;
  canRepeat: boolean;
  /** Why it cannot repeat, on the unavailable Repeat control. */
  repeatNote?: string | null;
  onSave: (fields: TaskFields, starred: boolean) => void;
  onCancel: () => void;
  onSubtask?: () => void;
  /** Why it takes no subtasks, on the unavailable "Add subtask". */
  subtaskNote?: string | null;
  keepOpen?: boolean;
}) => {
  const view = useView();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState(item.title ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [due, setDue] = useState<DateKey | null>(item.due ?? null);
  const [time, setTime] = useState<number | null>(kept?.time ?? null);
  const [duration, setDuration] = useState<number | null>(kept?.duration ?? null);
  const [deadline, setDeadline] = useState<DateKey | null>(kept?.deadline ?? null);
  const [rule, setRule] = useState<string | null>(kept?.repeat?.rule ?? null);
  const [starred, setStarred] = useState(Boolean(kept?.starredAt));
  const [custom, setCustom] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const date = due ?? view.today;
  const presets = taskRepeatPresets(date);
  const preset = rule ? presets.find((choice) => choice.rule === rule)?.id ?? 'custom' : 'none';
  /** A time or a repeat needs a date: today, unless one is set. */
  const dated = () => {
    if (!due) setDue(view.today);
  };
  const save = () => {
    if (!title.trim()) return onCancel();
    // Google Calendar's repeating tasks have no end time.
    onSave({ title: title.trim(), notes, due, kept: { time: due ? time : null, duration: due && time !== null && !rule ? duration : null, deadline, rule: due && canRepeat ? rule : null } }, starred);
    if (!keepOpen) return;
    setTitle('');
    setNotes('');
    setDue(null);
    setTime(null);
    setDuration(null);
    setDeadline(null);
    setRule(null);
    setStarred(false);
    titleRef.current?.focus();
  };
  return (
    <div class={`gt-form depth-${depth}`} role="group" aria-label={item.id ? `Edit ${item.title}` : 'New task'} onKeyDown={(event) => event.key === 'Escape' && !custom && onCancel()}>
      <input ref={titleRef} class="gt-form-title" aria-label="Title" placeholder="Title" value={title} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && save()} />
      <textarea class="gt-form-notes" aria-label="Details" placeholder="Details" rows={2} value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
      <div class="gt-form-row" role="group" aria-label="Date and time">
        <Icon name="calendar" size={16} />
        <input type="date" aria-label="Date" value={due ?? ''} onChange={(event) => setDue(isDateKey(event.currentTarget.value) ? event.currentTarget.value : null)} />
        <select
          aria-label="Time"
          value={time === null ? '' : String(time)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTime(value ? Number(value) : null);
            if (!value) setDuration(null);
            else dated();
          }}
        >
          <option value="">All day</option>
          {startChoices().map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
        </select>
        {time !== null && !rule && (
          <select aria-label="End time" value={duration === null ? '' : String(time + duration)} onChange={(event) => setDuration(event.currentTarget.value ? Number(event.currentTarget.value) - time : null)}>
            <option value="">No end time</option>
            {endChoices(time).map((choice) => <option key={choice.value} value={String(choice.value)}>{choice.label}</option>)}
          </select>
        )}
        {due && (
          <button class="link" aria-label="Remove the date" onClick={() => { setDue(null); setTime(null); setDuration(null); setRule(null); }}>
            Clear
          </button>
        )}
      </div>
      <div class="gt-form-row">
        <Icon name="flag" size={16} />
        <span class="gt-form-label">Deadline</span>
        <input type="date" aria-label="Deadline" value={deadline ?? ''} onChange={(event) => setDeadline(isDateKey(event.currentTarget.value) ? event.currentTarget.value : null)} />
        {deadline && <button class="link" aria-label="Remove the deadline" onClick={() => setDeadline(null)}>Clear</button>}
      </div>
      {!canRepeat && repeatNote && (
        <div class="gt-form-row gt-form-repeat" title={repeatNote}>
          <Icon name="repeat" size={16} />
          <select aria-label="Repeat" disabled title={repeatNote}>
            <option>Does not repeat</option>
          </select>
          <span class="gt-form-note">{repeatNote}</span>
        </div>
      )}
      {canRepeat && (
        <div class="gt-form-row gt-form-repeat">
          <Icon name="repeat" size={16} />
          <select
            aria-label="Repeat"
            value={custom ? 'custom-open' : preset}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'custom-open') {
                setCustom(true);
                return dated();
              }
              if (value === 'custom') return;
              setCustom(false);
              const chosen = presets.find((choice) => choice.id === value)?.rule ?? null;
              setRule(chosen);
              if (chosen) {
                dated();
                setDuration(null);
              }
            }}
          >
            {presets.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
            {preset === 'custom' && rule && <option value="custom">{describeRecurrence([rule], date, zone)}</option>}
            <option value="custom-open">Custom…</option>
          </select>
          {custom && (
            <CustomRepeat
              start={date}
              allDay
              zone={zone}
              lines={rule ? [rule] : []}
              onCancel={() => setCustom(false)}
              onDone={(line) => {
                setCustom(false);
                setRule(line);
                setDuration(null);
                dated();
              }}
            />
          )}
        </div>
      )}
      <div class="gt-form-row">
        <button class={`gt-star-toggle${starred ? ' is-on' : ''}`} aria-pressed={starred} aria-label="Star" onClick={() => setStarred(!starred)}>
          <Icon name={starred ? 'starred' : 'star'} size={18} /> {starred ? 'Starred' : 'Star'}
        </button>
      </div>
      <KeptHint />
      <div class="gt-form-row gt-form-actions">
        {(onSubtask || subtaskNote) && (
          <button class="link" aria-disabled={subtaskNote ? 'true' : undefined} title={subtaskNote ?? undefined} onClick={() => !subtaskNote && onSubtask?.()}>
            <Icon name="indent" size={16} /> Add subtask
          </button>
        )}
        <span class="nav-spacer" />
        <button class="link" onClick={onCancel}>Cancel</button>
        <button class="primary" onClick={save}>{item.id ? 'Done' : 'Add'}</button>
      </div>
    </div>
  );
};

/** A task's date (with its kept time), repeat, deadline and the Planner task planning it, as chips. */
const TaskChips = ({ item, kept, list }: { item: GoogleTaskItem; kept: GoogleTaskKept | null; list?: string }) => {
  const view = useView();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const linked = taskForGoogleTask(view.state, item);
  const time = keptTimeLabel(kept);
  const deadline = kept?.deadline ?? null;
  if (!item.due && !deadline && !kept?.repeat && !linked && !list) return null;
  return (
    <span class="gt-chips">
      {item.due && (
        <span class={`gt-due${item.due < view.today && !item.completed ? ' is-overdue' : ''}`} title={time ? 'The time is kept in the Planner' : undefined}>
          {dueChip(item.due, view.today)}
          {time ? `, ${time}` : ''}
          {kept?.repeat && <span class="gt-repeat" title={describeRecurrence([kept.repeat.rule], item.due, zone)}><Icon name="repeat" size={13} /><span class="visually-hidden">, repeats {describeRecurrence([kept.repeat.rule], item.due, zone)}</span></span>}
        </span>
      )}
      {deadline && (
        <span class={`gt-deadline${deadline < view.today && !item.completed ? ' is-overdue' : ''}`}>
          <Icon name="flag" size={13} /> Deadline {dueChip(deadline, view.today)}
        </span>
      )}
      {list && <span class="gt-list-chip">{list}</span>}
      {linked && (
        <span class="gt-planned">
          <Icon name="link" size={14} /> Planned: {plannedLabel(linked, view.today)}
        </span>
      )}
    </span>
  );
};

/** Google Tasks' star, kept in the Planner. */
const StarButton = ({ item, kept }: { item: GoogleTaskItem; kept: GoogleTaskKept | null }) => {
  const { google, client } = usePlanner();
  const on = Boolean(kept?.starredAt);
  return (
    <button
      class={`gt-star${on ? ' is-on' : ''}`}
      aria-label={`Star ${item.title}`}
      aria-pressed={on}
      title={`${on ? 'Remove the star' : 'Add a star'} (${KEPT_HINT})`}
      onClick={() => void google.toggleStar(item).catch((error) => client.notify(messageOf(error)))}
    >
      <Icon name={on ? 'starred' : 'star'} size={18} />
    </button>
  );
};

/** Ask which tasks of a series a change or a deletion is for, as Google Tasks and Google Calendar ask; null when cancelled. */
const askRepeat = async (action: 'edit' | 'delete', ruleChanged = false): Promise<RepeatScope | null> => {
  const choices = action === 'delete' ? [{ id: 'this', label: 'This task' }, { id: 'all', label: 'All future tasks' }] : ruleChanged ? [{ id: 'all', label: 'All tasks' }] : [{ id: 'this', label: 'This task' }, { id: 'all', label: 'All tasks' }];
  const choice = await calendarUi.ask({ title: action === 'delete' ? 'Delete repeating task' : 'Edit repeating task', style: 'radio', choices });
  return choice === 'this' || choice === 'all' ? choice : null;
};

/** Save a task's form: a repeating one asks which tasks the change is for; the star is kept at once. */
const useTaskSave = () => {
  const { google, client } = usePlanner();
  const view = useView();
  return async (item: GoogleTaskItem, fields: TaskFields, starred: boolean) => {
    const kept = keptFor(view.state, item);
    const changed =
      fields.title !== item.title || fields.notes !== item.notes || fields.due !== item.due || fields.kept.time !== (kept?.time ?? null) || fields.kept.duration !== (kept?.duration ?? null) || fields.kept.deadline !== (kept?.deadline ?? null) || fields.kept.rule !== (kept?.repeat?.rule ?? null);
    try {
      if (changed) {
        const scope = kept?.repeat ? await askRepeat('edit', fields.kept.rule !== kept.repeat.rule) : 'this';
        if (!scope) return;
        await google.saveListTask(item, fields, scope);
      }
      if (Boolean(kept?.starredAt) !== starred) await google.setKept(item, { starred });
    } catch (error) {
      client.notify(`Google Tasks did not take it: ${messageOf(error)}`);
    }
  };
};

/** Why a task cannot repeat, as Google Tasks has it: a subtask, or a task with subtasks (open or done); null when it can. */
export const repeatBlock = (item: GoogleTaskItem, items: readonly GoogleTaskItem[]): string | null => (item.parent ? SUBTASK_NO_REPEAT : items.some((other) => other.parent === item.id) ? SUBTASKS_NO_REPEAT : null);

/** A task's ⋮ menu; sorted by date, the list's order is not on screen, so nothing moves in it. */
const RowMenu = ({ row, rows, list, lists, ordered, place, onClose, onEdit, onSubtask }: { row: TaskRow; rows: TaskRow[]; list: GoogleTaskList; lists: GoogleTaskList[]; ordered: boolean; place: MenuPlace | null; onClose: () => void; onEdit: () => void; onSubtask: () => void }) => {
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
  const repeating = Boolean(keptFor(view.state, item)?.repeat);
  // As in Google Tasks, a repeating task takes no subtasks and is no subtask: those actions are unavailable, with the reason.
  const indent = ordered ? indentTarget(rows, item.id) : null;
  const indentBlock = !indent ? null : repeating ? REPEATING_NOT_SUBTASK : indent.parent && keptFor(view.state, { account: item.account, id: indent.parent })?.repeat ? REPEATING_NO_SUBTASKS : null;
  const remove = async () => {
    const scope = keptFor(view.state, item)?.repeat ? await askRepeat('delete') : 'this';
    if (scope) await google.deleteListTask(item, scope);
  };
  return (
    <div class="menu gt-menu" ref={ref} role="menu" aria-label={`Actions for ${item.title}`} style={placed(place)}>
      <button role="menuitem" onClick={() => { onClose(); onEdit(); }}>Edit</button>
      {row.depth === 0 && !item.parent && (
        <button role="menuitem" aria-disabled={repeating ? 'true' : undefined} title={repeating ? REPEATING_NO_SUBTASKS : undefined} onClick={() => !repeating && (onClose(), onSubtask())}>
          Add a subtask
        </button>
      )}
      {indent && (
        <button role="menuitem" aria-disabled={indentBlock ? 'true' : undefined} title={indentBlock ?? undefined} onClick={() => !indentBlock && move(indent)}>
          Indent
        </button>
      )}
      {ordered && row.depth === 1 && <button role="menuitem" onClick={() => move(outdentTarget(rows, item.id))}>Unindent</button>}
      {ordered && moveUpTarget(rows, item.id) && <button role="menuitem" onClick={() => move(moveUpTarget(rows, item.id))}>Move up</button>}
      {ordered && moveDownTarget(rows, item.id) && <button role="menuitem" onClick={() => move(moveDownTarget(rows, item.id))}>Move down</button>}
      {elsewhere.map((other) => (
        <button
          key={other.id}
          role="menuitem"
          disabled={repeating}
          title={repeating ? REPEATING_STAYS : undefined}
          onClick={() => act(() => google.moveListTask(item, { parent: null, previous: null }, other.id))}
        >
          Move to {other.title}
        </button>
      ))}
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
      <button role="menuitem" class="danger" onClick={() => act(remove)}>Delete</button>
    </div>
  );
};

/** One list, as a Google Tasks column: "Add a task", its tasks and subtasks, "Completed". */
const ListColumn = ({ list, lists, several }: { list: GoogleTaskList; lists: GoogleTaskList[]; several: boolean }) => {
  const { google, client } = usePlanner();
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
  /** Google Tasks' "Sort by": the list's own order, by date, or starred recently (where dragging does not reorder). */
  const [sort, setSort] = useState<'mine' | 'date' | 'starred'>('mine');
  const [clearing, setClearing] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const listMenuRef = useOutside(listMenu, () => {
    setListMenu(false);
    setClearing(false);
  });
  const run = (work: () => Promise<unknown>) => work().catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`));
  /** A repeating task of this account: it takes no subtasks and is no subtask. */
  const repeats = (id: string | null): boolean => Boolean(id && keptFor(view.state, { account: list.account, id })?.repeat);

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
  const addTask = (fields: TaskFields, starred: boolean, where: { parent: string | null; previous: string | null }) =>
    void run(() => google.addListTask(list.account, list.id, { title: fields.title, notes: fields.notes, due: fields.due, parent: where.parent, previous: where.previous }, { time: fields.kept.time, duration: fields.kept.duration, deadline: fields.kept.deadline, rule: fields.kept.rule, starred }));

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
            onSubtask={row.depth === 0 && !item.parent && !kept?.repeat ? () => subtaskOf(item) : undefined}
            subtaskNote={row.depth === 0 && !item.parent && kept?.repeat ? REPEATING_NO_SUBTASKS : null}
            onSave={(fields, starred) => {
              setEditing(null);
              void saveTask(item, fields, starred);
            }}
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
          <TaskChips item={item} kept={kept} />
        </button>
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
              <button role="menuitemradio" aria-checked={sort === 'mine'} onClick={() => { setListMenu(false); setSort('mine'); }}><span class="menu-check">{sort === 'mine' ? '✓' : ''}</span>My order</button>
              <button role="menuitemradio" aria-checked={sort === 'date'} onClick={() => { setListMenu(false); setSort('date'); }}><span class="menu-check">{sort === 'date' ? '✓' : ''}</span>Date</button>
              <button role="menuitemradio" aria-checked={sort === 'starred'} onClick={() => { setListMenu(false); setSort('starred'); }}><span class="menu-check">{sort === 'starred' ? '✓' : ''}</span>Starred recently</button>
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
        <TaskForm item={{}} kept={null} depth={0} canRepeat keepOpen onCancel={() => setAdding(null)} onSave={(fields, starred) => addTask(fields, starred, { parent: null, previous: null })} />
      )}
      {sort === 'date' && (
        <ul class="gt-rows" aria-label={`${list.title} tasks by date`}>
          {dateGroups(items, view.today).map((group) => [
            <li key={`head-${group.kind}-${group.date}`} class={`gt-group-head${group.kind === 'past' ? ' is-overdue' : ''}`} role="presentation">
              {group.kind === 'past' ? 'Past' : group.kind === 'none' ? 'No date' : dueChip(group.date!, view.today)}
            </li>,
            ...group.items.map((item) => openRow({ item, depth: 0, children: 0 })),
          ])}
        </ul>
      )}
      {sort === 'starred' && <ul class="gt-rows" aria-label={`${list.title} tasks, starred recently`}>{starredFirst.map((item) => openRow({ item, depth: 0, children: 0 }))}</ul>}
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
          setDrop({ index, child: Boolean(box && event.clientX - box.left > 56) && Boolean(parent) && !repeats(parent) && !(draggedRow && repeats(draggedRow)) });
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
          const target = dropTarget([...rows.filter((row) => row.item.id !== id), dragged], id, before, at.child, repeats);
          void run(() => google.moveListTask(source, target, list.id));
        }}
      >
        {sort === 'mine' &&
          rows.map((row, index) => {
            const item = row.item;
            return [
              drop?.index === index && <li key={`drop-${item.id}`} class={`gt-drop${drop.child ? ' is-child' : ''}`} aria-hidden="true" />,
              openRow(row),
              // A new subtask goes after its parent's last subtask.
              adding?.parent && adding.parent === (row.depth === 0 ? item.id : item.parent) && !(rows[index + 1]?.depth === 1 && rows[index + 1]?.item.parent === adding.parent) && (
                <li key={`add-${item.id}`} class="gt-row depth-1 is-editing">
                  <TaskForm
                    item={{}}
                    kept={null}
                    depth={1}
                    canRepeat={false}
                    onCancel={() => setAdding(null)}
                    onSave={(fields, starred) => {
                      const where = adding;
                      setAdding(null);
                      addTask(fields, starred, where);
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

/** Google Tasks' Starred: the starred open tasks of every list, the newest star first; each edits in place. */
const StarredColumn = ({ lists }: { lists: GoogleTaskList[] }) => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const saveTask = useTaskSave();
  const [editing, setEditing] = useState<string | null>(null);
  const starred = starredKept(view.state);
  const keys = [...new Set(starred.map((kept) => listKey(kept.account, kept.listId)))];
  // Their lists are read, as each list's own column reads it.
  useEffect(() => {
    for (const key of keys) {
      const [account, listId] = key.split('\n');
      if (account && listId && !gv.board[key]) void google.loadBoard(account, listId);
    }
  }, [keys.join('|')]);
  const several = new Set(lists.map((list) => list.account)).size > 1;
  const rows = starred.flatMap((kept) => {
    const item = gv.board[listKey(kept.account, kept.listId)]?.items.find((other) => other.id === kept.taskId);
    const list = lists.find((other) => other.account === kept.account && other.id === kept.listId);
    return item && !item.completed ? [{ item, kept, list: list ? `${list.title}${several ? ` · ${list.account}` : ''}` : '' }] : [];
  });
  const loading = keys.some((key) => gv.board[key]?.loading);
  return (
    <section class="gt-list" aria-label="Starred">
      <header class="gt-list-head">
        <h2>Starred</h2>
      </header>
      <KeptHint />
      <ul class="gt-rows" aria-label="Starred tasks">
        {rows.map(({ item, kept, list }) =>
          editing === item.id ? (
            <li key={item.id} class="gt-row depth-0 is-editing">
              <TaskForm
                item={item}
                kept={kept}
                depth={0}
                canRepeat={Boolean(kept.repeat) || !repeatBlock(item, gv.board[listKey(item.account, item.listId)]?.items ?? [])}
                repeatNote={repeatBlock(item, gv.board[listKey(item.account, item.listId)]?.items ?? [])}
                onCancel={() => setEditing(null)}
                onSave={(fields, star) => {
                  setEditing(null);
                  void saveTask(item, fields, star);
                }}
              />
            </li>
          ) : (
            <li key={item.id} class="gt-row depth-0 is-starred-row" aria-label={item.title}>
              <span class="gt-handle" aria-hidden="true" />
              <button class="gt-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} onClick={() => void google.completeListTask(item, true).catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))}>
                <Icon name="circle" size={20} />
                <span class="gt-check-hover"><Icon name="check" size={14} /></span>
              </button>
              <button class="gt-body" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item.id)}>
                <span class="gt-title">{item.title}</span>
                {item.notes && <span class="gt-notes">{item.notes.split('\n').slice(0, 2).join(' ')}</span>}
                <TaskChips item={item} kept={kept} list={list} />
              </button>
              <StarButton item={item} kept={kept} />
            </li>
          ),
        )}
      </ul>
      {!rows.length && <p class="gt-empty">{loading ? 'Loading…' : 'No starred tasks. Star a task to see it here, from every list.'}</p>}
    </section>
  );
};

/** Google Tasks: "All tasks" (every ticked list side by side), Starred, or one list, and the lists to choose from. */
export const TasksView = () => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const [selected, setSelected] = useState<string>('all');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
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
        <button class={`tasks-nav${selected === 'starred' ? ' is-active' : ''}`} aria-current={selected === 'starred' ? 'page' : undefined} title={KEPT_HINT} onClick={() => setSelected('starred')}>
          <Icon name="star" size={18} /> Starred
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
        {selected === 'starred' ? <StarredColumn lists={gv.lists} /> : shown.map((list) => <ListColumn key={listKey(list.account, list.id)} list={list} lists={gv.lists} several={several} />)}
        {selected !== 'starred' && !shown.length && <p class="hint tasks-hint">{gv.lists.length ? 'Tick a list to show it here.' : 'No task lists yet: create one.'}</p>}
      </div>
    </div>
  );
};
