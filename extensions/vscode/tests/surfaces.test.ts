import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorRequests, readPart, readTabs, SavedTabs } from '../service/editors.ts';
import {
  editorKeyOf,
  editorRoute,
  isPortable,
  keyHash,
  leastRecentlyUsed,
  marshal,
  pageRoute,
  readEditorRoute,
  readOpenRequest,
  requestTitle,
  restoredTabOf,
  roleOf,
  roleSettings,
  routeNames,
  tabChunks,
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
    // Saved under an older host, which took 80 characters: its title cut there is the same title.
    const long = `Preview ${'chapter-'.repeat(15)}.md`;
    expect(restoredTabOf([{ id: preview('old'), title: tabTitle(long, 80) }], preview('new'), tabTitle(long, 512), new Set())).toBe(preview('old'));
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
    expect(requestTitle({ resource: remote(`/p/${'n'.repeat(300)}.ts`) }, 512)).toBe(`${'n'.repeat(300)}.ts`);
    expect(tabIcon('vscode-remote://h/p/README.md')).toBe('file-text');
    expect(tabIcon('vscode-remote://h/p/a.png')).toBe('file-image');
    expect(tabIcon('diff:a b')).toBe('git-commit');
    expect(tabIcon('vscode-remote://h/p/main.ts')).toBe('file-code');
  });

  test("a title as long as the host takes: a file's whole name (255 bytes at most) under a current host, cut by characters", () => {
    // An older host takes 80 characters, a current one 512 (its hello says).
    const name = `${'report-'.repeat(36)}final.pdf`;
    expect(name.length).toBe(261);
    expect(tabTitle(name, 512)).toBe(name);
    expect(tabTitle(name)).toHaveLength(80);
    expect(tabTitle(name).endsWith('…')).toBe(true);
    expect(tabTitle('x'.repeat(600), 512)).toHaveLength(512);
    // Never inside a character: an emoji is two UTF-16 units, and the host counts units.
    const emoji = tabTitle('😀'.repeat(60), 80);
    expect(emoji.length).toBeLessThanOrEqual(80);
    expect(emoji).toMatch(/^(😀)+…$/);
    // Nor a space before the ellipsis (the host trims, and the page would send it again and again).
    expect(tabTitle(`${'word '.repeat(30)}`, 80)).toMatch(/\S…$/);
    expect(tabTitle('   ')).toBe('Untitled');
  });

  test('every editor has a route the host takes, naming it: its link, or for a key too long for one, its hash', () => {
    const file = 'vscode-remote://h/p/a.ts';
    expect(pageRoute(file)).toBe(editorRoute(file));
    // A key the host takes as a tab id (1024 characters) can make a route of 3,000 (each `/` is `%2F`).
    // (A key of half slashes still fits: `d/` repeated makes a route of 2,027.)
    expect(editorRoute(editorKeyOf({ resource: remote(`/${'d/'.repeat(1500)}x.ts`) })!).length).toBeLessThanOrEqual(2048);
    for (const key of [`vscode-remote://h/${'/'.repeat(1000)}x`, editorKeyOf({ resource: remote(`/${'/'.repeat(1500)}x.ts`) })!]) {
      expect(key.length).toBeLessThanOrEqual(1024);
      expect(editorRoute(key).length).toBeGreaterThan(2048);
      const route = pageRoute(key);
      expect(route).toBe(`/editor?tab=${keyHash(key)}`);
      expect(route.length).toBeLessThanOrEqual(2048);
      const target = readEditorRoute(route)!;
      expect(target).toEqual({ key: `#${keyHash(key)}`, line: null });
      expect(routeNames(target.key, key)).toBe(true);
      expect(routeNames(target.key, file)).toBe(false);
    }
    expect(routeNames(file, file)).toBe(true);
    expect(keyHash('a')).not.toBe(keyHash('b'));
    expect(keyHash('a')).toMatch(/^[0-9a-z]{1,12}$/);
    expect(readEditorRoute('/editor?tab=../../x')).toBeNull();
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

describe('the header full: what makes room', () => {
  const editor = (key: string, flags: Partial<{ dirty: boolean; sticky: boolean; visible: boolean }> = {}) => ({ key, dirty: false, sticky: false, visible: false, ...flags });

  test('the editors used least recently close first, as VS Code\'s workbench.editor.limit closes them', () => {
    // Most recently used first: e is the one used least recently.
    const editors = [editor('a', { visible: true }), editor('b'), editor('c', { dirty: true }), editor('d', { sticky: true }), editor('e')];
    expect(leastRecentlyUsed(editors, new Set(), 1)).toEqual(['e']);
    // Never one with unsaved changes, a pinned one, one on screen.
    expect(leastRecentlyUsed(editors, new Set(), 5)).toEqual(['e', 'b']);
    // Nor one the caller keeps (the editors waiting for a tab).
    expect(leastRecentlyUsed(editors, new Set(['e']), 1)).toEqual(['b']);
    expect(leastRecentlyUsed([editor('a', { dirty: true })], new Set(), 1)).toEqual([]);
    expect(leastRecentlyUsed(editors, new Set(), 0)).toEqual([]);
  });
});

describe('the saved tabs, in parts when one request is too small for them', () => {
  // A request as the page makes it (the service's server fields, the list) and as OpenChamber's route takes it:
  // a body of 64,000 characters at most, in a JSON request of 80 KB.
  const fits = (tabs: unknown[]) => {
    const body = JSON.stringify({ serverUrl: 'http://127.0.0.1:35392/base', token: 't'.repeat(48), folder: '/p'.repeat(60), tabs, part: { revision: 'mbabcdef12', index: 0, count: 99 } });
    const request = JSON.stringify({ method: 'POST', path: '/tabs/save', body, viewerId: 'v'.repeat(36) });
    return body.length <= 64_000 && new TextEncoder().encode(request).length <= 80 * 1024;
  };
  const many = (count: number, idLength: number, title = (index: number) => `file-${index}.ts`) => Array.from({ length: count }, (_, index) => ({
    id: `vscode-remote://h/${String(index).padStart(6, '0')}/${'"%é/'.repeat(Math.max(0, Math.floor((idLength - 30) / 4)))}`.slice(0, idLength),
    title: title(index),
    icon: 'file-code',
  }));

  test('one part while they fit, as before; parts each a request takes otherwise, in order', () => {
    expect(tabChunks([])).toEqual([[]]);
    const few = many(20, 90);
    expect(tabChunks(few)).toEqual([few]);
    // A thousand tabs with ids of 1024 characters (quotes and non-ASCII escaped in the request) and long titles.
    const heavy = many(1000, 1024, (index) => `${'題'.repeat(200)}-${index}`);
    const parts = tabChunks(heavy);
    expect(parts.length).toBeGreaterThan(20);
    expect(parts.every((part) => part.length > 0 && fits(part))).toBe(true);
    expect(parts.flat()).toEqual(heavy);
  });

  test('the service keeps a list sent in parts once they have all come, and as long as any host takes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-tabs-parts-'));
    const saved = new SavedTabs(dir, () => {});
    const tabs = many(1000, 120).map((tab, index) => ({ ...tab, title: index === 0 ? 't'.repeat(512) : tab.title }));
    expect(readTabs(tabs)).toHaveLength(1000);
    expect(readTabs([{ id: 'x', title: 't'.repeat(513) }])).toEqual([]);
    const parts = tabChunks(tabs, 20_000);
    expect(parts.length).toBeGreaterThan(2);
    await saved.save('k', readTabs(many(3, 40)));
    // In any order; until the last has come the list is the one before.
    const order = [...parts.keys()].reverse();
    for (const [step, index] of order.entries()) {
      await saved.savePart('k', { revision: 'r1', index, count: parts.length }, readTabs(parts[index]));
      if (step < order.length - 1) expect(await saved.load('k')).toHaveLength(3);
    }
    expect(await saved.load('k')).toEqual(readTabs(tabs));
    expect(await new SavedTabs(dir, () => {}).load('k')).toHaveLength(1000);
  });

  test('two windows saving at once: the revision that completes is kept and takes the older ones with it, not the newer', async () => {
    const saved = new SavedTabs(mkdtempSync(join(tmpdir(), 'vscode-tabs-revisions-')), () => {});
    const a = many(4, 40, (index) => `a${index}`);
    const b = many(4, 40, (index) => `b${index}`);
    const c = many(4, 40, (index) => `c${index}`);
    await saved.savePart('k', { revision: 'a', index: 0, count: 2 }, a.slice(0, 2));
    await saved.savePart('k', { revision: 'b', index: 0, count: 2 }, b.slice(0, 2));
    await saved.savePart('k', { revision: 'c', index: 0, count: 2 }, c.slice(0, 2));
    await saved.savePart('k', { revision: 'b', index: 1, count: 2 }, b.slice(2));
    expect(await saved.load('k')).toEqual(b);
    // a began before b and went with it; c began after, and completes.
    await saved.savePart('k', { revision: 'a', index: 1, count: 2 }, a.slice(2));
    expect(await saved.load('k')).toEqual(b);
    await saved.savePart('k', { revision: 'c', index: 1, count: 2 }, c.slice(2));
    expect(await saved.load('k')).toEqual(c);
  });

  test('a part is read defensively', () => {
    expect(readPart({ revision: 'mbabc123', index: 1, count: 3 })).toEqual({ revision: 'mbabc123', index: 1, count: 3 });
    for (const part of [null, {}, { revision: 'x', index: 3, count: 3 }, { revision: '../x', index: 0, count: 1 }, { revision: 'x', index: 0, count: 0 }, { revision: 'x', index: 0, count: 10_000 }, { revision: 'x', index: 0.5, count: 2 }]) {
      expect(readPart(part)).toBeNull();
    }
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
