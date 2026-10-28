import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { Tunnels, type SocketFactory } from '../service/tunnel.ts';
import { sendBatches, TunnelSocket, type TunnelService } from '../workbench/tunnel.ts';

/**
 * A loopback server that answers an upgrade the way the VS Code Server's
 * upgradeToISocket does, then echoes the raw bytes; like the real server, it
 * never answers a WebSocket Close frame or ends a socket by itself.
 */
const vscodeServer = async () => {
  const upgrades: { requestLine: string; headers: Record<string, string> }[] = [];
  const connections: { socket: net.Socket; received: Buffer[]; closed: Promise<void> }[] = [];
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    const connection = { socket, received: [] as Buffer[], closed: new Promise<void>((resolve) => socket.on('close', () => resolve())) };
    connections.push(connection);
    socket.on('error', () => {});
    socket.on('data', (data: Buffer) => {
      if (upgraded) {
        connection.received.push(data);
        socket.write(data);
        return;
      }
      head = Buffer.concat([head, data]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [requestLine = '', ...lines] = head.subarray(0, end).toString('latin1').split('\r\n');
      const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      upgrades.push({ requestLine, headers });
      if (headers.cookie !== 'vscode-tkn=t') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      upgraded = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n');
      const rest = head.subarray(end + 4);
      if (rest.length > 0) socket.emit('data', rest);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, upgrades, connections, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};
const within = <T,>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([promise, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

/** A socket that records what it sent and lets the test play the server. */
const fakeSockets = () => {
  const sockets: { url: string; headers: Record<string, string>; sent: Buffer[]; fire: (type: string, event?: Record<string, unknown>) => void; closed: boolean }[] = [];
  const factory: SocketFactory = (url, headers) => {
    const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
    const socket = {
      url, headers, sent: [] as Buffer[], closed: false,
      fire: (type: string, event: Record<string, unknown> = {}) => {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
    sockets.push(socket);
    return {
      binaryType: 'blob',
      send: (data: Uint8Array) => void socket.sent.push(Buffer.from(data)),
      close: () => {
        socket.closed = true;
      },
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    };
  };
  return { sockets, factory };
};

describe('the service side', () => {
  test('carries bytes both ways in order and reports the close', async () => {
    const { sockets, factory } = fakeSockets();
    const tunnels = new Tunnels(factory);
    const id = tunnels.open('ws://vscode:8000/?reconnectionToken=x&tkn=t', { cookie: 'vscode-tkn=t' });
    expect(sockets[0]!.url).toBe('ws://vscode:8000/?reconnectionToken=x&tkn=t');
    sockets[0]!.fire('open');
    sockets[0]!.fire('message', { data: new Uint8Array([1, 2, 3]).buffer });
    sockets[0]!.fire('message', { data: new Uint8Array([4]).buffer });
    expect(await tunnels.receive(id, 10)).toEqual({ events: [{ type: 'open' }, { type: 'data', data: 'AQID' }, { type: 'data', data: 'BA==' }], closed: null });
    tunnels.send(id, ['BQY=', 'Bw==']);
    expect(sockets[0]!.sent.map((buffer) => [...buffer])).toEqual([[5, 6], [7]]);
    sockets[0]!.fire('close', { code: 1000, reason: 'bye', wasClean: true });
    expect(await tunnels.receive(id, 10)).toEqual({ events: [], closed: { code: 1000, reason: 'bye', wasClean: true } });
    expect(tunnels.has(id)).toBe(false);
    tunnels.dispose();
  });

  test('a poll waits for data and wakes when it comes', async () => {
    const { sockets, factory } = fakeSockets();
    const tunnels = new Tunnels(factory);
    const id = tunnels.open('ws://x/', {});
    const poll = tunnels.receive(id, 5000);
    setTimeout(() => sockets[0]!.fire('message', { data: new Uint8Array([9]).buffer }), 20);
    const started = Date.now();
    expect((await poll).events).toEqual([{ type: 'data', data: 'CQ==' }]);
    expect(Date.now() - started).toBeLessThan(1000);
    tunnels.dispose();
  });

  test('a tunnel nobody polls is closed', () => {
    const { sockets, factory } = fakeSockets();
    let now = 0;
    const tunnels = new Tunnels(factory, () => now);
    const id = tunnels.open('ws://x/', {});
    now = 60_000;
    tunnels.sweep();
    expect(tunnels.has(id)).toBe(false);
    expect(sockets[0]!.closed).toBe(true);
    tunnels.dispose();
  });

  test('a closed tunnel whose socket never closes still counts as an open connection', () => {
    const { sockets, factory } = fakeSockets();
    const tunnels = new Tunnels(factory);
    const id = tunnels.open('ws://x/', {});
    tunnels.close(id);
    expect([tunnels.size(), tunnels.sockets()]).toEqual([0, 1]);
    sockets[0]!.fire('close', { code: 1006 });
    expect(tunnels.sockets()).toBe(0);
    tunnels.dispose();
  });
});

describe('the connection to the VS Code Server', () => {
  test('is a raw upgrade asking for skipWebSocketFrames=true, carries the bytes unframed, and closing ends it', async () => {
    const server = await vscodeServer();
    const tunnels = new Tunnels();
    const id = tunnels.open(`ws://127.0.0.1:${server.port}/?reconnectionToken=r1&reconnection=false&skipWebSocketFrames=false&tkn=t`, { cookie: 'vscode-tkn=t' });
    expect((await tunnels.receive(id, 2000)).events).toEqual([{ type: 'open' }]);
    const upgrade = server.upgrades[0]!;
    expect(upgrade.requestLine).toBe('GET /?reconnectionToken=r1&reconnection=false&skipWebSocketFrames=true&tkn=t HTTP/1.1');
    expect(upgrade.headers).toMatchObject({ upgrade: 'websocket', connection: 'Upgrade', cookie: 'vscode-tkn=t', host: `127.0.0.1:${server.port}` });
    expect(upgrade.headers['sec-websocket-key']).toMatch(/^[A-Za-z0-9+/]{22}==$/);

    tunnels.send(id, ['AQID', 'BA==']);
    const echoed: string[] = [];
    while (Buffer.concat(echoed.map((data) => Buffer.from(data, 'base64'))).length < 4) {
      for (const event of (await tunnels.receive(id, 2000)).events) if (event.type === 'data') echoed.push(event.data);
    }
    expect([...Buffer.concat(server.connections[0]!.received)]).toEqual([1, 2, 3, 4]);
    expect([...Buffer.concat(echoed.map((data) => Buffer.from(data, 'base64')))]).toEqual([1, 2, 3, 4]);

    expect(tunnels.sockets()).toBe(1);
    tunnels.close(id);
    expect(await within(server.connections[0]!.closed, 2000)).not.toBe('timeout');
    expect([tunnels.size(), tunnels.sockets()]).toEqual([0, 0]);
    tunnels.dispose();
    await server.stop();
  });

  test("an abandoned tunnel's connection is ended by the sweep", async () => {
    const server = await vscodeServer();
    let now = 0;
    const tunnels = new Tunnels(undefined, () => now);
    const id = tunnels.open(`ws://127.0.0.1:${server.port}/?reconnectionToken=r2`, { cookie: 'vscode-tkn=t' });
    expect((await tunnels.receive(id, 2000)).events).toEqual([{ type: 'open' }]);
    now = 60_000;
    tunnels.sweep();
    expect(await within(server.connections[0]!.closed, 2000)).not.toBe('timeout');
    expect(tunnels.sockets()).toBe(0);
    tunnels.dispose();
    await server.stop();
  });

  test("the server's end reaches the frame as a close", async () => {
    const server = await vscodeServer();
    const tunnels = new Tunnels();
    const id = tunnels.open(`ws://127.0.0.1:${server.port}/?reconnectionToken=r3`, { cookie: 'vscode-tkn=t' });
    expect((await tunnels.receive(id, 2000)).events).toEqual([{ type: 'open' }]);
    server.connections[0]!.socket.end();
    expect(await tunnels.receive(id, 2000)).toEqual({ events: [], closed: { code: 1006, reason: '', wasClean: false } });
    expect([tunnels.has(id), tunnels.sockets()]).toEqual([false, 0]);
    tunnels.dispose();
    await server.stop();
  });

  test('a refused upgrade, or no server, is an error and a close', async () => {
    // Everything a tunnel reports until it closes.
    const untilClosed = async (tunnels: Tunnels, id: string) => {
      const events: unknown[] = [];
      for (let poll = 0; poll < 5; poll += 1) {
        const answer = await tunnels.receive(id, 1000);
        events.push(...answer.events);
        if (answer.closed) return { events, closed: answer.closed };
      }
      return { events, closed: null };
    };
    const server = await vscodeServer();
    const tunnels = new Tunnels();
    const refused = await untilClosed(tunnels, tunnels.open(`ws://127.0.0.1:${server.port}/?reconnectionToken=r4`, { cookie: 'vscode-tkn=wrong' }));
    expect(refused.events).toEqual([{ type: 'error', message: 'The VS Code Server refused the connection (HTTP 403).' }]);
    expect(refused.closed?.code).toBe(1006);
    await server.stop();
    const none = await untilClosed(tunnels, tunnels.open(`ws://127.0.0.1:${server.port}/`, {}));
    expect(none.events.map((event) => (event as { type: string }).type)).toEqual(['error']);
    expect(none.closed?.code).toBe(1006);
    expect(tunnels.sockets()).toBe(0);
    tunnels.dispose();
  });
});

describe('the frame side', () => {
  test('sends in request-sized batches; a long message goes as consecutive pieces', () => {
    const long = 'A'.repeat(100_000);
    const batches = sendBatches(['QQ==', long, 'Qg==']);
    expect(batches.flat().join('')).toBe(`QQ==${long}Qg==`);
    for (const batch of batches) expect(batch.join('').length).toBeLessThanOrEqual(45_000);
    // Pieces keep base64's 4-character groups, so each decodes on its own.
    for (const piece of batches.flat()) expect(piece.length % 4).toBe(0);
  });

  test("is VS Code's IWebSocket over the service: open, data, send, close", async () => {
    const received: unknown[] = [];
    const sent: string[][] = [];
    let polls = 0;
    const service: TunnelService = {
      open: async (path) => {
        received.push(path);
        return 't1';
      },
      send: async (_id, chunks) => {
        sent.push(chunks);
        return {};
      },
      receive: async () => {
        polls += 1;
        if (polls === 1) return { events: [{ type: 'open' }, { type: 'data', data: 'AQID' }], closed: null };
        return { events: [], closed: { code: 1000, reason: 'done', wasClean: true } };
      },
      close: async () => {},
    };
    const socket = new TunnelSocket('ws://vscode:8000/?reconnectionToken=abc&skipWebSocketFrames=false', service);
    const events: string[] = [];
    socket.onOpen(() => events.push('open'));
    socket.onData((data) => events.push(`data ${[...new Uint8Array(data)].join(',')}`));
    const closed = new Promise((resolve) => socket.onClose((event) => resolve(event)));
    socket.send(new Uint8Array([4, 5]));
    expect(await closed).toEqual({ code: 1000, reason: 'done', wasClean: true, event: undefined });
    expect(received).toEqual(['/?reconnectionToken=abc&skipWebSocketFrames=false']);
    expect(events).toEqual(['open', 'data 1,2,3']);
    expect(sent).toEqual([['BAU=']]);
  });

  test('a service that fails ends the socket with an error and a close', async () => {
    const service: TunnelService = {
      open: async () => {
        throw new Error('no service');
      },
      send: async () => ({}),
      receive: async () => ({ events: [], closed: null }),
      close: async () => {},
    };
    const socket = new TunnelSocket('ws://x/', service);
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));
    const closed = await new Promise<{ code: number } | undefined>((resolve) => socket.onClose((event) => resolve(event)));
    expect(closed?.code).toBe(1006);
    expect(errors.length).toBe(1);
  });
});
