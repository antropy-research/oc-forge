// The frame's side of the bridge extension (`bridge/`), which makes the parts of VS Code in one OpenChamber window
// one VS Code. The frame tells the bridge which part it is and which window (`forge.window.id()`), opens OpenChamber's
// bottom for it (`forge.rail.open`), installs it on the server it is connected to, and catches what VS Code would run
// in the page or the rail that belongs in the runtime (the bottom terminal's workbench) but that no extension can catch
// before it runs: a task VS Code starts (its pickers, an extension through the API), a compound launch (its own
// preLaunchTask), a terminal an extension makes. Until the bridge says hello in this workbench, VS Code's own runs.
import type { OcForgeClient } from '../../../adapters/openchamber/client/index.ts';
import { BRIDGE, FRAME, type BridgeHello, type BridgePart, type FrameInfo, type OutputSpec, type Routed, type TaskSpec, type TerminalSpec } from '../bridge/src/protocol.ts';
import type { FocusGuard } from '../src/focus.ts';
import {
  PARTS,
  SEVERITY_INFO,
  VscodeServices,
  type CommandService,
  type DebugService,
  type ExtensionService,
  type FileService,
  type LayoutService,
  type Launch,
  type NotificationService,
  type RemoteAgentService,
  type Task,
  type TaskService,
  type TerminalGroupService,
  type TerminalInstance,
  type TerminalInstanceHost,
  type TerminalService,
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

  // ── The page and the rail: a terminal an extension made here goes to the runtime ──
  const revealMoved = (focus: boolean): void => {
    const active = terminals()?.activeInstance;
    const process = active ? moved.get(active.instanceId) : undefined;
    if (process !== undefined) void command()?.executeCommand(BRIDGE.showTerminal, process, focus).catch(() => undefined);
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
      hideFromUser: config.hideFromUser,
      type: config.type,
      show: Date.now() - panelWanted < 5_000 && terminals()?.activeInstance === instance,
      focus: false,
    };
    const result = await command()?.executeCommand(BRIDGE.moveTerminal, spec).catch((error) => {
      options.log('could not show the terminal at the bottom', error);
      return null;
    }) as Routed | null | undefined;
    if (result?.routed) moved.set(instance.instanceId, process);
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
    // A compound launch: its own preLaunchTask runs before its configurations reach the bridge's launch provider.
    try {
      replaceMethod(ready.get<DebugService>('debugService'), 'startDebugging', (original) => function (this: unknown, launch: Launch | undefined, configOrName?: unknown, startOptions?: { noDebug?: boolean }, saveBeforeStart?: boolean) {
        const here = (): Promise<boolean> => original.call(this, launch, configOrName, startOptions, saveBeforeStart);
        if (!hello || typeof configOrName !== 'string' || !launch?.getCompound(configOrName)) return here();
        return Promise.resolve(command()?.executeCommand(BRIDGE.startDebugging, configOrName, Boolean(startOptions?.noDebug))).then(
          (result) => ((result as Routed | undefined)?.routed ? Boolean((result as Routed).ok) : here()),
          () => here(),
        );
      });
    } catch (error) {
      options.log('compound launches run in this part of VS Code', error);
    }
    // A terminal an extension makes here shows at the bottom, attached to its process; this part's panel stays closed.
    // `terminal.show()` (VS Code's `$show`) makes the terminal active and shows the panel: it shows at the bottom.
    try {
      const service = ready.get<TerminalService>('terminalService');
      service.onDidCreateInstance((instance) => void move(instance).catch((error) => options.log('could not move the terminal', error)));
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
    await notice(ready, call, meta.id);
  };

  const commands: BridgeFrame['commands'] = [
    { id: FRAME.info, handler: (): FrameInfo => ({ role: options.role, folder: options.folder, authority: options.authority, window: windowId() }) },
    {
      id: FRAME.hello,
      handler: ((value: BridgeHello) => {
        hello = value;
        for (const listener of [...helloListeners]) listener();
      }) as (...args: never[]) => unknown,
    },
    { id: FRAME.allowFocus, handler: () => options.focus?.allow() },
    {
      id: FRAME.debuggerKnown,
      handler: ((type: string) => Boolean(services?.get<DebugService>('debugService').getAdapterManager().getDebugger(type))) as (...args: never[]) => unknown,
    },
    { id: FRAME.openBottom, handler: () => openBottom().catch(() => false) },
    { id: FRAME.attachTerminal, handler: ((spec: TerminalSpec) => attach(spec)) as (...args: never[]) => unknown },
    { id: FRAME.showTerminal, handler: ((value: { process: number; focus: boolean }) => showTerminal(value)) as (...args: never[]) => unknown },
    { id: FRAME.outputChannels, handler: ((channels: OutputSpec[]) => outputChannels(channels)) as (...args: never[]) => unknown },
  ];
  // The runtime's Output view lists the page's and the rail's channels (see output.ts); set by the frame's boot.
  let outputChannels: (channels: OutputSpec[]) => unknown = () => false;

  return {
    commands,
    prepare,
    start,
    get running() {
      return hello !== null;
    },
    set outputs(handler: (channels: OutputSpec[]) => unknown) {
      outputChannels = handler;
    },
  } as BridgeFrame & { outputs: (channels: OutputSpec[]) => unknown };
};
