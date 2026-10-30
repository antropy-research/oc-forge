import { describe, expect, test } from 'bun:test';
import { readOpenRequest, roleSettings, tabIcon } from '../src/surfaces.ts';
import { commandHandoff, ELSEWHERE, extensionIdOf, showingCommands } from '../workbench/handoff.ts';
import { entryOfView, readViewRequest, viewRequestKey } from '../workbench/sideBars.ts';
import type { CommandEvent, EditorInput, Event } from '../workbench/vscode.ts';

const uri = (scheme: string, path: string, authority = '') => ({ scheme, authority, path, query: '', fragment: '', toString: () => `${scheme}://${authority}${path}`, toJSON: () => ({ $mid: 1, scheme, authority, path }), with: () => uri(scheme, path, authority) });
const input = (typeId: string, resource?: ReturnType<typeof uri>, extra: Record<string, unknown> = {}): EditorInput => ({
  typeId,
  resource,
  getName: () => typeId,
  isDirty: () => false,
  toUntyped: () => undefined,
  matches: () => false,
  ...extra,
}) as unknown as EditorInput;

describe('editors the rail hands to the page by command', () => {
  test("an extension's page: installed first, then the gallery, its tab shown once open", () => {
    const editor = input('workbench.extensions.input2', uri('extension', '/vscode.git/extension'));
    expect(extensionIdOf(editor)).toBe('vscode.git');
    expect(commandHandoff(editor, undefined)).toEqual({ kind: 'command', command: '_extensions.manage', args: ['vscode.git'], or: { command: 'extension.open', args: ['vscode.git'] }, show: true });
  });

  test('Settings and Keyboard Shortcuts with their query; workspace settings on their scope', () => {
    expect(commandHandoff(input('workbench.input.settings2', uri('vscode-settings', 'settingseditor')), { query: '@ext:vscode.git' })).toEqual({ kind: 'command', command: 'workbench.action.openSettings', args: [{ query: '@ext:vscode.git' }], show: true });
    expect(commandHandoff(input('workbench.input.settings2'), { target: 5 })).toMatchObject({ command: 'workbench.action.openWorkspaceSettings', args: [] });
    expect(commandHandoff(input('workbench.input.keybindings'), { query: '@command:foo' })).toMatchObject({ command: 'workbench.action.openGlobalKeybindings', args: ['@command:foo'] });
    expect(commandHandoff(input('workbench.input.keybindings'), undefined)).toMatchObject({ args: [] });
  });

  test('a walkthrough at its step, typed or by its resource; the Welcome page with no category', () => {
    expect(commandHandoff(input('workbench.editors.gettingStartedInput'), { selectedCategory: 'Setup', selectedStep: 'Setup#theme' })).toMatchObject({ command: 'workbench.action.openWalkthrough', args: [{ category: 'Setup', step: 'theme' }] });
    const untyped = { resource: uri('walkThrough', '', 'vscode_getting_started_page'), options: { selectedCategory: 'Beginner' } };
    expect(commandHandoff(untyped, undefined)).toMatchObject({ command: 'workbench.action.openWalkthrough', args: ['Beginner'] });
    expect(commandHandoff({ resource: uri('walkThrough', '', 'vscode_getting_started_page') }, undefined)).toMatchObject({ args: [] });
  });

  test("a search editor's configuration, read from the editor: the page searches again", async () => {
    const config = { query: 'Section 9', filesToInclude: './docs', isRegexp: false, contextLines: 1, notebookSearchConfig: { includeMarkupInput: true } };
    const editor = input('workbench.editorinputs.searchEditorInput', uri('search-editor', '', ''), { resolveModels: async () => ({ configurationModel: { config } }) });
    const request = await commandHandoff(editor, undefined);
    expect(request).toEqual({ kind: 'command', command: 'search.action.openNewEditor', args: [{ query: 'Section 9', filesToInclude: './docs', isRegexp: false, contextLines: 1, triggerSearch: true, focusResults: false }], show: true });
  });

  test('files, diffs and unknown editors are not handed over by command', () => {
    expect(commandHandoff(input('workbench.editors.files.fileEditorInput', uri('vscode-remote', '/a.ts')), undefined)).toBeNull();
    expect(commandHandoff({ resource: uri('vscode-remote', '/a.ts') }, undefined)).toBeNull();
    expect(commandHandoff(input('workbench.editors.webviewInput'), undefined)).toBeNull();
  });

  test("Markdown's preview opens in the page by the command that just made it, for a while", () => {
    let fire: (event: CommandEvent) => void = () => {};
    const onWillExecuteCommand: Event<CommandEvent> = (listener) => {
      fire = listener;
      return { dispose: () => {} };
    };
    let now = 0;
    const recent = showingCommands({ onWillExecuteCommand, executeCommand: async () => undefined }, () => now);
    expect(recent()).toBeNull();
    fire({ commandId: 'workbench.action.files.save', args: [] });
    expect(recent()).toBeNull();
    fire({ commandId: 'markdown.showPreview', args: [uri('vscode-remote', '/README.md')] });
    const request = recent();
    expect(request).toMatchObject({ command: 'markdown.showPreview', args: [{ $mid: 1, scheme: 'vscode-remote', path: '/README.md' }], show: true });
    // The same request for each editor that run opens: handed over once.
    expect(recent()).toBe(request!);
    now = 5_000;
    expect(recent()).toBeNull();
  });

  test("callers of a handed-over editor's pane go on: its methods do nothing, and it is no promise", async () => {
    const pane = ELSEWHERE as { focusSearchInput(): void; search(query: string): void; then?: unknown };
    expect(pane.focusSearchInput()).toBeUndefined();
    expect(pane.search('x')).toBeUndefined();
    expect(pane.then).toBeUndefined();
    expect(await Promise.resolve(ELSEWHERE)).toBe(ELSEWHERE);
  });

  test('requests carry their fallback and whether the page shows the tab; malformed fallbacks are dropped', () => {
    expect(readOpenRequest({ kind: 'command', command: '_extensions.manage', args: ['a.b'], or: { command: 'extension.open', args: ['a.b'] }, show: true })).toEqual({ kind: 'command', command: '_extensions.manage', args: ['a.b'], or: { command: 'extension.open', args: ['a.b'] }, show: true });
    expect(readOpenRequest({ kind: 'command', command: 'x', args: [], or: { command: 'bad command', args: [] }, show: 'yes' })).toEqual({ kind: 'command', command: 'x', args: [] });
  });

  test("an extension's page and a search editor have their own tab icons", () => {
    expect(tabIcon('workbench.extensions.input2|extension:/vscode.git/extension')).toBe('puzzle');
    expect(tabIcon('workbench.editorinputs.searchEditorInput|search-editor:#0.5')).toBe('search');
  });
});

