// Google's routes, by what they serve: sign-in and the accounts; Google Calendar (the calendars, events read in full,
// created, changed, answered, moved, deleted and restored, with Google Calendar's "This event", "This and following
// events" and "All events", and people to invite); Google Tasks (lists made, renamed and deleted, tasks read, made,
// changed, moved, nested and deleted, the Pending ones, the ones behind linked Planner tasks, task notifications,
// declined meetings and Drive files to attach); a repeating task's series; and Gmail. A write makes the next read of
// what it changed ask Google again; Google's own errors answer with their status.
import type http from 'node:http';
import { isDateKey, todayIn } from '../../src/domain/core/dates.ts';
import { ATTACHMENTS_MAX, GOOGLE_NOTES_MAX } from '../../src/domain/core/events.ts';
import { GMAIL_ACTIONS, type GmailAction, type GoogleTaskException, type GoogleTaskKept } from '../../src/domain/core/types.ts';
import { isRecord, messageOf } from '../../src/domain/core/values.ts';
import { EDIT_SCOPES, type EditScope, type EventInput } from '../../src/domain/google/events.ts';
import type { GoogleResponse } from '../../src/domain/google/google.ts';
import type { MadeTask, OccurrenceValues, SeriesSide } from '../../src/domain/google/taskKept.ts';
import { pendingRange, pendingTasks } from '../../src/domain/google/taskPending.ts';
import { GOOGLE_FEATURES, GoogleError, type GoogleAccounts, type GoogleFeature } from '../google/accounts.ts';
import type { SendUpdates } from '../google/data.ts';
import { ACK_LIMITS } from '../google/notifications.ts';
import type { OccurrenceEdit, SeriesUndo } from '../google/series.ts';
import { bad, ok, readJson, type Route } from '../http.ts';

const isEmail = (value: unknown): value is string => typeof value === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const isTitle = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const isThread = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-zA-Z_-]{1,64}$/.test(value);
const sendOf = (value: unknown): SendUpdates => (value === 'all' ? 'all' : 'none');
const scopeOf = (value: unknown): EditScope | null => (value === undefined ? 'this' : EDIT_SCOPES.includes(value as EditScope) ? (value as EditScope) : null);
const RESPONSES: readonly string[] = ['accepted', 'declined', 'tentative'];
const isMinutes = (value: unknown, low: number, high: number): boolean => value === null || (Number.isInteger(value) && (value as number) >= low && (value as number) <= high);
/** An occurrence as a window showed it, or as its form left it. */
const isOccurrence = (value: unknown): value is OccurrenceValues =>
  isRecord(value) && typeof value.title === 'string' && value.title.length <= 1024 && typeof value.notes === 'string' && value.notes.length <= GOOGLE_NOTES_MAX
  && isDateKey(value.due) && isMinutes(value.time, 0, 24 * 60 - 1) && isMinutes(value.duration, 5, 24 * 60) && (value.deadline === null || isDateKey(value.deadline))
  && (value.attachments === undefined || isFiles(value.attachments));
/** Drive files as a window sends them; each is checked again when it is kept. */
const isFiles = (value: unknown): boolean => Array.isArray(value) && value.length <= ATTACHMENTS_MAX && value.every((file) => isRecord(file) && typeof file.id === 'string');
/** What a window kept for a task, as Undo sends it back; checked again, field by field, when it is kept. */
const isKeptEntry = (value: unknown): value is GoogleTaskKept =>
  isRecord(value) && isEmail(value.account) && isId(value.listId) && isId(value.taskId) && typeof value.updatedAt === 'string' && (value.repeat === null || isRecord(value.repeat));
/** A next task a series made, as its window got it (Undo takes it back while it is still so). */
const isMade = (value: unknown): value is MadeTask =>
  isRecord(value) && isId(value.listId) && isId(value.id) && typeof value.title === 'string' && typeof value.notes === 'string' && (value.due === null || isDateKey(value.due)) && typeof value.updatedAt === 'string';
