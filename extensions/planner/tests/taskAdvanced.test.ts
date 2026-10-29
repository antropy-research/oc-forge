// Round 10: the rest of a Google task's advanced settings in Google Calendar,
// kept in the Planner as Google Tasks' API has none of them: its color (and
// each list's, under "My calendars"), Google Drive attachments (found through
// the account's Drive, asked for the way Calendar and Tasks are), and, for a
// work or school account, Do not disturb (the Planner's own notifications
// wait until the task ends) and "Automatically decline meetings" (invitations
// that overlap a Busy task are answered "Declined" with its message).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostClient } from '@openchamber/sdk';
import { GoogleStore, advancedChanged, attachmentsChanged, type TaskFields } from '../panel/lib/google.ts';
import type { PlannerClient } from '../panel/lib/client.ts';
import { eventColor, inHiddenList } from '../panel/components/calendar/items.ts';
import { GoogleAccounts, identityFromIdToken, type Fetcher } from '../service/google.ts';
import { MeetingDecliner } from '../service/googleDecline.ts';
import { TaskNotifications, type NotificationReads } from '../service/taskNotifications.ts';
import { ATTACHMENTS_MAX, validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import { addDays, instantAt, todayIn, zonedDateMinutes } from '../src/domain/dates.ts';
import { dueTaskEvent, type GoogleTaskItem } from '../src/domain/google.ts';
import { planRsvp } from '../src/domain/gevents.ts';
import { keptFor, occurrenceTask, templateOf, upcomingEvent, upcomingTasks } from '../src/domain/gtaskKept.ts';
import { taskNotifications } from '../src/domain/gtaskNotify.ts';
import {
  DEFAULT_DECLINE_MESSAGE,
  TASKS_COLOR,
  colorName,
  driveKind,
  driveQuery,
  invitationsToDecline,
  moveList,
  orderedLists,
  quietLabel,
  quietNotifications,
  taskColor,
  taskListColor,
  taskListKey,
  taskListShown,
  taskWindows,
  withAttachments,
  type Invitation,
} from '../src/domain/gtaskAdvanced.ts';
import { emptyState, type GoogleTaskKept, type PlannerState, type TaskAttachment } from '../src/domain/types.ts';
import { DEFAULT_SCOPES, DRIVE_SCOPE, defaultFakeWorld, fakeAuthCode, startFakeGoogle, type FakeGoogle } from './e2e/fakeGoogle.mjs';
import { seriesRoutes } from './seriesRoutes.ts';

const ME = 'me@example.com';
const ZONE = 'America/Los_Angeles';
const TODAY = '2026-10-29';
let clock = Date.parse('2026-10-29T15:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};
const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: ME, listId: 'L1', id: 'gt1', title: 'Deep work', notes: '', due: TODAY, completed: false, parent: null, position: '0001', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-28T15:00:00.000Z', ...patch,
});
const keep = (taskId: string, patch: Record<string, unknown>, listId = 'L1'): EventBody => ({ type: 'gtask.kept', account: ME, listId, taskId, patch } as EventBody);
const stateWith = (...bodies: EventBody[]): PlannerState => applyEvents(emptyState(), bodies.map(ev));
const kept = (state: PlannerState, id = 'gt1'): GoogleTaskKept | null => keptFor(state, { account: ME, id });
const check = (body: EventBody) => validateCommand({ cmd: 'c1', ...body }, emptyState());
const doc = (id: string, title: string): TaskAttachment => ({ id, title, mimeType: 'application/vnd.google-apps.document', url: `https://docs.google.com/document/d/${id}/edit` });

