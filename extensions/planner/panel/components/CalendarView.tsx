import { useState } from 'preact/hooks';
import { GOOGLE_TASKS_CALENDAR } from '../../src/domain/google.ts';
import { addDays, monthDay, startOfWeek } from '../../src/domain/dates.ts';
import { blocksFor, tasksForDay } from '../../src/domain/selectors.ts';
import { zonedDateMinutes } from '../../src/domain/dates.ts';
import { useView } from '../lib/context.ts';
import { useCalendarEvents } from '../lib/calendar.ts';
import { matchesFilter, useUi } from '../lib/ui.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { TaskList } from './TaskList.tsx';
import { TimeGrid } from './TimeGrid.tsx';
import { LinearIssues } from './LinearPanel.tsx';

/** Today's tasks that have no working session today yet. */
export const UnscheduledToday = () => {
  const view = useView();
  const { ui } = useUi();
  const zone = view.state.settings.timezone ?? 'UTC';
  const tasks = tasksForDay(view.state, view.today).filter(
    (task) => matchesFilter(task, ui.channelFilter, view.state.channels) && !task.completedAt && !blocksFor(view.state, task.id).some((block) => zonedDateMinutes(block.start, zone).date === view.today),
  );
  return <TaskList placement={{ kind: 'day', date: view.today }} tasks={tasks} empty="Everything today has a time" />;
};

/** Calendar: the day or week as a time grid, with unscheduled work beside it to drag in. */
export const CalendarView = () => {
  const view = useView();
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [side, setSide] = useState<'unscheduled' | 'backlog' | 'linear'>('unscheduled');
  const [anchor, setAnchor] = useState(view.today);
  const dates = mode === 'day' ? [anchor] : Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor, view.state.settings.weekStartsOn), index));
  const feed = useCalendarEvents(dates[0]!, dates[dates.length - 1]!);
  const step = mode === 'day' ? 1 : 7;
  return (
    <section class="view">
      <header class="view-header">
        <h1>Calendar</h1>
        <span class="view-sub">{mode === 'day' ? monthDay(dates[0]!) : `${monthDay(dates[0]!)} – ${monthDay(dates[6]!)}`}{feed.loading ? ' · syncing…' : ''}</span>
        <div class="date-nav">
          <ChannelFilter />
          <div class="tabs" role="tablist" aria-label="Calendar range">
            <button role="tab" aria-selected={mode === 'day'} onClick={() => setMode('day')}>Day</button>
            <button role="tab" aria-selected={mode === 'week'} onClick={() => setMode('week')}>Week</button>
          </div>
          <button aria-label="Earlier" onClick={() => setAnchor(addDays(anchor, -step))}>‹</button>
          <button onClick={() => setAnchor(view.today)}>Today</button>
          <button aria-label="Later" onClick={() => setAnchor(addDays(anchor, step))}>›</button>
        </div>
      </header>
      {feed.errors.length > 0 && (
        <p class="feed-errors" role="alert">
          {feed.errors.map((error) => `${error.calendarId === GOOGLE_TASKS_CALENDAR ? 'Google Tasks' : view.state.calendars[error.calendarId]?.name ?? 'Calendar'}: ${error.message}`).join(' · ')}
        </p>
      )}
      <div class="calendar-layout">
        <TimeGrid dates={dates} events={feed.events} />
        <aside class="side-panel" aria-label="Unscheduled work">
          <div class="tabs side-tabs" role="tablist">
            <button role="tab" aria-selected={side === 'unscheduled'} onClick={() => setSide('unscheduled')}>Unscheduled</button>
            <button role="tab" aria-selected={side === 'backlog'} onClick={() => setSide('backlog')}>Backlog</button>
            <button role="tab" aria-selected={side === 'linear'} onClick={() => setSide('linear')}>Linear</button>
          </div>
          <p class="hint">Drag onto the calendar to timebox.</p>
          {side === 'unscheduled' && <UnscheduledToday />}
          {side === 'backlog' && <BacklogBuckets compact />}
          {side === 'linear' && <LinearIssues />}
        </aside>
      </div>
    </section>
  );
};
