import { useEffect, useState } from 'preact/hooks';
import type { CalendarEvent } from '../../src/domain/ics.ts';
import type { DateKey } from '../../src/domain/types.ts';
import { usePlanner, useView } from './context.ts';

export interface CalendarFeedState {
  events: CalendarEvent[];
  errors: { calendarId: string; message: string }[];
  loading: boolean;
}

const REFRESH_MS = 10 * 60_000;

/** Subscribed-calendar occurrences for [from, to]; refetches when the range or the subscriptions change. */
export const useCalendarEvents = (from: DateKey, to: DateKey): CalendarFeedState => {
  const { client } = usePlanner();
  const view = useView();
  const [feed, setFeed] = useState<CalendarFeedState>({ events: [], errors: [], loading: false });
  const calendars = view.state.calendars;
  const signature = Object.values(calendars).map((calendar) => `${calendar.id}:${calendar.url}:${calendar.visible}`).join('|');

  useEffect(() => {
    if (!signature) {
      setFeed({ events: [], errors: [], loading: false });
      return;
    }
    let live = true;
    const load = (refresh: boolean) => {
      setFeed((current) => ({ ...current, loading: true }));
      client
        .calendarEvents(from, to, refresh)
        .then((result) => live && setFeed({ ...result, loading: false }))
        .catch((error) => live && setFeed({ events: [], errors: [{ calendarId: '*', message: error instanceof Error ? error.message : String(error) }], loading: false }));
    };
    load(false);
    const timer = setInterval(() => load(true), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, from, to, signature, view.state.settings.timezone]);
  return feed;
};
