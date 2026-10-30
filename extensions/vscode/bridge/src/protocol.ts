// Between a frame (workbench/bridge.ts) and the bridge in its workbench's extension host: what each runs for the
// other, by command id. The frame's are embedder commands (`IWorkbenchConstructionOptions.commands`); the bridge's are
// extension commands, which the frame runs through VS Code's command service.

/** The frame's commands, for the bridge. */
export const FRAME = {
  /** Which part this frame is: `FrameInfo`. */
  info: 'openchamber.vscode.bridge.info',
  /** The bridge runs in this workbench, joined to the window's parts: `BridgeHello`. */
  hello: 'openchamber.vscode.bridge.hello',
  /** The user asked for something this part shows (from another part): it may take the keyboard focus. */
  allowFocus: 'openchamber.vscode.bridge.allowFocus',
  /** The runtime: focuses a stack frame another part chose (`{ sessionId, threadId, frameId }`): the bottom's Debug
   * Console evaluates in it. */
  focusFrame: 'openchamber.vscode.bridge.focusFrame',
  /** Whether this workbench knows a debugger type yet (an extension installed while it runs comes in a moment). */
  debuggerKnown: 'openchamber.vscode.bridge.debuggerKnown',
  /** The page: a file another part renames, moves or deletes (`FilesChange`): its editors here follow. */
  filesChange: 'openchamber.vscode.bridge.filesChange',
  /** Undo or Redo on a file (`{ resource, redo }`), if this part has it: true once done, else false. */
  undo: 'openchamber.vscode.bridge.undo',
  /** Opens OpenChamber's bottom, VS Code's terminal (`forge.rail.open`): true once it is open, false if it can't. */
  openBottom: 'openchamber.vscode.bridge.openBottom',
  /** The runtime: shows a terminal another part's extension made (`TerminalSpec`), its process attached here. */
  attachTerminal: 'openchamber.vscode.bridge.attachTerminal',
  /** The runtime: shows the terminal attached to a process (`{ process, focus }`). */
  showTerminal: 'openchamber.vscode.bridge.showTerminal',
} as const;

/** The bridge's commands, for the frame. */
export const BRIDGE = {
  /** The page or the rail: runs a task in the runtime (`TaskSpec`): true, or false where there's no runtime. */
  runTask: 'openchamber.bridge.runTask',
  /** The page or the rail: starts a launch configuration or a compound by name in the runtime: true, or false. */
  startDebugging: 'openchamber.bridge.startDebugging',
  /** The page or the rail: a terminal an extension made here goes to the runtime (`TerminalSpec`): true, or false. */
  moveTerminal: 'openchamber.bridge.moveTerminal',
  /** The page or the rail: shows a moved terminal at the bottom (`{ process, focus }`). */
  showTerminal: 'openchamber.bridge.showTerminal',
  /** Undo or Redo on a file this part has nothing for (`resource`, `redo`): the part that has it does it. */
  undo: 'openchamber.bridge.undo',
} as const;

export type BridgePart = 'view' | 'editor' | 'terminal';

export interface FrameInfo {
  role: BridgePart | 'classic';
  folder: string;
  /** The server's authority as this workbench names it (`vscode-remote://<authority>/…`). */
  authority: string;
  /** OpenChamber's window this frame is in (`forge.window.id()`), or null on a host without it. */
  window: string | null;
}

export interface BridgeHello {
  /** The build its .vsix carried (`openchamberBuild` in its manifest), if any. */
  build: string | null;
  version: string;
}

/** What the frame's catch got from the bridge: whether it went to the runtime (else VS Code's own runs here). */
export interface Routed {
  routed: boolean;
  ok?: boolean;
}

/** A task as the runtime finds it again (`vscode.tasks.fetchTasks`): its source and label, and its definition. */
export interface TaskSpec {
  label: string;
  source: string;
  definition: Record<string, unknown>;
  definitionType?: string;
}

/** A terminal's process on the server's pty host, to attach to (`IShellLaunchConfig.attachPersistentProcess`). */
export interface TerminalSpec {
  id: number;
  pid: number;
  title: string;
  titleSource: number;
  cwd: string;
  shellIntegrationNonce: string;
  icon?: unknown;
  color?: string;
  hasChildProcesses?: boolean;
  isFeatureTerminal?: boolean;
  hideFromUser?: boolean;
  type?: string;
  /** Show it once attached (`terminal.show()` came with it). */
  show?: boolean;
  focus?: boolean;
}

/** A file operation another part runs (`will`, before it: VS Code waits) or ran (`did`). */
export interface FilesChange {
  phase: 'will' | 'did';
  kind: 'rename' | 'delete';
  /** URIs; `to` for a rename or move. */
  files: { from: string; to?: string }[];
}

/** An output channel of the page's or the rail's extension host: its name, and its file on the server. */
export interface OutputSpec {
  label: string;
  file: string;
  /** A log channel (`createOutputChannel(name, { log: true })`): its lines are log lines. */
  log: boolean;
}
