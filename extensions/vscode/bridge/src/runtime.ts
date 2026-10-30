// The runtime: the bottom terminal's workbench. The window's debug sessions, terminals and tasks run here; the page
// and the rail send it what they start and mirror its debug sessions.
import * as vscode from 'vscode';
import type { Bus, Message } from './bus.ts';
import { BreakpointTracker, FORWARDED, RUNS, toMainThread, type BreakpointState, type DapMessage } from './dap.ts';
import { FRAME, type TaskSpec, type TerminalSpec } from './protocol.ts';

/** VS Code's own debug UI is the page's and the rail's (mirrors); the Debug Console is the bottom's, natively. */
export const RUNTIME_SESSION_OPTIONS = {
  suppressDebugView: true,
  suppressDebugToolbar: true,
  suppressDebugStatusbar: true,
  suppressSaveBeforeStart: true,
} as const;

interface SessionData {
  session: vscode.DebugSession;
  capabilities: Record<string, unknown> | null;
  /** The threads stopped now (a mirror that comes late shows them), by thread id or 'all'. */
  stopped: Map<string, Record<string, unknown>>;
  breakpoints: BreakpointTracker;
  /** Sources whose breakpoint states changed and go out together. */
  dirty: Set<string>;
  flush: ReturnType<typeof setTimeout> | null;
}

