import { describe, expect, test } from 'bun:test';
import { Tunnels, type SocketFactory } from '../service/tunnel.ts';
import { sendBatches, TunnelSocket, type TunnelService } from '../workbench/tunnel.ts';

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
