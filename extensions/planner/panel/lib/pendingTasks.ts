// Google Calendar's Pending tasks in the panel: one read of the open Google
// tasks dated in the past 365 days (the service's /google/tasks/pending),
// shared by every calendar view on screen, read again after the Planner
// changed something in Google (the calendar's tick), when the day changes and
// every ten minutes. A task completed or rescheduled from the list shows so at
// once, until a read begun after the change has it.
import { useEffect, useState } from 'preact/hooks';
import type { GoogleTaskItem } from '../../src/domain/google.ts';
import { pendingTasks } from '../../src/domain/gtaskPending.ts';
import type { DateKey } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';
import { usePlanner, useView } from './context.ts';
import { useCalendarUi } from './gcal.ts';

const REFRESH_MS = 10 * 60_000;

interface PendingView {
  items: GoogleTaskItem[];
  /** The day they are pending on, as the service read them. */
  today: DateKey | null;
  error: string | null;
}

const keyOf = (item: Pick<GoogleTaskItem, 'account' | 'id'>): string => `${item.account}\n${item.id}`;

class PendingStore {
  private view: PendingView = { items: [], today: null, error: null };
  private readonly listeners = new Set<() => void>();
  /** The read asked for last (its day and the calendar's tick), so views on screen together share it. */
  private asked: string | null = null;
  private reads = 0;
  /** Changes made here, by task: the task as it is now (null: done), and when. */
  private readonly changes = new Map<string, { item: GoogleTaskItem | null; at: number }>();

  get = (): PendingView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Read them for `today` unless this read (`today` at `tick`) was asked for already; `force` reads anyway, past the service's cache. */
  load(client: PlannerClient, today: DateKey, tick: number, force = false): void {
    const asked = `${today}\n${tick}`;
    if (!force && this.asked === asked) return;
    this.asked = asked;
    const read = ++this.reads;
    const startedAt = Date.now();
    client
      .call<{ tasks: GoogleTaskItem[]; today: DateKey; errors?: string[] }>('GET', `/google/tasks/pending${force ? '?refresh=1' : ''}`)
      .then((answer) => {
        if (read !== this.reads) return;
        for (const [key, change] of this.changes) if (change.at < startedAt) this.changes.delete(key);
        this.set({ items: answer.tasks ?? [], today: answer.today ?? today, error: answer.errors?.length ? answer.errors.join('; ') : null });
      })
      .catch((error) => {
        if (read === this.reads) this.set({ error: error instanceof Error ? error.message : String(error) });
      });
  }

  /**
   * A task changed from the list: as it is now (a new date), or done (null); shown so at once. Said again once
   * Google has it, so only a read begun after that replaces it.
   */
  change(item: GoogleTaskItem, now: GoogleTaskItem | null): void {
    this.changes.set(keyOf(item), { item: now, at: Date.now() });
    this.set({});
  }

  /** A change Google refused: the task shows as it was. */
  forget(item: GoogleTaskItem): void {
    if (this.changes.delete(keyOf(item))) this.set({});
  }

  /** The pending tasks on `today`, with the changes made here. */
  pending(today: DateKey): GoogleTaskItem[] {
    const items = this.view.items.flatMap((item) => {
      const change = this.changes.get(keyOf(item));
      return change ? (change.item ? [change.item] : []) : [item];
    });
    return pendingTasks(items, today);
  }

  private set(patch: Partial<PendingView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const pendingStore = new PendingStore();

/** The pending tasks while `enabled` (Google tasks shown on the calendar), read as the calendar changes. */
export const usePendingTasks = (enabled: boolean): GoogleTaskItem[] => {
  const { client } = usePlanner();
  const view = useView();
  const ui = useCalendarUi();
  const [, setVersion] = useState(0);
  useEffect(() => pendingStore.subscribe(() => setVersion((version) => version + 1)), []);
  useEffect(() => {
    if (enabled) pendingStore.load(client, view.today, ui.tick);
  }, [client, enabled, view.today, ui.tick, view.state.settings.timezone]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => !document.hidden && pendingStore.load(client, view.today, ui.tick, true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [client, enabled, view.today, ui.tick]);
  return enabled ? pendingStore.pending(view.today) : [];
};
