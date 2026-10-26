// The workbench's web sockets, carried over the host's request/response
// channel: the frame cannot open a socket itself (its CSP allows connections
// to its own package only), so the service opens it to the VS Code Server and
// the frame sends batches and long-polls for what arrived. VS Code's remote
// protocol keeps its own framing and reconnects on its own, so a tunnel only
// has to keep order.

/** What a poll may carry, base64 included: well under the host's 8 MB answer. */
const POLL_BYTES = 4_000_000;
/** A poll waits this long for something to arrive: well under the host's 20 s. */
export const POLL_WAIT_MS = 12_000;
/** A tunnel nobody polled for this long belongs to a frame that is gone. */
const ABANDONED_MS = 45_000;
const MAX_TUNNELS = 32;

export type TunnelEvent = { type: 'open' } | { type: 'data'; data: string } | { type: 'error'; message: string };
export type TunnelClose = { code: number; reason: string; wasClean: boolean };

interface SocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string; wasClean?: boolean; message?: string }) => void): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const defaultFactory: SocketFactory = (url, headers) => {
  const Socket = (globalThis as { WebSocket?: new (url: string, init?: unknown) => SocketLike }).WebSocket;
  if (!Socket) throw new Error('This Node has no WebSocket; OpenChamber needs Node 22 or newer for the VS Code view.');
  return new Socket(url, { headers });
};

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
      tunnel.closed = { code: event.code ?? 1006, reason: event.reason ?? '', wasClean: event.wasClean ?? false };
      wake();
    });
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

  dispose(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.tunnels.keys()]) this.close(id);
  }
}
