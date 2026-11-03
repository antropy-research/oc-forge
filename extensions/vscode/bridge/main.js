var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// bridge/src/extension.ts
var exports_extension = {};
__export(exports_extension, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(exports_extension);
var crypto2 = __toESM(require("node:crypto"));
var os = __toESM(require("node:os"));
var path5 = __toESM(require("node:path"));
var vscode10 = __toESM(require("vscode"));

// bridge/src/breakpointSync.ts
var vscode = __toESM(require("vscode"));

// bridge/src/breakpoints.ts
var fs2 = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));

// bridge/src/lock.ts
var fs = __toESM(require("node:fs"));
var alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
var tryLock = (file, staleMs = 1e4) => {
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 384);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released)
          return;
        released = true;
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid))
            fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
    let stale = false;
    try {
      const holder = Number(fs.readFileSync(file, "utf8"));
      const age = Date.now() - fs.statSync(file).mtimeMs;
      stale = !Number.isInteger(holder) || holder <= 0 || !alive(holder) || age > staleMs;
    } catch {
      stale = true;
    }
    if (!stale)
      return null;
    try {
      fs.unlinkSync(file);
    } catch {}
  }
  return null;
};
var withLock = async (file, work, waitMs = 3000) => {
  const end = Date.now() + waitMs;
  let release = tryLock(file);
  while (!release && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
    release = tryLock(file);
  }
  try {
    return await work();
  } finally {
    release?.();
  }
};

// bridge/src/breakpoints.ts
var sourceKey = (uri, line, character) => `src|${uri}|${line}|${character}`;
var functionKey = (name) => `fn|${name}`;
var canonical = (data) => JSON.stringify({
  key: data.key,
  kind: data.kind,
  uri: data.uri,
  line: data.line,
  character: data.character,
  functionName: data.functionName,
  enabled: data.enabled,
  condition: data.condition || undefined,
  hitCondition: data.hitCondition || undefined,
  logMessage: data.logMessage || undefined
});
var sorted = (list) => [...list].sort((a, b) => a.key.localeCompare(b.key));
var isEmpty = (delta) => delta.put.length === 0 && delta.remove.length === 0;
var diff = (before, after) => {
  const old = new Map(before.map((item) => [item.key, canonical(item)]));
  const now = new Set(after.map((item) => item.key));
  return {
    put: after.filter((item) => old.get(item.key) !== canonical(item)),
    remove: [...old.keys()].filter((key) => !now.has(key))
  };
};
var applyDelta = (list, delta) => {
  const byKey = new Map(list.map((item) => [item.key, item]));
  for (const key of delta.remove)
    byKey.delete(key);
  for (const item of delta.put)
    byKey.set(item.key, item);
  return sorted([...byKey.values()]);
};
var union = (...lists) => {
  const byKey = new Map;
  for (const list of lists)
    for (const item of list)
      byKey.set(item.key, item);
  return sorted([...byKey.values()]);
};

class BreakpointStore {
  file;
  constructor(file) {
    this.file = file;
  }
  get lock() {
    return `${this.file}.lock`;
  }
  read() {
    try {
      const data = JSON.parse(fs2.readFileSync(this.file, "utf8"));
      return Array.isArray(data.list) ? sorted(data.list) : null;
    } catch {
      return null;
    }
  }
  write(list) {
    fs2.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    fs2.writeFileSync(temporary, JSON.stringify({ version: 1, at: Date.now(), list: sorted(list) }));
    fs2.renameSync(temporary, this.file);
  }
  update(delta) {
    fs2.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.lock, () => {
      const next = applyDelta(this.read() ?? [], delta);
      this.write(next);
      return next;
    });
  }
  init(first) {
    fs2.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.lock, async () => {
      const existing = this.read();
      if (existing)
        return { list: existing, created: false };
      const list = sorted(await first());
      this.write(list);
      return { list, created: true };
    }, 6000);
  }
}

// bridge/src/breakpointSync.ts
var dataOf = (bp) => {
  const common = {
    enabled: bp.enabled,
    condition: bp.condition || undefined,
    hitCondition: bp.hitCondition || undefined,
    logMessage: bp.logMessage || undefined
  };
  if (bp instanceof vscode.SourceBreakpoint) {
    const { uri, range } = bp.location;
    return { key: sourceKey(uri.toString(), range.start.line, range.start.character), kind: "source", uri: uri.toString(), line: range.start.line, character: range.start.character, ...common };
  }
  if (bp instanceof vscode.FunctionBreakpoint)
    return { key: functionKey(bp.functionName), kind: "function", functionName: bp.functionName, ...common };
  return null;
};
var breakpointOf = (data) => data.kind === "source" ? new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.parse(data.uri ?? ""), new vscode.Position(data.line ?? 0, data.character ?? 0)), data.enabled, data.condition, data.hitCondition, data.logMessage) : new vscode.FunctionBreakpoint(data.functionName ?? "", data.enabled, data.condition, data.hitCondition, data.logMessage);
var syncBreakpoints = (bus, store, log) => {
  const local = () => sorted(vscode.debug.breakpoints.map(dataOf).filter((data) => data !== null));
  let known = local();
  let applying = false;
  const apply = (list) => {
    const target = new Map(list.map((item) => [item.key, item]));
    const have = vscode.debug.breakpoints.map((bp) => ({ bp, data: dataOf(bp) })).filter((item) => item.data !== null);
    const delta = diff(have.map((item) => item.data), list);
    const changed = new Set(delta.put.map((item) => item.key));
    const remove = have.filter((item) => !target.has(item.data.key) || changed.has(item.data.key)).map((item) => item.bp);
    applying = true;
    try {
      if (remove.length)
        vscode.debug.removeBreakpoints(remove);
      if (delta.put.length)
        vscode.debug.addBreakpoints(delta.put.map(breakpointOf));
    } finally {
      applying = false;
    }
    known = local();
  };
  const disposable = vscode.debug.onDidChangeBreakpoints(() => {
    if (applying)
      return;
    const now = local();
    const delta = diff(known, now);
    if (isEmpty(delta))
      return;
    known = now;
    bus.send({ type: "bp.delta", delta });
    store.update(delta).catch((error) => log(`could not keep the folder's breakpoints: ${error}`));
  });
  bus.on("bp.delta", (message) => apply(applyDelta(local(), message.delta)));
  bus.on("bp.ask", () => local());
  return {
    dispose: () => disposable.dispose(),
    join: async () => {
      const { list, created } = await store.init(async () => union(...await bus.gather("bp.ask"), local()));
      apply(list);
      if (created)
        bus.send({ type: "bp.delta", delta: { put: list, remove: [] } });
    }
  };
};

// bridge/src/bus.ts
var crypto = __toESM(require("node:crypto"));
var fs3 = __toESM(require("node:fs"));
var net = __toESM(require("node:net"));
var path2 = __toESM(require("node:path"));

// bridge/src/events.ts
class Emitter {
  listeners = new Set;
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {}
    }
  }
  dispose() {
    this.listeners.clear();
  }
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var waitForAsync = async (probe, timeoutMs, every = 50) => {
  const end = Date.now() + timeoutMs;
  for (;; ) {
    if (await probe())
      return true;
    if (Date.now() >= end)
      return false;
    await sleep(every);
  }
};
var waitFor = async (probe, timeoutMs, every = 50) => {
  const end = Date.now() + timeoutMs;
  for (;; ) {
    if (probe())
      return true;
    if (Date.now() >= end)
      return false;
    await sleep(every);
  }
};

