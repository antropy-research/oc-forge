// The compiled workbench the frame loads, taken from the user's own VS Code
// Server (the same commit, which the remote connection requires) and prepared
// for an OpenChamber frame: only the files a browser loads, under names
// OpenChamber serves, with `patch.ts` applied. It is written inside this
// extension's folder (`vscode-web/<commit>/`), because an extension frame can
// load files from its own package and from nowhere else.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { clientFileName, REQUIRED_SOURCE_FILES, WEB_NODE_MODULES } from '../src/clientFiles.ts';
import { patchExtensionHostIframe, patchScript, patchStylesheet, patchWorkbench, PatchError } from '../src/patch.ts';
import type { ServerPage, VscodeServer } from './server.ts';

/** Bumped when the cache's layout or patches change, so older caches are rebuilt. */
export const CACHE_FORMAT = 3;
const MARKER = 'ready.json';
const KEEP = 2;
const DOWNLOADS_AT_ONCE = 8;
/** Where VS Code's webview host page is, which this extension's own replaces. */
const WEBVIEW_PRE = 'out/vs/workbench/contrib/webview/browser/pre';
const WEBVIEW_FILES = ['index.html', 'host.js'] as const;

export type AssetState =
  | { state: 'idle' }
  | { state: 'preparing'; source: 'local' | 'download'; done: number; total: number }
  /** `surfaces`: every surface patch applied, so the frames can use OpenChamber's own surfaces. */
  | { state: 'ready'; path: string; files: number; source: 'local' | 'download'; surfaces: boolean }
  | { state: 'failed'; error: string };

/** Where a VS Code Server is usually installed on the machine running OpenChamber. */
export const localInstallCandidates = (commit: string, home = homedir()): string[] => [
  '/opt/vscode-server',
  join(home, '.vscode-server', 'cli', 'servers', `Stable-${commit}`, 'server'),
  join(home, '.vscode-server', 'bin', commit),
  join(home, '.vscode', 'cli', 'serve-web', commit),
  join(home, '.vscode-cli', 'serve-web', commit),
  join(home, '.vscode-server', 'cli', 'serve-web', commit),
];

const walk = async (root: string, dir: string, out: string[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path));
  }
};

export class WorkbenchAssets {
  private readonly jobs = new Map<string, AssetState>();
  private stamp: string | null = null;

  constructor(
    /** `<package>/vscode-web`. */
    private readonly cacheRoot: string,
    /** Install-relative paths the browser loads, for a server reached only over HTTP (`web-files.json`). */
    private readonly downloadList: () => string[],
    private readonly log: (message: string) => void,
    private readonly candidates: (commit: string) => string[] = localInstallCandidates,
    /** This extension's webview host (`webview/index.html`, `webview/host.js`), put in place of VS Code's. */
    private readonly webviewHost: string | null = null,
  ) {}

  /** The cache folder of a commit, relative to the package (what the frame loads from). */
  static folder(commit: string): string {
    return `vscode-web/${commit}`;
  }

  /** Which list a cache made over HTTP came from (the list changes when the VS Code pin moves). */
  private listStamp(): string {
    this.stamp ??= createHash('sha256').update(JSON.stringify(this.downloadList())).digest('hex').slice(0, 16);
    return this.stamp;
  }

  status(commit: string): AssetState {
    const job = this.jobs.get(commit);
    if (job && job.state !== 'ready') return job;
    const marker = join(this.cacheRoot, commit, MARKER);
    if (existsSync(marker)) {
      try {
        const ready = JSON.parse(readFileSync(marker, 'utf8')) as { format?: number; files?: number; source?: 'local' | 'download'; missing?: unknown; list?: string };
        // One made over HTTP has the files its list named: from an older list it lacks those added since, and is
        // prepared again. One made from an install on this machine has all of them.
        if (ready.format === CACHE_FORMAT && (ready.source !== 'download' || ready.list === this.listStamp())) {
          this.refreshWebviewHost(commit);
          const surfaces = Array.isArray(ready.missing) && ready.missing.length === 0;
          return { state: 'ready', path: WorkbenchAssets.folder(commit), files: ready.files ?? 0, source: ready.source ?? 'local', surfaces };
        }
      } catch {
        // A broken marker: prepare again.
      }
    }
    // A cache that was ready but is gone (or older) is prepared again.
    return { state: 'idle' };
  }

