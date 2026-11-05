// The Google store's calendars (one of its parts, store.ts): Google calendars shown beside the plan, each a calendar
// subscription the service reads through its account, shown or hidden as Google Calendar's checkbox does; an
// account's own calendar shown the first time the Planner sees it; the calendar working sessions go to; and the
// calendars of accounts that are gone, dropped.
import type { EventBody } from '../../../src/domain/core/events.ts';
import { newId } from '../../../src/domain/core/ids.ts';
import type { CalendarSubscription, PlannerState } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleCalendarInfo } from '../../../src/domain/google/google.ts';
import type { GoogleStore } from './store.ts';

/** Where a Google calendar opens on the web; the Planner reads it through the account, not from here. */
const calendarWebUrl = (calendarId: string): string => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}`;

/** The plan's subscriptions to a Google calendar. */
const subscriptionsOf = (state: PlannerState, calendar: GoogleCalendarInfo): CalendarSubscription[] =>
  Object.values(state.calendars).filter((item) => item.google?.account === calendar.account && item.google.calendarId === calendar.id);

/**
 * Google Calendar shows your own calendar from the start: the first time the
 * Planner sees an account's calendars, its primary calendar is shown, unless
 * one of that account's calendars already is. Once per account, so a calendar
 * hidden or removed later stays as the user left it.
 */
const introduce = async (google: GoogleStore, calendars: readonly GoogleCalendarInfo[]): Promise<void> => {
  const state = google.client.getView().state;
  const seen = state.settings.googleCalendarsIntroduced ?? [];
  const accounts = [...new Set(calendars.map((calendar) => calendar.account))].filter((account) => !seen.includes(account));
  if (!accounts.length) return;
  for (const account of accounts) {
    const shown = Object.values(state.calendars).some((item) => item.google?.account === account);
    const primary = calendars.find((calendar) => calendar.account === account && calendar.primary);
    if (!shown && primary) await google.showCalendar(primary, true);
  }
  await google.client.dispatch([{ type: 'settings.updated', patch: { googleCalendarsIntroduced: [...seen, ...accounts].slice(-50) } }]);
};

export const calendarMethods = {
  async loadCalendars(): Promise<void> {
    try {
      const answer = await this.client.call<{ calendars: GoogleCalendarInfo[]; errors: { account: string; message: string }[] }>('GET', '/google/calendars');
      this.set({ calendars: answer.calendars, calendarErrors: answer.errors });
      this.introductions = this.introductions.then(() => introduce(this, answer.calendars)).catch(() => {});
      await this.introductions;
    } catch (error) {
      this.set({ calendarErrors: [{ account: '', message: messageOf(error) }] });
    }
  },

  /** Show a Google calendar beside the plan (a calendar subscription read through its account), or stop. */
  showCalendar(calendar: GoogleCalendarInfo, show: boolean): Promise<void> {
    const existing = subscriptionsOf(this.client.getView().state, calendar);
    if (!show) return this.client.dispatch(existing.map((item) => ({ type: 'calendar.removed' as const, calendarId: item.id })));
    if (existing.length) return this.client.dispatch(existing.filter((item) => !item.visible).map((item) => ({ type: 'calendar.updated' as const, calendarId: item.id, patch: { visible: true } })));
    return this.client.dispatch([
      { type: 'calendar.added', calendar: { id: newId(), name: calendar.name.slice(0, 80) || 'Google Calendar', url: calendarWebUrl(calendar.id), color: calendar.color, google: { account: calendar.account, calendarId: calendar.id } } },
    ]);
  },

  /**
   * Google Calendar's checkbox beside a calendar: shown or hidden, keeping its
   * color; a Google calendar not shown before is added.
   */
  setVisible(calendar: GoogleCalendarInfo | CalendarSubscription, visible: boolean): Promise<void> {
    if ('visible' in calendar) return this.client.dispatch([{ type: 'calendar.updated', calendarId: calendar.id, patch: { visible } }]);
    const existing = subscriptionsOf(this.client.getView().state, calendar);
    if (existing.length) return this.client.dispatch(existing.filter((item) => item.visible !== visible).map((item) => ({ type: 'calendar.updated' as const, calendarId: item.id, patch: { visible } })));
    return visible ? this.showCalendar(calendar, true) : Promise.resolve();
  },

  setTimeboxCalendar(target: { account: string; calendarId: string } | null): Promise<void> {
    return this.client.dispatch([{ type: 'settings.updated', patch: { googleTimebox: target } }]);
  },

  /** Drop the calendars (and the session calendar) of accounts that are gone. */
  async forgetCalendars(gone: (account: string) => boolean): Promise<void> {
    const state = this.client.getView().state;
    const bodies: EventBody[] = Object.values(state.calendars)
      .filter((calendar) => calendar.google && gone(calendar.google.account))
      .map((calendar) => ({ type: 'calendar.removed', calendarId: calendar.id }));
    if (state.settings.googleTimebox && gone(state.settings.googleTimebox.account)) bodies.push({ type: 'settings.updated', patch: { googleTimebox: null } });
    const channels = Object.entries(state.settings.channelTimebox).filter(([, target]) => !gone(target.account));
    if (channels.length !== Object.keys(state.settings.channelTimebox).length) bodies.push({ type: 'settings.updated', patch: { channelTimebox: Object.fromEntries(channels) } });
    if (bodies.length) await this.client.dispatch(bodies);
  },
} satisfies ThisType<GoogleStore>;