// bridge/src/bus.ts
var BUS_MEMBER = { part: "bus", member: "bus" };
var busFiles = (dir, key) => {
  const name = crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
  return { socket: path2.join(dir, `${name}.sock`), lock: path2.join(dir, `${name}.lock`) };
};
var sweepStale = async (dir, keep, olderThanMs = 5 * 60000) => {
  let removed = 0;
  let names;
  try {
    names = fs3.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path2.join(dir, name);
    if (!name.endsWith(".sock") || file === keep)
      continue;
    try {
      if (Date.now() - fs3.statSync(file).mtimeMs < olderThanMs)
        continue;
    } catch {
      continue;
    }
    const answers = await new Promise((resolve) => {
      const socket = net.connect(file);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (answers)
      continue;
    for (const target of [file, file.replace(/\.sock$/, ".lock")]) {
      try {
        fs3.unlinkSync(target);
      } catch {}
    }
    removed++;
  }
  return removed;
};

class Bus {
  options;
  me;
  members = new Map;
  away = false;
  handlers = new Map;
  waiting = new Map;
  clients = new Set;
  server = null;
  socket = null;
  disposed = false;
  starting = null;
  membersChanged = new Emitter;
  onMembers = this.membersChanged.event;
  files;
  constructor(options) {
    this.options = options;
    this.me = { part: options.part, member: crypto.randomUUID() };
    this.members.set(this.me.member, this.me.part);
    fs3.mkdirSync(options.dir, { recursive: true, mode: 448 });
    this.files = busFiles(options.dir, options.key);
  }
  get leading() {
    return this.server !== null;
  }
  get connected() {
    return this.server !== null || this.socket !== null;
  }
  log(line) {
    this.options.log?.(`[${this.me.part}] ${line}`);
  }
  start() {
    this.starting ??= this.join().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  sweep(olderThanMs) {
    return sweepStale(this.options.dir, this.files.socket, olderThanMs);
  }
  async join() {
    for (let attempt = 0;attempt < 100 && !this.disposed && !this.away; attempt++) {
      if (await this.connect())
        return;
      const release = tryLock(this.files.lock);
      if (release) {
        try {
          if (await this.connect())
            return;
          try {
            fs3.unlinkSync(this.files.socket);
          } catch {}
          if (await this.listen())
            return;
        } finally {
          release();
        }
      }
      await sleep(20 + Math.random() * 80);
    }
    if (!this.disposed && !this.away)
      throw new Error(`could not join the parts at ${this.files.socket}`);
  }
  listen() {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once("error", () => resolve(false));
      server.listen(this.files.socket, () => {
        try {
          fs3.chmodSync(this.files.socket, 384);
        } catch {}
        this.server = server;
        this.members = new Map([[this.me.member, this.me.part]]);
        this.log("listens");
        this.announce();
        resolve(true);
      });
    });
  }
  connect() {
    return new Promise((resolve) => {
      if (!fs3.existsSync(this.files.socket)) {
        resolve(false);
        return;
      }
      const socket = net.connect(this.files.socket);
      socket.once("error", () => resolve(false));
      socket.once("connect", () => {
        this.socket = socket;
        this.read(socket, (message) => this.deliver(message));
        socket.on("error", () => {
          return;
        });
        socket.on("close", () => {
          if (this.socket === socket)
            this.socket = null;
          if (!this.disposed && !this.away)
            this.start().catch((error) => this.log(String(error)));
        });
        this.write(socket, { type: "hello", from: this.me });
        this.log("joined");
        resolve(true);
      });
    });
  }
  accept(socket) {
    this.clients.add(socket);
    this.read(socket, (message) => {
      if (message.type === "hello" && message.from) {
        socket.member = message.from.member;
        this.members.set(message.from.member, message.from.part);
        this.announce();
        return;
      }
      this.relay(message, socket);
    });
    socket.on("close", () => {
      this.clients.delete(socket);
      if (socket.member)
        this.members.delete(socket.member);
      this.announce();
    });
    socket.on("error", () => {
      return;
    });
  }
  announce() {
    this.relay({ type: "members", from: this.me, list: [...this.members].map(([member, part]) => ({ member, part })) }, null);
  }
  read(socket, onMessage) {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf(`
`);end >= 0; end = buffer.indexOf(`
`)) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line)
          continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.log(`bad message: ${error}`);
          continue;
        }
        onMessage(message);
      }
    });
  }
  write(socket, message) {
    if (!socket.destroyed)
      socket.write(`${JSON.stringify(message)}
`);
  }
  relay(message, origin) {
    if (message.reqId && message.type !== "reply" && message.to && this.options.parts.includes(message.to)) {
      const member = [...this.members].find(([, part]) => part === message.to)?.[0];
      if (!member) {
        const reply = { type: "reply", from: BUS_MEMBER, to: message.from?.member, reqId: message.reqId, ok: false, error: `no ${message.to} part` };
        if (origin)
          this.write(origin, reply);
        else
          this.deliver(reply);
        return;
      }
      message = { ...message, to: member };
    }
    for (const client of this.clients)
      if (client !== origin)
        this.write(client, message);
    if (origin !== null || message.type === "members" || message.to === this.me.member && message.from?.member !== this.me.member)
      this.deliver(message);
  }
  deliver(message) {
    if (message.type === "members") {
      const list = message.list ?? [];
      this.members = new Map(list.map((item) => [item.member, item.part]));
      this.membersChanged.fire([...this.members.values()]);
      return;
    }
    if (message.from?.member === this.me.member)
      return;
    if (message.to && message.to !== this.me.part && message.to !== this.me.member)
      return;
    if (message.type === "reply") {
      const waiter = message.reqId ? this.waiting.get(message.reqId) : undefined;
      if (waiter && message.reqId) {
        this.waiting.delete(message.reqId);
        if (message.ok)
          waiter.resolve(message.value);
        else
          waiter.reject(new Error(String(message.error ?? "failed")));
      }
      return;
    }
    const handler = this.handlers.get(message.type);
    if (!handler)
      return;
    Promise.resolve().then(() => handler(message)).then((value) => {
      if (message.reqId)
        this.send({ type: "reply", to: message.from?.member, reqId: message.reqId, ok: true, value: value ?? null });
    }, (error) => {
      const text = error instanceof Error ? error.message : String(error);
      this.log(`${message.type}: ${text}`);
      if (message.reqId)
        this.send({ type: "reply", to: message.from?.member, reqId: message.reqId, ok: false, error: text });
    });
  }
  send(message) {
    const full = { ...message, from: this.me };
    if (this.server)
      this.relay(full, null);
    else if (this.socket)
      this.write(this.socket, full);
  }
  request(to, type, payload = {}, timeoutMs = 15000) {
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error(`${type}: no answer from the ${to ?? "other"} part`));
      }, timeoutMs);
      this.waiting.set(reqId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.send({ ...payload, type, to, reqId });
    });
  }
  async gather(type, payload = {}, ms = 1500) {
    const others = [...this.members.keys()].filter((member) => member !== this.me.member);
    const answers = await Promise.all(others.map((member) => this.request(member, type, payload, ms).then((value) => ({ value }), () => null)));
    return answers.filter((answer) => answer !== null && answer.value !== null && answer.value !== undefined).map((answer) => answer.value);
  }
  on(type, handler) {
    this.handlers.set(type, handler);
  }
  has(part) {
    return [...this.members.values()].includes(part);
  }
  memberOf(part) {
    return [...this.members].find(([, value]) => value === part)?.[0];
  }
  leave() {
    if (this.away)
      return;
    this.away = true;
    this.socket?.destroy();
    this.socket = null;
    for (const client of this.clients)
      client.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.members = new Map([[this.me.member, this.me.part]]);
    this.log("its window doesn't answer: it leaves");
  }
  async rejoin() {
    if (!this.away)
      return;
    this.away = false;
    this.log("its window answers again: it rejoins");
    await this.start();
  }
  dispose() {
    this.disposed = true;
    this.socket?.destroy();
    for (const client of this.clients)
      client.destroy();
    this.server?.close();
    this.membersChanged.dispose();
    for (const waiter of this.waiting.values())
      waiter.reject(new Error("the bus closed"));
    this.waiting.clear();
  }
}

// bridge/src/front.ts
var vscode2 = __toESM(require("vscode"));

// bridge/src/mirror.ts
var placeKey = (line, column) => `${line}:${column ?? ""}`;

class Mirror {
  link;
  realId;
  statesOf;
  seq = 1;
  ended = false;
  configured = false;
  nextBreakpointId = 1;
  told = new Map;
  emitter = new Emitter;
  onDidSendMessage = this.emitter.event;
  constructor(link, realId, statesOf = () => {
    return;
  }) {
    this.link = link;
    this.realId = realId;
    this.statesOf = statesOf;
  }
  emit(message) {
    this.emitter.fire({ ...message, seq: this.seq++ });
  }
  respond(request, body, error) {
    this.emit(error ? { type: "response", request_seq: request.seq, command: request.command, success: false, message: error, body: { error: { id: 1, format: error, showUser: false } } } : { type: "response", request_seq: request.seq, command: request.command, success: true, body: body ?? {} });
  }
  event(event, body) {
    if (this.ended)
      return;
    if (event === "terminated")
      this.ended = true;
    this.emit({ type: "event", event, body });
  }
  breakpointStates(path, states) {
    const set = this.told.get(path);
    if (!set)
      return;
    for (const told of set.values()) {
      const state = states.find((item) => item.line === told.line && (item.column === undefined || told.column === undefined || item.column === told.column));
      if (!state)
        continue;
      const next = shown(told, state);
      if (next.verified === told.verified && next.shownLine === told.shownLine && next.shownColumn === told.shownColumn && next.message === told.message)
        continue;
      Object.assign(told, next);
      this.event("breakpoint", { reason: "changed", breakpoint: wire(told) });
    }
  }
  async handleMessage(message) {
    if (message.type !== "request")
      return;
    const args = message.arguments ?? {};
    try {
      switch (message.command) {
        case "initialize": {
          const caps = await this.link.request("dap.caps", { realId: this.realId });
          if (!caps)
            throw new Error("that debug session ended");
          this.respond(message, { ...caps, supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsRestartRequest: true });
          this.event("initialized");
          return;
        }
        case "launch":
        case "attach":
          this.respond(message, {});
          return;
        case "setBreakpoints":
          this.respond(message, { breakpoints: this.setBreakpoints(args) });
          return;
        case "setFunctionBreakpoints":
          this.respond(message, { breakpoints: (args.breakpoints ?? []).map(() => ({ verified: true })) });
          return;
        case "setDataBreakpoints":
        case "setInstructionBreakpoints":
          this.respond(message, { breakpoints: [] });
          return;
        case "setExceptionBreakpoints":
          if (!this.configured) {
            this.respond(message, {});
            return;
          }
          this.respond(message, await this.relay(message.command, args));
          return;
        case "configurationDone": {
          this.configured = true;
          this.respond(message, {});
          const state = await this.link.request("dap.state", { realId: this.realId }).catch(() => ({ stopped: [] }));
          for (const body of state.stopped)
            this.event("stopped", body);
          return;
        }
        case "restart":
          await this.link.request("session.restart", { realId: this.realId }, 60000);
          this.respond(message, {});
          return;
        case "terminate":
          if (!this.ended)
            this.link.send("session.stop", { realId: this.realId });
          this.respond(message, {});
          return;
        case "disconnect": {
          const closing = args.terminateDebuggee === undefined && args.restart === undefined && args.suspendDebuggee === undefined;
          if (!this.ended && !closing)
            this.link.send("session.stop", { realId: this.realId });
          this.ended = true;
          this.respond(message, {});
          return;
        }
        default:
          this.respond(message, await this.relay(message.command ?? "", args));
      }
    } catch (error) {
      this.respond(message, undefined, error instanceof Error ? error.message : String(error));
    }
  }
  relay(command, args) {
    return this.link.request("dap.request", { realId: this.realId, command, args });
  }
  setBreakpoints(args) {
    const source = args.source;
    const file = typeof source?.path === "string" ? source.path : "";
    const asked = args.breakpoints ?? args.lines?.map((line) => ({ line })) ?? [];
    const old = this.told.get(file) ?? new Map;
    const next = new Map;
    const states = this.statesOf(file) ?? [];
    for (const bp of asked) {
      const key = placeKey(bp.line, bp.column);
      const told = old.get(key) ?? { id: this.nextBreakpointId++, line: bp.line, column: bp.column, verified: false, shownLine: bp.line, shownColumn: bp.column };
      const state = states.find((item) => item.line === bp.line && (item.column === undefined || bp.column === undefined || item.column === bp.column));
      Object.assign(told, state ? shown(told, state) : { verified: told.verified, shownLine: told.shownLine });
      next.set(key, told);
    }
    this.told.set(file, next);
    return [...next.values()].map(wire);
  }
  dispose() {
    this.emitter.dispose();
  }
}
var shown = (told, state) => ({
  verified: state.verified,
  shownLine: state.actualLine ?? told.line,
  shownColumn: state.actualColumn ?? told.column,
  message: state.message
});
var wire = (told) => ({
  id: told.id,
  verified: told.verified,
  line: told.shownLine,
  ...told.shownColumn !== undefined ? { column: told.shownColumn } : {},
  ...told.message !== undefined ? { message: told.message } : {}
});

