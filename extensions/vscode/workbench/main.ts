// The VS Code view (rail panel and page): the compiled workbench of the user's
// own VS Code Server, rendered in this frame. Everything it needs from outside
// (its files, its web sockets, its remote resources, the extension gallery, its
// storage) comes through this extension's service; see `shims.ts`. In an
// OpenChamber with oc-forge's adapters the frame is one part of VS Code (a rail
// view, the page's editor area, the bottom terminal; `surfaces.ts`); in a
// stock one, the whole workbench.
import { connectHost, type HostReadyContext, type JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { connectOcForge } from '../../../adapters/openchamber/client/index.ts';
import type { RailEntry } from '../src/rail.ts';
import { isConnectionToken, parseServerUrl, readOpenRequest, readSettings, type OpenRequest, type VscodeSettings } from '../src/settings.ts';
import { roleOf, roleSettings, type Role } from '../src/surfaces.ts';
import { isExternalAllowed, NARROW_FRAME_CSS, remoteUri, webviewOriginName, workbenchConfiguration, type ServerWorkbenchConfig, type ThemeMode } from '../src/workbench.ts';
import { installBasicShims, installResourceBridge, installWorkerShim, type Answer } from './shims.ts';
import { persistentIndexedDB, IDBKeyRange, saveThroughService, type StateOp, type StateSnapshot } from './storage.ts';
import { prepareSurface, reportExtensionsPath, startSurface, type SurfaceController, type SurfaceRole } from './surfaces.ts';
import { TunnelSocket, type TunnelService } from './tunnel.ts';
import { VscodeServices, type InstantiationService, type StorageService } from './vscode.ts';

const host = connectHost();
// oc-forge's adapters answer at once; a stock OpenChamber never does, and the boot below takes longer than this anyway.
const forgeReady = connectOcForge({ timeoutMs: 1_000 }).catch(() => null);
/** The rail entry "Open in VS Code" shows: the chat's folder in the Explorer. */
const EXPLORER_ENTRY = 'explorer';
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

installBasicShims((url) => void host.openUrl(url).catch(() => {}));

/** POST to the service; its JSON answer, or an error with the service's message. */
const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  const result = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify(body) });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = result.body ? (JSON.parse(result.body) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: the status says enough.
  }
  if (result.status >= 400) throw new Error(typeof parsed.error === 'string' ? parsed.error : `The VS Code service answered ${result.status}.`);
  return parsed as T;
};

type AssetState =
  | { state: 'idle' }
  | { state: 'preparing'; source: 'local' | 'download'; done: number; total: number }
  | { state: 'ready'; path: string; files: number; surfaces?: boolean }
  | { state: 'failed'; error: string };
interface Connected {
  commit: string;
  version: string | null;
  config: ServerWorkbenchConfig;
  assets: AssetState;
}

const root = (): HTMLElement => document.getElementById('oc-boot') as HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child !== null) node.append(child);
  return node;
};

const status = (title: string, detail = '', progress?: number): void => {
  const bar = progress === undefined ? null : el('div', { class: 'bar' }, el('div', { class: 'fill' }));
  if (bar && progress !== undefined) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
  root().replaceChildren(el('div', { class: 'status', role: 'status' }, el('strong', { textContent: title }), detail ? el('p', { class: 'hint', textContent: detail }) : null, bar));
};

