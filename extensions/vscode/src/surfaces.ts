// VS Code in OpenChamber's own surfaces (oc-forge's adapters): which part of
// VS Code a frame is, the settings that make its workbench that part, and how
// an editor travels from one frame to another. Pure; the frame side is
// `workbench/surfaces.ts`.

/**
 * The part of VS Code a frame shows:
 *   classic   the whole workbench (a stock OpenChamber, or a release the surface patches don't fit)
 *   view      a rail entry's view container, filling the rail panel
 *   editor    the editor area, in OpenChamber's main area; its editors are header tabs
 *   terminal  VS Code's panel on its terminal, maximized, at OpenChamber's bottom
 */
export type Role = 'classic' | 'view' | 'editor' | 'terminal';

/** What the adapted host said in its hello, as far as the role depends on it. */
export interface HostHello {
  surface: string;
  features: readonly string[];
  rail: { entry: string | null; own: boolean } | null;
}

export const TERMINAL_ENTRY_ID = 'terminal';

export const roleOf = (hello: HostHello | null, surfaces: boolean): Role => {
  if (!hello || !surfaces) return 'classic';
  if (hello.surface === 'page') return hello.features.includes('tabs') ? 'editor' : 'classic';
  if (hello.surface !== 'panel' || !hello.features.includes('rail') || !hello.rail) return 'classic';
  if (hello.rail.own) return hello.rail.entry === TERMINAL_ENTRY_ID ? 'terminal' : 'classic';
  return hello.rail.entry ? 'view' : 'classic';
};

/**
 * Settings that make a workbench its part. They are its defaults from the
 * start, and they are set again in memory once it runs (VS Code's MEMORY
 * target), so the user's own settings.json can't undo the layout and nothing
 * is written there. `strip`: OpenChamber's header shows its tab strip.
 */
export const roleSettings = (role: Role, strip = true): Record<string, unknown> => {
  if (role === 'classic') return {};
  // OpenChamber's rail is the activity bar now; the layout buttons would bring back parts that live elsewhere.
  const common: Record<string, unknown> = { 'workbench.activityBar.location': 'hidden', 'workbench.layoutControl.enabled': false };
  // A view or the terminal is one part alone: no title bar (its command centre, its back and forward) and no status bar.
  const part: Record<string, unknown> = { ...common, 'workbench.statusBar.visible': false, 'window.commandCenter': false, 'workbench.navigationControl.enabled': false };
  // The parts are one workspace (one folder), whose terminals VS Code reconnects each window to as it starts: only the
  // terminal's part does, else a view or the page that started first would take the terminal panel's shells.
  const noTerminals: Record<string, unknown> = { 'terminal.integrated.enablePersistentSessions': false };
  if (role === 'view') return { ...part, ...noTerminals };
  if (role === 'terminal') {
    return {
      ...part,
      'workbench.panel.opensMaximized': 'always',
      // A horizontal panel maximizes only when centred.
      'workbench.panel.alignment': 'center',
    };
  }
  // The editor area: its editors are OpenChamber's header tabs, which have no preview state.
  return strip
    ? { ...common, ...noTerminals, 'workbench.editor.showTabs': 'none', 'workbench.editor.enablePreview': false, 'workbench.editor.enablePreviewFromQuickOpen': false }
    : { ...common, ...noTerminals };
};

/** VS Code's own `$mid` for a URI marshalled as JSON (`base/common/marshallingIds.ts`). */
const URI_MID = 1;

export interface UriLike {
  scheme: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
  toString(): string;
  toJSON(): unknown;
}

export const isUriLike = (value: unknown): value is UriLike => {
  const uri = value as UriLike | null;
  return typeof uri === 'object' && uri !== null && typeof uri.scheme === 'string' && typeof uri.path === 'string' && typeof uri.toJSON === 'function' && typeof (uri as { with?: unknown }).with === 'function';
};

/** An untyped editor input (`{ resource }`, `{ original, modified }`, `{ multiDiffSource }`, ...) as JSON: URIs marshalled the way VS Code does. */
export const marshal = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return undefined;
  if (isUriLike(value)) return value.toJSON();
  if (Array.isArray(value)) return value.map((item) => marshal(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function' || typeof item === 'symbol' || item === undefined) continue;
      out[key] = marshal(item, depth + 1);
    }
    return out;
  }
  return typeof value === 'bigint' ? undefined : value;
};

