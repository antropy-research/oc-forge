// The Debug Adapter Protocol between a real session (in the runtime) and its mirrors (in the page and the rail).

/** Events a mirror hears of the real session: DAP's own, but those that are its own workbench's (see mirror.ts). */
export const FORWARDED = new Set(['stopped', 'continued', 'exited', 'terminated', 'thread', 'module', 'loadedSource', 'process', 'capabilities', 'invalidated', 'memory']);

/** Requests that set a stopped thread running: the other mirrors hear it ran on (VS Code tells only the one that asked). */
export const RUNS = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto']);

export interface DapMessage {
  seq?: number;
  type: string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  /** A failed response's error. */
  message?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

const isAbsolute = (file: string): boolean => file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);

/**
 * A request's file as the main thread names a server's file. A mirror's requests reach the real session through the
 * runtime's main thread (`customRequest`), which reads a plain path as the browser's own (`vscode-local`): a file on
 * the server is `vscode-remote://<authority>/<path>` there.
 */
export const toMainThread = (args: Record<string, unknown> | undefined, authority: string | undefined): Record<string, unknown> | undefined => {
  const source = args?.source as { path?: unknown; sourceReference?: unknown } | undefined;
  if (!authority || !source || typeof source.path !== 'string' || !isAbsolute(source.path) || (typeof source.sourceReference === 'number' && source.sourceReference > 0)) return args;
  const file = source.path.replace(/\\/g, '/');
  const encoded = (file.startsWith('/') ? file : `/${file}`).split('/').map((part) => encodeURIComponent(part)).join('/');
  return { ...args, source: { ...source, path: `vscode-remote://${authority}${encoded}` } };
};

/** What the real adapter said of one breakpoint the runtime set (its line as set, one-based). */
export interface BreakpointState {
  line: number;
  column?: number;
  verified: boolean;
  /** Where the adapter put it, if elsewhere. */
  actualLine?: number;
  actualColumn?: number;
  message?: string;
}

/**
 * The runtime's view of each source's breakpoints in one real session, from the adapter's own messages (a tracker's):
 * `setBreakpoints`' answers and its `breakpoint` events.
 */
export class BreakpointTracker {
  private readonly pending = new Map<number, { path: string; lines: { line: number; column?: number }[] }>();
  private readonly byAdapterId = new Map<number, { path: string; index: number }>();
  private readonly states = new Map<string, BreakpointState[]>();

  /** A request VS Code sends the adapter. */
  request(message: DapMessage): void {
    if (message.type !== 'request' || message.command !== 'setBreakpoints' || typeof message.seq !== 'number') return;
    const args = message.arguments ?? {};
    const file = (args.source as { path?: string } | undefined)?.path;
    if (typeof file !== 'string') return;
    const lines = ((args.breakpoints as { line: number; column?: number }[] | undefined) ?? []).map((bp) => ({ line: bp.line, column: bp.column }));
    this.pending.set(message.seq, { path: file, lines });
  }

  /** A message from the adapter: the source whose breakpoints changed, or null. */
  message(message: DapMessage): string | null {
    if (message.type === 'response' && message.command === 'setBreakpoints' && typeof message.request_seq === 'number') {
      const asked = this.pending.get(message.request_seq);
      this.pending.delete(message.request_seq);
      if (!asked) return null;
      for (const [id, place] of this.byAdapterId) if (place.path === asked.path) this.byAdapterId.delete(id);
      const answered = message.success ? ((message.body?.breakpoints as Record<string, unknown>[] | undefined) ?? []) : [];
      const states = asked.lines.map((place, index): BreakpointState => {
        const bp = answered[index];
        if (typeof bp?.id === 'number') this.byAdapterId.set(bp.id, { path: asked.path, index });
        return stateOf(place, bp);
      });
      this.states.set(asked.path, states);
      return asked.path;
    }
    if (message.type === 'event' && message.event === 'breakpoint') {
      const bp = message.body?.breakpoint as Record<string, unknown> | undefined;
      const place = typeof bp?.id === 'number' ? this.byAdapterId.get(bp.id) : undefined;
      if (!bp || !place) return null;
      const states = this.states.get(place.path);
      const old = states?.[place.index];
      if (!states || !old) return null;
      if (message.body?.reason === 'removed') {
        states[place.index] = { ...old, verified: false, actualLine: undefined, actualColumn: undefined };
      } else {
        // A `changed` event carries what changed; the rest stays.
        states[place.index] = stateOf({ line: old.line, column: old.column }, { verified: old.verified, line: old.actualLine, column: old.actualColumn, message: old.message, ...bp });
      }
      return place.path;
    }
    return null;
  }

  statesOf(file: string): BreakpointState[] {
    return this.states.get(file) ?? [];
  }

  sources(): string[] {
    return [...this.states.keys()];
  }
}

const stateOf = (place: { line: number; column?: number }, bp: Record<string, unknown> | undefined): BreakpointState => {
  const line = typeof bp?.line === 'number' ? bp.line : undefined;
  const column = typeof bp?.column === 'number' ? bp.column : undefined;
  return {
    line: place.line,
    ...(place.column !== undefined ? { column: place.column } : {}),
    verified: bp?.verified === true,
    ...(line !== undefined && line !== place.line ? { actualLine: line } : {}),
    ...(column !== undefined && column !== place.column ? { actualColumn: column } : {}),
    ...(typeof bp?.message === 'string' ? { message: bp.message } : {}),
  };
};
