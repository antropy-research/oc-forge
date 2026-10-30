import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { setShared, usePanel, type SourceId } from '../lib/sourcePanel.ts';
import { DayTargetsContext } from '../lib/dayTargets.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { dayLabel } from './DayColumn.tsx';
import { DayCalendar } from './TimeGrid.tsx';
import { LinearIssues } from './LinearPanel.tsx';
import { GitHubItems } from './GitHubPanel.tsx';
import { GmailItems, GoogleTasksItems } from './GooglePanel.tsx';
import { BacklogIcon, CalendarIcon, GitHubIcon, GmailIcon, LinearIcon, TasksIcon } from './SourceIcons.tsx';

export { openSource, showCalendarDay, type SourceId } from '../lib/sourcePanel.ts';

const SOURCES: { id: SourceId; label: string; hint: string; Icon: () => JSX.Element }[] = [
  { id: 'calendar', label: 'Calendar', hint: 'Drag a task onto a time to timebox it.', Icon: CalendarIcon },
  { id: 'backlog', label: 'Backlog', hint: 'Drag a task onto a day.', Icon: BacklogIcon },
  { id: 'linear', label: 'Linear', hint: 'Drag an issue onto a day, or plan it with a click.', Icon: LinearIcon },
  { id: 'github', label: 'GitHub', hint: 'Drag an issue or pull request onto a day.', Icon: GitHubIcon },
  { id: 'mail', label: 'Gmail', hint: 'Drag a message onto a day to make it a task.', Icon: GmailIcon },
  { id: 'tasks', label: 'Google Tasks', hint: 'Drag a task onto a day.', Icon: TasksIcon },
];

/** Sunsama's "Calendars" at the top of the calendar: which calendars show (only what is shown changes). */
const CalendarsMenu = () => {
  const { client } = usePlanner();
  const view = useView();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const calendars = Object.values(view.state.calendars).sort((a, b) => a.name.localeCompare(b.name));
  if (!calendars.length) return null;
  return (
    <span class="menu-anchor" ref={ref}>
      <button class="link calendars-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)}>Calendars</button>
      {open && (
        <div class="menu calendars-menu" role="menu" aria-label="Calendars shown">
          {calendars.map((calendar) => (
            <label key={calendar.id} class="menu-check-row">
              <input type="checkbox" checked={calendar.visible} onChange={(event) => void client.dispatch([{ type: 'calendar.updated', calendarId: calendar.id, patch: { visible: event.currentTarget.checked } }])} />
              <span class="calendar-swatch" style={{ background: calendar.color }} aria-hidden="true" /> {calendar.name}
            </label>
          ))}
        </div>
      )}
    </span>
  );
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
        <CalendarsMenu />
      </div>
      <DayCalendar date={date} />
    </div>
  );
};

/**
 * Sunsama's right-hand panel: a vertical rail of sources (Calendar, Backlog,
 * Linear, GitHub, Gmail, Google Tasks) and the chosen one's list beside it.
 * Its items drag onto any day column on screen (and onto the calendar), and
 * their quick actions plan on `days`, `primary` first. The » buttons fold the
 * panel down to the rail; any source opens it again.
 */
export const SourcePanel = ({ days, primary }: { days: DateKey[]; primary: DateKey }) => {
  const panel = usePanel();
  const [calendarDate, setCalendarDate] = useState(primary);
  useEffect(() => setCalendarDate(primary), [primary]);
  useEffect(() => {
    if (panel.day) setCalendarDate(panel.day.date);
  }, [panel.day?.at]);
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
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Sources"
          onKeyDown={(event) => {
            // Up and down move between the sources, as in a vertical tab list.
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const at = SOURCES.findIndex((item) => item.id === (event.target as HTMLElement).dataset.source);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? SOURCES.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : SOURCES.length - 1)) % SOURCES.length;
            setShared({ open: SOURCES[next]!.id });
            (event.currentTarget.querySelector(`[data-source="${SOURCES[next]!.id}"]`) as HTMLElement | null)?.focus();
          }}
        >
          {SOURCES.map((item) => (
            <button
              key={item.id}
              role="tab"
              data-source={item.id}
              tabIndex={panel.open === item.id || (!panel.open && item.id === panel.last) ? 0 : -1}
              class={`rail-button${panel.open === item.id ? ' is-active' : ''}`}
              aria-selected={panel.open === item.id}
              aria-controls={panel.open === item.id ? 'planner-source-panel' : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => setShared({ open: item.id })}
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
