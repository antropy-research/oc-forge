// Planner local service. The host starts it with the app's Node runtime, binds it
// to 127.0.0.1, and proxies the panel's serviceRequest calls to it.
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventStore } from './store.ts';
import { Planner } from './planner.ts';
import { CalendarFeeds } from './calendars.ts';
import { SyncManager } from './sync.ts';
import { GitHubSource, LISTS, type ListKind } from './github.ts';
import { LinearWorkspaces, WorkspaceError } from './linear.ts';
import { GOOGLE_FEATURES, GoogleAccounts, GoogleError, type GoogleFeature } from './google.ts';
import { GoogleData } from './googleData.ts';
import { GoogleCalendars, GoogleDueTasks, GoogleTimeboxes } from './googleTimeboxes.ts';
import { googleWriteRoute } from './googleRoutes.ts';
import { GOOGLE_TASKS_CALENDAR, dueTaskEvent } from '../src/domain/google.ts';
import { addDays, daysBetween, instantAt, isDateKey, todayIn } from '../src/domain/dates.ts';
import { CommandFiles, OpenCodeInfo, agentRoute, opencodeConfigDir } from './agents.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const BODY_LIMIT = 1_000_000;
const dir = process.env.PLANNER_DATA_DIR || join(homedir(), '.local', 'share', 'openchamber-planner', 'data');
const log = (message: string): void => console.error(`[planner] ${message}`);
let sync: SyncManager | null = null;
const store = new EventStore({ dir, log, onCommit: () => sync?.schedule() });
await store.init();
const planner = new Planner(store);
sync = new SyncManager(store, planner, log);
await sync.init();
const snapshot = () => ({ ...planner.snapshot(), sync: sync!.status() });
const github = new GitHubSource();
// Feed copies are a cache, kept beside the git-tracked data rather than in it.
const feeds = new CalendarFeeds(join(dirname(dir), 'cache'));
// Linear API keys stay on this machine: beside the data, never in its synced repository.
const linearWorkspaces = new LinearWorkspaces(join(dirname(dir), 'linear-workspaces.json'), undefined, log);
// Google's client secret and refresh tokens likewise stay beside the data, never in it.
const google = new GoogleAccounts(join(dirname(dir), 'google-accounts.json'), undefined, undefined, log);
const googleData = new GoogleData(google);
const googleCalendars = new GoogleCalendars(googleData);
const googleDueTasks = new GoogleDueTasks(googleData);
const timeboxes = new GoogleTimeboxes(planner, googleData, { idle: () => sync!.idle(), log, onWrite: () => googleCalendars.forget() });
// Agents to assign tasks to: one OpenCode command per preset, in OpenCode's own config folder.
const opencodeConfig = opencodeConfigDir();
const opencodeInfo = new OpenCodeInfo();
const agentCommands = new CommandFiles(opencodeConfig, log);
const syncAgentCommands = () => agentCommands.syncPresets(planner.state.settings.agentPresets ?? []);
syncAgentCommands();
agentCommands.retireLeftovers();

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const PULL_LOOKUPS_PER_REQUEST = 4;

/** A run's pull request to look up, as the panel sends it: by its URL once known, else by the run's branch. */
const isLookup = (value: unknown): value is { runId: string; branch: string | null; directories: string[]; url?: string } => {
  const lookup = value as { runId?: unknown; branch?: unknown; directories?: unknown; url?: unknown } | null;
  return (
    typeof lookup?.runId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(lookup.runId) &&
    (lookup.branch === null || (typeof lookup.branch === 'string' && lookup.branch.length <= 200)) &&
    (lookup.url === undefined || (typeof lookup.url === 'string' && lookup.url.length <= 300)) &&
    Array.isArray(lookup.directories) && lookup.directories.length <= 3 && lookup.directories.every((item) => typeof item === 'string' && item.length <= 1024)
  );
};

/** Map with at most `limit` calls in flight. */
const mapLimited = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
};

