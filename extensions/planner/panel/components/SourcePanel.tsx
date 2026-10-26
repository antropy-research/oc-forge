import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { useView } from '../lib/context.ts';
import { DayTargetsContext } from '../lib/dayTargets.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { dayLabel } from './DayColumn.tsx';
import { DayCalendar } from './TimeGrid.tsx';
import { LinearIssues } from './LinearPanel.tsx';
import { GitHubItems } from './GitHubPanel.tsx';
import { GmailItems, GoogleTasksItems } from './GooglePanel.tsx';

export type SourceId = 'calendar' | 'backlog' | 'linear' | 'github' | 'mail' | 'tasks';

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
const BacklogIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
    <path d="M3.5 13.5l2.2-7.4A2 2 0 0 1 7.6 4.7h8.8a2 2 0 0 1 1.9 1.4l2.2 7.4v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M3.5 13.5h5l1.2 2h4.6l1.2-2h5" />
  </svg>
);
// Linear's mark: a disc cut by four parallel lines.
const LinearIcon = () => (
  <svg viewBox="0 0 100 100" aria-hidden="true" fill="#5e6ad2">
    <path d="M1.2 61.5c-.2-1 1-1.6 1.6-.9l36.6 36.6c.7.7.1 1.8-.9 1.6A50 50 0 0 1 1.2 61.5z" />
    <path d="M0 46.9a1.5 1.5 0 0 0 .4 1.1l51.6 51.6c.3.3.7.4 1.1.4a50 50 0 0 0 6.9-.9c.8-.2 1-1.1.5-1.7L2.6 39.5c-.6-.6-1.5-.3-1.7.5A50 50 0 0 0 0 46.9z" />
    <path d="M4.2 29.7c-.2.4-.1.8.2 1.1l64.8 64.8c.3.3.7.4 1.1.2a50 50 0 0 0 5.2-2.7c.6-.3.6-1.1.2-1.5L8.4 24.3c-.5-.5-1.2-.4-1.5.2a50 50 0 0 0-2.7 5.2z" />
    <path d="M12.7 18.1a1.5 1.5 0 0 1-.1-2A50 50 0 1 1 84 87.4c-.6.5-1.4.5-2-.1z" />
  </svg>
);
const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
const GmailIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285f4" d="M3.5 19.5h3.3v-8.1L2 7.8v10.2c0 .8.7 1.5 1.5 1.5z" />
    <path fill="#34a853" d="M17.2 19.5h3.3c.8 0 1.5-.7 1.5-1.5V7.8l-4.8 3.6z" />
    <path fill="#fbbc04" d="M17.2 5.3v6.1L22 7.8V5.9c0-1.8-2-2.8-3.4-1.7z" />
    <path fill="#ea4335" d="M6.8 11.4V5.3L12 9.2l5.2-3.9v6.1L12 15.3z" />
    <path fill="#c5221f" d="M2 5.9v1.9l4.8 3.6V5.3L5.4 4.2C4 3.1 2 4.1 2 5.9z" />
  </svg>
);
const TasksIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" fill="#1a73e8" />
    <path d="M7.8 12.3l2.9 2.9 5.6-6.1" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const SOURCES: { id: SourceId; label: string; hint: string; Icon: () => JSX.Element }[] = [
  { id: 'calendar', label: 'Calendar', hint: 'Drag a task onto a time to timebox it.', Icon: CalendarIcon },
  { id: 'backlog', label: 'Backlog', hint: 'Drag a task onto a day.', Icon: BacklogIcon },
  { id: 'linear', label: 'Linear', hint: 'Drag an issue onto a day, or plan it with a click.', Icon: LinearIcon },
  { id: 'github', label: 'GitHub', hint: 'Drag an issue or pull request onto a day.', Icon: GitHubIcon },
  { id: 'mail', label: 'Gmail', hint: 'Drag a message onto a day to make it a task.', Icon: GmailIcon },
  { id: 'tasks', label: 'Google Tasks', hint: 'Drag a task onto a day.', Icon: TasksIcon },
];

/** What the panel shows, the same on Home and Today: a source, or nothing (only the rail). */
interface PanelState {
  open: SourceId | null;
  last: SourceId;
  /** The calendar under a source's list, to drop items straight onto a time. */
  split: boolean;
}

