// VS Code's parts in OpenChamber's own surfaces (oc-forge's adapters,
// `adapters/openchamber`): each frame is a workbench of its own, connected to
// the same VS Code Server, in one role (`src/surfaces.ts`):
//   view      the rail panel: one view container at a time, the one the rail's entry names
//   editor    the page, in OpenChamber's main area: the editor area; its editors are header tabs
//   terminal  the terminal entry's own panel at the bottom: VS Code's panel, maximized
// Frames reach each other only through OpenChamber: an editor opened in a
// view or the terminal becomes a header tab, which shows the page, which opens
// the editor; what to open waits in the extension's service.
import type { OcForgeClient, OcForgeTab } from '../../../adapters/openchamber/client/index.ts';
import { entryOfView, type RailEntry } from '../src/rail.ts';
import {
  editorKeyOf,
  editorRoute,
  isPortable,
  marshal,
  readEditorRoute,
  readOpenRequest,
  requestTitle,
  roleSettings,
  tabIcon,
  tabTitle,
  unmarshal,
  type OpenRequest,
  type Role,
} from '../src/surfaces.ts';
import {
  isEditorInput,
  MEMORY_TARGET,
  PARTS,
  SIDEBAR,
  type CommandService,
  type ConfigurationService,
  type EditorGroupsService,
  type EditorIdentifier,
  type EditorInput,
  type EditorService,
  type FileService,
  type LayoutService,
  type PaneCompositePartService,
  type Part,
  type RemoteAgentService,
  type ViewsService,
  type VscodeServices,
} from './vscode.ts';

export type SurfaceRole = Exclude<Role, 'classic'>;

export interface SurfaceContext {
  role: SurfaceRole;
  forge: OcForgeClient;
  services: VscodeServices;
  /** A POST to this extension's service, the server named. */
  call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  /** The service's rail entries (`GET /rail`), with the view container each shows. */
  railEntries: () => Promise<RailEntry[]>;
  openUrl: (url: string) => void;
}

const log = (message: string, error?: unknown): void => console.warn(`[OpenChamber VS Code] ${message}`, error ?? '');
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Layout ──────────────────────────────────────────────────────────────

const hide = (layout: LayoutService, part: Part): void => {
  if (layout.isVisible(part)) layout.setPartHidden(true, part);
};
const show = (layout: LayoutService, part: Part): void => {
  if (!layout.isVisible(part)) layout.setPartHidden(false, part);
};

/**
 * The parts a role shows. For a view, the panel goes before the editor area:
 * hiding the panel while the editor area is hidden would bring it back (VS
 * Code un-maximizes the panel first), and the editor area hides with the
 * panel hidden only because of the `bare` patch.
 */
export const applyRoleLayout = (role: SurfaceRole, services: VscodeServices, hasEditors = () => false): void => {
  const layout = services.get<LayoutService>('layoutService');
  hide(layout, PARTS.auxiliarybar);
  if (role === 'view') {
    hide(layout, PARTS.panel);
    if (!hasEditors()) hide(layout, PARTS.editor);
    show(layout, PARTS.sidebar);
  } else if (role === 'editor') {
    hide(layout, PARTS.sidebar);
    hide(layout, PARTS.panel);
  } else {
    hide(layout, PARTS.sidebar);
    show(layout, PARTS.panel);
    if (!layout.isPanelMaximized()) layout.toggleMaximizedPanel();
  }
};

/** The role's settings above the user's, in memory: `undefined` removes one. */
const applySettings = async (services: VscodeServices, settings: Record<string, unknown>, previous: Record<string, unknown> = {}): Promise<void> => {
  const configuration = services.get<ConfigurationService>('configurationService');
  for (const key of Object.keys(previous)) if (!(key in settings)) await configuration.updateValue(key, undefined, MEMORY_TARGET).catch(() => undefined);
  for (const [key, value] of Object.entries(settings)) await configuration.updateValue(key, value, MEMORY_TARGET).catch((error) => log(`could not set ${key}`, error));
};

