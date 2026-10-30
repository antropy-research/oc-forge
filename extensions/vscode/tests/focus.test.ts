import { describe, expect, test } from 'bun:test';
import { FOCUS_INTENT_MS, guardFocus, type FocusWindow } from '../src/focus.ts';

/** A frame's window as the guard sees it: elements that note what they focused, the frame's focus, a clock, input. */
const frame = () => {
  const focused: Array<{ name: string; options?: unknown }> = [];
  class FakeHTMLElement {
    constructor(readonly name: string) {}
    focus(this: FakeHTMLElement, options?: unknown): void {
      focused.push({ name: this.name, options });
    }
  }
  class FakeSVGElement {
    constructor(readonly name: string) {}
    focus(this: FakeSVGElement): void {
      focused.push({ name: this.name });
    }
  }
  const listeners = new Map<string, Array<(event: { isTrusted: boolean }) => void>>();
  const clock = { now: 1_000 };
  const state = { hasFocus: false };
  const target: FocusWindow = {
    document: { hasFocus: () => state.hasFocus },
    HTMLElement: FakeHTMLElement,
    SVGElement: FakeSVGElement,
    focus: () => focused.push({ name: 'window' }),
    addEventListener: (type, listener, options) => {
      // Input before the frame's own listeners; the window's own blur only (an element's doesn't bubble).
      expect(options).toEqual({ capture: type !== 'blur', passive: true });
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  let kept = 0;
  const guard = guardFocus(target, { now: () => clock.now, kept: () => kept++ });
  const input = (type: string, isTrusted = true) => {
    for (const listener of listeners.get(type) ?? []) listener({ isTrusted });
  };
  const element = (name: string) => new FakeHTMLElement(name);
  return { guard, target, focused, clock, state, input, element, svg: (name: string) => new FakeSVGElement(name), kept: () => kept, names: () => focused.map((item) => item.name) };
};

describe('a VS Code frame takes the keyboard focus only for the user', () => {
  test("one the user isn't in keeps its focus calls from moving the focus: VS Code's start, a reload, what a part shows by itself", () => {
    const { target, element, svg, names, kept } = frame();
    element('Editor Group 1 (empty)').focus();
    element('Files Explorer').focus({ preventScroll: true });
    svg('chart').focus();
    target.focus();
    expect(names()).toEqual([]);
    expect(kept()).toBe(4);
  });

  test('one that has the focus moves it as it likes, with its arguments', () => {
    const { element, state, focused } = frame();
    state.hasFocus = true;
    element('README.md').focus({ preventScroll: true });
    expect(focused).toEqual([{ name: 'README.md', options: { preventScroll: true } }]);
  });

  test('a click, a touch, a key or a drop in it lets it take the focus for a moment', () => {
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'drop']) {
      const { input, element, clock, names } = frame();
      input(type);
      element('now').focus();
      clock.now += FOCUS_INTENT_MS - 1;
      element('just in time').focus();
      clock.now += 1;
      element('too late').focus();
      expect(names()).toEqual(['now', 'just in time']);
    }
  });

  test('the moment ends when the frame loses the focus: the user went elsewhere, and a late focus call stays here', () => {
    const { input, element, state, clock, names } = frame();
    // A file opened from the Explorer: the page takes the focus, then the user clicks a chat tab in OpenChamber.
    input('pointerdown');
    state.hasFocus = true;
    element('README.md').focus();
    state.hasFocus = false;
    input('blur');
    clock.now += 200;
    element('README.md, again').focus();
    expect(names()).toEqual(['README.md']);
  });

  test("input a script made up is not the user's", () => {
    const { input, element, names } = frame();
    input('mousedown', false);
    input('keydown', false);
    element('Files Explorer').focus();
    expect(names()).toEqual([]);
  });

  test('OpenChamber telling it the user chose what it shows (a rail entry, a header tab, a link) does too', () => {
    const { guard, element, target, clock, names } = frame();
    expect(guard.allowed()).toBe(false);
    guard.allow();
    expect(guard.allowed()).toBe(true);
    element('README.md').focus();
    target.focus();
    clock.now += FOCUS_INTENT_MS;
    expect(guard.allowed()).toBe(false);
    element('later').focus();
    expect(names()).toEqual(['README.md', 'window']);
  });

  test("VS Code's own wrapper of focus(), installed once it runs, calls through the guard", () => {
    const { target, element, state, names } = frame();
    const guarded = target.HTMLElement.prototype.focus;
    const wrapped: string[] = [];
    // As VS Code's BaseWindow wraps it for its auxiliary windows.
    target.HTMLElement.prototype.focus = function (this: { name: string }, options?: unknown) {
      wrapped.push(this.name);
      guarded.call(this, options);
    };
    element('kept').focus();
    state.hasFocus = true;
    element('taken').focus();
    expect(wrapped).toEqual(['kept', 'taken']);
    expect(names()).toEqual(['taken']);
  });
});
