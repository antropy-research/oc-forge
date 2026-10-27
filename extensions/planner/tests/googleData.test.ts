import { describe, expect, test } from 'bun:test';
import { GoogleData, toMailItem, toTaskItem } from '../service/googleData.ts';
import type { GoogleAccounts } from '../service/google.ts';
import { GOOGLE_TASKS_CALENDAR, dueTaskEvent, gmailUrl, googleEvent, gtaskSource, isGoogleTaskItem, isMailItem, linkedGoogleTasks, planGoogleTaskSync, taskForGoogleTask, taskFromGoogleTask, taskFromMail, type GoogleTaskItem } from '../src/domain/google.ts';
import { applyEvents, foldEvents } from '../src/domain/reducer.ts';
import { validateCommand, type EventBody, type PlannerEvent } from '../src/domain/events.ts';

let clock = Date.parse('2026-10-25T16:00:00Z');
const ev = (body: EventBody): PlannerEvent => {
  clock += 1000;
  return { v: 1, id: `e${clock}`, at: new Date(clock).toISOString(), ...body } as PlannerEvent;
};

/** A GoogleAccounts stand-in that answers requests from a table, and records them. */
const fakeAccounts = (answer: (method: string, url: string, body?: unknown) => unknown) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const accounts = {
    request: async (_email: string, method: string, url: string, body?: unknown) => {
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      return answer(method, url, body);
    },
  } as unknown as GoogleAccounts;
  return { data: new GoogleData(accounts), calls };
};

