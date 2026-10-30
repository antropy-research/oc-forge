import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { formatMinutes, monthDay } from '../../src/domain/dates.ts';
import { parseQuickAdd } from '../../src/domain/quickAdd.ts';
import { reorderCommands, sortTasks } from '../../src/domain/sort.ts';
import { tasksForDay } from '../../src/domain/selectors.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { addParsedTask, urlHint } from '../lib/addTask.ts';
import { useUi } from '../lib/ui.ts';
import type { Route } from './Shell.tsx';

interface Item {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

const where = (task: Task): string => {
  if (task.deletedAt) return 'in trash';
  if (task.archivedAt) return 'archived';
  if (task.completedAt) return 'done';
  return task.placement.kind === 'day' ? monthDay(task.placement.date) : 'backlog';
};

/**
 * Escape closes an overlay wherever the focus is in it, as it does the calendar's popovers. Attached before the
 * overlay is painted, so an Escape pressed the moment it shows is not lost.
 */
const useEscape = (onClose: () => void) =>
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

/** Cmd/Ctrl+K: jump anywhere, run an action, or find a task. */
export const CommandPalette = ({ onClose, onRoute, onAddTask, onAsk }: { onClose: () => void; onRoute: (route: Route) => void; onAddTask: () => void; onAsk: (query: string) => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  useLayoutEffect(() => input.current?.focus(), []);
  useEscape(onClose);

  const go = (route: Route, label: string, hint: string): Item => ({ id: `go-${route}`, label: `Go to ${label}`, hint, run: () => onRoute(route) });
  const commands: Item[] = [
    { id: 'add', label: 'Add task', hint: 'A', run: onAddTask },
    go('home', 'Home', ''),
    go('today', 'Today', 'T'),
    go('calendar', 'Calendar', ''),
    go('focus', 'Focus', 'F'),
    go('planning', 'Daily planning', 'P'),
    go('shutdown', 'Daily shutdown', 'O'),
    go('highlights', 'Daily highlights', ''),
    go('weeklyPlanning', 'Weekly planning', ''),
    go('weeklyReview', 'Weekly review', ''),
    go('backlog', 'Backlog', ''),
    go('linear', 'Linear', ''),
    go('github', 'GitHub', ''),
    go('google', 'Google', ''),
    go('agents', 'Agents', ''),
    go('archive', 'Archive', ''),
    go('stats', 'Stats', ''),
    go('settings', 'Settings', ''),
    { id: 'sort', label: 'Sort today by priority', hint: '', run: () => void client.dispatch(reorderCommands(sortTasks(tasksForDay(view.state, view.today), 'priority')), { undo: 'List sorted' }) },
    ...(view.state.timer ? [{ id: 'stop', label: 'Stop the timer', hint: '', run: () => void client.dispatch([{ type: 'timer.stopped' }]) }] : []),
  ];
  const q = query.trim().toLowerCase();
  const tasks: Item[] = q.length >= 2
    ? Object.values(view.state.tasks)
        .filter((task) => `${task.title} ${task.notes}`.toLowerCase().includes(q))
        .sort((a, b) => Number(Boolean(a.deletedAt || a.archivedAt)) - Number(Boolean(b.deletedAt || b.archivedAt)) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
        .map((task) => ({ id: task.id, label: task.title, hint: `${where(task)}${task.plannedMinutes ? ` · ${formatMinutes(task.plannedMinutes)}` : ''}`, run: () => setUi({ openTaskId: task.id }) }))
    : [];
  const ask: Item[] = q.length >= 3 ? [{ id: 'ask', label: `Ask Planner: "${query.trim()}"`, hint: '✦', run: () => onAsk(query.trim()) }] : [];
  const items = [...commands.filter((item) => !q || item.label.toLowerCase().includes(q)), ...tasks, ...ask];
  const active = Math.min(index, Math.max(0, items.length - 1));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div class="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          value={query}
          placeholder="Search tasks or type a command"
          aria-label="Search tasks or commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setIndex((current) => Math.min(items.length - 1, current + 1));
            else if (event.key === 'ArrowUp') setIndex((current) => Math.max(0, current - 1));
            else if (event.key === 'Enter') run(items[active]);
            else return;
            event.preventDefault();
          }}
        />
        <ul id="palette-list" role="listbox" class="palette-list">
          {items.map((item, position) => (
            <li key={item.id} role="option" aria-selected={position === active} class={position === active ? 'is-active' : ''} onMouseEnter={() => setIndex(position)} onMouseDown={(event) => { event.preventDefault(); run(item); }}>
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li class="empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
};

/** Sunsama's Add Task window (A): the same syntax as inline Add task, landing on today by default. */
export const QuickAddModal = ({ onClose }: { onClose: () => void }) => {
  const { client, linear, github, google } = usePlanner();
  const view = useView();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useLayoutEffect(() => input.current?.focus(), []);
  useEscape(onClose);
  const parsed = text.trim() ? parseQuickAdd(text, view.today, view.state.settings.weekStartsOn) : null;
  return (
    <div class="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Add task">
        <input
          ref={input}
          value={text}
          placeholder="Task name  ~30m  @tomorrow  #channel  $objective  !high"
          aria-label="New task"
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !parsed?.title.trim()) return;
            void addParsedTask({ client, linear, github, google }, parsed, { kind: 'day', date: view.today }, 'bottom', view.today);
            onClose();
          }}
        />
        <p class="hint palette-hint">{(parsed && urlHint(parsed.title)) ?? `Enter adds to ${parsed?.placement ? 'the day or bucket you named' : 'today'}. Esc cancels.`}</p>
      </div>
    </div>
  );
};