/** The settings form: where the VS Code Server answers (as this OpenChamber server reaches it) and its token. */
const showSettings = (settings: VscodeSettings, problem = ''): Promise<VscodeSettings> => new Promise((resolve) => {
  const url = el('input', { type: 'url', value: settings.serverUrl ?? '', placeholder: 'http://vscode:8000', autocomplete: 'off' });
  url.setAttribute('aria-label', 'VS Code Server address');
  const token = el('input', { type: 'password', value: settings.token ?? '', placeholder: 'connection token', autocomplete: 'off' });
  token.setAttribute('aria-label', 'VS Code Server connection token');
  const follow = el('input', { type: 'checkbox', checked: settings.followTheme });
  const error = el('p', { class: 'problem', role: 'alert', textContent: problem });
  // A sandboxed frame without allow-forms never submits a form: a button and Enter do it here.
  const connect = el('button', { type: 'button', textContent: 'Connect' });
  const form = el('div', { class: 'settings', role: 'form' },
    el('h1', { textContent: 'VS Code' }),
    el('p', { class: 'hint', textContent: "VS Code runs here, inside OpenChamber: the workbench of your own VS Code Server for the web (code serve-web, or the server the oc-forge dev container runs). Its files, terminal and extensions are the server's." }),
    el('label', {}, 'Address, as the machine running OpenChamber reaches it', url),
    el('label', {}, 'Connection token', token),
    el('label', { class: 'inline' }, follow, "Start in OpenChamber's light or dark look"),
    error,
    el('div', { class: 'row' }, connect),
    el('p', { class: 'hint', textContent: 'In the oc-forge dev container: http://vscode:8000, with VSCODE_CONNECTION_TOKEN from its secrets file.' }),
  );
  for (const input of [url, token]) input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect.click();
  });
  connect.addEventListener('click', () => {
    const address = parseServerUrl(url.value);
    if (!address) {
      error.textContent = 'That is not an http(s) address of a server, like http://vscode:8000.';
      return;
    }
    const typed = token.value.trim();
    if (typed && !isConnectionToken(typed)) {
      error.textContent = 'A connection token is letters, digits and . _ ~ - only.';
      return;
    }
    const next: VscodeSettings = { serverUrl: address, token: typed || null, followTheme: follow.checked };
    void host.storage.set('settings', next as unknown as JsonValue).then(() => resolve(next));
  });
  root().replaceChildren(form);
  url.focus();
});

const ready = new Promise<HostReadyContext>((resolve) => {
  const stop = host.onReady((context) => {
    stop();
    resolve(context);
  });
});

/** The latest host context: the folder OpenChamber shows and its theme. */
let context: HostReadyContext;
const modeOf = (ctx: HostReadyContext): ThemeMode => (ctx.theme.mode === 'dark' ? 'dark' : 'light');

const pendingOpen = async (): Promise<OpenRequest | null> => readOpenRequest(await host.storage.get('open-request').catch(() => undefined));