// bridge/src/protocol.ts
var FRAME = {
  info: "openchamber.vscode.bridge.info",
  hello: "openchamber.vscode.bridge.hello",
  allowFocus: "openchamber.vscode.bridge.allowFocus",
  focusFrame: "openchamber.vscode.bridge.focusFrame",
  debuggerKnown: "openchamber.vscode.bridge.debuggerKnown",
  filesChange: "openchamber.vscode.bridge.filesChange",
  undo: "openchamber.vscode.bridge.undo",
  openBottom: "openchamber.vscode.bridge.openBottom",
  attachTerminal: "openchamber.vscode.bridge.attachTerminal",
  showTerminal: "openchamber.vscode.bridge.showTerminal"
};
var BRIDGE = {
  runTask: "openchamber.bridge.runTask",
  startDebugging: "openchamber.bridge.startDebugging",
  moveTerminal: "openchamber.bridge.moveTerminal",
  showTerminal: "openchamber.bridge.showTerminal",
  undo: "openchamber.bridge.undo"
};

// bridge/src/variables.ts
var NAME = /\$\{([A-Za-z][\w]*(?::[^}]+)?)\}/g;
var variablesIn = (value, into = new Set) => {
  if (typeof value === "string") {
    for (const match of value.matchAll(NAME))
      into.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value)
      variablesIn(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value))
      variablesIn(item, into);
  }
  return into;
};
var replaceVariables = (value, values) => {
  if (typeof value === "string")
    return value.replace(NAME, (all, name) => values.get(name) ?? all);
  if (Array.isArray(value))
    return value.map((item) => replaceVariables(item, values));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceVariables(item, values)]));
  return value;
};
var EDITOR_VARIABLES = new Set([
  "file",
  "fileBasename",
  "fileBasenameNoExtension",
  "fileDirname",
  "fileExtname",
  "relativeFile",
  "relativeFileDirname",
  "lineNumber",
  "columnNumber",
  "selectedText",
  "fileWorkspaceFolder",
  "fileWorkspaceFolderBasename",
  "fileDirnameBasename"
]);
var needsFront = (names) => {
  let editor = false;
  let ask = false;
  for (const name of names) {
    if (EDITOR_VARIABLES.has(name))
      editor = true;
    if (name.startsWith("input:") || name.startsWith("command:"))
      ask = true;
  }
  return { editor, ask };
};
var dirname2 = (file) => file.lastIndexOf("/") > 0 ? file.slice(0, file.lastIndexOf("/")) : "/";
var basename = (file) => file.slice(file.lastIndexOf("/") + 1);
var extname = (file) => {
  const base = basename(file);
  return base.lastIndexOf(".") > 0 ? base.slice(base.lastIndexOf(".")) : "";
};
var editorValues = (editor) => {
  const relative = editor.folder && editor.file.startsWith(`${editor.folder}/`) ? editor.file.slice(editor.folder.length + 1) : editor.file;
  const values = new Map([
    ["file", editor.file],
    ["fileBasename", basename(editor.file)],
    ["fileBasenameNoExtension", basename(editor.file).slice(0, basename(editor.file).length - extname(editor.file).length)],
    ["fileDirname", dirname2(editor.file)],
    ["fileExtname", extname(editor.file)],
    ["relativeFile", relative],
    ["relativeFileDirname", relative.includes("/") ? dirname2(relative) : "."],
    ["lineNumber", String(editor.line)],
    ["columnNumber", String(editor.column)],
    ["selectedText", editor.selectedText],
    ["fileDirnameBasename", basename(dirname2(editor.file))]
  ]);
  if (editor.folder) {
    values.set("fileWorkspaceFolder", editor.folder);
    values.set("fileWorkspaceFolderBasename", basename(editor.folder));
  }
  return values;
};
var askVariables = async (names, inputs, asker, config, commandAliases = {}) => {
  const values = new Map;
  for (const name of names) {
    if (values.has(name))
      continue;
    if (name.startsWith("input:")) {
      const input = inputs.find((item) => item.id === name.slice("input:".length));
      if (!input)
        throw new Error(`Undefined input variable '${name.slice("input:".length)}'`);
      const answer = input.type === "pickString" ? await asker.pick(input) : input.type === "command" ? await Promise.resolve(asker.command(input.command ?? "", input.args)).then((value) => value === undefined || value === null ? undefined : String(value)) : await asker.prompt(input);
      if (answer === undefined)
        return null;
      values.set(name, answer);
    } else if (name.startsWith("command:")) {
      const id = name.slice("command:".length);
      const answer = await asker.command(commandAliases[id] ?? id, config);
      if (answer === undefined || answer === null)
        return null;
      values.set(name, String(answer));
    }
  }
  return values;
};

