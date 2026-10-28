// R4: keys pressed in an extension frame never reach OpenChamber's window
// listeners. A frame forwards a press; the host replays it through those same
// listeners, but only for navigation actions and only right after the user
// pressed something.
import { isDesktopShell } from '@/lib/desktop';
import {
  eventMatchesShortcut,
  eventMatchesShortcutPrefix,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  normalizeCombo,
  resolveShortcutEventDigit,
  SHORTCUT_SCHEMA,
  UNASSIGNED_SHORTCUT,
} from '@/lib/shortcuts';
import { isMacOS } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import {
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

/** The bindings frames are told about: the forwardable actions' current single-chord bindings. */
export const ocForgeShortcuts = (): OcForgeShortcuts => {
  const bindings: OcForgeShortcuts['bindings'] = {};
  for (const action of OC_FORGE_FORWARDABLE_ACTIONS) {
    const binding = bindingOf(action);
    if (binding && !binding.includes(' ')) bindings[action] = binding;
  }
  const mac = isMacOS();
  return { mod: mac && isDesktopShell() ? ['meta'] : mac ? ['meta', 'ctrl'] : ['ctrl'], mac, bindings };
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
  if (!action) return { ok: false, error: 'Not one of the OpenChamber navigation shortcuts a frame may forward.' };
  if (sharedWithOtherAction(keydown)) return { ok: false, error: 'This key is also bound to an OpenChamber action frames may not run.' };
  // Same listeners as a press with focus in OpenChamber itself; the keyup
  // releases what they track as held.
  document.body.dispatchEvent(keydown);
  document.body.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, action };
};
