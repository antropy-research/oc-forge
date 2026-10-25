import { useState } from 'preact/hooks';
import { clockLabel, monthDay, weekdayName, zonedDateMinutes } from '../../src/domain/dates.ts';
import { ritualRecord } from '../../src/domain/rituals.ts';
import { useNow } from '../lib/time.ts';
import { tasksForDay } from '../../src/domain/selectors.ts';
import { useGoogle, usePlanner, useView } from '../lib/context.ts';
import { BacklogBuckets } from './Backlog.tsx';
import { DayColumn } from './DayColumn.tsx';
import { AddTask } from './AddTask.tsx';
import { TaskList } from './TaskList.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { DayCalendar } from './TimeGrid.tsx';
import { LinearIssues } from './LinearPanel.tsx';
import { GitHubItems } from './GitHubPanel.tsx';
import { GmailItems, GoogleTasksItems } from './GooglePanel.tsx';

type Side = 'calendar' | 'backlog' | 'linear' | 'github' | 'tasks' | 'mail';
const SIDE_LABELS: Record<Side, string> = { calendar: 'Calendar', backlog: 'Backlog', linear: 'Linear', github: 'GitHub', tasks: 'Google Tasks', mail: 'Gmail' };


/** Today: only today's work, with the calendar or the backlog beside it. */
export const TodayView = ({ onShutdown }: { onShutdown?: () => void }) => {
  const view = useView();
  const now = useNow(true, 60_000);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shutdownAt = ritualRecord(view.state, 'planning', view.today).shutdownTime ?? view.state.settings.workdayEnd;
  const pastShutdown = zonedDateMinutes(now, zone).minutes >= shutdownAt && !ritualRecord(view.state, 'shutdown', view.today).completedAt;
  const { google } = usePlanner();
  useGoogle();
  const [chosen, setSide] = useState<Side>('calendar');
  // Google Tasks and Gmail show once an account allows them.
  const sides: Side[] = ['calendar', 'backlog', 'linear', 'github', ...(google.accountsWith('tasks').length ? (['tasks'] as const) : []), ...(google.accountsWith('mail').length ? (['mail'] as const) : [])];
  const side = sides.includes(chosen) ? chosen : 'calendar';
  return (
    <section class="view">
      <header class="view-header">
        <h1>Today</h1>
        <span class="view-sub">{weekdayName(view.today)}, {monthDay(view.today)}</span>
        <div class="date-nav">
          <ChannelFilter />
        </div>
      </header>
      {pastShutdown && onShutdown && (
        <div class="banner" role="status">
          <span>It's past {clockLabel(shutdownAt)}, your shutdown time.</span>
          <button class="link" onClick={onShutdown}>Start the daily shutdown</button>
        </div>
      )}
      <div class="today-layout">
        <DayColumn date={view.today} wide />
        <aside class={`side-panel${side === 'calendar' ? ' is-calendar' : ''}`} aria-label={SIDE_LABELS[side]}>
          <div class="tabs side-tabs" role="tablist">
            {sides.map((item) => <button key={item} role="tab" aria-selected={side === item} onClick={() => setSide(item)}>{SIDE_LABELS[item]}</button>)}
          </div>
          {side === 'calendar' && <DayCalendar date={view.today} />}
          {side === 'backlog' && <BacklogBuckets compact />}
          {side === 'linear' && <LinearIssues />}
          {side === 'github' && <GitHubItems />}
          {side === 'tasks' && <GoogleTasksItems />}
          {side === 'mail' && <GmailItems />}
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
