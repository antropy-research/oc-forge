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
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey, GoogleTaskKept, PlannerState, TaskAttachment, TaskVisibility } from '../../src/domain/types.ts';
import { DECLINE_MESSAGE_MAX, type DeclineInput } from '../../src/domain/events.ts';
import { DEFAULT_DECLINE_MESSAGE, colorName, moveList, orderedLists, taskListColor, taskListKey, taskOrigins } from '../../src/domain/gtaskAdvanced.ts';
import { TaskAttachments, TaskColorMenu } from './TaskExtras.tsx';
import { addDays, isDateKey } from '../../src/domain/dates.ts';
import { shortDay, weekdayShort } from '../../src/domain/gcalendar.ts';
import { describeRecurrence } from '../../src/domain/rrule.ts';
import { taskForGoogleTask, type GoogleTaskItem, type GoogleTaskList } from '../../src/domain/google.ts';
import { KEPT_HINT, TASKS_API_REFERENCE, VISIBILITY_LABELS, keptFor, keptTimeLabel, starredKept, taskRepeatPresets, visibilityOf } from '../../src/domain/gtaskKept.ts';
import { byTitle, completedItems, dateGroups, deadlineSections, dropTarget, indentTarget, moveBottomTarget, moveDownTarget, moveTopTarget, moveUpTarget, openRows, outdentTarget, type MoveTarget, type TaskRow } from '../../src/domain/gtasks.ts';
import { GOOGLE_DRAG_TYPE, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { calendarUi } from '../lib/gcal.ts';
import { DELETE_CHOICES, completeWithUndo, undoAction, REPEATING_NO_SUBTASKS, REPEATING_NOT_SUBTASK, REPEATING_STAYS, SHARED_NO_REPEAT, SHARED_NO_SUBTASKS, SUBTASK_NO_REPEAT, SUBTASKS_NO_REPEAT, advancedChanged, attachmentsChanged, listKey, type DeleteScope, type RepeatScope, type TaskFields } from '../lib/google.ts';
import { useUi } from '../lib/ui.ts';
import { plannedLabel } from './GitHubPanel.tsx';
import { Icon } from './calendar/Icon.tsx';
import { CustomRepeat } from './calendar/EventEditor.tsx';
import { endChoices, startChoices } from './calendar/form.ts';

/** A task row dragged within or between lists: account, list and task ids. */
const ROW_DRAG_TYPE = 'application/x-planner-gtask-row';
/** A task list dragged to another place in the sidebar: its key. */
const LIST_DRAG_TYPE = 'application/x-planner-gtask-list';
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
/**
 * The menu's place as inline style. Lengths are strings with their unit: Preact 11 no longer
 * adds "px" to numbers, and the browser drops a bare number. The other edge is reset, so
 * `.menu`'s own `top` cannot stretch a menu placed above its button.
 */
const placed = (place: MenuPlace | null) =>
  place
    ? {
        position: 'fixed',
        top: place.top === undefined ? 'auto' : `${place.top}px`,
        bottom: place.bottom === undefined ? 'auto' : `${place.bottom}px`,
        left: 'auto',
        right: `${place.right}px`,
        maxHeight: `${place.maxHeight}px`,
        overflowY: 'auto',
      }
    : undefined;

/** Why a task without a time has no availability or visibility to set, as Google Calendar has it. */
export const UNTIMED_ADVANCED = 'A task without a time is free and private, as in Google Calendar: give it a time to set these';
/** What a task's availability and visibility do here, and what they cannot do in Google. */
export const ADVANCED_NOTE =
  'Busy: the Planner plans other work around it (auto-schedule, playlist times). Visibility goes to the working sessions the Planner writes to Google Calendar for it; Google Calendar itself shows others no task the Planner times, as it gets no time for it and keeps a task without one private';
/** What a task's color does here. */
export const COLOR_NOTE = "Color: the task's on the Planner's calendar, over its list's (Google Calendar gets no color for a task from other apps)";
/** What Do not disturb does here, and what a web app can't mute. */
export const DND_NOTE =
  "Mutes the Planner's own task notifications during this task: they come when it ends. Google Chat, other apps and OpenChamber's own notifications aren't muted: the Planner can't reach them";
/** What "Automatically decline meetings" does here. */
export const DECLINE_NOTE =
  'The Planner answers the invitations on your calendar that overlap this task "Declined", with this message to the organizer, as Google Calendar does: its times in the next two weeks, and a later time once it comes within them';
/** Google Calendar's own words for declining when a task is Free. */
export const DECLINE_FREE = 'Unavailable for "Free" time entries';
/** Why a personal account's task has no Do not disturb or declining. */
export const WORKSPACE_ONLY = 'Do not disturb and Automatically decline meetings are for work and school accounts, as in Google Calendar';

/**
 * Title, details, Drive attachments, date and time (or all day), deadline,
 * repeat, star and advanced settings (color, availability, Do not disturb,
 * declining meetings and visibility) of a task, edited in place, as Google
 * Tasks' task form and Google Calendar's (and, over the calendar, its list).
 * A new task's form stays open after Enter for the next one, as Google Tasks
 * keeps adding. Subtasks, and tasks with subtasks, do not repeat, nor does a
 * repeating task take subtasks (nor in Google Tasks): those controls are
 * unavailable, with the reason. As in Google Calendar, only a task with a time
 * has availability, visibility, Do not disturb and declining (declining only
 * Busy), and only a work or school account has Do not disturb and declining.
 * One upcoming task of a series, edited alone, shows its series' repeat,
 * advanced settings and attachments there, unavailable, and no star (it is no
 * Google task yet). A save Google refuses leaves the form open with what was
 * typed and why, so Save can try again.
 */
export const TaskForm = ({ item, kept, depth, canRepeat, repeatNote = null, star = true, lists, onSave, onCancel, onSubtask, subtaskNote = null, keepOpen = false, advancedNote = null, account: accountProp, onAddBelow }: {
  item: Partial<GoogleTaskItem>;
  /** Enter in the title, once saved: a new task below this one (Google Tasks' "Add below"). */
  onAddBelow?: () => void;
  /** The account a new task goes to (its list's); an existing task's is its own. */
  account?: string;
  kept: GoogleTaskKept | null;
  depth: 0 | 1;
  canRepeat: boolean;
  /** Why it cannot repeat, or change its repeat, on the unavailable Repeat control. */
  repeatNote?: string | null;
  /** Whether it offers a star. */
  star?: boolean;
  /** The lists it may go to (over the calendar), and why it stays in its own. */
  lists?: { lists: GoogleTaskList[]; locked: string | null };
  /** Settles once Google has answered: rejected when it refused. */
  onSave: (fields: TaskFields, starred: boolean, listId?: string) => Promise<unknown>;
  onCancel: () => void;
  onSubtask?: () => void;
  /** Why it takes no subtasks, on the unavailable "Add subtask". */
  subtaskNote?: string | null;
  keepOpen?: boolean;
  /** Why its availability and visibility cannot change here (one task of a series: they are the series'). */
  advancedNote?: string | null;
}) => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title, setTitle] = useState(item.title ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [due, setDue] = useState<DateKey | null>(item.due ?? null);
  const [time, setTime] = useState<number | null>(kept?.time ?? null);
  const [duration, setDuration] = useState<number | null>(kept?.duration ?? null);
  const [deadline, setDeadline] = useState<DateKey | null>(kept?.deadline ?? null);
  const [rule, setRule] = useState<string | null>(kept?.repeat?.rule ?? null);
  const [starred, setStarred] = useState(Boolean(kept?.starredAt));
  const [busy, setBusy] = useState(Boolean(kept?.busy));
  const [visibility, setVisibility] = useState<TaskVisibility>(visibilityOf(kept));
  const [color, setColor] = useState<string | null>(kept?.color ?? null);
  const [attachments, setAttachments] = useState<TaskAttachment[]>(kept?.attachments ?? []);
  const [doNotDisturb, setDoNotDisturb] = useState(Boolean(kept?.doNotDisturb));
  const [decline, setDecline] = useState<DeclineInput | null>(kept?.decline ?? null);
  const [advanced, setAdvanced] = useState(Boolean(kept?.busy || kept?.visibility || kept?.color || kept?.doNotDisturb || kept?.decline));
  const [listId, setListId] = useState(item.listId ?? '');
  const account = item.account ?? accountProp ?? null;
  // Google Calendar gives only work and school accounts Do not disturb and declining meetings (null: not known yet).
  const eligible = account && gv.status ? google.isWorkspace(account) : null;
  const workspace = Boolean(eligible);
  const timed = Boolean(due) && time !== null;
  const listColor = taskListColor(view.state.settings, account ?? '', listId || item.listId || '');
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    titleRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  const date = due ?? view.today;
  const presets = taskRepeatPresets(date);
  const preset = rule ? presets.find((choice) => choice.rule === rule)?.id ?? 'custom' : 'none';
  /** A time or a repeat needs a date: today, unless one is set. */
  const dated = () => {
    if (!due) setDue(view.today);
  };
  const save = (fromEnter = false) => {
    if (saving) return;
    if (!title.trim()) return onCancel();
    setSaving(true);
    setProblem(null);
    // Google Calendar's repeating tasks have no end time; availability, visibility, Do not disturb and declining come
    // with a time, declining with Busy; an account not known yet to be a work or school one keeps the last two as they are.
    const fields = {
      time: due ? time : null,
      duration: due && time !== null && !rule ? duration : null,
      deadline,
      rule: due && canRepeat ? rule : null,
      busy: timed && busy,
      visibility: timed ? visibility : ('default' as const),
      color,
      attachments,
      doNotDisturb: eligible === null ? undefined : timed && eligible && doNotDisturb,
      decline: eligible === null ? undefined : timed && eligible && busy ? decline : null,
    };
    onSave({ title: title.trim(), notes, due, kept: fields }, starred, listId || undefined).then(
      (saved) => {
        if (fromEnter && saved !== false) onAddBelow?.();
        if (!mounted.current) return;
        setSaving(false);
        if (!keepOpen) return;
        setTitle('');
        setNotes('');
        setDue(null);
        setTime(null);
        setDuration(null);
        setDeadline(null);
        setRule(null);
        setStarred(false);
        setBusy(false);
        setVisibility('default');
        setColor(null);
        setAttachments([]);
        setDoNotDisturb(false);
        setDecline(null);
        setAdvanced(false);
        titleRef.current?.focus();
      },
      (error: unknown) => {
        const message = `Google Tasks did not take it: ${messageOf(error)}`;
        // Closed meanwhile: said where it shows.
        if (!mounted.current) return client.notify(message);
        setSaving(false);
        setProblem(message);
      },
    );
  };
  return (
    <div class={`gt-form depth-${depth}`} role="group" aria-label={item.id ? `Edit ${item.title}` : 'New task'} onKeyDown={(event) => event.key === 'Escape' && !custom && onCancel()}>
      <input ref={titleRef} class="gt-form-title" aria-label="Title" placeholder="Title" value={title} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && save(true)} />
      <textarea class="gt-form-notes" aria-label="Details" placeholder="Details" rows={2} value={notes} onInput={(event) => setNotes(event.currentTarget.value)} />
      {/* One task of a series attaches files to itself alone (This task), as Google Calendar does; All tasks to the series. */}
      <TaskAttachments account={account} files={attachments} note={null} onChange={setAttachments} />
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
            <option>{rule ? describeRecurrence([rule], date, zone) : 'Does not repeat'}</option>
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
      {lists && (
        <div class="gt-form-row" title={lists.locked ?? undefined}>
          <Icon name="task" size={16} />
          <select aria-label="List" value={listId} disabled={Boolean(lists.locked)} onChange={(event) => setListId(event.currentTarget.value)}>
            {lists.lists.map((list) => <option key={list.id} value={list.id}>{list.title}</option>)}
          </select>
          {lists.locked && <span class="gt-form-note">{lists.locked}</span>}
        </div>
      )}
      {star && (
        <div class="gt-form-row">
          <button class={`gt-star-toggle${starred ? ' is-on' : ''}`} aria-pressed={starred} aria-label="Star" onClick={() => setStarred(!starred)}>
            <Icon name={starred ? 'starred' : 'star'} size={18} /> {starred ? 'Starred' : 'Star'}
          </button>
        </div>
      )}
      <div class="gt-form-row gt-form-advanced">
        <Icon name="tune" size={16} />
        <button class="link" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced settings</button>
        {!advanced && <span class="gt-color-dot" style={{ background: color ?? listColor }} title={color ? colorName(color) : 'List color'} />}
        {!advanced && due && time !== null && (busy || visibility !== 'default' || (workspace && doNotDisturb)) && (
          <span class="gt-form-note">{busy ? 'Busy' : 'Free'} · {VISIBILITY_LABELS[visibility]}{workspace ? ` · Do not disturb is ${doNotDisturb ? 'ON' : 'OFF'}` : ''}</span>
        )}
      </div>
      {advanced && (
        <div class="gt-form-advanced-fields" role="group" aria-label="Advanced settings">
          <div class="gt-adv-row">
            <Icon name="calendar" size={16} />
            <TaskColorMenu color={color} listColor={listColor} disabled={Boolean(advancedNote)} note={advancedNote ?? undefined} onChange={setColor} />
            <span class="gt-adv-name">{color ? colorName(color) : 'List color'}</span>
          </div>
          <div class="gt-adv-row">
            <Icon name="work" size={16} />
            <select aria-label="Availability" value={timed && busy ? 'busy' : 'free'} disabled={!timed || Boolean(advancedNote)} title={advancedNote ?? (!timed ? UNTIMED_ADVANCED : 'Show me as busy or free')} onChange={(event) => setBusy(event.currentTarget.value === 'busy')}>
              <option value="free">Free</option>
              <option value="busy">Busy</option>
            </select>
          </div>
          {workspace && (
            <label class="gt-adv-check">
              <input type="checkbox" aria-label="Do not disturb" checked={timed && doNotDisturb} disabled={!timed || Boolean(advancedNote)} onChange={(event) => setDoNotDisturb(event.currentTarget.checked)} />
              <span class="gt-adv-check-text">
                <span class="gt-dnd-label"><span class="gt-dnd-mark"><Icon name="dnd" size={16} /></span>Do not disturb</span>
                <span class="gt-form-note">{DND_NOTE}</span>
              </span>
            </label>
          )}
          {workspace && (
            <label class="gt-adv-check">
              <input
                type="checkbox"
                aria-label="Automatically decline meetings"
                checked={timed && busy && decline !== null}
                disabled={!timed || !busy || Boolean(advancedNote)}
                onChange={(event) => setDecline(event.currentTarget.checked ? kept?.decline ?? { mode: 'new', message: DEFAULT_DECLINE_MESSAGE } : null)}
              />
              <span class="gt-adv-check-text">
                <span>Automatically decline meetings</span>
                <span class="gt-form-note">{!timed ? UNTIMED_ADVANCED : !busy ? DECLINE_FREE : DECLINE_NOTE}</span>
              </span>
            </label>
          )}
          {workspace && timed && busy && decline && (
            <div class="gt-adv-row gt-adv-decline" role="group" aria-label="Declining meetings">
              <select aria-label="Meetings to decline" value={decline.mode} disabled={Boolean(advancedNote)} onChange={(event) => setDecline({ ...decline, mode: event.currentTarget.value === 'all' ? 'all' : 'new' })}>
                <option value="new">Only new meeting invitations</option>
                <option value="all">New and existing meetings</option>
              </select>
              <input class="gt-adv-message" aria-label="Message" placeholder="Message" maxLength={DECLINE_MESSAGE_MAX} value={decline.message} disabled={Boolean(advancedNote)} onInput={(event) => setDecline({ ...decline, message: event.currentTarget.value })} />
            </div>
          )}
          <div class="gt-adv-row">
            <Icon name="lock" size={16} />
            <select aria-label="Visibility" value={timed ? visibility : 'default'} disabled={!timed || Boolean(advancedNote)} title={advancedNote ?? (!timed ? UNTIMED_ADVANCED : 'Who sees its details')} onChange={(event) => setVisibility(event.currentTarget.value as TaskVisibility)}>
              {(['default', 'public', 'private'] as const).map((choice) => <option key={choice} value={choice}>{VISIBILITY_LABELS[choice]}</option>)}
            </select>
          </div>
          <span class="gt-form-note">{advancedNote ?? (!timed ? UNTIMED_ADVANCED : ADVANCED_NOTE)}.</span>
          {!advancedNote && <span class="gt-form-note">{COLOR_NOTE}.</span>}
          {!workspace && account && <span class="gt-form-note">{WORKSPACE_ONLY}.</span>}
        </div>
      )}
      <KeptHint />
      {problem && <p class="danger gt-form-problem" role="alert">{problem}</p>}
      <div class="gt-form-row gt-form-actions">
        {(onSubtask || subtaskNote) && (
          <button class="link" aria-disabled={subtaskNote ? 'true' : undefined} title={subtaskNote ?? undefined} onClick={() => !subtaskNote && onSubtask?.()}>
            <Icon name="indent" size={16} /> Add subtask
          </button>
        )}
        <span class="nav-spacer" />
        <button class="link" onClick={onCancel}>Cancel</button>
        <button class="primary" disabled={saving} aria-busy={saving ? 'true' : undefined} onClick={() => save()}>{item.id ? 'Done' : 'Add'}</button>
      </div>
    </div>
  );
};

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
const TaskBody = ({ item, kept, list, onEdit }: { item: GoogleTaskItem; kept: GoogleTaskKept | null; list?: string; onEdit: () => void }) => (
  <div class="gt-body" onClick={(event) => !(event.target as Element).closest('button') && onEdit()}>
    <button class="gt-body-edit" aria-label={`Edit ${item.title}`} onClick={onEdit}>
      <span class="gt-title">{item.title}</span>
      {item.notes && <span class="gt-notes">{item.notes.split('\n').slice(0, 2).join(' ')}</span>}
    </button>
    <TaskChips item={item} kept={kept} list={list} />
  </div>
);

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