/** One side of an edit of all tasks of a series; the template's every field is checked again when it is kept. */
const isSeriesSide = (value: unknown): value is SeriesSide =>
  isRecord(value) && (value.rule === null || (typeof value.rule === 'string' && value.rule.length <= 500)) && (value.due === null || isDateKey(value.due))
  && isRecord(value.template) && typeof value.template.title === 'string' && typeof value.template.notes === 'string' && isDateKey(value.template.start);
const OWN_FIELDS = ['time', 'duration', 'deadline', 'starred', 'busy', 'visibility', 'color', 'attachments', 'doNotDisturb', 'decline'];
const occurrenceEditOf = (input: Record<string, unknown>): OccurrenceEdit | null => {
  if (input.skip === true) return { skip: true };
  // What it had (its change is checked again when it is kept), or null: as its series has it.
  if ('restore' in input) return input.restore === null || isRecord(input.restore) ? { restore: input.restore as GoogleTaskException | null } : null;
  return isOccurrence(input.before) && isOccurrence(input.after) ? { before: input.before, after: input.after } : null;
};

/** The request's JSON body, to read fields of. */
const readInput = async (req: http.IncomingMessage) => (await readJson(req)) as Record<string, unknown>;

/** Ask every account that has `feature`; one account's trouble stays its own. */
const perAccount = async <T>(google: GoogleAccounts, feature: GoogleFeature, ask: (account: string) => Promise<T[]>): Promise<{ items: T[]; errors: { account: string; message: string }[] }> => {
  const items: T[] = [];
  const errors: { account: string; message: string }[] = [];
  await Promise.all(
    (await google.emailsWith(feature)).map(async (account) => {
      try {
        items.push(...(await ask(account)));
      } catch (error) {
        errors.push({ account, message: messageOf(error) });
      }
    }),
  );
  return { items, errors };
};

/** Sign-in and the accounts. */
const accountRoutes: Route = async ({ google, timeboxes }, req, url) => {
  const path = url.pathname;
  if (path === '/google/status' && req.method === 'GET') return ok({ ...(await google.status()), timeboxError: timeboxes.lastError });
  if (path === '/google/client' && req.method === 'PUT') {
    const input = await readInput(req);
    if (typeof input.id !== 'string' || typeof input.secret !== 'string') return bad('id and secret must be strings');
    return ok(await google.setClient(input.id, input.secret));
  }
  if (path === '/google/client' && req.method === 'DELETE') return ok(await google.clearClient());
  if (path === '/google/connect' && req.method === 'POST') {
    const input = await readInput(req);
    const features = Array.isArray(input.features) ? GOOGLE_FEATURES.filter((feature) => (input.features as unknown[]).includes(feature)) : [];
    return ok(await google.startSignIn(features));
  }
  const signIn = /^\/google\/connect\/([A-Za-z0-9_-]{8,40})(\/finish)?$/.exec(path);
  if (signIn && !signIn[2] && req.method === 'GET') return ok(google.signIn(signIn[1]!));
  if (signIn && signIn[2] && req.method === 'POST') {
    const input = await readInput(req);
    if (typeof input.url !== 'string' || input.url.length > 4000) return bad('url must be the address the browser was sent to');
    return ok(await google.finishSignIn(signIn[1]!, input.url));
  }
  const account = /^\/google\/accounts\/([^/]+)$/.exec(path);
  if (account && req.method === 'DELETE') return ok({ removed: await google.remove(decodeURIComponent(account[1]!)) });
  return null;
};

