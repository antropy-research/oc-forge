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
  restoredTabOf,
  roleSettings,
  tabIcon,
  tabRoute,
  tabTitle,
  unmarshal,
  type OpenRequest,
  type Role,
} from '../src/surfaces.ts';
import {
  isEditorInput,
  MEMORY_TARGET,
  NO_MATCHING_KB,
  PARTS,
  SIDEBAR,
  type CommandService,
  type ConfigurationService,
  type EditorGroupsService,
  type EditorIdentifier,
  type EditorInput,
  type EditorService,
  type FileService,
  type KeybindingService,
  type LayoutService,
  type PaneCompositePartService,
  type Part,
  type RemoteAgentService,
  type TerminalService,
  type ViewsService,
  type VscodeKeyboardEvent,
  type VscodeServices,
} from './vscode.ts';

export type SurfaceRole = Exclude<Role, 'classic'>;

export interface SurfaceContext {
  role: SurfaceRole;
  forge: OcForgeClient;
  services: VscodeServices;
  /** The folder this workbench shows (the page's tabs are kept per folder). */
  folder: string | null;
  /** A POST to this extension's service, the server named. */
  call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  /** VS Code saves its state and this frame's storage reaches the service, as before a reload. */
  saveState: () => Promise<void>;
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

/** OpenChamber's rail digits (Cmd/Ctrl+Alt+digit), which VS Code binds to nothing. */
const RAIL_DIGITS = 'switch_context_surface';

/** Whether VS Code binds this digit press where it happened (VS Code's `KeyCode.Digit0` is 21). */
const vscodeBindsDigit = (services: VscodeServices, event: KeyboardEvent): boolean => {
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  if (digit === undefined) return false;
  const vscodeEvent: VscodeKeyboardEvent = {
    _standardKeyboardEventBrand: true,
    browserEvent: event,
    target: event.target,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    altGraphKey: event.getModifierState('AltGraph'),
    keyCode: 21 + Number(digit),
    code: event.code,
    equals: () => false,
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
  };
  try {
    return services.get<KeybindingService>('keybindingService').softDispatch(vscodeEvent, event.target).kind !== NO_MATCHING_KB;
  } catch {
    // Its keybinding service changed: by default VS Code binds no rail digit.
    return false;
  }
};

/**
 * VS Code takes the keys while it has focus. A press it has no binding for
 * (it didn't prevent its default) that OpenChamber binds to navigation (its
 * close-tab key, its rail digits) goes to OpenChamber: those tabs and that
 * rail are OpenChamber's.
 *
 * A terminal is the exception: xterm makes presses the shell's input and stops
 * them before VS Code or this sees them (Ctrl+Alt+digit becomes Esc and the
 * digit on Linux and Windows). OpenChamber's rail digits skip the shell, as VS
 * Code's own navigation keys do (`terminal.integrated.commandsToSkipShell`),
 * unless VS Code binds them; its other keys stay the shell's: Ctrl+[ is Esc,
 * Ctrl+B and Alt+W are readline's, tmux's and Emacs's.
 */
const forwardUnhandledKeys = (forge: OcForgeClient, services: VscodeServices): void => {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || !forge.has('keys')) return;
    const action = forge.keys.match(event);
    if (!action) return;
    event.preventDefault();
    void forge.keys.forward(event).catch(() => undefined);
  });
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || !forge.has('keys')) return;
    if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return;
    if (forge.keys.match(event) !== RAIL_DIGITS || vscodeBindsDigit(services, event)) return;
    event.preventDefault();
    event.stopPropagation();
    void forge.keys.forward(event).catch(() => undefined);
  }, true);
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

/** A header tab with its route (`tabRoute`): a Cmd/Ctrl+click on it opens its editor in a new browser tab. */
const withRoute = (tab: OcForgeTab): OcForgeTab => {
  const route = tabRoute(tab.id);
  return route ? { ...tab, route } : tab;
};

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

/**
 * A Cmd/Ctrl+click just now: what it opens goes to a new browser tab, not over the current view. The open may come
 * seconds later (a link's `command:` waits for VS Code's extensions to activate on it); a plain click or a key in
 * between ends it (a Ctrl+click that only selected in a list, then Enter, opens here).
 */
