// The Planner's writes to Google Calendar and Google Tasks, as service routes:
// events read in full, created, changed, answered, moved and deleted (with
// Google Calendar's "This event", "This and following events" and "All
// events"), task lists made, renamed and deleted, and tasks read with the
// completed ones, moved, nested and deleted; a repeating task's next
// occurrence made once, and its series deleted from one of its tasks on
// ("This and following tasks") or whole ("All tasks"), answered with the plan
// as it is then. Each write makes the next calendar read ask Google again.
import type http from 'node:http';
import { isDateKey } from '../src/domain/dates.ts';
import { EDIT_SCOPES, type EditScope, type EventInput } from '../src/domain/gevents.ts';
import type { GoogleResponse } from '../src/domain/google.ts';
import type { GoogleData, SendUpdates } from './googleData.ts';
import type { GoogleSeries } from './googleSeries.ts';

export interface GoogleRouteContext {
  data: GoogleData;
  /** Repeating tasks' series, one change of a series at a time for every window. */
  series: GoogleSeries;
  /** The plan as it is now, for an answer that changed it. */
  snapshot: () => object;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  /** The user's zone, for moving a series by its clock time. */
  zone: () => string;
  /** Something changed in Google: forget what was read of it. */
  changed: (what: 'calendar' | 'tasks') => void;
}

type Answer = { status: number; body: unknown } | null;

const isEmail = (value: unknown): value is string => typeof value === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const isTitle = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const ok = (body: unknown) => ({ status: 200, body });
const bad = (error: string) => ({ status: 400, body: { error } });
const sendOf = (value: unknown): SendUpdates => (value === 'all' ? 'all' : 'none');
const scopeOf = (value: unknown): EditScope | null => (value === undefined ? 'this' : EDIT_SCOPES.includes(value as EditScope) ? (value as EditScope) : null);
const RESPONSES: readonly string[] = ['accepted', 'declined', 'tentative'];

