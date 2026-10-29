import { describe, expect, test } from 'bun:test';
import { plannerKeeps } from '../panel/lib/forge.ts';

// A key press as plannerKeeps reads it: the key, its modifiers and where focus is.
const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, target: 'input' | 'textarea' | 'notes' | 'page' = 'page') =>
  ({
    key,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
    target: target === 'page' ? { tagName: 'DIV', isContentEditable: false } : target === 'notes' ? { tagName: 'DIV', isContentEditable: true } : { tagName: target.toUpperCase(), isContentEditable: false },
  }) as unknown as KeyboardEvent;
const linux = { surface: 'page', page: 'today', mac: false };
const mac = { surface: 'page', page: 'today', mac: true };

describe('the keys the Planner keeps from OpenChamber', () => {
  test("from a field, OpenChamber's navigation keys go to OpenChamber, not to Chrome", () => {
    expect(plannerKeeps(press('1', { ctrl: true }, 'input'), linux)).toBe(false);
    expect(plannerKeeps(press('1', { meta: true }, 'input'), mac)).toBe(false);
    expect(plannerKeeps(press('ArrowLeft', { ctrl: true, alt: true }, 'textarea'), linux)).toBe(false);
    expect(plannerKeeps(press('ArrowRight', { meta: true, alt: true }, 'textarea'), mac)).toBe(false);
    expect(plannerKeeps(press('[', { ctrl: true }, 'input'), linux)).toBe(false);
    // The command palette rather than Chrome's Print; Alt+W closes the tab where it types nothing.
    expect(plannerKeeps(press('p', { ctrl: true }, 'input'), linux)).toBe(false);
    expect(plannerKeeps(press('p', { meta: true }, 'input'), mac)).toBe(false);
    expect(plannerKeeps(press('w', { alt: true }, 'input'), linux)).toBe(false);
    expect(plannerKeeps(press('1', { ctrl: true }, 'notes'), linux)).toBe(false);
  });

  test('a field keeps what editing uses: formatting, moves and deletes, and the keys that type on macOS', () => {
    expect(plannerKeeps(press('b', { ctrl: true }, 'notes'), linux)).toBe(true);
    expect(plannerKeeps(press('b', { meta: true }, 'notes'), mac)).toBe(true);
    expect(plannerKeeps(press('b', { ctrl: true }, 'input'), linux)).toBe(true);
    expect(plannerKeeps(press('ArrowLeft', { ctrl: true }, 'input'), linux)).toBe(true);
    expect(plannerKeeps(press('ArrowLeft', { alt: true }, 'input'), mac)).toBe(true);
    expect(plannerKeeps(press('Backspace', { meta: true }, 'textarea'), mac)).toBe(true);
    // Option+W types ∑; Control+P is the Cocoa "previous line", Control+B "back".
    expect(plannerKeeps(press('∑', { alt: true }, 'input'), mac)).toBe(true);
    expect(plannerKeeps(press('p', { ctrl: true }, 'textarea'), mac)).toBe(true);
    expect(plannerKeeps(press('b', { ctrl: true }, 'input'), mac)).toBe(true);
  });

  test("outside fields the Planner keeps its own palette and the Linear page's layout key", () => {
    expect(plannerKeeps(press('k', { ctrl: true }), linux)).toBe(true);
    expect(plannerKeeps(press('b', { ctrl: true }), { ...linux, page: 'linear' })).toBe(true);
    expect(plannerKeeps(press('b', { ctrl: true }), linux)).toBe(false);
    expect(plannerKeeps(press('1', { ctrl: true }), linux)).toBe(false);
    expect(plannerKeeps(press('k', { ctrl: true }), { ...linux, surface: 'panel' })).toBe(false);
  });
});
