// The calendar's routes: the events of a range of days from every calendar of the plan (ICS feeds and Google
// calendars) with the Google tasks due then, Google Calendar's search, and Sunsama's meeting import, run now.
import { addDays, daysBetween, instantAt, isDateKey, todayIn } from '../../src/domain/core/dates.ts';
import { messageOf } from '../../src/domain/core/values.ts';
import { readCalendar } from '../calendar/range.ts';
import { bad, ok, type Route } from '../http.ts';

export const calendarRoute: Route = async (ctx, req, url) => {
  const { planner, feeds, googleData } = ctx;
  if (url.pathname === '/calendar' && req.method === 'GET') {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isDateKey(from) || !isDateKey(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 62) return bad('from and to must be dates at most 62 days apart');
    const { events, deadlineTasks, errors, reconcile } = await readCalendar(ctx, from, to, url.searchParams.get('refresh') === '1');
    // Sessions moved or deleted in Google follow, once the answer is on its way.
    return ok({ events, deadlineTasks, errors }, reconcile);
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
