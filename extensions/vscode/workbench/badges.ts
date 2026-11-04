// VS Code's activity badges on OpenChamber's rail icons (pre-review row 14): Source Control's count of changes, the
// Extensions view's updates, an installed extension's own count, as VS Code's activity bar shows them on its view
// containers. Each part counts what its workbench sees and sends all of it when it changes (`forge.rail.setBadges`);
// the rail shows each entry's count from the part that saw it change last, so a part that is behind (VS Code
// refreshes a part's Source Control while it has the focus) doesn't bring back its old count.
import type { OcForgeClient } from '../../../adapters/openchamber/client/index.ts';
import type { RailEntry } from '../src/rail.ts';
import type { Activity, ActivityService, VscodeServices } from './vscode.ts';

/** How often the rail's entries are read again for the containers they show (extensions come and go). */
const ENTRIES_MS = 30_000;
/** Activities change in bursts (a Git refresh): one send for each burst. */
const SETTLE_MS = 250;

/**
 * The count VS Code's activity bar shows on a view container: the number of its first activity that has one (a
 * `NumberBadge`, whose `number` is the class's own field, README "Which VS Code internals the frames use"). An icon or
 * a progress badge shows no count.
 */
export const countOf = (activities: readonly Activity[]): number => {
  for (const activity of activities) {
    const count = (activity.badge as { number?: unknown } | undefined)?.number;
    if (typeof count === 'number' && Number.isInteger(count) && count > 0) return count;
  }
  return 0;
};

/** The count on each rail entry that shows a view container of its own (not "Additional Views", not the bottom's). */
export const countsOf = (entries: readonly RailEntry[], activitiesOf: (view: string) => readonly Activity[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.zone || !entry.view) continue;
    const count = countOf(activitiesOf(entry.view));
    if (count > 0) counts[entry.id] = count;
  }
  return counts;
};

export const feedRailBadges = (forge: OcForgeClient, services: VscodeServices, railEntries: () => Promise<RailEntry[]>): void => {
  if (!forge.has('rail-badge')) return;
  const activity = services.get<ActivityService>('activityService');
  let entries: RailEntry[] = [];
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The user came to this part: what it counts is the current view (VS Code refreshes its Git while it has the focus). */
  let fresh = false;
  const send = (): void => {
    timer = null;
    const counts = countsOf(entries, (view) => activity.getViewContainerActivities(view));
    const text = JSON.stringify(counts);
    if (text === sent && !fresh) return;
    sent = text;
    const options = fresh ? { fresh: true } : {};
    fresh = false;
    // Sent again with the next change when the host didn't take it.
    forge.rail.setBadges(counts, options).catch(() => {
      sent = null;
    });
  };
  const soon = (): void => {
    timer ??= setTimeout(send, SETTLE_MS);
  };
  activity.onDidChangeActivity(soon);
  window.addEventListener('focus', () => {
    fresh = true;
    soon();
  });
  const read = async (): Promise<void> => {
    entries = await railEntries().catch(() => entries);
    soon();
  };
  void read();
  setInterval(() => void read(), ENTRIES_MS);
};
