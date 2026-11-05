// The calendar's routes: the events of a range of days from every calendar of the plan (ICS feeds and Google
// calendars) with the Google tasks due then, Google Calendar's search, and Sunsama's meeting import, run now.
import { addDays, daysBetween, instantAt, isDateKey, todayIn } from '../../src/domain/core/dates.ts';
import { messageOf } from '../../src/domain/core/values.ts';
import { GOOGLE_TASKS_CALENDAR, dueTaskEvent } from '../../src/domain/google/google.ts';
import { deadlineGroups } from '../../src/domain/google/taskKept.ts';
import { bad, ok, type Route } from '../http.ts';

export const calendarRoute: Route = async (ctx, req, url) => {
  const { planner, feeds, google, googleData, googleCalendars, googleDueTasks, timeboxes } = ctx;
  if (url.pathname === '/calendar' && req.method === 'GET') {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isDateKey(from) || !isDateKey(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 62) return bad('from and to must be dates at most 62 days apart');
    const zone = ctx.zone();
    const refresh = url.searchParams.get('refresh') === '1';
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
    const answer = {
      events: [...feed.events, ...fromGoogle.events, ...dueEvents].sort((a, b) => a.start.localeCompare(b.start)),
      deadlineTasks: deadlines.items,
      errors: [...feed.errors, ...fromGoogle.errors, ...[...due.errors, ...deadlines.errors].map((message) => ({ calendarId: GOOGLE_TASKS_CALENDAR, message }))],
    };
    // Sessions moved or deleted in Google follow, once the answer is on its way.
    return ok(answer, () => {
      if (fromGoogle.reads.size) void timeboxes.reconcile(fromGoogle.reads, timeMin, timeMax).catch((error) => ctx.log(`Google Calendar: ${messageOf(error)}`));
    });
  }
  // Google Calendar's search: the calendars shown, a year back and two ahead, in date order.
  if (url.pathname === '/calendar/search' && req.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query || query.length > 200) return bad('q must be 1-200 characters');
    const zone = ctx.zone();
    const today = todayIn(zone);
    const [from, to] = [addDays(today, -366), addDays(today, 731)];
    const [timeMin, timeMax] = [instantAt(from, 0, zone), instantAt(addDays(to, 1), 0, zone)];
    const shown = Object.values(planner.state.calendars).filter((calendar) => calendar.visible);
    const needle = query.toLocaleLowerCase();
    const errors: { calendarId: string; message: string }[] = [];
    let more = false;
    const [feed, ...fromGoogle] = await Promise.all([
      feeds.eventsFor(shown.filter((calendar) => !calendar.google), from, to, zone),
      ...shown.filter((calendar) => calendar.google).map((calendar) =>
        googleData.searchEvents(calendar.google!.account, calendar.google!.calendarId, query, timeMin, timeMax, zone, calendar.id).catch((error) => {
          errors.push({ calendarId: calendar.id, message: messageOf(error) });
          return { events: [], more: false };
        }),
      ),
    ]);
    errors.push(...feed.errors);
    const events = feed.events.filter((event) => `${event.title}\n${event.location}`.toLocaleLowerCase().includes(needle));
    for (const found of fromGoogle) {
      events.push(...found.events);
      more ||= found.more;
    }
    return ok({ events: events.sort((a, b) => a.start.localeCompare(b.start)), from, to, more, errors });
  }
  if (url.pathname === '/meetings/sync' && req.method === 'POST') {
    // A meeting-import setting changed (or a check asks): ended meetings completed, auto-sync's applied now.
    return ok(await ctx.meetings.run());
  }
  return null;
};
