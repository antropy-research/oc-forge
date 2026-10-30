// A fake Google on a loopback port, for the Planner service started with
// PLANNER_GOOGLE_API_BASE=<base>: OAuth tokens (a sign-in's code grants the
// scopes it asked for, on top of the ones granted before, and its ID token says
// the account's work or school domain), user info, Google Calendar (calendar
// list; events with weekly and daily series, their occurrences and exceptions;
// insert, patch, delete, move, instances), Google Tasks (lists, tasks with
// subtasks and order, move between lists), each list in pages, and Google
// Drive's file search (only with the Drive scope), Gmail (a search's messages with
// their labels, by words and the in:/is:/label: terms; threads with their text;
// labels; and, with gmail.modify, a thread's labels changed or trashed), and the
// People API's contact searches (with the contacts scopes). Every request is
// logged in `requests`. Used by tests/googleService.test.ts and the e2e journeys.
import http from 'node:http';

const pad = (n, width = 2) => String(n).padStart(width, '0');
const dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Wall-clock fields of an instant in a zone. */
const zoned = (ms, zone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return { date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, seconds: (parts.hour % 24) * 3600 + parts.minute * 60 + parts.second };
};
/** The instant of a wall-clock time in a zone. */
const instant = (date, seconds, zone) => {
  const [y, m, d] = date.split('-').map(Number);
  const local = Date.UTC(y, m - 1, d) + seconds * 1000;
  let guess = local;
  for (let i = 0; i < 3; i++) {
    const seen = zoned(guess, zone);
    const [sy, sm, sd] = seen.date.split('-').map(Number);
    guess += local - (Date.UTC(sy, sm - 1, sd) + seen.seconds * 1000);
  }
  return guess;
};
const addDays = (date, days) => dateKey(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const timeMs = (time) => (time?.date ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time?.dateTime ?? ''));
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Occurrence starts (ms) of a series, in its zone's wall clock, through `untilMs`. */
const occurrences = (event, untilMs, defaultZone) => {
  const line = (event.recurrence ?? []).find((item) => item.startsWith('RRULE:'));
  if (!line) return [];
  const rule = Object.fromEntries(line.slice(6).split(';').map((part) => part.split('=')));
  const allDay = Boolean(event.start.date);
  const zone = event.start.timeZone ?? defaultZone;
  const first = allDay ? { date: event.start.date, seconds: 0 } : zoned(timeMs(event.start), zone);
  const interval = Number(rule.INTERVAL ?? 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? (rule.UNTIL.length === 8 ? Date.parse(`${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}T23:59:59Z`) : Date.parse(rule.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))) : Infinity;
  const exdates = new Set((event.recurrence ?? []).filter((item) => item.startsWith('EXDATE')).flatMap((item) => item.split(':')[1].split(',')));
  const out = [];
  const startOf = (date) => (allDay ? Date.parse(`${date}T00:00:00Z`) : instant(date, first.seconds, zone));
  const days = rule.FREQ === 'WEEKLY' ? (rule.BYDAY ? rule.BYDAY.split(',').map((code) => DAYS.indexOf(code.slice(-2))) : [new Date(`${first.date}T00:00:00Z`).getUTCDay()]) : null;
  let produced = 0;
  for (let step = 0; step < 2000 && produced < count; step++) {
    const dates = [];
    if (rule.FREQ === 'DAILY') dates.push(addDays(first.date, step * interval));
    else if (rule.FREQ === 'WEEKLY') {
      const weekStart = addDays(first.date, -new Date(`${first.date}T00:00:00Z`).getUTCDay() + step * 7 * interval);
      for (const day of [...days].sort()) dates.push(addDays(weekStart, day));
    } else if (rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') {
      const [y, m, d] = first.date.split('-').map(Number);
      const months = rule.FREQ === 'MONTHLY' ? step * interval : step * 12 * interval;
      const target = new Date(Date.UTC(y, m - 1 + months, d));
      if (target.getUTCDate() === d) dates.push(dateKey(target.getTime()));
    } else break;
    let stop = false;
    for (const date of dates) {
      if (date < first.date) continue;
      const ms = startOf(date);
      if (ms > until || ms > untilMs || produced >= count) {
        stop = true;
        break;
      }
      produced++;
      if (!exdates.has(allDay ? date.replace(/-/g, '') : stamp(ms))) out.push(ms);
    }
    if (stop) break;
  }
  return out;
};

