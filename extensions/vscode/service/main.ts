// The VS Code extension's local service. The host starts it with the app's
// Node runtime on 127.0.0.1 and proxies the frames' serviceRequest calls to it.
// It is the embedded workbench's only way to the VS Code Server: it prepares
// the compiled workbench for the frame, carries its web sockets, reads its
// remote resources, fetches from the extension gallery, and keeps its storage.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConnectionToken, parseServerUrl } from '../src/settings.ts';
import { isExternalAllowed } from '../src/workbench.ts';
import { WorkbenchAssets } from './assets.ts';
import { EditorRequests, readTabs, SavedTabs } from './editors.ts';
import { Rail } from './rail.ts';
import { RESOURCE_MAX, ServerError, VscodeServer } from './server.ts';
import { isStateRole, readOps, WorkbenchState } from './state.ts';
import { Tunnels } from './tunnel.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const BODY_LIMIT = 200_000;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (message: string): void => console.error(`[vscode] ${message}`);
const assets = new WorkbenchAssets(
  join(packageRoot, 'vscode-web'),
  async () => JSON.parse(await readFile(join(packageRoot, 'service', 'web-files.json'), 'utf8')) as string[],
  log,
  undefined,
  join(packageRoot, 'webview'),
);
const tunnels = new Tunnels();
const stateDir = process.env.OPENCHAMBER_VSCODE_DATA_DIR || join(homedir(), '.local', 'share', 'openchamber-vscode', 'state');
const state = new WorkbenchState(stateDir, log);
// OpenChamber's own surfaces (oc-forge's adapters): the rail, editors handed to the page, the page's tabs.
const rail = new Rail(join(stateDir, 'rail.json'), (url, token) => new VscodeServer(url, token), log);
const editorRequests = new EditorRequests();
const savedTabs = new SavedTabs(stateDir, log);

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
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
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = text ? (JSON.parse(text) as unknown) : {};
        resolve(typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });

/** The VS Code Server a request names: its address and token, as the frame keeps them in its settings. */
const serverOf = (body: Record<string, unknown>): VscodeServer => {
  const url = typeof body.serverUrl === 'string' ? parseServerUrl(body.serverUrl) : null;
  if (!url) throw new ServerError('Set the VS Code Server address first.', 400);
  if (body.token !== undefined && body.token !== null && !isConnectionToken(body.token)) throw new ServerError('That connection token is not valid.', 400);
  return new VscodeServer(url, (body.token as string | null | undefined) ?? null);
};

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  // The server's workbench configuration, commit and version, and whether its workbench is ready here.
  '/connect': async (body) => {
    const server = serverOf(body);
    const page = await server.page();
    // The rail lists this server's extensions from now on.
    await rail.remember(server.url, (body.token as string | null | undefined) ?? null);
    return { commit: page.commit, base: page.base, version: await server.version(page.base), config: page.config, assets: assets.status(page.commit) };
  },
  // A workbench tells where the server keeps its extensions (its remote environment's extensionsPath).
  '/rail/source': async (body) => {
    const server = serverOf(body);
    const path = typeof body.extensionsPath === 'string' && body.extensionsPath.startsWith('/') && body.extensionsPath.length <= 4096 && !body.extensionsPath.includes('\0') ? body.extensionsPath : null;
    if (!path) throw new ServerError('extensionsPath is required', 400);
    await rail.remember(server.url, (body.token as string | null | undefined) ?? null, path);
    return { ok: true };
  },
  // An editor a rail view or the terminal hands to the page, waiting for the page to take it.
  '/editors/request': async (body) => {
    if (typeof body.key !== 'string' || !body.key || body.key.length > 1024 || typeof body.open !== 'object' || body.open === null) throw new ServerError('key and open are required', 400);
    editorRequests.put(body.key, body.open);
    return { ok: true };
  },
  '/editors/take': async (body) => {
    if (typeof body.key !== 'string') throw new ServerError('key is required', 400);
    return { open: editorRequests.take(body.key) };
  },
  // The page's header tabs, so a frame can bring them back after OpenChamber reloads.
  '/tabs/save': async (body) => {
    const server = serverOf(body);
    await savedTabs.save(WorkbenchState.keyOf(server.url, null), readTabs(body.tabs));
    return { ok: true };
  },
  '/tabs/load': async (body) => {
    const server = serverOf(body);
    return { tabs: await savedTabs.load(WorkbenchState.keyOf(server.url, null)) };
  },
  // Start (or follow) preparing the compiled workbench of the server's commit.
  '/assets/prepare': async (body) => {
    const server = serverOf(body);
    const page = await server.page();
    return { commit: page.commit, assets: assets.prepare(server, page) };
  },
  '/tunnel/open': async (body) => {
    const server = serverOf(body);
    if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 4096) throw new ServerError('path is required', 400);
    return { id: tunnels.open(server.socketUrl(body.path), server.socketHeaders()) };
  },
  '/tunnel/send': async (body) => {
    if (typeof body.id !== 'string' || !Array.isArray(body.chunks) || !body.chunks.every((chunk) => typeof chunk === 'string')) throw new ServerError('id and chunks are required', 400);
    if (!tunnels.has(body.id)) return { closed: true };
    tunnels.send(body.id, body.chunks as string[]);
    return { ok: true };
  },
  '/tunnel/recv': async (body) => {
    if (typeof body.id !== 'string') throw new ServerError('id is required', 400);
    return tunnels.receive(body.id);
  },
  '/tunnel/close': async (body) => {
    if (typeof body.id === 'string') tunnels.close(body.id);
    return { ok: true };
  },
  // A GET the workbench makes to its server: a remote resource, a static or web extension file.
  '/remote/get': async (body) => {
    const server = serverOf(body);
    if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 8192) throw new ServerError('path is required', 400);
    const answer = await server.get(body.path);
    return { status: answer.status, contentType: answer.contentType, data: answer.body.toString('base64') };
  },
  // The extension gallery and VS Code's CDN (marketplace queries, extension icons), nothing else.
  '/external/fetch': async (body) => {
    const url = typeof body.url === 'string' ? body.url : '';
    if (!isExternalAllowed(url)) throw new ServerError('That address is not one the VS Code view may reach.', 403);
    const method = body.method === 'POST' ? 'POST' : 'GET';
    const headers: Record<string, string> = {};
    if (body.headers && typeof body.headers === 'object') {
      for (const [name, value] of Object.entries(body.headers as Record<string, unknown>)) {
        if (typeof value === 'string' && /^(accept|accept-language|content-type|x-market-client-id|x-market-user-id|vscode-sessionid|x-client-name|x-client-version)$/i.test(name)) headers[name] = value;
      }
    }
    const payload = method === 'POST' && typeof body.body === 'string' ? Buffer.from(body.body, 'base64') : undefined;
    const response = await fetch(url, { method, headers, body: payload, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > RESOURCE_MAX) throw new ServerError('The answer is too large.', 413);
    return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', data: data.toString('base64') };
  },
  // A frame in one of OpenChamber's own surfaces names its role: its layout and open editors are its own.
  '/state/load': async (body) => {
    const server = serverOf(body);
    const key = WorkbenchState.keyOf(server.url, null);
    return isStateRole(body.role) ? state.loadRole(key, body.role) : state.load(key);
  },
  '/state/apply': async (body) => {
    const server = serverOf(body);
    const key = WorkbenchState.keyOf(server.url, null);
    if (isStateRole(body.role)) await state.applyRole(key, body.role, readOps(body.ops));
    else await state.apply(key, readOps(body.ops));
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true, tunnels: tunnels.size(), sockets: tunnels.sockets() });
      return;
    }
    // Polled by an adapted OpenChamber (manifest `ocForge.rail`): one rail icon per entry.
    if (url.pathname === '/rail' && req.method === 'GET') {
      json(res, 200, { entries: await rail.entries() });
      return;
    }
    const route = req.method === 'POST' ? routes[url.pathname] : undefined;
    if (!route) {
      json(res, 404, { error: 'not found' });
      return;
    }
    json(res, 200, await route(await readJson(req)));
  } catch (error) {
    const status = error instanceof ServerError ? error.status : 500;
    json(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

const shutdown = async (): Promise<void> => {
  server.close();
  tunnels.dispose();
  await state.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, '127.0.0.1');
