// OpenChamber's bridge between the VS Code workbenches of one folder (spike: round 14, phase 1).
//
// Each part of VS Code in OpenChamber (the rail view, the page, the bottom terminal) is a workbench of its own, with an
// extension host of its own on the VS Code Server's machine. This extension runs in each of them (extensionKind
// `workspace`), learns its part from its frame (the embedder command `openchamber.vscode.bridge.info`), and joins the
// folder's other parts over a local socket. The bottom terminal's workbench is the folder's runtime: debug sessions,
// terminals and tasks run there. The page and the rail send it what they start, and mirror its debug sessions with a
// debug adapter of their own that relays every request to the real session and every event back.
'use strict';
const vscode = require('vscode');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MIRROR = 'openchamber-mirror';
const PARTS = ['view', 'editor', 'terminal'];
const log = vscode.window.createOutputChannel('OpenChamber Bridge', { log: true });
const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);

// ── The folder's parts, over a Unix socket ─────────────────────────────────
// The first part to come listens and relays every message to the others; the others connect. When it goes, the next
// to notice listens. Messages are JSON lines: { type, from: { part, member }, to?: part | member, ... }, delivered in
// the order each part sent them.

class Bus {
  constructor(key, part) {
    this.key = key;
    this.me = { part, member: crypto.randomUUID() };
    this.handlers = new Map();
    this.waiting = new Map();
    this.clients = new Set();
    this.members = new Map([[this.me.member, part]]);
    this.server = null;
    this.socket = null;
    this.disposed = false;
    this.onMembers = new vscode.EventEmitter();
  }

  file() {
    const dir = path.join(os.tmpdir(), `ocvsb-${uid}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${hashOf(this.key)}.sock`);
  }

  async start() {
    const file = this.file();
    for (let attempt = 0; attempt < 5 && !this.disposed; attempt++) {
      if (await this.listen(file)) return;
      if (await this.connect(file)) return;
      // Nobody listens on it: a part that went without closing it.
      try {
        fs.unlinkSync(file);
      } catch {
        // Gone already.
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
    throw new Error(`could not join the folder's parts at ${file}`);
  }

  listen(file) {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', () => resolve(false));
      server.listen(file, () => {
        this.server = server;
        this.members = new Map([[this.me.member, this.me.part]]);
        log.info(`[${this.me.part}] listens for the folder's parts`);
        this.announce();
        resolve(true);
      });
    });
  }

  connect(file) {
    return new Promise((resolve) => {
      const socket = net.connect(file);
      socket.once('error', () => resolve(false));
      socket.once('connect', () => {
        this.socket = socket;
        this.read(socket, (message) => this.deliver(message));
        socket.on('close', () => {
          if (this.socket === socket) this.socket = null;
          if (!this.disposed && !this.away) void this.start().catch((error) => log.error(String(error)));
        });
        this.write(socket, { type: 'hello', from: this.me });
        log.info(`[${this.me.part}] joined the folder's parts`);
        resolve(true);
      });
    });
  }

  accept(socket) {
    this.clients.add(socket);
    this.read(socket, (message) => {
      if (message.type === 'hello') {
        socket.member = message.from.member;
        this.members.set(message.from.member, message.from.part);
        this.announce();
        return;
      }
      this.relay(message, socket);
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      if (socket.member) this.members.delete(socket.member);
      this.announce();
    });
    socket.on('error', () => undefined);
  }

  announce() {
    this.relay({ type: 'members', from: this.me, list: [...this.members].map(([member, part]) => ({ member, part })) }, null);
  }

