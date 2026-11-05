// A Google task's form, in the Tasks view and over the calendar (the task editor), as Google Tasks' task form and
// Google Calendar's have it; and the hint that says what the Planner keeps for a Google task, and why.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey, GoogleTaskKept, TaskAttachment, TaskVisibility } from '../../../../src/domain/core/types.ts';
import { DECLINE_MESSAGE_MAX, type DeclineInput } from '../../../../src/domain/core/events.ts';
import { isDateKey } from '../../../../src/domain/core/dates.ts';
import { messageOf } from '../../../../src/domain/core/values.ts';
import type { GoogleTaskItem, GoogleTaskList } from '../../../../src/domain/google/google.ts';
import { describeRecurrence } from '../../../../src/domain/google/rrule.ts';
import { DEFAULT_DECLINE_MESSAGE, colorName, taskListColor } from '../../../../src/domain/google/taskAdvanced.ts';
import { settleConflicts, type FormField, type FormValues } from '../../../../src/domain/google/taskForm.ts';
import { KEPT_HINT, TASKS_API_REFERENCE, VISIBILITY_LABELS, taskRepeatPresets, visibilityOf } from '../../../../src/domain/google/taskKept.ts';
import { useGoogle, usePlanner, useView } from '../../../lib/core/context.ts';
import { FreshnessError, TaskConflict, type TaskFields } from '../../../lib/google/types.ts';
import { CustomRepeat } from '../../calendar/EventEditor.tsx';
import { endChoices, startChoices } from '../../calendar/form.ts';
import { Icon } from '../../calendar/Icon.tsx';
import { ConflictBanner, RetryBanner, taskConflictLines } from '../../common/Conflicts.tsx';
import { TaskAttachments, TaskColorMenu } from './TaskExtras.tsx';

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

/** Why a task without a time has no availability or visibility to set, as Google Calendar has it. */
const UNTIMED_ADVANCED = 'A task without a time is free and private, as in Google Calendar: give it a time to set these';
/** What a task's availability and visibility do here, and what they cannot do in Google. */
const ADVANCED_NOTE =
  'Busy: the Planner plans other work around it (auto-schedule, playlist times). Visibility goes to the working sessions the Planner writes to Google Calendar for it; Google Calendar itself shows others no task the Planner times, as it gets no time for it and keeps a task without one private';
/** What a task's color does here. */
const COLOR_NOTE = "Color: the task's on the Planner's calendar, over its list's (Google Calendar gets no color for a task from other apps)";
/** What Do not disturb does here, and what a web app can't mute. */
const DND_NOTE =
  "Mutes the Planner's own task notifications during this task: they come when it ends. Google Chat, other apps and OpenChamber's own notifications aren't muted: the Planner can't reach them";
/** What "Automatically decline meetings" does here. */
const DECLINE_NOTE =
  'The Planner answers the invitations on your calendar that overlap this task "Declined", with this message to the organizer, as Google Calendar does: its times in the next two weeks, and a later time once it comes within them';
