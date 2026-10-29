import { useEffect, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { GoogleTaskItem } from '../../src/domain/google.ts';
import type { DateKey } from '../../src/domain/types.ts';
import { addDays, instantAt } from '../../src/domain/dates.ts';
import { deadlineEvents, upcomingEvent, upcomingTasks, withTaskTimes } from '../../src/domain/gtaskKept.ts';
import { pendingEvent } from '../../src/domain/gtaskPending.ts';
import { useGoogle, usePlanner, useView } from './context.ts';
import { calendarUi, useCalendarUi, withPending } from './gcal.ts';
import { usePendingTasks } from './pendingTasks.ts';

export interface CalendarFeedState {
  events: CalendarEvent[];
  /** Google tasks read for a deadline in the range (their date may be outside it, or none). */
  deadlineTasks?: GoogleTaskItem[];
  errors: { calendarId: string; message: string }[];
  loading: boolean;
}

const REFRESH_MS = 10 * 60_000;

/**
 * Subscribed-calendar occurrences and Google tasks due in [from, to]; refetches
 * when the range or the subscriptions change, and after the Planner changed
 * something in Google. Changes on their way to Google show at once. Events I
 * declined are left out unless asked for (the calendar views show them). With
 * `tasks`, the calendar's own views also get Google tasks as Google Calendar
 * shows them beside their date: deadlines on their day, the upcoming
 * occurrences of repeating tasks, from what the Planner keeps now, and on
 * today, its "N pending tasks" entry (the open tasks of the past 365 days).
 */
export const useCalendarEvents = (from: DateKey, to: DateKey, options: { declined?: boolean; tasks?: boolean } = {}): CalendarFeedState => {
  const { client, google } = usePlanner();
  const view = useView();
  const ui = useCalendarUi();
  useGoogle();
  const [feed, setFeed] = useState<CalendarFeedState>({ events: [], errors: [], loading: false });
  const calendars = view.state.calendars;
  // Google tasks show on their due day whenever an account with Tasks is connected, subscribed calendars or not.
  const tasks = view.state.settings.googleTasksOnCalendar && google.accountsWith('tasks').length > 0;
  const signature = [...Object.values(calendars).map((calendar) => `${calendar.id}:${calendar.url}:${calendar.visible}`), ...(tasks ? ['google-tasks'] : [])].join('|');

  useEffect(() => {
    if (!signature) {
      setFeed({ events: [], errors: [], loading: false });
      return;
    }
    let live = true;
    const load = (refresh: boolean) => {
      const startedAt = Date.now();
      setFeed((current) => ({ ...current, loading: true }));
      client
        .calendarEvents(from, to, refresh)
        .then((result) => {
          if (!live) return;
          setFeed({ ...result, loading: false });
          calendarUi.settle(startedAt);
        })
        .catch((error) => live && setFeed({ events: [], errors: [{ calendarId: '*', message: error instanceof Error ? error.message : String(error) }], loading: false }));
    };
    load(false);
    const timer = setInterval(() => load(true), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, from, to, signature, view.state.settings.timezone, ui.tick]);

  const zone = view.state.settings.timezone ?? 'UTC';
  const kept = view.state.googleTasks;
  const pending = usePendingTasks(Boolean(options.tasks && tasks) && from <= view.today && view.today <= to);
  // A Google task with a time kept in the Planner shows at that time, as Google Calendar shows timed tasks.
  const timed = withTaskTimes(feed.events, kept, zone);
  const shown = timed.flatMap((event) => (event.googleTask ? [event.googleTask] : []));
  const pendingEntry = pendingEvent(pending, view.today, zone);
  const beside = options.tasks && tasks ? [...deadlineEvents([...shown, ...(feed.deadlineTasks ?? [])], kept ?? {}, from, to, zone), ...upcomingTasks(kept ?? {}, shown, from, to, view.today).map((task) => upcomingEvent(task, zone)), ...(pendingEntry ? [pendingEntry] : [])] : [];
  const events = withPending([...timed, ...beside], ui.pending, ui.added, instantAt(from, 0, zone), instantAt(addDays(to, 1), 0, zone));
  return { ...feed, events: options.declined ? events : events.filter((event) => event.google?.response !== 'declined') };
};
