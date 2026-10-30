// A debug adapter in the page or the rail that is the runtime's real session (`DebugAdapterInlineImplementation`):
// requests go to it (`customRequest` in the runtime), its events come back (the runtime's tracker). What is the
// mirror's own workbench's it answers itself: its breakpoints are the folder's (synced through the breakpoints API),
// so it sets none, and tells VS Code what the real adapter said of each; its console output is the bottom's Debug
// Console's; its progress the runtime's.
import type { BreakpointState, DapMessage } from './dap.ts';
import { Emitter } from './events.ts';

export interface MirrorLink {
  /** A request to the runtime that runs the real session. */
  request<T = unknown>(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  send(type: string, payload: Record<string, unknown>): void;
}

/** What VS Code was told of a breakpoint it set in this mirror. */
interface Told {
  id: number;
  line: number;
  column?: number;
  verified: boolean;
  shownLine: number;
  shownColumn?: number;
  message?: string;
}

const placeKey = (line: number, column?: number): string => `${line}:${column ?? ''}`;

export class Mirror {
  private seq = 1;
  ended = false;
  private configured = false;
  private nextBreakpointId = 1;
  /** Per source path: the breakpoints VS Code set here, by line and column. */
  private readonly told = new Map<string, Map<string, Told>>();
  private readonly emitter = new Emitter<DapMessage>();
  readonly onDidSendMessage = this.emitter.event;

  constructor(
    private readonly link: MirrorLink,
    readonly realId: string,
    /** What the real adapter said of a source's breakpoints, as the runtime last told. */
    private readonly statesOf: (path: string) => readonly BreakpointState[] | undefined = () => undefined,
  ) {}

  private emit(message: DapMessage): void {
    this.emitter.fire({ ...message, seq: this.seq++ });
  }

  private respond(request: DapMessage, body?: Record<string, unknown>, error?: string): void {
    this.emit(error
      ? { type: 'response', request_seq: request.seq, command: request.command, success: false, message: error, body: { error: { id: 1, format: error, showUser: false } } }
      : { type: 'response', request_seq: request.seq, command: request.command, success: true, body: body ?? {} });
  }

  /** An event of the real session. */
  event(event: string, body?: Record<string, unknown>): void {
    if (this.ended) return;
    if (event === 'terminated') this.ended = true;
    this.emit({ type: 'event', event, body });
  }

  /** The runtime's word on a source's breakpoints: what changed for VS Code goes to it as `breakpoint` events. */
  breakpointStates(path: string, states: readonly BreakpointState[]): void {
    const set = this.told.get(path);
    if (!set) return;
    for (const told of set.values()) {
      const state = states.find((item) => item.line === told.line && (item.column === undefined || told.column === undefined || item.column === told.column));
      if (!state) continue;
      const next = shown(told, state);
      if (next.verified === told.verified && next.shownLine === told.shownLine && next.shownColumn === told.shownColumn && next.message === told.message) continue;
      Object.assign(told, next);
      this.event('breakpoint', { reason: 'changed', breakpoint: wire(told) });
    }
  }

  async handleMessage(message: DapMessage): Promise<void> {
    if (message.type !== 'request') return;
    const args = message.arguments ?? {};
    try {
      switch (message.command) {
        case 'initialize': {
          const caps = await this.link.request<Record<string, unknown> | null>('dap.caps', { realId: this.realId });
          if (!caps) throw new Error('that debug session ended');
          this.respond(message, { ...caps, supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsRestartRequest: true });
          this.event('initialized');
          return;
        }
        case 'launch':
        case 'attach':
          this.respond(message, {});
          return;
        case 'setBreakpoints':
          this.respond(message, { breakpoints: this.setBreakpoints(args) });
          return;
        case 'setFunctionBreakpoints':
          this.respond(message, { breakpoints: ((args.breakpoints as unknown[] | undefined) ?? []).map(() => ({ verified: true })) });
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
          this.respond(message, await this.relay(message.command, args));
          return;
        case 'configurationDone': {
          this.configured = true;
          this.respond(message, {});
          // What the real session shows now: its paused threads, as if it had just stopped.
          const state = await this.link.request<{ stopped: Record<string, unknown>[] }>('dap.state', { realId: this.realId }).catch(() => ({ stopped: [] }));
          for (const body of state.stopped) this.event('stopped', body);
          return;
        }
        case 'restart':
          // VS Code's own restart, in the runtime (its tasks, the adapter's restart or a new launch).
          await this.link.request('session.restart', { realId: this.realId }, 60_000);
          this.respond(message, {});
          return;
        case 'terminate':
          // The user's Stop: the real session stops, and its end (`terminated`, which VS Code waits for) ends this one.
          if (!this.ended) this.link.send('session.stop', { realId: this.realId });
          this.respond(message, {});
          return;
        case 'disconnect': {
          // VS Code is done with this adapter. A window that closes or reloads disconnects its sessions with no
          // arguments: the real one goes on. The user's Disconnect (or Stop, for an adapter that can't terminate) stops it.
          const closing = args.terminateDebuggee === undefined && args.restart === undefined && args.suspendDebuggee === undefined;
          if (!this.ended && !closing) this.link.send('session.stop', { realId: this.realId });
          this.ended = true;
          this.respond(message, {});
          return;
        }
        default:
          this.respond(message, await this.relay(message.command ?? '', args));
      }
    } catch (error) {
      this.respond(message, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private relay(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.link.request<Record<string, unknown>>('dap.request', { realId: this.realId, command, args });
  }

  /** VS Code sets a source's breakpoints: each keeps its id; what the real adapter said of it, as far as known. */
  private setBreakpoints(args: Record<string, unknown>): Record<string, unknown>[] {
    const source = args.source as { path?: string } | undefined;
    const file = typeof source?.path === 'string' ? source.path : '';
    const asked: { line: number; column?: number }[] = (args.breakpoints as { line: number; column?: number }[] | undefined) ?? (args.lines as number[] | undefined)?.map((line) => ({ line })) ?? [];
    const old = this.told.get(file) ?? new Map<string, Told>();
    const next = new Map<string, Told>();
    const states = this.statesOf(file) ?? [];
    for (const bp of asked) {
      const key = placeKey(bp.line, bp.column);
      const told: Told = old.get(key) ?? { id: this.nextBreakpointId++, line: bp.line, column: bp.column, verified: false, shownLine: bp.line, shownColumn: bp.column };
      const state = states.find((item) => item.line === bp.line && (item.column === undefined || bp.column === undefined || item.column === bp.column));
      Object.assign(told, state ? shown(told, state) : { verified: told.verified, shownLine: told.shownLine });
      next.set(key, told);
    }
    this.told.set(file, next);
    return [...next.values()].map(wire);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

const shown = (told: Told, state: BreakpointState): Pick<Told, 'verified' | 'shownLine' | 'shownColumn' | 'message'> => ({
  verified: state.verified,
  shownLine: state.actualLine ?? told.line,
  shownColumn: state.actualColumn ?? told.column,
  message: state.message,
});

const wire = (told: Told): Record<string, unknown> => ({
  id: told.id,
  verified: told.verified,
  line: told.shownLine,
  ...(told.shownColumn !== undefined ? { column: told.shownColumn } : {}),
  ...(told.message !== undefined ? { message: told.message } : {}),
});