const boot = async (): Promise<void> => {
  context = await ready;
  applyHostReady(context, document.documentElement);
  if (context.surface === 'background') return;
  let settings = readSettings(await host.storage.get('settings').catch(() => undefined));
  const forceSettings = (await host.storage.get('show-settings').catch(() => undefined)) === true;
  if (forceSettings) await host.storage.delete('show-settings').catch(() => {});
  if (!settings.serverUrl || forceSettings) settings = await showSettings(settings);
  let connected: Connected;
  for (;;) {
    status('Connecting to VS Code…', settings.serverUrl ?? '');
    try {
      connected = await call<Connected>('/connect', { serverUrl: settings.serverUrl, token: settings.token });
      break;
    } catch (error) {
      settings = await showSettings(settings, messageOf(error));
    }
  }
  const server = { serverUrl: settings.serverUrl, token: settings.token };
  let assets = connected.assets;
  const label = `VS Code ${connected.version ?? connected.commit.slice(0, 8)}`;
  while (assets.state !== 'ready') {
    if (assets.state === 'failed') {
      status(`${label} could not be prepared`, assets.error);
      return;
    }
    if (assets.state === 'preparing') {
      status(`Preparing ${label} for OpenChamber…`, assets.source === 'local' ? 'Copying its workbench from the install on this machine (once per VS Code version).' : 'Downloading its workbench from the VS Code Server (once per VS Code version).', assets.total ? assets.done / assets.total : 0);
    }
    await new Promise((resolve) => setTimeout(resolve, assets.state === 'idle' ? 0 : 400));
    assets = (await call<{ assets: AssetState }>('/assets/prepare', server)).assets;
  }
  status(`Starting ${label}…`);

  // Which part of VS Code this frame is: the whole workbench on a stock OpenChamber.
  const forge = await forgeReady;
  const role: Role = roleOf(forge?.hello ?? null, assets.surfaces === true);
  const surfaceRole: SurfaceRole | null = role === 'classic' ? null : role;
  if (forge && !surfaceRole) forge.dispose();
  const strip = forge?.tabs.state().strip ?? true;
  // For the end-to-end check's measurements: which part this frame is, and (below) when its workbench ran.
  document.documentElement.dataset.ocVscodeRole = role;

  // Storage first: VS Code reads its settings from IndexedDB as it starts. Each part keeps its own layout.
  const stateRole = surfaceRole ? { role: surfaceRole } : {};
  const snapshot = await call<StateSnapshot>('/state/load', { ...server, ...stateRole }).catch((): StateSnapshot => ({ format: 1, dbs: {} }));
  const storage = persistentIndexedDB(snapshot, async (ops: StateOp[]) => {
    await call('/state/apply', { ...server, ...stateRole, ops });
  });
  await storage.ready;
  Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => storage.factory });
  Object.defineProperty(window, 'IDBKeyRange', { configurable: true, get: () => IDBKeyRange });
  window.addEventListener('pagehide', () => void storage.flush());
  // VS Code's own save before a reload, once its services are there (saveThroughService).
  let saveBeforeReload = (): Promise<void> => storage.flush();

  const authority = connected.config.remoteAuthority ?? '';
  installWorkerShim();
  installResourceBridge({
    authority,
    serverGet: (path) => call<Answer>('/remote/get', { ...server, path }),
    externalFetch: (url, init) => call<Answer>('/external/fetch', { url, method: init.method, headers: init.headers, body: init.body }),
    isExternal: isExternalAllowed,
    openUrl: (url) => void host.openUrl(url).catch(() => {}),
  });

  // The panel and the page each answer an "Open in VS Code" request once. In OpenChamber's own surfaces the
  // rail view answers it; the page and the terminal follow the folder it shows.
  const answersOpen = !surfaceRole || surfaceRole === 'view';
  const handledKey = `handled-open:${surfaceRole ?? context.surface}`;
  const handledBefore = Number((await host.storage.get(handledKey).catch(() => 0)) ?? 0);
  const open = answersOpen ? await pendingOpen() : null;
  const fresh = open && open.at > handledBefore && Date.now() - open.at < 120_000 ? open : null;
  if (fresh) await host.storage.set(handledKey, fresh.at).catch(() => {});
  const storedFolder = await host.storage.get('folder').catch(() => undefined);
  const folder = fresh?.folder ?? (typeof storedFolder === 'string' && storedFolder.startsWith('/') ? storedFolder : null) ?? context.directory;
  if (surfaceRole && fresh && fresh.folder !== storedFolder) await host.storage.set('folder', fresh.folder).catch(() => {});
  const configuration = workbenchConfiguration(connected.config, { folder, token: settings.token, mode: modeOf(context), followTheme: settings.followTheme, defaults: roleSettings(role, strip) });

  // This frame's sockets share one poll (tunnel.ts, FramePoll). Not crypto.randomUUID: plain HTTP is no secure context.
  const poller = [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const service: TunnelService = {
    open: async (path) => (await call<{ id: string }>('/tunnel/open', { ...server, path, poller })).id,
    send: (id, chunks) => call('/tunnel/send', { id, chunks }),
    receive: (ids) => call('/tunnel/recv', { poller, ids }),
    close: async (id) => {
      await call('/tunnel/close', { id });
    },
  };
  const reloadWith = async (nextFolder: string | null, request?: OpenRequest): Promise<void> => {
    await saveBeforeReload().catch(() => {});
    if (nextFolder) await host.storage.set('folder', nextFolder).catch(() => {});
    else await host.storage.delete('folder').catch(() => {});
    if (request) await host.storage.set('open-request', request as unknown as JsonValue).catch(() => {});
    location.reload();
  };
  let workbench: { commands: { executeCommand: (id: string, ...args: unknown[]) => Promise<unknown> }; window: { showInformationMessage: (message: string, ...items: string[]) => Promise<string | undefined> } } | null = null;
  let markRunning: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  let markServices: (services: VscodeServices) => void = () => {};
  const servicesReady = new Promise<VscodeServices>((resolve) => {
    markServices = resolve;
  });
  const hooks: Record<string, unknown> = {
    connectionToken: settings.token ?? undefined,
    originHash: async (parentOrigin: string, salt: string) => webviewOriginName(parentOrigin, salt),
    // VS Code keeps its Cmd/Ctrl+digit and Cmd/Ctrl+Alt+arrow keys inside OpenChamber (VS Code for the web drops them in a browser tab).
    keyboard: true,
    // A rail view is its view container alone: no editor area and no panel.
    bare: surfaceRole === 'view',
    services: (instantiation: InstantiationService) => {
      const ids = hooks.serviceIds;
      if (!(ids instanceof Map)) return;
      const services = new VscodeServices(instantiation, ids);
      if (surfaceRole) prepareSurface(surfaceRole, services);
      try {
        saveBeforeReload = saveThroughService(services.get<StorageService>('storageService'), storage.flush);
      } catch (error) {
        console.warn('[OpenChamber VS Code] VS Code saves its state before a reload without waiting for the service', error);
      }
      markServices(services);
    },
    workbench: (handle: typeof workbench) => {
      workbench = handle;
      document.documentElement.dataset.ocVscodeStarted = String(Math.round(performance.now()));
      markRunning();
    },
    options: (options: Record<string, unknown>) => {
      const original = options.workspaceProvider as Record<string, unknown> & { workspace?: unknown };
      const payload: [string, string][] = [];
      // A rail view hands the file to the page once it runs (below).
      if (fresh?.file && authority && !surfaceRole) {
        const target = remoteUri(authority, fresh.file);
        payload.push(['openFile', `vscode-remote://${target.authority}${encodeURI(target.path)}${fresh.line ? `:${fresh.line}` : ''}`]);
        if (fresh.line) payload.push(['gotoLineMode', 'true']);
      }
      const workspaceProvider = new Proxy(original, {
        get: (target, property) => {
          if (property === 'trusted') return true;
          if (property === 'payload') return payload.length ? payload : target.payload;
          if (property === 'open') {
            // "Open Folder…" and recent folders: this view switches to that folder.
            return async (workspace: { folderUri?: { path: string; scheme: string } } | undefined) => {
              await reloadWith(workspace?.folderUri?.scheme === 'vscode-remote' ? workspace.folderUri.path : null);
              return true;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      return {
        ...options,
        webSocketFactory: { create: (url: string) => new TunnelSocket(url, service) },
        // Webviews (Markdown preview, extension pages) load this extension's host page from the prepared workbench.
        webviewEndpoint: `${cache}out/vs/workbench/contrib/webview/browser/pre`,
        workspaceProvider,
        windowIndicator: { label: '$(remote) OpenChamber', tooltip: `VS Code on ${settings.serverUrl}, inside OpenChamber` },
        commands: [
          { id: 'openchamber.vscode.settings', label: 'OpenChamber: VS Code Server Connection…', handler: async () => {
            await host.storage.set('show-settings', true);
            await saveBeforeReload().catch(() => {});
            location.reload();
          } },
          { id: 'openchamber.vscode.followFolder', label: "OpenChamber: Open OpenChamber's Folder", handler: async () => {
            await reloadWith(context.directory);
          } },
        ],
      };
    },
  };
  (globalThis as Record<string, unknown>).__ocVSCode = hooks;

  // VS Code's own page carries these; this frame is that page now.
  const meta = document.createElement('meta');
  meta.id = 'vscode-workbench-web-configuration';
  meta.setAttribute('data-settings', JSON.stringify(configuration));
  document.head.append(meta);
  const cache = new URL(`../${assets.path}/`, document.baseURI).href;
  (globalThis as Record<string, unknown>)._VSCODE_FILE_ROOT = `${cache}out/`;
  const stylesheet = el('link', { rel: 'stylesheet', href: `${cache}out/vs/code/browser/workbench/workbench.css` });
  await new Promise<void>((resolve) => {
    stylesheet.addEventListener('load', () => resolve(), { once: true });
    stylesheet.addEventListener('error', () => resolve(), { once: true });
    document.head.append(stylesheet);
  });
  // A part's frame can be narrower than VS Code's dialogs: they fit it.
  document.head.append(el('style', { id: 'oc-vscode-narrow', textContent: NARROW_FRAME_CSS }));
  root().remove();
  document.body.setAttribute('aria-label', '');
  try {
    await import(/* @vite-ignore */ `${cache}out/nls.messages.js`);
    await import(/* @vite-ignore */ `${cache}out/vs/code/browser/workbench/workbench.js`);
  } catch (error) {
    document.body.append(el('div', { id: 'oc-boot' }));
    status(`${label} did not start`, messageOf(error));
    return;
  }

  // OpenChamber's own surfaces, once VS Code runs: this frame's part, and where the server keeps its extensions for the rail.
  const openFileAt = (file: string, line?: number) => workbench?.commands.executeCommand('_workbench.open', remoteUri(authority, file), [undefined, { pinned: true, ...(line ? { selection: { startLineNumber: line, startColumn: 1 } } : {}) }]);
  let surface: SurfaceController = {};
  void Promise.all([servicesReady, running]).then(async ([services]) => {
    const serviceCall = <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => call<T>(path, { ...server, ...body });
    void reportExtensionsPath(services, serviceCall).catch(() => {});
    if (!surfaceRole || !forge) return;
    surface = await startSurface({
      role: surfaceRole,
      forge,
      services,
      folder,
      call: serviceCall,
      saveState: () => saveBeforeReload(),
      railEntries: async () => {
        const answer = await host.serviceRequest({ method: 'GET', path: '/rail' });
        return ((JSON.parse(answer.body || '{}') as { entries?: RailEntry[] }).entries ?? []);
      },
      openUrl: (url) => void host.openUrl(url).catch(() => {}),
    });
    // "Open in VS Code" from a chat: the rail view shows that folder in the Explorer, and hands a file to the page.
    if (surfaceRole === 'view' && fresh) {
      await surface.showEntry?.(EXPLORER_ENTRY);
      if (fresh.file) await openFileAt(fresh.file, fresh.line);
    }
  }).catch((error) => console.warn('[OpenChamber VS Code] the surface did not start', error));

  // OpenChamber's look follows into VS Code when it changes; its folder is offered.
  let shownFolder = folder;
  let asked: string | null = null;
  host.onReady((next) => {
    const before = modeOf(context);
    context = next;
    applyHostReady(next, document.documentElement);
    const dark = document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') ?? false;
    if (settings.followTheme && modeOf(next) !== before && (modeOf(next) === 'dark') !== dark) void workbench?.commands.executeCommand('workbench.action.toggleLightDarkThemes');
    const directory = next.directory;
    if (answersOpen && directory && directory !== shownFolder && directory !== asked && workbench) {
      asked = directory;
      void workbench.window.showInformationMessage(`OpenChamber is now in ${directory}.`, 'Open it here').then((choice) => {
        if (choice) void reloadWith(directory);
      });
    }
  });

  // "Open in VS Code" from a chat, the file view or elsewhere: shown here.
  let handled = fresh?.at ?? handledBefore;
  setInterval(() => {
    if (!answersOpen) {
      // The page and the terminal follow the folder the rail view shows.
      void host.storage.get('folder').catch(() => undefined).then(async (stored) => {
        if (typeof stored === 'string' && stored.startsWith('/') && stored !== shownFolder) {
          shownFolder = stored;
          // VS Code saves first: closing the page's last tab ends the page at once.
          await saveBeforeReload().catch(() => {});
          await surface.beforeFolderChange?.().catch(() => {});
          await reloadWith(stored);
        }
      });
      return;
    }
    void pendingOpen().then(async (request) => {
      if (!request || request.at <= handled) return;
      handled = request.at;
      await host.storage.set(handledKey, request.at).catch(() => {});
      if (request.folder !== shownFolder) {
        shownFolder = request.folder;
        // The rail view comes back on the Explorer of the new folder.
        if (surfaceRole === 'view') await forge?.rail.setActive(EXPLORER_ENTRY).catch(() => {});
        await reloadWith(request.folder, request);
        return;
      }
      if (surfaceRole === 'view') await surface.showEntry?.(EXPLORER_ENTRY);
      if (request.file && workbench) await openFileAt(request.file, request.line);
    });
  }, 1500);
};

void boot().catch((error) => {
  if (root()) status('VS Code did not start', messageOf(error));
});