// bridge/src/front.ts
var MIRROR = "openchamber-mirror";
var startFront = (bus, context, folder, part, log) => {
  const mirrors = new Map;
  const live = new Set;
  const entryOf = (realId) => {
    let entry = mirrors.get(realId);
    if (!entry) {
      let markStarted = () => {
        return;
      };
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      entry = { owner: null, adapter: null, session: null, starting: false, started, markStarted, states: new Map };
      mirrors.set(realId, entry);
    }
    return entry;
  };
  const linkTo = (owner) => ({
    request: (type, payload, timeoutMs) => bus.request(owner, type, payload, timeoutMs),
    send: (type, payload) => bus.send({ ...payload, type, to: owner })
  });
  let noticed = 0;
  const ensureRuntime = async (what, reveal = true) => {
    const opening = reveal || !bus.has("terminal") ? vscode2.commands.executeCommand(FRAME.openBottom).then((value) => value === true, () => false) : Promise.resolve(false);
    if (bus.has("terminal"))
      return true;
    if (await opening && await waitFor(() => bus.has("terminal"), 45000))
      return true;
    if (Date.now() - noticed > 1e4) {
      noticed = Date.now();
      vscode2.window.showInformationMessage(`${what} runs in this part of VS Code: open VS Code's terminal at OpenChamber's bottom (its icon on the rail) to run it there, with the rest.`);
    }
    return false;
  };
  context.subscriptions.push(vscode2.debug.registerDebugAdapterDescriptorFactory(MIRROR, {
    createDebugAdapterDescriptor: (session) => {
      const { realId, owner } = session.configuration.__openchamber ?? {};
      if (!realId || !owner)
        return;
      const entry = entryOf(realId);
      const adapter = new Mirror(linkTo(owner), realId, (file) => entry.states.get(file));
      entry.adapter = adapter;
      return new vscode2.DebugAdapterInlineImplementation(adapter);
    }
  }));
  context.subscriptions.push(vscode2.debug.onDidStartDebugSession((session) => {
    const realId = session.configuration.__openchamber?.realId;
    if (!realId)
      return;
    const entry = entryOf(realId);
    entry.session = session;
    entry.markStarted(session);
  }));
  bus.on("session.started", async (message) => {
    const realId = String(message.realId);
    live.add(realId);
    const entry = entryOf(realId);
    if (entry.starting || entry.session)
      return;
    entry.starting = true;
    entry.owner = message.from?.member ?? null;
    const states = await bus.request(entry.owner ?? undefined, "dap.bpstates", { realId }, 5000).catch(() => ({}));
    for (const [file, list] of Object.entries(states))
      if (!entry.states.has(file))
        entry.states.set(file, list);
    const parentId = typeof message.parentId === "string" ? message.parentId : undefined;
    const parent = parentId && live.has(parentId) ? await Promise.race([entryOf(parentId).started, new Promise((resolve) => setTimeout(() => resolve(undefined), 1e4))]) : undefined;
    const known = await waitForAsync(() => vscode2.commands.executeCommand(FRAME.debuggerKnown, MIRROR).then((value) => value !== false, () => true), 20000, 200);
    if (!known) {
      entry.starting = false;
      log(`no mirror of ${String(message.name)}: VS Code here doesn't know the ${MIRROR} debugger yet`);
      return;
    }
    const ok = await vscode2.debug.startDebugging(undefined, {
      type: MIRROR,
      request: message.request === "attach" ? "attach" : "launch",
      name: String(message.name),
      noDebug: Boolean(message.noDebug),
      internalConsoleOptions: "neverOpen",
      __openchamber: { realId, owner: entry.owner }
    }, {
      parentSession: parent,
      lifecycleManagedByParent: Boolean(parent),
      compact: Boolean(parent),
      consoleMode: parent ? vscode2.DebugConsoleMode.MergeWithParent : vscode2.DebugConsoleMode.Separate,
      noDebug: Boolean(message.noDebug),
      suppressDebugView: part === "editor",
      suppressDebugToolbar: part !== "editor",
      suppressDebugStatusbar: part !== "editor",
      suppressSaveBeforeStart: true
    });
    if (!ok)
      entry.starting = false;
    log(`mirror of ${String(message.name)}: ${ok}`);
  });
  bus.on("dap.event", (message) => {
    mirrors.get(String(message.realId))?.adapter?.event(String(message.event), message.body);
  });
  bus.on("bp.state", (message) => {
    const entry = mirrors.get(String(message.realId));
    if (!entry)
      return;
    for (const [file, list] of Object.entries(message.sources ?? {})) {
      entry.states.set(file, list);
      entry.adapter?.breakpointStates(file, list);
    }
  });
  const end = (realId) => {
    live.delete(realId);
    const entry = mirrors.get(realId);
    mirrors.delete(realId);
    entry?.adapter?.event("terminated");
  };
  bus.on("session.ended", (message) => end(String(message.realId)));
  context.subscriptions.push(vscode2.debug.onDidChangeActiveStackItem((item) => {
    if (!(item instanceof vscode2.DebugStackFrame))
      return;
    const realId = item.session.configuration.__openchamber?.realId;
    const owner = realId ? mirrors.get(realId)?.owner : undefined;
    if (realId && owner)
      bus.send({ type: "debug.focus", to: owner, realId, threadId: item.threadId, frameId: item.frameId });
  }));
  context.subscriptions.push({ dispose: bus.onMembers(() => setTimeout(() => {
    for (const [realId, entry] of mirrors)
      if (entry.owner && !bus.members.has(entry.owner))
        end(realId);
  }, 5000)).dispose });
  const resolveHere = async (config) => {
    const names = variablesIn(config);
    const { editor, ask } = needsFront(names);
    let resolved = config;
    if (editor) {
      const active = vscode2.window.activeTextEditor;
      if (active) {
        const file = active.document.uri.path;
        const workspace2 = vscode2.workspace.getWorkspaceFolder(active.document.uri)?.uri.path;
        resolved = replaceVariables(resolved, editorValues({ file, folder: workspace2, line: active.selection.active.line + 1, column: active.selection.active.character + 1, selectedText: active.document.getText(active.selection) }));
      }
    }
    if (ask) {
      const inputs = vscode2.workspace.getConfiguration("launch", folder.uri).get("inputs") ?? [];
      const aliases = {};
      for (const extension of vscode2.extensions.all) {
        for (const debuggerInfo of extension.packageJSON?.contributes?.debuggers ?? []) {
          if (debuggerInfo.type === config.type && debuggerInfo.variables)
            Object.assign(aliases, debuggerInfo.variables);
        }
      }
      const values = await askVariables(names, inputs, {
        prompt: (input) => vscode2.window.showInputBox({ prompt: input.description, value: input.default, password: input.password }),
        pick: async (input) => {
          const items = (input.options ?? []).map((option) => typeof option === "string" ? { label: option, value: option } : { label: option.label ?? option.value, value: option.value });
          return (await vscode2.window.showQuickPick(items, { placeHolder: input.description }))?.value;
        },
        command: (id, args) => vscode2.commands.executeCommand(id, args)
      }, config, aliases);
      if (!values)
        return null;
      resolved = replaceVariables(resolved, values);
    }
    return resolved;
  };
  context.subscriptions.push(vscode2.debug.registerDebugConfigurationProvider("*", {
    resolveDebugConfiguration: async (_folder, config) => {
      if (config.type === MIRROR)
        return live.has(config.__openchamber?.realId ?? "") ? config : undefined;
      if (!config.type && !config.request && !config.name)
        return config;
      if (part === "view" && needsFront(variablesIn(config)).editor && bus.has("editor")) {
        await bus.request("editor", "debug.resolve", { config, noDebug: Boolean(config.noDebug) }, 120000);
        return;
      }
      if (!await ensureRuntime("Debugging"))
        return config;
      const resolved = await resolveHere(config);
      if (!resolved)
        return;
      await bus.request("terminal", "debug.start", { config: resolved, noDebug: Boolean(config.noDebug) }, 120000);
      return;
    }
  }));
  if (part === "editor") {
    bus.on("debug.resolve", async (message) => {
      const resolved = await resolveHere(message.config);
      if (!resolved || !await ensureRuntime("Debugging"))
        return false;
      return bus.request("terminal", "debug.start", { config: resolved, noDebug: Boolean(message.noDebug) }, 120000);
    });
  }
  const runThere = (command, as = command, what = "This") => async (...args) => {
    while (args.length && (args[args.length - 1] === undefined || args[args.length - 1] === null))
      args.pop();
    if (!await ensureRuntime(what)) {
      return;
    }
    log(`${command} runs in the runtime`);
    return bus.request("terminal", "run.command", { command: as, args: JSON.parse(JSON.stringify(args)) }, 60000);
  };
  const routed = [
    ["workbench.action.terminal.new", undefined, "A new terminal"],
    ["workbench.action.terminal.newWithProfile", undefined, "A new terminal"],
    ["workbench.action.terminal.newWithCwd", undefined, "A new terminal"],
    ["workbench.action.terminal.newLocal", "workbench.action.terminal.new", "A new terminal"],
    ["workbench.action.terminal.newInActiveWorkspace", "workbench.action.terminal.new", "A new terminal"],
    ["workbench.action.terminal.split", undefined, "A new terminal"],
    ["workbench.action.terminal.splitActiveTab", "workbench.action.terminal.split", "A new terminal"],
    ["workbench.action.terminal.splitInActiveWorkspace", "workbench.action.terminal.split", "A new terminal"],
    ["workbench.action.createTerminalEditor", "workbench.action.terminal.new", "A new terminal"],
    ["workbench.action.createTerminalEditorSameGroup", "workbench.action.terminal.new", "A new terminal"],
    ["workbench.action.createTerminalEditorSide", "workbench.action.terminal.new", "A new terminal"],
    ["openInIntegratedTerminal", undefined, "A new terminal"],
    ["openInTerminal", "openInIntegratedTerminal", "A new terminal"],
    ["workbench.action.togglePanel", "workbench.action.focusPanel", "The panel"],
    ["workbench.action.focusPanel", undefined, "The panel"],
    ["workbench.actions.view.problems", "workbench.panel.markers.view.focus", "Problems"],
    ["workbench.action.output.toggleOutput", "workbench.panel.output.focus", "Output"],
    ["workbench.debug.action.toggleRepl", "workbench.panel.repl.view.focus", "The Debug Console"],
    ["workbench.action.terminal.toggleTerminal", "workbench.action.terminal.focus", "The terminal"],
    ["workbench.action.terminal.focus", undefined, "The terminal"],
    ["workbench.action.tasks.reRunTask", undefined, "The task"],
    ["workbench.action.tasks.restartTask", undefined, "The task"],
    ["workbench.action.tasks.terminate", undefined, "The task"],
    ["workbench.action.tasks.showTasks", undefined, "The task"],
    ["workbench.action.tasks.showLog", undefined, "The task"]
  ];
  for (const [command, as, what] of routed)
    context.subscriptions.push(vscode2.commands.registerCommand(command, runThere(command, as, what)));
  const sendThere = async (text) => {
    if (text === undefined || !await ensureRuntime("The terminal"))
      return;
    await bus.request("terminal", "terminal.send", { text }, 30000);
  };
  context.subscriptions.push(vscode2.commands.registerCommand("workbench.action.terminal.runSelectedText", async () => {
    const editor = vscode2.window.activeTextEditor;
    if (!editor)
      return;
    const text = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).text : editor.document.getText(editor.selection);
    await sendThere(text);
  }));
  context.subscriptions.push(vscode2.commands.registerCommand("workbench.action.terminal.runActiveFile", async () => {
    const editor = vscode2.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file")
      return;
    if (editor.document.isDirty)
      await editor.document.save();
    await sendThere(editor.document.uri.fsPath.includes(" ") ? `"${editor.document.uri.fsPath}"` : editor.document.uri.fsPath);
  }));
  context.subscriptions.push(vscode2.commands.registerCommand(BRIDGE.runTask, async (task) => {
    if (!await ensureRuntime(`The task "${task.label}"`))
      return { routed: false };
    await bus.request("terminal", "task.run", { task }, 60000);
    return { routed: true, ok: true };
  }));
  context.subscriptions.push(vscode2.commands.registerCommand(BRIDGE.startDebugging, async (name, noDebug) => {
    if (!await ensureRuntime("Debugging"))
      return { routed: false };
    return { routed: true, ok: await bus.request("terminal", "debug.start", { name, noDebug: Boolean(noDebug) }, 120000) };
  }));
  context.subscriptions.push(vscode2.commands.registerCommand(BRIDGE.moveTerminal, async (terminal) => {
    if (!await ensureRuntime(`The terminal "${terminal.title}"`, false))
      return { routed: false };
    await bus.request("terminal", "terminal.attach", { terminal }, 30000);
    return { routed: true, ok: true };
  }));
  context.subscriptions.push(vscode2.commands.registerCommand(BRIDGE.showTerminal, async (process2, focus) => {
    if (!await ensureRuntime("The terminal", false))
      return { routed: false };
    return { routed: true, ok: Boolean(await bus.request("terminal", "terminal.show", { process: process2, focus: Boolean(focus) }, 30000)) };
  }));
  return { ensureRuntime };
};

// bridge/src/heartbeat.ts
class Heartbeat {
  options;
  away = false;
  asked = null;
  wait;
  timer = null;
  stopped = false;
  pings = 0;
  constructor(options) {
    this.options = options;
    this.wait = options.everyMs ?? 2000;
  }
  get now() {
    return (this.options.now ?? Date.now)();
  }
  start() {
    this.schedule(this.options.everyMs ?? 2000);
  }
  schedule(ms) {
    if (this.stopped)
      return;
    const set = this.options.setTimer ?? ((fn, delay) => setTimeout(fn, delay));
    this.timer = set(() => this.tick(), ms);
  }
  tick() {
    if (this.stopped)
      return;
    const every = this.options.everyMs ?? 2000;
    if (this.asked !== null) {
      const waited = this.now - this.asked;
      if (!this.away && waited > (this.options.timeoutMs ?? 3000)) {
        this.away = true;
        this.options.onAway();
      }
      if (waited > (this.options.giveUpMs ?? 300000))
        this.asked = null;
      if (this.away)
        this.wait = Math.min(this.wait * 2, this.options.maxAwayMs ?? 60000);
      this.schedule(this.away ? this.wait : every);
      return;
    }
    const asked = this.now;
    this.asked = asked;
    this.pings++;
    const answered = () => {
      if (this.asked !== asked)
        return;
      this.asked = null;
      if (this.away) {
        this.away = false;
        this.wait = every;
        this.options.onBack();
      }
    };
    Promise.resolve(this.options.ping()).then(answered, answered);
    this.schedule(this.away ? this.wait : every);
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null)
      (this.options.clearTimer ?? ((timer) => clearTimeout(timer)))(this.timer);
  }
}