/** Ask which tasks of a series a change is for, as Google Calendar asks (This task or All tasks; a new rule is for all); null when cancelled. */
const askRepeat = async (ruleChanged = false): Promise<RepeatScope | null> => {
  const choices = ruleChanged ? [{ id: 'all', label: 'All tasks' }] : [{ id: 'this', label: 'This task' }, { id: 'all', label: 'All tasks' }];
  const choice = await calendarUi.ask({ title: 'Edit repeating task', style: 'radio', choices });
  return choice === 'this' || choice === 'all' ? choice : null;
};

/** Ask which tasks of a series a deletion is for, as Google Calendar asks (This task, This and following tasks, All tasks); null when cancelled. */
const askDelete = async (): Promise<DeleteScope | null> => {
  const choice = await calendarUi.ask({ title: 'Delete repeating task', style: 'radio', choices: DELETE_CHOICES });
  return DELETE_CHOICES.find((option) => option.id === choice)?.id ?? null;
};

/**
 * Save a task's form: a repeating one asks which tasks the change is for
 * (unless `scope` says), and a new list moves it there. All or nothing, as
 * `saveListTask` writes it: Google takes its fields and the move first, and
 * what the Planner keeps, the star too, changes only once it has. True when
 * saved, false when the question was cancelled; Google's refusal is thrown,
 * for the form to show beside what was typed.
 */
