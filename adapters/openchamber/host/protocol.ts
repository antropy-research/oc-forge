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

export const OC_FORGE_FEATURES = ['rail', 'tabs', 'zones', 'keys', 'links'] as const;
export type OcForgeFeature = (typeof OC_FORGE_FEATURES)[number];

export const OC_FORGE_ZONES = ['left', 'right', 'bottom'] as const;
export type OcForgeZone = (typeof OC_FORGE_ZONES)[number];

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

export const OC_FORGE_LIMITS = {
  railEntries: 100,
  entryId: 48,
  title: 80,
  svg: 16_384,
  tabs: 64,
  tabId: 1024,
  route: 2048,
} as const;

/** Kebab-case; `--` is reserved: OpenChamber names an entry's own surface `plugin:<extension>--<entry>`. */
export const OC_FORGE_ENTRY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUEST_ID = /^[a-z][a-z0-9-]*$/;

/** A Remixicon name (`git-branch`) or an inline `<svg>`; the host draws either as a mask in the rail's colour. */
export type OcForgeIcon = string;

export type OcForgeRailEntry = {
  id: string;
  title: string;
  icon: OcForgeIcon;
  /** Ascending; entries without one keep the service's order after those with one. */
  order?: number;
  /**
   * Gives the entry its own panel (a frame of its own, loading `panel.entry`)
   * that opens in this zone until the user moves it. Without a zone the entry
   * is a view of the extension's one panel and follows its zone.
   */
  zone?: OcForgeZone;
};

/** The `ocForge` block of an extension's package.json, as the host read it. */
export type OcForgeManifest = {
  apiVersion: 1;
  /** Where the extension's panel opens until the user moves it. */
  zone?: OcForgeZone;
  /** The service path the host polls for rail entries, and how often (ms). */
  rail?: { path: string; interval: number };
  /**
   * Its page. `keepBottomZone`: OpenChamber's bottom zone stays shown under the
   * page instead of being covered with the chat (an editor over its terminal).
   */
  page?: { keepBottomZone: true };
};

export const OC_FORGE_RAIL_INTERVAL_DEFAULT = 3_000;
export const OC_FORGE_RAIL_INTERVAL_MIN = 1_000;
export const OC_FORGE_RAIL_INTERVAL_MAX = 60_000;

export type OcForgeTab = {
  id: string;
  title: string;
  icon?: OcForgeIcon;
  /** Unsaved changes: the tab shows a dot instead of its close button until hovered. */
  dirty?: boolean;
  /** Its place on the extension's page: a Cmd/Ctrl+click on the tab opens the page there in a new browser tab. */
  route?: string;
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
};

export type OcForgeTabsState = { list: OcForgeTab[]; active: string | null; shown: boolean; strip: boolean };

export type OcForgeHello = {
  version: typeof OC_FORGE_VERSION;
  /** What this host supports for this frame. */
  features: OcForgeFeature[];
  /** The extension's `panel.id`. */
  extension: string;
  /** The SDK surface the frame is: `panel`, `page`, `status`, `file`, `dialog`. */
  surface: string;
  /** Rail panels of extensions with rail entries: the entry shown, and whether the frame is that entry's own panel. */
  rail: { entry: string | null; own: boolean } | null;
  /**
   * The extension's header tabs, the one its page shows, whether the page is
   * on screen on it, and whether the header's tab strip is there at all (it
   * follows OpenChamber's "Session tabs" setting).
   */
  tabs: OcForgeTabsState;
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
  | { type: 'rail-active'; payload: { entry: string } }
  | { type: 'tab-open'; payload: OcForgeTab & { activate?: boolean } }
  | { type: 'tab-update'; payload: { id: string; title?: string; icon?: OcForgeIcon | null; dirty?: boolean; route?: string | null } }
  | { type: 'tab-close'; payload: { id: string } }
  /** The frame decides how its dirty tabs close (it then gets `tab-close-request`), or stops deciding. */
  | { type: 'tab-close-handler'; payload: { on: boolean } }
  | { type: 'tab-activate'; payload: { id: string } }
  | { type: 'key'; payload: OcForgeKey }
  | { type: 'route'; payload: { route: string; push?: boolean } };

/** Host -> frame. */
export type OcForgeEvent =
  | { type: 'hello'; payload: OcForgeHello }
  | { type: 'rail-entry'; payload: { entry: string } }
  | { type: 'tab-activated'; payload: { id: string } }
  | { type: 'tab-closed'; payload: { id: string } }
  /** The user asked to close this dirty tab; it stays until the frame closes it. */
  | { type: 'tab-close-request'; payload: { id: string } }
  | { type: 'tabs'; payload: OcForgeTabsState }
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
const text = (value: unknown, max: number): string | null => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
);