// bridge/src/problems.ts
var vscode3 = __toESM(require("vscode"));

// bridge/src/wire.ts
var diagnosticKey = (diagnostic) => JSON.stringify([
  diagnostic.range,
  diagnostic.message,
  diagnostic.severity,
  diagnostic.source ?? null,
  diagnostic.code ?? null,
  diagnostic.tags ?? [],
  diagnostic.related ?? []
]);
var subtractDiagnostics = (all, mine) => {
  const left = new Map;
  for (const diagnostic of mine)
    left.set(diagnosticKey(diagnostic), (left.get(diagnosticKey(diagnostic)) ?? 0) + 1);
  return all.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const count = left.get(key) ?? 0;
    if (count === 0)
      return true;
    left.set(key, count - 1);
    return false;
  });
};
var gitFingerprint = (state) => JSON.stringify([
  state.HEAD?.name ?? null,
  state.HEAD?.commit ?? null,
  ...[state.indexChanges, state.workingTreeChanges, state.mergeChanges, state.untrackedChanges ?? []].map((changes) => changes.map((change) => `${change.status} ${change.uri.toString()}`).sort())
]);
var contains = (outer, line, character) => (line > outer[0] || line === outer[0] && character >= outer[1]) && (line < outer[2] || line === outer[2] && character <= outer[3]);
var symbolPath = (symbols, line, character) => {
  for (const symbol of symbols) {
    if (!contains(symbol.range, line, character))
      continue;
    return [symbol, ...symbolPath(symbol.children, line, character)];
  }
  return [];
};
var SYMBOL_ICONS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum-member",
  "struct",
  "event",
  "operator",
  "type-parameter"
];

// bridge/src/problems.ts
var toWire = (diagnostic) => ({
  range: [diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.range.end.line, diagnostic.range.end.character],
  message: diagnostic.message,
  severity: diagnostic.severity,
  source: diagnostic.source,
  code: typeof diagnostic.code === "object" && diagnostic.code !== null ? { value: diagnostic.code.value, target: diagnostic.code.target.toString() } : diagnostic.code,
  tags: diagnostic.tags,
  related: diagnostic.relatedInformation?.map((item) => ({ uri: item.location.uri.toString(), range: [item.location.range.start.line, item.location.range.start.character, item.location.range.end.line, item.location.range.end.character], message: item.message }))
});
var range = ([sl, sc, el, ec]) => new vscode3.Range(sl, sc, el, ec);
var fromWire = (wire) => {
  const diagnostic = new vscode3.Diagnostic(range(wire.range), wire.message, wire.severity);
  if (wire.source !== undefined)
    diagnostic.source = wire.source;
  if (wire.code !== undefined)
    diagnostic.code = typeof wire.code === "object" ? { value: wire.code.value, target: vscode3.Uri.parse(wire.code.target) } : wire.code;
  if (wire.tags)
    diagnostic.tags = wire.tags;
  if (wire.related)
    diagnostic.relatedInformation = wire.related.map((item) => new vscode3.DiagnosticRelatedInformation(new vscode3.Location(vscode3.Uri.parse(item.uri), range(item.range)), item.message));
  return diagnostic;
};
var startProblems = (bus, context, log) => {
  const mirrored = vscode3.languages.createDiagnosticCollection("openchamber");
  context.subscriptions.push(mirrored);
  const others = new Map;
  const published = new Map;
  const own = (uri) => subtractDiagnostics(vscode3.languages.getDiagnostics(uri).map(toWire), (mirrored.get(uri) ?? []).map(toWire));
  const show = (uris) => {
    for (const uri of uris) {
      const list = [...others.values()].flatMap((byUri) => byUri.get(uri) ?? []);
      mirrored.set(vscode3.Uri.parse(uri), list.length ? list.map(fromWire) : undefined);
    }
  };
  const dirty = new Set;
  let timer = null;
  const publish = () => {
    timer = null;
    const changes = [];
    for (const uri of dirty) {
      const list = own(vscode3.Uri.parse(uri));
      const key = list.map(diagnosticKey).sort().join(`
`);
      if ((published.get(uri) ?? "") === key)
        continue;
      if (key)
        published.set(uri, key);
      else
        published.delete(uri);
      changes.push({ uri, diagnostics: list });
    }
    dirty.clear();
    if (changes.length)
      bus.send({ type: "diag.update", changes });
  };
  context.subscriptions.push(vscode3.languages.onDidChangeDiagnostics((event) => {
    for (const uri of event.uris)
      dirty.add(uri.toString());
    timer ??= setTimeout(publish, 150);
  }));
  bus.on("diag.update", (message) => {
    const member = message.from?.member;
    if (!member)
      return;
    const byUri = others.get(member) ?? new Map;
    others.set(member, byUri);
    const changes = message.changes ?? [];
    for (const change of changes) {
      if (change.diagnostics.length)
        byUri.set(change.uri, change.diagnostics);
      else
        byUri.delete(change.uri);
    }
    show(changes.map((change) => change.uri));
  });
  bus.on("diag.all", () => vscode3.languages.getDiagnostics().map(([uri]) => ({ uri: uri.toString(), diagnostics: own(uri) })).filter((item) => item.diagnostics.length > 0));
  const refresh = async () => {
    const members = [...bus.members.keys()].filter((member) => member !== bus.me.member);
    const gone = [...others.keys()].filter((member) => !members.includes(member));
    const touched = new Set;
    for (const member of gone) {
      for (const uri of others.get(member)?.keys() ?? [])
        touched.add(uri);
      others.delete(member);
    }
    for (const member of members.filter((item) => !others.has(item))) {
      const all = await bus.request(member, "diag.all", {}, 5000).catch(() => null);
      if (!all)
        continue;
      const byUri = new Map(all.map((item) => [item.uri, item.diagnostics]));
      others.set(member, byUri);
      for (const uri of byUri.keys())
        touched.add(uri);
    }
    show(touched);
  };
  context.subscriptions.push({ dispose: bus.onMembers(() => void refresh().catch((error) => log(`problems: ${error}`))).dispose });
  refresh().catch((error) => log(`problems: ${error}`));
};

// bridge/src/replace.ts
var vscode4 = __toESM(require("vscode"));
var PREVIEW_SCHEME = "private";
var PREVIEW_FRAGMENT = "replacePreview";
var startReplacePreview = (bus, context, part) => {
  if (part === "editor") {
    const changed = new vscode4.EventEmitter;
    context.subscriptions.push(changed, vscode4.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: async (uri) => {
        if (uri.fragment !== PREVIEW_FRAGMENT || !bus.has("view"))
          return;
        const text = await bus.request("view", "replace.preview", { uri: uri.toString() }, 1e4).catch(() => null);
        return text ?? undefined;
      }
    }));
    bus.on("replace.changed", (message) => changed.fire(vscode4.Uri.parse(String(message.uri))));
    const isPreview = (uri) => uri.scheme === PREVIEW_SCHEME && uri.fragment === PREVIEW_FRAGMENT;
    context.subscriptions.push(vscode4.workspace.onDidOpenTextDocument((document) => {
      if (isPreview(document.uri))
        changed.fire(document.uri);
    }));
    for (const document of vscode4.workspace.textDocuments)
      if (isPreview(document.uri))
        changed.fire(document.uri);
    return;
  }
  if (part !== "view")
    return;
  const following = new Set;
  bus.on("replace.preview", async (message) => {
    const uri = vscode4.Uri.parse(String(message.uri));
    if (uri.scheme !== PREVIEW_SCHEME || uri.fragment !== PREVIEW_FRAGMENT)
      return null;
    const document = await vscode4.workspace.openTextDocument(uri);
    following.add(document.uri.toString());
    return document.getText();
  });
  context.subscriptions.push(vscode4.workspace.onDidChangeTextDocument((event) => {
    const key = event.document.uri.toString();
    if (following.has(key))
      bus.send({ type: "replace.changed", to: "editor", uri: key });
  }));
  context.subscriptions.push(vscode4.workspace.onDidCloseTextDocument((document) => void following.delete(document.uri.toString())));
};

// bridge/src/runtime.ts
var vscode5 = __toESM(require("vscode"));

// bridge/src/dap.ts
var FORWARDED = new Set(["stopped", "continued", "exited", "terminated", "thread", "module", "loadedSource", "process", "capabilities", "invalidated", "memory"]);
var RUNS = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue", "goto"]);
var isAbsolute = (file) => file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file);
var toMainThread = (args, authority) => {
  const source = args?.source;
  if (!authority || !source || typeof source.path !== "string" || !isAbsolute(source.path) || typeof source.sourceReference === "number" && source.sourceReference > 0)
    return args;
  const file = source.path.replace(/\\/g, "/");
  const encoded = (file.startsWith("/") ? file : `/${file}`).split("/").map((part) => encodeURIComponent(part)).join("/");
  return { ...args, source: { ...source, path: `vscode-remote://${authority}${encoded}` } };
};