const modifiedClicks = (): (() => boolean) => {
  let at = -Infinity;
  const note = (event: MouseEvent) => {
    at = event.metaKey || event.ctrlKey ? performance.now() : -Infinity;
  };
  window.addEventListener('mousedown', note, true);
  window.addEventListener('mouseup', note, true);
  window.addEventListener('keydown', (event) => {
    if (!['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) at = -Infinity;
  }, true);
  return () => performance.now() - at < 10_000;
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
      await context.forge.tabs.open(withRoute({ id: handoff.key, title: handoff.title, icon: handoff.icon }), { activate: true });
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

/**
 * The page keeps the folder's tabs when the user closes its last one (OpenChamber keeps it a few seconds for that),
 * but a page still starting hears nothing yet: its VS Code isn't running, as after a reload the rail view brought the
 * tabs back. A part that stays (a rail view, the terminal) empties them too, so that the tab doesn't come back.
 */
const keepLastClose = (context: SurfaceContext): void => {
  const { forge } = context;
  if (!forge.has('tabs')) return;
  // The host's new list comes after the close: the closed tab is still in it.
  forge.tabs.onClose((id) => {
    if (forge.tabs.state().list.some((tab) => tab.id !== id)) return;
    void context.call('/tabs/save', { folder: context.folder, tabs: [] }).catch(() => undefined);
  });
};

/** What the frame's boot can ask of its part once it runs. */
export interface SurfaceController {
  /** A rail view: show this entry's view container, and light it on the rail. */
  showEntry?(entry: string): Promise<void>;
  /** About to reload on another folder: the page closes its tabs, which are the old folder's editors. */
  beforeFolderChange?(): Promise<void>;
}

// ── The rail view ───────────────────────────────────────────────────────

const startView = async (context: SurfaceContext): Promise<SurfaceController> => {
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
    const saved = await context.call<{ tabs?: OcForgeTab[] }>('/tabs/load', { folder: context.folder }).catch(() => ({ tabs: [] }));
    for (const tab of saved.tabs ?? []) await forge.tabs.open(withRoute(tab)).catch(() => undefined);
  }
  return {
    showEntry: async (next) => {
      if (forge.rail.entry() !== next) await forge.rail.setActive(next).catch(() => undefined);
      await showEntry(next);
    },
  };
};

// ── The bottom terminal ─────────────────────────────────────────────────

const startTerminal = async (context: SurfaceContext): Promise<void> => {
  await context.services.get<EditorGroupsService>('editorGroupsService').whenRestored;
  applyRoleLayout('terminal', context.services);
  // VS Code first reconnects the folder's terminals an earlier window left running (persistent sessions). Asked for a
  // terminal before that, it finds none and starts one more: every start of this part added a terminal, which every
  // later start reconnected and replayed too. A reconnection that hangs still gets its terminal, after a while.
  const reconnected = (async () => context.services.get<TerminalService>('terminalService').whenConnected)();
  await Promise.race([reconnected, later(20_000)]).catch(() => undefined);
  // Its active terminal, or a new one when the folder has none.
  await context.services.get<CommandService>('commandService').executeCommand('workbench.action.terminal.focus').catch((error) => log('could not open the terminal', error));
};

// ── The page: the editor area, its editors as header tabs ───────────────

class EditorArea {
  private readonly editorService: EditorService;
  private readonly openEditor: EditorService['openEditor'];
  private hostTabs = new Map<string, OcForgeTab>();
  /** Keys that were editors here: only those tabs are closed when their editor goes. */
  private readonly adopted = new Set<string>();
  /** Keys whose tab this page gave its route. */
  private readonly routed = new Set<string>();
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
  /** About to reload on another folder: the header no longer follows these editors. */
  private leaving = false;
  /** Until VS Code has restored its editors, the header doesn't follow them: what it restored is no choice made in it. */
  private started = false;
  /** The editor a link names as the page starts (a reload, a new browser tab from Cmd/Ctrl+click). */
  private linked: string | null = null;
  /** A tab chosen since the page started: it, not the link the page started with, is what the page shows. */
  private chosen = false;

  constructor(private readonly context: SurfaceContext) {
    this.editorService = context.services.get<EditorService>('editorService');
    this.openEditor = this.editorService.openEditor.bind(this.editorService);
    const state = context.forge.tabs.state();
    this.hostTabs = new Map(state.list.map((tab) => [tab.id, tab]));
    this.shown = state.shown;
    this.strip = state.strip;
  }

  /**
   * Restored, with the VS Code Server's files reachable (before that, a file would open as a plain text resource),
   * and the editors the user closed closed again.
   */
  private ready: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    const { forge, services } = this.context;
    // What VS Code restored, taken before anyone can open more: only these may be editors whose tabs were closed.
    const restored = new Set(this.editorService.getEditors(1).map((identifier) => identifier.editor));
    // A file opened in a rail view or the terminal starts the page with its tab: that is what the user asked for. Only
    // otherwise does the page's route count as a link, as OpenChamber keeps it after the page went with its last tab.
    const active = forge.tabs.state().active;
    const handed = active ? await this.take(active) : null;
    const route = handed ? null : forge.links.route();
    this.linked = readEditorRoute(route)?.key ?? null;
    this.ready = (async () => {
      await services.get<EditorGroupsService>('editorGroupsService').whenRestored;
      await services.get<FileService>('fileService').activateProvider('vscode-remote').catch(() => undefined);
      await this.dropClosedEditors(restored).catch((error) => log('could not close the editors closed before', error));
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
    forge.tabs.onActivate((id) => {
      this.chosen = true;
      void this.show(id).catch((error) => log('could not show the tab', error));
    });
    forge.tabs.onClose((id) => void this.closeFromHeader(id).catch((error) => log('could not close the editor', error)));
    // An unsaved tab the user closes stays until VS Code's own close, with its save prompt, has run here.
    forge.tabs.onCloseRequest((id) => void this.closeAsked(id).catch((error) => log('could not close the editor', error)));
    forge.links.onRoute((route) => void this.openRoute(route));
    await this.ready;
    this.editorService.onDidEditorsChange(() => this.schedule());
    this.editorService.onDidActiveEditorChange(() => this.schedule());
    // The editor VS Code restored as active is no change made in VS Code: the header's selection stands.
    this.lastActive = this.activeKey();
    // A link to an editor shows that editor, before the header follows VS Code (the address bar would name VS Code's
    // editor then). Otherwise the editor handed over, or the header's selection: a tab chosen while the page started
    // behind the tabs the rail view brought back. A tab chosen meanwhile also comes before the link: after a reload
    // the address bar still names the editor shown before it.
    if (this.linked && !this.chosen) await this.openRoute(route);
    this.started = true;
    await this.sync();
    const state = forge.tabs.state();
    if (handed && active) await this.show(active, handed);
    else if ((!this.linked || this.chosen) && state.active && (state.shown || !this.strip)) await this.show(state.active);
    // Started: the page follows VS Code now, and its first file has opened (it took the focus then).
    document.documentElement.dataset.ocVscodePageStarted = 'true';
  }

  /** What a rail view or the terminal handed over for this tab (`/editors/request`), once. */
  private async take(key: string): Promise<OpenRequest | null> {
    const taken = await this.context.call<{ open?: unknown }>('/editors/take', { key }).catch(() => ({ open: null }));
    return readOpenRequest(taken.open);
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
    if (this.timer || this.leaving || !this.started) return;
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
        if (this.leaving) return;
        this.adopted.add(key);
        const tab = withRoute({ id: key, title: item.title, icon: tabIcon(key), dirty: item.dirty });
        const host = this.hostTabs.get(key);
        // Its route is sent once more at most: an adapted OpenChamber older than tab routes keeps none.
        const routed = host?.route === tab.route || this.routed.has(key);
        if (host && host.title === tab.title && Boolean(host.dirty) === tab.dirty && host.icon === tab.icon && routed) continue;
        await forge.tabs.open(tab);
        this.hostTabs.set(key, tab);
        if (tab.route) this.routed.add(key);
      }
      // Activate before closing: closing the shown tab would move the page to OpenChamber's choice of neighbour.
      // Only for a change made in VS Code (Ctrl+Tab, Go to Definition): a click on a header tab is OpenChamber's and on its way here.
      const active = this.activeKey();
      const changed = active !== this.lastActive;
      if (this.showing === 0) this.lastActive = active;
      if (active && changed && this.showing === 0 && this.shown && forge.tabs.state().active !== active && current.has(active)) await forge.tabs.activate(active);
      // Sent before a tab closes (OpenChamber takes the frame's messages in order): the last one may take the page with it.
      void this.saveTabs(current);
      for (const key of [...this.hostTabs.keys()]) {
        if (current.has(key) || !this.adopted.has(key)) continue;
        await forge.tabs.close(key);
        this.hostTabs.delete(key);
        this.adopted.delete(key);
        this.routed.delete(key);
      }
      const route = active ? editorRoute(active) : null;
      if (route !== this.route && this.shown) {
        this.route = route;
        if (route) await forge.links.setRoute(route).catch(() => undefined);
      }
    } finally {
      this.syncing = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  /** The folder's tabs, which a frame brings back after OpenChamber reloads: the editors here, when they changed. */
  private async saveTabs(current: ReadonlyMap<string, { title: string }>): Promise<void> {
    const saved = JSON.stringify([...current].map(([id, item]) => ({ id, title: item.title, icon: tabIcon(id) })));
    if (saved === this.saved) return;
    this.saved = saved;
    await this.context.call('/tabs/save', { folder: this.context.folder, tabs: JSON.parse(saved) }).catch(() => undefined);
  }

  /**
   * VS Code restores the editors of the state it last saved, which OpenChamber may have cut short: it removes the
   * page with its last tab, before the page hears of the close. An editor that no saved or header tab stands for was
   * closed by the user, and closes again (an unsaved one stays, and gets its tab). A webview panel VS Code revived
   * (Markdown's preview) has a new key: it takes its old tab's place, as that tab can't open it. The editors opened
   * since the page started (`restored` is what VS Code had before) are the user's.
   */
  private async dropClosedEditors(restored: ReadonlySet<EditorInput>): Promise<void> {
    const { forge } = this.context;
    const saved = await this.context.call<{ tabs?: OcForgeTab[] }>('/tabs/load', { folder: this.context.folder }).catch(() => null);
    if (!saved) return;
    const tabs = [...(saved.tabs ?? []), ...forge.tabs.state().list];
    const current = this.editorService.getEditors(1).map((identifier) => ({ identifier, key: keyOfEditor(identifier.editor) }));
    const taken = new Set(current.map((editor) => editor.key));
    for (const { identifier, key } of current.filter((editor) => restored.has(editor.identifier.editor))) {
      const title = tabTitle(identifier.editor.getName());
      const tab = restoredTabOf(tabs, key, title, taken);
      if (tab === key) continue;
      if (tab) {
        taken.add(tab);
        await this.replaceTab(tab, withRoute({ id: key, title, icon: tabIcon(key), dirty: identifier.editor.isDirty() }));
      } else if (key !== this.linked && !identifier.editor.isDirty()) {
        // Not waited on for long: the page's start (and its header) must not hang on one.
        await Promise.race([this.editorService.closeEditor(identifier).catch(() => undefined), later(2_000)]);
      }
    }
  }

  /** A header tab's editor came back under another key: that key's tab in its place, selected if it was. */
  private async replaceTab(old: string, tab: OcForgeTab): Promise<void> {
    const { forge } = this.context;
    const state = forge.tabs.state();
    if (!state.list.some((item) => item.id === old)) return;
    this.adopted.add(tab.id);
    this.hostTabs.set(tab.id, tab);
    // Opened before the old one closes: the page's last tab takes the page with it.
    await forge.tabs.open(tab, { activate: state.shown && state.active === old }).catch(() => undefined);
    await forge.tabs.close(old).catch(() => undefined);
    this.hostTabs.delete(old);
  }

  /** OpenChamber shows the page on this tab: its editor, maybe one another frame asked for (`handed`: taken already). */
  private async show(id: string, handed: OpenRequest | null = null): Promise<void> {
    this.showing += 1;
    try {
      await this.ready;
      // Tabs chosen while the page was starting each wait for it: only the one chosen last opens its editor, as the
      // header shows, not each in the order they come back here.
      const selected = this.context.forge.tabs.state().active;
      if (selected && selected !== id) return;
      const request = handed ?? await this.take(id);
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
      const editor = unmarshal(request.editor, (components) => uri.revive(components)) as { options?: Record<string, unknown> };
      // Where it is open already (VS Code may have restored it), not as a second one over the active group's editor.
      const found = this.current().get(key);
      if (found) await this.openEditor(found.identifier.editor, { ...editor.options, preserveFocus: false }, found.identifier.groupId);
      else await this.openEditor(editor);
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
    const selection = target.line ? { selection: { startLineNumber: target.line, startColumn: 1 } } : {};
    if (found) await this.openEditor(found.identifier.editor, { preserveFocus: false, ...selection }, found.identifier.groupId);
    else await this.openKey(target.key, target.line).catch((error) => log('could not open the linked editor', error));
    // A link names what the page shows: its tab is the selected one, not the tab the header had selected meanwhile.
    const opened = this.current().get(target.key);
    if (!opened || this.context.forge.tabs.state().active === target.key) return;
    const tab = withRoute({ id: target.key, title: opened.title, icon: tabIcon(target.key), dirty: opened.dirty });
    this.adopted.add(target.key);
    this.hostTabs.set(target.key, tab);
    this.lastActive = target.key;
    await this.context.forge.tabs.open(tab, { activate: true }).catch(() => undefined);
  }

  /** Another folder is coming: its editors are not these, so neither are the header's tabs, nor the page's route. */
  async closeAllTabs(): Promise<void> {
    this.leaving = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // OpenChamber keeps the page a few seconds after its last tab, and the route after the page: the page that starts
    // on the new folder in this frame would take it for a link, and open this folder's editor there.
    this.route = '/';
    await this.context.forge.links.setRoute('/').catch(() => undefined);
    for (const id of [...this.hostTabs.keys()]) await this.context.forge.tabs.close(id).catch(() => undefined);
    this.hostTabs.clear();
    this.adopted.clear();
    this.routed.clear();
  }

  /**
   * The user closed the tab in the header, which OpenChamber has done already (a saved one, or any while no frame
   * decides): close its editors (one per group). If VS Code asks to save and the user cancels, the tab comes back.
   * After the last one OpenChamber keeps the page a few seconds more, hidden, before it goes (the adapters'
   * OC_FORGE_PAGE_LINGER_MS): the page keeps the folder's tabs and VS Code's state then, so neither brings it back.
   */
  private async closeFromHeader(id: string): Promise<void> {
    this.hostTabs.delete(id);
    const editors = this.editorService.getEditors(1).filter((identifier) => keyOfEditor(identifier.editor) === id);
    for (const identifier of editors) await this.editorService.closeEditor(identifier);
    // The host's new list comes after the close: the closed tab is still in it.
    if (this.context.forge.tabs.state().list.some((tab) => tab.id !== id)) this.schedule();
    else await this.keepBeforeGoing();
  }

  /**
   * The page goes with its last tab: the folder's tabs, and VS Code's state (in which the closed editors, and the
   * backup of a file closed unsaved, are gone), reach the service before it does. Not on a timer, which a hidden
   * frame may slow down.
   */
  private async keepBeforeGoing(): Promise<void> {
    const current = this.current();
    await this.saveTabs(current);
    await this.context.saveState().catch(() => undefined);
    // An editor that stayed (VS Code didn't close it) gets its tab back, which brings the page back.
    if (current.size > 0) this.schedule();
  }

  /**
   * The user closed an unsaved tab in the header (its ×, a middle click, the close-tab key), and OpenChamber left
   * it to this page: VS Code closes its editors as it would close its own tab, asking to save. The tab goes once
   * they all have; a cancel keeps the tab, the editor and its changes.
   */
  private async closeAsked(id: string): Promise<void> {
    await this.ready;
    const editors = this.editorService.getEditors(1).filter((identifier) => keyOfEditor(identifier.editor) === id);
    for (const identifier of editors) await this.editorService.closeEditor(identifier);
    if (this.current().has(id)) return;
    this.hostTabs.delete(id);
    this.adopted.delete(id);
    this.routed.delete(id);
    // The last tab takes the page with it, back to the chat: what it keeps reaches the service first (the backup of
    // the file is gone in VS Code's state, else the next start would bring back what Don't Save threw away).
    if (!this.context.forge.tabs.state().list.some((tab) => tab.id !== id)) await this.keepBeforeGoing();
    else await this.saveTabs(this.current());
    await this.context.forge.tabs.close(id).catch(() => undefined);
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
export const startSurface = async (context: SurfaceContext): Promise<SurfaceController> => {
  const { role, services } = context;
  // The page's depend on the header's strip, and follow it (EditorArea).
  if (role !== 'editor') await applySettings(services, roleSettings(role));
  forwardUnhandledKeys(context.forge, services);
  // Restoring the last view container shows the side bar again: the role's layout once more, after.
  void services.get<LayoutService>('layoutService').whenRestored.then(() => {
    try {
      applyRoleLayout(role, services, () => role === 'view' && editorsOf(services).length > 0);
    } catch (error) {
      log('could not lay the workbench out', error);
    }
  });
  if (role === 'editor') {
    const area = new EditorArea(context);
    await area.start();
    return { beforeFolderChange: () => area.closeAllTabs() };
  }
  handEditorsToPage(context);
  keepLastClose(context);
  keepLayout(role, services, () => role === 'view' && editorsOf(services).length > 0);
  if (role === 'view') return startView(context);
  await startTerminal(context);
  return {};
};

/** Where the server keeps its extensions, for the rail: any workbench can tell (its default profile's extensions.json is there). */
export const reportExtensionsPath = async (services: VscodeServices, call: SurfaceContext['call']): Promise<void> => {
  const environment = await services.get<RemoteAgentService>('remoteAgentService').getEnvironment();
  const profiles = environment?.profiles?.all ?? [];
  const listing = (profiles.find((profile) => profile.isDefault) ?? profiles[0])?.extensionsResource?.path;
  if (listing?.endsWith('/extensions.json')) await call('/rail/source', { extensionsPath: listing.slice(0, -'/extensions.json'.length) });
};