describe('Google Calendar events', () => {
  const zone = 'America/Los_Angeles';
  test('timed, all-day, free, cancelled, declined and the Planner’s own sessions', () => {
    expect(googleEvent({ id: 'a', summary: 'Standup', start: { dateTime: '2026-10-26T09:00:00-07:00' }, end: { dateTime: '2026-10-26T09:15:00-07:00' } }, 'cal', zone)).toEqual({
      id: 'cal:a', calendarId: 'cal', title: 'Standup', location: '', start: '2026-10-26T16:00:00.000Z', end: '2026-10-26T16:15:00.000Z', allDay: false, busy: true,
    });
    // An all-day event runs midnight to midnight where the user is, end date exclusive, and blocks nothing.
    expect(googleEvent({ id: 'b', summary: 'Offsite', start: { date: '2026-10-27' }, end: { date: '2026-10-29' } }, 'cal', zone)).toMatchObject({ start: '2026-10-27T07:00:00.000Z', end: '2026-10-29T07:00:00.000Z', allDay: true, busy: false });
    expect(googleEvent({ id: 'c', transparency: 'transparent', start: { dateTime: '2026-10-26T10:00:00Z' }, end: { dateTime: '2026-10-26T11:00:00Z' } }, 'cal', zone)).toMatchObject({ title: '(No title)', busy: false });
    expect(googleEvent({ id: 'd', status: 'cancelled', start: { dateTime: '2026-10-26T10:00:00Z' } }, 'cal', zone)).toBeNull();
    // Declined stays on the calendar, as Google Calendar shows it, but blocks no time.
    const declined = googleEvent({ id: 'e', attendees: [{ self: true, responseStatus: 'declined' }], organizer: { email: 'ann@x.com' }, start: { dateTime: '2026-10-26T10:00:00Z' }, end: { dateTime: '2026-10-26T11:00:00Z' } }, 'cal', zone, { account: 'me@x.com', calendarId: 'primary', accessRole: 'owner' });
    expect(declined).toMatchObject({ busy: false, google: { account: 'me@x.com', calendarId: 'primary', eventId: 'e', response: 'declined', editable: false } });
    expect(googleEvent({ id: 'f', extendedProperties: { private: { plannerBlockId: 'blk' } }, start: { dateTime: '2026-10-26T10:00:00Z' } }, 'cal', zone)).toBeNull();
  });

  test('what may be done with an event: its calendar, its organizer, its kind', () => {
    const at = { start: { dateTime: '2026-10-26T10:00:00Z' }, end: { dateTime: '2026-10-26T11:00:00Z' } };
    const ref = (raw: Parameters<typeof googleEvent>[0], accessRole: string) => googleEvent({ ...at, ...raw }, 'cal', zone, { account: 'me@x.com', calendarId: 'primary', accessRole })?.google;
    expect(ref({ id: 'mine', organizer: { email: 'me@x.com', self: true } }, 'owner')).toMatchObject({ editable: true, response: null, guests: false });
    expect(ref({ id: 'ro', organizer: { email: 'me@x.com', self: true } }, 'reader')?.editable).toBe(false);
    expect(ref({ id: 'invite', organizer: { email: 'ann@x.com' }, attendees: [{ email: 'me@x.com', self: true, responseStatus: 'needsAction' }, { email: 'ann@x.com', organizer: true, responseStatus: 'accepted' }] }, 'owner')).toMatchObject({ editable: false, response: 'needsAction', guests: true });
    expect(ref({ id: 'open', organizer: { email: 'ann@x.com' }, guestsCanModify: true }, 'owner')?.editable).toBe(true);
    expect(ref({ id: 'bday', eventType: 'birthday' }, 'owner')?.editable).toBe(false);
    expect(ref({ id: 'colored', colorId: '11', hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://www.google.com/calendar/event?eid=x' }, 'owner')).toMatchObject({ color: '#d50000', meet: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://www.google.com/calendar/event?eid=x' });
    expect(ref({ id: 'series_20261026T100000Z', recurringEventId: 'series' }, 'writer')).toMatchObject({ recurringEventId: 'series', editable: true });
  });
  test('reading a calendar keeps events and the Planner sessions apart; sessions are written as events', async () => {
    const { data, calls } = fakeAccounts((method, url) => {
      if (method === 'GET') {
        return {
          items: [
            { id: 'm', summary: 'Meeting', start: { dateTime: '2026-10-26T17:00:00Z' }, end: { dateTime: '2026-10-26T18:00:00Z' } },
            { id: 's', summary: 'Write tests', start: { dateTime: '2026-10-26T19:00:00Z' }, end: { dateTime: '2026-10-26T20:00:00Z' }, extendedProperties: { private: { plannerBlockId: 'blk1' } } },
          ],
        };
      }
      return { id: url.endsWith('/events') ? 'new-event' : 'old-event' };
    });
    const read = await data.events('me@x.com', 'primary', '2026-10-26T07:00:00Z', '2026-10-27T07:00:00Z', 'UTC', 'sub1');
    expect(read.events.map((event) => event.id)).toEqual(['sub1:m']);
    expect(read.sessions).toEqual([{ blockId: 'blk1', eventId: 's', start: '2026-10-26T19:00:00.000Z', end: '2026-10-26T20:00:00.000Z' }]);
    expect(new URL(calls[0]!.url).searchParams.get('singleEvents')).toBe('true');
    const timebox = { blockId: 'blk2', taskId: 't1', title: 'Write tests', start: '2026-10-26T21:00:00.000Z', end: '2026-10-26T22:00:00.000Z' };
    expect(await data.putTimebox('me@x.com', 'primary', timebox, null)).toBe('new-event');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { summary: 'Write tests', extendedProperties: { private: { plannerBlockId: 'blk2', plannerTaskId: 't1' } }, reminders: { useDefault: false } } });
    expect(await data.putTimebox('me@x.com', 'primary', timebox, 'old-event')).toBe('old-event');
    expect(calls.at(-1)!.method).toBe('PATCH');
    expect(calls.at(-1)!.url).toEndWith('/calendars/primary/events/old-event');
  });
});

describe('Google Tasks', () => {
  const raw = { id: 'gt1', title: ' Buy milk ', notes: 'two', due: '2026-10-30T00:00:00.000Z', status: 'needsAction', position: '00002', webViewLink: 'https://tasks.google.com/task/gt1', updated: '2026-10-25T10:00:00Z' };
  const item = (patch: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({ ...toTaskItem(raw, 'me@x.com', 'L1')!, ...patch });
  test('a task as the Planner reads it', () => {
    expect(item()).toEqual({ account: 'me@x.com', listId: 'L1', id: 'gt1', title: 'Buy milk', notes: 'two', due: '2026-10-30', completed: false, parent: null, position: '00002', url: 'https://tasks.google.com/task/gt1', updated: '2026-10-25T10:00:00Z' });
    expect(toTaskItem({ id: 'x', deleted: true }, 'me@x.com', 'L1')).toBeNull();
    expect(isGoogleTaskItem(item())).toBe(true);
    expect(isGoogleTaskItem({ ...item(), url: 'javascript:x' })).toBe(false);
  });
  test('lists read in order; completing and due dates write back', async () => {
    const { data, calls } = fakeAccounts((method) => (method === 'GET' ? { items: [{ ...raw, id: 'b', position: '00005' }, { ...raw, id: 'a', position: '00001' }] } : { ...raw, status: 'completed' }));
    expect((await data.tasks('me@x.com', 'L1')).map((task) => task.id)).toEqual(['a', 'b']);
    expect(calls[0]!.url).toContain('showCompleted=false');
    expect((await data.updateTask('me@x.com', 'L1', 'gt1', { completed: true }))?.completed).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'completed' } });
    await data.updateTask('me@x.com', 'L1', 'gt1', { due: '2026-11-02' });
    expect(calls.at(-1)!.body).toEqual({ due: '2026-11-02T00:00:00.000Z' });
    await data.updateTask('me@x.com', 'L1', 'gt1', { completed: false, due: null });
    expect(calls.at(-1)!.body).toEqual({ status: 'needsAction', completed: null, due: null });
  });
  test('tasks due in a range come from every list, completed ones too, and show on their day all day long', async () => {
    const { data, calls } = fakeAccounts((_method, url) => {
      if (url.includes('/users/@me/lists/%40default')) return { id: 'L1' };
      if (url.includes('/users/@me/lists?')) return { items: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Work' }] };
      if (url.includes('/lists/L1/')) return { items: [{ ...raw, id: 'in', due: '2026-10-28T00:00:00.000Z' }, { ...raw, id: 'late', due: '2026-11-09T00:00:00.000Z' }] };
      return { items: [{ ...raw, id: 'done', status: 'completed', completed: '2026-10-27T18:00:00.000Z', due: '2026-10-27T00:00:00.000Z' }, { ...raw, id: 'nodate', due: undefined }] };
    });
    const due = await data.dueTasks('me@x.com', '2026-10-26', '2026-11-01');
    expect(due.map((task) => [task.id, task.completed])).toEqual([['in', false], ['done', true]]);
    expect(due[1]!.completedAt).toBe('2026-10-27T18:00:00.000Z');
    const query = new URL(calls.find((call) => call.url.includes('/lists/L1/'))!.url).searchParams;
    // Tasks completed in Google's own apps are hidden ones: those are asked for too.
    expect([query.get('dueMin'), query.get('dueMax'), query.get('showCompleted'), query.get('showHidden')]).toEqual(['2026-10-26T00:00:00.000Z', '2026-11-01T23:59:59.999Z', 'true', 'true']);
    const event = dueTaskEvent({ ...due[0]!, due: '2026-10-28' }, 'America/Los_Angeles');
    expect(event).toMatchObject({ calendarId: GOOGLE_TASKS_CALENDAR, title: 'Buy milk', start: '2026-10-28T07:00:00.000Z', end: '2026-10-29T07:00:00.000Z', allDay: true, busy: false, googleTask: { id: 'in' } });
  });

  test('a linked task follows a rename and, when asked, a completion; it is planned once', () => {
    const state = foldEvents([ev({ type: 'task.created', task: taskFromGoogleTask(item(), 't1', { kind: 'day', date: '2026-10-25' }, 1) })]);
    expect(state.tasks.t1).toMatchObject({ title: 'Buy milk', notes: 'two', dueDate: '2026-10-30', source: { kind: 'gtask', account: 'me@x.com', listId: 'L1' } });
    expect(validateCommand({ cmd: 'g1', type: 'task.updated', taskId: 't1', patch: { source: gtaskSource(item()) } }, state)).toBeNull();
    expect(taskForGoogleTask(state, { id: 'gt1' })?.id).toBe('t1');
    expect(linkedGoogleTasks(state)).toEqual([{ account: 'me@x.com', listId: 'L1', ids: ['gt1'] }]);
    const options = { today: '2026-10-25', importCompletion: true };
    expect(planGoogleTaskSync(state, new Map([['gt1', item()]]), options)).toEqual({ bodies: [], writes: [], conflicts: [] });
    const renamed = planGoogleTaskSync(state, new Map([['gt1', item({ title: 'Buy oat milk' })]]), options);
    expect(renamed.bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item({ title: 'Buy oat milk' })), title: 'Buy oat milk' }]);
    const done = planGoogleTaskSync(state, new Map([['gt1', item({ completed: true })]]), options);
    expect(done.bodies.map((body) => body.type)).toEqual(['task.sourceSynced', 'task.completed']);
    expect(planGoogleTaskSync(state, new Map([['gt1', item({ completed: true })]]), { ...options, importCompletion: false }).bodies.map((body) => body.type)).toEqual(['task.sourceSynced']);
    // Renamed on both sides: the newer change wins, here the Planner's (made after Google's), which goes to Google.
    const mine = applyEvents(state, [ev({ type: 'task.updated', taskId: 't1', patch: { title: 'My milk' } })]);
    const both = planGoogleTaskSync(mine, new Map([['gt1', item({ title: 'Buy oat milk' })]]), { ...options, editedAt: () => mine.tasks.t1!.updatedAt });
    expect(both.bodies).toEqual([{ type: 'task.sourceSynced', taskId: 't1', source: gtaskSource(item({ title: 'Buy oat milk' })) }]);
    expect(both.writes).toEqual([{ taskId: 't1', account: 'me@x.com', listId: 'L1', id: 'gt1', patch: { title: 'My milk' } }]);
    expect(both.conflicts).toEqual([{ taskId: 't1', fields: ['title'] }]);
  });
});