class BreakpointTracker {
  pending = new Map;
  byAdapterId = new Map;
  states = new Map;
  request(message) {
    if (message.type !== "request" || message.command !== "setBreakpoints" || typeof message.seq !== "number")
      return;
    const args = message.arguments ?? {};
    const file = args.source?.path;
    if (typeof file !== "string")
      return;
    const lines = (args.breakpoints ?? []).map((bp) => ({ line: bp.line, column: bp.column }));
    this.pending.set(message.seq, { path: file, lines });
  }
  message(message) {
    if (message.type === "response" && message.command === "setBreakpoints" && typeof message.request_seq === "number") {
      const asked = this.pending.get(message.request_seq);
      this.pending.delete(message.request_seq);
      if (!asked)
        return null;
      for (const [id, place] of this.byAdapterId)
        if (place.path === asked.path)
          this.byAdapterId.delete(id);
      const answered = message.success ? message.body?.breakpoints ?? [] : [];
      const states = asked.lines.map((place, index) => {
        const bp = answered[index];
        if (typeof bp?.id === "number")
          this.byAdapterId.set(bp.id, { path: asked.path, index });
        return stateOf(place, bp);
      });
      this.states.set(asked.path, states);
      return asked.path;
    }
    if (message.type === "event" && message.event === "breakpoint") {
      const bp = message.body?.breakpoint;
      const place = typeof bp?.id === "number" ? this.byAdapterId.get(bp.id) : undefined;
      if (!bp || !place)
        return null;
      const states = this.states.get(place.path);
      const old = states?.[place.index];
      if (!states || !old)
        return null;
      if (message.body?.reason === "removed") {
        states[place.index] = { ...old, verified: false, actualLine: undefined, actualColumn: undefined };
      } else {
        states[place.index] = stateOf({ line: old.line, column: old.column }, { verified: old.verified, line: old.actualLine, column: old.actualColumn, message: old.message, ...bp });
      }
      return place.path;
    }
    return null;
  }
  statesOf(file) {
    return this.states.get(file) ?? [];
  }
  sources() {
    return [...this.states.keys()];
  }
}
var stateOf = (place, bp) => {
  const line = typeof bp?.line === "number" ? bp.line : undefined;
  const column = typeof bp?.column === "number" ? bp.column : undefined;
  return {
    line: place.line,
    ...place.column !== undefined ? { column: place.column } : {},
    verified: bp?.verified === true,
    ...line !== undefined && line !== place.line ? { actualLine: line } : {},
    ...column !== undefined && column !== place.column ? { actualColumn: column } : {},
    ...typeof bp?.message === "string" ? { message: bp.message } : {}
  };
};

// bridge/src/runtime.ts
var RUNTIME_SESSION_OPTIONS = {
  suppressDebugView: true,
  suppressDebugToolbar: true,
  suppressDebugStatusbar: true,
  suppressSaveBeforeStart: true
};
var startRuntime = (bus, context, folder, authority, log) => {
  const sessions = new Map;
  const dataOf = (session) => {
    let data = sessions.get(session.id);
    if (!data) {
      data = { session, capabilities: null, stopped: new Map, breakpoints: new BreakpointTracker, dirty: new Set, flush: null };
      sessions.set(session.id, data);
    }
    return data;
  };
  const announce = (session) => bus.send({
    type: "session.started",
    realId: session.id,
    parentId: session.parentSession?.id,
    name: session.name,
    request: session.configuration.request === "attach" ? "attach" : "launch",
    noDebug: Boolean(session.configuration.noDebug)
  });
  const sendStates = (data) => {
    data.flush = null;
    const sources = {};
    for (const file of data.dirty)
      sources[file] = data.breakpoints.statesOf(file);
    data.dirty.clear();
    bus.send({ type: "bp.state", realId: data.session.id, sources });
  };
  context.subscriptions.push(vscode5.debug.registerDebugAdapterTrackerFactory("*", {
    createDebugAdapterTracker: (session) => {
      const data = dataOf(session);
      return {
        onWillReceiveMessage: (message) => data.breakpoints.request(message),
        onDidSendMessage: (message) => {
          const changed = data.breakpoints.message(message);
          if (changed) {
            data.dirty.add(changed);
            data.flush ??= setTimeout(() => sendStates(data), 30);
          }
          if (message.type === "response" && message.command === "initialize")
            data.capabilities = message.body ?? {};
          if (message.type !== "event" || !message.event)
            return;
          if (message.event === "stopped")
            data.stopped.set(message.body?.allThreadsStopped ? "all" : String(message.body?.threadId), message.body ?? {});
          if (message.event === "continued") {
            if (message.body?.allThreadsContinued !== false)
              data.stopped.clear();
            else
              data.stopped.delete(String(message.body?.threadId));
          }
          if (message.event === "capabilities")
            data.capabilities = { ...data.capabilities ?? {}, ...message.body?.capabilities ?? {} };
          if (FORWARDED.has(message.event))
            bus.send({ type: "dap.event", realId: session.id, event: message.event, body: message.body });
        }
      };
    }
  }));
  context.subscriptions.push(vscode5.debug.onDidStartDebugSession((session) => {
    dataOf(session).session = session;
    announce(session);
  }));
  context.subscriptions.push(vscode5.debug.onDidTerminateDebugSession((session) => {
    const data = sessions.get(session.id);
    if (!data)
      return;
    if (data.flush)
      clearTimeout(data.flush);
    sessions.delete(session.id);
    bus.send({ type: "session.ended", realId: session.id });
  }));
  context.subscriptions.push({ dispose: bus.onMembers(() => {
    for (const data of sessions.values())
      if (data.capabilities)
        announce(data.session);
  }).dispose });
  const sessionOf = (message) => {
    const data = sessions.get(String(message.realId));
    if (!data)
      throw new Error("that debug session ended");
    return data.session;
  };
  bus.on("debug.start", async (message) => {
    const started = Date.now();
    const target = message.config ?? message.name;
    const ok = await vscode5.debug.startDebugging(folder, target, { ...RUNTIME_SESSION_OPTIONS, noDebug: Boolean(message.noDebug) });
    log(`debug.start ${typeof target === "string" ? target : target.name}: ${ok} in ${Date.now() - started} ms`);
    return ok;
  });
  bus.on("dap.caps", (message) => sessions.get(String(message.realId))?.capabilities ?? null);
  bus.on("dap.state", (message) => ({ stopped: [...sessions.get(String(message.realId))?.stopped.values() ?? []] }));
  bus.on("dap.bpstates", (message) => {
    const data = sessions.get(String(message.realId));
    return data ? Object.fromEntries(data.breakpoints.sources().map((file) => [file, data.breakpoints.statesOf(file)])) : {};
  });
  bus.on("dap.request", async (message) => {
    const session = sessionOf(message);
    const command = String(message.command);
    const args = message.args;
    if (RUNS.has(command)) {
      const all = !args?.singleThread;
      const data = sessions.get(session.id);
      if (all)
        data?.stopped.clear();
      else
        data?.stopped.delete(String(args?.threadId));
      bus.send({ type: "dap.event", realId: session.id, event: "continued", body: { threadId: args?.threadId, allThreadsContinued: all } });
    }
    return session.customRequest(command, toMainThread(args, authority));
  });
  bus.on("debug.focus", (message) => vscode5.commands.executeCommand(FRAME.focusFrame, { sessionId: String(message.realId), threadId: Number(message.threadId), frameId: Number(message.frameId) }).then(undefined, () => {
    return;
  }));
  bus.on("session.stop", async (message) => {
    const data = sessions.get(String(message.realId));
    if (data)
      await vscode5.debug.stopDebugging(data.session);
  });
  bus.on("session.restart", async (message) => {
    sessionOf(message);
    await vscode5.commands.executeCommand("workbench.action.debug.restart", undefined, { sessionId: String(message.realId) });
    return true;
  });
  const userAsked = () => vscode5.commands.executeCommand(FRAME.allowFocus).then(undefined, () => {
    return;
  });
  bus.on("run.command", async (message) => {
    await userAsked();
    log(`run.command ${String(message.command)}`);
    await vscode5.commands.executeCommand(String(message.command), ...message.args ?? []);
    return true;
  });
  bus.on("terminal.send", async (message) => {
    await userAsked();
    const terminal = vscode5.window.activeTerminal ?? vscode5.window.createTerminal();
    terminal.show(false);
    terminal.sendText(String(message.text), message.execute !== false);
    return true;
  });
  bus.on("task.run", async (message) => {
    const spec = message.task;
    const tasks2 = await vscode5.tasks.fetchTasks(spec.definitionType ? { type: spec.definitionType } : undefined);
    const same = tasks2.filter((task) => task.source === spec.source && (task.name === spec.label || `${task.source}: ${task.name}` === spec.label));
    const task = same.find((item) => JSON.stringify(item.definition) === JSON.stringify(spec.definition)) ?? same[0];
    if (!task)
      throw new Error(`No task "${spec.source}: ${spec.label}" here`);
    await userAsked();
    await vscode5.tasks.executeTask(task);
    log(`task.run ${spec.source}: ${spec.label}`);
    return true;
  });
  bus.on("terminal.attach", (message) => vscode5.commands.executeCommand(FRAME.attachTerminal, message.terminal));
  bus.on("terminal.show", async (message) => {
    if (message.focus)
      await userAsked();
    return vscode5.commands.executeCommand(FRAME.showTerminal, { process: message.process, focus: Boolean(message.focus) });
  });
};

