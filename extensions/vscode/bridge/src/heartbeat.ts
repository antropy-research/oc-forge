// Whether this part's window is there. A window that went (closed, reloaded) leaves its extension host on the server
// for VS Code's reconnection grace (hours by default), with the bridge in it: it asks its frame (`ping`, a command the
// frame answers) every `everyMs`; no answer within `timeoutMs` and the part is away; the answer, when it comes, and it
// is back. At most one question waits at a time: while the window is gone, VS Code queues each call for it until it
// reconnects, so a disconnected extension host holds one, not one per tick. While away it asks less and less often.
export interface HeartbeatOptions {
  ping: () => PromiseLike<unknown>;
  onAway: () => void;
  onBack: () => void;
  everyMs?: number;
  timeoutMs?: number;
  /** The longest wait between ticks while away. */
  maxAwayMs?: number;
  /** A question unanswered this long is dropped and asked again (VS Code may drop calls across a reconnection). */
  giveUpMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class Heartbeat {
  away = false;
  /** When the waiting question was asked, or null. */
  private asked: number | null = null;
  private wait: number;
  private timer: unknown = null;
  private stopped = false;
  /** Questions asked so far (for the checks). */
  pings = 0;

  constructor(private readonly options: HeartbeatOptions) {
    this.wait = options.everyMs ?? 2_000;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    this.schedule(this.options.everyMs ?? 2_000);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set = this.options.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
    this.timer = set(() => this.tick(), ms);
  }

  /** One tick: ask, or judge the question waiting. */
  tick(): void {
    if (this.stopped) return;
    const every = this.options.everyMs ?? 2_000;
    if (this.asked !== null) {
      const waited = this.now - this.asked;
      if (!this.away && waited > (this.options.timeoutMs ?? 3_000)) {
        this.away = true;
        this.options.onAway();
      }
      if (waited > (this.options.giveUpMs ?? 300_000)) this.asked = null;
      if (this.away) this.wait = Math.min(this.wait * 2, this.options.maxAwayMs ?? 60_000);
      this.schedule(this.away ? this.wait : every);
      return;
    }
    const asked = this.now;
    this.asked = asked;
    this.pings++;
    const answered = (): void => {
      if (this.asked !== asked) return;
      this.asked = null;
      if (this.away) {
        this.away = false;
        this.wait = every;
        this.options.onBack();
      }
    };
    // An error is an answer too: the window is there to give it.
    Promise.resolve(this.options.ping()).then(answered, answered);
    this.schedule(this.away ? this.wait : every);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer);
  }
}