export const isOcForgeIcon = (value: unknown): value is OcForgeIcon => (
  typeof value === 'string'
  && (ICON_NAME.test(value) || (/^\s*<svg[\s>]/i.test(value) && value.length <= OC_FORGE_LIMITS.svg))
);

const readTab = (value: Json): OcForgeTab | null => {
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= OC_FORGE_LIMITS.tabId ? value.id : null;
  const title = text(value.title, OC_FORGE_LIMITS.title);
  if (!id || !title) return null;
  const tab: OcForgeTab = { id, title };
  if (value.icon !== undefined) {
    if (!isOcForgeIcon(value.icon)) return null;
    tab.icon = value.icon;
  }
  if (value.dirty !== undefined) {
    if (typeof value.dirty !== 'boolean') return null;
    tab.dirty = value.dirty;
  }
  if (value.route !== undefined) {
    if (!isRoute(value.route)) return null;
    tab.route = value.route;
  }
  return tab;
};

const isRoute = (value: unknown): value is string => typeof value === 'string' && value.length <= OC_FORGE_LIMITS.route;

/** A request a frame posted, or null for anything that is not one. */
export const readOcForgeRequest = (data: unknown): { id: string | null; request: OcForgeRequest } | null => {
  if (!isObject(data) || data.channel !== OC_FORGE_CHANNEL || data.v !== OC_FORGE_VERSION) return null;
  const id = typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 128 ? data.id : null;
  const payload = isObject(data.payload) ? data.payload : {};
  switch (data.type) {
    case 'hello':
      return { id, request: { type: 'hello' } };
    case 'rail-active':
      return typeof payload.entry === 'string' && OC_FORGE_ENTRY_ID.test(payload.entry)
        ? { id, request: { type: 'rail-active', payload: { entry: payload.entry } } }
        : null;
    case 'tab-open': {
      const tab = readTab(payload);
      if (!tab || (payload.activate !== undefined && typeof payload.activate !== 'boolean')) return null;
      return { id, request: { type: 'tab-open', payload: payload.activate === undefined ? tab : { ...tab, activate: payload.activate } } };
    }
    case 'tab-update': {
      if (typeof payload.id !== 'string' || !payload.id || payload.id.length > OC_FORGE_LIMITS.tabId) return null;
      const update: { id: string; title?: string; icon?: OcForgeIcon | null; dirty?: boolean; route?: string | null } = { id: payload.id };
      if (payload.title !== undefined) {
        const title = text(payload.title, OC_FORGE_LIMITS.title);
        if (!title) return null;
        update.title = title;
      }
      if (payload.icon !== undefined) {
        if (payload.icon !== null && !isOcForgeIcon(payload.icon)) return null;
        update.icon = payload.icon;
      }
      if (payload.dirty !== undefined) {
        if (typeof payload.dirty !== 'boolean') return null;
        update.dirty = payload.dirty;
      }
      if (payload.route !== undefined) {
        if (payload.route !== null && !isRoute(payload.route)) return null;
        update.route = payload.route;
      }
      return { id, request: { type: 'tab-update', payload: update } };
    }
    case 'tab-close-handler':
      return typeof payload.on === 'boolean' ? { id, request: { type: 'tab-close-handler', payload: { on: payload.on } } } : null;
    case 'tab-close':
    case 'tab-activate':
      return typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= OC_FORGE_LIMITS.tabId
        ? { id, request: { type: data.type, payload: { id: payload.id } } }
        : null;
    case 'key': {
      const flags = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const;
      if (typeof payload.key !== 'string' || !payload.key || payload.key.length > 32) return null;
      if (typeof payload.code !== 'string' || payload.code.length > 32) return null;
      if (flags.some((flag) => typeof payload[flag] !== 'boolean')) return null;
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
      if (!isRoute(payload.route) || (payload.push !== undefined && typeof payload.push !== 'boolean')) return null;
      return { id, request: { type: 'route', payload: payload.push === undefined ? { route: payload.route } : { route: payload.route, push: payload.push } } };
    default:
      return null;
  }
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

/**
 * The entries a service answered (`{ entries: [...] }`), in display order.
 * A malformed entry is dropped on its own; an answer without a list is null.
 */
export const readOcForgeRailEntries = (body: unknown): OcForgeRailEntry[] | null => {
  if (!isObject(body) || !Array.isArray(body.entries)) return null;
  const seen = new Set<string>();
  const entries: Array<OcForgeRailEntry & { index: number }> = [];
  body.entries.forEach((value, index) => {
    if (!isObject(value) || entries.length >= OC_FORGE_LIMITS.railEntries) return;
    const id = typeof value.id === 'string' && value.id.length <= OC_FORGE_LIMITS.entryId && OC_FORGE_ENTRY_ID.test(value.id) ? value.id : null;
    const title = text(value.title, OC_FORGE_LIMITS.title);
    if (!id || !title || seen.has(id) || !isOcForgeIcon(value.icon)) return;
    const entry: OcForgeRailEntry & { index: number } = { id, title, icon: value.icon, index };
    if (value.order !== undefined) {
      if (typeof value.order !== 'number' || !Number.isFinite(value.order)) return;
      entry.order = value.order;
    }
    if (value.zone !== undefined) {
      if (!OC_FORGE_ZONES.includes(value.zone as OcForgeZone)) return;
      entry.zone = value.zone as OcForgeZone;
    }
    seen.add(id);
    entries.push(entry);
  });
  return entries
    .sort((left, right) => (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY) || left.index - right.index)
    .map(({ index: _index, ...entry }) => entry);
};

const isRequestPath = (value: unknown): value is string => (
  typeof value === 'string' && value.startsWith('/') && value.length <= 512 && !value.includes('\0')
  && !value.includes('\\') && !value.includes('://') && !value.split('/').some((segment) => segment === '.' || segment === '..')
);

/** The catalog row's `ocForge` field (the server read it from package.json), or undefined. */
export const readOcForgeManifest = (value: unknown): OcForgeManifest | undefined => {
  if (!isObject(value) || value.apiVersion !== 1) return undefined;
  const manifest: OcForgeManifest = { apiVersion: 1 };
  if (OC_FORGE_ZONES.includes(value.zone as OcForgeZone)) manifest.zone = value.zone as OcForgeZone;
  if (isObject(value.rail) && isRequestPath(value.rail.path)) {
    const interval = typeof value.rail.interval === 'number' && Number.isInteger(value.rail.interval)
      ? Math.min(OC_FORGE_RAIL_INTERVAL_MAX, Math.max(OC_FORGE_RAIL_INTERVAL_MIN, value.rail.interval))
      : OC_FORGE_RAIL_INTERVAL_DEFAULT;
    manifest.rail = { path: value.rail.path, interval };
  }
  if (isObject(value.page) && value.page.keepBottomZone === true) manifest.page = { keepBottomZone: true };
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
  return null;
};
