import { useEffect, useRef, useState } from 'preact/hooks';
import type { EventBody, PlannerEvent, SubtaskConflict, TaskPatch } from '../../src/domain/events.ts';
import { BACKLOG_BUCKETS, type BacklogBucket, type Placement, type Priority, type Subtask, type Task } from '../../src/domain/types.ts';
import { addDays, formatMinutes, isDateKey, monthDay } from '../../src/domain/dates.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { suggestFor } from '../../src/domain/suggest.ts';
import { describe, timeAgo } from '../../src/domain/activity.ts';
import { actualIsFromPlan, actualMinutes, edgePosition, entriesFor, liveChannels, positionAt, tasksIn } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { EVENT_SUBTASKS_HINT, isEventTask } from '../../src/domain/merge.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { objectivesForWeek, weekStartOf } from '../../src/domain/rituals.ts';
import { useUi } from '../lib/ui.ts';
import { formatClock, useNow } from '../lib/time.ts';
import { TimerButton } from './TimerButton.tsx';
import { RepeatSection } from './RepeatSection.tsx';
import { MergedSection } from './MergedSection.tsx';
import { LinearTaskSection } from './LinearPanel.tsx';
import { AgentSection } from './Agents.tsx';
import { GitHubTaskSection } from './GitHubPanel.tsx';
import { GoogleTaskSection } from './GooglePanel.tsx';
import { LinkTaskSection } from './LinkSection.tsx';
import { ConflictBanner, RetryBanner, notCheckedText, quoted, useDraft } from './Conflicts.tsx';

const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

const startValue = (placement: Placement): string => (placement.kind === 'day' ? `day:${placement.date}` : `bucket:${placement.bucket}`);

const StartPicker = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const [picking, setPicking] = useState(false);
  const current = startValue(task.placement);
  const move = (placement: Placement) => void client.dispatch([{ type: 'task.moved', taskId: task.id, placement, position: edgePosition(view.state, placement, 'bottom') }], { undo: 'Task moved' });
  const today = view.today;
  const tomorrow = addDays(today, 1);
  const options: { value: string; label: string }[] = [
    { value: `day:${today}`, label: 'Today' },
    { value: `day:${tomorrow}`, label: 'Tomorrow' },
  ];
  if (task.placement.kind === 'day' && task.placement.date !== today && task.placement.date !== tomorrow) options.push({ value: current, label: monthDay(task.placement.date) });
  return (
    <span class="start-picker">
      <select
        value={current}
        aria-label="Start"
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === 'pick') return setPicking(true);
          setPicking(false);
          if (value === current) return;
          if (value.startsWith('day:')) move({ kind: 'day', date: value.slice(4) });
          else move({ kind: 'backlog', bucket: value.slice(7) as BacklogBucket });
        }}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        <option value="pick">Pick a date…</option>
        <optgroup label="Backlog">
          {BACKLOG_BUCKETS.map((bucket) => <option key={bucket.id} value={`bucket:${bucket.id}`}>{bucket.label}</option>)}
        </optgroup>
      </select>
      {picking && (
        <input
          type="date"
          aria-label="Start date"
          onChange={(event) => {
            const date = event.currentTarget.value;
            if (isDateKey(date)) {
              setPicking(false);
              move({ kind: 'day', date });
            }
          }}
        />
      )}
    </span>
  );
};

/** A subtask change the service found changed elsewhere since, as the section asks it: what, and Save mine. */
interface SubtaskProblem {
  /** The subtask it is about: a newer question about it replaces this one. */
  id: string;
  line: string;
  mine: () => void;
}

/**
 * A task's subtasks changed one at a time, by identity (`subtask.*`): the
 * service applies each to the plan as it has it then, so a subtask added,
 * ticked or renamed in another window meanwhile stays. A tick or a rename
 * says what it saw, a delete the title it saw: a subtask renamed or deleted
 * elsewhere since is asked as an edit's conflict is (`problems`: Keep theirs,
 * or Save mine), nothing of it written. Each resolves to that conflict, or
 * null.
 */