let shared: PanelState = { open: 'calendar', last: 'calendar', split: false };
const listeners = new Set<() => void>();
const setShared = (patch: Partial<PanelState>) => {
  shared = { ...shared, ...patch, ...(patch.open ? { last: patch.open } : {}) };
  for (const listener of listeners) listener();
};
const usePanel = (): PanelState => {
  const [state, setState] = useState(shared);
  useEffect(() => {
    const listener = () => setState(shared);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return state;
};

/** One day of the calendar, steppable a day at a time. */
const CalendarDay = ({ date, onDate }: { date: DateKey; onDate: (date: DateKey) => void }) => {
  const view = useView();
  return (
    <div class="source-calendar">
      <div class="source-day" role="group" aria-label="Calendar day">
        <button class="icon-button" aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}>‹</button>
        <span class="source-day-label">{dayLabel(date, view.today)} · {weekdayName(date).slice(0, 3)}, {monthDay(date)}</span>
        <button class="icon-button" aria-label="Next day" onClick={() => onDate(addDays(date, 1))}>›</button>
      </div>
      <DayCalendar date={date} />
    </div>
  );
};

/**
 * Sunsama's right-hand panel: a vertical rail of sources (Calendar, Backlog,
 * Linear, GitHub, Gmail, Google Tasks) and the chosen one's list beside it.
 * Its items drag onto any day column on screen (and onto the calendar), and
 * their quick actions plan on `days`, `primary` first. Clicking the open
 * source again folds the panel down to the rail.
 */
export const SourcePanel = ({ days, primary }: { days: DateKey[]; primary: DateKey }) => {
  const panel = usePanel();
  const [calendarDate, setCalendarDate] = useState(primary);
  useEffect(() => setCalendarDate(primary), [primary]);
  const source = SOURCES.find((item) => item.id === panel.open) ?? null;
  const split = Boolean(source && source.id !== 'calendar' && panel.split);
  return (
    <DayTargetsContext.Provider value={{ days, primary }}>
      {source && (
        <aside id="planner-source-panel" class={`side-panel source-panel${source.id === 'calendar' ? ' is-calendar' : ''}${split ? ' is-split' : ''}`} aria-label={source.label}>
          <header class="source-head">
            <span class="source-icon" aria-hidden="true"><source.Icon /></span>
            <h2>{source.label}</h2>
            <span class="grow" />
            {source.id !== 'calendar' && (
              <button
                class={`icon-button source-split${split ? ' is-on' : ''}`}
                aria-pressed={split}
                aria-label="Calendar below"
                title="Show the calendar under the list, to drop items onto a time"
                onClick={() => setShared({ split: !panel.split })}
              >
                <CalendarIcon />
              </button>
            )}
            <button class="icon-button" aria-label="Close the panel" title="Close the panel (the rail stays)" onClick={() => setShared({ open: null })}>»</button>
          </header>
          {source.id === 'calendar' ? (
            <CalendarDay date={calendarDate} onDate={setCalendarDate} />
          ) : (
            <div class="source-body">
              <p class="hint">{source.hint}</p>
              {source.id === 'backlog' && <BacklogBuckets compact />}
              {source.id === 'linear' && <LinearIssues />}
              {source.id === 'github' && <GitHubItems />}
              {source.id === 'mail' && <GmailItems />}
              {source.id === 'tasks' && <GoogleTasksItems />}
            </div>
          )}
          {split && <CalendarDay date={calendarDate} onDate={setCalendarDate} />}
        </aside>
      )}
      <nav class="source-rail" aria-label="Sources">
        <div role="tablist" aria-orientation="vertical" aria-label="Sources">
          {SOURCES.map((item) => (
            <button
              key={item.id}
              role="tab"
              class={`rail-button${panel.open === item.id ? ' is-active' : ''}`}
              aria-selected={panel.open === item.id}
              aria-controls={panel.open === item.id ? 'planner-source-panel' : undefined}
              aria-label={item.label}
              title={panel.open === item.id ? `${item.label} (click to hide)` : item.label}
              onClick={() => setShared({ open: panel.open === item.id ? null : item.id })}
            >
              <item.Icon />
            </button>
          ))}
        </div>
        <span class="grow" />
        <button class="rail-button rail-toggle" aria-label={panel.open ? 'Hide the panel' : 'Show the panel'} aria-expanded={Boolean(panel.open)} title={panel.open ? 'Hide the panel' : 'Show the panel'} onClick={() => setShared({ open: panel.open ? null : panel.last })}>
          {panel.open ? '»' : '«'}
        </button>
      </nav>
    </DayTargetsContext.Provider>
  );
};
