// The page and the rail: what starts here (a launch, a terminal, a task) runs in the runtime, and the runtime's debug
// sessions show here as mirrors.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import type { BreakpointState } from './dap.ts';
import { waitFor, waitForAsync } from './events.ts';
import { Mirror, type MirrorLink } from './mirror.ts';
import { BRIDGE, FRAME, type BridgePart, type Routed, type TaskSpec, type TerminalSpec } from './protocol.ts';
import { askVariables, editorValues, needsFront, replaceVariables, variablesIn, type InputDefinition } from './variables.ts';

export const MIRROR = 'openchamber-mirror';

interface MirrorEntry {
  owner: string | null;
  adapter: Mirror | null;
  session: vscode.DebugSession | null;
  starting: boolean;
  started: Promise<vscode.DebugSession>;
  markStarted: (session: vscode.DebugSession) => void;
  /** What the real adapter said of each source's breakpoints. */
  states: Map<string, BreakpointState[]>;
}

export interface Front {
  /** Whether the runtime is there, opening OpenChamber's bottom for it if it can. */
  ensureRuntime(what: string): Promise<boolean>;
}

export const startFront = (bus: Bus, context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, part: BridgePart, log: (line: string) => void): Front => {
  const mirrors = new Map<string, MirrorEntry>();
  const live = new Set<string>();
  const entryOf = (realId: string): MirrorEntry => {
    let entry = mirrors.get(realId);
    if (!entry) {
      let markStarted: (session: vscode.DebugSession) => void = () => undefined;
      const started = new Promise<vscode.DebugSession>((resolve) => {
        markStarted = resolve;
      });
      entry = { owner: null, adapter: null, session: null, starting: false, started, markStarted, states: new Map() };
      mirrors.set(realId, entry);
    }
    return entry;
  };
  const linkTo = (owner: string): MirrorLink => ({
    request: (type, payload, timeoutMs) => bus.request(owner, type, payload, timeoutMs),
    send: (type, payload) => bus.send({ ...payload, type, to: owner }),
  });

  // ── The runtime, opened when it isn't there ──
  // What the user starts here (a launch, a terminal, a task) shows at OpenChamber's bottom, as VS Code shows its panel
  // for it: the bottom opens (as it is if it shows already). Without the runtime yet, this waits for it to come.
  let noticed = 0;
  const ensureRuntime = async (what: string, reveal = true): Promise<boolean> => {
    const opening = reveal || !bus.has('terminal')
      ? vscode.commands.executeCommand<boolean>(FRAME.openBottom).then((value) => value === true, () => false)
      : Promise.resolve(false);
    if (bus.has('terminal')) return true;
    if (await opening && await waitFor(() => bus.has('terminal'), 45_000)) return true;
    if (Date.now() - noticed > 10_000) {
      noticed = Date.now();
      void vscode.window.showInformationMessage(`${what} runs in this part of VS Code: open VS Code's terminal at OpenChamber's bottom (its icon on the rail) to run it there, with the rest.`);
    }
    return false;
  };

  // ── Mirrors of the runtime's debug sessions ──
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(MIRROR, {
    createDebugAdapterDescriptor: (session) => {
      const { realId, owner } = (session.configuration.__openchamber ?? {}) as { realId?: string; owner?: string };
      if (!realId || !owner) return undefined;
      const entry = entryOf(realId);
      const adapter = new Mirror(linkTo(owner), realId, (file) => entry.states.get(file));
      entry.adapter = adapter;
      return new vscode.DebugAdapterInlineImplementation(adapter as unknown as vscode.DebugAdapter);
    },
  }));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
    const realId = (session.configuration.__openchamber as { realId?: string } | undefined)?.realId;
    if (!realId) return;
    const entry = entryOf(realId);
    entry.session = session;
    entry.markStarted(session);
  }));
  bus.on('session.started', async (message) => {
    const realId = String(message.realId);
    live.add(realId);
    const entry = entryOf(realId);
    if (entry.starting || entry.session) return;
    entry.starting = true;
    entry.owner = message.from?.member ?? null;
    // What the real adapter said of the breakpoints so far (a mirror that comes late).
    const states = await bus.request<Record<string, BreakpointState[]>>(entry.owner ?? undefined, 'dap.bpstates', { realId }, 5_000).catch(() => ({}));
    for (const [file, list] of Object.entries(states)) if (!entry.states.has(file)) entry.states.set(file, list);
    // A child session (js-debug's process under its launch) goes under its parent's mirror.
    const parentId = typeof message.parentId === 'string' ? message.parentId : undefined;
    const parent = parentId && live.has(parentId)
      ? await Promise.race([entryOf(parentId).started, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000))])
      : undefined;
    // A bridge installed while this window ran: VS Code knows its debugger type a moment after the bridge started
    // (else it would ask to install an extension for it).
    const known = await waitForAsync(() => vscode.commands.executeCommand<boolean>(FRAME.debuggerKnown, MIRROR).then((value) => value !== false, () => true), 20_000, 200);
    if (!known) {
      entry.starting = false;
      log(`no mirror of ${String(message.name)}: VS Code here doesn't know the ${MIRROR} debugger yet`);
      return;
    }
    // No folder: VS Code's restart of a session in a folder reads its launch configuration again by name (the
    // mirror's is the real one's), which would start another real session.
    const ok = await vscode.debug.startDebugging(undefined, {
      type: MIRROR,
      request: message.request === 'attach' ? 'attach' : 'launch',
      name: String(message.name),
      noDebug: Boolean(message.noDebug),
      internalConsoleOptions: 'neverOpen',
      __openchamber: { realId, owner: entry.owner },
    }, {
      parentSession: parent,
      lifecycleManagedByParent: Boolean(parent),
      compact: Boolean(parent),
      consoleMode: parent ? vscode.DebugConsoleMode.MergeWithParent : vscode.DebugConsoleMode.Separate,
      noDebug: Boolean(message.noDebug),
      // The page shows the editor's debug UI and its toolbar, never a debug view; the rail shows the debug view.
      suppressDebugView: part === 'editor',
      suppressDebugToolbar: part !== 'editor',
      suppressDebugStatusbar: part !== 'editor',
      suppressSaveBeforeStart: true,
    });
    if (!ok) entry.starting = false;
    log(`mirror of ${String(message.name)}: ${ok}`);
  });
  bus.on('dap.event', (message) => {
    mirrors.get(String(message.realId))?.adapter?.event(String(message.event), message.body as Record<string, unknown> | undefined);
  });
  bus.on('bp.state', (message) => {
    const entry = mirrors.get(String(message.realId));
    if (!entry) return;
    for (const [file, list] of Object.entries((message.sources as Record<string, BreakpointState[]> | undefined) ?? {})) {
      entry.states.set(file, list);
      entry.adapter?.breakpointStates(file, list);
    }
  });
  const end = (realId: string): void => {
    live.delete(realId);
    const entry = mirrors.get(realId);
    mirrors.delete(realId);
    entry?.adapter?.event('terminated');
  };
  bus.on('session.ended', (message) => end(String(message.realId)));
  // The stack frame chosen here (the rail's call stack) is the runtime's too: the bottom's Debug Console evaluates in it.
  context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem((item) => {
    if (!(item instanceof vscode.DebugStackFrame)) return;
    const realId = (item.session.configuration.__openchamber as { realId?: string } | undefined)?.realId;
    const owner = realId ? mirrors.get(realId)?.owner : undefined;
    if (realId && owner) bus.send({ type: 'debug.focus', to: owner, realId, threadId: item.threadId, frameId: item.frameId });
  }));
  // A runtime that went (its window closed) ends the mirrors of its sessions: after a moment, as the parts find each
  // other again when the one that listened went.
  context.subscriptions.push({ dispose: bus.onMembers(() => setTimeout(() => {
    for (const [realId, entry] of mirrors) if (entry.owner && !bus.members.has(entry.owner)) end(realId);
  }, 5_000)).dispose });

  // ── A launch from here runs in the runtime ──
  // Caught before VS Code substitutes its variables and runs its preLaunchTask (`resolveDebugConfiguration`, after the
  // type's own providers): returning undefined there aborts it here. What only this part can resolve (the editor's
  // variables, what asks the user) is resolved first.
  const resolveHere = async (config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | null> => {
    const names = variablesIn(config);
    const { editor, ask } = needsFront(names);
    let resolved = config;
    if (editor) {
      const active = vscode.window.activeTextEditor;
      if (active) {
        const file = active.document.uri.path;
        const workspace = vscode.workspace.getWorkspaceFolder(active.document.uri)?.uri.path;
        resolved = replaceVariables(resolved, editorValues({ file, folder: workspace, line: active.selection.active.line + 1, column: active.selection.active.character + 1, selectedText: active.document.getText(active.selection) }));
      }
    }
    if (ask) {
      const inputs = vscode.workspace.getConfiguration('launch', folder.uri).get<InputDefinition[]>('inputs') ?? [];
      const aliases: Record<string, string> = {};
      for (const extension of vscode.extensions.all) {
        for (const debuggerInfo of (extension.packageJSON?.contributes?.debuggers as { type?: string; variables?: Record<string, string> }[] | undefined) ?? []) {
          if (debuggerInfo.type === config.type && debuggerInfo.variables) Object.assign(aliases, debuggerInfo.variables);
        }
      }
      const values = await askVariables(names, inputs, {
        prompt: (input) => vscode.window.showInputBox({ prompt: input.description, value: input.default, password: input.password }),
        pick: async (input) => {
          const items = (input.options ?? []).map((option) => (typeof option === 'string' ? { label: option, value: option } : { label: option.label ?? option.value, value: option.value }));
          return (await vscode.window.showQuickPick(items, { placeHolder: input.description }))?.value;
        },
        command: (id, args) => vscode.commands.executeCommand(id, args),
      }, config, aliases);
      if (!values) return null;
      resolved = replaceVariables(resolved, values);
    }
    return resolved;
  };
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('*', {
    resolveDebugConfiguration: async (_folder, config) => {
      // A mirror VS Code starts again for a session that ended: nothing to mirror.
      if (config.type === MIRROR) return live.has((config.__openchamber as { realId?: string } | undefined)?.realId ?? '') ? config : undefined;
      // An empty configuration (F5 with no launch.json): the type's providers make one first.
      if (!config.type && !config.request && !config.name) return config;
      if (part === 'view' && needsFront(variablesIn(config)).editor && bus.has('editor')) {
        // The page names the active editor.
        await bus.request('editor', 'debug.resolve', { config, noDebug: Boolean(config.noDebug) }, 120_000);
        return undefined;
      }
      if (!(await ensureRuntime('Debugging'))) return config;
      const resolved = await resolveHere(config);
      if (!resolved) return undefined;
      await bus.request('terminal', 'debug.start', { config: resolved, noDebug: Boolean(config.noDebug) }, 120_000);
      return undefined;
    },
  }));
  if (part === 'editor') {
    bus.on('debug.resolve', async (message) => {
      const resolved = await resolveHere(message.config as vscode.DebugConfiguration);
      if (!resolved || !(await ensureRuntime('Debugging'))) return false;
      return bus.request('terminal', 'debug.start', { config: resolved, noDebug: Boolean(message.noDebug) }, 120_000);
    });
  }

  // ── Terminals, and tasks that run: VS Code's commands run in the runtime ──
  // Registered after VS Code's own, so they are the ones a key, a menu or the command palette runs. A task that
  // starts (VS Code's pickers, Run Build Task, an extension through the API) goes through the frame (`runTask` below).
  const runThere = (command: string, as = command, what = 'This') => async (...args: unknown[]): Promise<unknown> => {
    while (args.length && (args[args.length - 1] === undefined || args[args.length - 1] === null)) args.pop();
    if (!(await ensureRuntime(what))) {
      // VS Code's own, here: the user was told.
      return undefined;
    }
    log(`${command} runs in the runtime`);
    return bus.request('terminal', 'run.command', { command: as, args: JSON.parse(JSON.stringify(args)) as unknown[] }, 60_000);
  };
  const routed: [string, string?, string?][] = [
    ['workbench.action.terminal.new', undefined, 'A new terminal'],
    ['workbench.action.terminal.newWithProfile', undefined, 'A new terminal'],
    ['workbench.action.terminal.newWithCwd', undefined, 'A new terminal'],
    ['workbench.action.terminal.newLocal', 'workbench.action.terminal.new', 'A new terminal'],
    ['workbench.action.terminal.newInActiveWorkspace', 'workbench.action.terminal.new', 'A new terminal'],
    ['workbench.action.terminal.split', undefined, 'A new terminal'],
    ['workbench.action.terminal.splitActiveTab', 'workbench.action.terminal.split', 'A new terminal'],
    ['workbench.action.terminal.splitInActiveWorkspace', 'workbench.action.terminal.split', 'A new terminal'],
    // A terminal editor would be in the bottom's editor area, which doesn't show: a terminal at the bottom instead.
    ['workbench.action.createTerminalEditor', 'workbench.action.terminal.new', 'A new terminal'],
    ['workbench.action.createTerminalEditorSameGroup', 'workbench.action.terminal.new', 'A new terminal'],
    ['workbench.action.createTerminalEditorSide', 'workbench.action.terminal.new', 'A new terminal'],
    // The Explorer's "Open in Integrated Terminal" (and "Open in Terminal", the same on a remote): in that folder.
    ['openInIntegratedTerminal', undefined, 'A new terminal'],
    ['openInTerminal', 'openInIntegratedTerminal', 'A new terminal'],
    // The panel's views are the bottom's: Ctrl+J, Problems, Output, the Debug Console open it on that view.
    ['workbench.action.togglePanel', 'workbench.action.focusPanel', 'The panel'],
    ['workbench.action.focusPanel', undefined, 'The panel'],
    ['workbench.actions.view.problems', 'workbench.panel.markers.view.focus', 'Problems'],
    ['workbench.action.output.toggleOutput', 'workbench.panel.output.focus', 'Output'],
    ['workbench.debug.action.toggleRepl', 'workbench.panel.repl.view.focus', 'The Debug Console'],
    // The bottom shows the terminal: OpenChamber opens and closes its zone (the panel there is all it shows).
    ['workbench.action.terminal.toggleTerminal', 'workbench.action.terminal.focus', 'The terminal'],
    ['workbench.action.terminal.focus', undefined, 'The terminal'],
    ['workbench.action.tasks.reRunTask', undefined, 'The task'],
    ['workbench.action.tasks.restartTask', undefined, 'The task'],
    ['workbench.action.tasks.terminate', undefined, 'The task'],
    ['workbench.action.tasks.showTasks', undefined, 'The task'],
    ['workbench.action.tasks.showLog', undefined, 'The task'],
  ];
  for (const [command, as, what] of routed) context.subscriptions.push(vscode.commands.registerCommand(command, runThere(command, as, what)));
  // Text from the editor for the runtime's active terminal.
  const sendThere = async (text: string | undefined): Promise<void> => {
    if (text === undefined || !(await ensureRuntime('The terminal'))) return;
    await bus.request('terminal', 'terminal.send', { text }, 30_000);
  };
  context.subscriptions.push(vscode.commands.registerCommand('workbench.action.terminal.runSelectedText', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).text : editor.document.getText(editor.selection);
    await sendThere(text);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('workbench.action.terminal.runActiveFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    if (editor.document.isDirty) await editor.document.save();
    await sendThere(editor.document.uri.fsPath.includes(' ') ? `"${editor.document.uri.fsPath}"` : editor.document.uri.fsPath);
  }));

  // ── For the frame: what it catches before VS Code runs it here (`{ routed: false }`: VS Code's own runs here) ──
  context.subscriptions.push(vscode.commands.registerCommand(BRIDGE.runTask, async (task: TaskSpec): Promise<Routed> => {
    if (!(await ensureRuntime(`The task "${task.label}"`))) return { routed: false };
    await bus.request('terminal', 'task.run', { task }, 60_000);
    return { routed: true, ok: true };
  }));
  context.subscriptions.push(vscode.commands.registerCommand(BRIDGE.startDebugging, async (name: string, noDebug?: boolean): Promise<Routed> => {
    if (!(await ensureRuntime('Debugging'))) return { routed: false };
    return { routed: true, ok: await bus.request<boolean>('terminal', 'debug.start', { name, noDebug: Boolean(noDebug) }, 120_000) };
  }));
  context.subscriptions.push(vscode.commands.registerCommand(BRIDGE.moveTerminal, async (terminal: TerminalSpec): Promise<Routed> => {
    if (!(await ensureRuntime(`The terminal "${terminal.title}"`, false))) return { routed: false };
    await bus.request('terminal', 'terminal.attach', { terminal }, 30_000);
    return { routed: true, ok: true };
  }));
  context.subscriptions.push(vscode.commands.registerCommand(BRIDGE.showTerminal, async (process: number, focus?: boolean): Promise<Routed> => {
    if (!(await ensureRuntime('The terminal', false))) return { routed: false };
    return { routed: true, ok: Boolean(await bus.request('terminal', 'terminal.show', { process, focus: Boolean(focus) }, 30_000)) };
  }));

  return { ensureRuntime };
};