/** Keeps a view's or the terminal's layout: VS Code may bring parts back (a toggle, an editor opening). */
const keepLayout = (role: SurfaceRole, services: VscodeServices, hasEditors: () => boolean): void => {
  const layout = services.get<LayoutService>('layoutService');
  const editors = services.get<EditorService>('editorService');
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      try {
        applyRoleLayout(role, services, hasEditors);
      } catch (error) {
        log('could not keep the layout', error);
      }
    });
  };
  layout.onDidChangePartVisibility(again);
  editors.onDidEditorsChange(again);
};

// ── Keys ────────────────────────────────────────────────────────────────

/**
 * VS Code takes the keys while it has focus. A press it has no binding for
 * (it didn't prevent its default) that OpenChamber binds to navigation (its
 * close-tab key, its rail digits) goes to OpenChamber: those tabs and that
 * rail are OpenChamber's.
 */
const forwardUnhandledKeys = (forge: OcForgeClient): void => {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || !forge.has('keys')) return;
    const action = forge.keys.match(event);
    if (!action) return;
    event.preventDefault();
    void forge.keys.forward(event).catch(() => undefined);
  });
};

// ── Handing editors to the page ─────────────────────────────────────────

interface Handoff {
  key: string;
  title: string;
  icon: string;
  open: OpenRequest;
  /** The page's address for it, for a new browser tab. */
  route: string | null;
}

const FILE_INPUTS = new Set(['workbench.editors.files.fileEditorInput', 'workbench.editors.untitledEditorInput', 'workbench.editors.resourceEditorInput']);

/** The header tab of an editor open in a workbench. */
export const keyOfEditor = (editor: EditorInput): string => {
  let untyped: unknown;
  try {
    untyped = editor.toUntyped();
  } catch {
    untyped = undefined;
  }
  const record = untyped as Record<string, unknown> | undefined;
  if (record && (record.original || record.multiDiffSource)) {
    const key = editorKeyOf(record);
    if (key) return key;
  }
  if (editor.resource) return editorKeyOf({ resource: editor.resource }, FILE_INPUTS.has(editor.typeId) ? undefined : editor.typeId)!;
  return `${editor.typeId}|${editor.getName()}`;
};

