// Google Calendar and Google Tasks writes through the real GoogleAccounts,
// with fetch mocked: the requests the Planner sends, in order, and what it
// makes of Google's refusals.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAccounts, GoogleError, TOKEN_URL, testFetcher, type Fetcher } from '../service/google.ts';
import { GoogleData } from '../service/googleData.ts';

const ME = 'me@example.com';
const LA = 'America/Los_Angeles';
const CLIENT_ID = `${'1234567'.repeat(2)}-${'abcdefghij'.repeat(3)}.apps.googleusercontent.com`;

interface Call {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  body?: unknown;
}
type Reply = { status: number; body?: unknown };

/** A connected account whose requests `answer` replies to; token requests are answered here. */
const google = (answer: (call: Call) => Reply) => {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    if (url === TOKEN_URL) return { status: 200, text: async () => JSON.stringify({ access_token: 'at', expires_in: 3600 }) };
    const parsed = new URL(url);
    const call: Call = { method: init.method, path: decodeURIComponent(parsed.pathname), query: Object.fromEntries(parsed.searchParams), ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    const reply = answer(call);
    return { status: reply.status, text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)) };
  };
  const file = join(mkdtempSync(join(tmpdir(), 'planner-gwrites-')), 'google-accounts.json');
  writeFileSync(file, JSON.stringify({ version: 1, client: { id: CLIENT_ID, secret: `GOCSPX-${'s'.repeat(28)}` }, accounts: [{ email: ME, refreshToken: 'rt', scopes: [], addedAt: '2026-10-01T00:00:00Z' }] }));
  return { data: new GoogleData(new GoogleAccounts(file, fetcher)), calls, writes: () => calls.filter((call) => call.method !== 'GET') };
};

const ok = (body: unknown = {}): Reply => ({ status: 200, body });
const EVENTS = '/calendar/v3/calendars/primary/events';
const calendarList = (call: Call): Reply | null => (call.path === '/calendar/v3/users/me/calendarList' ? ok({ items: [{ id: 'primary', summary: 'Me', accessRole: 'owner', backgroundColor: '#4285f4', primary: true }] }) : null);

