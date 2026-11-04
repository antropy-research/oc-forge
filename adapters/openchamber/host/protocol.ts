// The oc-forge channel between an adapted OpenChamber and extension frames.
// One file for both ends: the build copies it into OpenChamber's UI as
// src/oc-forge/protocol.ts, and extensions bundle it through
// adapters/openchamber/client. It imports nothing.
//
// Messages are posted beside the SDK's own (`channel: "openchamber"`), so a
// stock OpenChamber and the stock SDK ignore them: an extension learns the
// host has these APIs only when the host answers its `hello`.

export const OC_FORGE_CHANNEL = 'oc-forge';
export const OC_FORGE_VERSION = 1;

export const OC_FORGE_FEATURES = ['keys', 'links', 'modals'] as const;
export type OcForgeFeature = (typeof OC_FORGE_FEATURES)[number];

/**
 * OpenChamber shortcut actions a frame may forward: switching and closing
 * tabs, switching surfaces, moving between sessions, the sidebar and the
 * command palette. Anything else stays with the frame or is refused.
 */
export const OC_FORGE_FORWARDABLE_ACTIONS = [
  'switch_session_tab',
  'switch_context_surface',
  'switch_session_previous',
  'switch_session_next',
  'session_history_back',
  'session_history_forward',
  'close_session_tab',
  'toggle_sidebar',
  'open_command_palette',
] as const;
export type OcForgeForwardableAction = (typeof OC_FORGE_FORWARDABLE_ACTIONS)[number];

/** Bound to a bare modifier prefix and completed by a digit: held mod + 1–9, held mod+alt + 0–9. */
export const OC_FORGE_DIGIT_ACTIONS = ['switch_context_surface', 'switch_session_tab'] as const;

/** What the host takes from a frame: a route (a deep link's, a page's own) of at most this many characters. */
export const OC_FORGE_LIMITS = {
  route: 2048,
} as const;

const GUEST_ID = /^[a-z][a-z0-9-]*$/;

/** The `ocForge` block of an extension's package.json, as the host read it. */
export type OcForgeManifest = {
  apiVersion: 1;
  /**
   * Its frames are sandboxed with `allow-modals` too: `print()` opens the
   * browser's print dialog on the frame's own document (and `alert()`,
   * `confirm()` and `prompt()` work). OpenChamber's frames otherwise have
   * `allow-scripts` alone, where Chrome ignores `print()`.
   */
  modals?: true;
};

export type OcForgeShortcuts = {
  /** Which modifier flags count as OpenChamber's `mod`. */
  mod: Array<'meta' | 'ctrl'>;
  /** On macOS Meta is Command; elsewhere it is the Super key and never `mod`. */
  mac: boolean;
  /**
   * The current binding of each forwardable action, normalized the way
   * OpenChamber stores it (`mod+alt+arrowleft`). The digit actions are a bare
   * prefix (`mod`, `mod+alt`) completed by a digit. Unassigned actions and
   * two-chord sequences are left out: they cannot be forwarded.
   */
  bindings: Partial<Record<OcForgeForwardableAction, string>>;
  /**
   * In an installed app window only, where Chrome reserves none of its tab
   * keys: those keys act on OpenChamber's tabs there, beside the bindings
   * (`ctrl+tab` and `ctrl+shift+tab` for the next and previous tab, `mod+w`
   * to close one). In a normal tab Chrome keeps them and a page never gets them.
   */
  aliases?: Partial<Record<OcForgeForwardableAction, string[]>>;
};

export type OcForgeHello = {
  version: typeof OC_FORGE_VERSION;
  /** What this host supports for this frame. */
  features: OcForgeFeature[];
  /** The extension's `panel.id`. */
  extension: string;
  /** The SDK surface the frame is: `panel`, `page`, `status`, `file`, `dialog`. */
  surface: string;
  /** The deep-link route handed to this frame (`?extension=<id>&route=<route>`), if any. */
  route: string | null;
  /** URL prefixes: `page + encodeURIComponent(route)` is this extension's page, `session + encodeURIComponent(id)` a chat. */
  links: { page: string; session: string } | null;
  shortcuts: OcForgeShortcuts;
};

export type OcForgeKey = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
};

/** Frame -> host. Requests carry an `id`; the host answers each with a `result`. */
export type OcForgeRequest =
  | { type: 'hello' }
  | { type: 'key'; payload: OcForgeKey }
  | { type: 'route'; payload: { route: string; push?: boolean } };

/** Host -> frame. */
export type OcForgeEvent =
  | { type: 'hello'; payload: OcForgeHello }
  | { type: 'route'; payload: { route: string } }
  | { type: 'shortcuts'; payload: OcForgeShortcuts }
  | { type: 'result'; id: string; ok: boolean; error?: string; payload?: unknown };

