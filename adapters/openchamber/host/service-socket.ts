// Guest service requests over one WebSocket per window instead of an HTTP
// request each: over plain HTTP/1.1 a browser shares six connections per host
// among a site's tabs, and extensions that long-poll their service (VS Code's
// tunnels) held them all with two windows open (server/service-socket.js).
//
// A request that could not be sent (no socket yet, a server without the route)
// is left to the caller, which sends it over fetch as before. A request that
// was sent and lost its answer fails, as a fetch cut off does: sending it again
// could repeat a write (a tunnel's batch of bytes).

/** What this needs of a WebSocket (a browser's, or a test's). */
export type OcForgeSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
};

/** The route's answer: its status and body text, as a fetch would have read them. */
export type OcForgeServiceAnswer = { status: number; text: string };

const OPEN = 1;
/** How long a request waits for the socket to open before it goes over fetch instead. */
const OPEN_WAIT_MS = 5_000;
/** After a socket that would not open (a server without the route), fetch alone for this long. */
const RETRY_AFTER_MS = 30_000;
/** No answer for this long is a lost one; the server answers or fails each request well before. */
const ANSWER_WAIT_MS = 180_000;
const LOST: OcForgeServiceAnswer = { status: 502, text: 'null' };
const ANSWER = /^(\d{1,15}) (\d{3})\n/;
/** The ids the server takes (an extension id); others go over fetch, which answers for them. */
const GUEST_ID = /^[a-z][a-z0-9-]*$/;

export const createOcForgeServiceSocket = (open: () => OcForgeSocketLike | null, now: () => number = Date.now) => {
  let socket: OcForgeSocketLike | null = null;
  let opening: Promise<OcForgeSocketLike | null> | null = null;
  let unusableUntil = 0;
  let next = 1;
  const pending = new Map<string, (answer: OcForgeServiceAnswer) => void>();

  const lose = (from: OcForgeSocketLike) => {
    if (socket !== from) return;
    socket = null;
    for (const settle of pending.values()) settle(LOST);
    pending.clear();
  };

  const connect = (): Promise<OcForgeSocketLike | null> => {
    if (socket && socket.readyState === OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    if (now() < unusableUntil) return Promise.resolve(null);
    let candidate: OcForgeSocketLike | null = null;
    try {
      candidate = open();
    } catch {
      candidate = null;
    }
    if (!candidate) return Promise.resolve(null);
    const opened = candidate;
    opening = new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opening = null;
        if (ok) {
          socket = opened;
          resolve(opened);
          return;
        }
        unusableUntil = now() + RETRY_AFTER_MS;
        try {
          opened.close();
        } catch {
          // Never opened.
        }
        resolve(null);
      };
      const timer = setTimeout(() => finish(false), OPEN_WAIT_MS);
      opened.addEventListener('open', () => finish(true));
      opened.addEventListener('error', () => {
        if (!settled) finish(false);
      });
      opened.addEventListener('close', () => {
        if (!settled) finish(false);
        else lose(opened);
      });
      opened.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const header = ANSWER.exec(event.data);
        if (!header) return;
        const settle = pending.get(header[1]);
        if (!settle) return;
        pending.delete(header[1]);
        settle({ status: Number(header[2]), text: event.data.slice(header[0].length) });
      });
    });
    return opening;
  };

  return {
    /**
     * Sends one service request (the JSON body the HTTP route takes). Null: it
     * was not sent, so send it over fetch. Otherwise the route's answer, or a
     * 502 with no body when the answer was lost.
     */
    async request(guestId: string, body: unknown): Promise<OcForgeServiceAnswer | null> {
      if (!GUEST_ID.test(guestId)) return null;
      const ready = await connect();
      if (!ready || ready.readyState !== OPEN) return null;
      const id = String(next++);
      const json = JSON.stringify(body);
      return new Promise<OcForgeServiceAnswer | null>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(LOST);
        }, ANSWER_WAIT_MS);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        try {
          ready.send(`${id} ${guestId}\n${json}`);
        } catch {
          // Refused before it left (a socket still connecting): not sent, so fetch sends it.
          pending.delete(id);
          clearTimeout(timer);
          resolve(null);
        }
      });
    },
  };
};
