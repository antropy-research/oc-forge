import { useEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { addDays, formatMinutes, nextWeekday } from '../../src/domain/dates.ts';
import { parseDuration } from '../../src/domain/quickAdd.ts';
import { DRAG_TYPE, usePlanner, useView } from '../lib/context.ts';
import { moveTo } from '../lib/commands.ts';

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
  const run = (body: Parameters<typeof client.dispatch>[0]) => {
    onClose();
    void client.dispatch(body);
  };
  const onDay = task.placement.kind === 'day' ? task.placement.date : null;
  return (
    <div class="menu" ref={ref} role="menu">
      {onDay !== today && <button role="menuitem" onClick={() => run([moveTo(state, task.id, { kind: 'day', date: today })])}>Move to today</button>}
      <button role="menuitem" onClick={() => run([moveTo(state, task.id, { kind: 'day', date: addDays(onDay && onDay >= today ? onDay : today, 1) }, 'top')])}>
        {onDay && onDay > today ? 'Move to next day' : 'Move to tomorrow'}
      </button>
      <button role="menuitem" onClick={() => run([moveTo(state, task.id, { kind: 'day', date: nextWeekday(today, state.settings.weekStartsOn) })])}>Move to next week</button>
      {task.placement.kind !== 'backlog' && <button role="menuitem" onClick={() => run([moveTo(state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')])}>Move to backlog</button>}
      <hr />
      <button role="menuitem" class="danger" onClick={() => run([{ type: 'task.deleted', taskId: task.id }])}>Delete</button>
    </div>
  );
};

export const TaskCard = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const [editing, setEditing] = useState<'title' | 'time' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const channel = task.channelId ? view.state.channels[task.channelId] : null;
  const done = Boolean(task.completedAt);

  const toggle = () =>
    void client.dispatch([done ? { type: 'task.reopened', taskId: task.id } : { type: 'task.completed', taskId: task.id, on: view.today }]);

  return (
    <li
      data-task={task.id}
      class={`task-card${done ? ' is-done' : ''}${menuOpen ? ' has-menu' : ''}`}
      draggable={editing === null}
      onDragStart={(event) => {
        event.dataTransfer?.setData(DRAG_TYPE, task.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button class="check" aria-label={done ? 'Mark incomplete' : 'Mark complete'} aria-pressed={done} onClick={toggle}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" /></svg>
      </button>
      <div class="task-body">
        {editing === 'title' ? (
          <InlineInput
            value={task.title}
            onCommit={(value) => {
              setEditing(null);
              const title = value.trim();
              if (title && title !== task.title) void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { title } }]);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div class="task-title" title="Double-click to rename" onDblClick={() => setEditing('title')}>{task.title}</div>
        )}
        {(channel || task.rolloverCount > 0 || task.priority) && (
          <div class="task-meta">
            {channel && <span class="channel"><span class="hash" style={{ color: channel.color }}>#</span>{channel.name}</span>}
            {task.priority && <span class={`priority priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>}
            {task.rolloverCount > 0 && <span class="rollover" title={`Rolled over ${task.rolloverCount} day${task.rolloverCount === 1 ? '' : 's'}`}>↻ {task.rolloverCount}</span>}
          </div>
        )}
      </div>
      {editing === 'time' ? (
        <InlineInput
          className="inline-input time-input"
          value={formatMinutes(task.plannedMinutes)}
          onCommit={(value) => {
            setEditing(null);
            const minutes = value.trim() ? parseDuration(value) : null;
            if (value.trim() && minutes === null) return;
            if (minutes !== task.plannedMinutes) void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { plannedMinutes: minutes } }]);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button class={`planned${task.plannedMinutes ? '' : ' is-empty'}`} title="Planned time" onClick={() => setEditing('time')}>
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