export const useTaskSave = () => {
  const { google } = usePlanner();
  const view = useView();
  return async (item: GoogleTaskItem, fields: TaskFields, starred: boolean, scope?: RepeatScope, listId?: string): Promise<boolean> => {
    const kept = keptFor(view.state, item);
    // Availability, visibility, color, Do not disturb and declining are a series' own: changing them is for all its
    // tasks, as a new rule is.
    const advanced = advancedChanged(fields.kept, kept);
    const changed =
      fields.title !== item.title || fields.notes !== item.notes || fields.due !== item.due || fields.kept.time !== (kept?.time ?? null) || fields.kept.duration !== (kept?.duration ?? null) || fields.kept.deadline !== (kept?.deadline ?? null) || fields.kept.rule !== (kept?.repeat?.rule ?? null) || advanced || attachmentsChanged(fields.kept, kept);
    const star = Boolean(kept?.starredAt) !== starred ? starred : undefined;
    const moveTo = listId && listId !== item.listId ? listId : undefined;
    if (changed) {
      const chosen = scope ?? (kept?.repeat ? await askRepeat(fields.kept.rule !== kept.repeat.rule || advanced) : 'this');
      if (!chosen) return false;
      await google.saveListTask(item, fields, chosen, { starred: star, listId: moveTo });
      return true;
    }
    // Only its list or its star: the move is Google's, made first; the star is the Planner's alone, with no Google write.
    const now = moveTo ? await google.moveListTask(item, { parent: null, previous: null }, moveTo) : item;
    if (star !== undefined) await google.setKept(now, { starred: star });
    return true;
  };
};

