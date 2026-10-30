// The page shows no side bar (applyRoleLayout). A view container VS Code opens there (Ctrl+Shift+E/F/G/D/X, Ctrl+B,
// "Reveal Active File in Explorer View", Run and Debug as a session starts) opens on OpenChamber's rail instead, in
// the rail view, as VS Code's activity bar would show it; before, a second Explorer or Search built itself inside the
// page beside the rail's (pre-review row 3). The page lights the entry with forge.rail.open. What the entry should
// show (a container behind "Additional Views", a file to reveal) waits in the extension's storage for this browser
// tab (`forge.window.id()`), where the rail view takes it as the entry opens, or, already open, within a moment.
import type { OcForgeClient } from '../../../adapters/openchamber/client/index.ts';
import type { RailEntry } from '../src/rail.ts';
import { isUriLike, marshal } from '../src/surfaces.ts';
import { SIDEBAR, type CommandService, type EditorService, type PaneCompositePartService, type VscodeServices } from './vscode.ts';

export const EXPLORER_VIEW = 'workbench.view.explorer';
const REVEAL_ACTIVE = 'workbench.files.action.showActiveFileInExplorer';
export const REVEAL = 'revealInExplorer';
/** A request older than this is the trace of another start, not one to follow. */
const REQUEST_MS = 15_000;
/** A reveal command is what opened the Explorer that follows it this soon. */
const REVEAL_MS = 2_000;

/** The extension's storage (the SDK's `host.storage`). */
export interface FrameStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What the rail view should show: a view container, and a file to reveal in the Explorer (a marshalled URI). */
export interface ViewRequest {
  view: string;
  reveal: unknown;
  at: number;
}

/** This browser tab's request: another tab's rail view leaves it alone. */
export const viewRequestKey = (forge: OcForgeClient): string => `view-request:${forge.has('window-id') ? forge.window.id() : 'any'}`;

export const readViewRequest = (value: unknown, now: number = Date.now()): ViewRequest | null => {
  const request = value as Partial<ViewRequest> | null;
  if (typeof request?.view !== 'string' || !/^[\w.-]{1,200}$/.test(request.view) || typeof request.at !== 'number') return null;
  if (now - request.at > REQUEST_MS || request.at > now + REQUEST_MS) return null;
  const reveal = request.reveal as { scheme?: unknown; path?: unknown } | null | undefined;
  return { view: request.view, reveal: typeof reveal?.scheme === 'string' && typeof reveal.path === 'string' ? reveal : null, at: request.at };
};

/** The rail entry that shows a view container: its own, or the one whose "Additional Views" lists it. */
export const entryOfView = (entries: readonly RailEntry[], view: string): RailEntry | undefined => (
  entries.find((entry) => !entry.zone && entry.view === view) ?? entries.find((entry) => entry.more?.some((more) => more.view === view))
);

/** The page: a view container VS Code opens in its side bar opens on the rail, with the file to reveal. */
export const sideBarsToRail = (forge: OcForgeClient, services: VscodeServices, storage: FrameStorage, railEntries: () => Promise<RailEntry[]>): void => {
  if (!forge.has('rail-open')) return;
  const panes = services.get<PaneCompositePartService>('paneCompositePartService');
  const editors = services.get<EditorService>('editorService');
  let reveal: { uri: unknown; at: number } | null = null;
  services.get<CommandService>('commandService').onWillExecuteCommand(({ commandId, args }) => {
    if (commandId === REVEAL_ACTIVE) reveal = { uri: editors.activeEditor?.resource ?? null, at: Date.now() };
    else if (commandId === REVEAL) reveal = { uri: isUriLike(args[0]) ? args[0] : editors.activeEditor?.resource ?? null, at: Date.now() };
  });
  panes.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
    if (viewContainerLocation !== SIDEBAR) return;
    const view = composite.getId();
    const file = view === EXPLORER_VIEW && reveal && Date.now() - reveal.at < REVEAL_MS ? reveal.uri : null;
    reveal = null;
    void (async () => {
      const entry = entryOfView(await railEntries(), view);
      if (!entry) return;
      // Plain JSON, as the storage takes it: a URI's toJSON may answer the URI itself.
      const reveal: unknown = file ? JSON.parse(JSON.stringify(marshal(file))) : null;
      await storage.set(viewRequestKey(forge), { view, reveal, at: Date.now() } satisfies ViewRequest);
      await forge.rail.open(entry.id);
    })().catch((error) => console.warn('[OpenChamber VS Code] could not open the view on the rail', error));
  });
};

/** The rail view: this tab's request, once (the storage's value goes as it is taken). */
export const takeViewRequest = async (forge: OcForgeClient, storage: FrameStorage): Promise<ViewRequest | null> => {
  const key = viewRequestKey(forge);
  const request = readViewRequest(await storage.get(key).catch(() => null));
  if (request) await storage.delete(key).catch(() => undefined);
  return request;
};
