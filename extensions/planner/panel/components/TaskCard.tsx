import { useEffect, useRef, useState } from 'preact/hooks';
import type { EventBody } from '../../src/domain/events.ts';
import type { Task } from '../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, nextWeekday } from '../../src/domain/dates.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { moveTo } from '../lib/commands.ts';
import { useUi } from '../lib/ui.ts';

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

const TaskMenu = ({ task, onClose }: { task: Task; onClose: () => void }) => {
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
      <hr />
      <button role="menuitem" onClick={() => run({ type: 'task.archived', taskId: task.id }, 'Task archived')}>Archive</button>
      <button role="menuitem" class="danger" onClick={() => run({ type: 'task.deleted', taskId: task.id }, 'Task deleted')}>Delete</button>
    </div>
  );
};

export const TaskCard = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const [editingTime, setEditingTime] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const channel = task.channelId ? view.state.channels[task.channelId] : null;
  const done = Boolean(task.completedAt);
  const subtasksDone = task.subtasks.filter((subtask) => subtask.done).length;
  const due = task.dueDate;
  const dueClass = due && !done ? (due < view.today ? ' is-overdue' : due === view.today ? ' is-due-today' : '') : '';
  const hasMeta = channel || task.rolloverCount > 0 || task.priority || due || task.subtasks.length > 0 || task.notes;

  const toggle = () =>
    void client.dispatch([done ? { type: 'task.reopened', taskId: task.id } : { type: 'task.completed', taskId: task.id, on: view.today }]);

  return (
    <li
      data-task={task.id}
      class={`task-card${done ? ' is-done' : ''}${menuOpen ? ' has-menu' : ''}`}
      draggable={!editingTime}
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
        {hasMeta && (
          <span class="task-meta">
            {channel && <span class="channel"><span class="hash" style={{ color: channel.color }}>#</span>{channel.name}</span>}
            {task.priority && <span class={`priority priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>}
            {due && <span class={`due${dueClass}`}>Due {due === view.today ? 'today' : monthDay(due)}</span>}
            {task.subtasks.length > 0 && <span class="subtask-count" title="Subtasks">☑ {subtasksDone}/{task.subtasks.length}</span>}
            {task.notes && <span class="has-notes" title="Has notes">≡</span>}
            {task.rolloverCount > 0 && <span class="rollover" title={`Rolled over ${task.rolloverCount} day${task.rolloverCount === 1 ? '' : 's'}`}>↻ {task.rolloverCount}</span>}
          </span>
        )}
      </button>
      {editingTime ? (
        <InlineInput
          className="inline-input time-input"
          value={formatMinutes(task.plannedMinutes)}
          onCommit={(value) => {
            setEditingTime(false);
            const minutes = value.trim() ? parseDuration(value) : null;
            if (value.trim() && minutes === null) return;
            if (minutes !== task.plannedMinutes) void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { plannedMinutes: minutes } }]);
          }}
          onCancel={() => setEditingTime(false)}
        />
      ) : (
        <button class={`planned${task.plannedMinutes ? '' : ' is-empty'}`} title="Planned time" aria-label="Planned time" onClick={() => setEditingTime(true)}>
          {task.plannedMinutes ? formatMinutes(task.plannedMinutes) : '–:––'}
        </button>
      )}
      <div class="menu-anchor">
        <button class="more" aria-label="Task actions" aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>⋯</button>
        {menuOpen && <TaskMenu task={task} onClose={() => setMenuOpen(false)} />}
      </div>
    </li>
  );
};