  read(socket, onMessage) {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch (error) {
          log.error(`bad message: ${error}`);
        }
      }
    });
  }

  write(socket, message) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * As the one listening: to every other part, and to this one. A request for a part goes to one member of it, the
   * one that joined first (two browser tabs on the folder each have a terminal's part: one runtime runs what is asked).
   */
  relay(message, origin) {
    if (message.reqId && PARTS.includes(message.to)) {
      const member = [...this.members].find(([, part]) => part === message.to)?.[0];
      if (!member) {
        const reply = { type: 'reply', from: { part: 'bus', member: 'bus' }, to: message.from.member, reqId: message.reqId, ok: false, error: `no ${message.to} part` };
        if (origin) this.write(origin, reply);
        else this.deliver(reply);
        return;
      }
      message = { ...message, to: member };
    }
    for (const client of this.clients) if (client !== origin) this.write(client, message);
    if (origin !== null || message.type === 'members' || (message.to && message.to === this.me.member)) this.deliver(message);
  }

  deliver(message) {
    if (message.type === 'members') {
      this.members = new Map(message.list.map((item) => [item.member, item.part]));
      this.onMembers.fire([...this.members.values()]);
      return;
    }
    if (message.from?.member === this.me.member) return;
    if (message.to && message.to !== this.me.part && message.to !== this.me.member) return;
    if (message.type === 'reply') {
      const waiter = this.waiting.get(message.reqId);
      if (waiter) {
        this.waiting.delete(message.reqId);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(new Error(message.error ?? 'failed'));
      }
      return;
    }
    const handler = this.handlers.get(message.type);
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(message))
      .then((value) => {
        if (message.reqId) this.send({ type: 'reply', to: message.from.member, reqId: message.reqId, ok: true, value });
      }, (error) => {
        log.error(`${message.type}: ${error?.message ?? error}`);
        if (message.reqId) this.send({ type: 'reply', to: message.from.member, reqId: message.reqId, ok: false, error: String(error?.message ?? error) });
      });
  }

  send(message) {
    const full = { ...message, from: this.me };
    if (this.server) this.relay(full, null);
    else if (this.socket) this.write(this.socket, full);
  }

  request(to, type, payload = {}, timeoutMs = 15_000) {
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error(`${type}: no answer from the ${to} part`));
      }, timeoutMs);
      this.waiting.set(reqId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...payload, type, to, reqId });
    });
  }

  /** Every other part's answer, each within `ms`. */
  async gather(type, payload = {}, ms = 1_500) {
    const others = [...this.members.keys()].filter((member) => member !== this.me.member);
    const answers = await Promise.all(others.map((member) => this.request(member, type, payload, ms).catch(() => null)));
    return answers.filter((answer) => answer !== null && answer !== undefined);
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  has(part) {
    return [...this.members.values()].includes(part);
  }

  /** This part's window went (it doesn't answer): out of the folder's parts until it answers again. */
  leave() {
    this.away = true;
    this.socket?.destroy();
    this.socket = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.members = new Map([[this.me.member, this.me.part]]);
    log.info(`[${this.me.part}] its window doesn't answer: it leaves the folder's parts`);
  }

  async rejoin() {
    this.away = false;
    log.info(`[${this.me.part}] its window answers again: it rejoins`);
    await this.start();
  }

  dispose() {
    this.disposed = true;
    this.socket?.destroy();
    for (const client of this.clients) client.destroy();
    this.server?.close();
  }
}

// ── Breakpoints: one list for the folder's parts ───────────────────────────
// Each part's workbench keeps its own. A change in one goes to the others with the stable breakpoints API, and to the
// folder's one list on the server (in the bridge's global storage, which every part shares): a part that joins takes
// that list, so a breakpoint removed while it was away stays removed. The first time, it is what every part had.

const breakpointKey = (bp) => {
  if (bp instanceof vscode.SourceBreakpoint) return `src|${bp.location.uri.toString()}|${bp.location.range.start.line}|${bp.location.range.start.character}`;
  if (bp instanceof vscode.FunctionBreakpoint) return `fn|${bp.functionName}`;
  return null;
};

const breakpointData = (bp) => ({
  key: breakpointKey(bp),
  kind: bp instanceof vscode.SourceBreakpoint ? 'source' : 'function',
  uri: bp instanceof vscode.SourceBreakpoint ? bp.location.uri.toString() : undefined,
  line: bp instanceof vscode.SourceBreakpoint ? bp.location.range.start.line : undefined,
  character: bp instanceof vscode.SourceBreakpoint ? bp.location.range.start.character : undefined,
  functionName: bp instanceof vscode.FunctionBreakpoint ? bp.functionName : undefined,
  enabled: bp.enabled,
  condition: bp.condition || undefined,
  hitCondition: bp.hitCondition || undefined,
  logMessage: bp.logMessage || undefined,
});