/** What the account allowed the Planner unless a world says: Calendar, Tasks and Gmail. */
export const DEFAULT_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks', 'https://www.googleapis.com/auth/gmail.readonly'];
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const CONTACTS_SCOPES = ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts.other.readonly'];
/** The code Google's redirect carries in this fake: the scopes the sign-in asked for, so the token answer grants them. */
export const fakeAuthCode = (scope) => Buffer.from(JSON.stringify({ scope })).toString('base64url');

export const defaultFakeWorld = ({ account = 'harness@example.com', today = new Date().toISOString().slice(0, 10), zone = 'America/Los_Angeles' } = {}) => {
  const at = (days, hour, minute = 0) => new Date(instant(addDays(today, days), hour * 3600 + minute * 60, zone)).toISOString();
  return {
    account,
    zone,
    /** Small pages, so every list is read across several of them. */
    pageSize: { calendarList: 2, events: 8, lists: 1, tasks: 2 },
    calendars: [
      { id: 'primary', summary: account, accessRole: 'owner', backgroundColor: '#039be5', primary: true },
      { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', backgroundColor: '#33b679' },
      { id: 'holidays', summary: 'Holidays', accessRole: 'reader', backgroundColor: '#0b8043' },
    ],
    events: {
      primary: [
        { id: 'planning', summary: 'Quarter planning', description: '<b>Agenda</b><br>Goals<br>Budget', location: 'Room 4', start: { dateTime: at(0, 14) }, end: { dateTime: at(0, 15) }, organizer: { email: account, self: true }, attendees: [{ email: account, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', displayName: 'Ann Lee', responseStatus: 'accepted' }, { email: 'bo@example.com', responseStatus: 'needsAction' }], hangoutLink: 'https://meet.google.com/abc-defg-hij', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } },
        { id: 'invite', summary: 'Vendor demo', start: { dateTime: at(1, 11) }, end: { dateTime: at(1, 12) }, organizer: { email: 'vendor@example.com', displayName: 'Vendor' }, attendees: [{ email: 'vendor@example.com', organizer: true, responseStatus: 'accepted' }, { email: account, self: true, responseStatus: 'needsAction' }] },
        { id: 'standup', summary: 'Standup', start: { dateTime: at(-14, 9), timeZone: zone }, end: { dateTime: at(-14, 9, 15), timeZone: zone }, recurrence: ['RRULE:FREQ=DAILY'], organizer: { email: account, self: true } },
        { id: 'offsite', summary: 'Team offsite', start: { date: addDays(today, 2) }, end: { date: addDays(today, 4) }, organizer: { email: account, self: true } },
      ],
      'team@group.calendar.google.com': [{ id: 'retro', summary: 'Sprint retro', start: { dateTime: at(3, 16) }, end: { dateTime: at(3, 17) }, organizer: { email: 'team@group.calendar.google.com', self: true } }],
      holidays: [{ id: 'holiday', summary: 'Founders day', start: { date: addDays(today, 5) }, end: { date: addDays(today, 6) }, organizer: { email: 'holidays' } }],
    },
    lists: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Errands' }],
    defaultList: 'L1',
    tasks: {
      L1: [
        { id: 't-report', title: 'Send the report', notes: 'To Ann, with the numbers', due: `${today}T00:00:00.000Z`, status: 'needsAction' },
        { id: 't-trip', title: 'Plan the trip', notes: '', due: `${addDays(today, 3)}T00:00:00.000Z`, status: 'needsAction' },
        { id: 't-hotel', title: 'Book the hotel', notes: '', status: 'needsAction', parent: 't-trip' },
        { id: 't-old', title: 'Renew the badge', notes: '', due: `${addDays(today, -1)}T00:00:00.000Z`, status: 'completed', completed: at(-1, 15) },
      ],
      L2: [{ id: 't-stamps', title: 'Buy stamps', notes: '', status: 'needsAction' }],
    },
  };
};

/** Start the fake on a free loopback port. */
export const startFakeGoogle = async (world = defaultFakeWorld()) => {
  const requests = [];
  let next = 1;
  const id = (prefix) => `${prefix}${next++}`;
  // Calendar events: masters and singles by calendar; exceptions by occurrence id.
  const calendars = new Map(world.calendars.map((calendar) => [calendar.id, { ...calendar, events: new Map((world.events[calendar.id] ?? []).map((event) => [event.id, structuredClone(event)])), exceptions: new Map() }]));
  const lists = world.lists.map((list) => ({ ...list }));
  // A world's task may say when it was last changed (`updated`); else now.
  const tasks = new Map(world.lists.map((list) => [list.id, (world.tasks[list.id] ?? []).map((task) => ({ updated: new Date().toISOString(), ...structuredClone(task) }))]));
  const fail = { next: null };
  /** Tasks deleted, by id: their list, the task and where it was, for an undelete (PATCH deleted: false). */
  const trash = new Map();
  /** Requests held a while before they are answered (and before what they change changes), as a slow Google holds them. */
  const slow = [];

  // Google keeps an order among siblings; positions are 20-digit numbers, rewritten here on each change.
  const renumber = (listId) => {
    const all = tasks.get(listId) ?? [];
    const groups = new Map();
    for (const task of all) groups.set(task.parent ?? '', [...(groups.get(task.parent ?? '') ?? []), task]);
    for (const group of groups.values()) group.forEach((task, index) => (task.position = pad(index + 1, 20)));
  };
  for (const list of lists) renumber(list.id);
  const place = (listId, task, parent, previous) => {
    const all = tasks.get(listId).filter((other) => other !== task);
    task.parent = parent || undefined;
    const siblings = all.filter((other) => (other.parent ?? '') === (parent ?? ''));
    const at = previous ? all.indexOf(siblings.find((other) => other.id === previous)) + 1 : all.indexOf(siblings[0]) >= 0 ? all.indexOf(siblings[0]) : all.length;
    all.splice(Math.max(0, at), 0, task);
    tasks.set(listId, all);
    renumber(listId);
  };
  const publicTask = (task) => ({ kind: 'tasks#task', ...task, webViewLink: `https://tasks.google.com/task/${task.id}` });

  const occurrenceId = (event, ms) => (event.start.date ? `${event.id}_${dateKey(ms).replace(/-/g, '')}` : `${event.id}_${stamp(ms)}`);
  const occurrence = (calendar, event, ms) => {
    const key = occurrenceId(event, ms);
    const exception = calendar.exceptions.get(key);
    if (exception) return exception;
    const length = timeMs(event.end) - timeMs(event.start);
    const time = (value) => (event.start.date ? { date: dateKey(value) } : { dateTime: new Date(value).toISOString(), ...(event.start.timeZone ? { timeZone: event.start.timeZone } : {}) });
    const { recurrence: _rule, ...rest } = event;
    return { ...structuredClone(rest), id: key, recurringEventId: event.id, originalStartTime: time(ms), start: time(ms), end: time(ms + length) };
  };
  const withLinks = (calendarId, event) => ({ ...event, htmlLink: `https://www.google.com/calendar/event?eid=${encodeURIComponent(event.id)}`, ...(event.organizer ? {} : { organizer: { email: calendarId, self: true } }) });
  const findEvent = (calendar, eventId) => {
    if (calendar.events.has(eventId)) return { kind: 'event', event: calendar.events.get(eventId) };
    if (calendar.exceptions.has(eventId)) return { kind: 'exception', event: calendar.exceptions.get(eventId) };
    const cut = eventId.lastIndexOf('_');
    const master = cut > 0 ? calendar.events.get(eventId.slice(0, cut)) : null;
    if (!master) return null;
    const ms = occurrences(master, Date.parse('2100-01-01'), world.zone).find((value) => occurrenceId(master, value) === eventId);
    return ms === undefined ? null : { kind: 'occurrence', event: occurrence(calendar, master, ms), master };
  };
  const applyConference = (event, body, query) => {
    if (query.get('conferenceDataVersion') !== '1' || !('conferenceData' in body)) return;
    if (body.conferenceData === null) {
      delete event.conferenceData;
      delete event.hangoutLink;
    } else if (body.conferenceData?.createRequest) {
      const code = `fak-${pad(next++, 4)}-mee`;
      event.hangoutLink = `https://meet.google.com/${code}`;
      event.conferenceData = { conferenceSolution: { name: 'Google Meet' }, entryPoints: [{ entryPointType: 'video', uri: event.hangoutLink }] };
    }
  };
  const page = (items, query, kind, extra = {}) => {
    const key = 'items';
    const size = Number(query.get('maxResults') ?? 100) || 100;
    const step = Math.min(size, world.pageSize?.[kind] ?? size);
    const from = Number(query.get('pageToken') ?? 0);
    const slice = items.slice(from, from + step);
    return { ...extra, [key]: slice, ...(from + step < items.length ? { nextPageToken: String(from + step) } : {}) };
  };

  const answer = (method, path, query, body) => {
    if (fail.next && fail.next.method === method && path.includes(fail.next.path)) {
      const { status, message } = fail.next;
      fail.next = null;
      return [status, { error: { code: status, message } }];
    }
    // Access taken back (a password changed, the Planner removed in the account's permissions): every token and every
    // request is refused, as Google refuses them.
    if (world.revoked && path !== '/revoke') return path === '/token' ? [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }] : [401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }];
    if (path === '/token' && body.grant_type === 'authorization_code') {
      // A sign-in: Google keeps what the account granted before (include_granted_scopes) and adds what it just allowed,
      // and says who it is in the ID token (`hd`: a work or school account's domain).
      let asked = [];
      try {
        asked = String(JSON.parse(Buffer.from(String(body.code ?? ''), 'base64url').toString('utf8')).scope ?? '').split(' ').filter(Boolean);
      } catch {
        asked = [];
      }
      world.granted = [...new Set([...(world.granted ?? DEFAULT_SCOPES), ...asked])];
      const claims = { email: world.account, email_verified: true, ...(world.hostedDomain ? { hd: world.hostedDomain } : {}) };
      return [200, { access_token: `fake-${next++}`, expires_in: 3600, token_type: 'Bearer', refresh_token: `fake-refresh-${next++}`, scope: world.granted.join(' '), id_token: ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.') }];
    }
    if (path === '/token') return [200, { access_token: `fake-${next++}`, expires_in: 3600, token_type: 'Bearer' }];
    if (path === '/revoke') return [200, {}];
    if (path === '/oauth2/v3/userinfo' && method === 'GET') return [200, { sub: '1', email: world.account, email_verified: true, ...(world.hostedDomain ? { hd: world.hostedDomain } : {}) }];
    // Gmail: a message's labels are Gmail's own (INBOX, UNREAD, STARRED, SPAM, TRASH…) and the user's (`world.mailLabels`,
    // by id); a message says only `unread` until something changes them.
    const granted = () => world.granted ?? DEFAULT_SCOPES;
    const labelsOf = (message) => (message.labels ??= message.unread ? ['UNREAD', 'INBOX'] : ['INBOX']);
    const slug = (name) => name.toLowerCase().replace(/[\s/]+/g, '-');
    const SYSTEM = { inbox: 'INBOX', unread: 'UNREAD', starred: 'STARRED', important: 'IMPORTANT', spam: 'SPAM', trash: 'TRASH', sent: 'SENT', drafts: 'DRAFT' };
    /** Gmail's search, as far as the Planner sends it: words of the subject, sender or snippet, and in:/is:/label: terms; spam and trash only with in:anywhere (or in:spam, in:trash). */
    const matches = (message, q) => {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const labels = labelsOf(message);
      if (!terms.some((term) => ['in:anywhere', 'in:spam', 'in:trash'].includes(term)) && (labels.includes('SPAM') || labels.includes('TRASH'))) return false;
      return terms.every((term) => {
        const [kind, value] = /^(in|is|label):(.+)$/.exec(term)?.slice(1) ?? [null, term];
        if (kind === 'in' && value === 'anywhere') return true;
        if (kind === 'in' || kind === 'is') return SYSTEM[value] ? labels.includes(SYSTEM[value]) : true;
        if (kind === 'label') return (world.mailLabels ?? []).some((label) => slug(label.name) === value && labels.includes(label.id));
        return `${message.subject} ${message.from} ${message.snippet}`.toLowerCase().includes(term);
      });
    };
    if (path === '/gmail/v1/users/me/messages' && method === 'GET') {
      const found = (world.mail ?? []).filter((message) => matches(message, query.get('q') ?? ''));
      return [200, { messages: found.map((message) => ({ id: message.id, threadId: message.threadId })), resultSizeEstimate: found.length }];
    }
    if (path === '/gmail/v1/users/me/labels' && method === 'GET') {
      const system = ['INBOX', 'STARRED', 'IMPORTANT', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'CATEGORY_SOCIAL', 'CHAT'].map((id) => ({ id, name: id, type: 'system' }));
      return [200, { labels: [...system, ...(world.mailLabels ?? []).map((label) => ({ ...label, type: 'user' }))] }];
    }
    const base64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
    const rawMessage = (message) => ({
      id: message.id,
      threadId: message.threadId,
      snippet: message.snippet,
      internalDate: String(Date.parse(message.date)),
      labelIds: [...labelsOf(message)],
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: message.subject }, { name: 'From', value: message.from }, { name: 'To', value: world.account }, { name: 'Date', value: message.date }],
        parts: [
          { mimeType: 'text/plain', body: { data: base64url(message.body ?? message.snippet ?? '') } },
          { mimeType: 'text/html', body: { data: base64url(`<p>${message.body ?? message.snippet ?? ''}</p>`) } },
        ],
      },
    });
    // A thread's labels changed, or the thread trashed: Gmail's conversation actions (gmail.modify, never a delete).
    const threadAction = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/(modify|trash)$/.exec(path);
    if (threadAction && method === 'POST') {
      if (!granted().includes(GMAIL_MODIFY_SCOPE)) return [403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } }];
      const messages = (world.mail ?? []).filter((one) => one.threadId === decodeURIComponent(threadAction[1]));
      if (!messages.length) return [404, { error: { message: 'Not Found' } }];
      const add = threadAction[2] === 'trash' ? ['TRASH'] : [].concat(body.addLabelIds ?? []);
      const remove = threadAction[2] === 'trash' ? ['INBOX'] : [].concat(body.removeLabelIds ?? []);
      const known = new Set([...Object.values(SYSTEM), ...(world.mailLabels ?? []).map((label) => label.id)]);
      const unknown = [...add, ...remove].find((label) => !known.has(label));
      if (unknown) return [400, { error: { code: 400, message: `Invalid label: ${unknown}` } }];
      for (const message of messages) message.labels = [...new Set([...labelsOf(message).filter((label) => !remove.includes(label)), ...add])];
      return [200, { id: decodeURIComponent(threadAction[1]), messages: messages.map((message) => ({ id: message.id, threadId: message.threadId, labelIds: [...message.labels] })) }];
    }
    // The People API: people of the contacts, and those emailed ("other contacts"), whose name or address starts so.
    const people = /^\/v1\/(people:searchContacts|otherContacts:search)$/.exec(path);
    if (people && method === 'GET') {
      if (!CONTACTS_SCOPES.every((scope) => granted().includes(scope))) return [403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } }];
      const q = (query.get('query') ?? '').toLowerCase();
      const all = people[1] === 'people:searchContacts' ? world.contacts ?? [] : world.otherContacts ?? [];
      const found = q ? all.filter((person) => [person.name, person.email].some((text) => text.toLowerCase().split(/[\s@.]+/).some((word) => word.startsWith(q)) || text.toLowerCase().startsWith(q))) : [];
      return [200, { results: found.map((person) => ({ person: { names: person.name ? [{ displayName: person.name }] : [], emailAddresses: [{ value: person.email }] } })) }];
    }
    const mailMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (mailMatch && method === 'GET') {
      const message = (world.mail ?? []).find((one) => one.id === decodeURIComponent(mailMatch[1]));
      if (!message) return [404, { error: { message: 'Not Found' } }];
      return [200, rawMessage(message)];
    }
    // A thread: its messages, oldest first, as Gmail gives them (what a pasted thread address opens).
    const threadMatch = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path);
    if (threadMatch && method === 'GET') {
      const messages = (world.mail ?? []).filter((one) => one.threadId === decodeURIComponent(threadMatch[1])).sort((a, b) => a.date.localeCompare(b.date));
      if (!messages.length) return [404, { error: { message: 'Not Found' } }];
      return [200, { id: decodeURIComponent(threadMatch[1]), messages: messages.map(rawMessage) }];
    }
    // Google Drive: file names, types and addresses, by a part of the name (Drive's `name contains '…'`), newest first.
    if (path === '/drive/v3/files' && method === 'GET') {
      if (!(world.granted ?? DEFAULT_SCOPES).includes(DRIVE_SCOPE)) return [403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } }];
      const q = query.get('q') ?? '';
      const name = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const files = (world.driveFiles ?? [])
        .filter((file) => !file.trashed && file.mimeType !== 'application/vnd.google-apps.folder' && (!name || file.name.toLowerCase().includes(name.toLowerCase())))
        .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
      const [from, size] = [Number(query.get('pageToken') ?? 0), Number(query.get('pageSize') ?? 100)];
      return [200, { files: files.slice(from, from + size).map(({ trashed: _trashed, ...file }) => file), ...(from + size < files.length ? { nextPageToken: String(from + size) } : {}) }];
    }
    // Google Calendar
    if (path === '/calendar/v3/users/me/calendarList' && method === 'GET') return [200, page(world.calendars.map(({ id: calendarId, summary, accessRole, backgroundColor, primary }) => ({ id: calendarId, summary, accessRole, backgroundColor, ...(primary ? { primary } : {}) })), query, 'calendarList')];
    let match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?(?:\/(instances|move))?$/.exec(path);
    if (match) {
      const calendar = calendars.get(decodeURIComponent(match[1]));
      if (!calendar) return [404, { error: { message: 'Not Found' } }];
      const eventId = match[2] ? decodeURIComponent(match[2]) : null;
      const from = Date.parse(query.get('timeMin') ?? '1970-01-01T00:00:00Z');
      const to = Date.parse(query.get('timeMax') ?? '2100-01-01T00:00:00Z');
      if (!eventId && method === 'GET') {
        const items = [];
        for (const event of calendar.events.values()) {
          if (event.status === 'cancelled') continue;
          if (event.recurrence?.length) {
            for (const ms of occurrences(event, to, world.zone)) {
              const item = occurrence(calendar, event, ms);
              if (item.status !== 'cancelled' && timeMs(item.end) > from && timeMs(item.start) < to) items.push(withLinks(calendar.id, item));
            }
          } else if (timeMs(event.end) > from && timeMs(event.start) < to) items.push(withLinks(calendar.id, event));
        }
        items.sort((a, b) => timeMs(a.start) - timeMs(b.start));
        // q: Google's free-text search over the title, place, description and guests.
        const q = query.get('q')?.toLowerCase();
        const found = q ? items.filter((item) => [item.summary, item.location, item.description, ...(item.attendees ?? []).flatMap((guest) => [guest.email, guest.displayName])].some((text) => typeof text === 'string' && text.toLowerCase().includes(q))) : items;
        return [200, page(found, query, 'events', { accessRole: calendar.accessRole, timeZone: world.zone })];
      }
      if (!eventId && method === 'POST') {
        const event = { ...structuredClone(body), id: id('ev'), organizer: { email: calendar.id === 'primary' ? world.account : calendar.id, self: true }, status: 'confirmed', created: new Date().toISOString() };
        delete event.conferenceData;
        applyConference(event, body, query);
        calendar.events.set(event.id, event);
        return [200, withLinks(calendar.id, event)];
      }
      if (eventId && match[3] === 'instances' && method === 'GET') {
        const master = calendar.events.get(eventId);
        if (!master) return [404, { error: { message: 'Not Found' } }];
        const items = occurrences(master, to, world.zone).filter((ms) => ms >= from && ms < to).map((ms) => occurrence(calendar, master, ms)).filter((item) => query.get('showDeleted') === 'true' || item.status !== 'cancelled');
        return [200, page(items, query, 'events')];
      }
      if (eventId && match[3] === 'move' && method === 'POST') {
        const destination = calendars.get(query.get('destination') ?? '');
        const event = calendar.events.get(eventId);
        if (!destination || !event) return [404, { error: { message: 'Not Found' } }];
        calendar.events.delete(eventId);
        destination.events.set(eventId, event);
        return [200, withLinks(destination.id, event)];
      }
      const found = eventId ? findEvent(calendar, eventId) : null;
      if (!found) return [404, { error: { message: 'Not Found' } }];
      if (method === 'GET') return found.event.status === 'cancelled' ? [410, { error: { message: 'Resource has been deleted' } }] : [200, withLinks(calendar.id, found.event)];
      if (method === 'PATCH') {
        if (calendar.accessRole === 'reader') return [403, { error: { message: 'You need to have writer access to this calendar.' } }];
        const target = found.kind === 'occurrence' ? structuredClone(found.event) : found.event;
        if (found.kind === 'occurrence' && body.recurrence) return [400, { error: { message: 'Invalid recurrence rule.' } }];
        for (const [key, value] of Object.entries(body)) if (key !== 'conferenceData') target[key] = value;
        applyConference(target, body, query);
        if (found.kind === 'occurrence') calendar.exceptions.set(target.id, target);
        return [200, withLinks(calendar.id, target)];
      }
      if (method === 'DELETE') {
        if (found.kind === 'event') {
          calendar.events.delete(eventId);
          for (const key of [...calendar.exceptions.keys()]) if (key.startsWith(`${eventId}_`)) calendar.exceptions.delete(key);
        } else calendar.exceptions.set(eventId, { ...found.event, status: 'cancelled' });
        return [204, null];
      }
    }
    // Google Tasks
    if (path === '/tasks/v1/users/@me/lists' && method === 'GET') return [200, page(lists.map((list) => ({ kind: 'tasks#taskList', ...list })), query, 'lists')];
    if (path === '/tasks/v1/users/@me/lists' && method === 'POST') {
      const list = { id: id('L'), title: body.title };
      lists.push(list);
      tasks.set(list.id, []);
      return [200, list];
    }
    match = /^\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/.exec(path);
    if (match) {
      const listId = match[1] === '@default' ? world.defaultList : decodeURIComponent(match[1]);
      const list = lists.find((item) => item.id === listId);
      if (!list) return [404, { error: { message: 'Not Found' } }];
      if (method === 'GET') return [200, list];
      if (method === 'PATCH') {
        Object.assign(list, { title: body.title });
        return [200, list];
      }
      if (method === 'DELETE') {
        if (listId === world.defaultList) return [400, { error: { message: 'Invalid Value' } }];
        lists.splice(lists.indexOf(list), 1);
        tasks.delete(listId);
        return [204, null];
      }
    }
    match = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?(\/move)?$/.exec(path);
    if (match) {
      const listId = decodeURIComponent(match[1]);
      const all = tasks.get(listId);
      if (!all) return [404, { error: { message: 'Not Found' } }];
      const taskId = match[2] ? decodeURIComponent(match[2]) : null;
      if (!taskId && method === 'GET') {
        const showCompleted = query.get('showCompleted') !== 'false';
        const dueMin = query.get('dueMin');
        const dueMax = query.get('dueMax');
        const items = all.filter((task) => (showCompleted || task.status !== 'completed') && (!dueMin || (task.due && task.due >= dueMin)) && (!dueMax || (task.due && task.due <= dueMax)));
        return [200, page(items.map(publicTask), query, 'tasks')];
      }
      if (!taskId && method === 'POST') {
        const task = { id: id('t'), title: body.title, notes: body.notes ?? '', status: 'needsAction', ...(body.due ? { due: body.due } : {}), updated: new Date().toISOString() };
        place(listId, task, query.get('parent'), query.get('previous'));
        return [200, publicTask(task)];
      }
      // A task deleted a moment ago: Google keeps it (deleted), and writing deleted: false gives it back, in its place.
      const gone = trash.get(taskId);
      if (!all.find((item) => item.id === taskId) && gone && gone.listId === listId) {
        if (method === 'GET') return [200, publicTask({ ...gone.task, deleted: true })];
        if (method === 'PATCH' && body.deleted === false) {
          trash.delete(taskId);
          const restored = { ...gone.task, updated: new Date().toISOString() };
          all.splice(Math.min(gone.index, all.length), 0, restored);
          renumber(listId);
          return [200, publicTask(restored)];
        }
      }
      const task = all.find((item) => item.id === taskId);
      if (!task) return [404, { error: { message: 'Not Found' } }];
      if (match[3] && method === 'POST') {
        const destination = query.get('destinationTasklist');
        if (destination && destination !== listId) {
          tasks.set(listId, all.filter((item) => item !== task && item.parent !== task.id));
          renumber(listId);
          if (!tasks.has(destination)) return [404, { error: { message: 'Not Found' } }];
          place(destination, task, query.get('parent'), query.get('previous'));
        } else place(listId, task, query.get('parent'), query.get('previous'));
        task.updated = new Date().toISOString();
        return [200, publicTask(task)];
      }
      if (method === 'GET') return [200, publicTask(task)];
      if (method === 'PATCH') {
        for (const [key, value] of Object.entries(body)) {
          if (value === null) delete task[key];
          else task[key] = value;
        }
        if (body.status === 'completed' && !task.completed) task.completed = new Date().toISOString();
        if (body.status === 'needsAction') delete task.completed;
        task.updated = new Date().toISOString();
        return [200, publicTask(task)];
      }
      if (method === 'DELETE') {
        // Gone from the list; kept a while (with its subtasks) for an undelete.
        for (const item of all) if (item === task || item.parent === task.id) trash.set(item.id, { listId, task: item, index: all.indexOf(item) });
        tasks.set(listId, all.filter((item) => item !== task && item.parent !== task.id));
        renumber(listId);
        return [204, null];
      }
    }
    return [404, { error: { message: `fake Google: no route for ${method} ${path}` } }];
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      let body = {};
      if (text) {
        try {
          body = req.headers['content-type']?.includes('json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
        } catch {
          body = {};
        }
      }
      const path = decodeURIComponent(url.pathname);
      const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams), body: text ? body : undefined, at: Date.now() };
      requests.push(entry);
      const held = slow.find((entry) => entry.times > 0 && entry.method === req.method && path.includes(entry.path));
      if (held) {
        held.times -= 1;
        await new Promise((resolve) => setTimeout(resolve, held.ms));
      }
      const [status, payload] = answer(req.method, path, url.searchParams, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === null ? '' : JSON.stringify(payload));
      // When it was answered: a held one, later than it came.
      entry.answeredAt = Date.now();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base,
    requests,
    world,
    calendars,
    tasks,
    lists,
    /** Make the next matching request fail with this status. */
    failNext: (method, path, status, message) => (fail.next = { method, path, status, message }),
    /** Hold the next `times` matching requests `ms` before answering them (and before they change anything). */
    delayNext: (method, path, ms, times = 1) => slow.push({ method, path, ms, times }),
    /** The google-accounts.json a service needs to use this fake as `world.account`. */
    accountsFile: () =>
      JSON.stringify({
        version: 1,
        client: { id: `${'1234567'.repeat(2)}-${'abcdefghij'.repeat(3)}.apps.googleusercontent.com`, secret: `GOCSPX-${'f'.repeat(28)}` },
        accounts: [{ email: world.account, refreshToken: 'fake-refresh-token', scopes: world.granted ?? DEFAULT_SCOPES, addedAt: new Date().toISOString(), domain: world.hostedDomain ?? null }],
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
