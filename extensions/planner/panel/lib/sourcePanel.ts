// The source panel's state, shared by Home and Today and the keys that open it: which source is open, the calendar
// under a source's list, and a day asked for by its name (Sunsama's right-hand panel).
import { useEffect, useState } from 'preact/hooks';
import type { DateKey } from '../../src/domain/types.ts';

export type SourceId = 'calendar' | 'backlog' | 'linear' | 'github' | 'mail' | 'tasks';

/** What the panel shows, the same on Home and Today: a source, or nothing (only the rail). */
interface PanelState {
  open: SourceId | null;
  last: SourceId;
  /** The calendar under a source's list, to drop items straight onto a time. */
  split: boolean;
  /** A day asked for by its name at the top of its list (Sunsama's), and when. */
  day: { date: DateKey; at: number } | null;
}

let shared: PanelState = { open: 'calendar', last: 'calendar', split: false, day: null };
const listeners = new Set<() => void>();
export const setShared = (patch: Partial<PanelState>) => {
  shared = { ...shared, ...patch, ...(patch.open ? { last: patch.open } : {}) };
  for (const listener of listeners) listener();
};

/** Open a source in the panel (Sunsama's Shift C for the calendar, Shift G for Gmail). */
export const openSource = (id: SourceId): void => setShared({ open: id });

/** Show a day's calendar in the panel: Sunsama's click on the name of a date at the top of its task list. */
export const showCalendarDay = (date: DateKey): void => setShared({ open: 'calendar', day: { date, at: Date.now() } });

export const usePanel = (): PanelState => {
  const [state, setState] = useState(shared);
  useEffect(() => {
    const listener = () => setState(shared);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return state;
};