const breakpointOf = (data) => (data.kind === 'source'
  ? new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.parse(data.uri), new vscode.Position(data.line, data.character)), data.enabled, data.condition, data.hitCondition, data.logMessage)
  : new vscode.FunctionBreakpoint(data.functionName, data.enabled, data.condition, data.hitCondition, data.logMessage));

const syncBreakpoints = (bus, file) => {
  const sorted = (list) => [...list].sort((a, b) => a.key.localeCompare(b.key));
  const local = () => sorted(vscode.debug.breakpoints.map(breakpointData).filter((data) => data.key));
  let known = JSON.stringify(local());
  let applying = false;
  const save = (list) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify({ at: Date.now(), list }));
      fs.renameSync(`${file}.${process.pid}`, file);
    } catch (error) {
      log.warn(`could not keep the folder's breakpoints: ${error}`);
    }
  };
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).list ?? null;
    } catch {
      return null;
    }
  };
  const apply = (list) => {
    const wanted = new Map(list.map((data) => [data.key, JSON.stringify(data)]));
    const have = vscode.debug.breakpoints.filter((bp) => breakpointKey(bp));
    const remove = have.filter((bp) => wanted.get(breakpointKey(bp)) !== JSON.stringify(breakpointData(bp)));
    const kept = new Set(have.filter((bp) => !remove.includes(bp)).map(breakpointKey));
    const add = list.filter((data) => !kept.has(data.key)).map(breakpointOf);
    applying = true;
    try {
      if (remove.length) vscode.debug.removeBreakpoints(remove);
      if (add.length) vscode.debug.addBreakpoints(add);
    } finally {
      applying = false;
    }
    known = JSON.stringify(local());
  };
  const disposable = vscode.debug.onDidChangeBreakpoints(() => {
    if (applying) return;
    const now = JSON.stringify(local());
    if (now === known) return;
    known = now;
    const list = JSON.parse(now);
    save(list);
    bus.send({ type: 'bp.list', list });
  });
  bus.on('bp.list', (message) => apply(message.list));
  bus.on('bp.ask', () => local());
  const join = async () => {
    const list = saved();
    if (list) {
      apply(list);
      return;
    }
    const answers = await bus.gather('bp.ask');
    const union = new Map([...answers.flat(), ...local()].map((data) => [data.key, data]));
    const all = sorted([...union.values()]);
    apply(all);
    save(all);
    bus.send({ type: 'bp.list', list: all });
  };
  return { disposable, join };
};

// ── The runtime: the bottom terminal's workbench ───────────────────────────

/** What a mirror hears of the real session: DAP's events but those that are this workbench's own (see Mirror). */
const FORWARDED = new Set(['stopped', 'continued', 'exited', 'terminated', 'thread', 'module', 'loadedSource', 'process', 'capabilities', 'invalidated', 'memory']);
/** Requests that set a stopped thread running: the other mirrors hear it ran on (VS Code tells only the one that asked). */
const RUNS = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto']);

