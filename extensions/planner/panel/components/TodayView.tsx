import { useState } from 'preact/hooks';
import { monthDay, weekdayName } from '../../src/domain/dates.ts';
import { tasksForDay } from '../../src/domain/selectors.ts';
import { useView } from '../lib/context.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { DayColumn } from './DayColumn.tsx';
import { AddTask } from './AddTask.tsx';
import { TaskList } from './TaskList.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { DayCalendar } from './TimeGrid.tsx';


/** Today: only today's work, with the calendar or the backlog beside it. */
export const TodayView = () => {
  const view = useView();
  const [side, setSide] = useState<'calendar' | 'backlog'>('calendar');
  return (
    <section class="view">
      <header class="view-header">
        <h1>Today</h1>
        <span class="view-sub">{weekdayName(view.today)}, {monthDay(view.today)}</span>
        <div class="date-nav">
          <ChannelFilter />
        </div>
      </header>
      <div class="today-layout">
        <DayColumn date={view.today} wide />
        <aside class={`side-panel${side === 'calendar' ? ' is-calendar' : ''}`} aria-label={side === 'calendar' ? 'Calendar' : 'Backlog'}>
          <div class="tabs side-tabs" role="tablist">
            <button role="tab" aria-selected={side === 'calendar'} onClick={() => setSide('calendar')}>Calendar</button>
            <button role="tab" aria-selected={side === 'backlog'} onClick={() => setSide('backlog')}>Backlog</button>
          </div>
          {side === 'calendar' ? <DayCalendar date={view.today} /> : <BacklogBuckets compact />}
        </aside>
      </div>
    </section>
  );
};

/** The rail panel: a narrow, always-at-hand Today list. */
export const CompactToday = () => {
  const view = useView();
  const tasks = tasksForDay(view.state, view.today);
  const open = tasks.filter((task) => !task.completedAt).length;
  return (
    <div class="compact">
      <header class="compact-header">
        <div class="day-name">Today</div>
        <div class="day-date">{weekdayName(view.today)}, {monthDay(view.today)} · {open} open</div>
      </header>
      <AddTask placement={{ kind: 'day', date: view.today }} />
      <TaskList placement={{ kind: 'day', date: view.today }} tasks={tasks} empty="Nothing planned yet" />
    </div>
  );
};
