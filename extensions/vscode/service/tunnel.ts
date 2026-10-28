// The workbench's web sockets, carried over the host's request/response
// channel: the frame cannot open a socket itself (its CSP allows connections
// to its own package only), so the service opens it to the VS Code Server and
// the frame sends batches and long-polls for what arrived. VS Code's remote
// protocol keeps its own framing and reconnects on its own, so a tunnel only
// has to keep order.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/** What a poll may carry, base64 included: well under the host's 8 MB answer. */
const POLL_BYTES = 4_000_000;
/** A poll waits this long for something to arrive: well under the host's 20 s. */
export const POLL_WAIT_MS = 12_000;
/** A tunnel nobody polled for this long belongs to a frame that is gone. */
const ABANDONED_MS = 45_000;
/**
 * Past this the least recently polled tunnel is closed, which ends a live
 * workbench if every tunnel is live. Each workbench holds 2 (its management
 * connection and its extension host's); in an adapted OpenChamber a browser
 * window runs up to 3 (rail view, page, bottom terminal), so 6, and up to 12
 * for the 45 s a reloaded frame's old tunnels linger. 128 leaves room for
 * about ten such windows; the server's cost is per workbench either way.
 */
export const MAX_TUNNELS = 128;

export type TunnelEvent = { type: 'open' } | { type: 'data'; data: string } | { type: 'error'; message: string };
export type TunnelClose = { code: number; reason: string; wasClean: boolean };

type SocketEvent = { data?: unknown; code?: number; reason?: string; wasClean?: boolean; message?: string };
interface SocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

/** The upgrade answer's headers can't be longer than this. */
const HEADER_MAX = 16_384;

/**
 * A connection to the VS Code Server opened the way VS Code's own Node client
 * opens one (src/vs/platform/remote/node/nodeSocketFactory.ts): an upgrade
 * request asking for `skipWebSocketFrames=true`, then the bare TCP stream,
 * whose bytes pass as they come (the remote protocol frames itself).
 *
 * Not a WebSocket: the server ignores WebSocket Close frames (its
 * WebSocketNodeSocket reads data and Ping only) and never times a socket out,
 * so a WebSocket's close() waits for an answer that never comes. The
 * connection then stays open for good, and so does the extension host the
 * server keeps for it. Closing this one ends the TCP connection at once, and
 * the server starts its own reconnection grace.
 */
export class ServerSocket implements SocketLike {
  binaryType = 'arraybuffer';
  private readonly socket: net.Socket;
  private readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>();
  private readonly early: Buffer[] = [];
  private header: Buffer | null = Buffer.alloc(0);
  private ended = false;

  constructor(url: string, headers: Record<string, string>) {
    const target = new URL(url);
    target.searchParams.set('skipWebSocketFrames', 'true');
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(target.port) || (secure ? 443 : 80);
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      ...Object.entries(headers)
        .filter(([name, value]) => !/[\r\n:]/.test(name) && !/[\r\n]/.test(value))
        .map(([name, value]) => `${name}: ${value}`),
    ];
    const request = `${lines.join('\r\n')}\r\n\r\n`;
    this.socket = secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }, () => this.socket.write(request))
      : net.connect({ host, port }, () => this.socket.write(request));
    this.socket.setNoDelay(true);
    this.socket.on('data', (data: Buffer) => this.accept(data));
    // A socket error is followed by its close, which ends this one.
    this.socket.on('error', (error) => this.emit('error', { message: error.message }));
    this.socket.on('close', () => this.end(1006, ''));
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: Uint8Array): void {
    if (this.ended) return;
    if (this.header) this.early.push(Buffer.from(data));
    else this.socket.write(data);
  }

  close(): void {
    if (this.ended) return;
    this.socket.destroy();
    this.end(1000, '', true);
  }

  private accept(data: Buffer): void {
    if (this.ended) return;
    if (!this.header) {
      this.emit('message', { data });
      return;
    }
    const header = Buffer.concat([this.header, data]);
    const end = header.indexOf('\r\n\r\n');
    if (end < 0) {
      if (header.length > HEADER_MAX) this.fail('The VS Code Server sent no upgrade answer.');
      else this.header = header;
      return;
    }
    this.header = null;
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(header.subarray(0, end).toString('latin1'))?.[1] ?? 'no status';
    if (status !== '101') {
      this.fail(`The VS Code Server refused the connection (HTTP ${status}).`);
      return;
    }
    this.emit('open', {});
    for (const chunk of this.early.splice(0)) this.socket.write(chunk);
    const rest = header.subarray(end + 4);
    if (rest.length > 0) this.emit('message', { data: rest });
  }

  private fail(message: string): void {
    this.emit('error', { message });
    this.socket.destroy();
    this.end(1006, message);
  }

  private end(code: number, reason: string, wasClean = false): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('close', { code, reason, wasClean });
  }

  private emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const defaultFactory: SocketFactory = (url, headers) => new ServerSocket(url, headers);