const startRuntime = (bus, context, folder, authority) => {
  /** Real sessions by id, their adapter's capabilities, and the threads stopped now (replayed to a mirror that comes late). */
  const sessions = new Map();
  const capabilities = new Map();
  const stopped = new Map();
  const announce = (session) => bus.send({
    type: 'session.started',
    realId: session.id,
    parentId: session.parentSession?.id,
    name: session.name,
    request: session.configuration.request === 'attach' ? 'attach' : 'launch',
    noDebug: Boolean(session.configuration.noDebug),
  });
  // A request's file as the main thread names a server's file: a plain path would be the browser's (`vscode-local`).
  const toMainThread = (args) => {
    const source = args?.source;
    if (!authority || !source || typeof source.path !== 'string' || !path.isAbsolute(source.path) || source.sourceReference > 0) return args;
    return { ...args, source: { ...source, path: vscode.Uri.from({ scheme: 'vscode-remote', authority, path: source.path }).toString() } };
  };
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: (session) => ({
      onDidSendMessage: (message) => {
        if (message.type === 'response' && message.command === 'initialize') capabilities.set(session.id, message.body ?? {});
        if (message.type !== 'event') return;
        if (message.event === 'stopped') {
          const threads = stopped.get(session.id) ?? new Map();
          threads.set(message.body?.allThreadsStopped ? 'all' : message.body?.threadId, message.body);
          stopped.set(session.id, threads);
        }
        if (message.event === 'continued') {
          if (message.body?.allThreadsContinued !== false) stopped.delete(session.id);
          else stopped.get(session.id)?.delete(message.body?.threadId);
        }
        if (FORWARDED.has(message.event)) bus.send({ type: 'dap.event', realId: session.id, event: message.event, body: message.body });
      },
    }),
  }));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
    if (session.type === MIRROR) return;
    sessions.set(session.id, session);
    announce(session);
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
    if (!sessions.delete(session.id)) return;
    stopped.delete(session.id);
    capabilities.delete(session.id);
    bus.send({ type: 'session.ended', realId: session.id });
  }));
  // A part that joins mirrors what runs already (parents first).
  bus.onMembers.event(() => {
    for (const session of sessions.values()) announce(session);
  });
  const userAsked = () => vscode.commands.executeCommand('openchamber.vscode.bridge.allowFocus').then(undefined, () => undefined);
  bus.on('debug.start', async (message) => {
    const started = Date.now();
    const ok = await vscode.debug.startDebugging(folder, message.config, {
      // Its view and toolbar are the page's and the rail's (mirrors); its console is the bottom panel's, natively.
      suppressDebugView: true,
      suppressDebugToolbar: true,
      suppressDebugStatusbar: true,
      // The part it came from saved its editors.
      suppressSaveBeforeStart: true,
      noDebug: Boolean(message.noDebug),
    });
    log.info(`debug.start ${message.config?.name}: ${ok} in ${Date.now() - started} ms`);
    return ok;
  });
  bus.on('dap.caps', (message) => capabilities.get(message.realId) ?? null);
  bus.on('dap.state', (message) => ({ stopped: [...(stopped.get(message.realId)?.values() ?? [])] }));
  bus.on('dap.request', async (message) => {
    const session = sessions.get(message.realId);
    if (!session) throw new Error('that debug session ended');
    if (RUNS.has(message.command)) {
      // Before the request: its thread may stop again before the answer comes back.
      const threadId = message.args?.threadId;
      const all = !message.args?.singleThread;
      if (all) stopped.delete(session.id);
      else stopped.get(session.id)?.delete(threadId);
      bus.send({ type: 'dap.event', realId: session.id, event: 'continued', body: { threadId, allThreadsContinued: all } });
    }
    return session.customRequest(message.command, toMainThread(message.args));
  });
  bus.on('session.stop', async (message) => {
    const session = sessions.get(message.realId);
    if (session) await vscode.debug.stopDebugging(session);
  });
  // Commands another part asked for: the terminal's and the tasks', run here as VS Code would run them.
  bus.on('run.command', async (message) => {
    await userAsked();
    log.info(`run.command ${message.command}`);
    await vscode.commands.executeCommand(message.command, ...(message.args ?? []));
    return true;
  });
};

// ── The page and the rail: they send what they start, and mirror the runtime's sessions ──

/** VS Code's variables that name the active editor: the page resolves them, the runtime has no editor. */
const EDITOR_VARIABLES = /\$\{(file|fileBasename|fileBasenameNoExtension|fileDirname|fileExtname|relativeFile|relativeFileDirname|lineNumber|selectedText|fileWorkspaceFolder|fileDirnameBasename)\}/g;

const editorValues = () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const file = editor.document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ?? '';
  const relative = folder ? path.relative(folder, file) : file;
  const ext = path.extname(file);
  return {
    file,
    fileBasename: path.basename(file),
    fileBasenameNoExtension: path.basename(file, ext),
    fileDirname: path.dirname(file),
    fileExtname: ext,
    relativeFile: relative,
    relativeFileDirname: path.dirname(relative),
    lineNumber: String(editor.selection.active.line + 1),
    selectedText: editor.document.getText(editor.selection),
    fileWorkspaceFolder: folder,
    fileDirnameBasename: path.basename(path.dirname(file)),
  };
};

const usesEditor = (config) => JSON.stringify(config).match(EDITOR_VARIABLES) !== null;

