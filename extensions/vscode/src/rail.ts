// VS Code's activity bar as OpenChamber rail entries (oc-forge's adapters,
// `ocForge.rail`): the five built-in view containers, every installed
// extension's `contributes.viewsContainers.activitybar`, and the terminal,
// which gets its own panel at the bottom. Pure: the service reads the
// extensions (`service/rail.ts`), this turns them into entries.

export interface RailEntry {
  /** Kebab-case, at most 48 characters, no `--` (the host's rule). */
  id: string;
  title: string;
  /** A Remixicon name in OpenChamber's sprite, or an inline `<svg>` of at most 16 KB. */
  icon: string;
  order: number;
  /** `bottom`: a panel of its own there (the terminal). */
  zone?: 'bottom';
  /** The view container a view entry shows: VS Code opens it by this id (`workbench.view.explorer`). The host ignores it. */
  view?: string;
  /** The overflow entry's containers, the ones the rail has no room for (`MORE_ENTRY_ID`). The host ignores it. */
  more?: { view: string; title: string }[];
}

/** VS Code's own view containers, in its order, with the Remixicons in OpenChamber's sprite closest to their codicons. */
export const BUILT_IN_ENTRIES: readonly RailEntry[] = [
  { id: 'explorer', title: 'Explorer', icon: 'file-copy-2', order: 1, view: 'workbench.view.explorer' },
  { id: 'search', title: 'Search', icon: 'search', order: 2, view: 'workbench.view.search' },
  { id: 'scm', title: 'Source Control', icon: 'git-branch', order: 3, view: 'workbench.view.scm' },
  { id: 'debug', title: 'Run and Debug', icon: 'bug', order: 4, view: 'workbench.view.debug' },
  { id: 'extensions', title: 'Extensions', icon: 'puzzle', order: 5, view: 'workbench.view.extensions' },
];

export const TERMINAL_ENTRY: RailEntry = { id: 'terminal', title: 'Terminal', icon: 'terminal-box', order: 1000, zone: 'bottom' };

/** The host's limits (adapters/openchamber/host/protocol.ts). */
const ENTRY_ID_MAX = 48;
const TITLE_MAX = 80;
const SVG_MAX = 16_384;
/** The entries the host takes from an extension (`OC_FORGE_LIMITS.railEntries`: 100, 32 before d459d05). */
export const ENTRIES_MAX = 100;

/** The containers past the rail's room, behind one entry, as VS Code's activity bar puts them behind "…". */
export const MORE_ENTRY_ID = 'additional-views';

/** An extension's activity-bar view container, as its package.json declares it. */
export interface DeclaredContainer {
  /** `contributes.viewsContainers.activitybar[].id`; VS Code names the container `workbench.view.extension.<id>`. */
  id: string;
  title: string;
  /** A path in the extension's folder, or `$(codicon)`. */
  icon: string;
}

/** The extension's declared containers, with `%key%` titles looked up in its package.nls.json. */
export const declaredContainers = (manifest: unknown, nls: Record<string, unknown> = {}): DeclaredContainer[] => {
  const list = (manifest as { contributes?: { viewsContainers?: { activitybar?: unknown } } } | null)?.contributes?.viewsContainers?.activitybar;
  if (!Array.isArray(list)) return [];
  const localized = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const key = /^%(.+)%$/.exec(value)?.[1];
    if (!key) return value;
    const found = nls[key];
    const text = typeof found === 'string' ? found : typeof (found as { message?: unknown })?.message === 'string' ? (found as { message: string }).message : null;
    return text ?? key;
  };
  const containers: DeclaredContainer[] = [];
  for (const item of list) {
    const entry = item as { id?: unknown; title?: unknown; icon?: unknown };
    if (typeof entry?.id !== 'string' || !/^[\w.-]{1,200}$/.test(entry.id)) continue;
    const title = localized(entry.title)?.trim();
    if (!title) continue;
    containers.push({ id: entry.id, title, icon: typeof entry.icon === 'string' ? entry.icon : '' });
  }
  return containers;
};

/** A kebab-case entry id for a container id (`gitlensInspect` → `gitlens-inspect`), not one of `taken`. */
export const entryIdOf = (containerId: string, taken: ReadonlySet<string>): string => {
  let id = containerId
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(id)) id = `v-${id}`.replace(/-+$/, '');
  id = id.slice(0, ENTRY_ID_MAX - 3).replace(/-+$/, '');
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${id}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * An SVG as the host draws an icon (a CSS mask in the rail's colour): the
 * `<svg>` element alone, with its namespace and a viewBox, without scripts,
 * comments or metadata; null when it is not an SVG or larger than 16 KB.
 */
export const railSvg = (text: string): string | null => {
  let svg = text
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|metadata|title|desc)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/>\s+</g, '><')
    .trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg\s*>$/i.test(svg)) return null;
  if (!/^<svg[^>]*\sxmlns\s*=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/^<svg[^>]*\sviewBox\s*=/i.test(svg)) {
    const size = (name: string) => Number.parseFloat(new RegExp(`^<svg[^>]*\\s${name}\\s*=\\s*["']?([\\d.]+)`, 'i').exec(svg)?.[1] ?? '');
    const [width, height] = [size('width'), size('height')];
    if (width > 0 && height > 0) svg = svg.replace(/^<svg/i, `<svg viewBox="0 0 ${width} ${height}"`);
  }
  return svg.length <= SVG_MAX ? svg : null;
};