/** The reverse, with VS Code's own `URI.revive`. */
export const unmarshal = (value: unknown, revive: (components: unknown) => unknown, depth = 0): unknown => {
  if (depth > 8 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => unmarshal(item, revive, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.$mid === URI_MID && typeof record.scheme === 'string') return revive(record);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = unmarshal(item, revive, depth + 1);
  return out;
};

const uriText = (value: unknown): string | null => {
  if (isUriLike(value)) return value.toString();
  const components = value as { $mid?: unknown; scheme?: unknown; authority?: unknown; path?: unknown; query?: unknown; fragment?: unknown } | null;
  if (typeof components?.scheme !== 'string' || typeof components.path !== 'string') return null;
  // A marshalled URI: rebuilt the way URI.toString() writes it, enough to compare.
  const authority = typeof components.authority === 'string' && components.authority ? `//${components.authority}` : components.scheme === 'file' ? '//' : '';
  const query = typeof components.query === 'string' && components.query ? `?${components.query}` : '';
  const fragment = typeof components.fragment === 'string' && components.fragment ? `#${components.fragment}` : '';
  return `${components.scheme}:${authority}${encodeURI(components.path)}${query}${fragment}`;
};

const KEY_MAX = 1024;

const bounded = (key: string): string => {
  if (key.length <= KEY_MAX) return key;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  return `${key.slice(0, KEY_MAX - 12)}#${hash.toString(36)}`;
};

const resourceOf = (side: unknown): unknown => (side as { resource?: unknown } | null)?.resource;

/**
 * The header tab an editor is: the same text in every frame for the same
 * editor (its resource; a diff by both sides; others by their type).
 */
export const editorKeyOf = (untyped: unknown, typeId?: string): string | null => {
  const input = untyped as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return null;
  const original = uriText(resourceOf(input.original));
  const modified = uriText(resourceOf(input.modified));
  if (original && modified) return bounded(`diff:${original} ${modified}`);
  const source = uriText(input.multiDiffSource);
  if (source) return bounded(`changes:${source}`);
  const resource = uriText(input.resource);
  // `|` never appears in a URI's scheme: a typed key never reads as a resource.
  if (resource) return bounded(typeId ? `${typeId}|${resource}` : resource);
  return null;
};

/** A webview panel's key (Markdown's preview): its resource holds the panel's id, which VS Code makes anew when it revives the panel. */
const WEBVIEW_PANEL = 'workbench.editors.webviewInput|';

/**
 * The saved or header tab an editor VS Code restored stands for: the tab with its key, or for a revived webview
 * panel, a webview panel's tab with its title that no other editor stands for (`taken`). Null: none, so the user
 * closed it.
 */
export const restoredTabOf = (tabs: readonly { id: string; title: string }[], key: string, title: string, taken: ReadonlySet<string>): string | null => {
  if (tabs.some((tab) => tab.id === key)) return key;
  if (!key.startsWith(WEBVIEW_PANEL)) return null;
  return tabs.find((tab) => tab.id.startsWith(WEBVIEW_PANEL) && tab.title === title && !taken.has(tab.id))?.id ?? null;
};

/** Schemes whose editors belong to the frame that made them (its own terminals, output, chat). */
const LOCAL_SCHEMES = /^(vscode-terminal|output|vscode-chat|vscode-chat-.+|vscode-interactive-input|vscode-webview|walkThrough|walkThroughSnippet)$/;

/** Whether another frame can open this untyped editor: every resource it names is one that frame can resolve. */
export const isPortable = (untyped: unknown): boolean => {
  const input = untyped as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return false;
  const uris = [input.resource, resourceOf(input.original), resourceOf(input.modified), input.multiDiffSource, resourceOf(input.result)]
    .map((value) => (isUriLike(value) ? value.scheme : (value as { scheme?: unknown } | null)?.scheme))
    .filter((scheme): scheme is string => typeof scheme === 'string');
  return uris.length > 0 && uris.every((scheme) => !LOCAL_SCHEMES.test(scheme));
};

const TITLE_MAX = 80;

export const tabTitle = (name: string): string => {
  const title = name.trim() || 'Untitled';
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
};

const basename = (path: string): string => decodeURIComponent(path.replace(/\/+$/, '').split('/').pop() ?? '') || path;

/** A first title for a tab another frame opens; the page names it properly once the editor runs. */
export const requestTitle = (untyped: unknown): string => {
  const input = untyped as { label?: unknown; resource?: unknown; modified?: unknown; multiDiffSource?: unknown } | null;
  if (typeof input?.label === 'string' && input.label.trim()) return tabTitle(input.label);
  const modified = resourceOf(input?.modified);
  const path = (isUriLike(modified) ? modified.path : null) ?? (isUriLike(input?.resource) ? input!.resource.path : (input?.resource as { path?: string } | undefined)?.path);
  if (typeof path === 'string') return tabTitle(modified ? `${basename(path)} (changes)` : basename(path));
  return 'Editor';
};

const ICONS: [RegExp, string][] = [
  [/\.(md|markdown|txt|rst|adoc)$/i, 'file-text'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, 'file-image'],
  [/\.pdf$/i, 'file-pdf'],
  [/\.(mp4|webm|mov)$/i, 'file-video'],
  [/\.(mp3|wav|ogg|flac)$/i, 'file-music'],
];

/** A Remixicon for a header tab, by its key: diffs, settings and files by type. */
export const tabIcon = (key: string): string => {
  if (key.startsWith('diff:') || key.startsWith('changes:')) return 'git-commit';
  if (/settings|keybindings/i.test(key.split(':')[0] ?? '')) return 'settings-3';
  const path = key.replace(/[?#].*$/, '');
  for (const [pattern, icon] of ICONS) if (pattern.test(path)) return icon;
  return 'file-code';
};

/** What another frame asks the page to open: an editor (marshalled) or a command (an extension's page, Settings). */
export type OpenRequest =
  | { kind: 'editor'; editor: unknown }
  | { kind: 'command'; command: string; args: unknown[] };

export const readOpenRequest = (value: unknown): OpenRequest | null => {
  const request = value as Record<string, unknown> | null;
  if (request?.kind === 'editor' && typeof request.editor === 'object' && request.editor !== null) return { kind: 'editor', editor: request.editor };
  if (request?.kind === 'command' && typeof request.command === 'string' && /^[\w.-]{1,200}$/.test(request.command) && Array.isArray(request.args)) {
    return { kind: 'command', command: request.command, args: request.args };
  }
  return null;
};

/** The page's place, as a route in OpenChamber's address bar (`?extension=oc-forge-vscode&route=…`): its editor. */
export const editorRoute = (key: string, line?: number): string => `/editor?key=${encodeURIComponent(key)}${line ? `&line=${line}` : ''}`;

/** The longest route the host takes (the adapters' `OC_FORGE_LIMITS.route`). */
const ROUTE_MAX = 2048;

/**
 * A header tab's route: where a Cmd/Ctrl+click on the tab opens the page in a new browser tab, the editor's own link.
 * Only for an editor the page opens from its key alone (a resource, a diff); none for one that lives in its frame
 * (a webview, a terminal, an untitled file) or whose key `bounded` shortened.
 */
export const tabRoute = (key: string): string | undefined => {
  if (key.length > KEY_MAX - 12 || key.includes('|') || key.startsWith('changes:')) return undefined;
  if (!key.startsWith('diff:')) {
    const scheme = /^([a-z][\w+.-]*):\S+$/i.exec(key)?.[1];
    if (!scheme || scheme === 'untitled' || LOCAL_SCHEMES.test(scheme)) return undefined;
  }
  const route = editorRoute(key);
  return route.length <= ROUTE_MAX ? route : undefined;
};

export const readEditorRoute = (route: string | null): { key: string; line: number | null } | null => {
  if (!route) return null;
  const match = /^\/editor\?(.*)$/.exec(route);
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const key = params.get('key');
  const line = Number(params.get('line'));
  return key ? { key, line: Number.isInteger(line) && line > 0 ? line : null } : null;
};