describe("a task's color, as Google Calendar colors tasks", () => {
  test("its own color, else its list's, else Google Calendar's tasks color; checked as #rrggbb", () => {
    expect(check(keep('gt1', { color: '#0b8043' }))).toBeNull();
    expect(check(keep('gt1', { color: null }))).toBeNull();
    expect(check(keep('gt1', { color: 'green' }))).toContain('color must be #rrggbb');
    const plain = stateWith(keep('other', { time: 600 }));
    expect(taskColor(plain, item())).toBe(TASKS_COLOR);
    const listed = applyEvents(plain, [ev({ type: 'settings.updated', patch: { googleTaskListColors: { [taskListKey(ME, 'L1')]: '#f4511e' } } })]);
    expect(taskListColor(listed.settings, ME, 'L1')).toBe('#f4511e');
    expect(taskColor(listed, item())).toBe('#f4511e');
    const own = applyEvents(listed, [ev(keep('gt1', { color: '#8e24aa' }))]);
    expect(taskColor(own, item())).toBe('#8e24aa');
    expect(colorName('#8E24AA')).toBe('Grape');
    // On the calendar: a task's chip, its deadline and an upcoming occurrence of its series take it; events keep theirs.
    const chip = dueTaskEvent({ ...item(), due: TODAY }, ZONE);
    expect(eventColor(chip, own)).toBe('#8e24aa');
    expect(eventColor({ ...chip, calendarId: 'cal', googleTask: undefined, google: undefined }, { ...own, calendars: { cal: { id: 'cal', name: 'Cal', url: '', color: '#039be5', visible: true } } })).toBe('#039be5');
    // Back to its list's color: nothing else kept, so it is forgotten.
    expect(kept(applyEvents(own, [ev(keep('gt1', { color: null }))]))).toBeNull();
  });

  test("a color alone keeps a task in the Planner's keeping, and a series' template gives it to each task it makes", () => {
    const state = stateWith(keep('gt1', { color: '#d50000' }));
    expect(kept(state)).toMatchObject({ color: '#d50000', time: null });
    const template = templateOf({ title: 'Standup', notes: '' }, { time: 570, duration: null, deadline: null, color: '#33b679' }, TODAY);
    expect(template.color).toBe('#33b679');
    const next = occurrenceTask({ rule: 'RRULE:FREQ=DAILY', seriesId: 's', index: 1, next: null, on: TODAY, template }, template, addDays(TODAY, 1), 2);
    expect(next.kept.color).toBe('#33b679');
    const series = stateWith(keep('s1', { time: 570, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's', index: 1, next: null, on: TODAY, template } }));
    const upcoming = upcomingTasks(series.googleTasks, [], addDays(TODAY, 1), addDays(TODAY, 1), TODAY);
    expect(eventColor(upcomingEvent(upcoming[0]!, ZONE), series)).toBe('#33b679');
  });

  test('task lists under "My calendars": a color and a checkbox each, in the order the user put them', () => {
    expect(check({ type: 'settings.updated', patch: { googleTaskListColors: { [taskListKey(ME, 'L1')]: '#f4511e' } } })).toBeNull();
    expect(check({ type: 'settings.updated', patch: { googleTaskListColors: { L1: '#f4511e' } } })).toContain('googleTaskListColors');
    expect(check({ type: 'settings.updated', patch: { googleTaskListsHidden: [taskListKey(ME, 'L2')] } })).toBeNull();
    expect(check({ type: 'settings.updated', patch: { googleTaskListOrder: [taskListKey(ME, 'L2'), taskListKey(ME, 'L2')] } })).toContain('once each');
    const hidden = stateWith({ type: 'settings.updated', patch: { googleTaskListsHidden: [taskListKey(ME, 'L2')] } });
    expect(taskListShown(hidden.settings, ME, 'L1')).toBe(true);
    expect(taskListShown(hidden.settings, ME, 'L2')).toBe(false);
    expect(inHiddenList(dueTaskEvent({ ...item({ listId: 'L2' }), due: TODAY }, ZONE), hidden.settings)).toBe(true);
    expect(inHiddenList(dueTaskEvent({ ...item(), due: TODAY }, ZONE), hidden.settings)).toBe(false);
    const lists = [{ account: ME, id: 'L1', title: 'My Tasks' }, { account: ME, id: 'L2', title: 'Errands' }, { account: ME, id: 'L3', title: 'Reading' }];
    expect(orderedLists(lists, [taskListKey(ME, 'L3')]).map((list) => list.id)).toEqual(['L3', 'L1', 'L2']);
    expect(moveList(lists, 2, 0)).toEqual([taskListKey(ME, 'L3'), taskListKey(ME, 'L1'), taskListKey(ME, 'L2')]);
    expect(moveList(lists, 0, 5)).toEqual(lists.map((list) => taskListKey(list.account, list.id)));
  });
});

describe('Drive attachments, as Google Calendar attaches them to a task', () => {
  test('kept as Drive files: an id, a name, a type and an https address; each once, at most 25', () => {
    expect(check(keep('gt1', { attachments: [doc('a1', 'Q4 plan')] }))).toBeNull();
    expect(check(keep('gt1', { attachments: [] }))).toBeNull();
    expect(check(keep('gt1', { attachments: [{ ...doc('a1', 'Q4 plan'), url: 'http://example.com' }] }))).toContain('https');
    expect(check(keep('gt1', { attachments: [doc('a1', 'Q4 plan'), doc('a1', 'Q4 plan')] }))).toContain('once');
    expect(check(keep('gt1', { attachments: [{ ...doc('a1', 'Q4 plan'), size: 3 }] }))).toContain('unknown field');
    expect(check(keep('gt1', { attachments: Array.from({ length: ATTACHMENTS_MAX + 1 }, (_, n) => doc(`f${n}`, `File ${n}`)) }))).toContain('at most 25');
    const state = stateWith(keep('gt1', { attachments: [doc('a1', 'Q4 plan')] }));
    expect(kept(state)).toMatchObject({ attachments: [doc('a1', 'Q4 plan')] });
    // Removing the last one forgets it.
    expect(kept(applyEvents(state, [ev(keep('gt1', { attachments: [] }))]))).toBeNull();
  });

  test("Insert adds the files chosen once each, never past 25; Drive's search is by name, quoted as Drive asks", () => {
    const one = [doc('a1', 'Q4 plan')];
    expect(withAttachments(one, [doc('a1', 'Q4 plan'), doc('a2', 'Budget')], 25)!.map((file) => file.id)).toEqual(['a1', 'a2']);
    expect(withAttachments(one, [doc('a2', 'Budget')], 1)).toBeNull();
    expect(driveQuery('')).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    expect(driveQuery("Ann's \\ plan")).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder' and name contains 'Ann\\'s \\\\ plan'");
    expect(driveKind('application/vnd.google-apps.spreadsheet').label).toBe('Google Sheets');
    expect(driveKind('application/zip').label).toBe('File');
  });
});