describe('Gmail', () => {
  const raw = {
    id: 'm1',
    threadId: 't9',
    snippet: 'Can you review &quot;the plan&quot; &amp; reply?',
    internalDate: String(Date.parse('2026-10-25T08:00:00Z')),
    labelIds: ['INBOX', 'UNREAD'],
    payload: { headers: [{ name: 'Subject', value: 'Plan review' }, { name: 'From', value: 'Ann <ann@x.com>' }] },
  };
  test('a message as the Planner reads it, and as a task', () => {
    const item = toMailItem(raw, 'me@x.com')!;
    expect(item).toEqual({ account: 'me@x.com', id: 'm1', threadId: 't9', subject: 'Plan review', from: 'Ann <ann@x.com>', date: '2026-10-25T08:00:00.000Z', snippet: 'Can you review "the plan" & reply?', unread: true, url: gmailUrl('me@x.com', 't9') });
    expect(item.url).toBe('https://mail.google.com/mail/u/me%40x.com/#all/t9');
    expect(isMailItem(item)).toBe(true);
    const task = taskFromMail(item, 't1', { kind: 'day', date: '2026-10-25' }, 1);
    expect(task).toMatchObject({ title: 'Plan review', notes: 'From Ann <ann@x.com>\n\nCan you review "the plan" & reply?', source: { kind: 'email', id: 'm1', key: 'Email', account: 'me@x.com' } });
    const state = foldEvents([ev({ type: 'task.created', task })]);
    expect(state.tasks.t1!.source?.url).toBe(item.url);
  });
  test('a search reads each message’s headers, newest first', async () => {
    const { data, calls } = fakeAccounts((_method, url) => {
      if (url.includes('/messages?')) return { messages: [{ id: 'old' }, { id: 'new' }] };
      const id = /messages\/(\w+)\?/.exec(url)![1]!;
      return { ...raw, id, internalDate: String(id === 'new' ? Date.parse('2026-10-25T09:00:00Z') : Date.parse('2026-10-24T09:00:00Z')) };
    });
    const page = await data.mail('me@x.com', 'in:inbox');
    expect(page.messages.map((item) => item.id)).toEqual(['new', 'old']);
    expect(page.nextPageToken).toBeNull();
    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('in:inbox');
    expect(calls[1]!.url).toContain('format=metadata');
  });

  test('a search goes on from where the last page ended', async () => {
    const { data, calls } = fakeAccounts((_method, url) => (url.includes('/messages?') ? { messages: [{ id: 'a' }], nextPageToken: url.includes('pageToken=p2') ? undefined : 'p2' } : { ...raw, id: 'a' }));
    expect((await data.mail('me@x.com', 'in:inbox')).nextPageToken).toBe('p2');
    const second = await data.mail('me@x.com', 'in:inbox', 'p2');
    expect(new URL(calls.at(-2)!.url).searchParams.get('pageToken')).toBe('p2');
    expect(second.nextPageToken).toBeNull();
  });
});
