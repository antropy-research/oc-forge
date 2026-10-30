// The layout each part of VS Code keeps (`surfaces.ts`, applyRoleLayout). VS Code shows parts again by itself: a
// terminal reveals the panel, an editor that opens shows the editor area, Ctrl+B or Ctrl+Shift+E shows the side bar.
// The part lays itself out again after that, never in the same task: VS Code may answer a part hidden by showing it
// again at once (un-maximizing the panel shows the editor area; a terminal's reveal shows its panel once more after
// a timeout), and a re-layout queued as a microtask then never lets the frame paint, answer or collect garbage. A
// terminal made in a rail view froze all of OpenChamber that way, its renderer growing by gigabytes (pre-review row
// 1). On a timer instead; and when VS Code keeps showing parts again (more than `limit` re-layouts within
// `windowMs`), the part stops fighting it for a while, longer each time, and says so in the console: a part showing
// what it shouldn't for a moment is better than a frozen window.
import type { Disposable, Event } from './vscode.ts';

export interface LayoutGuardOptions {
  /** Lays the part out; what it changed (a part VS Code had shown, hidden again), empty when the layout held. */
  apply: () => readonly string[];
  /** What may change the layout. */
  events: readonly Event<unknown>[];
  /** Re-layouts that changed something, within `windowMs`, before the part stops for a while. */
  limit?: number;
  windowMs?: number;
  /** The first pause; each pause in a row doubles it, up to `maxPauseMs`. */
  pauseMs?: number;
  maxPauseMs?: number;
  /** For tests: the clock, the timer and the console. */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  log?: (message: string) => void;
}

export interface LayoutGuard extends Disposable {
  /** Lays the part out in a task of its own, soon. */
  queue(): void;
  /** How many times the part stopped fighting VS Code. */
  readonly pauses: number;
}

export const LAYOUT_LIMIT = 8;
export const LAYOUT_WINDOW_MS = 1_000;
export const LAYOUT_PAUSE_MS = 1_000;
export const LAYOUT_MAX_PAUSE_MS = 30_000;

export const guardLayout = (options: LayoutGuardOptions): LayoutGuard => {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const log = options.log ?? ((message: string) => console.warn(`[OpenChamber VS Code] ${message}`));
  const limit = options.limit ?? LAYOUT_LIMIT;
  const windowMs = options.windowMs ?? LAYOUT_WINDOW_MS;
  const firstPause = options.pauseMs ?? LAYOUT_PAUSE_MS;
  const maxPause = options.maxPauseMs ?? LAYOUT_MAX_PAUSE_MS;
  let queued = false;
  let disposed = false;
  let pause = firstPause;
  let pauses = 0;
  /** When the recent re-layouts that changed something ran, and what they changed. */
  let recent: { at: number; changed: readonly string[] }[] = [];
  /** Only the timer set last runs: a pause outlasts a re-layout queued by the very change that started it. */
  let generation = 0;
  const schedule = (ms: number): void => {
    const mine = ++generation;
    setTimer(() => {
      if (mine === generation) run();
    }, ms);
  };

  const run = (): void => {
    queued = false;
    if (disposed) return;
    let changed: readonly string[] = [];
    try {
      changed = options.apply();
    } catch (error) {
      log(`could not keep the layout: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (changed.length === 0) {
      // The layout held: VS Code isn't fighting it (any more).
      pause = firstPause;
      return;
    }
    const at = now();
    recent = [...recent.filter((item) => at - item.at <= windowMs), { at, changed }];
    if (recent.length <= limit) return;
    const counts = new Map<string, number>();
    for (const item of recent) for (const change of item.changed) counts.set(change, (counts.get(change) ?? 0) + 1);
    const what = [...counts].sort((a, b) => b[1] - a[1]).map(([change, count]) => `${change} ×${count}`).join(', ');
    log(`VS Code changed this part's layout back ${recent.length} times within ${windowMs} ms (${what}): it is left as VS Code has it for ${pause} ms`);
    pauses += 1;
    recent = [];
    // Nothing queues meanwhile; then once more, which pauses longer if VS Code still fights.
    queued = true;
    const wait = pause;
    pause = Math.min(pause * 2, maxPause);
    schedule(wait);
  };

  const queue = (): void => {
    if (queued || disposed) return;
    queued = true;
    schedule(0);
  };

  const subscriptions = options.events.map((event) => event(() => queue()));
  return {
    queue,
    get pauses() {
      return pauses;
    },
    dispose: () => {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
};
