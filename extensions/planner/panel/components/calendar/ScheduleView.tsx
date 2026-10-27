// Google Calendar's Schedule view: day after day, only days with something on
// them, each event with its time, calendar color and place.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../../src/domain/ics.ts';
import type { DateKey } from '../../../src/domain/types.ts';
import { zonedDateMinutes } from '../../../src/domain/dates.ts';
import { compactRange, longDay, scheduleDays, shortDay, weekdayShort } from '../../../src/domain/gcalendar.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { anchorOf, calendarUi, searchEvents, useCalendarUi } from '../../lib/gcal.ts';
import { answerClass, calendarItems, eventColor, isTaskEvent, itemKey, plannedTask, taskEventLabel } from './items.ts';

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
                    aria-label={task ? taskEventLabel(event, view.state, view.today) : `${event.title}, ${event.allDay ? 'all day' : range(event.start, event.end, zone, day.date)}`}
                    onClick={(click) => calendarUi.open({ kind: task ? 'task' : 'event', event, anchor: anchorOf(click.currentTarget) })}
                  >
                    <span class="schedule-time">{event.allDay ? 'All day' : range(event.start, event.end, zone, day.date)}</span>
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

/**
 * Google Calendar's search results: the matching events of the calendars
 * shown, day after day as in Schedule, opened at today. Read again after a
 * change made from them (an edit or a deletion in the details).
 */
export const SearchResults = ({ query, onDay }: { query: string; onDay: (date: DateKey) => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const { tick } = useCalendarUi();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [answer, setAnswer] = useState<{ query: string; events: CalendarEvent[]; more: boolean; errors: string[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setFailure(null);
    void searchEvents(client, query).then(
      (result) => {
        if (!live) return;
        setAnswer({ query, events: result.events, more: result.more, errors: result.errors.map((error) => `${view.state.calendars[error.calendarId]?.name ?? 'Calendar'}: ${error.message}`) });
      },
      (error) => live && setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, [query, tick]);
  const current = answer?.query === query ? answer : null;
  const days = new Map<DateKey, CalendarEvent[]>();
  for (const event of current?.events ?? []) {
    const date = zonedDateMinutes(event.start, zone).date;
    days.set(date, [...(days.get(date) ?? []), event]);
  }
  const dates = [...days.keys()].sort();
  // Opened at today, or the first result after it, as Google Calendar opens its results.
  const first = dates.find((date) => date >= view.today) ?? dates[dates.length - 1];
  useEffect(() => {
    if (first) list.current?.querySelector(`[data-date="${first}"]`)?.scrollIntoView({ block: 'start' });
  }, [current?.query, first]);
  return (
    <div class="schedule-view search-results" ref={list} role="region" aria-label={`Search results for ${query}`}>
      {!current && !failure && <p class="hint schedule-empty" role="status">Searching your calendars…</p>}
      {failure && <p class="feed-errors" role="alert">The search did not finish: {failure}</p>}
      {current && current.errors.length > 0 && <p class="feed-errors" role="alert">{current.errors.join(' · ')}</p>}
      {dates.map((date) => (
        <section key={date} data-date={date} class={`schedule-day${date === view.today ? ' is-today' : ''}`} aria-label={longDay(date)}>
          <div class="schedule-date">
            <button class="day-number" aria-label={`${longDay(date)}: show this day`} onClick={() => onDay(date)}>{Number(date.slice(8))}</button>
            <span class="schedule-weekday">{shortDay(date).split(' ')[0]?.toUpperCase()}, {weekdayShort(date)} {date.slice(0, 4) === view.today.slice(0, 4) ? '' : date.slice(0, 4)}</span>
          </div>
          <ul class="schedule-items">
            {days.get(date)!.map((event) => (
              <li key={event.id}>
                <button
                  class={`schedule-item${answerClass(event)}`}
                  style={{ '--item-color': eventColor(event, view.state.calendars) }}
                  aria-label={`${event.title}, ${event.allDay ? 'all day' : range(event.start, event.end, zone, date)}`}
                  onClick={(click) => calendarUi.open({ kind: 'event', event, anchor: anchorOf(click.currentTarget) })}
                >
                  <span class="schedule-time">{event.allDay ? 'All day' : range(event.start, event.end, zone, date)}</span>
                  <span class="chip-dot" aria-hidden="true" />
                  <span class="schedule-title">{event.title}</span>
                  {event.location && <span class="schedule-where muted">{event.location}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {current && dates.length === 0 && <p class="empty schedule-empty">No events match "{query}" from a year ago to two years ahead.</p>}
      {current?.more && <p class="hint schedule-empty">Google found more than this; add a word to narrow the search.</p>}
    </div>
  );
};