const useSubtaskCommands = (task: Task) => {
  const { client } = usePlanner();
  const view = useView();
  const [problems, setProblems] = useState<SubtaskProblem[]>([]);
  const ask = (id: string, line: string, mine: () => void) => setProblems((list) => [...list.filter((item) => item.id !== id), { id, line, mine }]);
  const settle = (id: string) => setProblems((list) => list.filter((item) => item.id !== id));
  const send = (bodies: EventBody[], undo?: string) =>
    new Promise<SubtaskConflict | null>((resolve) => {
      let found: SubtaskConflict | null = null;
      void client.dispatch(bodies, { ...(undo ? { undo } : {}), onConflict: (conflict) => (found = conflict) }).then(() => resolve(found));
    });
  /** Where a subtask is in this window's list: after the one before it (null: first). */
  const placeOf = (subtask: Subtask) => {
    const index = task.subtasks.findIndex((item) => item.id === subtask.id);
    return index > 0 ? task.subtasks[index - 1]!.id : index === 0 ? null : undefined;
  };
  /** Deleted elsewhere since: Save mine puts it back where it was, with this change. */
  const deleted = (subtask: Subtask, yours: string, mine: Subtask, after: string | null | undefined) =>
    ask(subtask.id, `${quoted(subtask.title)} was deleted elsewhere (yours: ${yours})`, () => void send([{ type: 'subtask.added', taskId: task.id, subtask: mine, after }]));
  const tick = async (subtask: Subtask) => {
    const done = !subtask.done;
    const after = placeOf(subtask);
    const conflict = await send([{ type: 'subtask.updated', taskId: task.id, subtaskId: subtask.id, patch: { done }, seen: { done: subtask.done } }]);
    if (conflict && !conflict.now) deleted(subtask, done ? 'checked off' : 'unchecked', { ...subtask, done }, after);
  };
  const rename = async (subtask: Subtask, title: string, seen: string) => {
    const after = placeOf(subtask);
    const conflict = await send([{ type: 'subtask.updated', taskId: task.id, subtaskId: subtask.id, patch: { title }, seen: { title: seen } }]);
    if (conflict && !conflict.now) deleted({ ...subtask, title: seen }, `renamed ${quoted(title)}`, { ...subtask, title }, after);
    return conflict;
  };
  const remove = async (subtask: Subtask, seen = subtask.title) => {
    const conflict = await send([{ type: 'subtask.deleted', taskId: task.id, subtaskId: subtask.id, seen: { title: seen } }]);
    const now = conflict?.now;
    if (now) ask(subtask.id, `${quoted(seen)} was renamed ${quoted(now.title)} elsewhere (yours: deleted)`, () => void remove(subtask, now.title));
  };
  /** ↗ Turn into a task: a task right after this one, the subtask gone, in one step Undo takes back. */
  const toTask = async (subtask: Subtask) => {
    const list = tasksIn(view.state, task.placement);
    const position = positionAt(view.state, task.placement, list.findIndex((item) => item.id === task.id) + 1);
    const conflict = await send(
      [
        { type: 'task.created', task: { id: newId(), title: subtask.title, placement: task.placement, position, channelId: task.channelId, folderId: task.folderId, objectiveId: task.objectiveId } },
        { type: 'subtask.deleted', taskId: task.id, subtaskId: subtask.id, seen: { title: subtask.title } },
      ],
      'Subtask became a task',
    );
    const now = conflict?.now;
    if (now) ask(subtask.id, `${quoted(subtask.title)} was renamed ${quoted(now.title)} elsewhere (yours: turned into a task)`, () => void toTask(now));
  };
  const add = (title: string) => send([{ type: 'subtask.added', taskId: task.id, subtask: { id: newId(), title, done: false } }]);
  return { problems, settle, add, tick, rename, remove, toTask };
};

/**
 * A subtask's title, edited in place over the title as it is (`useDraft`): renamed meanwhile too is asked, here; deleted
 * meanwhile, the section asks (`useSubtaskCommands`).
 */
const SubtaskTitle = ({ task, subtask, rename }: { task: Task; subtask: Subtask; rename: (subtask: Subtask, title: string, seen: string) => Promise<SubtaskConflict | null> }) => {
  const { client } = usePlanner();
  const title = useDraft(
    subtask.title,
    async (value, seen) => {
      const conflict = await rename(subtask, value, seen);
      return conflict?.now ? { theirs: conflict.now.title } : null;
    },
    async () => (await client.refresh()).tasks[task.id]?.subtasks.find((item) => item.id === subtask.id)?.title ?? subtask.title,
  );
  return (
    <>
      <input
        class="subtask-title"
        value={title.shown}
        aria-label="Subtask"
        onFocus={title.begin}
        onInput={(event) => title.change(event.currentTarget.value)}
        onBlur={(event) => {
          const value = event.currentTarget.value.trim();
          if (value) void title.end(value);
          else title.cancel();
        }}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
      {title.conflict && (
        <ConflictBanner lines={[`This subtask was renamed ${quoted(title.conflict.theirs)} elsewhere (yours: ${quoted(title.conflict.mine)})`]} onTheirs={title.theirs} onMine={title.mine} />
      )}
      {title.failed && <RetryBanner text={notCheckedText(title.failed)} onRetry={title.retry} />}
    </>
  );
};