const substituteEditor = (value, values) => {
  if (typeof value === 'string') return value.replace(EDITOR_VARIABLES, (all, name) => values[name] ?? all);
  if (Array.isArray(value)) return value.map((item) => substituteEditor(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEditor(item, values)]));
  return value;
};

/**
 * A debug adapter in the page or the rail that is the runtime's real session: requests go to it (`customRequest`), its
 * events come back (the runtime's tracker). Its breakpoints are the folder's (synced above), so it answers those itself;
 * its console output is the bottom panel's Debug Console's, and its progress the runtime's.
 */
class Mirror {
  /** `owner`: the runtime (a bus member) that runs the real session. */
  constructor(bus, realId, owner) {
    this.bus = bus;
    this.realId = realId;
    this.owner = owner;
    this.seq = 1;
    this.ended = false;
    this.configured = false;
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
  }

  emit(message) {
    this.emitter.fire({ ...message, seq: this.seq++ });
  }

  respond(request, body, error) {
    this.emit(error
      ? { type: 'response', request_seq: request.seq, command: request.command, success: false, message: error, body: { error: { id: 1, format: error, showUser: false } } }
      : { type: 'response', request_seq: request.seq, command: request.command, success: true, body });
  }

  event(event, body) {
    if (this.ended) return;
    if (event === 'terminated') this.ended = true;
    this.emit({ type: 'event', event, body });
  }

  async handleMessage(message) {
    if (message.type !== 'request') return;
    const args = message.arguments ?? {};
    try {
      switch (message.command) {
        case 'initialize': {
          const caps = await this.bus.request(this.owner, 'dap.caps', { realId: this.realId });
          if (!caps) throw new Error('that debug session ended');
          this.respond(message, { ...caps, supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsRestartRequest: false });
          this.event('initialized');
          return;
        }
        case 'launch':
        case 'attach':
          this.respond(message, {});
          return;
        // Breakpoints are the folder's (the breakpoints API keeps the parts' lists one): the real session has them.
        case 'setBreakpoints':
          this.respond(message, { breakpoints: (args.breakpoints ?? []).map((bp) => ({ verified: true, line: bp.line, column: bp.column })) });
          return;
        case 'setFunctionBreakpoints':
          this.respond(message, { breakpoints: (args.breakpoints ?? []).map(() => ({ verified: true })) });
          return;
        case 'setDataBreakpoints':
        case 'setInstructionBreakpoints':
          this.respond(message, { breakpoints: [] });
          return;
        case 'setExceptionBreakpoints':
          // As the mirror starts, its workbench says what it has; the real session has the runtime's. A change the user
          // makes here afterwards goes to the real session.
          if (!this.configured) {
            this.respond(message, {});
            return;
          }
          this.respond(message, await this.bus.request(this.owner, 'dap.request', { realId: this.realId, command: message.command, args }));
          return;
        case 'configurationDone': {
          this.configured = true;
          this.respond(message, {});
          // What the real session shows now: paused threads, as if it had just stopped.
          const state = await this.bus.request(this.owner, 'dap.state', { realId: this.realId }).catch(() => ({ stopped: [] }));
          for (const body of state.stopped) this.event('stopped', body);
          return;
        }
        case 'terminate':
          // The user's Stop: the real session stops, and its end (`terminated`, which VS Code waits for) ends this one.
          if (!this.ended) this.bus.send({ type: 'session.stop', to: this.owner, realId: this.realId });
          this.respond(message, {});
          return;
        case 'disconnect': {
          // VS Code is done with this adapter. A window that closes or reloads disconnects its sessions with no
          // arguments: the real one goes on. The user's Disconnect stops it.
          const closing = args.terminateDebuggee === undefined && !args.restart;
          if (!this.ended && !closing) this.bus.send({ type: 'session.stop', to: this.owner, realId: this.realId });
          this.ended = true;
          this.respond(message, {});
          return;
        }
        default:
          this.respond(message, await this.bus.request(this.owner, 'dap.request', { realId: this.realId, command: message.command, args }));
      }
    } catch (error) {
      this.respond(message, undefined, String(error?.message ?? error));
    }
  }

  dispose() {
    this.emitter.dispose();
  }
}

