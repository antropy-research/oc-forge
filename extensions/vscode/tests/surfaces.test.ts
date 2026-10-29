import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorRequests, readTabs, SavedTabs } from '../service/editors.ts';
import {
  editorKeyOf,
  editorRoute,
  isPortable,
  marshal,
  readEditorRoute,
  readOpenRequest,
  requestTitle,
  restoredTabOf,
  roleOf,
  roleSettings,
  tabIcon,
  tabRoute,
  tabTitle,
  unmarshal,
  type HostHello,
} from '../src/surfaces.ts';
import { workbenchConfiguration } from '../src/workbench.ts';

/** A stand-in for VS Code's URI: what the frame's code looks at. */
class Uri {
  constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
  toString() {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  toJSON() {
    return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
  with() {
    return this;
  }
  static revive(components: { scheme: string; authority: string; path: string; query?: string }) {
    return new Uri(components.scheme, components.authority, components.path, components.query);
  }
}
const remote = (path: string) => new Uri('vscode-remote', 'vscode:8000', path);

const hello = (surface: string, rail: HostHello['rail'], features = ['rail', 'tabs', 'zones', 'keys', 'links']): HostHello => ({ surface, features, rail });

describe('which part of VS Code a frame is', () => {
  test('the whole workbench on a stock OpenChamber, or without the surface patches', () => {
    expect(roleOf(null, true)).toBe('classic');
    expect(roleOf(hello('panel', { entry: 'explorer', own: false }), false)).toBe('classic');
  });

  test('a rail view, the page\'s editor area, the bottom terminal', () => {
    expect(roleOf(hello('panel', { entry: 'explorer', own: false }), true)).toBe('view');
    expect(roleOf(hello('page', null, ['tabs', 'zones', 'keys', 'links']), true)).toBe('editor');
    expect(roleOf(hello('panel', { entry: 'terminal', own: true }), true)).toBe('terminal');
  });

  test('without rail entries (an older service) the panel stays the whole workbench', () => {
    expect(roleOf(hello('panel', { entry: null, own: false }), true)).toBe('classic');
    expect(roleOf(hello('panel', null, ['zones', 'keys', 'links']), true)).toBe('classic');
    expect(roleOf(hello('panel', { entry: 'other', own: true }), true)).toBe('classic');
  });

  test('each part\'s settings: the rail is the activity bar; the header\'s tabs replace VS Code\'s', () => {
    expect(roleSettings('classic')).toEqual({});
    expect(roleSettings('view')).toMatchObject({ 'workbench.activityBar.location': 'hidden', 'workbench.statusBar.visible': false, 'window.commandCenter': false });
    expect(roleSettings('terminal')).toMatchObject({ 'workbench.panel.opensMaximized': 'always', 'workbench.panel.alignment': 'center' });
    expect(roleSettings('editor', true)).toMatchObject({ 'workbench.editor.showTabs': 'none', 'workbench.editor.enablePreview': false });
    expect(roleSettings('editor', false)['workbench.editor.showTabs']).toBeUndefined();
    // Only the terminal's part reconnects to the folder's terminals.
    for (const role of ['view', 'editor'] as const) expect(roleSettings(role)['terminal.integrated.enablePersistentSessions']).toBe(false);
    expect(roleSettings('editor', false)['terminal.integrated.enablePersistentSessions']).toBe(false);
    expect(roleSettings('terminal')['terminal.integrated.enablePersistentSessions']).toBeUndefined();
    const configuration = workbenchConfiguration({ remoteAuthority: 'vscode:8000' }, { folder: '/p', token: null, mode: 'dark', followTheme: true, defaults: roleSettings('view') });
    expect(configuration.configurationDefaults).toMatchObject({ 'chat.disableAIFeatures': true, 'workbench.activityBar.location': 'hidden' });
  });
});

describe('an editor between frames', () => {
  test('one key for the same editor in every frame: its resource, a diff by both sides, others by their type', () => {
    expect(editorKeyOf({ resource: remote('/p/a.ts'), options: { pinned: true } })).toBe('vscode-remote://vscode:8000/p/a.ts');
    expect(editorKeyOf(marshal({ resource: remote('/p/a.ts') }))).toBe('vscode-remote://vscode:8000/p/a.ts');
    const diff = { original: { resource: new Uri('git', '', '/p/a.ts', 'ref=HEAD') }, modified: { resource: remote('/p/a.ts') } };
    expect(editorKeyOf(diff)).toBe('diff:git:///p/a.ts?ref=HEAD vscode-remote://vscode:8000/p/a.ts');
    expect(editorKeyOf({ multiDiffSource: new Uri('scm-multi-diff-source', '', '/x') })).toBe('changes:scm-multi-diff-source:///x');
    expect(editorKeyOf({ resource: remote('/p/a.png') }, 'imagePreview')).toBe('imagePreview|vscode-remote://vscode:8000/p/a.png');
    expect(editorKeyOf({ label: 'nothing' })).toBeNull();
    expect(editorKeyOf({ resource: remote(`/${'x'.repeat(2000)}`) })!.length).toBeLessThanOrEqual(1024);
  });

  test('which saved tab an editor VS Code restored stands for; a revived webview panel takes its old tab by title', () => {
    const preview = (id: string) => `workbench.editors.webviewInput|webview-panel:webview-panel/webview-markdown.preview-${id}`;
    const tabs = [
      { id: 'vscode-remote://vscode:8000/p/README.md', title: 'README.md' },
      { id: preview('old'), title: 'Preview README.md' },
    ];
    expect(restoredTabOf(tabs, 'vscode-remote://vscode:8000/p/README.md', 'README.md', new Set())).toBe('vscode-remote://vscode:8000/p/README.md');
    // Closed by the user: no tab names it.
    expect(restoredTabOf(tabs, 'vscode-remote://vscode:8000/p/notes.ts', 'notes.ts', new Set())).toBeNull();
    expect(restoredTabOf(tabs, preview('new'), 'Preview README.md', new Set())).toBe(preview('old'));
    expect(restoredTabOf(tabs, preview('new'), 'Preview README.md', new Set([preview('old')]))).toBeNull();
    expect(restoredTabOf(tabs, preview('new'), 'Preview notes.md', new Set())).toBeNull();
    // Only a webview panel is revived under a new key: a file of the same title is another file.
    expect(restoredTabOf([{ id: 'vscode-remote://vscode:8000/q/README.md', title: 'README.md' }], 'vscode-remote://vscode:8000/p/README.md', 'README.md', new Set())).toBeNull();
  });

  test('marshalled as VS Code does, and back with its URI.revive', () => {
    const editor = { resource: remote('/p/a.ts'), options: { selection: { startLineNumber: 42, startColumn: 1 }, pinned: true, viewState: undefined, callback: () => 1 } };
    const json = JSON.parse(JSON.stringify(marshal(editor)));
    expect(json.resource).toEqual({ $mid: 1, scheme: 'vscode-remote', authority: 'vscode:8000', path: '/p/a.ts', query: '', fragment: '' });
    expect(json.options).toEqual({ selection: { startLineNumber: 42, startColumn: 1 }, pinned: true });
    const back = unmarshal(json, (components) => Uri.revive(components as never)) as typeof editor;
    expect(back.resource).toBeInstanceOf(Uri);
    expect(back.resource.toString()).toBe('vscode-remote://vscode:8000/p/a.ts');
  });

  test('what another frame can open; a terminal or an output belongs to its own frame', () => {
    expect(isPortable({ resource: remote('/p/a.ts') })).toBe(true);
    expect(isPortable({ original: { resource: new Uri('git', '', '/a') }, modified: { resource: remote('/a') } })).toBe(true);
    expect(isPortable({ resource: new Uri('vscode-terminal', '', '/1') })).toBe(false);
    expect(isPortable({ resource: new Uri('output', '', '/x') })).toBe(false);
    expect(isPortable({ label: 'untyped, no resource' })).toBe(false);
  });

  test('a tab\'s title and icon', () => {
    expect(requestTitle({ resource: remote('/p/src/main.ts') })).toBe('main.ts');
    expect(requestTitle({ original: { resource: remote('/p/a.ts') }, modified: { resource: remote('/p/a.ts') } })).toBe('a.ts (changes)');
    expect(requestTitle({ label: 'Settings' })).toBe('Settings');
    expect(tabTitle('x'.repeat(100))).toHaveLength(80);
    expect(tabIcon('vscode-remote://h/p/README.md')).toBe('file-text');
    expect(tabIcon('vscode-remote://h/p/a.png')).toBe('file-image');
    expect(tabIcon('diff:a b')).toBe('git-commit');
    expect(tabIcon('vscode-remote://h/p/main.ts')).toBe('file-code');
  });

  test('requests and routes are read defensively', () => {
    expect(readOpenRequest({ kind: 'command', command: 'extension.open', args: ['pub.ext'] })).toEqual({ kind: 'command', command: 'extension.open', args: ['pub.ext'] });
    expect(readOpenRequest({ kind: 'command', command: 'rm -rf /', args: [] })).toBeNull();
    expect(readOpenRequest({ kind: 'editor', editor: { resource: {} } })).toEqual({ kind: 'editor', editor: { resource: {} } });
    expect(readOpenRequest(null)).toBeNull();
    const route = editorRoute('vscode-remote://h/p/a b.ts', 7);
    expect(readEditorRoute(route)).toEqual({ key: 'vscode-remote://h/p/a b.ts', line: 7 });
    expect(readEditorRoute('/somewhere')).toBeNull();
  });

  test("a file tab's route is its editor's link; editors the page can't open from their key have none", () => {
    const file = 'vscode-remote://h/p/README.md';
    expect(tabRoute(file)).toBe(editorRoute(file));
    expect(readEditorRoute(tabRoute(file)!)).toEqual({ key: file, line: null });
    expect(tabRoute(`diff:git:/p/README.md?x ${file}`)).toBe(editorRoute(`diff:git:/p/README.md?x ${file}`));
    expect(tabRoute('vscode-userdata:/home/u/.vscode-server/data/User/settings.json')).toBeDefined();
    for (const key of ['workbench.editors.webviewInput|webview-panel:webview-panel/webview-1', 'changes:scm/git/resourceGroup', 'untitled:Untitled-1', 'vscode-terminal:/1/2', 'output:extension-output-1', 'Settings']) {
      expect(tabRoute(key)).toBeUndefined();
    }
    // A key shortened by `bounded`, or whose route the host wouldn't take.
    expect(tabRoute(`vscode-remote://h/${'a'.repeat(1010)}`)).toBeUndefined();
    expect(tabRoute(`vscode-remote://h/${'/'.repeat(700)}x`)).toBeUndefined();
  });
});

describe('the service hands editors from frame to frame', () => {
  test('a request waits for its tab, once, for a minute', () => {
    let now = 0;
    const requests = new EditorRequests(() => now);
    requests.put('a', { kind: 'editor' });
    expect(requests.take('a')).toEqual({ kind: 'editor' });
    expect(requests.take('a')).toBeNull();
    requests.put('b', { kind: 'editor' });
    now += 61_000;
    expect(requests.take('b')).toBeNull();
  });

  test('the page\'s tabs are kept per server, privately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-tabs-'));
    const tabs = new SavedTabs(dir, () => {});
    await tabs.save('k', readTabs([{ id: 'vscode-remote://h/a.ts', title: 'a.ts', icon: 'file-code' }, { id: '', title: 'bad' }, { id: 'x', title: 'y', icon: '<svg/>' }]));
    expect(await new SavedTabs(dir, () => {}).load('k')).toEqual([{ id: 'vscode-remote://h/a.ts', title: 'a.ts', icon: 'file-code' }, { id: 'x', title: 'y' }]);
    expect(statSync(join(dir, 'k.tabs.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'k.tabs.json'), 'utf8'))).toHaveLength(2);
    expect(await tabs.load('other')).toEqual([]);
    // One list per server and folder.
    expect(SavedTabs.keyOf('srv', '/p/a')).not.toBe(SavedTabs.keyOf('srv', '/p/b'));
    expect(SavedTabs.keyOf('srv', '/p/a')).toBe(SavedTabs.keyOf('srv', '/p/a'));
    expect(SavedTabs.keyOf('srv', 'relative')).toBe(SavedTabs.keyOf('srv', null));
    expect(SavedTabs.keyOf('srv', '/p/a')).toMatch(/^srv\.[0-9a-f]{16}$/);
  });
});