export const Subtasks = ({ task }: { task: Task }) => {
  const [draft, setDraft] = useState('');
  const commands = useSubtaskCommands(task);
  // A calendar event task has no subtasks at all, as in Sunsama (merging is how they are made, and events don't merge):
  // no Add subtask, Sunsama's advice instead. Any it had before stay, to tick, rename, convert or delete.
  const event = isEventTask(task);
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    void commands.add(title);
    setDraft('');
  };
  const done = task.subtasks.filter((subtask) => subtask.done).length;
  return (
    <section class="detail-section" aria-label="Subtasks">
      <h3>Subtasks {task.subtasks.length > 0 && <span class="count">{done}/{task.subtasks.length}</span>}</h3>
      <ul class="subtasks">
        {task.subtasks.map((subtask) => (
          <li key={subtask.id} class={subtask.done ? 'is-done' : ''}>
            <input type="checkbox" checked={subtask.done} aria-label={`Complete ${subtask.title}`} onChange={() => void commands.tick(subtask)} />
            <SubtaskTitle task={task} subtask={subtask} rename={commands.rename} />
            <button class="link" aria-label={`Turn ${subtask.title} into a task`} title="Turn into a task" onClick={() => void commands.toTask(subtask)}>
              ↗
            </button>
            <button class="link danger" aria-label={`Delete ${subtask.title}`} onClick={() => void commands.remove(subtask)}>×</button>
          </li>
        ))}
      </ul>
      {commands.problems.map((problem) => (
        <ConflictBanner
          key={problem.id}
          lines={[problem.line]}
          onTheirs={() => commands.settle(problem.id)}
          onMine={() => {
            commands.settle(problem.id);
            problem.mine();
          }}
        />
      ))}
      {event ? (
        <p class="hint subtasks-event">{EVENT_SUBTASKS_HINT}</p>
      ) : (
        <input class="subtask-add" value={draft} placeholder="Add subtask" aria-label="Add subtask" onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
      )}
    </section>
  );
};

/**
 * A task's notes, edited in place over the notes as they are (`useDraft`):
 * left as they were, nothing is written (notes changed in another window
 * meanwhile show); changed there too meanwhile, it is asked.
 */
export const NotesField = ({ task, className }: { task: Task; className: string }) => {
  const { client } = usePlanner();
  const notes = useDraft(task.notes, (value) => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { notes: value } }]), async () => (await client.refresh()).tasks[task.id]?.notes ?? task.notes);
  return (
    <>
      <textarea
        class={className}
        placeholder="Notes…"
        aria-label="Notes"
        value={notes.shown}
        onFocus={notes.begin}
        onInput={(event) => notes.change(event.currentTarget.value)}
        onBlur={(event) => void notes.end(event.currentTarget.value)}
      />
      {notes.conflict && (
        <ConflictBanner
          lines={[`Notes were changed elsewhere to ${notes.conflict.theirs.trim() ? quoted(notes.conflict.theirs) : 'none'} (yours: ${notes.conflict.mine.trim() ? quoted(notes.conflict.mine) : 'none'})`]}
          onTheirs={notes.theirs}
          onMine={notes.mine}
        />
      )}
      {notes.failed && <RetryBanner text={notCheckedText(notes.failed)} onRetry={notes.retry} />}
    </>
  );
};

/** Planned time as typed: none when empty, null when it does not read as one. */
const minutesOf = (text: string): number | null => (text.trim() ? parseDuration(text.trim()) : null);