// bridge/src/files.ts
var vscode6 = __toESM(require("vscode"));
var startFiles = (bus, context, part, log) => {
  if (part !== "editor") {
    const tell = (phase, kind, files) => {
      if (!bus.has("editor"))
        return;
      if (phase === "did") {
        bus.send({ type: "files.change", to: "editor", phase, kind, files });
        return;
      }
      return bus.request("editor", "files.change", { phase, kind, files }, 4000).catch((error) => log(`files: ${error}`));
    };
    const renamed = (files) => files.map((file) => ({ from: file.oldUri.toString(), to: file.newUri.toString() }));
    const deleted = (files) => files.map((file) => ({ from: file.toString() }));
    context.subscriptions.push(vscode6.workspace.onWillRenameFiles((event) => {
      const waiting = tell("will", "rename", renamed(event.files));
      if (waiting)
        event.waitUntil(waiting);
    }));
    context.subscriptions.push(vscode6.workspace.onDidRenameFiles((event) => void tell("did", "rename", renamed(event.files))));
    context.subscriptions.push(vscode6.workspace.onWillDeleteFiles((event) => {
      const waiting = tell("will", "delete", deleted(event.files));
      if (waiting)
        event.waitUntil(waiting);
    }));
    context.subscriptions.push(vscode6.workspace.onDidDeleteFiles((event) => void tell("did", "delete", deleted(event.files))));
  } else {
    bus.on("files.change", (message) => vscode6.commands.executeCommand(FRAME.filesChange, { phase: message.phase, kind: message.kind, files: message.files }));
  }
  context.subscriptions.push(vscode6.commands.registerCommand(BRIDGE.undo, async (resource, redo) => {
    for (const member of [...bus.members.keys()]) {
      if (member === bus.me.member)
        continue;
      if (await bus.request(member, "undo.try", { resource, redo: Boolean(redo) }, 120000).catch(() => false)) {
        log(`${redo ? "redo" : "undo"} of ${resource} ran in the ${bus.members.get(member)}`);
        return true;
      }
    }
    return false;
  }));
  bus.on("undo.try", (message) => vscode6.commands.executeCommand(FRAME.undo, { resource: String(message.resource), redo: Boolean(message.redo) }).then((done) => done === true, () => false));
};

// bridge/src/git.ts
var vscode7 = __toESM(require("vscode"));
var api = null;
var gitApi = () => {
  api ??= (async () => {
    const extension = vscode7.extensions.getExtension("vscode.git");
    if (!extension)
      return null;
    const exports2 = extension.isActive ? extension.exports : await extension.activate();
    return exports2?.getAPI(1) ?? null;
  })().catch(() => null);
  return api;
};
var startGitSync = (bus, context, log) => {
  const known = new Map;
  const watch = (repository) => {
    const root = repository.rootUri.toString();
    known.set(root, gitFingerprint(repository.state));
    context.subscriptions.push(repository.state.onDidChange(() => {
      const now = gitFingerprint(repository.state);
      if (known.get(root) === now)
        return;
      known.set(root, now);
      bus.send({ type: "git.changed", root, fingerprint: now });
    }));
  };
  gitApi().then((git) => {
    if (!git)
      return;
    for (const repository of git.repositories)
      watch(repository);
    context.subscriptions.push(git.onDidOpenRepository(watch));
    bus.on("git.changed", async (message) => {
      const root = String(message.root);
      const repository = git.repositories.find((item) => item.rootUri.toString() === root);
      if (!repository)
        return;
      known.set(root, String(message.fingerprint));
      if (gitFingerprint(repository.state) === message.fingerprint)
        return;
      await repository.status().catch((error) => log(`git status: ${error}`));
    });
  });
};

// bridge/src/output.ts
var path4 = __toESM(require("node:path"));
var import_node_string_decoder2 = require("node:string_decoder");
var vscode8 = __toESM(require("vscode"));

// bridge/src/outputFiles.ts
var fs4 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
var import_node_string_decoder = require("node:string_decoder");
var FIRST_READ_MAX = 1 << 20;
var outputFiles = (root) => {
  const found = [];
  const add = (file, label, log) => {
    try {
      if (fs4.statSync(file).size > 0)
        found.push({ label, file, log });
    } catch {}
  };
  let entries;
  try {
    entries = fs4.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const plain = entry.name.startsWith("output_logging_");
    if (!plain && !/^[^.]+\.[^.]+$/.test(entry.name))
      continue;
    const dir = path3.join(root, entry.name);
    let names;
    try {
      names = fs4.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".log"))
        continue;
      if (!plain)
        add(path3.join(dir, name), name.slice(0, -".log".length), true);
      else {
        const match = /^\d+-(.+)\.log$/.exec(name);
        if (match)
          add(path3.join(dir, name), match[1], false);
      }
    }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label) || a.file.localeCompare(b.file));
};
var follow = (mirrored, append, clear) => {
  const size = fs4.statSync(mirrored.file).size;
  let offset = mirrored.offset;
  if (size < offset) {
    clear();
    offset = 0;
    mirrored.decoder = new import_node_string_decoder.StringDecoder("utf8");
  }
  if (size === offset)
    return offset;
  const start = offset === 0 && size > FIRST_READ_MAX ? size - FIRST_READ_MAX : offset;
  const buffer = Buffer.alloc(size - start);
  const fd = fs4.openSync(mirrored.file, "r");
  try {
    fs4.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs4.closeSync(fd);
  }
  append(mirrored.decoder.write(buffer));
  return size;
};

// bridge/src/output.ts
var PART_NAMES = { view: "rail", editor: "page" };
var startOutputSource = (bus, context) => {
  const root = path4.dirname(context.logUri.fsPath);
  let last = "";
  const publish = (always) => {
    if (!bus.has("terminal"))
      return;
    const list = outputFiles(root);
    const key = JSON.stringify(list);
    if (key === last && !always)
      return;
    last = key;
    bus.send({ type: "output.channels", to: "terminal", channels: list });
  };
  const timer = setInterval(() => publish(false), 3000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push({ dispose: bus.onMembers(() => publish(true)).dispose });
  publish(true);
};
var startOutputMirror = (bus, context, log) => {
  const mirrors = new Map;
  const drop = (key) => {
    mirrors.get(key)?.channel.dispose();
    mirrors.delete(key);
  };
  const pump = () => {
    if (bus.away)
      return;
    for (const mirrored of mirrors.values()) {
      try {
        mirrored.offset = follow(mirrored, (text) => mirrored.channel.append(text), () => mirrored.channel.clear());
      } catch {}
    }
  };
  bus.on("output.channels", (message) => {
    const member = message.from?.member;
    const part = message.from?.part;
    if (!member || !part)
      return;
    const keep = new Set;
    for (const spec of message.channels ?? []) {
      const key = `${member}|${spec.file}`;
      keep.add(key);
      if (mirrors.has(key))
        continue;
      const channel = vscode8.window.createOutputChannel(`${spec.label} (${PART_NAMES[part] ?? part})`, spec.log ? "log" : undefined);
      mirrors.set(key, { channel, file: spec.file, offset: 0, decoder: new import_node_string_decoder2.StringDecoder("utf8"), member });
    }
    for (const [key, mirrored] of mirrors)
      if (mirrored.member === member && !keep.has(key))
        drop(key);
    pump();
  });
  const timer = setInterval(pump, 1000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      for (const key of [...mirrors.keys()])
        drop(key);
    }
  });
  context.subscriptions.push({
    dispose: bus.onMembers(() => {
      const gone = [...mirrors].filter(([, mirrored]) => !bus.members.has(mirrored.member)).map(([key]) => key);
      for (const key of gone)
        drop(key);
      if (gone.length)
        log(`output: ${gone.length} channel(s) of a part that left`);
    }).dispose
  });
};

// bridge/src/views.ts
var vscode9 = __toESM(require("vscode"));
var wireRange = (range) => [range.start.line, range.start.character, range.end.line, range.end.character];
var toRange = ([sl, sc, el, ec]) => new vscode9.Range(sl, sc, el, ec);
var fromDocumentSymbols = (symbols) => {
  const nested = symbols.filter((symbol) => ("children" in symbol));
  if (nested.length === symbols.length) {
    const convert = (symbol) => ({
      name: symbol.name,
      detail: symbol.detail,
      kind: symbol.kind,
      range: wireRange(symbol.range),
      selectionRange: wireRange(symbol.selectionRange),
      children: [...symbol.children].sort((a, b) => a.range.start.compareTo(b.range.start)).map(convert)
    });
    return [...nested].sort((a, b) => a.range.start.compareTo(b.range.start)).map(convert);
  }
  const flat = symbols.map((symbol) => ({
    name: symbol.name,
    detail: symbol.containerName,
    kind: symbol.kind,
    range: wireRange(symbol.location.range),
    selectionRange: wireRange(symbol.location.range),
    children: []
  })).sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  const roots = [];
  const stack = [];
  for (const symbol of flat) {
    while (stack.length && !(symbol.range[0] >= stack.at(-1).range[0] && symbol.range[2] <= stack.at(-1).range[2]))
      stack.pop();
    (stack.length ? stack.at(-1).children : roots).push(symbol);
    stack.push(symbol);
  }
  return roots;
};
var startViews = (bus, context, part, log) => {
  if (part === "editor")
    startPageSide(bus, context, log);
  if (part === "view")
    startRailSide(bus, context, log);
};
var startPageSide = (bus, context, log) => {
  let state = { uri: null, symbols: [], provides: false };
  let version = 0;
  const publish = async () => {
    const mine = ++version;
    const editor = vscode9.window.activeTextEditor;
    if (!editor) {
      state = { uri: null, symbols: [], provides: false };
    } else {
      const symbols = await vscode9.commands.executeCommand("vscode.executeDocumentSymbolProvider", editor.document.uri).then((value) => value, () => {
        return;
      });
      if (mine !== version)
        return;
      state = { uri: editor.document.uri.toString(), symbols: symbols ? fromDocumentSymbols(symbols) : [], provides: Boolean(symbols) };
    }
    bus.send({ type: "editor.active", to: "view", ...state });
  };
  let timer = null;
  const soon = (ms) => {
    if (timer)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      publish().catch((error) => log(`outline: ${error}`));
    }, ms);
  };
  context.subscriptions.push(vscode9.window.onDidChangeActiveTextEditor(() => soon(50)));
  context.subscriptions.push(vscode9.workspace.onDidChangeTextDocument((event) => {
    if (event.document === vscode9.window.activeTextEditor?.document)
      soon(400);
  }));
  context.subscriptions.push(vscode9.languages.onDidChangeDiagnostics(() => {
    if (!state.provides && vscode9.window.activeTextEditor)
      soon(800);
  }));
  let cursorTimer = null;
  context.subscriptions.push(vscode9.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor !== vscode9.window.activeTextEditor)
      return;
    if (cursorTimer)
      clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      const position = event.textEditor.selection.active;
      bus.send({ type: "editor.cursor", to: "view", uri: event.textEditor.document.uri.toString(), line: position.line, character: position.character });
    }, 100);
  }));
  bus.on("editor.current", () => state);
  bus.on("editor.reveal", async (message) => {
    await vscode9.commands.executeCommand(FRAME.allowFocus).then(undefined, () => {
      return;
    });
    const document = await vscode9.workspace.openTextDocument(vscode9.Uri.parse(String(message.uri)));
    const selection = toRange(message.range);
    await vscode9.window.showTextDocument(document, { selection: new vscode9.Range(selection.start, selection.start), preserveFocus: message.preserveFocus === true });
    return true;
  });
  context.subscriptions.push({ dispose: bus.onMembers(() => soon(50)).dispose });
  soon(0);
};

