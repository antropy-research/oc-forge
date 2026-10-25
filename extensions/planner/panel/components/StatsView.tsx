import { useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, formatMinutes, monthDay, weekdayName } from '../../src/domain/dates.ts';
import { actualMinutes } from '../../src/domain/selectors.ts';
import { completedOnDay, ritualRecord } from '../../src/domain/rituals.ts';
import { useView } from '../lib/context.ts';
import { ChannelBreakdown } from './rituals/DailyShutdown.tsx';

const RANGES = [7, 28, 90] as const;

/** Sunsama-style analytics: what got done, how long it took, and how well the plans held. */
export const StatsView = () => {
  const view = useView();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const dates: DateKey[] = Array.from({ length: days }, (_, index) => addDays(view.today, index - days + 1));
  const perDay = dates.map((date) => {
    const done = completedOnDay(view.state, date);
    return { date, done, minutes: done.reduce((sum, task) => sum + actualMinutes(view.state, task), 0), planned: Boolean(ritualRecord(view.state, 'planning', date).completedAt) };
  });
  const done = perDay.flatMap((day) => day.done);
  const actual = perDay.reduce((sum, day) => sum + day.minutes, 0);
  const estimated = done.filter((task) => task.plannedMinutes);
  const plannedOfEstimated = estimated.reduce((sum, task) => sum + (task.plannedMinutes ?? 0), 0);
  const actualOfEstimated = estimated.reduce((sum, task) => sum + actualMinutes(view.state, task), 0);
  const accuracy = plannedOfEstimated ? Math.round((actualOfEstimated / plannedOfEstimated) * 100) : null;
  let streak = 0;
  for (let index = perDay.length - 1; index >= 0 && perDay[index]!.done.length > 0; index--) streak++;
  const maxMinutes = Math.max(30, ...perDay.map((day) => day.minutes));

  return (
    <section class="view">
      <header class="view-header">
        <h1>Stats</h1>
        <span class="view-sub">{monthDay(dates[0]!)} – {monthDay(view.today)}</span>
        <div class="date-nav">
          <div class="tabs" role="tablist" aria-label="Range">
            {RANGES.map((range) => <button key={range} role="tab" aria-selected={days === range} onClick={() => setDays(range)}>{range} days</button>)}
          </div>
        </div>
      </header>
      <div class="view-scroll stats">
        <div class="stat-cards">
          <div class="stat-card"><span class="label">Tasks completed</span><strong>{done.length}</strong></div>
          <div class="stat-card"><span class="label">Actual time</span><strong>{formatMinutes(actual) || '0:00'}</strong></div>
          <div class="stat-card"><span class="label">Actual vs planned</span><strong>{accuracy === null ? '—' : `${accuracy}%`}</strong></div>
          <div class="stat-card"><span class="label">Days planned</span><strong>{perDay.filter((day) => day.planned).length}/{days}</strong></div>
          <div class="stat-card"><span class="label">Completion streak</span><strong>{streak} day{streak === 1 ? '' : 's'}</strong></div>
        </div>
        <h2>Work per day</h2>
        <div class={`day-bars${days > 28 ? ' is-dense' : ''}`} role="img" aria-label="Actual time per day">
          {perDay.map((day) => (
            <div key={day.date} class="day-bar" title={`${weekdayName(day.date)}, ${monthDay(day.date)}: ${day.done.length} tasks, ${formatMinutes(day.minutes) || '0:00'}`}>
              <div class="bar-track"><div class={`bar-fill${day.planned ? ' is-planned' : ''}`} style={{ height: `${(day.minutes / maxMinutes) * 100}%` }} /></div>
              {days <= 28 && <span class="bar-label">{days <= 7 ? weekdayName(day.date).slice(0, 3) : Number(day.date.slice(8))}</span>}
            </div>
          ))}
        </div>
        <p class="hint">Bars show tracked time (planned time for tasks completed untracked, when that setting is on); darker bars are days you ran daily planning.</p>
        <h2>Time by channel</h2>
        <div class="stats-breakdown"><ChannelBreakdown tasks={done} /></div>
      </div>
    </section>
  );
};
