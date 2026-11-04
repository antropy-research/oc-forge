// Editors a rail view or the terminal hands to the page by one of VS Code's own commands: the ones with no file to
// name them (Settings, Keyboard Shortcuts, a walkthrough, a search editor, an extension's page), which the page opens
// the way those commands do. Before, they opened inside the rail panel, squeezed beside the view or as a modal over
// it (pre-review rows 4, 6 and 7); a part other than the page never shows its editor area now (`applyRoleLayout`).
// Their header tab shows once the page has the editor open (`show`), as an extension's page may not open at all.
// The commands and their arguments are VS Code's documented ones; what each editor carries (its type id, its options,
// a search editor's configuration) is listed in the README, "Which VS Code internals the frames use".
import { marshal, type OpenRequest } from '../src/surfaces.ts';
import { isEditorInput, type CommandService, type EditorInput } from './vscode.ts';

export const EXTENSION_INPUT = 'workbench.extensions.input2';
export const SEARCH_EDITOR_INPUT = 'workbench.editorinputs.searchEditorInput';
export const SETTINGS_INPUT = 'workbench.input.settings2';
export const PREFERENCES_INPUT = 'workbench.input.preferences';
export const KEYBINDINGS_INPUT = 'workbench.input.keybindings';
export const WALKTHROUGH_INPUT = 'workbench.editors.gettingStartedInput';
/** Where the Welcome page and the walkthroughs open (`GettingStartedInput.RESOURCE`). */
const WALKTHROUGH_SCHEME = 'walkThrough';
const WALKTHROUGH_AUTHORITY = 'vscode_getting_started_page';

/** `ConfigurationTarget`: settings opened on the remote or workspace scope reopen there. */
const USER_REMOTE = 4;
const WORKSPACE = 5;

type CommandRequest = Extract<OpenRequest, { kind: 'command' }>;

const command = (id: string, args: unknown[], or?: CommandRequest['or']): CommandRequest => ({ kind: 'command', command: id, args, ...(or ? { or } : {}), show: true });

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The extension an extension's page shows: its resource is `extension:<publisher.name>/extension`. */
export const extensionIdOf = (editor: EditorInput): string | undefined => (
  editor.typeId === EXTENSION_INPUT && editor.resource?.scheme === 'extension' ? /^\/?(.+)\/extension$/.exec(editor.resource.path)?.[1] : undefined
);

/** A walkthrough's place (its editor options, `selectedCategory` and `selectedStep` as `<category>#<step>`): the command's argument. */
const walkthroughArgs = (options: unknown): unknown[] => {
  const category = text(record(options).selectedCategory);
  if (!category) return [];
  const step = text(record(options).selectedStep);
  return [step?.startsWith(`${category}#`) ? { category, step: step.slice(category.length + 1) } : category];
};

/**
 * A search editor's configuration (its query, includes, excludes, flags), read from the editor itself: a new one from
 * the rail's command palette, or the Search view's "Open in editor" with the view's query and results. The page runs
 * that search again in a search editor of its own.
 */
const searchArgs = async (editor: EditorInput): Promise<unknown[]> => {
  const resolve = (editor as unknown as { resolveModels?: () => Promise<{ configurationModel?: { config?: unknown } }> }).resolveModels;
  const config = typeof resolve === 'function' ? record((await resolve.call(editor).catch(() => null))?.configurationModel?.config) : {};
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) if (['string', 'number', 'boolean'].includes(typeof value)) args[key] = value;
  return [{ ...args, triggerSearch: Boolean(text(args.query)), focusResults: false }];
};

/**
 * The command that opens this editor in the page, or null for an editor the page opens as itself (a file, a diff) or
 * not at all. A search editor's needs its configuration read first (a promise).
 */
export const commandHandoff = (editor: unknown, options: unknown): CommandRequest | Promise<CommandRequest> | null => {
  if (isEditorInput(editor)) {
    switch (editor.typeId) {
      case EXTENSION_INPUT: {
        const id = extensionIdOf(editor);
        // An installed extension opens from what the page has installed (no gallery, which may be out of reach); one
        // from the Marketplace through the gallery.
        return id ? command('_extensions.manage', [id], { command: 'extension.open', args: [id] }) : null;
      }
      case SEARCH_EDITOR_INPUT:
        return searchArgs(editor).then((args) => command('search.action.openNewEditor', args));
      case SETTINGS_INPUT:
      case PREFERENCES_INPUT: {
        const query = text(record(options).query);
        const target = record(options).target;
        const id = target === WORKSPACE ? 'workbench.action.openWorkspaceSettings' : target === USER_REMOTE ? 'workbench.action.openRemoteSettings' : 'workbench.action.openSettings';
        return command(id, query ? [{ query }] : []);
      }
      case KEYBINDINGS_INPUT: {
        const query = text(record(options).query);
        return command('workbench.action.openGlobalKeybindings', query ? [query] : []);
      }
      case WALKTHROUGH_INPUT:
        return command('workbench.action.openWalkthrough', walkthroughArgs(options));
      default:
        return null;
    }
  }
  // The Welcome page and the walkthroughs open by their resource, with their place in the options.
  const untyped = record(editor);
  const resource = record(untyped.resource);
  if (resource.scheme === WALKTHROUGH_SCHEME && resource.authority === WALKTHROUGH_AUTHORITY) {
    return command('workbench.action.openWalkthrough', walkthroughArgs({ ...record(untyped.options), ...record(options) }));
  }
  return null;
};

/** Commands that show a resource in an editor of the frame that runs them (a webview), safe to run again in the page. */
const SHOWING_COMMANDS = new Set(['markdown.showPreview', 'markdown.showPreviewToSide', 'markdown.showLockedPreviewToSide']);
/** How long after such a command its editor may still be opening. */
const SHOWING_MS = 5_000;

/**
 * The showing command run last in this frame, while its editor may still be opening: Markdown's "Open Preview" on a
 * file in the rail's Explorer makes a webview there, which the page can't take, but the command shows the same
 * preview in the page. Its arguments marshalled (URIs as JSON, which the page revives).
 */
export const showingCommands = (commands: CommandService, now: () => number = Date.now): (() => CommandRequest | null) => {
  // The same request for each editor the same run opens (a webview revealed again): the caller hands it over once.
  let last: { request: CommandRequest; at: number } | null = null;
  commands.onWillExecuteCommand(({ commandId, args }) => {
    if (SHOWING_COMMANDS.has(commandId)) last = { request: command(commandId, marshal(args) as unknown[]), at: now() };
  });
  return () => (last && now() - last.at < SHOWING_MS ? last.request : null);
};

/**
 * What openEditor answers for an editor handed to the page by command. VS Code's own callers go on with the pane they
 * asked for (a new search editor triggers its search and focuses its query, Keyboard Shortcuts searches its query):
 * here each of its methods does nothing, rather than throwing into an error dialog in the rail.
 */
export const ELSEWHERE: unknown = new Proxy({}, {
  get: (_target, property) => (property === 'then' || typeof property === 'symbol' ? undefined : () => undefined),
});
