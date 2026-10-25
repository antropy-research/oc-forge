// Planner local service. The host starts it with the app's Node runtime, binds it
// to 127.0.0.1, and proxies the panel's serviceRequest calls to it.
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventStore } from './store.ts';
import { Planner } from './planner.ts';
import { CalendarFeeds } from './calendars.ts';
import { daysBetween, isDateKey } from '../src/domain/dates.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const BODY_LIMIT = 1_000_000;
const dir = process.env.PLANNER_DATA_DIR || join(homedir(), '.local', 'share', 'openchamber-planner', 'data');
const store = new EventStore({ dir, log: (message) => console.error(`[planner] ${message}`) });
await store.init();
const planner = new Planner(store);
// Feed copies are a cache, kept beside the git-tracked data rather than in it.
const feeds = new CalendarFeeds(join(dirname(dir), 'cache'));

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
      json(res, 200, { ok: true, version: planner.state.version });
      return;
    }
    if (url.pathname === '/state' && req.method === 'GET') {
      json(res, 200, planner.snapshot());
      return;
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
      const result = planner.execute(body.commands);
      if (!result.ok) {
        json(res, 400, { error: result.error, index: result.index });
        return;
      }
      json(res, 200, { applied: result.applied, ...planner.snapshot() });
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
