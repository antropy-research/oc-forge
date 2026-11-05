// What a Google task's row in the Tasks view is made of: its title, details and chips (its date and kept time,
// repeat, deadline, attachments, where it came from, the Planner task planning it), its star, and its ⋮ menu.
import type { GoogleTaskKept } from '../../../../src/domain/core/types.ts';
import { addDays } from '../../../../src/domain/core/dates.ts';
import { messageOf } from '../../../../src/domain/core/values.ts';
import { taskForGoogleTask, type GoogleTaskItem, type GoogleTaskList } from '../../../../src/domain/google/google.ts';
import { describeRecurrence } from '../../../../src/domain/google/rrule.ts';
import { taskOrigins } from '../../../../src/domain/google/taskAdvanced.ts';
import { KEPT_HINT, keptFor, keptTimeLabel } from '../../../../src/domain/google/taskKept.ts';
import { dueChip, indentTarget, moveDownTarget, moveUpTarget, outdentTarget, type MoveTarget, type TaskRow } from '../../../../src/domain/google/tasks.ts';
import { usePlanner, useView } from '../../../lib/core/context.ts';
import { useUi } from '../../../lib/core/ui.ts';
import { REPEATING_NO_SUBTASKS, REPEATING_STAYS, SHARED_NO_SUBTASKS } from '../../../lib/google/types.ts';
import { Icon } from '../../calendar/Icon.tsx';
import { plannedLabel } from '../../github/GitHubPanel.tsx';
import { askDelete, deleteWithUndo, indentProblem, inGoogle } from './actions.ts';
import { placed, useOutside, type MenuPlace } from './menu.ts';

/** A task's date (with its kept time), repeat, deadline, attachments and the Planner task planning it, as chips. */
const TaskChips = ({ item, kept, list }: { item: GoogleTaskItem; kept: GoogleTaskKept | null; list?: string }) => {
  const { host } = usePlanner();
  const view = useView();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const linked = taskForGoogleTask(view.state, item);
  const time = keptTimeLabel(kept);
  const deadline = kept?.deadline ?? null;
  const files = kept?.attachments ?? [];
  const origins = taskOrigins(item);
  if (!item.due && !deadline && !kept?.repeat && !linked && !list && !files.length && !origins.length) return null;
  return (
    <span class="gt-chips">
      {origins.map((origin, index) =>
        origin.url ? (
          <button key={`origin-${index}`} class="gt-file-chip gt-origin" aria-label={`${origin.label}${origin.detail ? `: ${origin.detail}` : ''}`} title={origin.detail || origin.label} onClick={(event) => { event.stopPropagation(); void host.openUrl(origin.url!); }}>
            <Icon name="link" size={13} /> {origin.label}{origin.detail ? `: ${origin.detail}` : ''}
          </button>
        ) : (
          <span key={`origin-${index}`} class="gt-file-chip gt-origin">{origin.label}</span>
        ),
      )}
      {files.slice(0, 2).map((file) => (
        <button key={file.id} class="gt-file-chip" aria-label={`Open attachment ${file.title}`} title={`${file.title} (Google Drive)`} onClick={(event) => { event.stopPropagation(); void host.openUrl(file.url); }}>
          <Icon name="attach" size={13} /> {file.title}
        </button>
      ))}
      {files.length > 2 && <span class="gt-file-chip is-more">+{files.length - 2}</span>}
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

/**
 * An open task's title, details and chips: a click edits it, except on a chip that opens something (an attachment,
 * the email or Doc it came from), which is a button of its own beside the edit button, never inside it.
 */
export const TaskBody = ({ item, kept, list, onEdit }: { item: GoogleTaskItem; kept: GoogleTaskKept | null; list?: string; onEdit: () => void }) => (
  <div class="gt-body" onClick={(event) => !(event.target as Element).closest('button') && onEdit()}>
    <button class="gt-body-edit" aria-label={`Edit ${item.title}`} onClick={onEdit}>
      <span class="gt-title">{item.title}</span>
      {item.notes && <span class="gt-notes">{item.notes.split('\n').slice(0, 2).join(' ')}</span>}
    </button>
    <TaskChips item={item} kept={kept} list={list} />
  </div>
);

/** Google Tasks' star, kept in the Planner. */
export const StarButton = ({ item, kept }: { item: GoogleTaskItem; kept: GoogleTaskKept | null }) => {
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

/** A task's ⋮ menu; sorted by date, the list's order is not on screen, so nothing moves in it. */
export const RowMenu = ({ row, rows, list, lists, ordered, place, onClose, onEdit, onSubtask }: { row: TaskRow; rows: TaskRow[]; list: GoogleTaskList; lists: GoogleTaskList[]; ordered: boolean; place: MenuPlace | null; onClose: () => void; onEdit: () => void; onSubtask: () => void }) => {
  const { google, client, host } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const ref = useOutside(true, onClose);
  const item = row.item;
  const linked = taskForGoogleTask(view.state, item);
  const act = (work: () => Promise<unknown>) => {
    onClose();
    void inGoogle(client.notify, work);
  };
  const move = (target: MoveTarget | null) => target && act(() => google.moveListTask(item, target));
  const elsewhere = lists.filter((other) => other.account === list.account && other.id !== list.id);
  const repeating = Boolean(keptFor(view.state, item)?.repeat);
  // As in Google Tasks, a repeating task takes no subtasks and is no subtask: those actions are unavailable, with the reason.
  const indent = ordered ? indentTarget(rows, item.id) : null;
  const indentBlock = indentProblem(view.state, rows, item, indent);
  const remove = async () => {
    const scope = keptFor(view.state, item)?.repeat ? await askDelete() : 'this';
    if (scope) await deleteWithUndo(google, client.notify, item, scope);
  };
  return (
    <div class="menu gt-menu" ref={ref} role="menu" aria-label={`Actions for ${item.title}`} style={placed(place)}>
      <button role="menuitem" onClick={() => { onClose(); onEdit(); }}>Edit</button>
      {row.depth === 0 && !item.parent && (
        <button role="menuitem" aria-disabled={repeating || item.assigned ? 'true' : undefined} title={repeating ? REPEATING_NO_SUBTASKS : item.assigned ? SHARED_NO_SUBTASKS : undefined} onClick={() => !repeating && !item.assigned && (onClose(), onSubtask())}>
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
