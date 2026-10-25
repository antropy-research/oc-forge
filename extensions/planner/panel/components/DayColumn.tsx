import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { plannedTotal, tasksForDay, workloadTotal } from '../../src/domain/selectors.ts';
import { reorderCommands, sortTasks, type SortKey } from '../../src/domain/sort.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { matchesFilter, useUi } from '../lib/ui.ts';
import { AddTask } from './AddTask.tsx';
import { TaskList } from './TaskList.tsx';

export const dayLabel = (date: DateKey, today: DateKey): string => {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  return weekdayName(date);
};

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'priority', label: 'Sort by priority' },
  { key: 'planned', label: 'Sort by planned time' },
  { key: 'completed-last', label: 'Move completed to bottom' },
];

const DayMenu = ({ date, onClose }: { date: DateKey; onClose: () => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div class="menu" ref={ref} role="menu">
      {SORTS.map((sort) => (
        <button
          key={sort.key}
          role="menuitem"
          onClick={() => {
            onClose();
            void client.dispatch(reorderCommands(sortTasks(tasksForDay(view.state, date), sort.key)), { undo: 'List sorted' });
          }}
        >
          {sort.label}
        </button>
      ))}
    </div>
  );
};

/** One day's list: header with planned time against the workload threshold, Add task, tasks. */
export const DayColumn = ({ date, wide = false }: { date: DateKey; wide?: boolean }) => {
  const view = useView();
  const { ui } = useUi();
  const [menuOpen, setMenuOpen] = useState(false);
  const tasks = tasksForDay(view.state, date).filter((task) => matchesFilter(task, ui.channelFilter, view.state.channels));
  const planned = plannedTotal(tasks);
  const workload = workloadTotal(view.state, tasks);
  const threshold = view.state.settings.workloadMinutes;
  const over = workload > threshold;
  const done = tasks.filter((task) => task.completedAt).length;
  const classes = ['day-column', wide ? 'is-wide' : '', date === view.today ? 'is-today' : '', date < view.today ? 'is-past' : ''].filter(Boolean).join(' ');
  return (
    <section class={classes} aria-label={`${dayLabel(date, view.today)}, ${monthDay(date)}`}>
      <header class="day-header">
        <div>
          <div class="day-name">{dayLabel(date, view.today)}</div>
          <div class="day-date">{weekdayName(date)}, {monthDay(date)}</div>
        </div>
        <div class="day-tools">
          {tasks.length > 0 && (
            <div class={`day-load${over ? ' is-over' : ''}`} title={over ? `Over your ${formatMinutes(threshold)} workload threshold` : `Planned work: ${formatMinutes(workload)} of ${formatMinutes(threshold)}`}>
              <span class="load-time">{formatMinutes(planned)}</span>
              <span class="load-count">{done}/{tasks.length}</span>
            </div>
          )}
          {tasks.length > 1 && (
            <div class="menu-anchor">
              <button class="more is-visible" aria-label={`${dayLabel(date, view.today)} actions`} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>⋯</button>
              {menuOpen && <DayMenu date={date} onClose={() => setMenuOpen(false)} />}
            </div>
          )}
        </div>
      </header>
      {tasks.length > 0 && (
        <div class="load-bar" aria-hidden="true">
          <div class={`load-fill${over ? ' is-over' : ''}`} style={{ width: `${Math.min(100, (workload / threshold) * 100)}%` }} />
        </div>
      )}
      <AddTask placement={{ kind: 'day', date }} />
      <TaskList placement={{ kind: 'day', date }} tasks={tasks} />
    </section>
  );
};
