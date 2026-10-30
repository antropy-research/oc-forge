// What a URL pasted alone into a new task's title is, as Sunsama's "Add via
// URL" recognizes one (https://help.sunsama.com/docs/usage-guides/tasks/add-via-url):
// an item of a connected tool, imported as a task linked to it (a Linear
// issue, a GitHub issue or pull request, a Gmail message), or any other page,
// a task with that page as its backlink. A Google Calendar event, which
// Sunsama links as a page, the Planner looks up and plans as "Plan as task"
// does.
import { parseGitHubUrl } from './github.ts';
import { parseLinearUrl } from './linear.ts';

export type PastedUrl =
  | { kind: 'linear'; key: string; urlKey: string }
  | { kind: 'github'; item: 'issue' | 'pull'; key: string; url: string }
  /** Gmail's own links (`#inbox/FMfcgz…`) are opaque to other apps: `thread` and `message` are null then. */
  | { kind: 'gmail'; thread: string | null; message: string | null; account: string | null; url: string }
  | { kind: 'gcal'; eventId: string; calendarId: string; url: string }
  | { kind: 'link'; url: string; host: string; title: string };

/** A decimal id of Gmail's (`thread-f:`, `msg-f:`), as the API's hex one. */
const hexOf = (decimal: string): string => BigInt(decimal).toString(16);

/**
 * A Gmail message's address: the thread or message the API knows it by, when the address has it (Gmail's legacy
 * view, `#inbox/<16 hex>` or `?th=`, and a printed or "Show original" message's `thread-f:` / `msg-f:` ids); the
 * account in it (`authuser`), when it says.
 */
export const parseGmailUrl = (text: string): Extract<PastedUrl, { kind: 'gmail' }> | null => {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return null;
  // The account, when the address names it: `?authuser=` or `/mail/u/<address>/` (as the Planner's own links to Gmail do).
  const named = url.searchParams.get('authuser') ?? (() => {
    try {
      return /^\/mail\/u\/([^/]+)\//.exec(decodeURIComponent(url.pathname))?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  const account = named && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(named) ? named.toLowerCase() : null;
  const decoded = decodeURIComponent(text);
  const thread = /thread-f:(\d{10,20})/.exec(decoded)?.[1];
  const message = /msg-f:(\d{10,20})/.exec(decoded)?.[1];
  if (thread || message) return { kind: 'gmail', thread: thread ? hexOf(thread) : null, message: message ? hexOf(message) : null, account, url: url.href };
  const legacy = /\/([0-9a-f]{16})(?:[/?]|$)/i.exec(url.hash)?.[1] ?? (/^[0-9a-f]{16}$/i.test(url.searchParams.get('th') ?? '') ? url.searchParams.get('th') : null);
  if (legacy) return { kind: 'gmail', thread: legacy.toLowerCase(), message: null, account, url: url.href };
  // A message Gmail opened (`#inbox/FMfcgz…`): its token is encrypted for the account, so no other app can read it.
  if (/^#[^/]+(\/[^/]+)*\/[A-Za-z0-9_-]{16,}$/.test(url.hash)) return { kind: 'gmail', thread: null, message: null, account, url: url.href };
  return null;
};

/** Google Calendar's short forms of a calendar's address in an event's `eid`. */
const CALENDAR_SUFFIXES: readonly [string, string][] = [
  ['@m', '@gmail.com'],
  ['@g', '@group.calendar.google.com'],
  ['@v', '@group.v.calendar.google.com'],
];

/**
 * A Google Calendar event's address (`…/calendar/event?eid=…`, `…/r/eventedit/<eid>`): its `eid` is the event's id
 * and its calendar's, base64 encoded; null for any other page.
 */
export const parseCalendarUrl = (text: string): Extract<PastedUrl, { kind: 'gcal' }> | null => {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const google = url.hostname === 'calendar.google.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar'));
  if (url.protocol !== 'https:' || !google) return null;
  const eid = url.searchParams.get('eid') ?? /\/(?:eventedit|event)\/([A-Za-z0-9_-]{8,})/.exec(url.pathname)?.[1];
  if (!eid) return null;
  let decoded: string;
  try {
    const base64 = eid.replace(/-/g, '+').replace(/_/g, '/');
    decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
  const [eventId, calendar] = decoded.split(' ');
  if (!eventId || !/^[A-Za-z0-9_]{5,1024}$/.test(eventId) || !calendar || !/^[^\s@]+@[^\s@]+$/.test(calendar)) return null;
  const short = CALENDAR_SUFFIXES.find(([suffix]) => calendar.endsWith(suffix));
  return { kind: 'gcal', eventId, calendarId: short ? `${calendar.slice(0, -short[0].length)}${short[1]}` : calendar, url: url.href };
};

/** A page's title from its address, as no page is fetched: "help.sunsama.com › docs › integrations › github". */
export const linkTitle = (url: URL): string => {
  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const title = [host, ...parts].join(' › ');
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
};

/** A URL pasted alone as a new task's title (nothing else in it); null for any other title. */
export const pastedUrl = (title: string): PastedUrl | null => {
  const text = title.trim();
  if (!/^https?:\/\/\S+$/i.test(text) || text.length > 2000) return null;
  const linear = parseLinearUrl(text);
  if (linear) return { kind: 'linear', ...linear };
  const github = parseGitHubUrl(text);
  if (github) return { kind: 'github', item: github.kind, key: github.key, url: github.url };
  const gmail = parseGmailUrl(text);
  if (gmail) return gmail;
  const event = parseCalendarUrl(text);
  if (event) return event;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return { kind: 'link', url: url.href, host: url.hostname.replace(/^www\./, ''), title: linkTitle(url) };
};