/** Google Calendar: the calendars, their events as the calendar views change them, and people to invite. */
const calendarRoutes: Route = async ({ google, googleData, googleCalendars, contacts, zone }, req, url) => {
  const path = url.pathname;
  const method = req.method;
  const query = (name: string) => url.searchParams.get(name);
  if (path === '/google/calendars' && method === 'GET') {
    const { items, errors } = await perAccount(google, 'calendar', (email) => googleData.calendars(email));
    return ok({ calendars: items, errors });
  }
  if (path === '/google/event' && method === 'GET') {
    const [account, calendar, id] = [query('account'), query('calendar'), query('id')];
    if (!isEmail(account) || !isId(calendar) || !isId(id)) return bad('account, calendar and id are required');
    return ok({ event: await googleData.eventDetail(account, calendar, id) });
  }
  if (path === '/google/events' && (method === 'POST' || method === 'PATCH')) {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.calendarId)) return bad('account and calendarId are required');
    if (typeof input.event !== 'object' || input.event === null) return bad('event is required');
    if (method === 'POST') {
      const event = await googleData.insertEvent(input.account, input.calendarId, input.event as EventInput, sendOf(input.sendUpdates));
      googleCalendars.forget();
      return ok({ event });
    }
    const scope = scopeOf(input.scope);
    if (!isId(input.eventId) || !scope) return bad('eventId and a scope (this, following or all) are required');
    try {
      return ok({ requests: await googleData.updateEvent(input.account, input.calendarId, input.eventId, input.event as EventInput, scope, sendOf(input.sendUpdates), zone()) });
    } finally {
      googleCalendars.forget();
    }
  }
  if (path === '/google/events' && method === 'DELETE') {
    const [account, calendar, id, scope] = [query('account'), query('calendar'), query('id'), scopeOf(query('scope') ?? undefined)];
    if (!isEmail(account) || !isId(calendar) || !isId(id) || !scope) return bad('account, calendar, id and a scope are required');
    try {
      return ok(await googleData.deleteEvent(account, calendar, id, scope, sendOf(query('sendUpdates'))));
    } finally {
      googleCalendars.forget();
    }
  }
  if (path === '/google/events/restore' && method === 'POST') {
    const input = await readInput(req);
    if (!isId(input?.token)) return bad('token is required');
    try {
      await googleData.restoreEvent(input.token as string);
      return ok({ restored: true });
    } finally {
      googleCalendars.forget();
    }
  }
  if (path === '/google/events/respond' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.calendarId) || !isId(input.eventId)) return bad('account, calendarId and eventId are required');
    if (!RESPONSES.includes(input.response as string)) return bad('response must be accepted, declined or tentative');
    const scope = input.scope === 'all' ? 'all' : 'this';
    try {
      return ok({ requests: await googleData.respond(input.account, input.calendarId, input.eventId, input.response as GoogleResponse, scope) });
    } finally {
      googleCalendars.forget();
    }
  }
  if (path === '/google/events/move' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.calendarId) || !isId(input.eventId) || !isId(input.destination)) return bad('account, calendarId, eventId and destination are required');
    try {
      return ok({ event: await googleData.moveEvent(input.account, input.calendarId, input.eventId, input.destination, sendOf(input.sendUpdates)) });
    } finally {
      googleCalendars.forget();
    }
  }
  if (path === '/google/contacts' && method === 'GET') {
    // People to invite, by name or address (Sunsama's Google Contacts integration); the account must allow Contacts.
    const email = query('account');
    const text = (query('q') ?? '').trim();
    if (!isEmail(email) || !text || text.length > 100) return bad('account and a search of at most 100 characters are required');
    if (!(await google.allows(email, 'contacts'))) return { status: 403, body: { error: `Google Contacts are not allowed for ${email}: allow them to search people to invite`, reason: 'not-allowed' } };
    return ok({ contacts: await contacts.search(email, text) });
  }
  return null;
};

/**
 * Google Tasks: the lists, their tasks as the Tasks view, the calendar and linked Planner tasks read and change them,
 * task notifications, declined meetings, and Drive files to attach to a task.
 */