describe('Do not disturb and declining meetings (work and school accounts)', () => {
  const at = (minutes: number, date = TODAY) => instantAt(date, minutes, ZONE);
  test('both go with a time, declining only while Busy; declining stays on since it was turned on', () => {
    expect(check(keep('gt1', { doNotDisturb: true, decline: { mode: 'all', message: 'Heads down' } }))).toBeNull();
    expect(check(keep('gt1', { decline: { mode: 'sometimes', message: 'x' } }))).toContain('mode');
    expect(check(keep('gt1', { decline: { mode: 'new', message: 'x'.repeat(501) } }))).toContain('message');
    expect(check(keep('gt1', { doNotDisturb: 'yes' }))).toContain('doNotDisturb');
    const on = stateWith(keep('gt1', { time: 600, busy: true, doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } }));
    const since = kept(on)!.decline!.since;
    expect(kept(on)).toMatchObject({ doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } });
    // A new message keeps when it was turned on.
    const renamed = applyEvents(on, [ev(keep('gt1', { decline: { mode: 'new', message: 'In a workshop' } }))]);
    expect(kept(renamed)!.decline).toEqual({ mode: 'new', message: 'In a workshop', since });
    // Free: nothing is declined; all day: neither.
    expect(kept(applyEvents(on, [ev(keep('gt1', { busy: false }))]))!.decline).toBeUndefined();
    const allDay = kept(applyEvents(on, [ev(keep('gt1', { time: null, deadline: '2026-11-02' }))]))!;
    expect(allDay.doNotDisturb).toBeUndefined();
    expect(allDay.decline).toBeUndefined();
    expect(quietLabel(kept(on))).toBe('Do not disturb · Declines meetings');
    expect(quietLabel(kept(stateWith(keep('gt1', { time: 600, doNotDisturb: true }))))).toBe('Do not disturb');
  });

  test("a task's window: its time on its date, for open timed tasks and their series' upcoming occurrences", () => {
    const template = templateOf({ title: 'Focus block', notes: '' }, { time: 13 * 60, duration: 90, deadline: null, busy: true, doNotDisturb: true, decline: { mode: 'all', message: 'Focus', since: '2026-10-28T00:00:00.000Z' } }, TODAY);
    const state = stateWith(
      keep('gt1', { time: 600, duration: 60, busy: true, doNotDisturb: true }),
      keep('free', { time: 700, decline: { mode: 'all', message: 'x' } }),
      keep('done', { time: 800, doNotDisturb: true }),
      keep('series-1', { time: 13 * 60, duration: 90, busy: true, doNotDisturb: true, decline: { mode: 'all', message: 'Focus' }, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 'series', index: 1, next: null, on: TODAY, template } }),
    );
    const items = [item(), item({ id: 'free' }), item({ id: 'done', completed: true }), item({ id: 'series-1', title: 'Focus block' })];
    const windows = taskWindows(items, state.googleTasks, TODAY, addDays(TODAY, 1), TODAY, ZONE);
    expect(windows.map((window) => [window.taskId, window.date, window.start, window.end, window.doNotDisturb, window.decline?.mode ?? null])).toEqual([
      ['gt1', TODAY, at(600), at(660), true, null],
      ['series-1', TODAY, at(780), at(870), true, 'all'],
      ['series-1', addDays(TODAY, 1), at(780, addDays(TODAY, 1)), at(870, addDays(TODAY, 1)), true, 'all'],
    ]);
    expect(windows[2]!.key).toBe(`upcoming:series:${addDays(TODAY, 1)}`);
    expect(windows[2]!.decline!.since).toBe('2026-10-28T00:00:00.000Z');
  });

  test('Do not disturb holds the notifications that come during it until it ends; its own comes at its start', () => {
    const state = stateWith(keep('gt1', { time: 14 * 60, duration: 60, doNotDisturb: true }), keep('call', { time: 14 * 60 + 30 }), keep('later', { time: 16 * 60 }), keep('chain', { time: 15 * 60, duration: 30, doNotDisturb: true }), keep('inside', { time: 14 * 60 + 45 }));
    const due = [item(), item({ id: 'call', title: 'Call the bank' }), item({ id: 'later', title: 'Later' }), item({ id: 'chain', title: 'Second block' }), item({ id: 'inside', title: 'Inside' })];
    const all = quietNotifications(taskNotifications(due, [], state.googleTasks, TODAY, ZONE), taskWindows(due, state.googleTasks, TODAY, TODAY, TODAY, ZONE));
    expect(all.map((one) => [one.taskId, one.at, one.held ?? false])).toEqual([
      ['gt1', at(14 * 60), false],
      // 2:30 and 2:45 fall in Deep work, then in the second block that follows it: they come at 3:30.
      ['chain', at(15 * 60), false],
      ['call', at(15 * 60 + 30), true],
      ['inside', at(15 * 60 + 30), true],
      ['later', at(16 * 60), false],
    ]);
  });

  test('the service holds them, and gives them when the task is over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-dnd-'));
    try {
      const state = stateWith({ type: 'settings.updated', patch: { timezone: ZONE } }, keep('gt1', { time: 14 * 60, duration: 60, doNotDisturb: true }), keep('call', { time: 14 * 60 + 30 }));
      const items = [item(), item({ id: 'call', title: 'Call the bank' })];
      const reads: NotificationReads = { accounts: async () => [ME], due: async () => ({ items, errors: [] }), byIds: async () => ({ items: [], errors: [] }) };
      const now = { at: Date.parse(at(14 * 60 + 35)) };
      const service = new TaskNotifications(join(dir, 'given.json'), () => state, reads, () => now.at);
      const during = await service.take();
      // 9 AM passed with no date-only task; Deep work's own came at 2pm; Call the bank waits for 3pm.
      expect(during.notifications.map((one) => one.taskId)).toEqual(['gt1']);
      expect(during.next).toBe(at(15 * 60));
      now.at = Date.parse(at(15 * 60)) + 1000;
      expect((await service.take()).notifications.map((one) => [one.taskId, one.held])).toEqual([['call', true]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('which invitations a Busy task declines: someone else\'s meetings overlapping it, not declined yet; "only new" leaves older ones', () => {
    const window = { account: ME, listId: 'L1', taskId: 'gt1', key: 'k', title: 'Deep work', date: TODAY, start: at(600), end: at(720), doNotDisturb: false, decline: { mode: 'all' as const, message: 'Busy', since: at(500) } };
    const invite = (patch: Partial<Invitation>): Invitation => ({ id: 'i', summary: 'Sync', start: at(630), end: at(690), created: at(400), response: 'needsAction', mine: false, meeting: true, ...patch });
    const events = [
      invite({ id: 'old' }),
      invite({ id: 'new', created: at(550) }),
      invite({ id: 'accepted', response: 'accepted', created: at(560) }),
      invite({ id: 'mine', mine: true }),
      invite({ id: 'declined', response: 'declined' }),
      invite({ id: 'guestless', response: null }),
      invite({ id: 'focus', meeting: false }),
      invite({ id: 'before', start: at(540), end: at(600) }),
      invite({ id: 'edge', start: at(710), end: at(780) }),
    ];
    expect(invitationsToDecline(window, events).map((one) => one.id)).toEqual(['old', 'new', 'accepted', 'edge']);
    // Only new ones: those made after it was turned on (at 8:20); the rest were made at 6:40.
    expect(invitationsToDecline({ ...window, decline: { ...window.decline, mode: 'new' } }, events).map((one) => one.id)).toEqual(['new', 'accepted']);
    // Declined by the Planner before and answered again since: left as the user answered it.
    expect(invitationsToDecline(window, events, new Set(['old'])).map((one) => one.id)).toEqual(['new', 'accepted', 'edge']);
    expect(invitationsToDecline({ ...window, decline: null }, events)).toEqual([]);
  });

  test('a decline answers "Declined" with the message, which the organizer gets', () => {
    const instance = { id: 'ev1', attendees: [{ email: 'boss@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'needsAction' }] };
    const plan = planRsvp({ scope: 'this', instance, series: null, response: 'declined', comment: DEFAULT_DECLINE_MESSAGE });
    expect(plan).toEqual({ ops: [{ method: 'PATCH', eventId: 'ev1', role: 'change', body: { attendees: [instance.attendees[0], { email: ME, self: true, responseStatus: 'declined', comment: 'Declined because I am busy' }] } }] });
  });

  test("the service's pass: a work account's Busy task declines what overlaps it, each once; a personal account's none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-decline-'));
    try {
      const state = stateWith({ type: 'settings.updated', patch: { timezone: ZONE } }, keep('gt1', { time: 15 * 60, duration: 60, busy: true, decline: { mode: 'all', message: 'Heads down' } }));
      const invitations: Invitation[] = [{ id: 'sync', summary: 'Sync', start: at(15 * 60 + 15), end: at(15 * 60 + 45), created: at(60), response: 'needsAction', mine: false, meeting: true }];
      const responded: unknown[][] = [];
      const calendar = {
        invitations: async () => invitations,
        respond: async (...args: unknown[]) => {
          responded.push(args);
          invitations[0] = { ...invitations[0]!, response: 'declined' };
          return 1;
        },
      };
      let accounts = [ME];
      const reads = { accounts: async () => accounts, byIds: async () => ({ items: [item()], errors: [] }) };
      const decliner = new MeetingDecliner(join(dir, 'declined.json'), () => state, reads, calendar, { now: () => Date.parse(at(13 * 60)) });
      const pass = await decliner.run();
      expect(pass.declined).toEqual([expect.objectContaining({ account: ME, taskId: 'gt1', task: 'Deep work', eventId: 'sync', summary: 'Sync' })]);
      expect(responded).toEqual([[ME, 'primary', 'sync', 'declined', 'this', 'Heads down']]);
      expect((await decliner.declinedFor(ME, 'gt1')).map((one) => one.eventId)).toEqual(['sync']);
      // Accepted again by the user: the Planner leaves it, after a restart too.
      invitations[0] = { ...invitations[0]!, response: 'accepted' };
      const again = new MeetingDecliner(join(dir, 'declined.json'), () => state, reads, calendar, { now: () => Date.parse(at(13 * 60)) });
      expect((await again.run()).declined).toEqual([]);
      expect(responded).toHaveLength(1);
      // A personal account (no work or school domain) declines nothing.
      accounts = [];
      invitations[0] = { ...invitations[0]!, id: 'other', response: 'needsAction' };
      expect((await new MeetingDecliner(join(dir, 'other.json'), () => state, reads, calendar).run()).declined).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saved from the form', () => {
  const host = { storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] } } as unknown as HostClient;
  const fakeClient = (start: PlannerState, answer: (method: string, path: string, body: any) => unknown = () => ({ tasks: [] })) => {
    let state = start;
    let n = 0;
    const calls: { method: string; path: string; body?: any }[] = [];
    // A repeating task's series changes in the service: its routes run the service's own code here (`seriesRoutes`).
    const { handle } = seriesRoutes({ state: () => state, apply: (bodies) => (state = applyEvents(state, bodies.map(ev))) }, async (method, path, body) => answer(method, path, body));
    const client = {
      getView: () => ({ state, today: TODAY }),
      call: async (method: string, path: string, body?: unknown) => {
        const answered = await handle(path, body);
        if (answered) return answered;
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        return answer(method, path, body);
      },
      adopt: async () => {},
      dispatch: async (bodies: EventBody[]) => {
        for (const body of bodies) expect(validateCommand({ cmd: `c${n}`, ...body }, state)).toBeNull();
        n += bodies.length;
        state = applyEvents(state, bodies.map(ev));
      },
      activity: async () => [],
      notify: () => {},
      onCommitted: () => () => {},
    } as unknown as PlannerClient;
    return { client, calls, state: () => state };
  };
  const fields = (patch: Partial<TaskFields['kept']> = {}): TaskFields => ({ title: 'Deep work', notes: '', due: TODAY, kept: { time: 600, duration: 60, deadline: null, rule: null, busy: true, visibility: 'default', ...patch } });

  test('color, attachments, Do not disturb and declining are kept, with no Google write; declining is asked for at once', async () => {
    const fake = fakeClient(stateWith(keep('gt1', { time: 600, duration: 60, busy: true })), (method, path) => (path === '/google/tasks/decline' ? { declined: [], errors: [] } : method === 'PATCH' ? { task: item() } : { tasks: [] }));
    const store = new GoogleStore(host, fake.client, 'page');
    await store.saveListTask(item(), fields({ color: '#0b8043', attachments: [doc('a1', 'Q4 plan')], doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } }));
    expect(kept(fake.state())).toMatchObject({ color: '#0b8043', attachments: [doc('a1', 'Q4 plan')], doNotDisturb: true, decline: { mode: 'new', message: 'Heads down' } });
    expect(Date.parse(kept(fake.state())!.decline!.since)).toBeGreaterThan(0);
    expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.filter((call) => call.path === '/google/tasks/decline')).toHaveLength(1);
    // Fields that leave them out leave them as they are; Free ends declining.
    await store.saveListTask(item(), { ...fields(), kept: { time: 600, duration: 60, deadline: null, rule: null } });
    expect(kept(fake.state())).toMatchObject({ color: '#0b8043', doNotDisturb: true, decline: { mode: 'new' } });
    await store.saveListTask(item(), fields({ busy: false }));
    expect(kept(fake.state())!.decline).toBeUndefined();
    expect(kept(fake.state())!.doNotDisturb).toBe(true);
  });

  test("a repeating task's color, Do not disturb and declining are its series' (All tasks); its attachments are this task's or all of them", async () => {
    const template = templateOf({ title: 'Deep work', notes: '' }, { time: 600, duration: null, deadline: null, busy: true }, TODAY);
    const start = stateWith(keep('gt1', { time: 600, busy: true, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: 's', index: 1, next: null, on: TODAY, template } }));
    const fake = fakeClient(start);
    const store = new GoogleStore(host, fake.client, 'page');
    const repeating = (patch: Partial<TaskFields['kept']>) => ({ ...fields({ duration: null, rule: 'RRULE:FREQ=DAILY', ...patch }) });
    expect(advancedChanged(repeating({ color: '#d50000' }).kept, kept(start))).toBe(true);
    expect(attachmentsChanged(repeating({ attachments: [doc('a1', 'Q4 plan')] }).kept, kept(start))).toBe(true);
    // This task: the attachment is this occurrence's alone; the series makes the next ones without it.
    await store.saveListTask(item(), repeating({ attachments: [doc('a1', 'Q4 plan')] }), 'this');
    expect(kept(fake.state())!.attachments).toEqual([doc('a1', 'Q4 plan')]);
    expect(kept(fake.state())!.repeat!.template!.attachments).toBeUndefined();
    // A color asked for "this task" is for the whole series, as Google Calendar keeps one per series.
    await store.saveListTask(item(), repeating({ color: '#d50000', attachments: [doc('a1', 'Q4 plan')] }), 'this');
    expect(kept(fake.state())!.repeat!.template).toMatchObject({ color: '#d50000', attachments: [doc('a1', 'Q4 plan')] });
    const next = occurrenceTask(kept(fake.state())!.repeat!, kept(fake.state())!.repeat!.template!, addDays(TODAY, 1), 2);
    expect(next.kept).toMatchObject({ color: '#d50000', attachments: [doc('a1', 'Q4 plan')], busy: true });
  });
});

describe('work and school accounts', () => {
  const token = (claims: Record<string, unknown>) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  test("an ID token's hd says a work or school account; a personal one has none", () => {
    expect(identityFromIdToken(token({ email: 'Ann@Corp.example', hd: 'corp.example' }))).toEqual({ email: 'ann@corp.example', domain: 'corp.example' });
    expect(identityFromIdToken(token({ email: 'me@gmail.com' }))).toEqual({ email: 'me@gmail.com', domain: null });
    expect(identityFromIdToken(token({ email: 'me@x.example', hd: 'not a domain!' }))).toEqual({ email: 'me@x.example', domain: null });
    expect(identityFromIdToken('garbage')).toBeNull();
  });

  test('an account connected before the Planner kept it is asked once (its user info), and kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-identify-'));
    try {
      const file = join(dir, 'google-accounts.json');
      const client = { id: `${'1234567'.repeat(2)}-${'abcdefghij'.repeat(3)}.apps.googleusercontent.com`, secret: `GOCSPX-${'y'.repeat(28)}` };
      writeFileSync(file, JSON.stringify({ version: 1, client, accounts: [{ email: ME, refreshToken: 'rt', scopes: DEFAULT_SCOPES, addedAt: '2026-10-01T00:00:00Z' }] }));
      const urls: string[] = [];
      const fetcher: Fetcher = async (url) => {
        urls.push(url);
        const body = url.includes('/token') ? { access_token: 'at', expires_in: 3600 } : { sub: '1', email: ME, hd: 'example.com' };
        return { status: 200, text: async () => JSON.stringify(body) };
      };
      const accounts = new GoogleAccounts(file, fetcher);
      expect((await accounts.status()).accounts).toEqual([{ email: ME, features: ['calendar', 'tasks', 'mail'], addedAt: '2026-10-01T00:00:00Z', workspace: true }]);
      expect(JSON.parse(readFileSync(file, 'utf8')).accounts[0].domain).toBe('example.com');
      await accounts.status();
      expect(urls.filter((url) => url.endsWith('/oauth2/v3/userinfo'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A zone where it is between 10 AM and 8 PM now, so a task two hours ahead is still today. */
const daytimeZone = (now = Date.now()): string =>
  ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Honolulu'].find((zone) => {
    const hour = zonedDateMinutes(now, zone).minutes / 60;
    return hour >= 10 && hour < 20;
  }) ?? 'UTC';

describe('the routes, against a fake Google (a work account without Drive yet)', () => {
  const token = 'task-advanced-test-token';
  const zone = daytimeZone();
  const today = todayIn(zone);
  const account = 'harness@example.com';
  let child: ChildProcess;
  let fake: FakeGoogle;
  let base = '';
  let root = '';
  let seq = 0;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const commands = (...bodies: Record<string, unknown>[]) => call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `ta${String(++seq).padStart(8, '0')}`, ...body })) });
  const minutesNow = () => Math.floor(zonedDateMinutes(Date.now(), zone).minutes);
  const start = minutesNow() + 120;
  const at = (minutes: number) => new Date(instantAt(today, minutes, zone)).toISOString();

  beforeAll(async () => {
    const world = defaultFakeWorld({ account, today, zone });
    world.hostedDomain = 'example.com';
    world.granted = [...DEFAULT_SCOPES];
    world.driveFiles = [
      { id: 'd-plan', name: 'Q4 plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/d-plan/edit', modifiedTime: '2026-10-20T10:00:00Z' },
      { id: 'd-budget', name: 'Budget 2027', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://docs.google.com/spreadsheets/d/d-budget/edit', modifiedTime: '2026-10-25T10:00:00Z' },
      { id: 'd-folder', name: 'Budget folder', mimeType: 'application/vnd.google-apps.folder', webViewLink: 'https://drive.google.com/drive/folders/d-folder' },
      { id: 'd-old', name: 'Old budget', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/d-old/view', trashed: true },
    ];
    const guest = (id: string, summary: string, from: number, to: number, created: string, extra: Record<string, unknown> = {}) => ({
      id, summary, created, start: { dateTime: at(from) }, end: { dateTime: at(to) }, organizer: { email: 'lead@example.com' },
      attendees: [{ email: 'lead@example.com', organizer: true, responseStatus: 'accepted' }, { email: account, self: true, responseStatus: 'needsAction' }], ...extra,
    });
    world.events.primary!.push(
      guest('ev-existing', 'Existing sync', start + 15, start + 45, '2026-01-01T00:00:00.000Z'),
      guest('ev-outside', 'Later sync', start + 90, start + 120, '2026-01-01T00:00:00.000Z'),
      { id: 'ev-mine', summary: 'My own review', created: '2026-01-01T00:00:00.000Z', start: { dateTime: at(start) }, end: { dateTime: at(start + 30) }, organizer: { email: account, self: true }, attendees: [{ email: account, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', responseStatus: 'needsAction' }] },
    );
    world.tasks.L1![0]!.due = `${today}T00:00:00.000Z`;
    fake = await startFakeGoogle(world);
    root = mkdtempSync(join(tmpdir(), 'planner-task-advanced-'));
    writeFileSync(join(root, 'google-accounts.json'), fake.accountsFile(), { mode: 0o600 });
    mkdirSync(join(root, 'data'), { recursive: true });
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port: free } = server.address() as AddressInfo;
        server.close(() => resolve(free));
      });
    });
    child = spawn(process.execPath, [join(import.meta.dir, '../service/main.ts')], {
      env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(root, 'data'), PLANNER_GOOGLE_API_BASE: fake.base },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await commands({ type: 'settings.updated', patch: { timezone: zone } })).status).toBe(200);
  });

  afterAll(async () => {
    const exited = new Promise((resolve) => child?.once('exit', resolve));
    child?.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a work account, without Drive: its files are not searched until Drive is allowed', async () => {
    const status = await call('GET', '/google/status');
    expect(status.body.accounts).toEqual([expect.objectContaining({ email: account, workspace: true, features: ['calendar', 'tasks', 'mail'] })]);
    const refused = await call('GET', `/google/drive/files?account=${encodeURIComponent(account)}&q=plan`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('allow it first');
    expect(fake.requests.filter((request) => request.path.startsWith('/drive/'))).toEqual([]);
  });

  test('Allow Google Drive: a sign-in that asks for what the account has plus Drive; Google adds it to the rest', async () => {
    const started = await call('POST', '/google/connect', { features: ['calendar', 'tasks', 'mail', 'drive'] });
    expect(started.status).toBe(200);
    const auth = new URL(started.body.authUrl);
    expect(auth.searchParams.get('include_granted_scopes')).toBe('true');
    expect(auth.searchParams.get('scope')!.split(' ')).toContain(DRIVE_SCOPE);
    const redirect = `${started.body.redirectUri}?${new URLSearchParams({ state: auth.searchParams.get('state')!, code: fakeAuthCode(auth.searchParams.get('scope')!) })}`;
    const finished = await call('POST', `/google/connect/${started.body.id}/finish`, { url: redirect });
    expect(finished.body).toEqual({ status: 'connected', email: account, features: ['calendar', 'tasks', 'mail', 'drive'] });
    const status = await call('GET', '/google/status');
    expect(status.body.accounts).toEqual([expect.objectContaining({ email: account, workspace: true, features: ['calendar', 'tasks', 'mail', 'drive'] })]);
    const kept = JSON.parse(readFileSync(join(root, 'google-accounts.json'), 'utf8')).accounts[0];
    expect(kept).toMatchObject({ domain: 'example.com', scopes: expect.arrayContaining([...DEFAULT_SCOPES, DRIVE_SCOPE]) });
  });

  test("Drive's search: files by name, newest first, no folders or trashed files; names, types and addresses only", async () => {
    const latest = await call('GET', `/google/drive/files?account=${encodeURIComponent(account)}`);
    expect(latest.body.files.map((file: { id: string }) => file.id)).toEqual(['d-budget', 'd-plan']);
    const found = await call('GET', `/google/drive/files?account=${encodeURIComponent(account)}&q=budget`);
    expect(found.body.files).toEqual([{ id: 'd-budget', title: 'Budget 2027', mimeType: 'application/vnd.google-apps.spreadsheet', url: 'https://docs.google.com/spreadsheets/d/d-budget/edit', modifiedTime: '2026-10-25T10:00:00Z' }]);
    const asked = fake.requests.filter((request) => request.path === '/drive/v3/files').at(-1)!;
    expect(asked.query).toMatchObject({ q: "trashed = false and mimeType != 'application/vnd.google-apps.folder' and name contains 'budget'", fields: 'files(id,name,mimeType,webViewLink,modifiedTime)' });
  });

  test("Undo after Delete: Google undeletes a task it deleted a moment ago, with its subtasks; only deleted: false is taken", async () => {
    const list = () => fake.tasks.get('L1')!.map((task: { id: string }) => task.id);
    expect(list()).toContain('t-trip');
    expect((await call('DELETE', `/google/tasks?account=${encodeURIComponent(account)}&list=L1&id=t-trip`)).status).toBe(200);
    expect(list()).not.toContain('t-trip');
    expect(list()).not.toContain('t-hotel');
    expect((await call('PATCH', '/google/tasks', { account, listId: 'L1', id: 't-trip', deleted: true })).status).toBe(400);
    const back = await call('PATCH', '/google/tasks', { account, listId: 'L1', id: 't-trip', deleted: false });
    expect(back.status).toBe(200);
    expect(back.body.task).toMatchObject({ id: 't-trip', title: 'Plan the trip' });
    expect((await call('PATCH', '/google/tasks', { account, listId: 'L1', id: 't-hotel', deleted: false })).body.task).toMatchObject({ id: 't-hotel', parent: 't-trip' });
    expect(list()).toEqual(expect.arrayContaining(['t-trip', 't-hotel']));
  });

  test('Automatically decline meetings: the invitations overlapping a Busy task are declined with its message, which the organizer gets', async () => {
    const message = 'Declined: heads down on the Q4 plan';
    expect((await commands({ type: 'gtask.kept', account, listId: 'L1', taskId: 't-report', patch: { time: start, duration: 60, busy: true, decline: { mode: 'all', message } } })).status).toBe(200);
    const pass = await call('POST', '/google/tasks/decline');
    expect(pass.status).toBe(200);
    // The background pass may have declined it first; either way Google has it declined, once.
    const self = () => fake.calendars.get('primary')!.events.get('ev-existing').attendees.find((guest: { self?: boolean }) => guest.self);
    for (let i = 0; i < 50 && self().responseStatus !== 'declined'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(self()).toMatchObject({ responseStatus: 'declined', comment: message });
    const patches = fake.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/events/ev-existing'));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.query.sendUpdates).toBe('all');
    // Not the one after it, nor the one I organize.
    expect(fake.calendars.get('primary')!.events.get('ev-outside').attendees.find((guest: { self?: boolean }) => guest.self).responseStatus).toBe('needsAction');
    expect(fake.requests.some((request) => request.method === 'PATCH' && request.path.endsWith('/events/ev-mine'))).toBe(false);
    const declined = await call('GET', `/google/tasks/declined?account=${encodeURIComponent(account)}&task=t-report`);
    expect(declined.body.declined).toEqual([expect.objectContaining({ eventId: 'ev-existing', summary: 'Existing sync', task: 'Send the report' })]);
    // Only new invitations: one made before it was turned on stays; a new one is declined.
    fake.calendars.get('primary')!.events.get('ev-existing').attendees.find((guest: { self?: boolean }) => guest.self).responseStatus = 'needsAction';
    expect((await commands({ type: 'gtask.kept', account, listId: 'L1', taskId: 't-report', patch: { decline: null } }, { type: 'gtask.kept', account, listId: 'L1', taskId: 't-report', patch: { decline: { mode: 'new', message } } })).status).toBe(200);
    const fresh = { id: 'ev-new', summary: 'New sync', created: new Date(Date.now() + 1000).toISOString(), start: { dateTime: at(start + 30) }, end: { dateTime: at(start + 50) }, organizer: { email: 'lead@example.com' }, attendees: [{ email: 'lead@example.com', organizer: true, responseStatus: 'accepted' }, { email: account, self: true, responseStatus: 'needsAction' }] };
    fake.calendars.get('primary')!.events.set('ev-new', fresh);
    await call('POST', '/google/tasks/decline');
    const freshSelf = () => fake.calendars.get('primary')!.events.get('ev-new').attendees.find((guest: { self?: boolean }) => guest.self);
    for (let i = 0; i < 50 && freshSelf().responseStatus !== 'declined'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(freshSelf()).toMatchObject({ responseStatus: 'declined', comment: message });
    // The older one was declined by the Planner before and answered again: it is left as answered.
    expect(self().responseStatus).toBe('needsAction');
  });
});

afterEach(() => {
  clock += 60_000;
});
