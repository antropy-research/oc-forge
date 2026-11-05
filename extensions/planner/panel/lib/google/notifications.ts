// Google Calendar's task notifications, from the Planner (Google gets no time
// or deadline the Planner keeps): while a Planner surface is open and its
// window shown (the rail panel or its Work Status section), it asks
// the service for the ones come by now, at the next one's time, soon after a
// change here and at least every 30 seconds, and shows each as an OpenChamber
// notification that stays until it is dismissed, as Google Calendar's alerts
// do. The service gives each one once, to whichever surface asks first, and
// lends it until that surface says it showed it: a frame that goes before
// (the Work Status card hides while the right panel opens) loses none.
import type { HostClient } from '@openchamber/sdk';
import { notificationMessage, type TaskNotification } from '../../../src/domain/google/taskNotify.ts';
import type { PlannerClient } from '../core/client.ts';

/** Surfaces that show them: not the hidden frame that answers actions and commands. */
const SURFACES = new Set(['panel', 'status']);
/** At least this often, for tasks changed elsewhere (Google's own apps, another window); Google is read at most every 90 s. */
const EVERY_MS = 30_000;
/** Soon after a change here, which may have set a time a minute away. */
const AFTER_CHANGE_MS = 1500;
/** At most this many at once; the rest are counted in one more. */
const SHOWN_AT_ONCE = 3;

export const startTaskNotifications = (host: HostClient, client: PlannerClient, surface: string): (() => void) => {
  if (!SURFACES.has(surface)) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let asking = false;
  let stopped = false;
  const later = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = stopped ? null : setTimeout(() => void ask(), Math.max(250, ms));
  };
  /** Shows them; true when OpenChamber took every one. */
  const show = async (items: readonly TaskNotification[]): Promise<boolean> => {
    let shown = true;
    const toast = (message: string) => host.toast({ kind: 'info', message, persistent: true }).catch(() => {
      shown = false;
    });
    for (const item of items.slice(0, SHOWN_AT_ONCE)) await toast(notificationMessage(item));
    const more = items.length - SHOWN_AT_ONCE;
    if (more > 0) await toast(`${more} more task notification${more === 1 ? '' : 's'} today: see the Planner's calendar`);
    return shown;
  };
  const ask = async () => {
    // A hidden window shows nothing: the ones due wait for it (or for another window) to be shown.
    if (stopped || asking || document.hidden) return;
    asking = true;
    const asked = Date.now();
    // By the service's clock: the browser's may be off.
    let nextIn: number | null = null;
    try {
      const answer = await client.call<{ notifications?: TaskNotification[]; nextIn?: number | null }>('POST', '/google/tasks/notifications');
      nextIn = typeof answer.nextIn === 'number' ? answer.nextIn - (Date.now() - asked) : null;
      // Shown: given for good. Not shown, or never said, they come to the next surface that asks once the loan ends.
      if (answer.notifications?.length && await show(answer.notifications)) {
        await client.call('POST', '/google/tasks/notifications/ack', { keys: answer.notifications.map((item) => item.key) }).catch(() => {});
      }
    } catch {
      // The service is starting, or Google is out of reach: ask again in a minute.
    } finally {
      asking = false;
    }
    later(Math.min(EVERY_MS, nextIn === null ? EVERY_MS : nextIn + 200));
  };
  const onVisible = () => !document.hidden && later(0);
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = client.onCommitted(() => later(AFTER_CHANGE_MS));
  later(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribe();
  };
};