interface Tunnel {
  socket: SocketLike;
  queue: TunnelEvent[];
  queued: number;
  closed: TunnelClose | null;
  waiters: (() => void)[];
  polledAt: number;
}

export class Tunnels {
  private readonly tunnels = new Map<string, Tunnel>();
  /** Sockets not yet closed, those of closed tunnels included. */
  private readonly live = new Set<SocketLike>();
  private next = 1;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly factory: SocketFactory = defaultFactory, private readonly now: () => number = Date.now) {
    this.sweeper = setInterval(() => this.sweep(), 10_000);
    this.sweeper.unref?.();
  }

  open(url: string, headers: Record<string, string>): string {
    if (this.tunnels.size >= MAX_TUNNELS) this.sweep(true);
    const id = `t${this.next++}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = this.factory(url, headers);
    socket.binaryType = 'arraybuffer';
    const tunnel: Tunnel = { socket, queue: [], queued: 0, closed: null, waiters: [], polledAt: this.now() };
    const wake = () => {
      for (const waiter of tunnel.waiters.splice(0)) waiter();
    };
    const push = (event: TunnelEvent) => {
      tunnel.queue.push(event);
      tunnel.queued += event.type === 'data' ? event.data.length : 0;
      wake();
    };
    socket.addEventListener('open', () => push({ type: 'open' }));
    socket.addEventListener('message', (event) => {
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data));
      push({ type: 'data', data: bytes.toString('base64') });
    });
    socket.addEventListener('error', (event) => push({ type: 'error', message: event.message ?? 'socket error' }));
    socket.addEventListener('close', (event) => {
      this.live.delete(socket);
      tunnel.closed = { code: event.code ?? 1006, reason: event.reason ?? '', wasClean: event.wasClean ?? false };
      wake();
    });
    this.live.add(socket);
    this.tunnels.set(id, tunnel);
    return id;
  }

  has(id: string): boolean {
    return this.tunnels.has(id);
  }

  send(id: string, chunks: string[]): void {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) throw new Error('no such tunnel');
    if (tunnel.closed) return;
    for (const chunk of chunks) tunnel.socket.send(Buffer.from(chunk, 'base64'));
  }

  /** What arrived since the last poll, waiting up to `waitMs` for something. */
  async receive(id: string, waitMs = POLL_WAIT_MS): Promise<{ events: TunnelEvent[]; closed: TunnelClose | null }> {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return { events: [], closed: { code: 1006, reason: 'tunnel gone', wasClean: false } };
    tunnel.polledAt = this.now();
    if (tunnel.queue.length === 0 && !tunnel.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        tunnel.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    tunnel.polledAt = this.now();
    const events: TunnelEvent[] = [];
    let size = 0;
    while (tunnel.queue.length > 0) {
      const event = tunnel.queue[0]!;
      const length = event.type === 'data' ? event.data.length : 0;
      if (events.length > 0 && size + length > POLL_BYTES) break;
      tunnel.queue.shift();
      tunnel.queued -= length;
      size += length;
      events.push(event);
    }
    const closed = tunnel.queue.length === 0 ? tunnel.closed : null;
    if (closed) this.tunnels.delete(id);
    return { events, closed };
  }

  close(id: string): void {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return;
    this.tunnels.delete(id);
    try {
      tunnel.socket.close();
    } catch {
      // Already closing.
    }
    for (const waiter of tunnel.waiters.splice(0)) waiter();
  }

  /** Close tunnels nobody polls (their frame is gone); with `oldest`, also the least recently polled one. */
  sweep(oldest = false): void {
    const now = this.now();
    for (const [id, tunnel] of this.tunnels) if (now - tunnel.polledAt > ABANDONED_MS) this.close(id);
    if (oldest && this.tunnels.size >= MAX_TUNNELS) {
      const [id] = [...this.tunnels.entries()].sort((a, b) => a[1].polledAt - b[1].polledAt)[0] ?? [];
      if (id) this.close(id);
    }
  }

  size(): number {
    return this.tunnels.size;
  }

  /** Connections to the VS Code Server still open; more than `size()` for long means closing doesn't end them. */
  sockets(): number {
    return this.live.size;
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.tunnels.keys()]) this.close(id);
    for (const socket of [...this.live]) socket.close();
  }
}
