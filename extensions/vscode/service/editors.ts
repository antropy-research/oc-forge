// Editors between the frames of OpenChamber's own surfaces (oc-forge's
// adapters). A rail view or the bottom terminal that opens an editor hands it
// to the page, the editor area in OpenChamber's main area, through a header
// tab: OpenChamber shows the page on that tab and tells it. What to open (the
// editor, its selection) waits here until the page takes it. The page's tabs
// are kept too, so a frame can bring them back after OpenChamber reloads,
// before the page has started again.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OC_FORGE_LIMITS } from '../../../adapters/openchamber/host/protocol.ts';

const REQUEST_TTL_MS = 60_000;
const REQUESTS_MAX = 64;
/** As many tabs, and titles as long, as any host takes (an older host took 64 and 80). */
const TABS_MAX = OC_FORGE_LIMITS.tabs;
const TITLE_MAX = OC_FORGE_LIMITS.title;
/** Revisions of one list being sent in parts at once (two browser windows on a folder): the older ones go. */
const REVISIONS_MAX = 4;
const PARTS_MAX = 256;
/** A browser tab's own list sits beside its folder's: `<folder's key>.w-<window id>`. */
const WINDOW_MARK = '.w-';
/** Browser tabs' lists kept per folder, the newest. */
const WINDOWS_MAX = 64;

export class EditorRequests {
  private readonly pending = new Map<string, { open: unknown; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  put(key: string, open: unknown): void {
    this.prune();
    this.pending.delete(key);
    this.pending.set(key, { open, at: this.now() });
    while (this.pending.size > REQUESTS_MAX) this.pending.delete(this.pending.keys().next().value!);
  }

  /** The tabs with a request waiting (at most REQUESTS_MAX), for a page that didn't see them selected. */
  keys(): string[] {
    this.prune();
    return [...this.pending.keys()];
  }

  /** The request waiting for this tab, once. */
  take(key: string): unknown {
    this.prune();
    const request = this.pending.get(key);
    this.pending.delete(key);
    return request?.open ?? null;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, request] of this.pending) if (now - request.at > REQUEST_TTL_MS) this.pending.delete(key);
  }
}

export interface SavedTab {
  id: string;
  title: string;
  icon?: string;
}

/** Tabs as a frame sends them; anything malformed is dropped. */
export const readTabs = (raw: unknown): SavedTab[] => {
  if (!Array.isArray(raw)) return [];
  const tabs: SavedTab[] = [];
  for (const item of raw.slice(0, TABS_MAX)) {
    const tab = item as Record<string, unknown>;
    if (typeof tab?.id !== 'string' || !tab.id || tab.id.length > 1024) continue;
    if (typeof tab.title !== 'string' || !tab.title.trim() || tab.title.length > TITLE_MAX) continue;
    const icon = typeof tab.icon === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tab.icon) ? tab.icon : undefined;
    tabs.push(icon ? { id: tab.id, title: tab.title, icon } : { id: tab.id, title: tab.title });
  }
  return tabs;
};

/** Which part of a list sent in parts a request is (`/tabs/save`), or null for anything else. */
export const readPart = (raw: unknown): { revision: string; index: number; count: number } | null => {
  const part = raw as Record<string, unknown> | null;
  if (!part || typeof part !== 'object') return null;
  const { revision, index, count } = part;
  if (typeof revision !== 'string' || !/^[0-9a-z]{1,32}$/.test(revision)) return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > PARTS_MAX) return null;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count ? { revision, index, count } : null;
};

export class SavedTabs {
  private readonly tabs = new Map<string, SavedTab[]>();
  /** Lists coming in parts, by list and revision, oldest first. */
  private readonly incoming = new Map<string, Map<string, { count: number; parts: Map<number, SavedTab[]> }>>();

  constructor(private readonly dir: string, private readonly log: (message: string) => void) {}

  /**
   * One list per server and folder, a folder's editors being its own: the latest any browser tab kept. With `window`
   * (a browser tab's id, kept across its reloads), that tab's own list, which its reload brings back.
   */
  static keyOf(serverKey: string, folder: unknown, window?: unknown): string {
    const name = typeof folder === 'string' && folder.startsWith('/') ? folder : '';
    const key = `${serverKey}.${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
    return SavedTabs.isWindow(window) ? `${key}${WINDOW_MARK}${window}` : key;
  }

  static isWindow(window: unknown): window is string {
    return typeof window === 'string' && /^[0-9a-f]{32}$/.test(window);
  }

  private file(key: string): string {
    return join(this.dir, `${key}.tabs.json`);
  }

  async load(key: string): Promise<SavedTab[]> {
    return (await this.loadIfKept(key)) ?? [];
  }

  /** The list kept under this key, or null when none was (a window that never kept one). */
  async loadIfKept(key: string): Promise<SavedTab[] | null> {
    const cached = this.tabs.get(key);
    if (cached) return cached;
    const tabs = await readFile(this.file(key), 'utf8').then((text) => readTabs(JSON.parse(text)), () => null);
    if (tabs) this.tabs.set(key, tabs);
    return tabs;
  }

  /** Windows' lists past the newest WINDOWS_MAX of a folder go (browser tabs closed long ago). */
  private async prune(key: string): Promise<void> {
    const at = key.indexOf(WINDOW_MARK);
    if (at === -1) return;
    const prefix = `${key.slice(0, at)}${WINDOW_MARK}`;
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((name) => name.startsWith(prefix) && name.endsWith('.tabs.json'));
    if (names.length <= WINDOWS_MAX) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(this.dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    for (const { name } of dated.sort((a, b) => b.at - a.at).slice(WINDOWS_MAX)) {
      this.tabs.delete(name.slice(0, -'.tabs.json'.length));
      await rm(join(this.dir, name), { force: true }).catch(() => undefined);
    }
  }

  /**
   * One part of a list too long for one request: the list is kept once every part of its revision has come, in their
   * order, and the revisions begun before it go. One that never completes leaves the list as it was.
   */
  async savePart(key: string, part: { revision: string; index: number; count: number }, tabs: SavedTab[]): Promise<void> {
    const revisions = this.incoming.get(key) ?? new Map<string, { count: number; parts: Map<number, SavedTab[]> }>();
    this.incoming.set(key, revisions);
    // In the order they began: a revision that completes takes the older ones with it, and leaves the newer.
    let incoming = revisions.get(part.revision);
    if (!incoming) {
      incoming = { count: part.count, parts: new Map<number, SavedTab[]>() };
      revisions.set(part.revision, incoming);
      while (revisions.size > REVISIONS_MAX) revisions.delete(revisions.keys().next().value!);
    }
    if (incoming.count !== part.count) return;
    incoming.parts.set(part.index, tabs);
    if (incoming.parts.size < incoming.count) return;
    for (const revision of [...revisions.keys()]) {
      revisions.delete(revision);
      if (revision === part.revision) break;
    }
    if (revisions.size === 0) this.incoming.delete(key);
    await this.save(key, readTabs(Array.from({ length: incoming.count }, (_, index) => incoming.parts.get(index) ?? []).flat()));
  }

  async save(key: string, tabs: SavedTab[]): Promise<void> {
    if (JSON.stringify(this.tabs.get(key)) === JSON.stringify(tabs)) return;
    this.tabs.set(key, tabs);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(key)}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(tabs), { mode: 0o600 });
      await rename(tmp, this.file(key));
      await this.prune(key);
    } catch (error) {
      this.log(`could not keep the page's tabs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