export const startRuntime = (bus: Bus, context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, authority: string | undefined, log: (line: string) => void): void => {
  const sessions = new Map<string, SessionData>();
  const dataOf = (session: vscode.DebugSession): SessionData => {
    let data = sessions.get(session.id);
    if (!data) {
      data = { session, capabilities: null, stopped: new Map(), breakpoints: new BreakpointTracker(), dirty: new Set(), flush: null };
      sessions.set(session.id, data);
    }
    return data;
  };
  const announce = (session: vscode.DebugSession): void => bus.send({
    type: 'session.started',
    realId: session.id,
    parentId: session.parentSession?.id,
    name: session.name,
    request: session.configuration.request === 'attach' ? 'attach' : 'launch',
    noDebug: Boolean(session.configuration.noDebug),
  });
  const sendStates = (data: SessionData): void => {
    data.flush = null;
    const sources: Record<string, BreakpointState[]> = {};
    for (const file of data.dirty) sources[file] = data.breakpoints.statesOf(file);
    data.dirty.clear();
    bus.send({ type: 'bp.state', realId: data.session.id, sources });
  };

  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: (session) => {
      const data = dataOf(session);
      return {
        onWillReceiveMessage: (message: DapMessage) => data.breakpoints.request(message),
        onDidSendMessage: (message: DapMessage) => {
          const changed = data.breakpoints.message(message);
          if (changed) {
            data.dirty.add(changed);
            data.flush ??= setTimeout(() => sendStates(data), 30);
          }
          if (message.type === 'response' && message.command === 'initialize') data.capabilities = message.body ?? {};
          if (message.type !== 'event' || !message.event) return;
          if (message.event === 'stopped') data.stopped.set(message.body?.allThreadsStopped ? 'all' : String(message.body?.threadId), message.body ?? {});
          if (message.event === 'continued') {
            if (message.body?.allThreadsContinued !== false) data.stopped.clear();
            else data.stopped.delete(String(message.body?.threadId));
          }
          if (message.event === 'capabilities') data.capabilities = { ...(data.capabilities ?? {}), ...((message.body?.capabilities as Record<string, unknown>) ?? {}) };
          if (FORWARDED.has(message.event)) bus.send({ type: 'dap.event', realId: session.id, event: message.event, body: message.body });
        },
      };
    },
  }));
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
    dataOf(session).session = session;
    announce(session);
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
    const data = sessions.get(session.id);
    if (!data) return;
    if (data.flush) clearTimeout(data.flush);
    sessions.delete(session.id);
    bus.send({ type: 'session.ended', realId: session.id });
  }));
  // A part that joins mirrors what runs already: parents first (they started first).
  context.subscriptions.push({ dispose: bus.onMembers(() => {
    for (const data of sessions.values()) if (data.capabilities) announce(data.session);
  }).dispose });

  const sessionOf = (message: Message): vscode.DebugSession => {
    const data = sessions.get(String(message.realId));
    if (!data) throw new Error('that debug session ended');
    return data.session;
  };
  bus.on('debug.start', async (message) => {
    const started = Date.now();
    const target = (message.config as vscode.DebugConfiguration | undefined) ?? (message.name as string);
    const ok = await vscode.debug.startDebugging(folder, target, { ...RUNTIME_SESSION_OPTIONS, noDebug: Boolean(message.noDebug) });
    log(`debug.start ${typeof target === 'string' ? target : target.name}: ${ok} in ${Date.now() - started} ms`);
    return ok;
  });
  bus.on('dap.caps', (message) => sessions.get(String(message.realId))?.capabilities ?? null);
  bus.on('dap.state', (message) => ({ stopped: [...(sessions.get(String(message.realId))?.stopped.values() ?? [])] }));
  bus.on('dap.bpstates', (message) => {
    const data = sessions.get(String(message.realId));
    return data ? Object.fromEntries(data.breakpoints.sources().map((file) => [file, data.breakpoints.statesOf(file)])) : {};
  });
  bus.on('dap.request', async (message) => {
    const session = sessionOf(message);
    const command = String(message.command);
    const args = message.args as Record<string, unknown> | undefined;
    if (RUNS.has(command)) {
      // Before the request: its thread may stop again before the answer comes back.
      const all = !args?.singleThread;
      const data = sessions.get(session.id);
      if (all) data?.stopped.clear();
      else data?.stopped.delete(String(args?.threadId));
      bus.send({ type: 'dap.event', realId: session.id, event: 'continued', body: { threadId: args?.threadId, allThreadsContinued: all } });
    }
    return session.customRequest(command, toMainThread(args, authority));
  });
  bus.on('session.stop', async (message) => {
    const data = sessions.get(String(message.realId));
    if (data) await vscode.debug.stopDebugging(data.session);
  });
  // VS Code's own restart of that session: its tasks (preRestartTask, preLaunchTask), and the adapter's restart or a
  // new launch. The command takes the session as its context, as the call stack's Restart does.
  bus.on('session.restart', async (message) => {
    sessionOf(message);
    await vscode.commands.executeCommand('workbench.action.debug.restart', undefined, { sessionId: String(message.realId) });
    return true;
  });

  const userAsked = (): Thenable<unknown> => vscode.commands.executeCommand(FRAME.allowFocus).then(undefined, () => undefined);
  // Commands another part asked for (the terminal's, the running tasks'), run here as VS Code would run them.
  bus.on('run.command', async (message) => {
    await userAsked();
    log(`run.command ${String(message.command)}`);
    await vscode.commands.executeCommand(String(message.command), ...((message.args as unknown[] | undefined) ?? []));
    return true;
  });
  // Text for the active terminal (Run Selected Text, Run Active File): a new one if there is none.
  bus.on('terminal.send', async (message) => {
    await userAsked();
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
    terminal.show(false);
    terminal.sendText(String(message.text), message.execute !== false);
    return true;
  });
  // A task another part started (its picker, a key, an extension through the API): the same task, here.
  bus.on('task.run', async (message) => {
    const spec = message.task as TaskSpec;
    const tasks = await vscode.tasks.fetchTasks(spec.definitionType ? { type: spec.definitionType } : undefined);
    const same = tasks.filter((task) => task.name === spec.label && task.source === spec.source);
    const task = same.find((item) => JSON.stringify(item.definition) === JSON.stringify(spec.definition)) ?? same[0];
    if (!task) throw new Error(`No task "${spec.source}: ${spec.label}" here`);
    await userAsked();
    await vscode.tasks.executeTask(task);
    log(`task.run ${spec.source}: ${spec.label}`);
    return true;
  });
  // A terminal an extension made in the page or the rail: the same process, shown here (the frame attaches to it).
  bus.on('terminal.attach', (message) => vscode.commands.executeCommand(FRAME.attachTerminal, message.terminal as TerminalSpec));
  bus.on('terminal.show', async (message) => {
    if (message.focus) await userAsked();
    return vscode.commands.executeCommand(FRAME.showTerminal, { process: message.process, focus: Boolean(message.focus) });
  });
};