/** Codicons extensions name as `$(name)`, as the closest Remixicon in OpenChamber's sprite. */
const CODICONS: Record<string, string> = {
  account: 'shield-user', beaker: 'flask', book: 'book', bookmark: 'book-marked', bug: 'bug', checklist: 'list-check-2',
  cloud: 'cloud', code: 'code', copilot: 'robot', database: 'database-2', 'debug-alt': 'bug', extensions: 'puzzle',
  file: 'file', 'file-code': 'file-code', files: 'file-copy-2', folder: 'folder', 'folder-opened': 'folder-open', gear: 'settings-3',
  'git-branch': 'git-branch', 'git-commit': 'git-commit', 'git-merge': 'git-merge', 'git-pull-request': 'git-pull-request', github: 'github',
  history: 'history', inbox: 'inbox-archive', inspect: 'search-eye', layers: 'stack', 'list-flat': 'list-unordered', 'list-tree': 'node-tree',
  'list-unordered': 'list-unordered', package: 'box-3', play: 'play', plug: 'plug', references: 'node-tree', robot: 'robot', 'run-all': 'play',
  search: 'search', server: 'server', 'server-environment': 'server', settings: 'settings-3', 'settings-gear': 'settings-3', shield: 'shield',
  'source-control': 'git-branch', terminal: 'terminal-box', tools: 'tools', 'type-hierarchy': 'node-tree', window: 'window',
};
export const FALLBACK_ICON = 'apps';

export const codiconIcon = (icon: string): string | null => {
  const name = /^\$\(([a-z0-9-]+)(?:~[a-z]+)?\)$/.exec(icon.trim())?.[1];
  return name ? CODICONS[name] ?? FALLBACK_ICON : null;
};

/** One installed extension's containers, each with its icon read already (inline SVG) or a Remixicon. */
export interface InstalledContainers {
  extension: string;
  containers: (DeclaredContainer & { svg?: string | null })[];
}

/**
 * The rail: the built-ins, then each installed extension's containers in the
 * order the extensions are listed, then the terminal, which opens at the
 * bottom. At most the host's `max` entries: past them, the last container
 * entry is "Additional Views", which opens the others (`more`), so none is
 * left out.
 */
export const railEntries = (installed: readonly InstalledContainers[], max = ENTRIES_MAX): RailEntry[] => {
  const taken = new Set<string>([...BUILT_IN_ENTRIES.map((entry) => entry.id), TERMINAL_ENTRY.id, MORE_ENTRY_ID]);
  const extensions: RailEntry[] = [];
  const views = new Set<string>(BUILT_IN_ENTRIES.map((entry) => entry.view!));
  for (const extension of installed) {
    for (const container of extension.containers) {
      const view = `workbench.view.extension.${container.id}`;
      if (views.has(view)) continue;
      views.add(view);
      const id = entryIdOf(container.id, taken);
      taken.add(id);
      const title = container.title.length > TITLE_MAX ? `${container.title.slice(0, TITLE_MAX - 1)}…` : container.title;
      const icon = (container.svg ? railSvg(container.svg) : null) ?? codiconIcon(container.icon) ?? FALLBACK_ICON;
      extensions.push({ id, title, icon, order: 10 + extensions.length, view });
    }
  }
  const room = max - BUILT_IN_ENTRIES.length - 1;
  const shown = extensions.length <= room ? extensions : extensions.slice(0, room - 1);
  const hidden = extensions.slice(shown.length);
  const more: RailEntry[] = hidden.length === 0 ? [] : [{
    id: MORE_ENTRY_ID,
    title: `Additional Views (${hidden.length})`,
    icon: 'more',
    order: 10 + shown.length,
    more: hidden.map((entry) => ({ view: entry.view!, title: entry.title })),
  }];
  // The host shows them by `order`, and keeps the first `max` it reads: the built-ins, the terminal and the overflow
  // entry come first, so a host that takes fewer (an adapted OpenChamber before d459d05 took 32) drops containers.
  return [...BUILT_IN_ENTRIES, TERMINAL_ENTRY, ...more, ...shown].map((entry) => ({ ...entry }));
};

/** The entry that shows a view container, or null (`workbench.view.scm` → `scm`; one past the rail's room → its overflow entry). */
export const entryOfView = (entries: readonly RailEntry[], view: string): string | null =>
  entries.find((entry) => entry.view === view || entry.more?.some((item) => item.view === view))?.id ?? null;

/**
 * What a rail view makes of the container VS Code shows (`view`) once it has read the rail again (`now`; `before`, the
 * read before): the entry to light, its own or "Additional Views", as containers come and go. With none, its extension
 * was uninstalled and VS Code keeps the container until a reload (the extension ran), while the host lights the first
 * view: left out by two reads in a row (`missing`, what the last call answered; not one read that failed), that first
 * view is the one to show. A container opened later without an entry stays.
 */
export const followView = (before: readonly RailEntry[], now: readonly RailEntry[], view: string, missing: string | null): {
  light: string | null;
  show: string | null;
  missing: string | null;
} => {
  const entry = entryOfView(now, view);
  if (entry) return { light: entry, show: null, missing: null };
  const first = now.find((item) => !item.zone && item.view);
  if (missing === view && first) return { light: null, show: first.id, missing: null };
  return { light: null, show: null, missing: entryOfView(before, view) ? view : null };
};
