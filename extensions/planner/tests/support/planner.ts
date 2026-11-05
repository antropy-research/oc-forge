// The Planner end to end, without a browser: the real service process as OpenChamber starts it (a loopback port and a
// bearer token), with its plan, its keys and its gh configuration in a temporary home; Google, GitHub and Linear faked
// on this machine by the journeys' own fakes (tests/e2e/); and Planner windows made of the panel's own client and
// stores, as panel/main.tsx makes them, talking to the service as OpenChamber relays them. What a window asks of
// OpenChamber (notifications, links it opens, chats it starts, Linear requests) is kept on it.
//
//   const planner = usePlanner({ google: true });        // one Planner for the test file
//   const window = await planner.window();               // a Planner window, loaded
//   await window.client.dispatch([...]);                 // what the panel does
//   expect((await planner.state()).tasks[id]).toMatchObject(...);
//
// Nothing reaches a real account: the service gets only PATH, HOME, LANG and TZ from this process, gh is a stub that
// is not signed in unless the fake GitHub is asked for, and Google and Linear go to the fakes.
import { afterAll, beforeAll } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AttachIssueRequest,
  GenerateRequest,
  GuestActionItem,
  GuestProject,
  GuestSessionsSnapshot,
  GuestWorktree,
  HostClient,
  JsonValue,
  ResolveRequest,
  StartSessionRequest,
  ToastRequest,
} from '@openchamber/sdk';
import { PlannerClient } from '../../panel/lib/client.ts';
import { LinearStore } from '../../panel/lib/linear.ts';
import { AgentStore } from '../../panel/lib/agents.ts';
import { GitHubStore } from '../../panel/lib/github.ts';
import { GoogleStore } from '../../panel/lib/google.ts';
import { GmailStore } from '../../panel/lib/gmail.ts';
import { registerBackground } from '../../panel/lib/background.ts';
import type { EventBody } from '../../src/domain/events.ts';
import type { PlannerState } from '../../src/domain/types.ts';
import { defaultFakeWorld, startFakeGoogle, type FakeGoogle, type FakeWorld } from '../e2e/fakeGoogle.mjs';
import { defaultGithubWorld, ghConfigFiles, startFakeGithub, type FakeGithub } from '../e2e/fakeGithub.mjs';
import { answerLinear, defaultLinearWorld, type LinearWorld } from '../e2e/linearFake.mjs';

const SERVICE = join(import.meta.dir, '../../service/main.ts');

/** One GraphQL request the Planner sent to Linear: through OpenChamber's connection, or with a workspace's API key. */
export type LinearCall = { op: string | undefined; variables: Record<string, unknown>; query: string; key: string | null };
/** Answers a Linear request; `undefined` gives the fake world's own answer. */
export type LinearAnswer = (call: LinearCall, world: LinearWorld) => unknown | Promise<unknown>;

export type PlannerOptions = {
  /** The plan's time zone; the default is this process's. */
  zone?: string;
  /** A fake Google (this world, or the default one for `true`), with the service signed in to its account. */
  google?: FakeWorld | true;
  /** A fake GitHub behind the real `gh` (signed in, on a socket), with a git server for pushes when `git` is set. */
  github?: true | { world?: ReturnType<typeof defaultGithubWorld>; git?: boolean };
  /** OpenChamber's Linear connection, answered from this world (the default one for `true`). */
  linear?: LinearWorld | true;
  /** Linear workspaces added with an API key (the service's own requests), answered from this world. */
  linearApi?: LinearWorld | true;
  /** Answers Linear before the world does: errors, slow answers, documents the world lacks. */
  linearAnswer?: LinearAnswer;
  /** What the Small Model answers (`host.generate`). */
  generate?: (request: GenerateRequest) => string | Promise<string>;
  /** Files in the service's home before it starts, by path under it (the plan is `data/`, keys sit beside it). */
  files?: Record<string, string>;
  /** More environment for the service. */
  env?: Record<string, string>;
};

export type WindowOptions = {
  /** Which surface the window is (the stores start differently in the Work Status section and the background). */
  surface?: 'panel' | 'status' | 'background';
  /** The folder of the chat on screen. */
  directory?: string | null;
  /** The chat on screen. */
  session?: { id: string; title?: string } | null;
  /** OpenChamber's projects, as `onProjects` and `listProjects` answer. */
  projects?: GuestProject[];
  /** Each project's worktrees, as `listWorktrees` answers. */
  worktrees?: Record<string, GuestWorktree[]>;
  /** The browser's storage for the extension: windows given the same map share it, as a browser's tabs do. */
  storage?: Map<string, JsonValue>;
  /** Whether OpenChamber's Linear connection is signed in (default: when the Planner has `linear`). */
  linearConnected?: boolean;
  /** Load the client before handing the window over (default true). */
  load?: boolean;
};