/** A task shown while Google adds it, until it answers with the task (`GoogleStore.addListTask`). */
const beingAdded = (item: GoogleTaskItem): boolean => item.id.startsWith('new-');

/** Why a task cannot repeat, as Google Tasks has it: a shared task, a subtask, or a task with subtasks (open or done); null when it can. */
export const repeatBlock = (item: GoogleTaskItem, items: readonly GoogleTaskItem[]): string | null =>
  item.assigned ? SHARED_NO_REPEAT : item.parent ? SUBTASK_NO_REPEAT : items.some((other) => other.parent === item.id) ? SUBTASKS_NO_REPEAT : null;

/** Google Tasks' keyboard shortcuts, as its help lists them ("⌘" on a Mac, "Ctrl" elsewhere), with what each does here. */
export const TASK_SHORTCUTS: readonly { keys: string; action: string; note?: string }[] = [
  { keys: 'Enter', action: "Create a task; in a task's title, Add below; on a selected task, open it" },
  { keys: 'Space', action: 'Mark a task as complete' },
  { keys: 'Ctrl/⌘ + ]', action: 'Indent task' },
  { keys: 'Ctrl/⌘ + [', action: 'Remove indent' },
  { keys: 'Ctrl/⌘ + Alt/Opt + Enter', action: 'Add sub-item' },
  { keys: 'Esc or Enter', action: 'Finish editing' },
  { keys: '. or v', action: 'More actions, Move to list' },
  { keys: 'Ctrl/⌘ + Up / Down', action: 'Move up / Move down' },
  { keys: 'Ctrl/⌘ + Shift + Up / Down', action: 'Move to top / Move to bottom' },
  { keys: 's, + or =', action: 'Add to starred (s again: Remove from starred)' },
  { keys: '-', action: 'Remove from starred' },
  { keys: 'Up / Down', action: 'Select the previous / next task' },
  { keys: 'Home / End (Opt + Up / Down)', action: 'Select first / Select last' },
  { keys: 'Ctrl/⌘ + /', action: 'Show the list of shortcuts' },
  { keys: 'Ctrl/⌘ + z', action: 'Undo (a deletion)' },
  { keys: 'Ctrl/⌘ + p', action: 'Print a task list', note: "The browser prints the page as shown: an extension's frame in OpenChamber can't open the print dialog itself" },
  { keys: '!', action: 'Report spam', note: "Shared tasks are reported in the Doc or Chat space they come from: Google's Tasks API has no spam report" },
];

