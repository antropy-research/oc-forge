// The background frame: "Open in VS Code" on a chat shows that chat's folder
// (or worktree) in the VS Code view inside OpenChamber.
import { connectHost, type GuestActionItem, type JsonValue } from '@openchamber/sdk';
import type { OpenRequest } from '../src/settings.ts';

const host = connectHost();
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

host.onAction(async (item: GuestActionItem) => {
  if (item.kind !== 'session' || item.action !== 'open-in-vscode') return;
  if (!item.directory) {
    await host.toast({ kind: 'info', message: 'This chat has no folder to open in VS Code.' });
    return;
  }
  const request: OpenRequest = { folder: item.directory, at: Date.now() };
  await host.storage.set('open-request', request as unknown as JsonValue);
  try {
    // The VS Code view picks the request up and shows that folder.
    await host.openSurface('plugin:oc-forge-vscode');
  } catch (error) {
    await host.toast({ kind: 'error', message: `The VS Code view did not open: ${messageOf(error)}` });
  }
});