export type PlannerWindow = {
  host: HostClient;
  client: PlannerClient;
  linear: LinearStore;
  agents: AgentStore;
  github: GitHubStore;
  google: GoogleStore;
  gmail: GmailStore;
  /** OpenChamber notifications the window showed. */
  toasts: ToastRequest[];
  /** Links it opened (`host.openUrl`). */
  opened: string[];
  /** Surfaces it asked OpenChamber to show (`host.openSurface`). */
  surfaces: string[];
  /** Chats it started (`host.startSession`), with the ids they got. */
  started: Array<StartSessionRequest & { sessionId: string }>;
  /** Chats it opened (`host.openSession`). */
  openedSessions: string[];
  /** Its rail badge, as last set. */
  badge: unknown;
  /** A declared action run on a message or a chat, as OpenChamber's background frame runs it. */
  action(item: GuestActionItem): Promise<void>;
  /** A slash command (`/task …`, `/today`) resolved as the composer does. */
  resolve(request: ResolveRequest): Promise<AttachIssueRequest | null>;
  /** The chat on screen changes. */
  setSession(session: { id: string; title?: string } | null, directory?: string | null): void;
  /** OpenChamber's chats of a project, as `onSessions` hears them. */
  setSessions(snapshot: GuestSessionsSnapshot): void;
};

export type Planner = {
  base: string;
  token: string;
  home: string;
  zone: string;
  google: FakeGoogle | null;
  github: FakeGithub | null;
  /** The world OpenChamber's Linear connection answers from. */
  linear: LinearWorld | null;
  /** The world the service's API-key workspaces answer from. */
  linearApi: LinearWorld | null;
  /** Every Linear request, through the connection or with a key. */
  linearCalls: LinearCall[];
  /** The service's output, for a failing test's message. */
  log: string[];
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Commands as a window sends them; throws when the service refuses one. */
  commands(...bodies: EventBody[]): Promise<void>;
  state(): Promise<PlannerState>;
  window(options?: WindowOptions): Promise<PlannerWindow>;
  /** Stops the service and starts it again on the same home (a restart, or a reload of every window). */
  restart(): Promise<void>;
  stop(): Promise<void>;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it answers something truthy, or `timeout` passes (then the last answer). */
export const until = async <T>(probe: () => T | Promise<T>, timeout = 5000, every = 25): Promise<T> => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > end) return value;
    await sleep(every);
  }
};

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
  });

const operation = (query: string) => /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];

let commandSeq = 0;
const commandId = () => `e2e${Date.now().toString(36)}${String(++commandSeq).padStart(6, '0')}`;

