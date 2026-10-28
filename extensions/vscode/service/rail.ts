// The rail entries the host polls (`GET /rail`, the manifest's `ocForge.rail`):
// VS Code's built-in view containers, those of every extension installed on
// the VS Code Server, and the terminal. The extensions are read from the
// server itself, through the route it serves its files on
// (`/vscode-remote-resource`, with its token), so this works whether or not
// this machine shares the server's disk. Which server and where its
// extensions live, the frames tell (`remember`); it is kept on disk so the
// rail is complete after a restart, before any frame runs again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { declaredContainers, railEntries, type InstalledContainers, type RailEntry } from '../src/rail.ts';
import type { VscodeServer } from './server.ts';

interface Source {
  serverUrl: string;
  token: string | null;
  /** The server's extensions folder (`IRemoteAgentEnvironment.extensionsPath`), once a workbench has said. */
  extensionsPath: string | null;
}

/** A listing read this recently is answered again: every browser window polls. */
const FRESH_MS = 1_000;
const ICON_MAX = 64_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `extensions.json` as the server writes it: each installed extension's folder, by its id and version. */
export const installedFolders = (listing: unknown, obsolete: unknown, extensionsPath: string): { key: string; folder: string }[] => {
  if (!Array.isArray(listing)) return [];
  const gone = new Set(isRecord(obsolete) ? Object.keys(obsolete).filter((key) => obsolete[key] === true).map((key) => key.toLowerCase()) : []);
  const folders: { key: string; folder: string }[] = [];
  for (const item of listing) {
    if (!isRecord(item)) continue;
    const id = isRecord(item.identifier) && typeof item.identifier.id === 'string' ? item.identifier.id : null;
    const version = typeof item.version === 'string' ? item.version : '';
    const relative = typeof item.relativeLocation === 'string' && /^[^/\\]+$/.test(item.relativeLocation) && item.relativeLocation !== '..' ? item.relativeLocation : null;
    const location = isRecord(item.location) && typeof item.location.path === 'string' ? item.location.path : typeof item.location === 'string' ? item.location.replace(/^file:\/\//, '') : null;
    const folder = relative ? `${extensionsPath.replace(/\/+$/, '')}/${relative}` : location;
    if (!id || !folder || !folder.startsWith('/')) continue;
    if (gone.has(`${id}-${version}`.toLowerCase()) || (relative && gone.has(relative.toLowerCase()))) continue;
    folders.push({ key: `${id}@${version}:${folder}`, folder });
  }
  return folders;
};

export class Rail {
  private source: Source | null = null;
  private loaded: Promise<void> | null = null;
  private readonly extensions = new Map<string, InstalledContainers>();
  private last: RailEntry[] = railEntries([]);
  private readAt = 0;
  private reading: Promise<RailEntry[]> | null = null;

  constructor(
    /** Where the source is kept (mode 0600: it holds the connection token). */
    private readonly file: string,
    private readonly serverFor: (url: string, token: string | null) => VscodeServer,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, 'utf8').then((text) => {
      const saved = JSON.parse(text) as Partial<Source>;
      if (typeof saved.serverUrl === 'string') {
        this.source ??= { serverUrl: saved.serverUrl, token: typeof saved.token === 'string' ? saved.token : null, extensionsPath: typeof saved.extensionsPath === 'string' ? saved.extensionsPath : null };
      }
    }).catch(() => undefined);
    return this.loaded;
  }

  /** A frame connected to this server; `extensionsPath` once its workbench knows where the server keeps extensions. */
  async remember(serverUrl: string, token: string | null, extensionsPath?: string | null): Promise<void> {
    await this.load();
    const same = this.source?.serverUrl === serverUrl;
    const next: Source = { serverUrl, token, extensionsPath: extensionsPath ?? (same ? this.source!.extensionsPath : null) };
    if (this.source && JSON.stringify(this.source) === JSON.stringify(next)) return;
    if (!same) this.extensions.clear();
    this.source = next;
    this.readAt = 0;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (error) {
      this.log(`could not keep the rail's server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The entries now; the last list while the server can't be reached, so icons don't flicker. */
  async entries(): Promise<RailEntry[]> {
    await this.load();
    if (this.now() - this.readAt < FRESH_MS) return this.last;
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<RailEntry[]> {
    const source = this.source;
    if (!source?.extensionsPath) return this.last;
    const server = this.serverFor(source.serverUrl, source.token);
    const file = async (path: string): Promise<Buffer | null> => {
      const base = new URL(server.url).pathname.replace(/\/+$/, '');
      const answer = await server.get(`${base}/vscode-remote-resource?path=${encodeURIComponent(path)}`);
      return answer.status === 200 ? answer.body : null;
    };
    const json = async (path: string): Promise<unknown> => {
      const body = await file(path).catch(() => null);
      if (!body) return null;
      try {
        return JSON.parse(body.toString('utf8').replace(/^﻿/, '')) as unknown;
      } catch {
        return null;
      }
    };
    try {
      const listing = await file(`${source.extensionsPath}/extensions.json`);
      if (!listing) throw new Error('no extensions.json');
      const obsolete = await json(`${source.extensionsPath}/.obsolete`);
      const folders = installedFolders(JSON.parse(listing.toString('utf8').replace(/^﻿/, '')), obsolete, source.extensionsPath);
      const installed: InstalledContainers[] = [];
      for (const { key, folder } of folders) {
        let extension = this.extensions.get(key);
        if (!extension) {
          const manifest = await json(`${folder}/package.json`);
          const needsNls = JSON.stringify((manifest as { contributes?: { viewsContainers?: unknown } } | null)?.contributes?.viewsContainers ?? '').includes('%');
          const nls = needsNls ? await json(`${folder}/package.nls.json`) : null;
          const containers = declaredContainers(manifest, isRecord(nls) ? nls : {});
          const withIcons: InstalledContainers['containers'] = [];
          for (const container of containers) {
            const relative = container.icon.replace(/^\.?\//, '');
            const svg = /\.svg$/i.test(relative) && !relative.split('/').includes('..') ? await file(`${folder}/${relative}`).catch(() => null) : null;
            withIcons.push({ ...container, svg: svg && svg.byteLength <= ICON_MAX ? svg.toString('utf8') : null });
          }
          extension = { extension: key, containers: withIcons };
          if (manifest) this.extensions.set(key, extension);
        }
        installed.push(extension);
      }
      for (const key of [...this.extensions.keys()]) if (!folders.some((folder) => folder.key === key)) this.extensions.delete(key);
      this.last = railEntries(installed);
      this.readAt = this.now();
    } catch (error) {
      // The server restarts or is gone: keep the last list.
      if (this.readAt !== -1) this.log(`could not read the VS Code Server's extensions: ${error instanceof Error ? error.message : String(error)}`);
      this.readAt = -1;
    }
    return this.last;
  }
}
