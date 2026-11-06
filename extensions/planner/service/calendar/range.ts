// The events of a range of days from every calendar of the plan (ICS feeds and Google calendars) with the Google tasks
// due then: what the Calendar shows, and what Ask Planner's agent reads of a day.
import type { Context } from '../context.ts';
import { addDays, instantAt } from '../../src/domain/core/dates.ts';
import type { DateKey } from '../../src/domain/core/types.ts';
import { messageOf } from '../../src/domain/core/values.ts';
import { GOOGLE_TASKS_CALENDAR, dueTaskEvent } from '../../src/domain/google/google.ts';
import { deadlineGroups } from '../../src/domain/google/taskKept.ts';

/** The range's events, the tasks whose deadline falls in it, what failed, and the sessions to follow up in Google. */
export const readCalendar = async (ctx: Context, from: DateKey, to: DateKey, refresh: boolean) => {
  const { planner, feeds, google, googleCalendars, googleDueTasks, timeboxes } = ctx;
  const zone = ctx.zone();
  const calendars = Object.values(planner.state.calendars);
  // Google calendars are read through their accounts; the rest are ICS feeds.
  const timeMin = instantAt(from, 0, zone);
  const timeMax = instantAt(addDays(to, 1), 0, zone);
  // Google tasks due in the range show on their day, as in Google Calendar, planned or not (the panel shows the link).
  const shownAccounts = planner.state.settings.googleTasksOnCalendar ? await google.emailsWith('tasks') : [];
  const [feed, fromGoogle, due, deadlines] = await Promise.all([
    feeds.eventsFor(calendars.filter((calendar) => !calendar.google), from, to, zone, refresh),
    googleCalendars.read(calendars, timeboxes.calendarsFor(planner.state, timeMin, timeMax), timeMin, timeMax, zone, refresh),
    googleDueTasks.read(shownAccounts, from, to, refresh),
    // Tasks whose deadline (kept in the Planner) falls in the range show it there, as Google Calendar does, dated or not.
    googleDueTasks.byIds(deadlineGroups(planner.state.googleTasks, shownAccounts, from, to), refresh),
  ]);
  const dueEvents = due.items.flatMap((item) => (item.due ? [dueTaskEvent({ ...item, due: item.due }, zone)] : []));
  return {
    events: [...feed.events, ...fromGoogle.events, ...dueEvents].sort((a, b) => a.start.localeCompare(b.start)),
    deadlineTasks: deadlines.items,
    errors: [...feed.errors, ...fromGoogle.errors, ...[...due.errors, ...deadlines.errors].map((message) => ({ calendarId: GOOGLE_TASKS_CALENDAR, message }))],
    /** Sessions moved or deleted in Google follow; run once the answer is on its way. */
    reconcile: (): void => {
      if (fromGoogle.reads.size) void timeboxes.reconcile(fromGoogle.reads, timeMin, timeMax).catch((error) => ctx.log(`Google Calendar: ${messageOf(error)}`));
    },
  };
};