/** A Google write route's answer; null when the path is not one of them. */
export const googleWriteRoute = async (req: http.IncomingMessage, url: URL, ctx: GoogleRouteContext): Promise<Answer> => {
  const path = url.pathname;
  const method = req.method;
  const query = (name: string) => url.searchParams.get(name);
  const body = async () => (await ctx.readJson(req)) as Record<string, unknown>;

  if (path === '/google/event' && method === 'GET') {
    const [account, calendar, id] = [query('account'), query('calendar'), query('id')];
    if (!isEmail(account) || !isId(calendar) || !isId(id)) return bad('account, calendar and id are required');
    return ok({ event: await ctx.data.eventDetail(account, calendar, id) });
  }
  if (path === '/google/events' && (method === 'POST' || method === 'PATCH')) {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.calendarId)) return bad('account and calendarId are required');
    if (typeof input.event !== 'object' || input.event === null) return bad('event is required');
    if (method === 'POST') {
      const event = await ctx.data.insertEvent(input.account, input.calendarId, input.event as EventInput, sendOf(input.sendUpdates));
      ctx.changed('calendar');
      return ok({ event });
    }
    const scope = scopeOf(input.scope);
    if (!isId(input.eventId) || !scope) return bad('eventId and a scope (this, following or all) are required');
    try {
      return ok({ requests: await ctx.data.updateEvent(input.account, input.calendarId, input.eventId, input.event as EventInput, scope, sendOf(input.sendUpdates), ctx.zone()) });
    } finally {
      ctx.changed('calendar');
    }
  }
  if (path === '/google/events' && method === 'DELETE') {
    const [account, calendar, id, scope] = [query('account'), query('calendar'), query('id'), scopeOf(query('scope') ?? undefined)];
    if (!isEmail(account) || !isId(calendar) || !isId(id) || !scope) return bad('account, calendar, id and a scope are required');
    try {
      return ok(await ctx.data.deleteEvent(account, calendar, id, scope, sendOf(query('sendUpdates'))));
    } finally {
      ctx.changed('calendar');
    }
  }
  if (path === '/google/events/restore' && method === 'POST') {
    const input = (await body()) as { token?: unknown };
    if (!isId(input?.token)) return bad('token is required');
    try {
      await ctx.data.restoreEvent(input.token as string);
      return ok({ restored: true });
    } finally {
      ctx.changed('calendar');
    }
  }
  if (path === '/google/events/respond' && method === 'POST') {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.calendarId) || !isId(input.eventId)) return bad('account, calendarId and eventId are required');
    if (!RESPONSES.includes(input.response as string)) return bad('response must be accepted, declined or tentative');
    const scope = input.scope === 'all' ? 'all' : 'this';
    try {
      return ok({ requests: await ctx.data.respond(input.account, input.calendarId, input.eventId, input.response as GoogleResponse, scope) });
    } finally {
      ctx.changed('calendar');
    }
  }
  if (path === '/google/events/move' && method === 'POST') {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.calendarId) || !isId(input.eventId) || !isId(input.destination)) return bad('account, calendarId, eventId and destination are required');
    try {
      return ok({ event: await ctx.data.moveEvent(input.account, input.calendarId, input.eventId, input.destination, sendOf(input.sendUpdates)) });
    } finally {
      ctx.changed('calendar');
    }
  }

  if (path === '/google/tasklists' && method === 'POST') {
    const input = await body();
    if (!isEmail(input.account) || !isTitle(input.title)) return bad('account and a title (at most 1024 characters) are required');
    const list = await ctx.data.createTaskList(input.account, input.title.trim());
    return ok({ list });
  }
  if (path === '/google/tasklists' && method === 'PATCH') {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.listId) || !isTitle(input.title)) return bad('account, listId and a title are required');
    return ok({ list: await ctx.data.renameTaskList(input.account, input.listId, input.title.trim()) });
  }
  if (path === '/google/tasklists' && method === 'DELETE') {
    const [account, list] = [query('account'), query('list')];
    if (!isEmail(account) || !isId(list)) return bad('account and list are required');
    try {
      await ctx.data.deleteTaskList(account, list);
      return ok({ deleted: true });
    } finally {
      ctx.changed('tasks');
    }
  }
  if (path === '/google/tasks/all' && method === 'GET') {
    const [account, list] = [query('account'), query('list')];
    if (!isEmail(account) || !isId(list)) return bad('account and list are required');
    return ok(await ctx.data.allTasks(account, list));
  }
  if (path === '/google/tasks' && method === 'DELETE') {
    const [account, list, id] = [query('account'), query('list'), query('id')];
    if (!isEmail(account) || !isId(list) || !isId(id)) return bad('account, list and id are required');
    try {
      await ctx.data.deleteTask(account, list, id);
      return ok({ deleted: true });
    } finally {
      ctx.changed('tasks');
    }
  }
  if (path === '/google/tasks/next' && method === 'POST') {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    try {
      return ok({ ...(await ctx.series.next(input.account, input.listId, input.id)), ...ctx.snapshot() });
    } finally {
      ctx.changed('tasks');
    }
  }
  if (path === '/google/tasks/series' && method === 'DELETE') {
    const [account, series, from, task] = [query('account'), query('series'), query('from'), query('task')];
    if (!isEmail(account) || !isId(series)) return bad('account and series are required');
    if ((from !== null && !isDateKey(from)) || (task !== null && !isId(task))) return bad('from must be a date, task a task id');
    try {
      return ok({ ...(await ctx.series.remove(account, series, from, task)), ...ctx.snapshot() });
    } finally {
      ctx.changed('tasks');
    }
  }
  if (path === '/google/tasks/move' && method === 'POST') {
    const input = await body();
    if (!isEmail(input.account) || !isId(input.listId) || !isId(input.id)) return bad('account, listId and id are required');
    for (const key of ['parent', 'previous', 'destinationListId'] as const) if (input[key] !== undefined && input[key] !== null && !isId(input[key])) return bad(`${key} must be a task or list id`);
    try {
      const task = await ctx.data.moveTask(input.account, input.listId, input.id, { parent: (input.parent as string | null | undefined) ?? null, previous: (input.previous as string | null | undefined) ?? null, destination: (input.destinationListId as string | null | undefined) ?? null });
      return ok({ task });
    } finally {
      ctx.changed('tasks');
    }
  }
  return null;
};
