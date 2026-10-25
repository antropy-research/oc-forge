import { useEffect, useRef, useState } from 'preact/hooks';
import type { EventBody, PlannerEvent, TaskPatch } from '../../src/domain/events.ts';
import { BACKLOG_BUCKETS, type BacklogBucket, type Placement, type Priority, type Subtask, type Task } from '../../src/domain/types.ts';
import { addDays, formatMinutes, isDateKey, monthDay } from '../../src/domain/dates.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { describe, timeAgo } from '../../src/domain/activity.ts';
import { actualIsFromPlan, actualMinutes, edgePosition, entriesFor, liveChannels } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { objectivesForWeek, weekStartOf } from '../../src/domain/rituals.ts';
import { useUi } from '../lib/ui.ts';
import { formatClock, useNow } from '../lib/time.ts';
import { TimerButton } from './TimerButton.tsx';
import { RepeatSection } from './RepeatSection.tsx';
import { LinearTaskSection } from './LinearPanel.tsx';
import { AgentSection } from './Agents.tsx';

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

export const Subtasks = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const [draft, setDraft] = useState('');
  const save = (subtasks: Subtask[]) => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { subtasks } }]);
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    save([...task.subtasks, { id: newId(), title, done: false }]);
    setDraft('');
  };
  const done = task.subtasks.filter((subtask) => subtask.done).length;
  return (
    <section class="detail-section" aria-label="Subtasks">
      <h3>Subtasks {task.subtasks.length > 0 && <span class="count">{done}/{task.subtasks.length}</span>}</h3>
      <ul class="subtasks">
        {task.subtasks.map((subtask) => (
          <li key={subtask.id} class={subtask.done ? 'is-done' : ''}>
            <input
              type="checkbox"
              checked={subtask.done}
              aria-label={`Complete ${subtask.title}`}
              onChange={() => save(task.subtasks.map((item) => (item.id === subtask.id ? { ...item, done: !item.done } : item)))}
            />
            <input
              class="subtask-title"
              defaultValue={subtask.title}
              aria-label="Subtask"
              onBlur={(event) => {
                const title = event.currentTarget.value.trim();
                if (title && title !== subtask.title) save(task.subtasks.map((item) => (item.id === subtask.id ? { ...item, title } : item)));
              }}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <button class="link danger" aria-label={`Delete ${subtask.title}`} onClick={() => save(task.subtasks.filter((item) => item.id !== subtask.id))}>×</button>
          </li>
        ))}
      </ul>
      <input class="subtask-add" value={draft} placeholder="Add subtask" aria-label="Add subtask" onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
    </section>
  );
};

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
            defaultValue={task.title}
            key={`title-${task.title}`}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              const title = event.currentTarget.value.replace(/\s+/g, ' ').trim();
              if (title && title !== task.title) update({ title });
            }}
          />
          <label class="detail-planned">
            <span>Planned</span>
            <input
              key={`planned-${task.plannedMinutes}`}
              defaultValue={formatMinutes(task.plannedMinutes)}
              placeholder="0:00"
              aria-label="Planned time"
              onBlur={(event) => {
                const raw = event.currentTarget.value.trim();
                const minutes = raw ? parseDuration(raw) : null;
                if (raw && minutes === null) return;
                if (minutes !== task.plannedMinutes) update({ plannedMinutes: minutes });
              }}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
          </label>
        </div>

        <textarea
          class="detail-notes"
          placeholder="Notes…"
          aria-label="Notes"
          key={`notes-${task.id}`}
          defaultValue={task.notes}
          onBlur={(event) => {
            if (event.currentTarget.value !== task.notes) update({ notes: event.currentTarget.value });
          }}
        />
        <Subtasks task={task} />
        {task.sessionRef && (
          <section class="detail-section" aria-label="From chat">
            <h3>From chat <span class="count">{task.sessionRef.title}</span></h3>
            <button class="link" onClick={() => void agents.openSession(task.sessionRef!.sessionId).catch((error) => client.notify(`Could not open the chat: ${error instanceof Error ? error.message : String(error)}`))}>Open the chat</button>
          </section>
        )}
        <AgentSection task={task} />
        <LinearTaskSection task={task} />
        <RepeatSection task={task} />
        <ActualTime task={task} />
        <Activity task={task} />
      </div>
    </div>
  );
};