  /**
   * A prepared workbench carries this extension's webview host (`pre/`) as it
   * was when it was prepared: a newer one replaces it there, without preparing
   * the whole workbench again.
   */
  private refreshWebviewHost(commit: string): void {
    if (!this.webviewHost) return;
    const pre = join(this.cacheRoot, commit, WEBVIEW_PRE);
    for (const name of WEBVIEW_FILES) {
      try {
        const wanted = readFileSync(join(this.webviewHost, name));
        const target = join(pre, name);
        if (existsSync(target) && readFileSync(target).equals(wanted)) continue;
        mkdirSync(pre, { recursive: true });
        writeFileSync(`${target}.tmp-${process.pid}`, wanted);
        renameSync(`${target}.tmp-${process.pid}`, target);
        this.log(`VS Code ${commit.slice(0, 8)}: webview host ${name} updated`);
      } catch (error) {
        this.log(`could not update the webview host's ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Start preparing (once per commit) and answer at once with the state. */
  prepare(server: VscodeServer, page: ServerPage): AssetState {
    const current = this.status(page.commit);
    if (current.state === 'ready' || current.state === 'preparing') return current;
    const job: AssetState = { state: 'preparing', source: 'local', done: 0, total: 0 };
    this.jobs.set(page.commit, job);
    void this.build(server, page, job).then(
      (done) => this.jobs.set(page.commit, done),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`preparing VS Code ${page.commit.slice(0, 8)} failed: ${message}`);
        this.jobs.set(page.commit, { state: 'failed', error: message });
      },
    );
    return job;
  }

  private async localInstall(commit: string): Promise<string | null> {
    for (const dir of this.candidates(commit)) {
      try {
        const product = JSON.parse(await readFile(join(dir, 'product.json'), 'utf8')) as { commit?: unknown };
        if (product.commit === commit && REQUIRED_SOURCE_FILES.every((file) => existsSync(join(dir, file)))) return dir;
      } catch {
        // Not there, or another build.
      }
    }
    return null;
  }

  private async build(server: VscodeServer, page: ServerPage, job: Extract<AssetState, { state: 'preparing' }>): Promise<AssetState> {
    const local = await this.localInstall(page.commit);
    job.source = local ? 'local' : 'download';
    let sources: string[];
    if (local) {
      sources = [];
      await walk(local, join(local, 'out'), sources);
      for (const module of WEB_NODE_MODULES) await walk(local, join(local, 'node_modules', module), sources);
    } else {
      sources = this.downloadList();
    }
    const wanted = sources.filter((path) => clientFileName(path) !== null);
    const read = async (path: string): Promise<Buffer | null> => (local ? readFile(join(local, path)).catch(() => null) : server.staticFile(page.base, path));
    const codicon = await read('out/media/codicon.ttf');
    if (!codicon) throw new Error('the VS Code Server has no out/media/codicon.ttf');
    job.total = wanted.length;
    const tmp = join(this.cacheRoot, `${page.commit}.tmp-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    try {
      let next = 0;
      let files = 0;
      const missing: string[] = [];
      const worker = async (): Promise<void> => {
        while (next < wanted.length) {
          const path = wanted[next++]!;
          const body = await read(path);
          job.done += 1;
          if (!body) continue;
          const target = join(tmp, clientFileName(path)!);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, transform(path, body, codicon, missing));
          files += 1;
        }
      };
      await Promise.all(Array.from({ length: local ? 1 : DOWNLOADS_AT_ONCE }, worker));
      if (this.webviewHost) {
        const pre = join(tmp, WEBVIEW_PRE);
        await mkdir(pre, { recursive: true });
        for (const name of WEBVIEW_FILES) await writeFile(join(pre, name), await readFile(join(this.webviewHost, name)));
      }
      for (const file of ['out/vs/code/browser/workbench/workbench.js', 'out/vs/code/browser/workbench/workbench.css', 'out/nls.messages.js']) {
        if (!existsSync(join(tmp, file))) throw new Error(`${file} is missing from the VS Code Server`);
      }
      await writeFile(join(tmp, MARKER), JSON.stringify({ format: CACHE_FORMAT, commit: page.commit, files, source: job.source, missing, ...(local ? {} : { list: this.listStamp() }), at: new Date().toISOString() }));
      const final = join(this.cacheRoot, page.commit);
      await rm(final, { recursive: true, force: true });
      await rename(tmp, final);
      await this.prune(page.commit);
      this.log(`VS Code ${page.commit.slice(0, 8)} ready from ${local ?? 'the server'} (${files} files)`);
      // Without them each frame is the whole workbench, as on a stock OpenChamber.
      if (missing.length > 0) this.log(`VS Code ${page.commit.slice(0, 8)}: not in OpenChamber's own surfaces; this release moved ${missing.join(', ')}`);
      return { state: 'ready', path: WorkbenchAssets.folder(page.commit), files, source: job.source, surfaces: missing.length === 0 };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error instanceof PatchError ? new Error(`This VS Code release cannot run inside OpenChamber yet: ${error.message}`) : error;
    }
  }

  /** Keep the newest caches only; leftovers of interrupted builds go too. */
  private async prune(keep: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.cacheRoot);
    } catch {
      return;
    }
    const caches: { name: string; at: number }[] = [];
    for (const name of entries) {
      const path = join(this.cacheRoot, name);
      if (name.includes('.tmp-') && !name.endsWith(`.tmp-${process.pid}`)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (name === keep || !/^[0-9a-f]{40}$/.test(name)) continue;
      caches.push({ name, at: (await stat(path).catch(() => null))?.mtimeMs ?? 0 });
    }
    caches.sort((a, b) => b.at - a.at);
    for (const old of caches.slice(KEEP - 1)) await rm(join(this.cacheRoot, old.name), { recursive: true, force: true });
  }
}

/** A file as the cache stores it; surface patches the workbench lacks are added to `missing`. */
export const transform = (path: string, body: Buffer, codicon: Buffer, missing: string[] = []): Buffer | string => {
  if (path === 'out/vs/code/browser/workbench/workbench.js') return patchWorkbench(body.toString('utf8'), missing);
  if (path === 'out/vs/code/browser/workbench/workbench.css') return patchStylesheet(body.toString('utf8'), codicon.toString('base64'));
  if (path === 'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html') return patchExtensionHostIframe(body.toString('utf8'));
  if (path.endsWith('.js') && path.startsWith('out/')) return patchScript(body.toString('utf8'));
  return body;
};