const series = {
  id: 'wk',
  summary: 'Team sync',
  start: { dateTime: '2026-10-05T09:00:00-07:00', timeZone: LA },
  end: { dateTime: '2026-10-05T10:00:00-07:00', timeZone: LA },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
  organizer: { email: ME, self: true },
  attendees: [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@x.com', responseStatus: 'needsAction' }],
};
const instance = {
  id: 'wk_20261026T160000Z',
  recurringEventId: 'wk',
  summary: 'Team sync',
  originalStartTime: { dateTime: '2026-10-26T09:00:00-07:00', timeZone: LA },
  start: { dateTime: '2026-10-26T09:00:00-07:00', timeZone: LA },
  end: { dateTime: '2026-10-26T10:00:00-07:00', timeZone: LA },
  organizer: { email: ME, self: true },
  attendees: series.attendees,
};
/** Google with one weekly series; `extra` answers first. */
const withSeries = (extra: (call: Call) => Reply | null = () => null) =>
  google((call) => {
    const special = extra(call) ?? calendarList(call);
    if (special) return special;
    if (call.method === 'GET' && call.path === `${EVENTS}/wk`) return ok(series);
    if (call.method === 'GET' && call.path === `${EVENTS}/${instance.id}`) return ok(instance);
    if (call.method === 'POST' && call.path === EVENTS) return ok({ id: 'new-series', ...(call.body as object) });
    return ok({ id: call.path.split('/').pop() });
  });

describe('Google Calendar events', () => {
  test('a new event: its body, who hears of it, a Meet call, and what may be done with it', async () => {
    const { data, writes } = google((call) => calendarList(call) ?? ok({ id: 'ev1', htmlLink: 'https://www.google.com/calendar/event?eid=1', organizer: { email: ME, self: true }, ...(call.body as object) }));
    const detail = await data.insertEvent(ME, 'primary', { summary: 'Design review', start: { dateTime: '2026-10-26T17:00:00.000Z', timeZone: LA }, end: { dateTime: '2026-10-26T18:00:00.000Z', timeZone: LA }, attendees: [{ email: 'ann@x.com' }], meet: true, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }, 'all');
    const [post] = writes();
    expect(post).toMatchObject({ method: 'POST', path: EVENTS, query: { sendUpdates: 'all', conferenceDataVersion: '1' } });
    expect(post!.body).toMatchObject({ summary: 'Design review', attendees: [{ email: 'ann@x.com' }], recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } } });
    expect(detail).toMatchObject({ id: 'ev1', title: 'Design review', editable: true, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    await expect(data.insertEvent(ME, 'primary', { summary: 'no time' }, 'none')).rejects.toThrow('start and an end');
  });

  test('changing this event, all events, this and following', async () => {
    const at = (hour: number) => ({ dateTime: `2026-10-26T${hour}:00:00-07:00`, timeZone: LA });
    const one = withSeries();
    expect(await one.data.updateEvent(ME, 'primary', instance.id, { start: at(11), end: at(12) }, 'this', 'none', LA)).toBe(1);
    expect(one.writes()).toEqual([{ method: 'PATCH', path: `${EVENTS}/${instance.id}`, query: { sendUpdates: 'none' }, body: { start: at(11), end: at(12) } }]);

    const all = withSeries();
    await all.data.updateEvent(ME, 'primary', instance.id, { start: at(11), end: at(12) }, 'all', 'all', LA);
    expect(all.writes()).toEqual([{ method: 'PATCH', path: `${EVENTS}/wk`, query: { sendUpdates: 'all' }, body: { start: { dateTime: '2026-10-05T18:00:00.000Z', timeZone: LA }, end: { dateTime: '2026-10-05T19:00:00.000Z', timeZone: LA } } }]);

    const following = withSeries();
    expect(await following.data.updateEvent(ME, 'primary', instance.id, { summary: 'New sync' }, 'following', 'none', LA)).toBe(2);
    expect(following.writes().map((call) => [call.method, call.path])).toEqual([['POST', EVENTS], ['PATCH', `${EVENTS}/wk`]]);
    expect(following.writes()[0]!.body).toMatchObject({ summary: 'New sync', start: instance.start, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    expect(following.writes()[1]!.body).toEqual({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T155959Z'] });
  });

  test('a split whose second step fails takes its new series back', async () => {
    const { data, writes } = withSeries((call) => (call.method === 'PATCH' ? { status: 500, body: { error: { message: 'Backend Error' } } } : null));
    const failure = await data.updateEvent(ME, 'primary', instance.id, { summary: 'x' }, 'following', 'none', LA).catch((error) => error);
    expect(failure).toBeInstanceOf(GoogleError);
    expect([(failure as GoogleError).status, (failure as GoogleError).message]).toEqual([502, 'Backend Error']);
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${EVENTS}`, `PATCH ${EVENTS}/wk`, `DELETE ${EVENTS}/new-series`]);
  });

  test('splitting a counted series counts the events before it, page after page', async () => {
    const counted = { ...series, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'] };
    const { data, calls, writes } = google((call) => {
      if (call.path === `${EVENTS}/wk/instances`) {
        // Three earlier Mondays, over two pages (the one on the 12th was cancelled, which COUNT still counts).
        return call.query.pageToken ? ok({ items: [{ id: 'c', originalStartTime: { dateTime: '2026-10-19T09:00:00-07:00' } }] }) : ok({ items: [{ id: 'a', originalStartTime: { dateTime: '2026-10-05T09:00:00-07:00' } }, { id: 'b', originalStartTime: { dateTime: '2026-10-12T09:00:00-07:00' }, status: 'cancelled' }], nextPageToken: 'p2' });
      }
      if (call.method === 'GET' && call.path === `${EVENTS}/wk`) return ok(counted);
      if (call.method === 'GET') return ok(instance);
      return ok({ id: 'x' });
    });
    await data.updateEvent(ME, 'primary', instance.id, { summary: 'x' }, 'following', 'none', LA);
    const instances = calls.filter((call) => call.path.endsWith('/instances'));
    expect(instances.map((call) => [call.query.showDeleted, call.query.pageToken ?? null])).toEqual([['true', null], ['true', 'p2']]);
    expect(writes()[0]!.body).toMatchObject({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=7'] });
  });

  test('deleting, and an event that is already gone', async () => {
    const { data, writes } = withSeries();
    await data.deleteEvent(ME, 'primary', instance.id, 'following', 'all');
    expect(writes()).toEqual([{ method: 'PATCH', path: `${EVENTS}/wk`, query: { sendUpdates: 'all' }, body: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T155959Z'] } }]);
    const gone = google(() => ({ status: 410, body: { error: { message: 'Resource has been deleted' } } }));
    expect(await gone.data.deleteEvent(ME, 'primary', 'old', 'this', 'none')).toEqual({ requests: 0, undo: null });
  });

  test('one deleted event can be put back ("Undo"): written back as confirmed, or copied once Google no longer has it', async () => {
    const meeting = {
      id: 'ev9', etag: '"1"', htmlLink: 'https://www.google.com/calendar/event?eid=9', iCalUID: 'ev9@google.com', status: 'confirmed', created: '2026-10-01T00:00:00Z', updated: '2026-10-02T00:00:00Z',
      creator: { email: ME, self: true }, organizer: { email: ME, self: true }, summary: 'Design review', description: '<b>Agenda</b>', location: 'Room 4',
      start: { dateTime: '2026-10-27T10:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-10-27T11:00:00-07:00', timeZone: LA },
      attendees: [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@x.com', responseStatus: 'accepted' }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      conferenceData: { conferenceId: 'abc-defg-hij', conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
    };
    const restored = { summary: meeting.summary, description: meeting.description, location: meeting.location, start: meeting.start, end: meeting.end, attendees: meeting.attendees, reminders: meeting.reminders, conferenceData: meeting.conferenceData };
    const answer = (putStatus: number) => (call: Call): Reply => calendarList(call) ?? (call.method === 'GET' ? ok(meeting) : call.method === 'PUT' ? { status: putStatus, body: putStatus === 200 ? meeting : { error: { message: 'Not Found' } } } : call.method === 'POST' ? ok({ ...meeting, id: 'copy' }) : { status: 204 });

    const kept = google(answer(200));
    const deleted = await kept.data.deleteEvent(ME, 'primary', 'ev9', 'this', 'all');
    expect(deleted.requests).toBe(1);
    expect(deleted.undo).toBeString();
    await kept.data.restoreEvent(deleted.undo!);
    // Google's bookkeeping (id, etag, links, organizer…) stays out; the guests hear of it as they heard of the deletion.
    expect(kept.writes().map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE ${EVENTS}/ev9`, `PUT ${EVENTS}/ev9`]);
    expect(kept.writes()[1]).toMatchObject({ query: { sendUpdates: 'all', conferenceDataVersion: '1' }, body: { ...restored, status: 'confirmed' } });
    expect(Object.keys(kept.writes()[1]!.body as object).sort()).toEqual([...Object.keys(restored), 'status'].sort());
    // Once only.
    const again = await kept.data.restoreEvent(deleted.undo!).catch((error) => error);
    expect([again instanceof GoogleError, (again as GoogleError).status]).toEqual([true, 410]);

    const lost = google(answer(404));
    await lost.data.restoreEvent((await lost.data.deleteEvent(ME, 'primary', 'ev9', 'this', 'none')).undo!);
    expect(lost.writes().map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE ${EVENTS}/ev9`, `PUT ${EVENTS}/ev9`, `POST ${EVENTS}`]);
    expect(lost.writes()[2]).toMatchObject({ query: { sendUpdates: 'none' }, body: restored });
  });

  test('a deleted occurrence comes back confirmed; a deleted series, or its rest, cannot be undone here; nor can an old deletion', async () => {
    const { data, writes } = withSeries();
    const one = await data.deleteEvent(ME, 'primary', instance.id, 'this', 'none');
    await data.restoreEvent(one.undo!);
    expect(writes().slice(-1)).toEqual([{ method: 'PATCH', path: `${EVENTS}/${instance.id}`, query: { sendUpdates: 'none' }, body: { status: 'confirmed' } }]);
    expect((await data.deleteEvent(ME, 'primary', instance.id, 'all', 'none')).undo).toBeNull();
    expect((await data.deleteEvent(ME, 'primary', instance.id, 'following', 'none')).undo).toBeNull();

    const later = await data.deleteEvent(ME, 'primary', instance.id, 'this', 'none');
    const now = Date.now;
    Date.now = () => now() + 11 * 60_000;
    try {
      const old = await data.restoreEvent(later.undo!).catch((error) => error);
      expect([old instanceof GoogleError, (old as GoogleError).status]).toEqual([true, 410]);
    } finally {
      Date.now = now;
    }
  });

  test('answering an invitation patches my own answer, and the organizer hears it', async () => {
    const invited = { ...instance, organizer: { email: 'ann@x.com' }, attendees: [{ email: 'ann@x.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'needsAction' }] };
    const { data, writes } = google((call) => (call.method === 'GET' && call.path === `${EVENTS}/wk` ? ok(series) : call.method === 'GET' ? ok(invited) : ok({ id: instance.id })));
    await data.respond(ME, 'primary', instance.id, 'accepted', 'this');
    expect(writes()).toEqual([{ method: 'PATCH', path: `${EVENTS}/${instance.id}`, query: { sendUpdates: 'all' }, body: { attendees: [invited.attendees[0], { ...invited.attendees[1], responseStatus: 'accepted' }] } }]);
  });

  test("Google's refusals keep their meaning", async () => {
    const refusing = (status: number, message: string) => google((call) => (call.method === 'GET' ? ok({ ...instance, recurringEventId: undefined, id: 'one' }) : { status, body: { error: { message } } }));
    const statusOf = async (status: number, message: string) => {
      const error = await refusing(status, message).data.updateEvent(ME, 'primary', 'one', { summary: 'x' }, 'this', 'none', LA).catch((failure) => failure);
      return [(error as GoogleError).status, (error as GoogleError).message];
    };
    expect(await statusOf(403, 'You need to have writer access to this calendar.')).toEqual([403, 'You need to have writer access to this calendar.']);
    expect(await statusOf(400, 'Invalid recurrence rule.')).toEqual([400, 'Invalid recurrence rule.']);
    expect(await statusOf(412, 'Precondition Failed')).toEqual([409, 'Precondition Failed']);
    expect(await statusOf(503, 'Backend Error')).toEqual([502, 'Backend Error']);
    expect(await statusOf(403, 'Request had insufficient authentication scopes.')).toEqual([403, `${ME} has not allowed this; connect it again with that feature turned on`]);
  });

  test('event reads follow every page and carry the calendar’s access role', async () => {
    const { data, calls } = google((call) => {
      if (!call.path.endsWith('/events')) return ok({});
      return call.query.pageToken
        ? ok({ accessRole: 'reader', items: [{ id: 'b', summary: 'B', start: { dateTime: '2026-10-26T18:00:00Z' }, end: { dateTime: '2026-10-26T19:00:00Z' } }] })
        : ok({ accessRole: 'reader', items: [{ id: 'a', summary: 'A', start: { dateTime: '2026-10-26T16:00:00Z' }, end: { dateTime: '2026-10-26T17:00:00Z' } }], nextPageToken: 'n2' });
    });
    const read = await data.events(ME, 'team', '2026-10-26T07:00:00Z', '2026-10-27T07:00:00Z', LA, 'sub1');
    expect(read.events.map((event) => [event.id, event.google?.editable])).toEqual([['sub1:a', false], ['sub1:b', false]]);
    expect(calls.map((call) => call.query.pageToken ?? null)).toEqual([null, 'n2']);
    expect(calls[0]!.query.maxResults).toBe('2500');
  });
});

describe('Google Tasks', () => {
  const LISTS = '/tasks/v1/users/@me/lists';
  test('lists: every page, the default one marked; made, renamed, deleted', async () => {
    const { data, calls, writes } = google((call) => {
      if (call.path === `${LISTS}/@default`) return ok({ id: 'L1' });
      if (call.path === LISTS && call.method === 'GET') return call.query.pageToken ? ok({ items: [{ id: 'L3', title: 'Later' }] }) : ok({ items: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Errands' }], nextPageToken: 'p2' });
      if (call.method === 'DELETE') return { status: 404, body: { error: { message: 'Not Found' } } };
      return ok({ id: 'L9', title: (call.body as { title: string }).title });
    });
    expect(await data.taskLists(ME)).toEqual([
      { account: ME, id: 'L1', title: 'My Tasks', isDefault: true },
      { account: ME, id: 'L2', title: 'Errands', isDefault: false },
      { account: ME, id: 'L3', title: 'Later', isDefault: false },
    ]);
    expect(calls.filter((call) => call.path === LISTS).map((call) => call.query.pageToken ?? null)).toEqual([null, 'p2']);
    expect(await data.createTaskList(ME, 'Groceries')).toEqual({ account: ME, id: 'L9', title: 'Groceries', isDefault: false });
    expect(await data.renameTaskList(ME, 'L9', 'Food')).toEqual({ account: ME, id: 'L9', title: 'Food' });
    await data.deleteTaskList(ME, 'L9');
    expect(writes().map((call) => [call.method, call.path, call.body ?? null])).toEqual([['POST', LISTS, { title: 'Groceries' }], ['PATCH', `${LISTS}/L9`, { title: 'Food' }], ['DELETE', `${LISTS}/L9`, null]]);
  });

  test('a list’s tasks with the completed ones, page after page; a list too long says so', async () => {
    const raw = (id: string, extra = {}) => ({ id, title: id, position: '00000000000000000001', ...extra });
    const { data, calls } = google((call) => (call.query.pageToken === 'p3' ? ok({ items: [raw('c', { status: 'completed', completed: '2026-10-25T08:00:00.000Z' })] }) : call.query.pageToken ? ok({ items: [raw('b', { parent: 'a' })], nextPageToken: 'p3' }) : ok({ items: [raw('a')], nextPageToken: 'p2' })));
    const { tasks, complete } = await data.allTasks(ME, 'L1');
    expect(complete).toBe(true);
    expect(tasks.map((task) => [task.id, task.parent, task.completed, task.completedAt ?? null])).toEqual([['a', null, false, null], ['b', 'a', false, null], ['c', null, true, '2026-10-25T08:00:00.000Z']]);
    expect([calls[0]!.query.showCompleted, calls[0]!.query.showHidden, calls[0]!.query.maxResults]).toEqual(['true', 'true', '100']);
    const endless = google((call) => ok({ items: [raw(`t${call.query.pageToken ?? 0}`)], nextPageToken: `${Number(call.query.pageToken ?? 0) + 1}` }));
    const long = await endless.data.allTasks(ME, 'L1');
    expect([long.complete, long.tasks.length]).toEqual([false, 40]);
    await expect(endless.data.tasks(ME, 'L1')).rejects.toThrow('more than 4000 open tasks');
  });

  test('tasks: made under a parent after a sibling, renamed, moved to another list, deleted', async () => {
    const { data, writes } = google((call) => (call.method === 'DELETE' ? ok() : ok({ id: 'n1', title: 'Milk', parent: call.query.parent, position: '00000000000000000002' })));
    expect(await data.createTask(ME, 'L1', { title: 'Milk', due: '2026-10-27', parent: 'p1', previous: 's1' })).toMatchObject({ id: 'n1', parent: 'p1' });
    await data.updateTask(ME, 'L1', 'n1', { title: 'Oat milk', notes: 'two', due: null });
    await data.moveTask(ME, 'L1', 'n1', { parent: null, previous: 'x1' });
    expect(await data.moveTask(ME, 'L1', 'n1', { parent: null, previous: null, destination: 'L2' })).toMatchObject({ listId: 'L2' });
    await data.deleteTask(ME, 'L2', 'n1');
    expect(writes().map((call) => [call.method, call.path, call.query, call.body ?? null])).toEqual([
      ['POST', '/tasks/v1/lists/L1/tasks', { parent: 'p1', previous: 's1' }, { title: 'Milk', due: '2026-10-27T00:00:00.000Z' }],
      ['PATCH', '/tasks/v1/lists/L1/tasks/n1', {}, { due: null, title: 'Oat milk', notes: 'two' }],
      ['POST', '/tasks/v1/lists/L1/tasks/n1/move', { previous: 'x1' }, null],
      ['POST', '/tasks/v1/lists/L1/tasks/n1/move', { destinationTasklist: 'L2' }, null],
      ['DELETE', '/tasks/v1/lists/L2/tasks/n1', {}, null],
    ]);
  });
});

describe('a fake Google for tests', () => {
  test('only a loopback address replaces Google, path kept', async () => {
    expect(testFetcher(undefined)).toBeNull();
    expect(testFetcher('https://evil.example/')).toBeNull();
    expect(testFetcher('http://10.0.0.1:8080/')).toBeNull();
    expect(testFetcher('http://127.0.0.1:8080/')).not.toBeNull();
  });
});
