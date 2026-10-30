// The parts of one VS Code in OpenChamber (the rail view, the page, the bottom terminal of one OpenChamber window, on
// one folder), over a Unix socket on the VS Code Server's machine, where every part's extension host runs.
//
// The first part to come listens and relays every message to the others; the others connect. When it goes, the next
// to notice listens: one at a time, under a lock file, so that two parts that both find the socket dead don't both
// listen. Messages are JSON lines, `{ type, from: { part, member }, to?, reqId?, ... }`, each part's delivered in the
// order it sent them. `to` is a member, or a part: a request for a part goes to one member of it, the one that joined
// first (a part whose frame reloaded has, for a while, an old member too: VS Code keeps its extension host).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Emitter, sleep } from './events.ts';
import { tryLock } from './lock.ts';

export interface Member {
  part: string;
  member: string;
}

export interface Message {
  type: string;
  from?: Member;
  to?: string;
  reqId?: string;
  [key: string]: unknown;
}

export interface BusOptions {
  /** Where the socket and its lock live (mode 0700): one per user. */
  dir: string;
  /** What the bus joins: the parts of one window on one folder (`host|folder|window`). */
  key: string;
  part: string;
  /** Parts a request may name by their part (the others go by member). */
  parts: readonly string[];
  log?: (line: string) => void;
}

const BUS_MEMBER: Member = { part: 'bus', member: 'bus' };

export const busFiles = (dir: string, key: string): { socket: string; lock: string } => {
  const name = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
  return { socket: path.join(dir, `${name}.sock`), lock: path.join(dir, `${name}.lock`) };
};

/**
 * Removes the sockets (and locks) of buses nobody answers on any more, older than `olderThanMs`: a window whose
 * extension hosts were killed leaves its socket behind (a server closed in time removes its own). Answers how many.
 */
export const sweepStale = async (dir: string, keep: string, olderThanMs = 5 * 60_000): Promise<number> => {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.sock') || file === keep) continue;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < olderThanMs) continue;
    } catch {
      continue;
    }
    const answers = await new Promise<boolean>((resolve) => {
      const socket = net.connect(file);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (answers) continue;
    for (const target of [file, file.replace(/\.sock$/, '.lock')]) {
      try {
        fs.unlinkSync(target);
      } catch {
        // Gone already.
      }
    }
    removed++;
  }
  return removed;
};

type Handler = (message: Message) => unknown;

export class Bus {
  readonly me: Member;
  /** Member id → part, in the order they joined (the one listening first). */
  members = new Map<string, string>();
  away = false;
  private readonly handlers = new Map<string, Handler>();
  private readonly waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly clients = new Set<net.Socket & { member?: string }>();
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private disposed = false;
  private starting: Promise<void> | null = null;
  private readonly membersChanged = new Emitter<string[]>();
  readonly onMembers = this.membersChanged.event;
  private readonly files: { socket: string; lock: string };

  constructor(private readonly options: BusOptions) {
    this.me = { part: options.part, member: crypto.randomUUID() };
    this.members.set(this.me.member, this.me.part);
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.files = busFiles(options.dir, options.key);
  }

  get leading(): boolean {
    return this.server !== null;
  }

  get connected(): boolean {
    return this.server !== null || this.socket !== null;
  }

  private log(line: string): void {
    this.options.log?.(`[${this.me.part}] ${line}`);
  }