const startFront = (bus, context, folder, part) => {
  /** Mirrors by the real session's id: its adapter, and its session once VS Code started it. */
  const mirrors = new Map();
  const live = new Set();
  const mirrorOf = (realId) => {
    let mirror = mirrors.get(realId);
    if (!mirror) {
      let started = () => undefined;
      mirror = { adapter: null, session: null, starting: false, started: new Promise((resolve) => (started = resolve)) };
      mirror.markStarted = started;
      mirrors.set(realId, mirror);
    }
    return mirror;
  };
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(MIRROR, {
    createDebugAdapterDescriptor: (session) => {
      const { realId, owner } = session.configuration.__openchamber ?? {};
      const adapter = new Mirror(bus, realId, owner);
      mirrorOf(realId).adapter = adapter;
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  }));
  // A runtime that went (its window closed) ends the mirrors of its sessions: after a moment, as the parts find each
  // other again when the one that listened went.
  bus.onMembers.event(() => setTimeout(() => {
    for (const [realId, mirror] of mirrors) {
      if (!mirror.owner || bus.members.has(mirror.owner)) continue;
      live.delete(realId);
      mirrors.delete(realId);
      mirror.adapter?.event('terminated');
    }
  }, 5_000));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
    const realId = session.configuration.__openchamber?.realId;
    if (!realId) return;
    const mirror = mirrorOf(realId);
    mirror.session = session;
    mirror.markStarted(session);
  }));
  bus.on('session.started', async (message) => {
    live.add(message.realId);
    const mirror = mirrorOf(message.realId);
    if (mirror.starting || mirror.session) return;
    mirror.starting = true;
    mirror.owner = message.from.member;
    // A child session (js-debug's process under its launch) goes under its parent's mirror.
    const parent = message.parentId && live.has(message.parentId)
      ? await Promise.race([mirrorOf(message.parentId).started, new Promise((resolve) => setTimeout(() => resolve(undefined), 5_000))])
      : undefined;
    const ok = await vscode.debug.startDebugging(folder, {
      type: MIRROR,
      request: message.request,
      name: message.name,
      noDebug: message.noDebug,
      internalConsoleOptions: 'neverOpen',
      __openchamber: { realId: message.realId, owner: message.from.member },
    }, {
      parentSession: parent,
      lifecycleManagedByParent: Boolean(parent),
      compact: Boolean(parent),
      consoleMode: parent ? vscode.DebugConsoleMode.MergeWithParent : vscode.DebugConsoleMode.Separate,
      noDebug: message.noDebug,
      // The page shows the editor's debug UI and its toolbar, never a debug view; the rail shows the debug view.
      suppressDebugView: part === 'editor',
      suppressDebugToolbar: part !== 'editor',
      suppressDebugStatusbar: part !== 'editor',
      suppressSaveBeforeStart: true,
    });
    if (!ok) mirror.starting = false;
    log.info(`[${part}] mirror of ${message.name}: ${ok}`);
  });
  bus.on('dap.event', (message) => {
    mirrors.get(message.realId)?.adapter?.event(message.event, message.body);
  });
  bus.on('session.ended', (message) => {
    live.delete(message.realId);
    const mirror = mirrors.get(message.realId);
    mirrors.delete(message.realId);
    mirror?.adapter?.event('terminated');
  });

  // A launch from here runs in the runtime: caught before VS Code substitutes its variables and runs its preLaunchTask
  // (debugService.createSession), which the runtime does once. The page resolves what names its active editor first.
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('*', {
    resolveDebugConfiguration: async (_folder, config) => {
      // A mirror VS Code starts again (its Restart) for a session that ended: nothing to mirror.
      if (config.type === MIRROR) return live.has(config.__openchamber?.realId) ? config : undefined;
      if (!bus.has('terminal')) return config;
      const noDebug = Boolean(config.noDebug);
      if (usesEditor(config) && part !== 'editor' && bus.has('editor')) {
        await bus.request('editor', 'debug.resolve', { config, noDebug }, 60_000);
        return undefined;
      }
      const resolved = usesEditor(config) ? substituteEditor(config, editorValues() ?? {}) : config;
      await bus.request('terminal', 'debug.start', { config: resolved, noDebug }, 60_000);
      return undefined;
    },
  }));
  if (part === 'editor') {
    bus.on('debug.resolve', (message) => bus.request('terminal', 'debug.start', { config: substituteEditor(message.config, editorValues() ?? {}), noDebug: message.noDebug }, 60_000));
  }

  // Terminals and tasks: these commands of VS Code's run in the runtime instead (registered after VS Code's own, so
  // they are the ones a key, a menu or the command palette runs), with no panel here.
  const runThere = (command, as = command) => async (...args) => {
    if (!bus.has('terminal')) {
      void vscode.window.showInformationMessage("Open VS Code's terminal at OpenChamber's bottom to run this there.");
      return undefined;
    }
    while (args.length && (args[args.length - 1] === undefined || args[args.length - 1] === null)) args.pop();
    log.info(`[${part}] ${command} runs in the terminal's part`);
    return bus.request('terminal', 'run.command', { command: as, args: JSON.parse(JSON.stringify(args)) }, 60_000);
  };
  for (const [command, as] of [
    ['workbench.action.terminal.new'],
    ['workbench.action.terminal.newWithProfile'],
    ['workbench.action.terminal.split'],
    // The bottom shows the terminal: OpenChamber opens and closes its zone (the panel there is all it shows).
    ['workbench.action.terminal.toggleTerminal', 'workbench.action.terminal.focus'],
    ['workbench.action.terminal.focus'],
    ['workbench.action.tasks.build'],
    ['workbench.action.tasks.test'],
    ['workbench.action.tasks.reRunTask'],
    ['workbench.action.tasks.restartTask'],
    ['workbench.action.tasks.terminate'],
    ['workbench.action.tasks.showTasks'],
  ]) context.subscriptions.push(vscode.commands.registerCommand(command, runThere(command, as)));
  // Run Task: the task is picked here, where the user is, and runs there.
  context.subscriptions.push(vscode.commands.registerCommand('workbench.action.tasks.runTask', async (arg) => {
    if (arg !== undefined && arg !== null) return runThere('workbench.action.tasks.runTask')(arg);
    const tasks = await vscode.tasks.fetchTasks();
    const label = (task) => (task.source === 'Workspace' ? task.name : `${task.source}: ${task.name}`);
    const picked = await vscode.window.showQuickPick(tasks.map((task) => ({ label: label(task), detail: task.detail, task })), { placeHolder: 'Select the task to run' });
    if (picked) return runThere('workbench.action.tasks.runTask')(label(picked.task));
    return undefined;
  }));
};