const ActualTime = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const [draft, setDraft] = useState('');
  const running = view.state.timer?.taskId === task.id;
  const now = useNow(running);
  const entries = entriesFor(view.state, task.id);
  const actual = actualMinutes(view.state, task, now);
  const add = () => {
    const minutes = parseDuration(draft);
    if (!minutes) return;
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60_000);
    void client.dispatch([{ type: 'time.logged', entry: { id: newId(), taskId: task.id, start: start.toISOString(), end: end.toISOString() } }]);
    setDraft('');
  };
  return (
    <section class="detail-section" aria-label="Actual time">
      <h3>
        Actual {running ? formatClock(actual) : formatMinutes(actual) || '0:00'}
        {actualIsFromPlan(view.state, task) && <span class="count" title="Completed without tracked time; planned time counts as actual">from plan</span>}
        <TimerButton task={task} />
      </h3>
      {entries.length > 0 && (
        <ul class="entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>{new Date(entry.start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span class="muted">{entry.source === 'timer' ? 'timer' : 'manual'}</span>
              <span>{formatMinutes((Date.parse(entry.end) - Date.parse(entry.start)) / 60_000)}</span>
              <button class="link danger" aria-label="Delete time entry" onClick={() => void client.dispatch([{ type: 'time.deleted', entryId: entry.id }])}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div class="row">
        <input class="subtask-add" value={draft} placeholder="Add time, e.g. 0:25" aria-label="Add actual time" onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
      </div>
    </section>
  );
};

const Activity = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const [events, setEvents] = useState<PlannerEvent[] | null>(null);
  useEffect(() => {
    let live = true;
    client.activity(task.id).then((list) => live && setEvents(list)).catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [client, task.id, task.updatedAt]);
  if (!events || events.length === 0) return null;
  return (
    <section class="detail-section activity" aria-label="Activity">
      <ol>
        {events.slice().reverse().map((event) => (
          <li key={event.id}>
            {describe(event, task.id, view.state)} · <span title={new Date(event.at).toLocaleString()}>{timeAgo(event.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
};

export const TaskDetail = ({ taskId }: { taskId: string }) => {
  const { client, agents } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const dialog = useRef<HTMLDivElement>(null);
  const task = view.state.tasks[taskId];
  const close = () => setUi({ openTaskId: null });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The title and planned time, edited in place over the task as it is: changed elsewhere meanwhile too is asked.
  const fresh = async () => (await client.refresh()).tasks[taskId];
  const title = useDraft(task?.title ?? '', (value) => update({ title: value }), async () => (await fresh())?.title ?? task?.title ?? '');
  const planned = useDraft(
    formatMinutes(task?.plannedMinutes ?? null),
    (value) => update({ plannedMinutes: minutesOf(value) }),
    async () => formatMinutes((await fresh())?.plannedMinutes ?? null),
    (a, b) => minutesOf(a) === minutesOf(b),
  );
  if (!task) return null;
  const update = (patch: TaskPatch) => void client.dispatch([{ type: 'task.updated', taskId, patch }]);
  const act = (body: EventBody, label: string) => {
    close();
    void client.dispatch([body], { undo: label });
  };
  const done = Boolean(task.completedAt);
  const channels = liveChannels(view.state);

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Task details" tabIndex={-1} ref={dialog}>
        <header class="detail-bar">
          <div class="detail-fields">
          <label class="field">
            <span>Channel</span>
            <select value={task.channelId ?? ''} onChange={(event) => update({ channelId: event.currentTarget.value || null })}>
              <option value="">No channel</option>
              {channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </select>
          </label>
          <label class="field">
            <span>Priority</span>
            <select value={task.priority ?? ''} onChange={(event) => update({ priority: (event.currentTarget.value || null) as Priority | null })}>
              <option value="">No priority</option>
              {PRIORITIES.map((priority) => <option key={priority.id} value={priority.id}>{priority.label}</option>)}
            </select>
          </label>
          <label class="field">
            <span>Start</span>
            <StartPicker task={task} />
          </label>
          <label class="field">
            <span>Objective</span>
            <select value={task.objectiveId ?? ''} onChange={(event) => update({ objectiveId: event.currentTarget.value || null })}>
              <option value="">None</option>
              {(() => {
                const week = weekStartOf(view.state, task.placement.kind === 'day' ? task.placement.date : view.today);
                const list = objectivesForWeek(view.state, week);
                const current = task.objectiveId ? view.state.objectives[task.objectiveId] : null;
                if (current && !list.includes(current)) list.unshift(current);
                return list.map((objective) => <option key={objective.id} value={objective.id}>◎ {objective.title}</option>);
              })()}
            </select>
          </label>
          {Object.values(view.state.folders).some((folder) => !folder.deletedAt) && (
            <label class="field">
              <span>Folder</span>
              <select value={task.folderId ?? ''} onChange={(event) => update({ folderId: event.currentTarget.value || null })}>
                <option value="">No folder</option>
                {Object.values(view.state.folders).filter((folder) => !folder.deletedAt || folder.id === task.folderId).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
          )}
          <label class="field">
            <span>Due</span>
            <input type="date" value={task.dueDate ?? ''} onChange={(event) => update({ dueDate: isDateKey(event.currentTarget.value) ? event.currentTarget.value : null })} />
          </label>
          </div>
          <div class="detail-actions">
          {!task.archivedAt && <button class="link" onClick={() => act({ type: 'task.archived', taskId }, 'Task archived')}>Archive</button>}
          <button class="link danger" onClick={() => act({ type: 'task.deleted', taskId }, 'Task deleted')}>Delete</button>
          <button class="close" aria-label="Close" onClick={close}>×</button>
          </div>
        </header>

        <div class="detail-title-row">
          <button
            class="check"
            aria-label={done ? 'Mark incomplete' : 'Mark complete'}
            aria-pressed={done}
            onClick={() => void client.dispatch([done ? { type: 'task.reopened', taskId } : { type: 'task.completed', taskId, on: view.today }])}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" /></svg>
          </button>
          <textarea
            class="detail-title"
            rows={1}
            aria-label="Title"
            value={title.shown}
            onFocus={title.begin}
            onInput={(event) => title.change(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              const value = event.currentTarget.value.replace(/\s+/g, ' ').trim();
              if (value) void title.end(value);
              else title.cancel();
            }}
          />
          <label class="detail-planned">
            <span>Planned</span>
            <input
              value={planned.shown}
              placeholder="0:00"
              aria-label="Planned time"
              onFocus={planned.begin}
              onInput={(event) => planned.change(event.currentTarget.value)}
              onBlur={(event) => {
                const raw = event.currentTarget.value;
                // Not a time: left as typed, to correct.
                if (raw.trim() && minutesOf(raw) === null) return;
                void planned.end(raw);
              }}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            {!task.plannedMinutes && view.state.settings.suggestFromHistory && (() => {
              const suggestion = suggestFor(view.state, task.title, task.id);
              return suggestion?.minutes ? (
                <button class="link suggest" title={`From ${suggestion.basis} similar task${suggestion.basis === 1 ? '' : 's'}`} onClick={() => update({ plannedMinutes: suggestion.minutes })}>
                  Use {formatMinutes(suggestion.minutes)}
                </button>
              ) : null;
            })()}
          </label>
        </div>
        {title.conflict && <ConflictBanner lines={[`Title was changed to ${quoted(title.conflict.theirs)} elsewhere (yours: ${quoted(title.conflict.mine)})`]} onTheirs={title.theirs} onMine={title.mine} />}
        {planned.conflict && (
          <ConflictBanner lines={[`Planned time was changed to ${planned.conflict.theirs || 'none'} elsewhere (yours: ${planned.conflict.mine.trim() || 'none'})`]} onTheirs={planned.theirs} onMine={planned.mine} />
        )}
        {title.failed && <RetryBanner text={notCheckedText(title.failed)} onRetry={title.retry} />}
        {planned.failed && <RetryBanner text={notCheckedText(planned.failed)} onRetry={planned.retry} />}

        <NotesField task={task} className="detail-notes" key={`notes-${task.id}`} />
        <Subtasks task={task} key={`subtasks-${task.id}`} />
        {task.sessionRef && (
          <section class="detail-section" aria-label="From chat">
            <h3>From chat <span class="count">{task.sessionRef.title}</span></h3>
            <button class="link" onClick={() => void agents.openSession(task.sessionRef!.sessionId).catch((error) => client.notify(`Could not open the chat: ${error instanceof Error ? error.message : String(error)}`))}>Open the chat</button>
          </section>
        )}
        <AgentSection task={task} />
        <LinearTaskSection task={task} />
        <GitHubTaskSection task={task} />
        <GoogleTaskSection task={task} />
        <LinkTaskSection task={task} />
        <MergedSection task={task} />
        <RepeatSection task={task} />
        <ActualTime task={task} />
        <Activity task={task} />
      </div>
    </div>
  );
};
