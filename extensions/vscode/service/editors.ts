// Editors between the frames of OpenChamber's own surfaces (oc-forge's
// adapters). A rail view or the bottom terminal that opens an editor hands it
// to the page, the editor area in OpenChamber's main area, through a header
// tab: OpenChamber shows the page on that tab and tells it. What to open (the
// editor, its selection) waits here until the page takes it. The page's tabs
// are kept too, so a frame can bring them back after OpenChamber reloads,
// before the page has started again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUEST_TTL_MS = 60_000;
const REQUESTS_MAX = 64;
const TABS_MAX = 64;

export class EditorRequests {
  private readonly pending = new Map<string, { open: unknown; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  put(key: string, open: unknown): void {
    this.prune();
    this.pending.delete(key);
    this.pending.set(key, { open, at: this.now() });
    while (this.pending.size > REQUESTS_MAX) this.pending.delete(this.pending.keys().next().value!);
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
    if (typeof tab.title !== 'string' || !tab.title.trim() || tab.title.length > 80) continue;
    const icon = typeof tab.icon === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tab.icon) ? tab.icon : undefined;
    tabs.push(icon ? { id: tab.id, title: tab.title, icon } : { id: tab.id, title: tab.title });
  }
  return tabs;
};

export class SavedTabs {
  private readonly tabs = new Map<string, SavedTab[]>();

  constructor(private readonly dir: string, private readonly log: (message: string) => void) {}

  private file(key: string): string {
    return join(this.dir, `${key}.tabs.json`);
  }

  async load(key: string): Promise<SavedTab[]> {
    const cached = this.tabs.get(key);
    if (cached) return cached;
    const tabs = await readFile(this.file(key), 'utf8').then((text) => readTabs(JSON.parse(text)), () => []);
    this.tabs.set(key, tabs);
    return tabs;
  }

  async save(key: string, tabs: SavedTab[]): Promise<void> {
    if (JSON.stringify(this.tabs.get(key)) === JSON.stringify(tabs)) return;
    this.tabs.set(key, tabs);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(key)}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(tabs), { mode: 0o600 });
      await rename(tmp, this.file(key));
    } catch (error) {
      this.log(`could not keep the page's tabs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