const taskRoutes: Route = async ({ google, googleData, googleDueTasks, taskNotifications, decliner, zone }, req, url) => {
  const path = url.pathname;
  const method = req.method;
  const query = (name: string) => url.searchParams.get(name);
  if (path === '/google/tasklists' && method === 'GET') {
    const { items, errors } = await perAccount(google, 'tasks', (email) => googleData.taskLists(email));
    return ok({ lists: items, errors });
  }
  if (path === '/google/tasklists' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isTitle(input.title)) return bad('account and a title (at most 1024 characters) are required');
    const list = await googleData.createTaskList(input.account, input.title.trim());
    return ok({ list });
  }
  if (path === '/google/tasklists' && method === 'PATCH') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isTitle(input.title)) return bad('account, listId and a title are required');
    return ok({ list: await googleData.renameTaskList(input.account, input.listId, input.title.trim()) });
  }
  if (path === '/google/tasklists' && method === 'DELETE') {
    const [account, list] = [query('account'), query('list')];
    if (!isEmail(account) || !isId(list)) return bad('account and list are required');
    try {
      await googleData.deleteTaskList(account, list);
      return ok({ deleted: true });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks' && method === 'GET') {
    const [email, list] = [query('account'), query('list')];
    if (!isEmail(email) || !isId(list)) return bad('account and list are required');
    return ok({ tasks: await googleData.tasks(email, list) });
  }
  if (path === '/google/tasks/all' && method === 'GET') {
    const [account, list] = [query('account'), query('list')];
    if (!isEmail(account) || !isId(list)) return bad('account and list are required');
    return ok(await googleData.allTasks(account, list));
  }
  if (path === '/google/tasks' && (method === 'PATCH' || method === 'POST')) {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId)) return bad('account and listId are required');
    if (input.due !== undefined && input.due !== null && !isDateKey(input.due)) return bad('due must be a date or null');
    if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 8192)) return bad('notes must be text, at most 8192 characters (as Google Tasks keeps)');
    if (input.title !== undefined && !isTitle(input.title)) return bad('title must be 1 to 1024 characters');
    if (method === 'PATCH') {
      if (!isId(input.id)) return bad('id is required');
      if (input.completed !== undefined && typeof input.completed !== 'boolean') return bad('completed must be true or false');
      // Undo after Delete: Google undeletes a task it deleted a moment ago.
      if (input.deleted !== undefined && input.deleted !== false) return bad('deleted can only be false (Undo); DELETE deletes');
      const patch = { ...(input.completed !== undefined ? { completed: input.completed as boolean } : {}), ...(input.due !== undefined ? { due: input.due as string | null } : {}), ...(input.title !== undefined ? { title: (input.title as string).trim() } : {}), ...(input.notes !== undefined ? { notes: input.notes as string } : {}), ...(input.deleted === false ? { deleted: false as const } : {}) };
      const task = await googleData.updateTask(input.account, input.listId, input.id, patch);
      // Due dates and completion show on the calendar: read them again next time.
      googleDueTasks.forget();
      return ok({ task });
    }
    if (typeof input.title !== 'string') return bad('title is required');
    if ((input.parent !== undefined && input.parent !== null && !isId(input.parent)) || (input.previous !== undefined && input.previous !== null && !isId(input.previous))) return bad('parent and previous must be task ids');
    const task = await googleData.createTask(input.account, input.listId, { title: input.title.trim(), ...(input.notes ? { notes: input.notes as string } : {}), ...(input.due ? { due: input.due as string } : {}), parent: (input.parent as string | null | undefined) ?? null, previous: (input.previous as string | null | undefined) ?? null });
    googleDueTasks.forget();
    return ok({ task });
  }
  if (path === '/google/tasks' && method === 'DELETE') {
    const [account, list, id] = [query('account'), query('list'), query('id')];
    if (!isEmail(account) || !isId(list) || !isId(id)) return bad('account, list and id are required');
    try {
      await googleData.deleteTask(account, list, id);
      return ok({ deleted: true });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/move' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    for (const key of ['parent', 'previous', 'destinationListId'] as const) if (input[key] !== undefined && input[key] !== null && !isId(input[key])) return bad(`${key} must be a task or list id`);
    try {
      const task = await googleData.moveTask(input.account, input.listId, input.id, { parent: (input.parent as string | null | undefined) ?? null, previous: (input.previous as string | null | undefined) ?? null, destination: (input.destinationListId as string | null | undefined) ?? null });
      return ok({ task });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/linked' && method === 'POST') {
    // The tasks behind linked Planner tasks, to bring those up to date.
    const input = await readInput(req);
    const groups = (Array.isArray(input.groups) ? input.groups : [])
      .filter((group): group is { account: string; listId: string; ids: string[] } => isEmail(group?.account) && isId(group?.listId) && Array.isArray(group?.ids) && group.ids.every(isId));
    // The panel sends them in parts this size, so the request ends in time; more is refused, not cut.
    if (groups.length > 10 || groups.some((group) => group.ids.length > 50)) return bad('at most 10 lists of 50 tasks per request');
    const tasks: unknown[] = [];
    // Not in their list nor any other of the account's: deleted in Google.
    const missing: { account: string; listId: string; id: string }[] = [];
    const errors: { account: string; message: string }[] = [];
    await Promise.all(
      groups.map(async (group) => {
        try {
          const found = await googleData.linkedTasks(group.account, group.listId, group.ids);
          tasks.push(...found.tasks);
          missing.push(...found.missing.map((id) => ({ account: group.account, listId: group.listId, id })));
        } catch (error) {
          errors.push({ account: group.account, message: messageOf(error) });
        }
      }),
    );
    return ok({ tasks, missing, errors });
  }
  if (path === '/google/tasks/pending' && method === 'GET') {
    // Google Calendar's Pending tasks: the open tasks of every list dated in the past 365 days, latest first.
    const today = todayIn(zone());
    const { from, to } = pendingRange(today);
    const read = await googleDueTasks.read(await google.emailsWith('tasks'), from, to, query('refresh') === '1', true);
    return ok({ tasks: pendingTasks(read.items, today), today, from, to, errors: read.errors });
  }
  if (path === '/google/tasks/notifications' && method === 'POST') {
    // The task notifications come by now that no Planner surface has had yet, lent to the asker until it says it showed them.
    return ok(await taskNotifications.take());
  }
  if (path === '/google/tasks/notifications/ack' && method === 'POST') {
    const input = await readInput(req);
    const keys = Array.isArray(input.keys) ? input.keys : null;
    if (!keys || keys.length > ACK_LIMITS.keys || !keys.every((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= ACK_LIMITS.key)) {
      return bad(`keys is a list of at most ${ACK_LIMITS.keys} notification keys`);
    }
    await taskNotifications.ack(keys);
    return ok({ acknowledged: keys.length });
  }
  if (path === '/google/tasks/decline' && method === 'POST') {
    // "Automatically decline meetings" now, after a task's change: the meetings it declined, and where it carries on (`more`).
    return ok(await decliner.run());
  }
  if (path === '/google/tasks/declined' && method === 'GET') {
    const [email, task] = [query('account'), query('task')];
    if (!isEmail(email) || !isId(task)) return bad('account and task are required');
    // `more`: where the account's meetings are still to be looked at, while declining carries on after a bound.
    return ok({ declined: await decliner.declinedFor(email, task), more: decliner.progress(email) });
  }
  if (path === '/google/drive/files' && method === 'GET') {
    // Drive's files by name, to attach to a task, as Google Calendar's "Add a Google Drive attachment" finds them.
    const [email, text, pageToken] = [query('account'), query('q') ?? '', query('pageToken') ?? undefined];
    if (!isEmail(email) || text.length > 200 || (pageToken !== undefined && pageToken.length > 500)) return bad('account is required, and the search must be at most 200 characters');
    if (!(await google.allows(email.toLowerCase(), 'drive'))) return { status: 403, body: { error: `${email} has not allowed the Planner to see Google Drive: allow it first` } };
    // A page of them, and the next page's token ("More files").
    return ok(await googleData.driveFiles(email, text, pageToken));
  }
  return null;
};

/**
 * A repeating Google task's series, one change of it at a time (`GoogleSeries`): its next occurrence made once, one
 * upcoming occurrence changed or deleted on its own, an edit of all its tasks, its open task gone from Google, its
 * deletion from one of its tasks on ("This and following tasks") or whole ("All tasks"), and Google Tasks' Undo after
 * deleting or completing its tasks, each answered with the plan as it is then.
 */
const seriesRoutes: Route = async ({ series, snapshot, googleDueTasks }, req, url) => {
  const path = url.pathname;
  const method = req.method;
  const query = (name: string) => url.searchParams.get(name);
  if (path === '/google/tasks/next' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    if ((input.completed !== undefined && typeof input.completed !== 'boolean') || (input.due !== undefined && input.due !== null && !isDateKey(input.due))) return bad('completed must be true or false, due a date');
    const hint = { ...(input.completed !== undefined ? { completed: input.completed as boolean } : {}), ...(input.due !== undefined ? { due: input.due as string | null } : {}) };
    try {
      return ok({ ...(await series.next(input.account, input.listId, input.id, hint)), ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/occurrence' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.seriesId) || !isDateKey(input.on)) return bad('account, seriesId and on (a date) are required');
    const edit = occurrenceEditOf(input);
    if (!edit) return bad('skip, restore, or before and after (an occurrence each) are required');
    try {
      const { before } = await series.occurrence(input.account, input.seriesId, input.on, edit);
      return ok({ changed: true, before, ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/series/edit' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.taskId) || !isId(input.seriesId)) return bad('account, listId, taskId and seriesId are required');
    if (!isRecord(input.own) || Object.keys(input.own).some((key) => !OWN_FIELDS.includes(key))) return bad(`own may only carry ${OWN_FIELDS.join(', ')}`);
    if (!isSeriesSide(input.before) || !isSeriesSide(input.after)) return bad('before and after (rule, template and due) are required');
    try {
      await series.edit(input.account, input.taskId, input.seriesId, input.own, input.before, input.after);
      return ok({ changed: true, ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/series/undo' && method === 'POST') {
    // Google Tasks' Undo after deleting tasks of a series: "This task" (one), "This and following" or "All tasks" (cut).
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.seriesId)) return bad('account and seriesId are required');
    let undo: SeriesUndo;
    if (input.kind === 'one' && isKeptEntry(input.task) && (input.made === null || isMade(input.made))) undo = { kind: 'one', task: input.task, made: input.made };
    else if (input.kind === 'cut' && (input.from === null || isDateKey(input.from)) && Array.isArray(input.deleted) && input.deleted.length <= 5000 && input.deleted.every((task) => isRecord(task) && isId(task.listId) && isId(task.id)) && Array.isArray(input.before) && input.before.length <= 5000 && input.before.every(isKeptEntry)) {
      undo = { kind: 'cut', from: input.from, deleted: input.deleted as { listId: string; id: string }[], before: input.before };
    } else return bad('kind one (task, made) or cut (from, deleted, before) is required');
    try {
      return ok({ ...(await series.undo(input.account, input.seriesId, undo)), ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/uncomplete' && method === 'POST') {
    // Google Tasks' Undo after completing a task of a series: open again, and the next one it made gone again.
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    if (!(input.before === null || isKeptEntry(input.before)) || !(input.made === null || isMade(input.made))) return bad('before (what was kept for it) and made (its next task) are required, or null');
    try {
      return ok({ ...(await series.uncomplete(input.account, input.listId, input.id, { before: input.before, made: input.made })), ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/gone' && method === 'POST') {
    const input = await readInput(req);
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    try {
      await series.gone(input.account, input.listId, input.id);
      return ok({ ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  if (path === '/google/tasks/series' && method === 'DELETE') {
    const [account, seriesId, from, task] = [query('account'), query('series'), query('from'), query('task')];
    if (!isEmail(account) || !isId(seriesId)) return bad('account and series are required');
    if ((from !== null && !isDateKey(from)) || (task !== null && !isId(task))) return bad('from must be a date, task a task id');
    try {
      return ok({ ...(await series.remove(account, seriesId, from, task)), ...snapshot() });
    } finally {
      googleDueTasks.forget();
    }
  }
  return null;
};

/** Gmail: a page of mail, a pasted address's message, and beyond reading (Sunsama's actions on an email task and its automations) labels, a thread and the actions. */
const mailRoutes: Route = async ({ google, googleData, gmail }, req, url) => {
  const path = url.pathname;
  if (path === '/google/mail/labels' && req.method === 'GET') {
    const email = url.searchParams.get('account');
    if (!isEmail(email)) return bad('account is required');
    return ok({ labels: await gmail.labels(email) });
  }
  if (path === '/google/mail/thread' && req.method === 'GET') {
    const email = url.searchParams.get('account');
    const thread = url.searchParams.get('thread') ?? '';
    if (!isEmail(email) || !isThread(thread)) return bad('account and thread are required');
    const found = await gmail.thread(email, thread);
    return found ? ok({ thread: found }) : { status: 404, body: { error: 'Gmail no longer has this email' } };
  }
  if (path === '/google/mail/act' && req.method === 'POST') {
    const input = await readInput(req);
    const actions = Array.isArray(input.actions) ? input.actions : [];
    const valid = actions.length > 0 && actions.length <= 12 && actions.every((action: Partial<GmailAction> | null) =>
      Boolean(action) && (GMAIL_ACTIONS as readonly unknown[]).includes(action!.kind) &&
      (action!.kind === 'addLabel' || action!.kind === 'removeLabel' ? typeof action!.label === 'string' && action!.label.trim().length > 0 && action!.label.length <= 225 : action!.label === undefined));
    if (!isEmail(input.account) || !isThread(input.thread) || !valid) return bad('account, thread and one to twelve Gmail actions are required');
    if (!(await google.allows(input.account, 'mailActions'))) return { status: 403, body: { error: `Gmail actions are not allowed for ${input.account}: allow them in Settings → Google`, reason: 'not-allowed' } };
    return ok(await gmail.act(input.account, input.thread, actions as GmailAction[]));
  }
  if (path === '/google/mail/resolve' && req.method === 'POST') {
    // A pasted Gmail address, as Sunsama imports one: its message, in the account it names first, else in each with Gmail.
    const input = await readInput(req);
    const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{1,32}$/.test(value);
    if (!id(input.thread) && !id(input.message)) return bad('thread or message must be a Gmail API id');
    const accounts = await google.emailsWith('mail');
    const named = isEmail(input.account) ? input.account.toLowerCase() : null;
    const errors: string[] = [];
    for (const account of [...accounts.filter((email) => email === named), ...accounts.filter((email) => email !== named)]) {
      try {
        const item = await googleData.mailItem(account, { thread: id(input.thread) ? input.thread : null, message: id(input.message) ? input.message : null });
        if (item) return ok({ item });
      } catch (error) {
        errors.push(`${account}: ${messageOf(error)}`);
      }
    }
    return { status: 404, body: { error: errors.length ? errors.join('; ') : accounts.length ? 'This message is in none of your Gmail accounts' : 'No Google account has Gmail' } };
  }
  if (path === '/google/mail' && req.method === 'GET') {
    const email = url.searchParams.get('account');
    const query = url.searchParams.get('q') ?? 'in:inbox';
    const pageToken = url.searchParams.get('pageToken') ?? undefined;
    if (!isEmail(email) || query.length > 500 || (pageToken !== undefined && pageToken.length > 500)) return bad('account is required, and the search must be shorter');
    return ok(await googleData.mail(email, query, pageToken));
  }
  return null;
};

/** Google's routes; null when the path is not one of them. */
export const googleRoute: Route = async (ctx, req, url) => {
  if (!url.pathname.startsWith('/google/')) return null;
  try {
    return (await accountRoutes(ctx, req, url)) ?? (await calendarRoutes(ctx, req, url)) ?? (await taskRoutes(ctx, req, url)) ?? (await seriesRoutes(ctx, req, url)) ?? (await mailRoutes(ctx, req, url));
  } catch (error) {
    if (error instanceof GoogleError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
};
