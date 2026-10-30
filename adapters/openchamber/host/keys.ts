// R4: keys pressed in an extension frame never reach OpenChamber's window
// listeners. A frame forwards a press; the host replays it through those same
// listeners, but only for navigation actions and only right after the user
// pressed something.
import React from 'react';

import { isDesktopShell } from '@/lib/desktop';
import {
  eventMatchesShortcut,
  eventMatchesShortcutPrefix,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  normalizeCombo,
  parseShortcut,
  resolveShortcutEventDigit,
  SHORTCUT_SCHEMA,
  UNASSIGNED_SHORTCUT,
} from '@/lib/shortcuts';
import { isMacOS } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import {
  matchesCombo,
  OC_FORGE_DIGIT_ACTIONS,
  OC_FORGE_FORWARDABLE_ACTIONS,
  type OcForgeForwardableAction,
  type OcForgeKey,
  type OcForgeShortcuts,
} from './protocol.ts';

const DIGIT_ACTIONS: readonly string[] = OC_FORGE_DIGIT_ACTIONS;
const FORWARDABLE: readonly string[] = OC_FORGE_FORWARDABLE_ACTIONS;
const NO_HELD_KEYS: ReadonlySet<string> = new Set();

const overrides = () => useUIStore.getState().shortcutOverrides;

const bindingOf = (action: string): string => {
  const combo = DIGIT_ACTIONS.includes(action)
    ? getEffectiveShortcutPrefix(action, overrides())
    : getEffectiveShortcutCombo(action, overrides());
  const normalized = combo ? normalizeCombo(combo) : '';
  return normalized === UNASSIGNED_SHORTCUT ? '' : normalized;
};

/** `on` in this window's localStorage makes it count as an installed app window (headless Chromium has none: the end-to-end check sets it). */
export const OC_FORGE_APP_WINDOW_SWITCH = 'oc-forge:app-window';

/**
 * Whether OpenChamber runs as an installed app window. Chrome reserves none of
 * its tab keys there, and AGENTS.md asks for those keys (Ctrl+Tab,
 * Cmd+Option+←/→, Cmd+W) only there.
 */
export const isOcForgeAppWindow = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem(OC_FORGE_APP_WINDOW_SWITCH) === 'on') return true;
  } catch {
    // No storage: decided by the display mode alone.
  }
  return ['standalone', 'window-controls-overlay'].some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches);
};

/** Chrome's tab keys, for the actions they are in Chrome (Cmd+Option+←/→ is OpenChamber's own binding already). */
const APP_WINDOW_KEYS: Partial<Record<OcForgeForwardableAction, string[]>> = {
  switch_session_next: ['ctrl+tab'],
  switch_session_previous: ['ctrl+shift+tab'],
  close_session_tab: ['mod+w'],
};

/** The bindings frames are told about: the forwardable actions' current single-chord bindings. */
export const ocForgeShortcuts = (): OcForgeShortcuts => {
  const bindings: OcForgeShortcuts['bindings'] = {};
  for (const action of OC_FORGE_FORWARDABLE_ACTIONS) {
    const binding = bindingOf(action);
    if (binding && !binding.includes(' ')) bindings[action] = binding;
  }
  const mac = isMacOS();
  const shortcuts: OcForgeShortcuts = { mod: mac && isDesktopShell() ? ['meta'] : mac ? ['meta', 'ctrl'] : ['ctrl'], mac, bindings };
  if (!isOcForgeAppWindow()) return shortcuts;
  // An action the user unassigned has no alias either; a key that is its binding already needs none.
  const aliases: NonNullable<OcForgeShortcuts['aliases']> = {};
  for (const [action, combos] of Object.entries(APP_WINDOW_KEYS) as Array<[OcForgeForwardableAction, string[]]>) {
    const kept = combos.filter((combo) => bindings[action] && normalizeCombo(combo) !== bindings[action]);
    if (kept.length) aliases[action] = kept;
  }
  return { ...shortcuts, aliases };
};

/** The navigation action OpenChamber's own handlers would run for this press, in their order. */
const navigationActionOf = (event: KeyboardEvent): OcForgeForwardableAction | null => {
  if (resolveShortcutEventDigit(event) !== null) {
    if (eventMatchesShortcutPrefix(event, bindingOf('switch_context_surface'), NO_HELD_KEYS)) return 'switch_context_surface';
    if (resolveShortcutEventDigit(event) !== '0'
      && eventMatchesShortcutPrefix(event, bindingOf('switch_session_tab'), NO_HELD_KEYS)) return 'switch_session_tab';
  }
  for (const action of OC_FORGE_FORWARDABLE_ACTIONS) {
    if (DIGIT_ACTIONS.includes(action)) continue;
    const binding = bindingOf(action);
    if (binding && !binding.includes(' ') && eventMatchesShortcut(event, binding)) return action;
  }
  return null;
};

/** Another action shares the press (or starts a sequence with it): replaying it could run that one too. */
const sharedWithOtherAction = (event: KeyboardEvent): boolean => SHORTCUT_SCHEMA.some((action) => {
  if (FORWARDABLE.includes(action.id) || action.category === 'desktop') return false;
  const binding = bindingOf(action.id);
  return Boolean(binding) && eventMatchesShortcut(event, binding.split(' ')[0]);
});