class OutlineProvider {
  state = { uri: null, symbols: [], provides: false };
  parents = new Map;
  changed = new vscode9.EventEmitter;
  onDidChangeTreeData = this.changed.event;
  set(state) {
    this.state = state;
    this.parents.clear();
    const walk = (symbols, parent) => {
      for (const symbol of symbols) {
        this.parents.set(symbol, parent);
        walk(symbol.children, symbol);
      }
    };
    walk(state.symbols);
    this.changed.fire();
  }
  getTreeItem(symbol) {
    const item = new vscode9.TreeItem(symbol.name, symbol.children.length ? vscode9.TreeItemCollapsibleState.Expanded : vscode9.TreeItemCollapsibleState.None);
    item.description = symbol.detail || undefined;
    item.iconPath = new vscode9.ThemeIcon(`symbol-${SYMBOL_ICONS[symbol.kind] ?? "misc"}`);
    item.command = { command: "openchamber.bridge.revealSymbol", title: "Reveal", arguments: [this.state.uri, symbol.selectionRange] };
    item.id = `${symbol.range.join(",")}|${symbol.name}`;
    return item;
  }
  getChildren(symbol) {
    return symbol ? symbol.children : this.state.symbols;
  }
  getParent(symbol) {
    return this.parents.get(symbol);
  }
}

class TimelineProvider {
  git;
  uri = null;
  commits = [];
  changed = new vscode9.EventEmitter;
  onDidChangeTreeData = this.changed.event;
  constructor(git) {
    this.git = git;
  }
  async load(uri) {
    this.uri = uri;
    const repository = uri ? (await this.git())?.getRepository(uri) ?? null : null;
    const commits = repository && uri ? await repository.log({ path: uri.fsPath, maxEntries: 50 }).catch(() => []) : [];
    if (this.uri !== uri)
      return;
    this.commits = commits;
    this.changed.fire();
  }
  follow(git, loaded) {
    const heads = new Map;
    const watching = [];
    const again = () => void this.load(this.uri).then(loaded);
    const watch = (repository) => {
      heads.set(repository, repository.state.HEAD?.commit);
      watching.push(repository.state.onDidChange(() => {
        const head = repository.state.HEAD?.commit;
        if (head === heads.get(repository))
          return;
        heads.set(repository, head);
        if (this.uri && git.getRepository(this.uri) === repository)
          again();
      }));
      if (this.uri && git.getRepository(this.uri) === repository)
        again();
    };
    for (const repository of git.repositories)
      watch(repository);
    watching.push(git.onDidOpenRepository(watch));
    return { dispose: () => watching.forEach((item) => item.dispose()) };
  }
  getTreeItem(commit) {
    const item = new vscode9.TreeItem(commit.message.split(`
`)[0] ?? commit.hash.slice(0, 7), vscode9.TreeItemCollapsibleState.None);
    item.description = [commit.authorName, commit.authorDate ? relative(commit.authorDate) : undefined].filter(Boolean).join(", ");
    item.tooltip = `${commit.hash.slice(0, 8)} ${commit.authorName ?? ""}

${commit.message}`;
    item.iconPath = new vscode9.ThemeIcon("git-commit");
    if (this.uri)
      item.command = { command: "openchamber.bridge.openCommit", title: "Open Changes", arguments: [this.uri.toString(), commit.hash, commit.parents[0] ?? null] };
    return item;
  }
  getChildren(commit) {
    return commit ? [] : this.commits;
  }
}
var relative = (date) => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 60)
    return `${Math.max(minutes, 0)} min ago`;
  if (minutes < 60 * 24)
    return `${Math.round(minutes / 60)} hr ago`;
  return `${Math.round(minutes / 60 / 24)} days ago`;
};
var startRailSide = (bus, context, log) => {
  const outline = new OutlineProvider;
  const outlineView = vscode9.window.createTreeView("openchamber.outline", { treeDataProvider: outline, showCollapseAll: true });
  const timeline = new TimelineProvider(gitApi);
  const timelineView = vscode9.window.createTreeView("openchamber.timeline", { treeDataProvider: timeline });
  context.subscriptions.push(outlineView, timelineView);
  const NO_EDITOR = "The page's active editor cannot provide outline information.";
  const apply = (state) => {
    outline.set(state);
    outlineView.message = !state.uri ? "There is no editor open in the page." : state.provides ? undefined : NO_EDITOR;
    const uri = state.uri ? vscode9.Uri.parse(state.uri) : null;
    if (uri?.toString() !== timeline.uri?.toString())
      timeline.load(uri).then(timelineLoaded);
  };
  const timelineLoaded = () => {
    timelineView.message = !timeline.uri ? "There is no editor open in the page." : timeline.commits.length ? undefined : "The page's active file has no Git history.";
  };
  gitApi().then((git) => {
    if (git)
      context.subscriptions.push(timeline.follow(git, timelineLoaded));
  });
  bus.on("editor.active", (message) => apply({ uri: message.uri ?? null, symbols: message.symbols ?? [], provides: Boolean(message.provides) }));
  bus.on("editor.cursor", async (message) => {
    if (message.uri !== outline.state.uri || !outlineView.visible)
      return;
    const path = symbolPath(outline.state.symbols, Number(message.line), Number(message.character));
    const target = path.at(-1);
    if (target)
      await Promise.resolve(outlineView.reveal(target, { select: true, focus: false, expand: true })).then(undefined, () => {
        return;
      });
  });
  context.subscriptions.push(vscode9.commands.registerCommand("openchamber.bridge.revealSymbol", async (uri, range) => {
    if (uri)
      await bus.request("editor", "editor.reveal", { uri, range }, 1e4).catch((error) => log(`reveal: ${error}`));
  }));
  context.subscriptions.push(vscode9.commands.registerCommand("openchamber.bridge.openCommit", async (uri, hash, parent) => {
    const git = await gitApi();
    if (!git)
      return;
    const file = vscode9.Uri.parse(uri);
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    await vscode9.commands.executeCommand("vscode.diff", git.toGitUri(file, parent ?? `${hash}~`), git.toGitUri(file, hash), `${name} (${hash.slice(0, 7)})`);
  }));
  const ask = async () => {
    if (!bus.has("editor")) {
      apply({ uri: null, symbols: [], provides: false });
      return;
    }
    const state = await bus.request("editor", "editor.current", {}, 5000).catch(() => null);
    if (state)
      apply(state);
  };
  context.subscriptions.push({ dispose: bus.onMembers(() => void ask()).dispose });
  ask();
};

// bridge/src/extension.ts
var PARTS = ["view", "editor", "terminal"];
var activate = async (context) => {
  const channel = vscode10.window.createOutputChannel("OpenChamber Bridge", { log: true });
  context.subscriptions.push(channel);
  const info = await vscode10.commands.executeCommand(FRAME.info).then((value) => value, () => {
    return;
  });
  const part = info?.role;
  const folder = vscode10.workspace.workspaceFolders?.[0];
  if (!info || !part || !PARTS.includes(part) || !folder) {
    channel.info(`not one of OpenChamber's parts (${part ?? "no frame"}): nothing to do`);
    return;
  }
  const role = part;
  const log = (line) => channel.info(`[${role}] ${line}`);
  const folderKey = `${os.hostname()}|${folder.uri.toString()}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const bus = new Bus({ dir: path5.join(os.tmpdir(), `ocvsb-${uid}`), key: `${folderKey}|${info.window ?? "folder"}`, part: role, parts: PARTS, log });
  context.subscriptions.push(bus);
  const heartbeat = new Heartbeat({
    ping: () => vscode10.commands.executeCommand(FRAME.info),
    onAway: () => bus.leave(),
    onBack: () => void bus.rejoin().catch((error) => log(String(error)))
  });
  context.subscriptions.push({ dispose: () => heartbeat.stop() });
  await bus.start();
  heartbeat.start();
  bus.sweep().then((removed) => removed && log(`removed ${removed} stale socket(s) of closed windows`), () => {
    return;
  });
  const name = crypto2.createHash("sha1").update(folderKey).digest("hex").slice(0, 20);
  const breakpoints = syncBreakpoints(bus, new BreakpointStore(path5.join(context.globalStorageUri.fsPath, `${name}.breakpoints.json`)), log);
  context.subscriptions.push(breakpoints);
  if (role === "terminal")
    startRuntime(bus, context, folder, info.authority || undefined, log);
  else
    startFront(bus, context, folder, role, log);
  startProblems(bus, context, log);
  startViews(bus, context, role, log);
  if (role === "terminal")
    startOutputMirror(bus, context, log);
  else
    startOutputSource(bus, context);
  startFiles(bus, context, role, log);
  startReplacePreview(bus, context, role);
  startGitSync(bus, context, log);
  vscode10.commands.executeCommand("setContext", "openchamber.bridge.part", role);
  const manifest = context.extension.packageJSON;
  vscode10.commands.executeCommand(FRAME.hello, { build: manifest.openchamberBuild ?? null, version: manifest.version ?? "" }).then(undefined, () => {
    return;
  });
  breakpoints.join().then(() => log("breakpoints joined"), (error) => log(`breakpoints: ${error}`));
  log(`ready for ${folder.uri.toString()} in window ${info.window ?? "(the folder)"}`);
};
var deactivate = () => {
  return;
};