/** Google Calendar's own words for declining when a task is Free. */
const DECLINE_FREE = 'Unavailable for "Free" time entries';
/** Why a personal account's task has no Do not disturb or declining. */
const WORKSPACE_ONLY = 'Do not disturb and Automatically decline meetings are for work and school accounts, as in Google Calendar';

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
  // What the form showed when it opened: its save is the change from this, so a field it leaves alone keeps what
  // another window or the service gave it meanwhile (a time, a repeat cut short). Settling a conflict moves it on.
  const [shownAt, setShownAt] = useState<FormValues>(() => ({ title, notes, due, time, duration, deadline, rule, busy, visibility, color, attachments, doNotDisturb, decline, starred, listId }));
  const [conflict, setConflict] = useState<TaskConflict | null>(null);
  // The task could not be read as it is now: nothing was saved, and the edit stays to try again.
  const [unchecked, setUnchecked] = useState<FreshnessError | null>(null);
  const [again, setAgain] = useState(false);
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
  /**
   * The form's values as it saves them: a time only with a date, an end only
   * without a repeat, availability, visibility, Do not disturb and declining
   * only with a time (declining only Busy, the last two only for a work or
   * school account), a repeat only where it may repeat.
   */
  const valuesOf = (raw: FormValues): FormValues => {
    const timedThen = Boolean(raw.due) && raw.time !== null;
    const busyThen = timedThen && raw.busy;
    return {
      ...raw,
      title: raw.title.trim(),
      time: raw.due ? raw.time : null,
      duration: raw.due && raw.time !== null && !raw.rule ? raw.duration : null,
      rule: raw.due && canRepeat ? raw.rule : null,
      busy: busyThen,
      visibility: timedThen ? raw.visibility : 'default',
      doNotDisturb: timedThen && eligible !== false && raw.doNotDisturb,
      decline: busyThen && eligible !== false ? raw.decline : null,
    };
  };
  /** The form takes these fields' values (a conflict settled with theirs). */
  const take = (values: FormValues, fields: readonly FormField[]) => {
    const setters: { [K in FormField]: () => void } = {
      title: () => setTitle(values.title),
      notes: () => setNotes(values.notes),
      due: () => setDue(values.due),
      time: () => {
        setTime(values.time);
        setDuration(values.duration);
      },
      deadline: () => setDeadline(values.deadline),
      rule: () => setRule(values.rule),
      busy: () => setBusy(values.busy),
      visibility: () => setVisibility(values.visibility),
      color: () => setColor(values.color),
      attachments: () => setAttachments(values.attachments),
      doNotDisturb: () => setDoNotDisturb(values.doNotDisturb),
      decline: () => setDecline(values.decline),
      starred: () => setStarred(values.starred),
      listId: () => setListId(values.listId),
    };
    for (const field of fields) setters[field]();
  };
  /** A conflict settled: theirs (the form takes what each is now) or mine (saved over it); the save goes on either way. */
  const settle = (choice: 'theirs' | 'mine') => {
    if (!conflict) return;
    const settled = settleConflicts(valuesOf(shownAt), conflict.mine, conflict.now, conflict.fields, choice);
    setShownAt(settled.base);
    if (choice === 'theirs') take(settled.mine, conflict.fields);
    setConflict(null);
    setAgain(true);
  };
  // Saved again once the form has the settled values.
  useEffect(() => {
    if (!again) return;
    setAgain(false);
    save();
  }, [again]);
  const save = (fromEnter = false) => {
    if (saving) return;
    if (!title.trim()) return onCancel();
    setSaving(true);
    setProblem(null);
    setConflict(null);
    setUnchecked(null);
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
    onSave({ title: title.trim(), notes, due, kept: fields, base: valuesOf(shownAt) }, starred, listId || undefined).then(
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
        const message =
          error instanceof TaskConflict || error instanceof FreshnessError ? `"${title.trim()}" was not saved: it ${error.message}` : `Google Tasks did not take it: ${messageOf(error)}`;
        // Closed meanwhile: said where it shows.
        if (!mounted.current) return client.notify(message);
        setSaving(false);
        // Changed elsewhere too since the form opened: the user says which stays.
        if (error instanceof TaskConflict) return setConflict(error);
        // Not known whether it changed elsewhere: never saved on a guess; the edit stays, to try again.
        if (error instanceof FreshnessError) return setUnchecked(error);
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
      {conflict && <ConflictBanner lines={taskConflictLines(conflict, { zone, today: view.today, lists: gv.lists })} onTheirs={() => settle('theirs')} onMine={() => settle('mine')} />}
      {unchecked && (
        <RetryBanner
          text={`Couldn't check for changes made elsewhere: ${unchecked.what} couldn't be read${unchecked.reason ? ` (${unchecked.reason})` : ''}. Nothing was saved; your edit is still here.`}
          onRetry={() => save()}
        />
      )}
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
