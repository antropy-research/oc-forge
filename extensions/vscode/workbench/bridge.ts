// The frame's side of the bridge extension (`bridge/`), which makes the parts of VS Code in one OpenChamber window
// one VS Code. The frame tells the bridge which part it is and which window (`forge.window.id()`), opens OpenChamber's
// bottom for it (`forge.rail.open`), installs it on the server it is connected to, and catches what VS Code would run
// in the page or the rail that belongs in the runtime (the bottom terminal's workbench) but that no extension can catch
// before it runs: a task VS Code starts (its pickers, an extension through the API), a compound launch (its own
// preLaunchTask), a terminal an extension makes. Until the bridge says hello in this workbench, VS Code's own runs.
import type { OcForgeClient } from '../../../adapters/openchamber/client/index.ts';
import { BRIDGE, EXTENSION_LAUNCH, FRAME, MIRROR_TYPE, mirrorUi, type BridgeHello, type BridgePart, type FilesChange, type FrameInfo, type Routed, type TaskSpec, type TerminalSpec } from '../bridge/src/protocol.ts';
import type { FocusGuard } from '../src/focus.ts';
import {
  PARTS,
  SEVERITY_INFO,
  STORAGE_MACHINE,
  STORAGE_PROFILE,
  VscodeServices,
  type CommandService,
  type DebugService,
  type DebugSessionOptions,
  type EditorGroupsService,
  type EditorInput,
  type EditorService,
  type ExtensionService,
  type FileService,
  type ModelService,
  type LayoutService,
  type Launch,
  type NotificationService,
  type RemoteAgentService,
  type StorageService,
  type Task,
  type TaskService,
  type TerminalBackground,
  type TerminalGroupService,
  type TerminalInstance,
  type TerminalInstanceHost,
  type TerminalService,
  type TextFileService,
  type TextModelService,
  type UndoRedoService,
  type Uri,
  type ViewDescriptorService,
} from './vscode.ts';

/** The rail entry whose zone is OpenChamber's bottom: VS Code's terminal (src/surfaces.ts `TERMINAL_ENTRY_ID`). */
const TERMINAL_ENTRY = 'terminal';

export interface BridgePackageMeta {
  id: string;
  version: string;
  build: string;
}

export interface BridgeFrameOptions {
  role: BridgePart | 'classic';
  folder: string;
  authority: string;
  forge: OcForgeClient | null;
  focus: FocusGuard | null;
  log: (message: string, error?: unknown) => void;
}

export interface BridgeFrame {
  /** The embedder commands the bridge runs (`IWorkbenchConstructionOptions.commands`). */
  readonly commands: { id: string; handler: (...args: never[]) => unknown }[];
  /** As VS Code starts, before anything runs: the catches (each lets VS Code's own run until the bridge says hello). */
  prepare(services: VscodeServices): void;
  /** Once VS Code runs: the bridge installed (or brought up to date) on the server, or the notice that it isn't running. */
  start(services: VscodeServices, call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>): Promise<void>;
  /** Whether the bridge runs in this workbench. */
  readonly running: boolean;
}