  start(): Promise<void> {
    this.starting ??= this.join().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Sweeps other buses' stale sockets out of the directory (once a part started). */
  sweep(olderThanMs?: number): Promise<number> {
    return sweepStale(this.options.dir, this.files.socket, olderThanMs);
  }

  private async join(): Promise<void> {
    for (let attempt = 0; attempt < 100 && !this.disposed && !this.away; attempt++) {
      if (await this.connect()) return;
      // Nobody answers: listen, one part at a time.
      const release = tryLock(this.files.lock);
      if (release) {
        try {
          if (await this.connect()) return;
          try {
            fs.unlinkSync(this.files.socket);
          } catch {
            // No socket left behind.
          }
          if (await this.listen()) return;
        } finally {
          release();
        }
      }
      await sleep(20 + Math.random() * 80);
    }
    if (!this.disposed && !this.away) throw new Error(`could not join the parts at ${this.files.socket}`);
  }

  private listen(): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once('error', () => resolve(false));
      server.listen(this.files.socket, () => {
        try {
          fs.chmodSync(this.files.socket, 0o600);
        } catch {
          // The directory is the user's alone anyway.
        }
        this.server = server;
        this.members = new Map([[this.me.member, this.me.part]]);
        this.log('listens');
        this.announce();
        resolve(true);
      });
    });
  }

  private connect(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.files.socket)) {
        resolve(false);
        return;
      }
      const socket = net.connect(this.files.socket);
      socket.once('error', () => resolve(false));
      socket.once('connect', () => {
        this.socket = socket;
        this.read(socket, (message) => this.deliver(message));
        socket.on('error', () => undefined);
        socket.on('close', () => {
          if (this.socket === socket) this.socket = null;
          if (!this.disposed && !this.away) void this.start().catch((error) => this.log(String(error)));
        });
        this.write(socket, { type: 'hello', from: this.me });
        this.log('joined');
        resolve(true);
      });
    });
  }

  private accept(socket: net.Socket & { member?: string }): void {
    this.clients.add(socket);
    this.read(socket, (message) => {
      if (message.type === 'hello' && message.from) {
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

  private announce(): void {
    this.relay({ type: 'members', from: this.me, list: [...this.members].map(([member, part]) => ({ member, part })) }, null);
  }

  private read(socket: net.Socket, onMessage: (message: Message) => void): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch (error) {
          this.log(`bad message: ${error}`);
          continue;
        }
        onMessage(message);
      }
    });
  }

  private write(socket: net.Socket, message: Message): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  /** As the one listening: a request for a part goes to its first member; then to every other part, and to this one. */
  private relay(message: Message, origin: net.Socket | null): void {
    if (message.reqId && message.type !== 'reply' && message.to && this.options.parts.includes(message.to)) {
      const member = [...this.members].find(([, part]) => part === message.to)?.[0];
      if (!member) {
        const reply: Message = { type: 'reply', from: BUS_MEMBER, to: message.from?.member, reqId: message.reqId, ok: false, error: `no ${message.to} part` };
        if (origin) this.write(origin, reply);
        else this.deliver(reply);
        return;
      }
      message = { ...message, to: member };
    }
    for (const client of this.clients) if (client !== origin) this.write(client, message);
    if (origin !== null || message.type === 'members' || (message.to === this.me.member && message.from?.member !== this.me.member)) this.deliver(message);
  }

  private deliver(message: Message): void {
    if (message.type === 'members') {
      const list = (message.list as Member[] | undefined) ?? [];
      this.members = new Map(list.map((item) => [item.member, item.part]));
      this.membersChanged.fire([...this.members.values()]);
      return;
    }
    if (message.from?.member === this.me.member) return;
    if (message.to && message.to !== this.me.part && message.to !== this.me.member) return;
    if (message.type === 'reply') {
      const waiter = message.reqId ? this.waiting.get(message.reqId) : undefined;
      if (waiter && message.reqId) {
        this.waiting.delete(message.reqId);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(new Error(String(message.error ?? 'failed')));
      }
      return;
    }
    const handler = this.handlers.get(message.type);
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(message))
      .then((value) => {
        if (message.reqId) this.send({ type: 'reply', to: message.from?.member, reqId: message.reqId, ok: true, value: value ?? null });
      }, (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        this.log(`${message.type}: ${text}`);
        if (message.reqId) this.send({ type: 'reply', to: message.from?.member, reqId: message.reqId, ok: false, error: text });
      });
  }

  send(message: Message): void {
    const full: Message = { ...message, from: this.me };
    if (this.server) this.relay(full, null);
    else if (this.socket) this.write(this.socket, full);
  }

  request<T = unknown>(to: string | undefined, type: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const reqId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error(`${type}: no answer from the ${to ?? 'other'} part`));
      }, timeoutMs);
      this.waiting.set(reqId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...payload, type, to, reqId });
    });
  }

  /** Every other member's answer, each within `ms`. */
  async gather<T = unknown>(type: string, payload: Record<string, unknown> = {}, ms = 1_500): Promise<T[]> {
    const others = [...this.members.keys()].filter((member) => member !== this.me.member);
    const answers = await Promise.all(others.map((member) => this.request<T>(member, type, payload, ms).then((value) => ({ value }), () => null)));
    return answers.filter((answer): answer is { value: T } => answer !== null && answer.value !== null && answer.value !== undefined).map((answer) => answer.value);
  }

  on(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  has(part: string): boolean {
    return [...this.members.values()].includes(part);
  }

  /** The member a request for `part` goes to (the first of it), if any. */
  memberOf(part: string): string | undefined {
    return [...this.members].find(([, value]) => value === part)?.[0];
  }

  /** This part's window went (it doesn't answer): out of the bus until it answers again. */
  leave(): void {
    if (this.away) return;
    this.away = true;
    this.socket?.destroy();
    this.socket = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.members = new Map([[this.me.member, this.me.part]]);
    this.log("its window doesn't answer: it leaves");
  }

  async rejoin(): Promise<void> {
    if (!this.away) return;
    this.away = false;
    this.log('its window answers again: it rejoins');
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.destroy();
    for (const client of this.clients) client.destroy();
    this.server?.close();
    this.membersChanged.dispose();
    for (const waiter of this.waiting.values()) waiter.reject(new Error('the bus closed'));
    this.waiting.clear();
  }
}
