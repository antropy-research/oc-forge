import { describe, expect, test } from 'bun:test';
import { guardLayout } from '../workbench/layoutGuard.ts';
import type { Disposable, Event } from '../workbench/vscode.ts';

/** A clock and a timer queue the test runs by hand, and an event the test fires. */
const harness = () => {
  let time = 0;
  const timers: { at: number; run: () => void }[] = [];
  const listeners = new Set<(value: unknown) => void>();
  const event: Event<unknown> = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) } satisfies Disposable;
  };
  const fire = () => {
    for (const listener of [...listeners]) listener(undefined);
  };
  /** Runs the timers due within `ms`, in order, as the browser would (each in a task of its own). */
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      time = next.at;
      next.run();
    }
    time = end;
  };
  const logs: string[] = [];
  return {
    event,
    fire,
    advance,
    logs,
    pending: () => timers.length,
    listeners: () => listeners.size,
    options: { now: () => time, setTimer: (run: () => void, ms: number) => timers.push({ at: time + ms, run }), log: (message: string) => logs.push(message) },
  };
};

describe('guardLayout', () => {
  test('lays the part out in a task of its own, once for many changes', () => {
    const h = harness();
    let applied = 0;
    guardLayout({ ...h.options, events: [h.event], apply: () => (applied++, []) });
    h.fire();
    h.fire();
    h.fire();
    // Not in the same task: nothing ran yet, one timer waits.
    expect(applied).toBe(0);
    expect(h.pending()).toBe(1);
    h.advance(0);
    expect(applied).toBe(1);
    expect(h.pending()).toBe(0);
  });

  test('VS Code showing a part again at once is a fight it stops for a while, longer each time, and logs (the frozen rail)', () => {
    const h = harness();
    let applied = 0;
    // The b7dfa40 freeze: each re-layout hides the panel, and VS Code shows it again from that very change.
    guardLayout({
      ...h.options,
      events: [h.event],
      limit: 8,
      windowMs: 1_000,
      pauseMs: 1_000,
      apply: () => {
        applied++;
        h.fire();
        return ['panel hidden'];
      },
    });
    h.fire();
    // Each re-layout is a task of its own: 8 change the layout, the 9th within the window stops the fight.
    h.advance(0);
    expect(applied).toBe(9);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('panel hidden ×9');
    expect(h.logs[0]).toContain('for 1000 ms');
    // Paused: VS Code's changes queue nothing until the pause ends.
    h.fire();
    h.advance(999);
    expect(applied).toBe(9);
    // Then it tries again, and stops twice as long when VS Code still fights.
    h.advance(1);
    expect(applied).toBe(18);
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toContain('for 2000 ms');
    h.advance(2_000);
    expect(h.logs[2]).toContain('for 4000 ms');
  });

  test('a layout that holds ends the fight: the next pause is short again', () => {
    const h = harness();
    let fighting = true;
    guardLayout({
      ...h.options,
      events: [h.event],
      limit: 2,
      pauseMs: 100,
      apply: () => {
        if (!fighting) return [];
        h.fire();
        return ['sidebar hidden'];
      },
    });
    h.fire();
    h.advance(0);
    h.advance(100);
    expect(h.logs.map((line) => /for (\d+) ms/.exec(line)?.[1])).toEqual(['100', '200']);
    fighting = false;
    h.advance(200);
    fighting = true;
    h.fire();
    h.advance(0);
    expect(h.logs.map((line) => /for (\d+) ms/.exec(line)?.[1])).toEqual(['100', '200', '100']);
  });

  test('changes spread out over time are no fight', () => {
    const h = harness();
    let applied = 0;
    guardLayout({ ...h.options, events: [h.event], limit: 3, windowMs: 1_000, apply: () => (applied++, ['editor hidden']) });
    for (let index = 0; index < 20; index++) {
      h.fire();
      h.advance(400);
    }
    expect(applied).toBe(20);
    expect(h.logs).toEqual([]);
  });

  test('a layout that throws is logged, and the next change lays it out again', () => {
    const h = harness();
    let calls = 0;
    guardLayout({
      ...h.options,
      events: [h.event],
      apply: () => {
        calls++;
        if (calls === 1) throw new Error('no grid yet');
        return [];
      },
    });
    h.fire();
    h.advance(0);
    expect(h.logs).toEqual(['could not keep the layout: no grid yet']);
    h.fire();
    h.advance(0);
    expect(calls).toBe(2);
  });

  test('disposed, it listens to nothing and lays nothing out', () => {
    const h = harness();
    let applied = 0;
    const guard = guardLayout({ ...h.options, events: [h.event], apply: () => (applied++, []) });
    h.fire();
    guard.dispose();
    h.advance(0);
    h.fire();
    h.advance(0);
    expect(applied).toBe(0);
    expect(h.listeners()).toBe(0);
  });
});
