// The day's GitHub work for Daily Highlights' "Other activities", read from the service: the first page of every
// source together, then each source with more, a page at a time, until it ends or MAX_ACTIVITY_PAGES more pages were
// read (the section then says where GitHub has the rest). Kept a few minutes per day, so going back to a day is quick.
import { useEffect, useState } from 'preact/hooks';
import { ACTIVITY_SOURCES, type ActivityPage, type ActivitySource, type GitHubActivity } from '../../src/domain/githubActivity.ts';
import { addDays, instantAt } from '../../src/domain/dates.ts';
import type { DateKey } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';

/** Pages of one source read after its first; past them GitHub has the rest. */
export const MAX_ACTIVITY_PAGES = 10;
const KEEP_MS = 5 * 60_000;

export interface ActivityRead {
  login: string;
  items: GitHubActivity[];
  /** Sources with more left than the Planner read. */
  cut: ActivitySource[];
  /** How many a search found in all. */
  totals: ActivityPage['totals'];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const path = (from: string, to: string, page?: { source: ActivitySource; after: string }): string =>
  `/github/activity?${new URLSearchParams({ from, to, ...(page ? { source: page.source, after: page.after } : {}) })}`;

/** The day [from, to): every source to its end, or to its bound of pages. */
export const readGitHubActivity = async (client: Pick<PlannerClient, 'call'>, from: string, to: string): Promise<ActivityRead> => {
  const first = await client.call<ActivityPage>('GET', path(from, to));
  const items = [...first.items];
  const totals = { ...first.totals };
  const cut: ActivitySource[] = [];
  await Promise.all(
    ACTIVITY_SOURCES.filter((source) => first.more[source] !== undefined).map(async (source) => {
      let after = first.more[source];
      for (let pages = 0; after !== undefined && pages < MAX_ACTIVITY_PAGES; pages++) {
        const next = await client.call<ActivityPage>('GET', path(from, to, { source, after }));
        items.push(...next.items);
        if (next.totals[source] !== undefined) totals[source] = next.totals[source];
        after = next.more[source];
      }
      if (after !== undefined) cut.push(source);
    }),
  );
  return { login: first.login, items, cut: ACTIVITY_SOURCES.filter((source) => cut.includes(source)), totals };
};

const kept = new Map<string, { at: number; read: ActivityRead }>();
/** Each day's latest read asked for: one asked before it (a Refresh's, a day gone back to) answering last is not kept. */
const asking = new Map<string, number>();
let asks = 0;

/** A day's activity, kept a few minutes for going back to it, unless the day was asked for again meanwhile. */
export const readAndKeep = async (client: Pick<PlannerClient, 'call'>, key: string, from: string, to: string): Promise<ActivityRead> => {
  const ask = ++asks;
  asking.set(key, ask);
  const read = await readGitHubActivity(client, from, to);
  if (asking.get(key) === ask) kept.set(key, { at: Date.now(), read });
  return read;
};

/** What `readAndKeep` kept of a day, while it is fresh. */
export const keptRead = (key: string): ActivityRead | null => {
  const entry = kept.get(key);
  return entry && Date.now() - entry.at < KEEP_MS ? entry.read : null;
};

export interface ActivityState {
  loading: boolean;
  read: ActivityRead | null;
  error: string | null;
  /** Read the day again from GitHub. */
  refresh: () => void;
}

/** A day's GitHub work in `zone`, read while `enabled` (GitHub is connected). */
export const useGitHubActivity = (client: Pick<PlannerClient, 'call'>, date: DateKey, zone: string, enabled: boolean): ActivityState => {
  const key = `${date}|${zone}`;
  const fresh = () => keptRead(key);
  const [state, setState] = useState<{ key: string; loading: boolean; read: ActivityRead | null; error: string | null }>(() => ({ key, loading: false, read: fresh(), error: null }));
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const known = asked === 0 ? fresh() : null;
    if (known) {
      setState({ key, loading: false, read: known, error: null });
      return;
    }
    let live = true;
    // Another day's activity never shows under this one while it loads.
    setState((current) => ({ key, loading: true, read: current.key === key ? current.read : null, error: null }));
    readAndKeep(client, key, instantAt(date, 0, zone), instantAt(addDays(date, 1), 0, zone))
      .then((read) => {
        if (live) setState({ key, loading: false, read, error: null });
      })
      .catch((error) => {
        if (live) setState((current) => ({ key, loading: false, read: current.key === key ? current.read : null, error: messageOf(error) }));
      });
    return () => {
      live = false;
    };
  }, [key, enabled, asked]);
  const mine = state.key === key ? state : { loading: enabled, read: null, error: null };
  return { loading: mine.loading, read: mine.read, error: mine.error, refresh: () => setAsked((count) => count + 1) };
};