const isGroup = (value: unknown): boolean => typeof value === 'number' || (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number');
const selectionLine = (options: unknown): number | undefined => {
  const line = (options as { selection?: { startLineNumber?: unknown } } | undefined)?.selection?.startLineNumber;
  return typeof line === 'number' && line > 0 ? line : undefined;
};

/** What the page should open instead of this frame, or null to open it here. */
const handoffOf = (editor: unknown, optionsOrGroup: unknown): Handoff | null => {
  const options = optionsOrGroup && !isGroup(optionsOrGroup) ? optionsOrGroup : undefined;
  let untyped: Record<string, unknown> | undefined;
  if (isEditorInput(editor)) {
    // Editors with no resource to name them: the page opens them the way VS Code's own commands do.
    const id = editor.extension?.identifier?.id;
    if (editor.typeId === 'workbench.extensions.input2' && id) {
      return { key: `open|${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: tabTitle(editor.getName()), icon: 'puzzle', open: { kind: 'command', command: 'extension.open', args: [id] }, route: null };
    }
    try {
      untyped = editor.toUntyped() as Record<string, unknown> | undefined;
    } catch {
      untyped = undefined;
    }
  } else if (typeof editor === 'object' && editor !== null) {
    untyped = editor as Record<string, unknown>;
  }
  if (!untyped || !isPortable(untyped)) return null;
  // Header tabs have no preview state: what opens stays open.
  const merged = { ...untyped, options: { ...(untyped.options as object | undefined), ...(options as object | undefined), pinned: true } };
  const key = editorKeyOf(merged);
  if (!key) return null;
  const line = selectionLine(merged.options);
  return { key, title: requestTitle(merged), icon: tabIcon(key), open: { kind: 'editor', editor: marshal(merged) }, route: editorRoute(key, line) };
};

/** A Cmd/Ctrl+click just now: what it opens goes to a new browser tab, not over the current view. */
const modifiedClicks = (): (() => boolean) => {
  let at = -Infinity;
  const note = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) at = performance.now();
  };
  window.addEventListener('mousedown', note, true);
  window.addEventListener('mouseup', note, true);
  return () => performance.now() - at < 1_000;
};

/**
 * In a view or the terminal, editors open in the page: the frame's
 * openEditor/openEditors hand them over (the editor, its selection) and open
 * their header tab, which shows the page. What can't be handed over (a
 * webview, an extension's own editor) opens here.
 */
const handEditorsToPage = (context: SurfaceContext): void => {
  const editorService = context.services.get<EditorService>('editorService');
  const openEditor = editorService.openEditor.bind(editorService);
  const openEditors = editorService.openEditors.bind(editorService);
  const modified = modifiedClicks();
  const hand = async (handoff: Handoff): Promise<void> => {
    const url = handoff.route && modified() ? context.forge.links.pageUrl(handoff.route) : null;
    if (url) {
      context.openUrl(url);
      return;
    }
    try {
      await context.call('/editors/request', { key: handoff.key, open: handoff.open });
      await context.forge.tabs.open({ id: handoff.key, title: handoff.title, icon: handoff.icon }, { activate: true });
    } catch (error) {
      log('could not hand the editor to the page', error);
    }
  };
  editorService.openEditor = (editor, optionsOrGroup, group) => {
    const handoff = handoffOf(editor, optionsOrGroup);
    if (!handoff) return openEditor(editor, optionsOrGroup, group);
    void hand(handoff);
    return Promise.resolve(undefined);
  };
  editorService.openEditors = (editors, group, options) => {
    const here: unknown[] = [];
    for (const item of editors) {
      const typed = (item as { editor?: unknown }).editor;
      const handoff = isEditorInput(typed) ? handoffOf(typed, (item as { options?: unknown }).options) : handoffOf(item, undefined);
      if (handoff) void hand(handoff);
      else here.push(item);
    }
    return here.length > 0 ? openEditors(here, group, options) : Promise.resolve([]);
  };
  // An editor opened past openEditor (straight into a group): handed over all the same.
  let queued = false;
  editorService.onDidEditorsChange(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const identifier of editorService.getEditors(1)) {
        if (identifier.editor.isDirty()) continue;
        const handoff = handoffOf(identifier.editor, undefined);
        if (!handoff) continue;
        void hand(handoff);
        void editorService.closeEditor(identifier, { preserveFocus: true }).catch(() => undefined);
      }
    });
  });
};

const editorsOf = (services: VscodeServices): readonly EditorIdentifier[] => services.get<EditorService>('editorService').getEditors(1);

// ── The rail view ───────────────────────────────────────────────────────

const startView = async (context: SurfaceContext): Promise<void> => {
  const { forge, services } = context;
  const views = services.get<ViewsService>('viewsService');
  const panes = services.get<PaneCompositePartService>('paneCompositePartService');
  let entries = await context.railEntries().catch(() => [] as RailEntry[]);
  let showing: string | null = null;
  const showEntry = async (entry: string): Promise<void> => {
    showing = entry;
    let target = entries.find((item) => item.id === entry);
    if (!target) {
      entries = await context.railEntries().catch(() => entries);
      target = entries.find((item) => item.id === entry);
    }
    if (!target?.view) return;
    applyRoleLayout('view', services, () => editorsOf(services).length > 0);
    // An extension installed a moment ago registers its view container once its host has it.
    for (let attempt = 0; attempt < 30 && showing === entry; attempt++) {
      if (await views.openViewContainer(target.view, true).catch(() => null)) return;
      await later(500);
    }
    if (showing === entry) services.get<{ info(message: string): void }>('notificationService').info(`${target.title} isn't in this VS Code yet.`);
  };
  forge.rail.onEntry((entry) => void showEntry(entry));
  // VS Code switched view containers by itself (Ctrl+Shift+F, "Reveal in Explorer"): the rail follows.
  panes.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
    if (viewContainerLocation !== SIDEBAR) return;
    const entry = entryOfView(entries, composite.getId());
    if (!entry || entry === forge.rail.entry()) return;
    showing = entry;
    void forge.rail.setActive(entry).catch(() => undefined);
  });
  await services.get<EditorGroupsService>('editorGroupsService').whenRestored;
  const entry = forge.rail.entry();
  if (entry) await showEntry(entry);
  // After OpenChamber reloads, the page's tabs come back with the rail view, which starts the page behind them.
  if (forge.has('tabs') && forge.tabs.state().list.length === 0) {
    const saved = await context.call<{ tabs?: OcForgeTab[] }>('/tabs/load').catch(() => ({ tabs: [] }));
    for (const tab of saved.tabs ?? []) await forge.tabs.open(tab).catch(() => undefined);
  }
};

// ── The bottom terminal ─────────────────────────────────────────────────

const startTerminal = async (context: SurfaceContext): Promise<void> => {
  await context.services.get<EditorGroupsService>('editorGroupsService').whenRestored;
  applyRoleLayout('terminal', context.services);
  // Opens a terminal when there is none.
  await context.services.get<CommandService>('commandService').executeCommand('workbench.action.terminal.focus').catch((error) => log('could not open the terminal', error));
};

// ── The page: the editor area, its editors as header tabs ───────────────

class EditorArea {
  private readonly editorService: EditorService;
  private readonly openEditor: EditorService['openEditor'];
  private hostTabs = new Map<string, OcForgeTab>();
  /** Keys that were editors here: only those tabs are closed when their editor goes. */
  private readonly adopted = new Set<string>();
  private shown: boolean;
  private strip: boolean;
  private settings: Record<string, unknown> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private again = false;
  private route: string | null = null;
  private saved = '';
  /** VS Code's active editor at the last sync: only a change made in VS Code moves the header's selection. */
  private lastActive: string | null = null;
  /** A tab OpenChamber is showing: its editor is on its way, the header is right already. */
  private showing = 0;

  constructor(private readonly context: SurfaceContext) {
    this.editorService = context.services.get<EditorService>('editorService');
    this.openEditor = this.editorService.openEditor.bind(this.editorService);
    const state = context.forge.tabs.state();
    this.hostTabs = new Map(state.list.map((tab) => [tab.id, tab]));
    this.shown = state.shown;
    this.strip = state.strip;
  }

  /** Restored, with the VS Code Server's files reachable: before that, a file would open as a plain text resource. */
  private ready: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    const { forge, services } = this.context;
    this.ready = (async () => {
      await services.get<EditorGroupsService>('editorGroupsService').whenRestored;
      await services.get<FileService>('fileService').activateProvider('vscode-remote').catch(() => undefined);
    })();
    this.settings = roleSettings('editor', this.strip);
    await applySettings(services, this.settings);
    forge.tabs.onChange((state) => {
      this.hostTabs = new Map(state.list.map((tab) => [tab.id, tab]));
      this.shown = state.shown;
      if (state.strip !== this.strip) {
        this.strip = state.strip;
        const next = roleSettings('editor', this.strip);
        void applySettings(services, next, this.settings);
        this.settings = next;
      }
      this.schedule();
    });
    forge.tabs.onActivate((id) => void this.show(id).catch((error) => log('could not show the tab', error)));
    forge.tabs.onClose((id) => void this.closeFromHeader(id).catch((error) => log('could not close the editor', error)));
    forge.links.onRoute((route) => void this.openRoute(route));
    await this.ready;
    this.editorService.onDidEditorsChange(() => this.schedule());
    this.editorService.onDidActiveEditorChange(() => this.schedule());
    await this.sync();
    const state = forge.tabs.state();
    if (state.active && (state.shown || !this.strip)) await this.show(state.active);
    else if (forge.links.route()) await this.openRoute(forge.links.route());
  }

  private current(): Map<string, { identifier: EditorIdentifier; title: string; dirty: boolean }> {
    const current = new Map<string, { identifier: EditorIdentifier; title: string; dirty: boolean }>();
    for (const identifier of this.editorService.getEditors(1)) {
      const key = keyOfEditor(identifier.editor);
      if (!current.has(key)) current.set(key, { identifier, title: tabTitle(identifier.editor.getName()), dirty: identifier.editor.isDirty() });
    }
    return current;
  }

  private activeKey(): string | null {
    const active = this.editorService.activeEditor;
    return active ? keyOfEditor(active) : null;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync().catch((error) => log('could not update the header tabs', error));
    }, 30);
  }

  /** The header follows the editors: their tabs, titles, unsaved dots, the active one. */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    const { forge } = this.context;
    try {
      const current = this.current();
      for (const [key, item] of current) {
        this.adopted.add(key);
        const tab: OcForgeTab = { id: key, title: item.title, icon: tabIcon(key), dirty: item.dirty };
        const host = this.hostTabs.get(key);
        if (host && host.title === tab.title && Boolean(host.dirty) === tab.dirty && host.icon === tab.icon) continue;
        await forge.tabs.open(tab);
        this.hostTabs.set(key, tab);
      }
      // Activate before closing: closing the shown tab would move the page to OpenChamber's choice of neighbour.
      // Only for a change made in VS Code (Ctrl+Tab, Go to Definition): a click on a header tab is OpenChamber's and on its way here.
      const active = this.activeKey();
      const changed = active !== this.lastActive;
      if (this.showing === 0) this.lastActive = active;
      if (active && changed && this.showing === 0 && this.shown && forge.tabs.state().active !== active && current.has(active)) await forge.tabs.activate(active);
      for (const key of [...this.hostTabs.keys()]) {
        if (current.has(key) || !this.adopted.has(key)) continue;
        await forge.tabs.close(key);
        this.hostTabs.delete(key);
        this.adopted.delete(key);
      }
      const route = active ? editorRoute(active) : null;
      if (route !== this.route && this.shown) {
        this.route = route;
        if (route) await forge.links.setRoute(route).catch(() => undefined);
      }
      const saved = JSON.stringify([...current].map(([id, item]) => ({ id, title: item.title, icon: tabIcon(id) })));
      if (saved !== this.saved) {
        this.saved = saved;
        void this.context.call('/tabs/save', { tabs: JSON.parse(saved) }).catch(() => undefined);
      }
    } finally {
      this.syncing = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  /** OpenChamber shows the page on this tab: its editor, maybe one another frame asked for. */
  private async show(id: string): Promise<void> {
    this.showing += 1;
    try {
      await this.ready;
      const taken = await this.context.call<{ open?: unknown }>('/editors/take', { key: id }).catch(() => ({ open: null }));
      const request = readOpenRequest(taken.open);
      if (request) {
        await this.open(request, id);
        return;
      }
      const found = this.current().get(id);
      if (found) {
        if (this.activeKey() !== id) await this.openEditor(found.identifier.editor, { preserveFocus: false }, found.identifier.groupId);
        return;
      }
      // A tab brought back after a reload, or a deep link: its editor by the key alone.
      if (!(await this.openKey(id))) {
        await this.context.forge.tabs.close(id).catch(() => undefined);
        this.hostTabs.delete(id);
      }
    } finally {
      this.showing -= 1;
      if (this.showing === 0) this.lastActive = this.activeKey();
      this.schedule();
    }
  }

  private async open(request: OpenRequest, key: string): Promise<void> {
    const { services } = this.context;
    if (request.kind === 'command') {
      await services.get<CommandService>('commandService').executeCommand(request.command, ...request.args);
    } else {
      const uri = services.uriClass();
      await this.openEditor(unmarshal(request.editor, (components) => uri.revive(components)));
    }
    // The editor it became may be named otherwise (an extension's page): its own tab replaces this one.
    if (this.activeKey() !== key && !this.adopted.has(key)) {
      await this.context.forge.tabs.close(key).catch(() => undefined);
      this.hostTabs.delete(key);
    }
    this.schedule();
  }

  private async openKey(key: string, line?: number | null): Promise<boolean> {
    const uri = this.context.services.uriClass();
    const options = { pinned: true, ...(line ? { selection: { startLineNumber: line, startColumn: 1 } } : {}) };
    if (key.startsWith('diff:')) {
      const [original, modified] = key.slice('diff:'.length).split(' ');
      if (!original || !modified) return false;
      await this.openEditor({ original: { resource: uri.parse(original) }, modified: { resource: uri.parse(modified) }, options });
      return true;
    }
    if (key.includes('|') || key.startsWith('changes:') || !/^[a-z][\w+.-]*:\S+$/i.test(key)) return false;
    await this.openEditor({ resource: uri.parse(key), options });
    return true;
  }

  private async openRoute(route: string | null): Promise<void> {
    const target = readEditorRoute(route);
    if (!target) return;
    await this.ready;
    const found = this.current().get(target.key);
    if (found) await this.openEditor(found.identifier.editor, { preserveFocus: false }, found.identifier.groupId);
    else await this.openKey(target.key, target.line).catch((error) => log('could not open the linked editor', error));
  }

  /** The user closed the tab in the header: close its editors (one per group), asking to save as VS Code does. A cancel brings the tab back. */
  private async closeFromHeader(id: string): Promise<void> {
    this.hostTabs.delete(id);
    const editors = this.editorService.getEditors(1).filter((identifier) => keyOfEditor(identifier.editor) === id);
    for (const identifier of editors) await this.editorService.closeEditor(identifier);
    this.schedule();
  }
}