/** The list of Google Tasks' shortcuts (Ctrl/⌘ + /). */
const ShortcutsDialog = ({ onClose }: { onClose: () => void }) => (
  <div class="modal-backdrop is-top" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
    <div class="modal gt-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="gt-editor-bar">
        <h2>Keyboard shortcuts</h2>
        <button class="icon-button" aria-label="Close" title="Close" ref={(element) => element?.focus()} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <table class="gt-shortcut-table">
        <tbody>
          {TASK_SHORTCUTS.map((shortcut) => (
            <tr key={shortcut.keys} class={shortcut.note ? 'is-unavailable' : ''}>
              <td><kbd>{shortcut.keys}</kbd></td>
              <td>
                {shortcut.action}
                {shortcut.note && <div class="gt-form-note">{shortcut.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

/** Delete, with Google Tasks' "Undo" in the snackbar (and on Ctrl/⌘+Z). */
const deleteWithUndo = async (google: ReturnType<typeof usePlanner>['google'], notify: (message: string) => void, item: GoogleTaskItem, scope: DeleteScope) => {
  await google.deleteListTask(item, scope);
  calendarUi.snack(scope === 'this' ? 'Task deleted' : 'Tasks deleted', undoAction(google, notify));
};

/** Why a task cannot be indented under the task above, as Google Tasks has it: a repeating or shared task is no subtask and takes none. */
const indentProblem = (state: PlannerState, rows: readonly TaskRow[], item: GoogleTaskItem, indent: MoveTarget | null): string | null => {
  if (!indent) return null;
  if (keptFor(state, item)?.repeat) return REPEATING_NOT_SUBTASK;
  if (indent.parent && keptFor(state, { account: item.account, id: indent.parent })?.repeat) return REPEATING_NO_SUBTASKS;
  if (indent.parent && rows.find((row) => row.item.id === indent.parent)?.item.assigned) return SHARED_NO_SUBTASKS;
  return null;
};

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
  /** Google Tasks' "Sort by": the list's own order, by date, by deadline, starred recently or by title (where dragging does not reorder). */
  const [sort, setSort] = useState<SortBy>('mine');
  const [clearing, setClearing] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const listMenuRef = useOutside(listMenu, () => {
    setListMenu(false);
    setClearing(false);
  });
  const run = (work: () => Promise<unknown>) => work().catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`));
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
  const addTask = (fields: TaskFields, starred: boolean, where: { parent: string | null; previous: string | null }) =>
    google.addListTask(list.account, list.id, { title: fields.title, notes: fields.notes, due: fields.due, parent: where.parent, previous: where.previous }, {
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
          event.dataTransfer?.setData(GOOGLE_DRAG_TYPE, JSON.stringify({ kind: 'gtask', item }));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
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
              addsBelow(index) && (
                <li key={`below-${item.id}`} class="gt-row depth-0 is-editing">
                  <TaskForm
                    item={{}}
                    account={list.account}
                    kept={null}
                    depth={0}
                    canRepeat
                    onCancel={() => setAdding(null)}
                    onSave={(fields, starred) => {
                      const where = adding!;
                      return addTask(fields, starred, where).then(() => setAdding(null));
                    }}
                  />
                </li>
              ),
              // A new subtask goes after its parent's last subtask; the one on its way to Google does not move the form, which stays until Google has it.
              adding?.parent && !beingAdded(item) && adding.parent === (row.depth === 0 ? item.id : item.parent) && !(rows[index + 1]?.depth === 1 && rows[index + 1]?.item.parent === adding.parent && !beingAdded(rows[index + 1]!.item)) && (
                <li key={`add-${item.id}`} class="gt-row depth-1 is-editing">
                  <TaskForm
                    item={{}}
                    account={list.account}
                    kept={null}
                    depth={1}
                    canRepeat={false}
                    onCancel={() => setAdding(null)}
                    onSave={(fields, starred) => {
                      const where = adding;
                      return addTask(fields, starred, where).then(() => setAdding(null));
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

/**
 * Google Tasks' Starred: the starred open tasks of every list, the newest star first or by date; each edits in
 * place, its primary list too; a starred task is added from here to the list chosen.
 */
const StarredColumn = ({ lists }: { lists: GoogleTaskList[] }) => {
  const { google, client } = usePlanner();
  const gv = useGoogle();
  const view = useView();
  const saveTask = useTaskSave();
  const [editing, setEditing] = useState<string | null>(null);
  const [order, setOrder] = useState<'starred' | 'date'>('starred');
  const [menu, setMenu] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuPlace | null>(null);
  const menuRef = useOutside(menu, () => setMenu(false));
  const [adding, setAdding] = useState(false);
  const [addTo, setAddTo] = useState<string>(() => {
    const first = lists.find((list) => list.isDefault) ?? lists[0];
    return first ? listKey(first.account, first.id) : '';
  });
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
  const found = starred.flatMap((kept) => {
    const item = gv.board[listKey(kept.account, kept.listId)]?.items.find((other) => other.id === kept.taskId);
    const list = lists.find((other) => other.account === kept.account && other.id === kept.listId);
    return item && !item.completed ? [{ item, kept, list: list ? `${list.title}${several ? ` · ${list.account}` : ''}` : '' }] : [];
  });
  // Google Tasks' Starred sorts by "Recently starred" or by "Date" (its date, then the ones without one).
  const rows = order === 'date' ? [...found].sort((a, b) => (a.item.due ?? '9999').localeCompare(b.item.due ?? '9999') || (a.kept.time ?? -1) - (b.kept.time ?? -1)) : found;
  const loading = keys.some((key) => gv.board[key]?.loading);
  const target = lists.find((list) => listKey(list.account, list.id) === addTo) ?? lists[0];
  return (
    <section class="gt-list" aria-label="Starred">
      <header class="gt-list-head">
        <h2>Starred</h2>
        <div class="menu-anchor" ref={menuRef}>
          <button class="more is-visible" aria-label="Starred options" aria-haspopup="menu" onClick={(click) => { setMenuAt(placeMenu(click.currentTarget)); setMenu(!menu); }}>
            <Icon name="more" size={18} />
          </button>
          {menu && (
            <div class="menu" role="menu" aria-label="Starred options" style={placed(menuAt)}>
              <div class="menu-label">Sort by</div>
              {([['date', 'Date'], ['starred', 'Recently starred']] as const).map(([id, label]) => (
                <button key={id} role="menuitemradio" aria-checked={order === id} onClick={() => { setMenu(false); setOrder(id); }}>
                  <span class="menu-check">{order === id ? '✓' : ''}</span>{label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <button class="gt-add" onClick={() => setAdding(true)}>
        <Icon name="task" size={20} />
        <span>Add a starred task</span>
      </button>
      {adding && target && (
        <div class="gt-starred-add">
          <label class="gt-form-row gt-starred-list">
            <Icon name="task" size={16} />
            <span class="gt-form-label">Its list</span>
            <select aria-label="List for the starred task" value={listKey(target.account, target.id)} onChange={(event) => setAddTo(event.currentTarget.value)}>
              {lists.map((list) => <option key={listKey(list.account, list.id)} value={listKey(list.account, list.id)}>{list.title}{several ? ` · ${list.account}` : ''}</option>)}
            </select>
          </label>
          <TaskForm
            key={listKey(target.account, target.id)}
            item={{ account: target.account, listId: target.id }}
            kept={null}
            depth={0}
            canRepeat
            keepOpen
            star={false}
            onCancel={() => setAdding(false)}
            // Starred from the start, in the list chosen (its primary list), as Google Tasks adds one from Starred.
            onSave={(fields) =>
              google.addListTask(target.account, target.id, { title: fields.title, notes: fields.notes, due: fields.due }, {
                time: fields.kept.time, duration: fields.kept.duration, deadline: fields.kept.deadline, rule: fields.kept.rule, starred: true, busy: fields.kept.busy, visibility: fields.kept.visibility, color: fields.kept.color, attachments: fields.kept.attachments, doNotDisturb: fields.kept.doNotDisturb, decline: fields.kept.decline,
              })
            }
          />
        </div>
      )}
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
                // Its primary list, as Google Tasks' Starred changes it (a repeating task stays in its own).
                lists={{ lists: lists.filter((other) => other.account === item.account), locked: kept.repeat ? REPEATING_STAYS : null }}
                onCancel={() => setEditing(null)}
                onSave={(fields, star, listId) => saveTask(item, fields, star, undefined, listId).then((saved) => saved && setEditing(null))}
              />
            </li>
          ) : (
            <li key={item.id} class="gt-row depth-0 is-starred-row" aria-label={item.title}>
              <span class="gt-handle" aria-hidden="true" />
              <button class="gt-check" role="checkbox" aria-checked="false" aria-label={`Mark ${item.title} complete`} onClick={() => void completeWithUndo(google, client.notify, item).catch((error) => client.notify(`Google Tasks did not take it: ${messageOf(error)}`))}>
                <Icon name="circle" size={20} />
                <span class="gt-check-hover"><Icon name="check" size={14} /></span>
              </button>
              <TaskBody item={item} kept={kept} list={list} onEdit={() => setEditing(item.id)} />
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
  const [shortcuts, setShortcuts] = useState(false);
  const [draggedList, setDraggedList] = useState<string | null>(null);
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
        {selected === 'starred' ? <StarredColumn lists={lists} /> : shown.map((list) => <ListColumn key={listKey(list.account, list.id)} list={list} lists={lists} several={several} />)}
        {selected !== 'starred' && !shown.length && <p class="hint tasks-hint">{gv.lists.length ? 'Tick a list to show it here.' : 'No task lists yet: create one.'}</p>}
      </div>
    </div>
  );
};
