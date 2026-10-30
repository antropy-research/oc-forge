// OpenChamber's bridge between the VS Code workbenches of one OpenChamber window on one folder: the rail view, the
// page and the bottom terminal, each a workbench with an extension host of its own on the VS Code Server's machine.
// It runs in each (extensionKind `workspace`), learns its part from its frame, and joins the window's other parts on
// a socket on the server. The bottom terminal's workbench is the window's runtime: debug sessions, terminals and
// tasks run there; the page and the rail send it what they start, and mirror its debug sessions.
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { syncBreakpoints } from './breakpointSync.ts';
import { BreakpointStore } from './breakpoints.ts';
import { Bus } from './bus.ts';
import { startFront } from './front.ts';
import { Heartbeat } from './heartbeat.ts';
import { startProblems } from './problems.ts';
import { FRAME, type BridgeHello, type BridgePart, type FrameInfo } from './protocol.ts';
import { startReplacePreview } from './replace.ts';
import { startRuntime } from './runtime.ts';
import { startFiles } from './files.ts';
import { startGitSync } from './git.ts';
import { startOutputMirror, startOutputSource } from './output.ts';
import { startViews } from './views.ts';

const PARTS: readonly BridgePart[] = ['view', 'editor', 'terminal'];

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const channel = vscode.window.createOutputChannel('OpenChamber Bridge', { log: true });
  context.subscriptions.push(channel);
  const info = await vscode.commands.executeCommand<FrameInfo | undefined>(FRAME.info).then((value) => value, () => undefined);
  const part = info?.role;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!info || !part || !PARTS.includes(part as BridgePart) || !folder) {
    channel.info(`not one of OpenChamber's parts (${part ?? 'no frame'}): nothing to do`);
    return;
  }
  const role = part as BridgePart;
  const log = (line: string): void => channel.info(`[${role}] ${line}`);
  // One bus per OpenChamber window on the folder: a browser tab is a VS Code window of its own. A host that can't
  // tell its windows apart (no `forge.window.id()`) gives one bus per folder.
  const folderKey = `${os.hostname()}|${folder.uri.toString()}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const bus = new Bus({ dir: path.join(os.tmpdir(), `ocvsb-${uid}`), key: `${folderKey}|${info.window ?? 'folder'}`, part: role, parts: PARTS, log });
  context.subscriptions.push(bus);
  // A window that went leaves its extension host on the server for a while (VS Code's reconnection grace).
  const heartbeat = new Heartbeat({
    ping: () => vscode.commands.executeCommand(FRAME.info),
    onAway: () => bus.leave(),
    onBack: () => void bus.rejoin().catch((error) => log(String(error))),
  });
  context.subscriptions.push({ dispose: () => heartbeat.stop() });
  await bus.start();
  heartbeat.start();
  void bus.sweep().then((removed) => removed && log(`removed ${removed} stale socket(s) of closed windows`), () => undefined);
  // The folder's breakpoints, in the bridge's global storage (the workspace storage is each window's own: VS Code
  // gives a window open on the folder while another is a folder of its own, `<id>-1`).
  const name = crypto.createHash('sha1').update(folderKey).digest('hex').slice(0, 20);
  const breakpoints = syncBreakpoints(bus, new BreakpointStore(path.join(context.globalStorageUri.fsPath, `${name}.breakpoints.json`)), log);
  context.subscriptions.push(breakpoints);
  if (role === 'terminal') startRuntime(bus, context, folder, info.authority || undefined, log);
  else startFront(bus, context, folder, role, log);
  startProblems(bus, context, log);
  startViews(bus, context, role, log);
  if (role === 'terminal') startOutputMirror(bus, context, log);
  else startOutputSource(bus, context);
  startFiles(bus, context, role, log);
  startReplacePreview(bus, context, role);
  startGitSync(bus, context, log);
  void vscode.commands.executeCommand('setContext', 'openchamber.bridge.part', role);
  // The frame catches what VS Code would run here (a task, a compound launch, an extension's terminal) once it knows
  // the bridge runs, and which build.
  const manifest = context.extension.packageJSON as { version?: string; openchamberBuild?: string };
  void vscode.commands.executeCommand(FRAME.hello, { build: manifest.openchamberBuild ?? null, version: manifest.version ?? '' } satisfies BridgeHello).then(undefined, () => undefined);
  // Not awaited: a key that activated the bridge runs as soon as its commands are there.
  void breakpoints.join().then(() => log('breakpoints joined'), (error) => log(`breakpoints: ${error}`));
  log(`ready for ${folder.uri.toString()} in window ${info.window ?? '(the folder)'}`);
};

export const deactivate = (): void => undefined;
