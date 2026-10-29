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

/**
 * A press in the Tasks view: on a focused task (its row's handler acts there), its edit form's title, a Tasks nav
 * button, or a row's menu, as the DOM answers `closest` for each.
 */
const inTasks = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }, where: 'task' | 'new-task' | 'nav' | 'menu' | 'adding') => {
  const tag = where === 'new-task' ? 'INPUT' : 'BUTTON';
  const ancestors: Record<string, boolean> = {
    '.tasks-app': true,
    'li[data-task]': where === 'task' || where === 'menu' || where === 'adding',
    '.gt-form, .menu, .modal': where === 'new-task' || where === 'menu',
  };
  const row = { dataset: { task: where === 'adding' ? 'new-0mvtx' : 'gt1' } };
  const target = { tagName: tag, isContentEditable: false, closest: (selector: string) => (ancestors[selector] ? (selector === 'li[data-task]' ? row : {}) : null) };
  return { ...press(key, mods), target } as unknown as KeyboardEvent;
};
const calendar = { surface: 'page', page: 'calendar', mac: false };
const calendarMac = { ...calendar, mac: true };

describe("Google Tasks' shortcuts in the Tasks view, and OpenChamber's history keys", () => {
  test('kept while a task has the focus, where its row acts on them: indent, move (to the top or bottom with Shift), a subtask', () => {
    for (const key of ['[', ']', 'ArrowUp', 'ArrowDown']) {
      expect(plannerKeeps(inTasks(key, { ctrl: true }, 'task'), calendar)).toBe(true);
      expect(plannerKeeps(inTasks(key, { meta: true }, 'task'), calendarMac)).toBe(true);
    }
    expect(plannerKeeps(inTasks('ArrowUp', { ctrl: true, shift: true }, 'task'), calendar)).toBe(true);
    expect(plannerKeeps(inTasks('Enter', { ctrl: true, alt: true }, 'task'), calendar)).toBe(true);
    // Ctrl+Enter alone does nothing on a task: OpenChamber's.
    expect(plannerKeeps(inTasks('Enter', { ctrl: true }, 'task'), calendar)).toBe(false);
  });

  test("forwarded from a Tasks nav button, the New task field, a row's menu and a task being added: there Ctrl/⌘+[ and ] are OpenChamber's history back and forward", () => {
    for (const where of ['nav', 'new-task', 'menu', 'adding'] as const) {
      expect(plannerKeeps(inTasks('[', { ctrl: true }, where), calendar)).toBe(false);
      expect(plannerKeeps(inTasks(']', { meta: true }, where), calendarMac)).toBe(false);
    }
    expect(plannerKeeps(inTasks('ArrowDown', { ctrl: true }, 'nav'), calendar)).toBe(false);
  });

  test('the shortcut list and Undo anywhere in the Tasks view; Ctrl/⌘+1 never kept', () => {
    for (const where of ['task', 'nav', 'new-task'] as const) {
      expect(plannerKeeps(inTasks('/', { ctrl: true }, where), calendar)).toBe(true);
      expect(plannerKeeps(inTasks('1', { ctrl: true }, where), calendar)).toBe(false);
      expect(plannerKeeps(inTasks('1', { meta: true }, where), calendarMac)).toBe(false);
    }
    expect(plannerKeeps(inTasks('z', { ctrl: true }, 'nav'), calendar)).toBe(true);
  });
});
