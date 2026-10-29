import { useEffect, useRef, useState } from 'preact/hooks';
import type { EventBody } from '../../src/domain/events.ts';
import { SOURCE_NAMES, type Task } from '../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, nextWeekday } from '../../src/domain/dates.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { moveTo } from '../lib/commands.ts';
import { actualMinutes, blocksFor, positionAt, tasksIn } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { clockLabel, zonedDateMinutes } from '../../src/domain/dates.ts';
import { autoTimebox } from '../lib/autoSchedule.ts';
import { setHoveredTask } from '../lib/hover.ts';
import { isClosedType } from '../../src/domain/linear.ts';
import { shortKey } from '../../src/domain/github.ts';
import { KEPT_HINT, keptFor, keptTimeLabel } from '../../src/domain/gtaskKept.ts';
import { AgentChip } from './Agents.tsx';
import { AssignPopover } from './AssigneePicker.tsx';
import type { PlaylistEntry } from '../../src/domain/schedule.ts';
import { formatClock, useNow } from '../lib/time.ts';
import { TimerButton } from './TimerButton.tsx';
import { useUi } from '../lib/ui.ts';
import { ConflictBanner, useDraft } from './Conflicts.tsx';

const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' } as const;

interface InlineInputProps {
  value: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export const InlineInput = ({ value, className, onCommit, onCancel }: InlineInputProps) => {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(ref.current?.value ?? value);
  };
  return (
    <input
      ref={ref}
      class={className ?? 'inline-input'}
      defaultValue={value}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
};

const TaskMenu = ({ task, onClose, onAssign }: { task: Task; onClose: () => void; onAssign: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  const { state, today } = view;
  const run = (body: EventBody, label: string) => {
    onClose();
    void client.dispatch([body], { undo: label });
  };
  const onDay = task.placement.kind === 'day' ? task.placement.date : null;
  return (
    <div class="menu" ref={ref} role="menu">
      {onDay !== today && <button role="menuitem" onClick={() => run(moveTo(state, task.id, { kind: 'day', date: today }), 'Moved to today')}>Move to today</button>}
      <button role="menuitem" onClick={() => run(moveTo(state, task.id, { kind: 'day', date: addDays(onDay && onDay >= today ? onDay : today, 1) }, 'top'), 'Task moved')}>
        {onDay && onDay > today ? 'Move to next day' : 'Move to tomorrow'}
      </button>
      <button role="menuitem" onClick={() => run(moveTo(state, task.id, { kind: 'day', date: nextWeekday(today, state.settings.weekStartsOn) }), 'Moved to next week')}>Move to next week</button>
      {task.placement.kind !== 'backlog' && <button role="menuitem" onClick={() => run(moveTo(state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top'), 'Moved to backlog')}>Move to backlog</button>}
      {!task.completedAt && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            void autoTimebox(client, state, today, task, onDay ?? today).then((problem) => problem && client.notify(problem));
          }}
        >
          Timebox automatically
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          const list = tasksIn(state, task.placement);
          const position = positionAt(state, task.placement, list.findIndex((item) => item.id === task.id) + 1);
          run(
            {
              type: 'task.created',
              task: {
                id: newId(), title: task.title, notes: task.notes, plannedMinutes: task.plannedMinutes, priority: task.priority, dueDate: task.dueDate,
                placement: task.placement, position, channelId: task.channelId, folderId: task.folderId, objectiveId: task.objectiveId,
                subtasks: task.subtasks.map((subtask) => ({ ...subtask, id: newId(), done: false })), source: task.source,
              },
            },
            'Task duplicated',
          );
        }}
      >
        Duplicate
      </button>
      {!task.completedAt && (
        <button role="menuitem" aria-haspopup="dialog" onClick={onAssign}>
          Assign to an agent…
        </button>
      )}
      <hr />
      <button role="menuitem" onClick={() => run({ type: 'task.archived', taskId: task.id }, 'Task archived')}>Archive</button>
      <button role="menuitem" class="danger" onClick={() => run({ type: 'task.deleted', taskId: task.id }, 'Task deleted')}>Delete</button>
    </div>
  );
};

export const TaskCard = ({ task, playlist }: { task: Task; playlist?: PlaylistEntry }) => {
  const { client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const [editingTime, setEditingTime] = useState(false);
  // Planned time, edited in place over the task as it is: left as it was writes nothing; changed elsewhere too is asked.
  const minutesOf = (value: string) => (value.trim() ? parseDuration(value) : null);
  const planned = useDraft(
    formatMinutes(task.plannedMinutes),
    (value) => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { plannedMinutes: minutesOf(value) } }]),
    async () => formatMinutes((await client.refresh()).tasks[task.id]?.plannedMinutes ?? null),
    (a, b) => minutesOf(a) === minutesOf(b),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  // "Assign to an agent…" from the menu: the assignee picker, in place.
  const [assigning, setAssigning] = useState(false);
  const channel = task.channelId ? view.state.channels[task.channelId] : null;
  const done = Boolean(task.completedAt);
  const subtasksDone = task.subtasks.filter((subtask) => subtask.done).length;
  const due = task.dueDate;
  const dueClass = due && !done ? (due < view.today ? ' is-overdue' : due === view.today ? ' is-due-today' : '') : '';
  const running = view.state.timer?.taskId === task.id;
  const now = useNow(running);
  const actual = actualMinutes(view.state, task, now);
  const zone = view.state.settings.timezone ?? 'UTC';
  const dayKey = task.placement.kind === 'day' ? task.placement.date : null;
  const timebox = dayKey ? blocksFor(view.state, task.id).find((block) => zonedDateMinutes(block.start, zone).date === dayKey) : undefined;
  const objective = task.objectiveId ? view.state.objectives[task.objectiveId] : null;
  const hasRuns = Object.values(view.state.runs).some((run) => run.taskId === task.id);
  // What the Planner keeps for the Google task this plans: its time, deadline, repeat and star.
  const kept = task.source?.kind === 'gtask' && task.source.account ? keptFor(view.state, { account: task.source.account, id: task.source.id }) : null;
  const hasMeta = channel || task.rolloverCount > 0 || task.priority || due || task.subtasks.length > 0 || task.notes || timebox || objective || task.recurrence || task.source || hasRuns || kept;
  const sourceClosed = isClosedType(task.source?.status?.type);

  const toggle = () =>
    void client.dispatch([done ? { type: 'task.reopened', taskId: task.id } : { type: 'task.completed', taskId: task.id, on: view.today }]);

  return (
    <li
      data-task={task.id}
      class={`task-card${done ? ' is-done' : ''}${menuOpen || assigning ? ' has-menu' : ''}${running ? ' is-running' : ''}${planned.conflict ? ' has-conflict' : ''}`}
      draggable={!editingTime}
      onMouseEnter={() => setHoveredTask(task.id)}
      onMouseLeave={() => setHoveredTask(null)}
      onDragStart={(event) => {
        event.dataTransfer?.setData(DRAG_TYPE, task.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button class="check" aria-label={done ? 'Mark incomplete' : 'Mark complete'} aria-pressed={done} onClick={toggle}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" /></svg>
      </button>
      <button class="task-body" onClick={() => setUi({ openTaskId: task.id })} aria-label={`Open ${task.title}`}>
        <span class="task-title">{task.title}</span>
        {(hasMeta || hasRuns || playlist) && (
          <span class="task-meta">
            {task.source && (
              <span
                class={`source-chip${sourceClosed && !done ? ' is-closed' : ''}`}
                style={{ '--item-color': task.source.status?.color ?? '#5e6ad2' }}
                title={`${task.source.key}${task.source.status ? ` · ${task.source.status.name}` : ''} in ${SOURCE_NAMES[task.source.kind]}`}
              >
                <span class="dot" aria-hidden="true" />
                {task.source.kind === 'github' ? shortKey(task.source.key) : task.source.key}
                {sourceClosed && !done ? ` · ${task.source.status?.name ?? 'Done'} in ${SOURCE_NAMES[task.source.kind]}` : ''}
              </span>
            )}
            {playlist && (
              <span class={`playlist-time${playlist.late ? ' is-late' : ''}`} title={playlist.late ? 'Past your working hours if you go in order' : 'If you work through the list in order'}>
                ▸ {clockLabel(zonedDateMinutes(playlist.start, zone).minutes)}{playlist.end > playlist.start ? `–${clockLabel(zonedDateMinutes(playlist.end, zone).minutes)}` : ''}
              </span>
            )}
            {hasRuns && <AgentChip taskId={task.id} />}
            {timebox && <span class="timebox" style={{ '--item-color': channel?.color ?? 'var(--oc-primary)' }} title="Working session">{clockLabel(zonedDateMinutes(timebox.start, zone).minutes)}</span>}
            {channel && <span class="channel"><span class="hash" style={{ color: channel.color }}>#</span>{channel.name}</span>}
            {task.priority && <span class={`priority priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>}
            {objective && !objective.deletedAt && <span class="objective-badge" title={`Objective: ${objective.title}`}>◎ {objective.title}</span>}
            {due && <span class={`due${dueClass}`}>Due {due === view.today ? 'today' : monthDay(due)}</span>}
            {kept && kept.time !== null && <span class="gtask-kept" title={`Google task at ${keptTimeLabel(kept)} (${KEPT_HINT})`}>◷ {keptTimeLabel(kept)}</span>}
            {kept?.deadline && <span class={`gtask-kept${kept.deadline < view.today && !done ? ' is-overdue' : ''}`} title={`Deadline (${KEPT_HINT})`}>⚑ {monthDay(kept.deadline)}</span>}
            {kept?.repeat && <span class="repeats" title={`Repeats in Google Tasks' way (${KEPT_HINT})`}>⟳</span>}
            {kept?.starredAt && <span class="gtask-kept is-starred" title={`Starred (${KEPT_HINT})`}>★</span>}
            {task.subtasks.length > 0 && <span class="subtask-count" title="Subtasks">☑ {subtasksDone}/{task.subtasks.length}</span>}
            {task.notes && <span class="has-notes" title="Has notes">≡</span>}
            {task.recurrence && <span class="repeats" title="Repeats">⟳</span>}
            {task.rolloverCount > 0 && <span class="rollover" title={`Rolled over ${task.rolloverCount} day${task.rolloverCount === 1 ? '' : 's'}`}>↻ {task.rolloverCount}</span>}
          </span>
        )}
      </button>
      {editingTime ? (
        <InlineInput
          className="inline-input time-input"
          value={planned.shown}
          onCommit={(value) => {
            setEditingTime(false);
            if (value.trim() && minutesOf(value) === null) return planned.cancel();
            void planned.end(value);
          }}
          onCancel={() => {
            setEditingTime(false);
            planned.cancel();
          }}
        />
      ) : (
        <span class="times">
          <TimerButton task={task} />
          {actual > 0 && <span class={`actual${running ? ' is-running' : ''}`} title="Actual time">{running ? formatClock(actual) : formatMinutes(actual)}</span>}
          {actual > 0 && <span class="slash">/</span>}
          <button
            class={`planned${task.plannedMinutes ? '' : ' is-empty'}`}
            title="Planned time"
            aria-label="Planned time"
            onClick={() => {
              planned.begin();
              setEditingTime(true);
            }}
          >
            {task.plannedMinutes ? formatMinutes(task.plannedMinutes) : '–:––'}
          </button>
        </span>
      )}
      <div class="menu-anchor">
        <button class="more" aria-label="Task actions" aria-haspopup="menu" onClick={() => (assigning ? setAssigning(false) : setMenuOpen((open) => !open))}>⋯</button>
        {menuOpen && (
          <TaskMenu
            task={task}
            onClose={() => setMenuOpen(false)}
            onAssign={() => {
              setMenuOpen(false);
              setAssigning(true);
            }}
          />
        )}
        {assigning && <AssignPopover taskId={task.id} onClose={() => setAssigning(false)} />}
      </div>
      {planned.conflict && (
        <ConflictBanner lines={[`Planned time was changed to ${planned.conflict.theirs || 'none'} elsewhere (yours: ${planned.conflict.mine.trim() || 'none'})`]} onTheirs={planned.theirs} onMine={planned.mine} />
      )}
    </li>
  );
};
