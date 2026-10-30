import { describe, expect, test } from 'bun:test';
import { FOCUS_INTENT_MS, guardFocus, guardWebviews, type FocusWindow } from '../src/focus.ts';

/** A frame's window as the guard sees it: elements that note what they focused, the frame's focus, a clock, input. */
const frame = () => {
  const focused: Array<{ name: string; options?: unknown }> = [];
  class FakeHTMLElement {
    constructor(readonly name: string) {}
    focus(this: FakeHTMLElement, options?: unknown): void {
      focused.push({ name: this.name, options });
    }
  }
  class FakeIFrameElement extends FakeHTMLElement {}
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
    HTMLIFrameElement: FakeIFrameElement,
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
  return { guard, target, focused, clock, state, input, element, svg: (name: string) => new FakeSVGElement(name), iframe: (name: string) => new FakeIFrameElement(name), kept: () => kept, names: () => focused.map((item) => item.name) };
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

  test("an iframe given a focus() of its own (VS Code gives each webview's frame one, which focuses its window) is guarded too", () => {
    const { iframe, focused, state, names, kept } = frame();
    const webview = iframe('webview');
    webview.focus = () => {
      focused.push({ name: "the webview's window" });
    };
    webview.focus();
    expect(names()).toEqual([]);
    expect(kept()).toBe(1);
    state.hasFocus = true;
    webview.focus();
    expect(names()).toEqual(["the webview's window"]);
    // One given none keeps the guarded focus() every element has.
    const plain = iframe('plain frame');
    state.hasFocus = false;
    plain.focus();
    state.hasFocus = true;
    plain.focus();
    expect(names()).toEqual(["the webview's window", 'plain frame']);
    expect(kept()).toBe(2);
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

/**
 * A delayed service as VS Code's instantiation service hands it out (instantiationService.ts): a proxy that keeps the
 * first function read through it, writes through to the service, and answers getPrototypeOf with the class's.
 */
const delayed = <T extends object>(ctor: new () => T): T => {
  let value: T | undefined;
  const service = (): Record<PropertyKey, unknown> => (value ??= new ctor()) as unknown as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      const prop = service()[key];
      if (typeof prop !== 'function') return prop;
      const bound = prop.bind(service());
      target[key] = bound;
      return bound;
    },
    set(_target, key, next) {
      service()[key] = next;
      return true;
    },
    getPrototypeOf: () => ctor.prototype,
  }) as unknown as T;
};

describe("a webview takes the focus on the same terms: VS Code focuses its frame's window, which no element guard sees", () => {
  test('each webview the webview service makes, though VS Code hands the service out as a proxy that keeps what is read', () => {
    const { guard, state, clock, kept } = frame();
    const shown: string[] = [];
    class WebviewService {
      made = 0;
      createWebviewElement(...args: unknown[]) {
        this.made += 1;
        const name = String(args[0]);
        return { focus: () => shown.push(name) };
      }
    }
    const service = delayed(WebviewService);
    guardWebviews(service, guard);
    // A Markdown preview restored as the page's active editor, which VS Code's start focuses behind a chat; made as
    // VS Code makes it, through the proxy.
    const preview = service.createWebviewElement('preview');
    expect(service.made).toBe(1);
    preview.focus();
    expect(shown).toEqual([]);
    expect(kept()).toBe(1);
    // Its header tab chosen: the page lets the frame take the focus as the editor opens.
    guard.allow();
    preview.focus();
    expect(shown).toEqual(['preview']);
    // Later, with the focus in the frame (the user clicked into it): a view's webview takes it too.
    clock.now += FOCUS_INTENT_MS;
    state.hasFocus = true;
    service.createWebviewElement('view').focus();
    expect(shown).toEqual(['preview', 'view']);
    expect(service.made).toBe(2);
  });

  test('a service that makes no webviews the way the guard knows is said, not passed over', () => {
    const { guard } = frame();
    expect(() => guardWebviews({} as never, guard)).toThrow(/createWebviewElement/);
  });
});
