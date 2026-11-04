// The keyboard focus in OpenChamber's own surfaces (`workbench/surfaces.ts`): a VS Code frame takes it only for the
// user. VS Code focuses a part as it starts (Layout.restoreParts), and the surfaces focus what they show: the view
// container a rail entry names, the editor a header tab names, the terminal. Frames start and reload while the user is
// elsewhere in OpenChamber: after "Open in VS Code" the rail view, the page and the terminal reload on the new folder,
// and a folder's rail panel starts when one of its chats shows. A focus call there moved the focus out of OpenChamber,
// which closed the menu the user had open and sent their keys to VS Code. So a focus call takes effect only while the
// frame has the focus already, or for a moment after the user acted on it: a click, a touch, a key or a drop in it, or
// OpenChamber telling it the user chose something it shows (`allow`). That moment ends early when the frame loses the
// focus: the user went elsewhere. OpenChamber gives its own guest popovers the focus on the same terms (its SDK refuses
// one without keyboard interaction with its owner). A webview (Markdown's preview, an extension's page or view) is
// focused another way, through its frame's window, and goes through the same rule (`guardWebviews`).

/**
 * How long the user's action lets the frame take the focus. What the user asked for (a view container, an editor,
 * VS Code's save prompt, a quick pick) opens well within it; a frame that starts or reloads on its own does not.
 */
export const FOCUS_INTENT_MS = 2_000;

/** The user acting on the frame itself. */
const USER_INPUT = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'drop'] as const;

interface Focusable {
  focus(options?: unknown): void;
}

/** What the guard uses of a frame's window (a stand-in in the tests). */
export interface FocusWindow {
  readonly document: { hasFocus(): boolean };
  readonly HTMLElement: { readonly prototype: Focusable };
  readonly SVGElement?: { readonly prototype: Focusable };
  readonly HTMLIFrameElement?: { readonly prototype: object };
  focus(): void;
  addEventListener(type: string, listener: (event: { readonly isTrusted: boolean }) => void, options: { capture: boolean; passive: boolean }): void;
}

export interface FocusGuard {
  /** The user chose something this frame shows, in OpenChamber (a rail entry, a header tab, a link): it may take the focus for a moment. */
  allow(): void;
  /** Whether a focus call takes effect now. */
  allowed(): boolean;
  /** A function that focuses something another way (a webview's frame), on the same terms. */
  wrap<T extends (...args: never[]) => void>(focus: T): T;
}

/**
 * Guards a frame's focus calls (`element.focus()`, `window.focus()`). Installed before VS Code runs, so VS Code's own
 * wrapper of `HTMLElement.prototype.focus` (for its auxiliary windows) calls this one. `kept` hears of each call that
 * did nothing.
 */
export const guardFocus = (target: FocusWindow, options: { now?: () => number; kept?: () => void } = {}): FocusGuard => {
  const now = options.now ?? (() => performance.now());
  let until = Number.NEGATIVE_INFINITY;
  const allowed = (): boolean => target.document.hasFocus() || now() < until;
  const allow = (): void => {
    until = now() + FOCUS_INTENT_MS;
  };
  // Before the frame's own listeners (capture, on the window): VS Code focuses what a click lands on as it handles it.
  for (const type of USER_INPUT) {
    target.addEventListener(type, (event) => {
      if (event.isTrusted) allow();
    }, { capture: true, passive: true });
  }
  // The window's own blur (an element's doesn't bubble): the user went elsewhere, and what they did here is over.
  target.addEventListener('blur', () => {
    until = Number.NEGATIVE_INFINITY;
  }, { capture: false, passive: true });
  const guarded = (focus: (this: unknown, ...args: unknown[]) => void) => function (this: unknown, ...args: unknown[]): void {
    if (allowed()) focus.apply(this, args);
    else options.kept?.();
  };
  for (const prototype of [target.HTMLElement.prototype, target.SVGElement?.prototype]) {
    if (prototype) prototype.focus = guarded(prototype.focus);
  }
  target.focus = guarded(target.focus);
  // An iframe given a focus() of its own shadows the guarded one: VS Code gives each webview's frame one, which focuses
  // the frame's window. What an iframe is given goes through the guard too; one given none keeps the guarded one.
  const frames = target.HTMLIFrameElement?.prototype;
  if (frames) {
    Object.defineProperty(frames, 'focus', {
      configurable: true,
      get: () => (Object.getPrototypeOf(frames) as Focusable).focus,
      set(this: object, focus: unknown) {
        const value = typeof focus === 'function' ? guarded(focus as (this: unknown, ...args: unknown[]) => void) : focus;
        Object.defineProperty(this, 'focus', { configurable: true, enumerable: true, writable: true, value });
      },
    });
  }
  return { allow, allowed, wrap: <T extends (...args: never[]) => void>(focus: T) => guarded(focus as unknown as (this: unknown, ...args: unknown[]) => void) as unknown as T };
};

/** What the guard uses of VS Code's webview service: it makes every webview, those an editor or a view shows too. */
export interface WebviewMaker {
  createWebviewElement(...args: unknown[]): { focus(): void };
}

/**
 * A webview takes the focus only on the guard's terms. VS Code focuses one with `iframe.contentWindow.focus()` on the
 * webview's frame (WebviewElement._doFocus), a cross-origin call no `element.focus()` guard sees, and then posts it a
 * `focus` that moves the focus into its content: a Markdown preview restored as the page's active editor took the focus
 * as the page started behind a chat, and closed the menu open in OpenChamber. Each webview's focus() goes through the
 * guard (`IWebviewService.createWebviewElement`, the same in 1.140 to 1.144).
 *
 * The service is a delayed one: what VS Code hands out is a proxy that keeps the first function read through it and
 * answers every later read with that. So the original comes from the class (the proxy answers `getPrototypeOf` with
 * it), and the guarded one goes to the service itself through the proxy, before anything reads it.
 */
export const guardWebviews = (webviews: WebviewMaker, guard: FocusGuard): void => {
  const create = (Object.getPrototypeOf(webviews) as Partial<WebviewMaker> | null)?.createWebviewElement;
  if (typeof create !== 'function') throw new Error('VS Code\'s webview service makes no webviews (createWebviewElement)');
  webviews.createWebviewElement = function (this: WebviewMaker, ...args: unknown[]) {
    const webview = create.apply(this, args);
    webview.focus = guard.wrap(webview.focus.bind(webview));
    return webview;
  };
};
