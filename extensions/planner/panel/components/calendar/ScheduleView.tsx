// Google Calendar's Schedule view: day after day, only days with something on
// them, each event with its time, calendar color and place.
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey } from '../../../src/domain/types.ts';
import { zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactRange, longDay, scheduleDays, shortDay, weekdayShort } from '../../../src/domain/gcalendar.ts';
import { useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { anchorOf, calendarUi, useCalendarUi } from '../../lib/gcal.ts';
import { answerClass, calendarItems, eventColor, isTaskEvent, itemKey, plannedTask } from './items.ts';

const range = (start: string, end: string, zone: string, day: DateKey): string => {
  const from = zonedDateMinutes(start, zone);
  const to = zonedDateMinutes(end, zone);
  const a = from.date < day ? 0 : from.minutes;
  const b = to.date > day ? 1440 : to.minutes;
  return a === 0 && b === 1440 ? 'All day' : compactRange(a, b);
};

export const ScheduleView = ({ from, to, events, onDay }: { from: DateKey; to: DateKey; events: CalendarEvent[]; onDay: (date: DateKey) => void }) => {
  const view = useView();
  const { setUi } = useUi();
  const { prefs } = useCalendarUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = scheduleDays(calendarItems(view.state, events, from, to, zone, { completedTasks: prefs.completedTasks, channel: () => true }), from, to);
  return (
    <div class="schedule-view">
      {days.map((day) => (
        <section key={day.date} class={`schedule-day${day.date === view.today ? ' is-today' : ''}`} aria-label={longDay(day.date)}>
          <div class="schedule-date">
            <button class="day-number" aria-label={`${longDay(day.date)}: show this day`} onClick={() => onDay(day.date)}>{Number(day.date.slice(8))}</button>
            <span class="schedule-weekday">{shortDay(day.date).split(' ')[0]?.toUpperCase()}, {weekdayShort(day.date)}</span>
          </div>
          <ul class="schedule-items">
            {day.items.map(({ item }) => {
              if (item.kind === 'block') {
                const color = item.task.channelId ? view.state.channels[item.task.channelId]?.color ?? 'var(--oc-primary)' : 'var(--oc-primary)';
                return (
                  <li key={itemKey(item)}>
                    <button class={`schedule-item is-session${item.task.completedAt ? ' is-done' : ''}`} style={{ '--item-color': color }} onClick={() => setUi({ openTaskId: item.task.id })} aria-label={`Working session: ${item.task.title}`}>
                      <span class="schedule-time">{range(item.block.start, item.block.end, zone, day.date)}</span>
                      <span class="chip-dot is-square" aria-hidden="true" />
                      <span class="schedule-title">{item.task.title}</span>
                      <span class="schedule-where muted">Working session</span>
                    </button>
                  </li>
                );
              }
              const event = item.event;
              const task = isTaskEvent(event) ? event.googleTask! : null;
              const planned = task ? plannedTask(view.state, event) : null;
              return (
                <li key={itemKey(item)}>
                  <button
                    class={`schedule-item${task ? ' is-task' : ''}${task?.completed ? ' is-done' : ''}${answerClass(event)}`}
                    style={{ '--item-color': eventColor(event, view.state.calendars) }}
                    aria-label={`${event.title}, ${task ? 'task' : event.allDay ? 'all day' : range(event.start, event.end, zone, day.date)}`}
                    onClick={(click) => calendarUi.open({ kind: task ? 'task' : 'event', event, anchor: anchorOf(click.currentTarget) })}
                  >
                    <span class="schedule-time">{task || event.allDay ? 'All day' : range(event.start, event.end, zone, day.date)}</span>
                    <span class="chip-dot" aria-hidden="true" />
                    <span class="schedule-title">{task ? (task.completed ? '☑ ' : '☐ ') : ''}{event.title}</span>
                    {event.location && <span class="schedule-where muted">{event.location}</span>}
                    {planned && <span class="bar-badge">✓ planned</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {days.length === 0 && <p class="empty schedule-empty">Nothing on your calendars from {longDay(from)} to {longDay(to)}.</p>}
    </div>
  );
};