/** Puts `make(original)` in place of a method of a VS Code service, `original` taken from its class (see guardWebviews). */
const replaceMethod = <T extends object, K extends keyof T>(service: T, key: K, make: (original: T[K]) => T[K]): void => {
  const original = (Object.getPrototypeOf(service) as T)[key];
  if (typeof original !== 'function') throw new Error(`VS Code has no ${String(key)} to catch`);
  service[key] = make(original);
};

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** A task as the runtime finds it again: its source and label, and its definition (without VS Code's key). */
export const taskSpecOf = (task: Task): TaskSpec | null => {
  const label = task._label;
  const source = task._source?.label;
  if (typeof label !== 'string' || typeof source !== 'string') return null;
  const { _key: _ignored, ...definition } = task.getDefinition(true) ?? {};
  return { label, source, definition, definitionType: source !== 'Workspace' && typeof definition.type === 'string' ? definition.type : undefined };
};

export const createBridgeFrame = (options: BridgeFrameOptions): BridgeFrame => {
  let hello: BridgeHello | null = null;
  const helloListeners = new Set<() => void>();
  let services: VscodeServices | null = null;
  const front = options.role === 'view' || options.role === 'editor';
  /** Terminals an extension made here, gone to the runtime: instance id → its process on the pty host. */
  const moved = new Map<number, number>();
  /** When VS Code last tried to show this part's panel (a terminal's `show()`). */
  let panelWanted = 0;
  // This OpenChamber window's id (each browser tab is a VS Code window of its own), on a host that names its windows.
  const windowId = (): string | null => {
    if (!options.forge?.has('window-id')) return null;
    try {
      return options.forge.window.id();
    } catch {
      return null;
    }
  };
  const command = (): CommandService | null => {
    try {
      return services?.get<CommandService>('commandService') ?? null;
    } catch {
      return null;
    }
  };
  // OpenChamber's bottom, VS Code's terminal, opened as a click on its rail entry would (never closed), on a host that can.
  const openBottom = async (): Promise<boolean> => {
    if (!options.forge?.has('rail-open')) return false;
    await options.forge.rail.open(TERMINAL_ENTRY);
    return true;
  };

  // ── The rail: the bridge's Outline and Timeline (fed from the page) stand in for VS Code's own, which follow the
  // rail's active editor (it has none). VS Code's own are hidden while the bridge runs; those this frame hid show
  // again when it doesn't (it keeps which in the rail's storage). ──
  const NATIVE_VIEWS = ['outline', 'timeline'];
  const HIDDEN_VIEWS = 'openchamber.bridge.hiddenViews';
  const showNativeViews = (visible: boolean): void => {
    if (options.role !== 'view' || !services) return;
    try {
      const storage = services.get<StorageService>('storageService');
      const views = services.get<ViewDescriptorService>('viewDescriptorService');
      const hidden = new Set<string>(JSON.parse(storage.get(HIDDEN_VIEWS, STORAGE_PROFILE) ?? '[]') as string[]);
      for (const id of visible ? [...hidden] : NATIVE_VIEWS) {
        const container = views.getViewContainerByViewId(id);
        if (container) views.getViewContainerModel(container).setVisible(id, visible);
        if (visible) hidden.delete(id);
        else hidden.add(id);
      }
      if (hidden.size) storage.store(HIDDEN_VIEWS, JSON.stringify([...hidden]), STORAGE_PROFILE, STORAGE_MACHINE);
      else storage.remove(HIDDEN_VIEWS, STORAGE_PROFILE);
    } catch (error) {
      options.log(visible ? "could not show VS Code's own Outline and Timeline again" : "VS Code's own Outline and Timeline stay in the rail", error);
    }
  };

  // ── The runtime: terminals another part's extension made, attached to their process here ──
  const terminals = (): (TerminalService & TerminalInstanceHost) | null => services?.get<TerminalService & TerminalInstanceHost>('terminalService') ?? null;
  const reveal = async (instance: TerminalInstance, focus: boolean): Promise<void> => {
    await openBottom().catch(() => false);
    const service = terminals();
    if (!service) return;
    if (focus) {
      options.focus?.allow();
      await service.focusInstance(instance);
    } else {
      service.setActiveInstance(instance);
      await services?.get<TerminalGroupService>('terminalGroupService').showPanel(false);
    }
  };
  const attach = async (spec: TerminalSpec): Promise<number | null> => {
    const service = terminals();
    if (!service) return null;
    const existing = service.instances.find((instance) => instance.persistentProcessId === spec.id);
    const instance = existing ?? await service.createTerminal({
      config: {
        attachPersistentProcess: {
          id: spec.id, pid: spec.pid, title: spec.title, titleSource: spec.titleSource, cwd: spec.cwd, shellIntegrationNonce: spec.shellIntegrationNonce,
          icon: spec.icon, color: spec.color, hasChildProcesses: spec.hasChildProcesses, isFeatureTerminal: spec.isFeatureTerminal, hideFromUser: spec.hideFromUser, type: spec.type,
        },
      },
    });
    if (spec.show) await reveal(instance, Boolean(spec.focus));
    return instance.instanceId;
  };
  const showTerminal = async ({ process, focus }: { process: number; focus: boolean }): Promise<boolean> => {
    const instance = terminals()?.instances.find((item) => item.persistentProcessId === process);
    if (!instance) return false;
    await reveal(instance, focus);
    return true;
  };

  // ── The page and the rail: no terminal of their own. One an extension makes here (its handle on the process) is
  // hidden here (`hideFromUser`) and shown at the bottom, attached to its process (`move`). ──
  /** The launch configurations of the terminals hidden here. */
  const hiddenHere = new WeakSet<object>();
  /** Terminals VS Code was asked to show before they reached the bottom: with the focus or not. */
  const showWanted = new WeakMap<TerminalInstance, boolean>();
  /** The terminal `terminal.show()` shows (its `showPanel` comes next, with the focus wanted). */
  let pendingReveal: TerminalInstance | null = null;
  const revealAtBottom = (instance: TerminalInstance, focus: boolean): void => {
    const process = moved.get(instance.instanceId);
    if (process === undefined) showWanted.set(instance, focus);
    else void command()?.executeCommand(BRIDGE.showTerminal, process, focus).catch(() => undefined);
  };
  const revealMoved = (focus: boolean): void => {
    const target = pendingReveal ?? terminals()?.activeInstance;
    pendingReveal = null;
    if (target) revealAtBottom(target, focus);
  };
  let pseudoNoticed = false;
  const move = async (instance: TerminalInstance): Promise<void> => {
    if (!hello) return;
    await instance.processReady.catch(() => undefined);
    const config = instance.shellLaunchConfig;
    const process = instance.persistentProcessId;
    if (config.customPtyImplementation || process === undefined) {
      // An extension's own pseudoterminal: its process is the extension's, here.
      if (!pseudoNoticed) {
        pseudoNoticed = true;
        services?.get<NotificationService>('notificationService').info(`"${instance.title}" is a terminal of an extension's own, which stays in this part of VS Code: OpenChamber can't show it at the bottom.`);
      }
      return;
    }
    const spec: TerminalSpec = {
      id: process,
      pid: instance.processId ?? 0,
      title: instance.title,
      titleSource: instance.titleSource,
      cwd: await instance.getInitialCwd().catch(() => ''),
      shellIntegrationNonce: instance.shellIntegrationNonce,
      icon: config.icon,
      color: config.color,
      hasChildProcesses: instance.hasChildProcesses,
      isFeatureTerminal: config.isFeatureTerminal,
      // Hidden here by this frame, not by the extension: shown at the bottom.
      hideFromUser: hiddenHere.has(config) ? false : config.hideFromUser,
      type: config.type,
      show: showWanted.has(instance) || (Date.now() - panelWanted < 5_000 && terminals()?.activeInstance === instance),
      focus: showWanted.get(instance) ?? false,
    };
    const result = await command()?.executeCommand(BRIDGE.moveTerminal, spec).catch((error) => {
      options.log('could not show the terminal at the bottom', error);
      return null;
    }) as Routed | null | undefined;
    if (result?.routed) moved.set(instance.instanceId, process);
  };

  // ── The page: a file another part renames, moves or deletes: its editors here follow, as one window's would ──
  /** Unsaved text of files another part moves or deletes, by the file it ends up as. */
  const keptText = new Map<string, string>();
  const filesChange = async (change: FilesChange): Promise<boolean> => {
    if (options.role !== 'editor' || !services) return false;
    const uris = services.uriClass();
    const textFiles = services.get<TextFileService>('textFileService');
    // An extension host names the server's files `file:///…`; this window, `vscode-remote://<authority>/…`.
    const here = (uri: string): Uri => {
      const parsed = uris.parse(uri);
      return parsed.scheme === 'file' && options.authority ? parsed.with({ scheme: 'vscode-remote', authority: options.authority }) : parsed;
    };
    const pairs = change.files.map((file) => ({ from: here(file.from), to: file.to ? here(file.to) : null }));
    const inside = (resource: Uri, folder: Uri): boolean => resource.scheme === folder.scheme && resource.authority === folder.authority
      && (resource.path === folder.path || resource.path.startsWith(folder.path.endsWith('/') ? folder.path : `${folder.path}/`));
    const pairOf = (resource: Uri): { from: Uri; to: Uri | null } | undefined => pairs.find((pair) => inside(resource, pair.from));
    const movedTo = (resource: Uri, pair: { from: Uri; to: Uri | null }): Uri | null => (pair.to ? pair.to.with({ path: `${pair.to.path}${resource.path.slice(pair.from.path.length)}` }) : null);
    // Before (and after, if the before didn't come): the unsaved text kept, the model marked saved (VS Code's soft
    // revert, its text shown still), so that no save, the user's or auto-save's, writes the old name again.
    for (const model of [...textFiles.files.models]) {
      const pair = pairOf(model.resource);
      if (!pair || !model.isDirty()) continue;
      const kept = model.textEditorModel?.getValue();
      if (kept !== undefined) keptText.set((movedTo(model.resource, pair) ?? model.resource).toString(), kept);
      await model.revert({ soft: true });
    }
    options.log(`${change.phase} ${change.kind} of ${pairs.length} file(s): ${keptText.size} unsaved kept`);
    if (change.phase === 'will') return true;
    if (change.kind === 'delete') {
      // Marked deleted (VS Code's own mark, once it reads the file again); its text stays shown, unsaved no more.
      for (const model of [...textFiles.files.models]) if (pairOf(model.resource)) await textFiles.files.resolve(model.resource, { reload: { async: false } }).catch(() => undefined);
      for (const key of [...keptText.keys()]) if (pairOf(uris.parse(key))) keptText.delete(key);
      return true;
    }
    // Moved: each editor of it replaced by the new name's where it was, with its view state (VS Code's own move).
    const editorService = services.get<EditorService>('editorService');
    const groups = services.get<EditorGroupsService>('editorGroupsService');
    const byGroup = new Map<number, { editor: EditorInput; replacement: unknown }[]>();
    for (const { editor, groupId } of editorService.getEditors(1)) {
      const resource = editor.resource;
      const pair = resource ? pairOf(resource) : undefined;
      const target = resource && pair ? movedTo(resource, pair) : null;
      const group = groups.getGroup(groupId);
      if (!target || !group) continue;
      const result = await editor.rename(groupId, target).catch(() => undefined);
      const untyped = result?.editor as { typeId?: unknown; options?: Record<string, unknown> } | undefined;
      if (!untyped || typeof untyped !== 'object' || 'typeId' in untyped) continue;
      const list = byGroup.get(groupId) ?? [];
      list.push({ editor, replacement: { ...untyped, options: { ...untyped.options, preserveFocus: true, pinned: group.isPinned(editor), sticky: group.isSticky(editor), index: group.getIndexOfEditor(editor), inactive: !group.isActive(editor) } } });
      byGroup.set(groupId, list);
    }
    for (const [groupId, replacements] of byGroup) await editorService.replaceEditors(replacements, groupId);
    options.log(`moved ${[...byGroup.values()].flat().length} editor(s)`);
    // The unsaved text, unsaved in the new name's model.
    for (const [key, kept] of [...keptText]) {
      const target = uris.parse(key);
      if (!pairs.some((pair) => pair.to && inside(target, pair.to))) continue;
      keptText.delete(key);
      const model = await textFiles.files.resolve(target);
      const same = model.textEditorModel?.getValue() === kept;
      if (model.textEditorModel && !same) model.textEditorModel.setValue(kept);
      options.log(`unsaved text of ${target.path.split('/').pop()}: ${same ? 'the same as the file' : 'put back'} (unsaved ${model.isDirty()})`);
    }
    return true;
  };
  // ── The runtime: the stack frame the rail chose in a mirror's call stack, focused here (the Debug Console's) ──
  const focusFrame = async ({ sessionId, threadId, frameId }: { sessionId: string; threadId: number; frameId: number }): Promise<boolean> => {
    if (options.role !== 'terminal' || !services) return false;
    const debug = services.get<DebugService>('debugService');
    const session = debug.getModel().getSession(sessionId);
    const thread = session?.getThread(threadId);
    const frame = thread?.getCallStack().find((item) => item.frameId === frameId);
    // Already it (VS Code focuses the top frame as a thread stops, here and in each mirror).
    if (!frame || debug.getViewModel().focusedStackFrame === frame) return false;
    await debug.focusStackFrame(frame, thread, session, { explicit: true, preserveFocus: true });
    return true;
  };
  // Another part's Undo or Redo this part may have: VS Code's own (not the catch in `prepare`, which asks the others).
  const undoHere = async ({ resource, redo }: { resource: string; redo: boolean }): Promise<boolean> => {
    if (!services) return false;
    const undoRedo = services.get<UndoRedoService>('undoRedoService');
    const uri = services.uriClass().parse(resource);
    if (!(redo ? undoRedo.canRedo(uri) : undoRedo.canUndo(uri))) return false;
    const own = Object.getPrototypeOf(undoRedo) as UndoRedoService;
    await (redo ? own.redo : own.undo).call(undoRedo, uri);
    return true;
  };

  const prepare = (ready: VscodeServices): void => {
    services = ready;
    if (!front) return;
    // A task VS Code starts here (Run Task's and Run Build Task's pickers, a task an extension runs through the API,
    // the NPM Scripts view): the same task runs in the runtime. No extension can catch it before it runs.
    try {
      replaceMethod(ready.get<TaskService>('taskService'), 'run', (original) => function (this: unknown, task: Task | undefined, runOptions?: unknown, runSource?: number) {
        const here = (): Promise<unknown> => original.call(this, task, runOptions, runSource);
        const spec = hello && task ? taskSpecOf(task) : null;
        if (!spec) return here();
        return Promise.resolve(command()?.executeCommand(BRIDGE.runTask, spec)).then(
          (result) => ((result as Routed | undefined)?.routed ? { exitCode: 0 } : here()),
          (error) => {
            options.log('could not run the task in the runtime', error);
            return here();
          },
        );
      });
    } catch (error) {
      options.log('tasks run in this part of VS Code', error);
    }
    // A compound launch: its own preLaunchTask runs before its configurations reach the bridge's launch provider. Named,
    // or the one chosen (F5, Select and Start Debugging).
    // An extension's own launch (a test's Debug, a command's), not the user's (`startedByUser`): marked, so that the
    // bridge's launch provider gives the extension the session it asked for, here: a mirror of the runtime's, with the
    // debug UI this part shows for every mirror (bridge/src/front.ts).
    try {
      const debug = ready.get<DebugService>('debugService');
      const isConfig = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
      replaceMethod(debug, 'startDebugging', (original) => function (this: unknown, launch: Launch | undefined, configOrName?: unknown, startOptions?: DebugSessionOptions, saveBeforeStart?: boolean) {
        const here = (config: unknown = configOrName, sessionOptions: DebugSessionOptions | undefined = startOptions): Promise<boolean> => original.call(this, launch, config, sessionOptions, saveBeforeStart);
        if (!hello) return here();
        if (configOrName === undefined || typeof configOrName === 'string') {
          const selected = configOrName === undefined ? debug.getConfigurationManager().selectedConfiguration : null;
          const name = typeof configOrName === 'string' ? configOrName : selected?.name;
          if (name && (launch ?? selected?.launch)?.getCompound(name)) {
            return Promise.resolve(command()?.executeCommand(BRIDGE.startDebugging, name, Boolean(startOptions?.noDebug))).then(
              (result) => ((result as Routed | undefined)?.routed ? Boolean((result as Routed).ok) : here()),
              () => here(),
            );
          }
        }
        if (startOptions?.startedByUser) return here();
        const config = typeof configOrName === 'string' ? launch?.getConfiguration(configOrName) : configOrName;
        if (!isConfig(config) || config.type === MIRROR_TYPE) return here();
        return here({ ...config, [EXTENSION_LAUNCH]: true }, { ...startOptions, ...mirrorUi(options.role) });
      });
    } catch (error) {
      options.log('compound launches and extensions\' launches run in this part of VS Code', error);
    }
    // Undo or Redo on a file with nothing for it here (Ctrl+Z in the page after the rail's Explorer deleted the file):
    // the part that ran the operation on it does it, as one window's undo would.
    try {
      const undoRedo = ready.get<UndoRedoService>('undoRedoService');
      const isUri = (value: unknown): value is Uri => typeof (value as Uri | null)?.scheme === 'string' && typeof (value as Uri).path === 'string';
      for (const redo of [false, true]) {
        replaceMethod(undoRedo, redo ? 'redo' : 'undo', (original) => function (this: unknown, resource: Uri) {
          if (!hello || !isUri(resource) || (redo ? undoRedo.canRedo(resource) : undoRedo.canUndo(resource))) return original.call(this, resource);
          return Promise.resolve(command()?.executeCommand(BRIDGE.undo, resource.toString(), redo)).then(() => undefined, () => undefined);
        });
      }
    } catch (error) {
      options.log('undo stays in this part of VS Code', error);
    }
    // The rail: Search's replace previews. VS Code makes a preview's model, applies the replacements once and lets the
    // model go: the editor that would hold it is the page's. A reference taken as the model is made keeps it (with its
    // replacements, and their updates) while its search result lives, for the page to read (bridge/src/replace.ts).
    if (options.role === 'view') {
      try {
        const textModels = ready.get<TextModelService>('textModelService');
        ready.get<ModelService>('modelService').onModelAdded((model) => {
          if (!hello || model.uri.scheme !== 'private' || model.uri.fragment !== 'replacePreview') return;
          void textModels.createModelReference(model.uri).then((reference) => {
            const gone = model.onWillDispose(() => {
              gone.dispose();
              reference.dispose();
            });
          }, () => undefined);
        });
      } catch (error) {
        options.log("Search's replace previews stay in the rail", error);
      }
    }
    // A terminal an extension makes here shows at the bottom, attached to its process; this part's panel stays closed.
    // `terminal.show()` (VS Code's `$show`) makes the terminal active and shows the panel: it shows at the bottom.
    try {
      const service = ready.get<TerminalService & TerminalBackground>('terminalService');
      service.onDidCreateInstance((instance) => void move(instance).catch((error) => options.log('could not move the terminal', error)));
      // VS Code's own commands that make a terminal run at the bottom (the bridge): one made here is an extension's.
      replaceMethod(service, 'createTerminal', (original) => function (this: unknown, createOptions?: { config?: Record<string, unknown> }) {
        const config = createOptions?.config;
        if (!hello || !config || config.customPtyImplementation || config.attachPersistentProcess || config.hideFromUser || 'profileName' in config) return original.call(this, createOptions);
        const hidden = { ...config, hideFromUser: true };
        hiddenHere.add(hidden);
        return original.call(this, { ...createOptions, config: hidden });
      });
      // `terminal.show()` of one hidden here: shown at the bottom, and still hidden here.
      replaceMethod(service, 'showBackgroundTerminal', (original) => function (this: unknown, instance: TerminalInstance, suppressSetActive?: boolean) {
        if (!hello || !hiddenHere.has(instance.shellLaunchConfig)) return original.call(this, instance, suppressSetActive);
        pendingReveal = instance;
        queueMicrotask(() => {
          if (pendingReveal !== instance) return;
          pendingReveal = null;
          revealAtBottom(instance, false);
        });
        return Promise.resolve();
      });
      replaceMethod(ready.get<TerminalGroupService>('terminalGroupService'), 'showPanel', (original) => function (this: unknown, focus?: boolean) {
        if (!hello) return original.call(this, focus);
        panelWanted = Date.now();
        revealMoved(Boolean(focus));
        return Promise.resolve();
      });
      // Anything else that shows this part's panel: closed again, once VS Code is done showing it.
      const layout = ready.get<LayoutService>('layoutService');
      let closing = false;
      let closed: number[] = [];
      let pausedUntil = 0;
      layout.onDidChangePartVisibility((event) => {
        if (!hello || event.partId !== PARTS.panel || !event.visible || closing || Date.now() < pausedUntil) return;
        closing = true;
        setTimeout(() => {
          closing = false;
          if (!layout.isVisible(PARTS.panel)) return;
          // Something keeps showing it: let it be a moment rather than take turns with it.
          closed = [...closed.filter((at) => Date.now() - at < 1_000), Date.now()];
          if (closed.length > 5) {
            pausedUntil = Date.now() + 5_000;
            options.log('something keeps showing the panel in this part of VS Code');
            return;
          }
          layout.setPartHidden(true, PARTS.panel);
        }, 0);
      });
    } catch (error) {
      options.log("extensions' terminals stay in this part of VS Code", error);
    }
  };

  const waitHello = (ms: number): Promise<boolean> => new Promise((resolve) => {
    if (hello) {
      resolve(true);
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      helloListeners.delete(done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      helloListeners.delete(done);
      resolve(false);
    }, ms);
    helloListeners.add(done);
  });

  const install = async (ready: VscodeServices, call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>): Promise<void> => {
    const pkg = await call<BridgePackageMeta & { vsix: string }>('/bridge/package', {});
    const environment = await ready.get<RemoteAgentService>('remoteAgentService').getEnvironment();
    if (!environment) throw new Error('no remote environment');
    const files = ready.get<FileService>('fileService');
    // VS Code's own buffer class, as its file service takes: the class of a file's content it read.
    const sample = await files.readFile(environment.appRoot.with({ path: `${environment.appRoot.path}/package.json` }));
    const target = environment.globalStorageHome.with({ path: `${environment.globalStorageHome.path}/${pkg.id}/openchamber-bridge-${pkg.build}.vsix` });
    await files.writeFile(target, VscodeServices.bufferClass(sample.value).wrap(bytesOf(pkg.vsix)));
    await ready.get<CommandService>('commandService').executeCommand('workbench.extensions.installExtension', target);
    options.log(`installed the bridge ${pkg.version} (${pkg.build}) on the server`);
  };

  const notice = async (ready: VscodeServices, call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>, id: string): Promise<void> => {
    // Once per window, from its rail view (the Extensions view is a rail entry there).
    if (options.role !== 'view') return;
    const { claimed } = await call<{ claimed: boolean }>('/bridge/claim', { key: `notice|${options.authority}|${windowId() ?? options.folder}` }).catch(() => ({ claimed: false }));
    if (!claimed) return;
    ready.get<NotificationService>('notificationService').prompt(SEVERITY_INFO,
      "OpenChamber Bridge isn't running on this VS Code Server, so each part of VS Code here debugs, runs tasks and opens terminals on its own.",
      [{ label: 'Show Extension', run: () => void ready.get<CommandService>('commandService').executeCommand('workbench.extensions.search', `@id:${id}`) }]);
  };

  const start = async (ready: VscodeServices, call: <T>(path: string, body?: Record<string, unknown>) => Promise<T>): Promise<void> => {
    services = ready;
    if (options.role === 'classic') return;
    const meta = await call<BridgePackageMeta>('/bridge/package', { meta: true }).catch(() => null);
    if (!meta) return;
    const extensions = ready.get<ExtensionService>('extensionService');
    await extensions.whenInstalledExtensionsRegistered();
    const registered = (): boolean => extensions.extensions.some((extension) => extension.identifier.value.toLowerCase() === meta.id);
    if (registered() && await waitHello(30_000)) {
      if (hello?.build === meta.build) return;
      // Another build: this one, from the parts' next start.
      const { claimed } = await call<{ claimed: boolean }>('/bridge/claim', { key: `install|${options.authority}|${meta.build}` });
      if (claimed) await install(ready, call).catch((error) => options.log('could not update the bridge', error));
      return;
    }
    if (!registered()) {
      // Not running here: not installed (or disabled). One frame installs it; VS Code starts an extension installed
      // while it runs, in each window.
      const { claimed } = await call<{ claimed: boolean }>('/bridge/claim', { key: `install|${options.authority}|${meta.build}` });
      if (claimed) await install(ready, call).catch((error) => options.log('could not install the bridge', error));
      if (await waitHello(60_000)) return;
    }
    // VS Code's own, as without the bridge.
    showNativeViews(true);
    await notice(ready, call, meta.id);
  };

  const commands: BridgeFrame['commands'] = [
    { id: FRAME.info, handler: (): FrameInfo => ({ role: options.role, folder: options.folder, authority: options.authority, window: windowId() }) },
    {
      id: FRAME.hello,
      handler: ((value: BridgeHello) => {
        hello = value;
        showNativeViews(false);
        for (const listener of [...helloListeners]) listener();
      }) as (...args: never[]) => unknown,
    },
    { id: FRAME.allowFocus, handler: () => options.focus?.allow() },
    {
      id: FRAME.debuggerKnown,
      handler: ((type: string) => Boolean(services?.get<DebugService>('debugService').getAdapterManager().getDebugger(type))) as (...args: never[]) => unknown,
    },
    { id: FRAME.openBottom, handler: () => openBottom().catch(() => false) },
    { id: FRAME.filesChange, handler: ((change: FilesChange) => filesChange(change).catch((error) => {
      options.log('could not follow a file operation', error);
      return false;
    })) as (...args: never[]) => unknown },
    { id: FRAME.focusFrame, handler: ((frame: { sessionId: string; threadId: number; frameId: number }) => focusFrame(frame).catch(() => false)) as (...args: never[]) => unknown },
    { id: FRAME.undo, handler: ((request: { resource: string; redo: boolean }) => undoHere(request).catch(() => false)) as (...args: never[]) => unknown },
    { id: FRAME.attachTerminal, handler: ((spec: TerminalSpec) => attach(spec)) as (...args: never[]) => unknown },
    { id: FRAME.showTerminal, handler: ((value: { process: number; focus: boolean }) => showTerminal(value)) as (...args: never[]) => unknown },
  ];

  return {
    commands,
    prepare,
    start,
    get running() {
      return hello !== null;
    },
  };
};