// ── Start ───────────────────────────────────────────────────────────────

/** Called with the workbench's services as it starts, before it restores its parts. */
export const prepareSurface = (role: SurfaceRole, services: VscodeServices): void => {
  try {
    applyRoleLayout(role, services);
  } catch (error) {
    log('could not lay the workbench out', error);
  }
};

/** Called once the workbench runs. */
export const startSurface = async (context: SurfaceContext): Promise<void> => {
  const { role, services } = context;
  // The page's depend on the header's strip, and follow it (EditorArea).
  if (role !== 'editor') await applySettings(services, roleSettings(role));
  forwardUnhandledKeys(context.forge);
  // Restoring the last view container shows the side bar again: the role's layout once more, after.
  void services.get<LayoutService>('layoutService').whenRestored.then(() => {
    try {
      applyRoleLayout(role, services, () => role === 'view' && editorsOf(services).length > 0);
    } catch (error) {
      log('could not lay the workbench out', error);
    }
  });
  if (role === 'editor') {
    await new EditorArea(context).start();
    return;
  }
  handEditorsToPage(context);
  keepLayout(role, services, () => role === 'view' && editorsOf(services).length > 0);
  if (role === 'view') await startView(context);
  else await startTerminal(context);
};

/** Where the server keeps its extensions, for the rail: any workbench can tell (its default profile's extensions.json is there). */
export const reportExtensionsPath = async (services: VscodeServices, call: SurfaceContext['call']): Promise<void> => {
  const environment = await services.get<RemoteAgentService>('remoteAgentService').getEnvironment();
  const profiles = environment?.profiles?.all ?? [];
  const listing = (profiles.find((profile) => profile.isDefault) ?? profiles[0])?.extensionsResource?.path;
  if (listing?.endsWith('/extensions.json')) await call('/rail/source', { extensionsPath: listing.slice(0, -'/extensions.json'.length) });
};