export type OcForgeEnvelope<T> = T & { channel: typeof OC_FORGE_CHANNEL; v: typeof OC_FORGE_VERSION; id?: string };

export const envelope = <T extends object>(message: T, id?: string): OcForgeEnvelope<T> => (
  id === undefined
    ? { channel: OC_FORGE_CHANNEL, v: OC_FORGE_VERSION, ...message }
    : { channel: OC_FORGE_CHANNEL, v: OC_FORGE_VERSION, id, ...message }
);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// What the host takes, said to the frame whose request it refuses (its developer reads it in the rejected promise).
const ROUTE = `a route is at most ${OC_FORGE_LIMITS.route} characters`;
const flag = (name: string) => `${name} is true or false`;

const isRoute = (value: unknown): value is string => typeof value === 'string' && value.length <= OC_FORGE_LIMITS.route;

type Parsed = { id: string | null; request: OcForgeRequest } | { id: string | null; error: string };

/**
 * A request a frame posted; or, for one the host can't take, why (`error`), which the host answers with when the
 * request has an id, at once rather than leaving the frame to time out; or null for anything that is not one.
 */
export const parseOcForgeRequest = (data: unknown): Parsed | null => {
  if (!isObject(data) || data.channel !== OC_FORGE_CHANNEL || data.v !== OC_FORGE_VERSION || typeof data.type !== 'string') return null;
  const id = typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 128 ? data.id : null;
  const payload = isObject(data.payload) ? data.payload : {};
  const refuse = (reason: string): Parsed => ({ id, error: `Refused ${String(data.type).slice(0, 32)}: ${reason}.` });
  switch (data.type) {
    case 'hello':
      return { id, request: { type: 'hello' } };
    case 'key': {
      const flags = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const;
      const press = 'a press has its key and code (at most 32 characters each) and the four modifier flags';
      if (typeof payload.key !== 'string' || !payload.key || payload.key.length > 32) return refuse(press);
      if (typeof payload.code !== 'string' || payload.code.length > 32) return refuse(press);
      if (flags.some((name) => typeof payload[name] !== 'boolean')) return refuse(press);
      return {
        id,
        request: {
          type: 'key',
          payload: {
            key: payload.key,
            code: payload.code,
            ctrlKey: payload.ctrlKey as boolean,
            metaKey: payload.metaKey as boolean,
            altKey: payload.altKey as boolean,
            shiftKey: payload.shiftKey as boolean,
            repeat: payload.repeat === true,
          },
        },
      };
    }
    case 'route':
      if (!isRoute(payload.route)) return refuse(ROUTE);
      if (payload.push !== undefined && typeof payload.push !== 'boolean') return refuse(flag('push'));
      return { id, request: { type: 'route', payload: payload.push === undefined ? { route: payload.route } : { route: payload.route, push: payload.push } } };
    default:
      return refuse('not a request this host knows');
  }
};

/** A request a frame posted, or null for anything that is not a well-formed one. */
export const readOcForgeRequest = (data: unknown): { id: string | null; request: OcForgeRequest } | null => {
  const read = parseOcForgeRequest(data);
  return read && 'request' in read ? read : null;
};

/** An event the host posted, or null. The client module reads these. */
export const readOcForgeEvent = (data: unknown): OcForgeEvent | null => {
  if (!isObject(data) || data.channel !== OC_FORGE_CHANNEL || data.v !== OC_FORGE_VERSION || typeof data.type !== 'string') return null;
  if (data.type === 'result') {
    return typeof data.id === 'string' && typeof data.ok === 'boolean'
      ? { type: 'result', id: data.id, ok: data.ok, error: typeof data.error === 'string' ? data.error : undefined, payload: data.payload }
      : null;
  }
  if (!isObject(data.payload)) return null;
  return { type: data.type, payload: data.payload } as OcForgeEvent;
};

/** The catalog row's `ocForge` field (the server read it from package.json), or undefined. */
export const readOcForgeManifest = (value: unknown): OcForgeManifest | undefined => {
  if (!isObject(value) || value.apiVersion !== 1) return undefined;
  const manifest: OcForgeManifest = { apiVersion: 1 };
  if (value.modals === true) manifest.modals = true;
  return manifest;
};

export const isGuestId = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && GUEST_ID.test(value);

// Shortcut matching, the same rules as OpenChamber's own (lib/shortcuts/bindings.ts),
// so a frame can tell which keys the host would take.

const MODIFIERS = new Set(['mod', 'shift', 'alt', 'ctrl', 'super']);
const SHIFTED: Record<string, string> = {
  '{': '[', '}': ']', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '|': '\\', '~': '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
};

