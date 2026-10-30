// The keyboard focus in OpenChamber's own surfaces (`workbench/surfaces.ts`): a VS Code frame takes it only for the
// user. VS Code focuses a part as it starts (Layout.restoreParts), and the surfaces focus what they show: the view
// container a rail entry names, the editor a header tab names, the terminal. Frames start and reload while the user is
// elsewhere in OpenChamber: after "Open in VS Code" the rail view, the page and the terminal reload on the new folder,
// and a folder's rail panel starts when one of its chats shows. A focus call there moved the focus out of OpenChamber,
// which closed the menu the user had open and sent their keys to VS Code. So a focus call takes effect only while the
// frame has the focus already, or for a moment after the user acted on it: a click, a touch, a key or a drop in it, or
// OpenChamber telling it the user chose something it shows (`allow`). That moment ends early when the frame loses the
// focus: the user went elsewhere. OpenChamber gives its own guest popovers the focus on the same terms (its SDK refuses
// one without keyboard interaction with its owner).

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
  focus(): void;
  addEventListener(type: string, listener: (event: { readonly isTrusted: boolean }) => void, options: { capture: boolean; passive: boolean }): void;
}

export interface FocusGuard {
  /** The user chose something this frame shows, in OpenChamber (a rail entry, a header tab, a link): it may take the focus for a moment. */
  allow(): void;
  /** Whether a focus call takes effect now. */
  allowed(): boolean;
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
  return { allow, allowed };
};
