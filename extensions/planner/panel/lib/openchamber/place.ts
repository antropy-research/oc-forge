// Which page the whole Planner shows, kept in this browser's storage for the extension. OpenChamber loads the rail
// panel's frame anew in a folder whose panel has not had it yet: the frame starts on the page the user was on, not on
// Home, so the Planner shows the same thing in every chat. A task's or an issue's details open over it are not
// brought back: a window that opens by itself after a switch or a reload is more surprise than help.
import type { HostClient } from '@openchamber/sdk';
import { parseRoute, routeOf, type PlannerPlace } from './deepLink.ts';

const PLACE_KEY = 'planner.place';
const DEVICE = { scope: 'device' } as const;
/** A storage that does not answer does not hold the Planner back. */
const READ_MS = 1500;

/** The page kept last, as a place, or null (none, unreadable, or storage too slow). */
export const readPlace = (host: HostClient): Promise<PlannerPlace | null> => Promise.race([
  host.storage.get(PLACE_KEY, DEVICE).then((value) => {
    const place = typeof value === 'string' ? parseRoute(value) : null;
    return place ? { page: place.page } : null;
  }, () => null),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_MS)),
]);

export const savePlace = (host: HostClient, place: PlannerPlace): void => {
  void host.storage.set(PLACE_KEY, routeOf({ page: place.page }), DEVICE).catch(() => {});
};