exports.activate = async (context) => {
  const info = await vscode.commands.executeCommand('openchamber.vscode.bridge.info').then((value) => value, () => null);
  const part = info?.role;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!PARTS.includes(part) || !folder) {
    log.info(`not one of OpenChamber's parts (${part ?? 'no frame'}): nothing to do`);
    return;
  }
  const key = `${os.hostname()}|${folder.uri.toString()}`;
  const bus = new Bus(key, part);
  context.subscriptions.push(bus);
  await bus.start();
  // Not the workspace storage: VS Code gives each window open on the folder at once one of its own (`<id>-1`, ...).
  const store = path.join(context.globalStorageUri.fsPath, `${hashOf(key)}.breakpoints.json`);
  const breakpoints = syncBreakpoints(bus, store);
  context.subscriptions.push(breakpoints.disposable);
  // A window that went (closed, reloaded) leaves its extension host running a while on the server (VS Code's
  // reconnection grace): its part leaves the folder's parts while its window doesn't answer, and comes back with it.
  let beating = false;
  const heartbeat = setInterval(async () => {
    if (beating) return;
    beating = true;
    const alive = await Promise.race([
      vscode.commands.executeCommand('openchamber.vscode.bridge.info').then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    beating = false;
    if (!alive && !bus.away) bus.leave();
    else if (alive && bus.away) void bus.rejoin().catch((error) => log.error(String(error)));
  }, 2_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
  if (part === 'terminal') startRuntime(bus, context, folder, info.authority);
  else startFront(bus, context, folder, part);
  // Not awaited: a key that activated this runs as soon as the commands above are there.
  void breakpoints.join().then(() => log.info(`[${part}] breakpoints joined (${store})`), (error) => log.error(`breakpoints: ${error}`));
  log.info(`[${part}] ready for ${folder.uri.toString()}`);
};

exports.deactivate = () => undefined;
