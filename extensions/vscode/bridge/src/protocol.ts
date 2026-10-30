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
  /** Whether this workbench knows a debugger type yet (an extension installed while it runs comes in a moment). */
  debuggerKnown: 'openchamber.vscode.bridge.debuggerKnown',
  /** Opens OpenChamber's bottom, VS Code's terminal (`forge.rail.open`): true once it is open, false if it can't. */
  openBottom: 'openchamber.vscode.bridge.openBottom',
  /** The runtime: shows a terminal another part's extension made (`TerminalSpec`), its process attached here. */
  attachTerminal: 'openchamber.vscode.bridge.attachTerminal',
  /** The runtime: shows the terminal attached to a process (`{ process, focus }`). */
  showTerminal: 'openchamber.vscode.bridge.showTerminal',
  /** The runtime: the page's or the rail's output channels as files (`OutputSpec[]`), listed in the Output view. */
  outputChannels: 'openchamber.vscode.bridge.outputChannels',
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
  /** The page or the rail: this part's output channels (`OutputSpec[]`) for the runtime's Output view. */
  outputChannels: 'openchamber.bridge.outputChannels',
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

/** An output channel as the runtime lists it: its name and its file on the server. */
export interface OutputSpec {
  id: string;
  label: string;
  /** `file://` URIs as the server names them (the extension host's view). */
  files: string[];
  log: boolean;
  /** Which part's (for its name in the list). */
  part: BridgePart;
}