describe('the page: no side bar, no modal; split groups name their editor', () => {
  test('the page shows a tab per group only while split, none in zen mode; no part opens modals', () => {
    expect(roleSettings('editor', true, 1)).toMatchObject({ 'workbench.editor.showTabs': 'none', 'zenMode.showTabs': 'none', 'workbench.editor.useModal': 'off' });
    expect(roleSettings('editor', true, 2)['workbench.editor.showTabs']).toBe('single');
    for (const role of ['view', 'terminal'] as const) expect(roleSettings(role)['workbench.editor.useModal']).toBe('off');
    expect(roleSettings('classic')).toEqual({});
  });
});

describe("the page's side bars on the rail", () => {
  const entries = [
    { id: 'explorer', title: 'Explorer', icon: 'file-copy-2', order: 0, view: 'workbench.view.explorer' },
    { id: 'more', title: 'Additional Views', icon: 'more', order: 9, more: [{ view: 'workbench.view.extension.foo', title: 'Foo' }] },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', order: 10, zone: 'bottom' as const, view: 'workbench.panel.terminal' },
  ];

  test('a container opens on its own entry, or on the one whose Additional Views lists it; never on a zone entry', () => {
    expect(entryOfView(entries, 'workbench.view.explorer')?.id).toBe('explorer');
    expect(entryOfView(entries, 'workbench.view.extension.foo')?.id).toBe('more');
    expect(entryOfView(entries, 'workbench.panel.terminal')).toBeUndefined();
  });

  test('a request is for this browser tab, fresh, with a URI to reveal or none', () => {
    const forge = { has: (feature: string) => feature === 'window-id', window: { id: () => 'w-1' } } as never;
    expect(viewRequestKey(forge)).toBe('view-request:w-1');
    const reveal = { $mid: 1, scheme: 'vscode-remote', authority: 'host', path: '/a.ts' };
    expect(readViewRequest({ view: 'workbench.view.explorer', reveal, at: 1_000 }, 2_000)).toEqual({ view: 'workbench.view.explorer', reveal, at: 1_000 });
    expect(readViewRequest({ view: 'workbench.view.explorer', reveal: 'nope', at: 1_000 }, 2_000)?.reveal).toBeNull();
    expect(readViewRequest({ view: 'workbench.view.explorer', at: 1_000 }, 60_000)).toBeNull();
    expect(readViewRequest({ view: 'bad view!', at: 1_000 }, 1_000)).toBeNull();
  });
});