export const startPlanner = async (options: PlannerOptions = {}): Promise<Planner> => {
  const home = mkdtempSync(join(tmpdir(), 'planner-e2e-'));
  const zone = options.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const token = randomBytes(24).toString('hex');
  const log: string[] = [];
  const linearCalls: LinearCall[] = [];
  const linear = options.linear === true ? defaultLinearWorld() : options.linear ?? null;
  const linearApi = options.linearApi === true ? defaultLinearWorld() : options.linearApi ?? null;
  const answer = async (call: LinearCall, world: LinearWorld | null) => {
    linearCalls.push(call);
    const custom = options.linearAnswer ? await options.linearAnswer(call, world ?? defaultLinearWorld()) : undefined;
    const data = custom !== undefined ? custom : world ? answerLinear(world, call.op, call.variables) : null;
    return data ? { data } : { errors: [{ message: `fake Linear: unexpected ${call.op}` }] };
  };

  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text, { mode: 0o600 });
  }

  // gh: the real one signed in to the fake GitHub, or a stub that is not signed in, so no real account is reached.
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  let github: FakeGithub | null = null;
  let path = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  if (options.github) {
    const settings = options.github === true ? {} : options.github;
    github = await startFakeGithub({ socket: join(home, 'gh.sock'), ...(settings.git ? { gitPort: 0 } : {}), world: settings.world ?? defaultGithubWorld() });
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    for (const [name, text] of Object.entries(ghConfigFiles(github.socket!))) writeFileSync(join(home, '.config', 'gh', name), text, { mode: 0o600 });
  } else {
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: not logged in (planner e2e)" >&2\nexit 4\n');
    chmodSync(join(bin, 'gh'), 0o755);
    path = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  }

  let google: FakeGoogle | null = null;
  if (options.google) {
    google = await startFakeGoogle(options.google === true ? defaultFakeWorld({ zone }) : options.google);
    writeFileSync(join(home, 'google-accounts.json'), google.accountsFile(), { mode: 0o600 });
  }

  // The service's API-key workspaces reach this fake Linear (PLANNER_LINEAR_API_BASE).
  let linearServer: Server | null = null;
  let linearBase: string | null = null;
  if (linearApi || options.linearAnswer) {
    linearServer = createHttpServer(async (request, response) => {
      const { query = '', variables = {} } = JSON.parse((await readBody(request)) || '{}');
      const key = String(request.headers.authorization ?? '') || null;
      const body = await answer({ op: operation(query), variables, query, key }, linearApi);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => linearServer!.listen(0, '127.0.0.1', () => resolve()));
    linearBase = `http://127.0.0.1:${(linearServer.address() as AddressInfo).port}/`;
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: path,
    HOME: home,
    LANG: 'C.UTF-8',
    TZ: process.env.TZ ?? '',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    OPENCHAMBER_SERVICE_PORT: String(port),
    OPENCHAMBER_SERVICE_TOKEN: token,
    PLANNER_DATA_DIR: join(home, 'data'),
    ...(google ? { PLANNER_GOOGLE_API_BASE: `${google.base.replace(/\/?$/, '/')}` } : {}),
    ...(linearBase ? { PLANNER_LINEAR_API_BASE: linearBase } : {}),
    ...options.env,
  };

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the text itself.
    }
    return { status: response.status, body: parsed };
  };

  let child: ChildProcess | null = null;
  const start = async () => {
    child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (data) => log.push(String(data)));
    child.stderr?.on('data', (data) => log.push(String(data)));
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).status < 500) return;
      } catch {
        // Not listening yet.
      }
      if (attempt > 200) throw new Error(`the Planner service did not start:\n${log.join('')}`);
      await sleep(50);
    }
  };
  const halt = async () => {
    const running = child;
    child = null;
    if (!running || running.exitCode !== null) return;
    // Let it finish its last commit before its home goes.
    const exited = new Promise((resolve) => running.once('exit', resolve));
    running.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
  };

  await start();

  const commands = async (...bodies: EventBody[]) => {
    const answered = await call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: commandId(), ...body })) });
    if (answered.status !== 200) throw new Error(`the service refused ${bodies.map((body) => body.type).join(', ')}: ${JSON.stringify(answered.body)}`);
  };
  await commands({ type: 'settings.updated', patch: { timezone: zone } });

  const window = async (settings: WindowOptions = {}): Promise<PlannerWindow> => {
    const surface = settings.surface ?? 'panel';
    const storage = settings.storage ?? new Map<string, JsonValue>();
    const toasts: ToastRequest[] = [];
    const opened: string[] = [];
    const surfaces: string[] = [];
    const started: PlannerWindow['started'] = [];
    const openedSessions: string[] = [];
    let session = settings.session ? { id: settings.session.id, title: settings.session.title ?? settings.session.id } : null;
    let directory = settings.directory ?? null;
    const sessionListeners = new Set<(snapshot: any) => void>();
    const directoryListeners = new Set<(directory: string | null) => void>();
    const sessionsListeners = new Map<string, Set<(snapshot: GuestSessionsSnapshot) => void>>();
    let onAction: ((item: GuestActionItem) => void | Promise<void>) | null = null;
    let onResolve: ((request: ResolveRequest) => Promise<AttachIssueRequest | null> | AttachIssueRequest | null) | null = null;
    const projects = settings.projects ?? [];
    const snapshotOf = () => (session ? { id: session.id, title: session.title, directory } : null);
    const connected = settings.linearConnected ?? Boolean(linear);
    const win: Partial<PlannerWindow> & { badge: unknown } = { toasts, opened, surfaces, started, openedSessions, badge: null };
    const host = {
      serviceRequest: async ({ method, path, body }: { method: string; path: string; body?: string }) => {
        const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
        return { status: response.status, body: await response.text() };
      },
      serviceStatus: async () => ({ state: 'running' }),
      // OpenChamber's Linear connection.
      request: async ({ body }: { method: string; path: string; body?: string }) => {
        if (!connected) return { status: 401, body: JSON.stringify({ errors: [{ message: 'Linear is not connected' }] }) };
        const { query = '', variables = {} } = JSON.parse(body ?? '{}');
        return { status: 200, body: JSON.stringify(await answer({ op: operation(query), variables, query, key: null }, linear)) };
      },
      onConnection: (listener: (connection: unknown) => void) => {
        listener({ connected, account: connected ? linear?.viewer.name ?? 'Linear' : null });
        return () => {};
      },
      oauthStart: async () => {},
      oauthDisconnect: async () => {},
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: JsonValue) => void storage.set(key, value),
        delete: async (key: string) => void storage.delete(key),
        keys: async () => [...storage.keys()],
      },
      toast: async (toast: ToastRequest) => void toasts.push(toast),
      openUrl: async (url: string) => void opened.push(url),
      openSurface: async (id: string) => void surfaces.push(id),
      setBadge: async (badge: unknown) => void (win.badge = badge),
      generate: async (request: GenerateRequest) => {
        if (!options.generate) throw Object.assign(new Error('No model'), { code: 'NO_MODEL' });
        return { text: await options.generate(request) };
      },
      onSession: (listener: (snapshot: any) => void) => {
        sessionListeners.add(listener);
        listener(snapshotOf());
        return () => sessionListeners.delete(listener);
      },
      onDirectory: (listener: (directory: string | null) => void) => {
        directoryListeners.add(listener);
        listener(directory);
        return () => directoryListeners.delete(listener);
      },
      listProjects: async () => ({ kind: 'projects', state: 'ready', projects }),
      onProjects: async (listener: (snapshot: unknown) => void) => {
        listener({ kind: 'projects', state: 'ready', projects });
        return () => {};
      },
      listWorktrees: async (projectId: string) => ({ kind: 'worktrees', projectId, state: 'ready', worktrees: settings.worktrees?.[projectId] ?? [] }),
      onSessions: async (projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void) => {
        const listeners = sessionsListeners.get(projectId) ?? new Set();
        listeners.add(listener);
        sessionsListeners.set(projectId, listeners);
        return () => listeners.delete(listener);
      },
      startSession: async (request: StartSessionRequest) => {
        const sessionId = `ses_e2e${String(started.length + 1).padStart(4, '0')}${randomBytes(3).toString('hex')}`;
        started.push({ ...request, sessionId });
        return { sessionId };
      },
      openSession: async (id: string) => void openedSessions.push(id),
      onAction: (handler: typeof onAction) => {
        onAction = handler;
        return () => {};
      },
      onResolve: (handler: typeof onResolve) => {
        onResolve = handler;
        return () => {};
      },
    } as unknown as HostClient;
    const client = new PlannerClient(host);
    // As panel/main.tsx does: actions and slash commands answered from the start, then the stores.
    registerBackground(host, client);
    const google = new GoogleStore(host, client, surface);
    Object.assign(win, {
      host,
      client,
      linear: new LinearStore(host, client, surface),
      agents: new AgentStore(host, client, surface),
      github: new GitHubStore(client, surface),
      google,
      gmail: new GmailStore(client, google, surface),
      action: async (item: GuestActionItem) => {
        if (!onAction) throw new Error('no action handler registered');
        await onAction(item);
      },
      resolve: async (request: ResolveRequest) => {
        if (!onResolve) throw new Error('no resolve handler registered');
        return onResolve(request);
      },
      setSession: (next: { id: string; title?: string } | null, nextDirectory: string | null = directory) => {
        session = next ? { id: next.id, title: next.title ?? next.id } : null;
        directory = nextDirectory;
        for (const listener of sessionListeners) listener(snapshotOf());
        for (const listener of directoryListeners) listener(directory);
      },
      setSessions: (snapshot: GuestSessionsSnapshot) => {
        for (const listener of sessionsListeners.get(snapshot.projectId) ?? []) listener(snapshot);
      },
    });
    if (settings.load ?? true) await client.load();
    return win as PlannerWindow;
  };

  const planner: Planner = {
    base,
    token,
    home,
    zone,
    google,
    github,
    linear,
    linearApi,
    linearCalls,
    log,
    call,
    commands,
    state: async () => (await call('GET', '/state')).body.state,
    window,
    restart: async () => {
      await halt();
      await start();
    },
    stop: async () => {
      await halt();
      await google?.close();
      await github?.close();
      await new Promise((resolve) => (linearServer ? linearServer.close(resolve) : resolve(null)));
      rmSync(home, { recursive: true, force: true });
    },
  };
  return planner;
};

/**
 * One Planner for a test file: started before its tests, stopped after them. The object is filled in once it has
 * started, so read it inside tests.
 */
export const usePlanner = (options: PlannerOptions = {}): Planner => {
  const planner = {} as Planner;
  beforeAll(async () => {
    Object.assign(planner, await startPlanner(options));
  }, 60_000);
  afterAll(async () => {
    await planner.stop?.();
  });
  return planner;
};

/** The path of the real `gh` on this machine, or null (GitHub's scenarios then skip). */
export const realGh = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();
