import { clockLabel, monthDay, weekdayName, zonedDateMinutes } from '../../src/domain/dates.ts';
import { todayTargets } from '../lib/dayTargets.ts';
import { ritualRecord } from '../../src/domain/rituals.ts';
import { useNow } from '../lib/time.ts';
import { tasksForDay } from '../../src/domain/selectors.ts';
import { useView } from '../lib/context.ts';
import { DayColumn } from './DayColumn.tsx';
import { AddTask } from './AddTask.tsx';
import { TaskList } from './TaskList.tsx';
import { ChannelFilter } from './ChannelFilter.tsx';
import { SourcePanel } from './SourcePanel.tsx';

/** Today: only today's work, with the same sources panel as Home beside it. */
export const TodayView = ({ onShutdown }: { onShutdown?: () => void }) => {
  const view = useView();
  const now = useNow(true, 60_000);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shutdownAt = ritualRecord(view.state, 'planning', view.today).shutdownTime ?? view.state.settings.workdayEnd;
  const pastShutdown = zonedDateMinutes(now, zone).minutes >= shutdownAt && !ritualRecord(view.state, 'shutdown', view.today).completedAt;
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
      <div class="sunsama-layout is-today">
        <DayColumn date={view.today} wide />
        <SourcePanel {...todayTargets(view.today)} />
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