const keyFromCode = (code: string): string | null => {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return CODE_KEYS[code] ?? null;
};

const token = (key: string): string => {
  const lowered = key.toLowerCase();
  if (lowered === ',') return 'comma';
  if (lowered === '.') return 'period';
  if (lowered === ' ') return 'space';
  if (lowered === 'esc') return 'escape';
  if (lowered === '+') return 'plus';
  if (lowered === '-' || lowered === '_') return 'minus';
  return SHIFTED[lowered] ?? lowered;
};

const eventKey = (event: OcForgeKey): string => {
  if (event.altKey) return keyFromCode(event.code) ?? event.key;
  if (event.key.length === 1 && event.key.charCodeAt(0) > 127) return keyFromCode(event.code) ?? event.key;
  return event.key;
};

/** The digit a press addresses (`Digit1` -> `1`), or null. */
export const eventDigit = (event: Pick<OcForgeKey, 'key' | 'code'>): string | null => {
  if (event.code.startsWith('Digit') && event.code.length === 6) return event.code.slice(5);
  return event.key.length === 1 && event.key >= '0' && event.key <= '9' ? event.key : null;
};

const parseChord = (combo: string): { modifiers: Set<string>; key: string } | null => {
  if (!combo || combo.includes(' ')) return null;
  const modifiers = new Set<string>();
  let key = '';
  for (const part of combo.split('+')) {
    if (MODIFIERS.has(part)) modifiers.add(part);
    else key = part;
  }
  return { modifiers, key };
};

const modifiersMatch = (event: OcForgeKey, modifiers: Set<string>, shortcuts: Pick<OcForgeShortcuts, 'mod' | 'mac'>, prefix: boolean): boolean => {
  const expectedMod = modifiers.has('mod');
  const ctrlIsMod = shortcuts.mod.includes('ctrl');
  const modMatches = (shortcuts.mod.includes('meta') && event.metaKey) || (ctrlIsMod && event.ctrlKey);
  if (expectedMod && !modMatches) return false;
  if (prefix) {
    if (!expectedMod && event.metaKey) return false;
  } else if (shortcuts.mac) {
    if (modifiers.has('super')) return false;
    if (!expectedMod && event.metaKey) return false;
  } else if (modifiers.has('super') !== event.metaKey) {
    return false;
  }
  if (modifiers.has('shift') !== event.shiftKey || modifiers.has('alt') !== event.altKey) return false;
  if (modifiers.has('ctrl')) return event.ctrlKey;
  return !event.ctrlKey || (expectedMod && ctrlIsMod);
};

/** Whether a key press is this single-chord binding (`mod+alt+arrowleft`). */
export const matchesCombo = (event: OcForgeKey, combo: string, shortcuts: Pick<OcForgeShortcuts, 'mod' | 'mac'>): boolean => {
  const chord = parseChord(combo);
  if (!chord || !chord.key || !modifiersMatch(event, chord.modifiers, shortcuts, false)) return false;
  return token(eventKey(event)) === token(chord.key);
};

/** Whether a press holds exactly this bare-modifier prefix (`mod+alt`). */
export const matchesPrefix = (event: OcForgeKey, prefix: string, shortcuts: Pick<OcForgeShortcuts, 'mod' | 'mac'>): boolean => {
  const chord = parseChord(prefix);
  return Boolean(chord && !chord.key && chord.modifiers.size > 0 && modifiersMatch(event, chord.modifiers, shortcuts, true));
};

/** The forwardable OpenChamber action a key press would run on the host, or null. */
export const matchHostShortcut = (event: OcForgeKey, shortcuts: OcForgeShortcuts): OcForgeForwardableAction | null => {
  if (event.repeat) return null;
  const digit = eventDigit(event);
  if (digit !== null) {
    const surface = shortcuts.bindings.switch_context_surface;
    if (surface && matchesPrefix(event, surface, shortcuts)) return 'switch_context_surface';
    const tab = shortcuts.bindings.switch_session_tab;
    if (digit !== '0' && tab && matchesPrefix(event, tab, shortcuts)) return 'switch_session_tab';
  }
  for (const action of OC_FORGE_FORWARDABLE_ACTIONS) {
    if ((OC_FORGE_DIGIT_ACTIONS as readonly string[]).includes(action)) continue;
    const combo = shortcuts.bindings[action];
    if (combo && matchesCombo(event, combo, shortcuts)) return action;
  }
  for (const action of OC_FORGE_FORWARDABLE_ACTIONS) {
    for (const combo of shortcuts.aliases?.[action] ?? []) if (matchesCombo(event, combo, shortcuts)) return action;
  }
  return null;
};
