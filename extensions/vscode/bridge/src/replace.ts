// Search's replace preview. The rail's Search opens a result as a diff of the file and the file with the replacements
// (`private:<path>#replacePreview`, VS Code's own provider, fed by the search model); the rail hands that diff to the
// page, whose search model has no such search. The page's bridge serves the preview's content (a content provider of
// the same scheme, asked before VS Code's own), taken from the rail, and follows the rail's changes to it (another
// replacement typed there).
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import type { BridgePart } from './protocol.ts';

/** VS Code's `Schemas.internal`, and the fragment of its replace previews. */
export const PREVIEW_SCHEME = 'private';
export const PREVIEW_FRAGMENT = 'replacePreview';

export const startReplacePreview = (bus: Bus, context: vscode.ExtensionContext, part: BridgePart): void => {
  if (part === 'editor') {
    const changed = new vscode.EventEmitter<vscode.Uri>();
    context.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: async (uri) => {
        // Anything else of the scheme: VS Code's own.
        if (uri.fragment !== PREVIEW_FRAGMENT || !bus.has('view')) return undefined;
        const text = await bus.request<string | null>('view', 'replace.preview', { uri: uri.toString() }, 10_000).catch(() => null);
        return text ?? undefined;
      },
    }));
    bus.on('replace.changed', (message) => changed.fire(vscode.Uri.parse(String(message.uri))));
    // VS Code's own provider may answer first (it registers when Search starts): a preview the page opens takes the
    // rail's content at once (a change applies to the document, whichever provider made it).
    const isPreview = (uri: vscode.Uri): boolean => uri.scheme === PREVIEW_SCHEME && uri.fragment === PREVIEW_FRAGMENT;
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
      if (isPreview(document.uri)) changed.fire(document.uri);
    }));
    for (const document of vscode.workspace.textDocuments) if (isPreview(document.uri)) changed.fire(document.uri);
    return;
  }
  if (part !== 'view') return;
  const following = new Set<string>();
  bus.on('replace.preview', async (message) => {
    const uri = vscode.Uri.parse(String(message.uri));
    if (uri.scheme !== PREVIEW_SCHEME || uri.fragment !== PREVIEW_FRAGMENT) return null;
    // VS Code's own preview here (the rail's search model).
    const document = await vscode.workspace.openTextDocument(uri);
    following.add(document.uri.toString());
    return document.getText();
  });
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    const key = event.document.uri.toString();
    if (following.has(key)) bus.send({ type: 'replace.changed', to: 'editor', uri: key });
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => void following.delete(document.uri.toString())));
};
