// File operations across the parts. A file the rail's Explorer (or any part but the page) renames, moves or deletes:
// the page, which shows the editors, hears of it before (it keeps the file's unsaved text, and no save can write the
// old name any more) and after (its editors move to the new name, as one window's VS Code moves them); the frame does
// the moving (workbench/bridge.ts). And Undo or Redo a part has nothing for on a file goes to the part that ran the
// operation on it: Ctrl+Z in the page undoes the rail's delete.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { BRIDGE, FRAME, type BridgePart, type FilesChange } from './protocol.ts';

export const startFiles = (bus: Bus, context: vscode.ExtensionContext, part: BridgePart, log: (line: string) => void): void => {
  if (part !== 'editor') {
    const tell = (phase: FilesChange['phase'], kind: FilesChange['kind'], files: FilesChange['files']): Promise<unknown> | undefined => {
      if (!bus.has('editor')) return undefined;
      if (phase === 'did') {
        bus.send({ type: 'files.change', to: 'editor', phase, kind, files });
        return undefined;
      }
      // VS Code waits for this (a participant of the operation) before it runs it.
      return bus.request('editor', 'files.change', { phase, kind, files }, 4_000).catch((error: unknown) => log(`files: ${error}`));
    };
    const renamed = (files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): FilesChange['files'] => files.map((file) => ({ from: file.oldUri.toString(), to: file.newUri.toString() }));
    const deleted = (files: readonly vscode.Uri[]): FilesChange['files'] => files.map((file) => ({ from: file.toString() }));
    context.subscriptions.push(vscode.workspace.onWillRenameFiles((event) => {
      const waiting = tell('will', 'rename', renamed(event.files));
      if (waiting) event.waitUntil(waiting);
    }));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles((event) => void tell('did', 'rename', renamed(event.files))));
    context.subscriptions.push(vscode.workspace.onWillDeleteFiles((event) => {
      const waiting = tell('will', 'delete', deleted(event.files));
      if (waiting) event.waitUntil(waiting);
    }));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles((event) => void tell('did', 'delete', deleted(event.files))));
  } else {
    bus.on('files.change', (message) => vscode.commands.executeCommand(FRAME.filesChange, { phase: message.phase, kind: message.kind, files: message.files } as FilesChange));
  }

  // Undo and Redo: asked of the window's other parts in turn, until one has it. VS Code may ask the user first there (its
  // confirmation before undoing a delete, in that part): the request waits for the answer.
  context.subscriptions.push(vscode.commands.registerCommand(BRIDGE.undo, async (resource: string, redo?: boolean): Promise<boolean> => {
    for (const member of [...bus.members.keys()]) {
      if (member === bus.me.member) continue;
      if (await bus.request<boolean>(member, 'undo.try', { resource, redo: Boolean(redo) }, 120_000).catch(() => false)) {
        log(`${redo ? 'redo' : 'undo'} of ${resource} ran in the ${bus.members.get(member)}`);
        return true;
      }
    }
    return false;
  }));
  bus.on('undo.try', (message) => vscode.commands.executeCommand<boolean>(FRAME.undo, { resource: String(message.resource), redo: Boolean(message.redo) }).then((done) => done === true, () => false));
};