const isEmail = (value: unknown): value is string => typeof value === 'string' && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
const isGoogleId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/** Ask every account that has `feature`; one account's trouble stays its own. */
const perAccount = async <T>(feature: GoogleFeature, ask: (account: string) => Promise<T[]>): Promise<{ items: T[]; errors: { account: string; message: string }[] }> => {
  const accounts = (await google.status()).accounts.filter((account) => account.features.includes(feature));
  const items: T[] = [];
  const errors: { account: string; message: string }[] = [];
  await Promise.all(
    accounts.map(async (account) => {
      try {
        items.push(...(await ask(account.email)));
      } catch (error) {
        errors.push({ account: account.email, message: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { items, errors };
};

/** Google's routes; null when the path is not one of them. */
const googleRoute = async (req: http.IncomingMessage, url: URL): Promise<{ status: number; body: unknown } | null> => {
  const path = url.pathname;
  const ok = (body: unknown) => ({ status: 200, body });
  // Google Calendar events and Google Tasks lists, as the calendar and Tasks views change them.
  const written = await googleWriteRoute(req, url, { data: googleData, readJson, zone: () => planner.state.settings.timezone ?? 'UTC', changed: (what) => (what === 'calendar' ? googleCalendars : googleDueTasks).forget() });
  if (written) return written;
  if (path === '/google/status' && req.method === 'GET') return ok({ ...(await google.status()), timeboxError: timeboxes.lastError });
  if (path === '/google/client' && req.method === 'PUT') {
    const body = (await readJson(req)) as { id?: unknown; secret?: unknown };
    if (typeof body.id !== 'string' || typeof body.secret !== 'string') return { status: 400, body: { error: 'id and secret must be strings' } };
    return ok(await google.setClient(body.id, body.secret));
  }
  if (path === '/google/client' && req.method === 'DELETE') return ok(await google.clearClient());
  if (path === '/google/connect' && req.method === 'POST') {
    const body = (await readJson(req)) as { features?: unknown };
    const features = Array.isArray(body.features) ? GOOGLE_FEATURES.filter((feature) => (body.features as unknown[]).includes(feature)) : [];
    return ok(await google.startSignIn(features));
  }
  const signIn = /^\/google\/connect\/([A-Za-z0-9_-]{8,40})(\/finish)?$/.exec(path);
  if (signIn && !signIn[2] && req.method === 'GET') return ok(google.signIn(signIn[1]!));
  if (signIn && signIn[2] && req.method === 'POST') {
    const body = (await readJson(req)) as { url?: unknown };
    if (typeof body.url !== 'string' || body.url.length > 4000) return { status: 400, body: { error: 'url must be the address the browser was sent to' } };
    return ok(await google.finishSignIn(signIn[1]!, body.url));
  }
  const account = /^\/google\/accounts\/([^/]+)$/.exec(path);
  if (account && req.method === 'DELETE') return ok({ removed: await google.remove(decodeURIComponent(account[1]!)) });
  if (path === '/google/calendars' && req.method === 'GET') {
    const { items, errors } = await perAccount('calendar', (email) => googleData.calendars(email));
    return ok({ calendars: items, errors });
  }
  if (path === '/google/tasklists' && req.method === 'GET') {
    const { items, errors } = await perAccount('tasks', (email) => googleData.taskLists(email));
    return ok({ lists: items, errors });
  }
  if (path === '/google/tasks' && req.method === 'GET') {
    const email = url.searchParams.get('account');
    const list = url.searchParams.get('list');
    if (!isEmail(email) || !isGoogleId(list)) return { status: 400, body: { error: 'account and list are required' } };
    return ok({ tasks: await googleData.tasks(email, list) });
  }
  if (path === '/google/tasks/linked' && req.method === 'POST') {
    // The tasks behind linked Planner tasks, to bring those up to date.
    const body = (await readJson(req)) as { groups?: unknown };
    const groups = (Array.isArray(body.groups) ? body.groups : [])
      .filter((group): group is { account: string; listId: string; ids: string[] } => isEmail(group?.account) && isGoogleId(group?.listId) && Array.isArray(group?.ids) && group.ids.every(isGoogleId));
    // The panel sends them in parts this size, so the request ends in time; more is refused, not cut.
    if (groups.length > 10 || groups.some((group) => group.ids.length > 50)) return { status: 400, body: { error: 'at most 10 lists of 50 tasks per request' } };
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
          errors.push({ account: group.account, message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    return ok({ tasks, missing, errors });
  }
  if (path === '/google/tasks' && (req.method === 'PATCH' || req.method === 'POST')) {
    const body = (await readJson(req)) as { account?: unknown; listId?: unknown; id?: unknown; completed?: unknown; due?: unknown; title?: unknown; notes?: unknown; parent?: unknown; previous?: unknown };
    if (!isEmail(body.account) || !isGoogleId(body.listId)) return { status: 400, body: { error: 'account and listId are required' } };
    if (body.due !== undefined && body.due !== null && !isDateKey(body.due)) return { status: 400, body: { error: 'due must be a date or null' } };
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 8192)) return { status: 400, body: { error: 'notes must be text, at most 8192 characters (as Google Tasks keeps)' } };
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 1024)) return { status: 400, body: { error: 'title must be 1 to 1024 characters' } };
    if (req.method === 'PATCH') {
      if (!isGoogleId(body.id)) return { status: 400, body: { error: 'id is required' } };
      if (body.completed !== undefined && typeof body.completed !== 'boolean') return { status: 400, body: { error: 'completed must be true or false' } };
      const patch = { ...(body.completed !== undefined ? { completed: body.completed as boolean } : {}), ...(body.due !== undefined ? { due: body.due as string | null } : {}), ...(body.title !== undefined ? { title: (body.title as string).trim() } : {}), ...(body.notes !== undefined ? { notes: body.notes as string } : {}) };
      const task = await googleData.updateTask(body.account, body.listId, body.id, patch);
      // Due dates and completion show on the calendar: read them again next time.
      googleDueTasks.forget();
      return ok({ task });
    }
    if (typeof body.title !== 'string') return { status: 400, body: { error: 'title is required' } };
    if ((body.parent !== undefined && body.parent !== null && !isGoogleId(body.parent)) || (body.previous !== undefined && body.previous !== null && !isGoogleId(body.previous))) return { status: 400, body: { error: 'parent and previous must be task ids' } };
    const task = await googleData.createTask(body.account, body.listId, { title: body.title.trim(), ...(body.notes ? { notes: body.notes as string } : {}), ...(body.due ? { due: body.due as string } : {}), parent: (body.parent as string | null | undefined) ?? null, previous: (body.previous as string | null | undefined) ?? null });
    googleDueTasks.forget();
    return ok({ task });
  }
  if (path === '/google/mail' && req.method === 'GET') {
    const email = url.searchParams.get('account');
    const query = url.searchParams.get('q') ?? 'in:inbox';
    const pageToken = url.searchParams.get('pageToken') ?? undefined;
    if (!isEmail(email) || query.length > 500 || (pageToken !== undefined && pageToken.length > 500)) return { status: 400, body: { error: 'account is required, and the search must be shorter' } };
    return ok(await googleData.mail(email, query, pageToken));
  }
  return null;
};

const readJson = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true, version: planner.state.version, today: planner.today() });
      return;
    }
    if (url.pathname === '/state' && req.method === 'GET') {
      json(res, 200, snapshot());
      return;
    }
    if (url.pathname === '/github/status' && req.method === 'GET') {
      json(res, 200, await github.status());
      return;
    }
    if (url.pathname === '/github/list' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') ?? 'assigned';
      if (!(kind in LISTS)) {
        json(res, 400, { error: 'kind must be assigned, review or mine' });
        return;
      }
      try {
        json(res, 200, { items: await github.list(kind as ListKind) });
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (url.pathname === '/github/items' && req.method === 'POST') {
      const body = (await readJson(req)) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_=-]{1,100}$/.test(id)) : [];
      try {
        json(res, 200, { items: await github.items(ids) });
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (url.pathname === '/github/pulls' && req.method === 'POST') {
      // Pull requests that agents opened from their runs' worktree branches. Four
      // at a time, in parallel, so the request ends well within the host's 20 seconds.
      const body = (await readJson(req)) as { runs?: unknown };
      const runs = Array.isArray(body.runs) ? body.runs.filter(isLookup).slice(0, PULL_LOOKUPS_PER_REQUEST) : [];
      const results = await mapLimited(runs, 4, async (run) => {
        try {
          return { runId: run.runId, pullRequest: run.url ? await github.pullRequestAt(run.url) : run.branch ? await github.pullRequestFor(run.branch, run.directories) : null };
        } catch (error) {
          return { runId: run.runId, pullRequest: null, error: error instanceof Error ? error.message : String(error) };
        }
      });
      json(res, 200, { results });
      return;
    }
    if (url.pathname === '/agents' || url.pathname.startsWith('/agents/')) {
      const answer = await agentRoute(req, url, { configDir: opencodeConfig, info: opencodeInfo, commands: agentCommands, readJson });
      if (answer) {
        json(res, answer.status, answer.body);
        return;
      }
    }
    if (url.pathname.startsWith('/google/')) {
      try {
        const answer = await googleRoute(req, url);
        if (answer) {
          json(res, answer.status, answer.body);
          return;
        }
      } catch (error) {
        if (error instanceof GoogleError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
    }
    if (url.pathname.startsWith('/linear/')) {
      try {
        if (url.pathname === '/linear/workspaces' && req.method === 'GET') {
          json(res, 200, { workspaces: await linearWorkspaces.list() });
          return;
        }
        if (url.pathname === '/linear/workspaces' && req.method === 'POST') {
          const body = (await readJson(req)) as { key?: unknown };
          if (typeof body.key !== 'string') {
            json(res, 400, { error: 'key must be a string' });
            return;
          }
          json(res, 200, { workspace: await linearWorkspaces.add(body.key) });
          return;
        }
        const one = /^\/linear\/workspaces\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
        if (one && req.method === 'DELETE') {
          json(res, 200, { removed: await linearWorkspaces.remove(one[1]!) });
          return;
        }
        if (url.pathname === '/linear/graphql' && req.method === 'POST') {
          const body = (await readJson(req)) as { workspaceId?: unknown; query?: unknown; variables?: unknown };
          if (typeof body.workspaceId !== 'string' || typeof body.query !== 'string') {
            json(res, 400, { error: 'workspaceId and query must be strings' });
            return;
          }
          json(res, 200, await linearWorkspaces.graphql(body.workspaceId, body.query, body.variables ?? {}));
          return;
        }
      } catch (error) {
        if (error instanceof WorkspaceError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
    }
    if (url.pathname === '/sync') {
      if (req.method === 'GET') {
        json(res, 200, sync!.status());
        return;
      }
      if (req.method === 'PUT') {
        const body = (await readJson(req)) as { remote?: unknown };
        if (body.remote !== null && typeof body.remote !== 'string') {
          json(res, 400, { error: 'remote must be a string or null' });
          return;
        }
        try {
          json(res, 200, await sync!.setRemote(body.remote));
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (req.method === 'POST') {
        const status = await sync!.run().catch((error) => ({ ...sync!.status(), lastError: error instanceof Error ? error.message : String(error) }));
        json(res, 200, { status, ...snapshot() });
        syncAgentCommands();
        return;
      }
    }
    if (url.pathname === '/calendar' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!isDateKey(from) || !isDateKey(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 62) {
        json(res, 400, { error: 'from and to must be dates at most 62 days apart' });
        return;
      }
      const zone = planner.state.settings.timezone ?? 'UTC';
      const refresh = url.searchParams.get('refresh') === '1';
      const calendars = Object.values(planner.state.calendars);
      // Google calendars are read through their accounts; the rest are ICS feeds.
      const timeMin = instantAt(from, 0, zone);
      const timeMax = instantAt(addDays(to, 1), 0, zone);
      // Google tasks due in the range show on their day, as in Google Calendar, planned or not (the panel shows the link).
      const taskAccounts = planner.state.settings.googleTasksOnCalendar ? (await google.status()).accounts.filter((account) => account.features.includes('tasks')).map((account) => account.email) : [];
      const [feed, fromGoogle, due] = await Promise.all([
        feeds.eventsFor(calendars.filter((calendar) => !calendar.google), from, to, zone, refresh),
        googleCalendars.read(calendars, timeboxes.calendarsFor(planner.state, timeMin, timeMax), timeMin, timeMax, zone, refresh),
        googleDueTasks.read(taskAccounts, from, to, refresh),
      ]);
      const dueEvents = due.items.flatMap((item) => (item.due ? [dueTaskEvent({ ...item, due: item.due }, zone)] : []));
      json(res, 200, {
        events: [...feed.events, ...fromGoogle.events, ...dueEvents].sort((a, b) => a.start.localeCompare(b.start)),
        errors: [...feed.errors, ...fromGoogle.errors, ...due.errors.map((message) => ({ calendarId: GOOGLE_TASKS_CALENDAR, message }))],
      });
      // Sessions moved or deleted in Google follow, once the answer is on its way.
      if (fromGoogle.reads.size) void timeboxes.reconcile(fromGoogle.reads, timeMin, timeMax).catch((error) => log(`Google Calendar: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // Google Calendar's search: the calendars shown, a year back and two ahead, in date order.
    if (url.pathname === '/calendar/search' && req.method === 'GET') {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!query || query.length > 200) {
        json(res, 400, { error: 'q must be 1-200 characters' });
        return;
      }
      const zone = planner.state.settings.timezone ?? 'UTC';
      const today = todayIn(zone);
      const [from, to] = [addDays(today, -366), addDays(today, 731)];
      const [timeMin, timeMax] = [instantAt(from, 0, zone), instantAt(addDays(to, 1), 0, zone)];
      const shown = Object.values(planner.state.calendars).filter((calendar) => calendar.visible);
      const needle = query.toLocaleLowerCase();
      const errors: { calendarId: string; message: string }[] = [];
      let more = false;
      const [feed, ...fromGoogle] = await Promise.all([
        feeds.eventsFor(shown.filter((calendar) => !calendar.google), from, to, zone),
        ...shown.filter((calendar) => calendar.google).map((calendar) =>
          googleData.searchEvents(calendar.google!.account, calendar.google!.calendarId, query, timeMin, timeMax, zone, calendar.id).catch((error) => {
            errors.push({ calendarId: calendar.id, message: error instanceof Error ? error.message : String(error) });
            return { events: [], more: false };
          }),
        ),
      ]);
      errors.push(...feed.errors);
      const events = feed.events.filter((event) => `${event.title}\n${event.location}`.toLocaleLowerCase().includes(needle));
      for (const found of fromGoogle) {
        events.push(...found.events);
        more ||= found.more;
      }
      json(res, 200, { events: events.sort((a, b) => a.start.localeCompare(b.start)), from, to, more, errors });
      return;
    }
    if (url.pathname === '/activity' && req.method === 'GET') {
      const taskId = url.searchParams.get('task') ?? '';
      json(res, 200, { events: planner.activity(taskId) });
      return;
    }
    if (url.pathname === '/commands' && req.method === 'POST') {
      const body = (await readJson(req)) as { commands?: unknown };
      if (!Array.isArray(body.commands)) {
        json(res, 400, { error: 'commands must be an array' });
        return;
      }
      // A sync may be merging events from another machine; let it finish first.
      await sync!.idle();
      const result = planner.execute(body.commands);
      if (!result.ok) {
        json(res, 400, { error: result.error, index: result.index });
        return;
      }
      json(res, 200, { applied: result.applied, ...snapshot() });
      syncAgentCommands();
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const shutdown = async (): Promise<void> => {
  server.close();
  await Promise.race([timeboxes.settled(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await store.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, '127.0.0.1');