const keyOfEvent = (event: KeyboardEvent): OcForgeKey => ({
  key: event.key,
  code: event.code,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  altKey: event.altKey,
  shiftKey: event.shiftKey,
  repeat: event.repeat,
});

/** The action an app-window tab key stands for in this window, or null (not an app window, not such a key). */
const appWindowActionOf = (event: KeyboardEvent): OcForgeForwardableAction | null => {
  const shortcuts = ocForgeShortcuts();
  for (const [action, combos] of Object.entries(shortcuts.aliases ?? {}) as Array<[OcForgeForwardableAction, string[]]>) {
    if (combos.some((combo) => matchesCombo(keyOfEvent(event), combo, shortcuts))) return action;
  }
  return null;
};

const PUNCTUATION: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', '-': 'Minus', '=': 'Equal', '\\': 'Backslash' };

/** A binding's key token as a press's `key` and `code` (`w`: w, KeyW; `arrowright`: ArrowRight; `[`: [, BracketLeft). */
const keyAndCode = (token: string): { key: string; code: string } => {
  if (/^[a-z]$/.test(token)) return { key: token, code: `Key${token.toUpperCase()}` };
  if (/^[0-9]$/.test(token)) return { key: token, code: `Digit${token}` };
  if (PUNCTUATION[token]) return { key: token, code: PUNCTUATION[token] };
  if (token === 'space') return { key: ' ', code: 'Space' };
  // arrowright → ArrowRight, pagedown → PageDown, tab → Tab, f4 → F4.
  const named = token.replace(/^(arrow|page)?(.)/, (_all, prefix: string | undefined, first: string) => `${prefix ? prefix[0]!.toUpperCase() + prefix.slice(1) : ''}${first.toUpperCase()}`);
  return { key: named, code: named };
};

/**
 * Runs a navigation action as a press of its own current binding would, through
 * OpenChamber's listeners. The press is built from the binding and must match
 * it as OpenChamber reads it; false when it cannot be (no binding, a sequence,
 * a key another action shares).
 */
const replayAction = (action: OcForgeForwardableAction): boolean => {
  const binding = bindingOf(action);
  const chord = binding && !binding.includes(' ') ? parseShortcut(binding)?.chords[0] : undefined;
  if (!chord?.key) return false;
  const mac = isMacOS();
  const init: KeyboardEventInit = {
    ...keyAndCode(chord.key),
    ctrlKey: chord.modifiers.has('ctrl') || (chord.modifiers.has('mod') && !mac),
    metaKey: (chord.modifiers.has('mod') && mac) || chord.modifiers.has('super'),
    altKey: chord.modifiers.has('alt'),
    shiftKey: chord.modifiers.has('shift'),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const keydown = new KeyboardEvent('keydown', init);
  if (!eventMatchesShortcut(keydown, binding) || navigationActionOf(keydown) !== action || sharedWithOtherAction(keydown)) return false;
  document.body.dispatchEvent(keydown);
  document.body.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
};

/**
 * In an installed app window, Chrome's own tab keys act on OpenChamber's tabs
 * (Ctrl+Tab, Ctrl+Shift+Tab, Cmd/Ctrl+W): with focus in OpenChamber here, and
 * from a frame that forwards them (forwardOcForgeKey).
 */
export const useOcForgeAppWindowKeys = (): void => {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.isTrusted) return;
      const action = appWindowActionOf(event);
      if (!action || !replayAction(action)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
};

type UserActivation = { isActive: boolean };

export type OcForgeKeyResult = { ok: true; action: OcForgeForwardableAction } | { ok: false; error: string };

export const forwardOcForgeKey = (key: OcForgeKey): OcForgeKeyResult => {
  // A key press in the frame activates its ancestors too; without one, a frame
  // could switch tabs on its own.
  const activation = (navigator as Navigator & { userActivation?: UserActivation }).userActivation;
  if (!activation?.isActive) return { ok: false, error: 'A forwarded key needs a user activation; forward it while handling the key press.' };
  if (key.repeat) return { ok: false, error: 'Held-down repeats are not forwarded.' };
  const init: KeyboardEventInit = {
    key: key.key,
    code: key.code,
    ctrlKey: key.ctrlKey,
    metaKey: key.metaKey,
    altKey: key.altKey,
    shiftKey: key.shiftKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const keydown = new KeyboardEvent('keydown', init);
  const action = navigationActionOf(keydown);
  if (!action) {
    // One of Chrome's tab keys in an app window: run its action as its binding would.
    const alias = appWindowActionOf(keydown);
    if (alias && replayAction(alias)) return { ok: true, action: alias };
    return { ok: false, error: 'Not one of the OpenChamber navigation shortcuts a frame may forward.' };
  }
  if (sharedWithOtherAction(keydown)) return { ok: false, error: 'This key is also bound to an OpenChamber action frames may not run.' };
  // Same listeners as a press with focus in OpenChamber itself; the keyup
  // releases what they track as held.
  document.body.dispatchEvent(keydown);
  document.body.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, action };
};
