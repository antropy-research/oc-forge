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
import { daysBetween, isDateKey } from '../src/domain/dates.ts';

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

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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
      json(res, 200, await feeds.eventsFor(Object.values(planner.state.calendars), from, to, zone, url.searchParams.get('refresh') === '1'));
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
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const shutdown = async (): Promise<void> => {
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, '127.0.0.1');
