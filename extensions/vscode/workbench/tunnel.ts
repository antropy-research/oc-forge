// VS Code's web socket (its IWebSocket) over the service: sends go out in
// order, in batches that fit the host's request size, and a long poll brings
// in what the VS Code Server sent.

type Listener<T> = (value: T) => void;
interface Disposable {
  dispose(): void;
}
/** VS Code's `Event<T>`: subscribe with a listener, get a disposable back. */
type Event<T> = (listener: Listener<T>, thisArgs?: unknown, disposables?: Disposable[] | { add(d: Disposable): void }) => Disposable;

const emitter = <T>(): { event: Event<T>; fire: (value: T) => void } => {
  const listeners = new Set<Listener<T>>();
  const event: Event<T> = (listener, thisArgs, disposables) => {
    const bound: Listener<T> = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.add(bound);
    const disposable = { dispose: () => void listeners.delete(bound) };
    if (Array.isArray(disposables)) disposables.push(disposable);
    else disposables?.add(disposable);
    return disposable;
  };
  return { event, fire: (value) => {
    for (const listener of [...listeners]) listener(value);
  } };
};

export interface TunnelService {
  open(path: string): Promise<string>;
  send(id: string, chunks: string[]): Promise<{ closed?: boolean }>;
  receive(id: string): Promise<{ events: ({ type: 'open' } | { type: 'data'; data: string } | { type: 'error'; message: string })[]; closed: { code: number; reason: string; wasClean: boolean } | null }>;
  close(id: string): Promise<void>;
}

/** Base64 per request: the host takes a body of 64,000 characters, JSON included. */
const SEND_CHARS = 45_000;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const toArrayBuffer = (text: string): ArrayBuffer => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

/** Split base64 messages into requests; a message longer than one request goes as consecutive pieces (base64 cut on 4-character bounds stays decodable piece by piece). */
export const sendBatches = (messages: string[]): string[][] => {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const message of messages) {
    const pieces: string[] = [];
    if (message.length <= SEND_CHARS) pieces.push(message);
    else for (let index = 0; index < message.length; index += SEND_CHARS) pieces.push(message.slice(index, index + SEND_CHARS));
    for (const piece of pieces) {
      if (batch.length > 0 && size + piece.length > SEND_CHARS) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(piece);
      size += piece.length;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

export class TunnelSocket {
  private readonly data = emitter<ArrayBuffer>();
  private readonly opened = emitter<void>();
  private readonly closedEvent = emitter<{ code: number; reason: string; wasClean: boolean; event: undefined } | undefined>();
  private readonly errors = emitter<unknown>();
  readonly onData = this.data.event;
  readonly onOpen = this.opened.event;
  readonly onClose = this.closedEvent.event;
  readonly onError = this.errors.event;
  private outbox: string[] = [];
  private sending = false;
  private done = false;
  private readonly id: Promise<string | null>;

  constructor(url: string, private readonly service: TunnelService) {
    const target = new URL(url);
    this.id = service.open(`${target.pathname}${target.search}`).then(
      (id) => {
        void this.poll(id);
        return id;
      },
      (error) => {
        this.fail(error);
        return null;
      },
    );
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.errors.fire(error);
    this.finish({ code: 1006, reason: String(error instanceof Error ? error.message : error), wasClean: false });
  }

  private finish(closed: { code: number; reason: string; wasClean: boolean }): void {
    if (this.done) return;
    this.done = true;
    this.closedEvent.fire({ ...closed, event: undefined });
  }

  private async poll(id: string): Promise<void> {
    while (!this.done) {
      let answer;
      try {
        answer = await this.service.receive(id);
      } catch (error) {
        this.fail(error);
        return;
      }
      for (const event of answer.events) {
        if (event.type === 'open') this.opened.fire();
        else if (event.type === 'data') this.data.fire(toArrayBuffer(event.data));
        else this.errors.fire(new Error(event.message));
      }
      if (answer.closed) {
        this.finish(answer.closed);
        return;
      }
    }
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.done) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.outbox.push(toBase64(bytes));
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const id = await this.id;
      if (!id) return;
      while (this.outbox.length > 0 && !this.done) {
        // VS Code's remote protocol frames its own messages inside the byte stream, so a long
        // message may go as several web socket messages, as long as the order holds.
        const messages = this.outbox.splice(0);
        for (const batch of sendBatches(messages)) {
          const answer = await this.service.send(id, batch);
          if (answer.closed) {
            this.finish({ code: 1006, reason: 'tunnel gone', wasClean: false });
            return;
          }
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.sending = false;
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    void this.id.then((id) => (id ? this.service.close(id) : undefined)).catch(() => {});
  }
}
