// Round 12: a URL pasted alone as a new task's title, as Sunsama's "Add via URL" takes it
// (https://help.sunsama.com/docs/usage-guides/tasks/add-via-url): a Linear issue, a GitHub issue or pull request
// (https://help.sunsama.com/docs/integrations/github) and a Gmail message become a task linked to them; a Google
// Calendar event is planned as "Plan as task" plans it; any other page is a task with it as its backlink. Review 11
// found a pasted GitHub issue URL made a task titled with the URL, linked to nothing.
import { describe, expect, test } from 'bun:test';
import type { HostClient } from '@openchamber/sdk';
import { linkTitle, parseCalendarUrl, parseGmailUrl, pastedUrl } from '../src/domain/pastedUrl.ts';
import { addParsedTask, urlHint, type AddSources } from '../panel/lib/addTask.ts';
import { GitHubStore } from '../panel/lib/github.ts';
import { GoogleStore } from '../panel/lib/google.ts';
import type { LinearStore } from '../panel/lib/linear.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { parseQuickAdd } from '../src/domain/quickAdd.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { emptyState, type PlannerState, type Task } from '../src/domain/types.ts';
import type { GitHubItem } from '../src/domain/github.ts';

const ME = 'me@example.com';
const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
const ev = (body: EventBody): PlannerEvent => ({ v: 1, id: `e${(clock += 1000)}`, at: new Date(clock).toISOString(), ...body }) as PlannerEvent;
const eid = (text: string) => btoa(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('what a pasted URL is', () => {
  test('a Linear issue, a GitHub issue or pull request, a Gmail message, a Calendar event, or any page; never a title with other words', () => {
    expect(pastedUrl('https://linear.app/acme/issue/NEX-110/fix-it')).toEqual({ kind: 'linear', key: 'NEX-110', urlKey: 'acme' });
    expect(pastedUrl('https://github.com/acme/app/issues/51')).toEqual({ kind: 'github', item: 'issue', key: 'acme/app#51', url: 'https://github.com/acme/app/issues/51' });
    expect(pastedUrl('https://github.com/acme/app/pull/7#discussion_r1')).toEqual({ kind: 'github', item: 'pull', key: 'acme/app#7', url: 'https://github.com/acme/app/pull/7' });
    expect(pastedUrl('https://help.sunsama.com/docs/integrations/github')).toEqual({ kind: 'link', url: 'https://help.sunsama.com/docs/integrations/github', host: 'help.sunsama.com', title: 'help.sunsama.com › docs › integrations › github' });
    expect(pastedUrl('http://www.example.com/')).toMatchObject({ kind: 'link', host: 'example.com', title: 'example.com' });
    for (const title of ['Read https://github.com/acme/app/issues/51', 'Fix the crash', 'ftp://example.com/x', '']) expect(pastedUrl(title)).toBeNull();
  });

  test("Gmail: the legacy view's thread id, a printed message's thread-f / msg-f ids (as hex), the account it names; Gmail's own links are opaque", () => {
    expect(parseGmailUrl('https://mail.google.com/mail/u/0/#inbox/18b2f3c4d5e6f708')).toEqual({ kind: 'gmail', thread: '18b2f3c4d5e6f708', message: null, account: null, url: 'https://mail.google.com/mail/u/0/#inbox/18b2f3c4d5e6f708' });
    expect(parseGmailUrl('https://mail.google.com/mail/?authuser=Me@Example.com#all/18B2F3C4D5E6F708')).toMatchObject({ thread: '18b2f3c4d5e6f708', account: 'me@example.com' });
    // 1782345678901234567 = 0x18bc1f4b6c7c4807
    expect(parseGmailUrl('https://mail.google.com/mail/u/0/?ik=abc&view=pt&search=all&permthid=thread-f%3A1782345678901234567&simpl=msg-f%3A1782345678901234567')).toMatchObject({ thread: (1782345678901234567n).toString(16), message: (1782345678901234567n).toString(16) });
    expect(parseGmailUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgzQgLjNPlfJCVRfnNkPGkLhWClCW')).toMatchObject({ thread: null, message: null });
    expect(parseGmailUrl('https://mail.google.com/mail/u/0/#inbox')).toBeNull();
    expect(pastedUrl('https://mail.google.com/mail/u/0/#inbox')).toMatchObject({ kind: 'link' });
  });

  test("Google Calendar: an event's eid is its id and its calendar's, base64 encoded; gmail.com and group calendars come short", () => {
    expect(parseCalendarUrl(`https://calendar.google.com/calendar/event?eid=${eid('4htgpmm1hmak744r0kbkdcodar me@m')}`)).toMatchObject({ kind: 'gcal', eventId: '4htgpmm1hmak744r0kbkdcodar', calendarId: 'me@gmail.com' });
    expect(parseCalendarUrl(`https://calendar.google.com/calendar/u/0/r/eventedit/${eid('abc123def456_20261030T160000Z team123@g')}`)).toMatchObject({ eventId: 'abc123def456_20261030T160000Z', calendarId: 'team123@group.calendar.google.com' });
    expect(parseCalendarUrl(`https://www.google.com/calendar/event?eid=${eid('abcdef12345 me@example.com')}`)).toMatchObject({ calendarId: 'me@example.com' });
    expect(parseCalendarUrl('https://calendar.google.com/calendar/u/0/r/week')).toBeNull();
    expect(parseCalendarUrl('https://calendar.google.com/calendar/event?eid=%%%')).toBeNull();
  });

  test("a page's title from its address, as no page is fetched", () => {
    expect(linkTitle(new URL('https://www.example.com/a%20b/c'))).toBe('example.com › a b › c');
    expect(linkTitle(new URL(`https://example.com/${'x'.repeat(300)}`)).length).toBe(200);
  });

  test('the add field says what Enter does with it, as Sunsama suggests the import', () => {
    expect(urlHint('https://github.com/acme/app/issues/51')).toBe('Enter imports the GitHub issue acme/app#51');
    expect(urlHint('https://github.com/acme/app/pull/7')).toBe('Enter imports the GitHub pull request acme/app#7');
    expect(urlHint('https://mail.google.com/mail/u/0/#inbox/FMfcgzQgLjNPlfJCVRfnNkPGkLhWClCW')).toContain("Gmail's own links can't be read by other apps");
    expect(urlHint('https://example.com/x')).toBe('Enter adds a task linked to example.com');
    expect(urlHint('Fix the crash')).toBeNull();
  });
});

describe('Enter with a pasted URL', () => {
  const item51: GitHubItem = { id: 'I_51', kind: 'issue', repo: 'acme/app', number: 51, key: 'acme/app#51', title: 'Issue 51', url: 'https://github.com/acme/app/issues/51', state: 'OPEN', draft: false, updatedAt: '2026-10-01T00:00:00Z' };
  const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;
  /** A client whose service answers from `answer`, whose plan takes each command as the service would (validated). */
  const setup = (answer: (method: string, path: string, body: any) => unknown, options: { gh?: boolean; linear?: boolean } = {}) => {
    let state: PlannerState = { ...emptyState(), settings: { ...emptyState().settings, timezone: 'America/Los_Angeles' } };
    let n = 0;
    const calls: { method: string; path: string; body?: any }[] = [];
    const notes: string[] = [];
    const client = {
      getView: () => ({ state, today: TODAY }),
      call: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        const answered = answer(method, path, body);
        if (answered instanceof Error) throw answered;
        return answered;
      },
      // As the service takes a batch: each command checked against the plan the ones before it made.
      dispatch: async (bodies: EventBody[]) => {
        for (const body of bodies) {
          expect(validateCommand({ cmd: `c${n++}`, ...body }, state)).toBeNull();
          state = applyEvents(state, [ev(body)]);
        }
      },
      notify: (message: string) => notes.push(message),
      onCommitted: () => () => {},
    } as unknown as PlannerClient;
    const github = new GitHubStore(client, 'page');
    (github as unknown as { view: { status: unknown } }).view.status = { available: options.gh ?? true, login: 'me', message: null };
    const google = Object.assign(Object.create(new GoogleStore(host, client, 'page')), { accountsWith: (feature: string) => (feature === 'calendar' || feature === 'mail' ? [{ email: ME, features: ['calendar', 'mail'] }] : []) }) as GoogleStore;
    const linear = { available: () => options.linear ?? false } as unknown as LinearStore;
    const sources: AddSources = { client, linear, github, google };
    const add = (text: string) => addParsedTask(sources, parseQuickAdd(text, TODAY), { kind: 'day', date: TODAY }, 'bottom', TODAY);
    const tasks = (): Task[] => Object.values(state.tasks);
    return { add, calls, notes, tasks };
  };

  test('a GitHub issue URL makes a task linked to the issue: its real id, title and address; ~30m plans its time', async () => {
    const fake = setup((_method, path, body) => (path === '/github/resolve' ? { item: body.url === item51.url ? item51 : null } : {}));
    await fake.add('https://github.com/acme/app/issues/51#issuecomment-9 ~30m');
    expect(fake.calls).toEqual([{ method: 'POST', path: '/github/resolve', body: { url: 'https://github.com/acme/app/issues/51' } }]);
    expect(fake.tasks().map((task) => [task.title, task.plannedMinutes, task.source?.kind, task.source?.id, task.source?.key, task.source?.url])).toEqual([['Issue 51', 30, 'github', 'I_51', 'acme/app#51', 'https://github.com/acme/app/issues/51']]);
    expect(fake.notes).toEqual([]);
  });

  test('not on GitHub, or gh signed out: a task linked to the page, and the Planner says why', async () => {
    const missing = setup((_method, path) => (path === '/github/resolve' ? new Error('acme/app#52 was not found on GitHub, or this gh can\'t see it') : {}));
    await missing.add('https://github.com/acme/app/issues/52');
    expect(missing.tasks().map((task) => [task.title, task.source?.kind, task.source?.url])).toEqual([['github.com › acme › app › issues › 52', 'link', 'https://github.com/acme/app/issues/52']]);
    expect(missing.notes).toEqual(["acme/app#52 was not found on GitHub, or this gh can't see it; added the link as a task"]);
    const signedOut = setup(() => ({}), { gh: false });
    await signedOut.add('https://github.com/acme/app/pull/7');
    expect(signedOut.calls).toEqual([]);
    expect(signedOut.tasks()[0]!.source).toMatchObject({ kind: 'link', url: 'https://github.com/acme/app/pull/7' });
    expect(signedOut.notes[0]).toContain('GitHub (gh) is not signed in');
  });

  test("a Gmail message's address makes a task linked to the email; Gmail's own links become the page's backlink", async () => {
    const mail = { account: ME, id: '18b2f3c4d5e6f709', threadId: '18b2f3c4d5e6f708', subject: 'Quarterly numbers', from: 'Ann <ann@example.com>', date: '2026-10-29T10:00:00.000Z', snippet: 'See attached', unread: true, url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/18b2f3c4d5e6f708` };
    const fake = setup((_method, path, body) => (path === '/google/mail/resolve' ? (body.thread === '18b2f3c4d5e6f708' ? { item: mail } : new Error('This message is in none of your Gmail accounts')) : {}));
    await fake.add('https://mail.google.com/mail/u/0/#inbox/18b2f3c4d5e6f708');
    expect(fake.calls[0]).toEqual({ method: 'POST', path: '/google/mail/resolve', body: { thread: '18b2f3c4d5e6f708', message: null, account: null } });
    expect(fake.tasks().map((task) => [task.title, task.source?.kind, task.source?.id, task.source?.account])).toEqual([['Quarterly numbers', 'email', '18b2f3c4d5e6f709', ME]]);
    const opaque = setup(() => ({}));
    await opaque.add('https://mail.google.com/mail/u/0/#inbox/FMfcgzQgLjNPlfJCVRfnNkPGkLhWClCW');
    expect(opaque.calls).toEqual([]);
    expect(opaque.tasks()[0]!.source).toMatchObject({ kind: 'link', key: 'mail.google.com' });
    expect(opaque.notes[0]).toContain("Gmail's own links can't be read by other apps");
  });

  test('a Google Calendar event is planned as "Plan as task" plans it: its title, its length, linked back to it', async () => {
    const detail = { account: ME, calendarId: 'me@gmail.com', id: 'abc123def456', title: 'Design review', start: { dateTime: '2026-10-30T17:00:00Z' }, end: { dateTime: '2026-10-30T18:30:00Z' }, allDay: false, htmlLink: 'https://www.google.com/calendar/event?eid=YWJj' };
    const fake = setup((_method, path) => (path.startsWith('/google/event?') && path.includes('id=abc123def456') && path.includes('calendar=me%40gmail.com') ? { event: detail } : new Error('This event is no longer in Google Calendar')));
    await fake.add(`https://calendar.google.com/calendar/event?eid=${eid('abc123def456 me@m')}`);
    expect(fake.tasks().map((task) => [task.title, task.plannedMinutes, task.notes, task.source?.kind, task.source?.key, task.source?.url])).toEqual([['Design review', 90, '2026-10-30, from the calendar', 'link', 'Google Calendar', detail.htmlLink]]);
  });

  test('any other page: a task with it as its backlink (http too); a title that is no URL: a plain task', async () => {
    const fake = setup(() => ({}));
    await fake.add('http://intranet.example.com/wiki/Runbook ~15m');
    await fake.add('Fix the crash');
    expect(fake.tasks().map((task) => [task.title, task.plannedMinutes, task.source?.kind ?? null, task.source?.url ?? null])).toEqual([
      ['intranet.example.com › wiki › Runbook', 15, 'link', 'http://intranet.example.com/wiki/Runbook'],
      ['Fix the crash', null, null, null],
    ]);
    expect(fake.calls).toEqual([]);
  });

  test('a Linear issue URL without Linear connected: the backlink task, and how to connect', async () => {
    const fake = setup(() => ({}), { linear: false });
    await fake.add('https://linear.app/acme/issue/NEX-110/fix-it');
    expect(fake.tasks()[0]!.source).toMatchObject({ kind: 'link', url: 'https://linear.app/acme/issue/NEX-110/fix-it' });
    expect(fake.notes[0]).toContain('Linear is not connected');
  });
});
