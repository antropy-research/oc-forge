import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOcForgeRailEntries } from '../../../adapters/openchamber/client/index.ts';
import { BUILT_IN_ENTRIES, codiconIcon, declaredContainers, ENTRIES_MAX, entryIdOf, entryOfView, followView, MORE_ENTRY_ID, type RailEntry, railEntries, railSvg, TERMINAL_ENTRY } from '../src/rail.ts';
import { installedFolders, Rail } from '../service/rail.ts';
import type { VscodeServer } from '../service/server.ts';

const CIRCLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';

describe('VS Code\'s activity bar as rail entries', () => {
  test('the five built-ins in VS Code\'s order, then the extensions\', then the terminal at the bottom', () => {
    const entries = railEntries([{ extension: 'a', containers: [{ id: 'todoTree', title: 'Todo Tree', icon: 'media/todo.svg', svg: CIRCLE }] }]);
    // As the host shows them (it orders them by `order`).
    expect(readOcForgeRailEntries({ entries })!.map((entry) => entry.id)).toEqual(['explorer', 'search', 'scm', 'debug', 'extensions', 'todo-tree', 'terminal']);
    expect(entries.find((entry) => entry.id === 'todo-tree')).toMatchObject({ title: 'Todo Tree', icon: CIRCLE, view: 'workbench.view.extension.todoTree' });
    expect(entries.find((entry) => entry.id === 'terminal')).toEqual({ ...TERMINAL_ENTRY });
    expect(entryOfView(entries, 'workbench.view.scm')).toBe('scm');
    expect(entryOfView(entries, 'workbench.view.extension.todoTree')).toBe('todo-tree');
  });

  test('every entry passes the host\'s own rules (adapters/openchamber/host/protocol.ts)', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `view${index}`, title: `View ${index}`, icon: '$(beaker)' }));
    const entries = railEntries([{ extension: 'many', containers: many }]);
    expect(entries).toHaveLength(46);
    const read = readOcForgeRailEntries({ entries });
    expect(read).toHaveLength(entries.length);
    expect(read!.at(-1)!.id).toBe('terminal');
    expect(read!.find((entry) => entry.id === 'terminal')!.zone).toBe('bottom');
  });

  test('past the host\'s room "Additional Views" opens the containers left; none is dropped', () => {
    const containers = (count: number) => [{ extension: 'many', containers: Array.from({ length: count }, (_, index) => ({ id: `view${index}`, title: `View ${index}`, icon: '$(beaker)' })) }];
    const covered = (entries: ReturnType<typeof railEntries>, count: number) => Array.from({ length: count }, (_, index) => `workbench.view.extension.view${index}`)
      .every((view) => entryOfView(entries, view) !== null);
    // 94 containers fill the host's 100 entries with the built-ins and the terminal; one more needs the overflow.
    expect(railEntries(containers(94)).some((entry) => entry.id === MORE_ENTRY_ID)).toBe(false);
    const entries = railEntries(containers(120));
    expect(entries).toHaveLength(ENTRIES_MAX);
    const more = entries.find((entry) => entry.id === MORE_ENTRY_ID)!;
    expect(more).toMatchObject({ title: 'Additional Views (27)', icon: 'more' });
    expect(more.more).toHaveLength(27);
    expect(more.more![0]).toEqual({ view: 'workbench.view.extension.view93', title: 'View 93' });
    expect(covered(entries, 120)).toBe(true);
    expect(entryOfView(entries, 'workbench.view.extension.view119')).toBe(MORE_ENTRY_ID);
    expect(entryOfView(entries, 'workbench.view.extension.view92')).toBe('view92');
    // As the host shows them: the containers with room, then "Additional Views", then the terminal.
    const shown = readOcForgeRailEntries({ entries })!.map((entry) => entry.id);
    expect(shown).toHaveLength(ENTRIES_MAX);
    expect(shown.slice(-3)).toEqual(['view92', MORE_ENTRY_ID, 'terminal']);
    // For a host that takes fewer: within them, and a host that cut the list short keeps the built-ins and the terminal.
    const fewer = railEntries(containers(40), 32);
    expect(fewer).toHaveLength(32);
    expect(fewer.find((entry) => entry.id === MORE_ENTRY_ID)!.more).toHaveLength(15);
    expect(covered(fewer, 40)).toBe(true);
    expect(entries.slice(0, 32).map((entry) => entry.id)).toEqual(expect.arrayContaining(['explorer', 'extensions', 'terminal', MORE_ENTRY_ID]));
  });

  test('as extensions come and go, "Additional Views" holds the containers left then, and a container moves between its own entry and it', () => {
    const extension = (prefix: string, count: number) => ({ extension: prefix, containers: Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, title: `${prefix} ${index + 1}`, icon: '$(beaker)' })) });
    const view = (id: string) => `workbench.view.extension.${id}`;
    const more = (entries: ReturnType<typeof railEntries>) => entries.find((entry) => entry.id === MORE_ENTRY_ID);
    // 96 containers: 93 entries, 94-96 behind "Additional Views".
    const before = railEntries([extension('a', 96)]);
    expect(more(before)!.more!.map((item) => item.view)).toEqual(['a94', 'a95', 'a96'].map(view));
    // Another extension's container, installed later (listed after the first): behind it too, the title counting it.
    const after = railEntries([extension('a', 96), extension('b', 1)]);
    expect(more(after)).toMatchObject({ title: 'Additional Views (4)' });
    expect(more(after)!.more!.map((item) => item.view)).toEqual(['a94', 'a95', 'a96', 'b1'].map(view));
    expect(entryOfView(after, view('b1'))).toBe(MORE_ENTRY_ID);
    // Uninstalled again: as before.
    expect(railEntries([extension('a', 96)])).toEqual(before);
    // 94 containers fill the rail; one more moves the 94th behind "Additional Views", and its removal brings it back.
    expect(entryOfView(railEntries([extension('a', 94)]), view('a94'))).toBe('a94');
    expect(entryOfView(railEntries([extension('a', 94), extension('b', 1)]), view('a94'))).toBe(MORE_ENTRY_ID);
    expect(railEntries([extension('a', 94), extension('b', 1)]).some((entry) => entry.id === 'a94')).toBe(false);
  });

  test('a rail view lights the entry of the container shown as containers come and go, and shows the first view once it has none', () => {
    const extension = (prefix: string, count: number) => ({ extension: prefix, containers: Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, title: `${prefix} ${index + 1}`, icon: '$(beaker)' })) });
    const view = (id: string) => `workbench.view.extension.${id}`;
    const filled = railEntries([extension('a', 94)]);
    const crowded = railEntries([extension('a', 94), extension('b', 1)]);
    const lit = (before: RailEntry[], now: RailEntry[], shown: string) => followView(before, now, shown, null).light;
    // Its own entry, a built-in's too.
    expect(lit(filled, filled, view('a94'))).toBe('a94');
    expect(lit(filled, filled, 'workbench.view.scm')).toBe('scm');
    // One more installed moves it behind "Additional Views", and that entry is lit; uninstalled, its own again.
    expect(lit(filled, crowded, view('a94'))).toBe(MORE_ENTRY_ID);
    expect(lit(crowded, filled, view('a94'))).toBe('a94');
    // Uninstalled while it shows (VS Code keeps it until a reload): after two reads without it, the first view.
    const first = followView(crowded, filled, view('b1'), null);
    expect(first).toEqual({ light: null, show: null, missing: view('b1') });
    expect(followView(filled, filled, view('b1'), first.missing)).toEqual({ light: null, show: 'explorer', missing: null });
    // Behind "Additional Views", which stays for the others: the same.
    const overflow = railEntries([extension('a', 96), extension('b', 1)]);
    const fewer = railEntries([extension('a', 96)]);
    expect(followView(fewer, fewer, view('b1'), followView(overflow, fewer, view('b1'), null).missing).show).toBe('explorer');
    // One read that missed it (a manifest it failed to read): the next one lists it again, and nothing changes.
    expect(followView(filled, crowded, view('b1'), first.missing)).toEqual({ light: MORE_ENTRY_ID, show: null, missing: null });
    // A container the rail never listed, or opened again after that (the command palette): it stays, nothing lit.
    expect(followView(filled, filled, view('b1'), null)).toEqual({ light: null, show: null, missing: null });
    expect(followView(filled, filled, 'workbench.view.testing', null)).toEqual({ light: null, show: null, missing: null });
  });

  test('entry ids are kebab-case, unique, and never a built-in\'s', () => {
    const taken = new Set(['explorer', 'search', 'gitlens']);
    expect(entryIdOf('gitlensInspect', taken)).toBe('gitlens-inspect');
    expect(entryIdOf('gitlens', taken)).toBe('gitlens-2');
    expect(entryIdOf('explorer', taken)).toBe('explorer-2');
    expect(entryIdOf('package_explorer', taken)).toBe('package-explorer');
    expect(entryIdOf('3dViewer', taken)).toBe('v-3d-viewer');
    expect(entryIdOf('a'.repeat(80), taken).length).toBeLessThanOrEqual(48);
    expect(entryIdOf('--weird..id--', taken)).toBe('weird-id');
  });

  test('a container\'s title from package.nls.json; malformed containers are dropped', () => {
    const manifest = { contributes: { viewsContainers: { activitybar: [
      { id: 'one', title: '%view.title%', icon: 'one.svg' },
      { id: 'two', title: 'Two', icon: '$(beaker)' },
      { id: 'bad id!', title: 'Bad', icon: 'x.svg' },
      { id: 'three' },
    ] } } };
    expect(declaredContainers(manifest, { 'view.title': 'One' })).toEqual([
      { id: 'one', title: 'One', icon: 'one.svg' },
      { id: 'two', title: 'Two', icon: '$(beaker)' },
    ]);
    expect(declaredContainers(manifest, { 'view.title': { message: 'Uno' } })[0]!.title).toBe('Uno');
    expect(declaredContainers({})).toEqual([]);
  });

  test('icons: an SVG cleaned for the mask, a codicon as a Remixicon, anything else the fallback', () => {
    expect(railSvg('<?xml version="1.0"?>\n<!-- a comment -->\n<svg width="16" height="16"><title>x</title><path onclick="x()" d="M0 0h16v16z"/></svg>\n'))
      .toBe('<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16z"/></svg>');
    expect(railSvg(CIRCLE)).toBe(CIRCLE);
    expect(railSvg('<html><svg/></html>')).toBeNull();
    expect(railSvg(`<svg>${'<path d="M0 0"/>'.repeat(2000)}</svg>`)).toBeNull();
    expect(codiconIcon('$(beaker)')).toBe('flask');
    expect(codiconIcon('$(sync~spin)')).toBe('apps');
    expect(codiconIcon('media/icon.png')).toBeNull();
    const entry = railEntries([{ extension: 'a', containers: [{ id: 'png', title: 'PNG', icon: 'icon.png', svg: null }] }]).find((item) => item.id === 'png');
    expect(entry!.icon).toBe('apps');
    expect(BUILT_IN_ENTRIES.map((item) => item.icon)).toEqual(['file-copy-2', 'search', 'git-branch', 'bug', 'puzzle']);
  });
});

describe('the service reads the installed extensions from the VS Code Server', () => {
  const listing = [
    { identifier: { id: 'pub.alpha' }, version: '1.0.0', relativeLocation: 'pub.alpha-1.0.0', location: { $mid: 1, path: '/home/u/.vscode-server/extensions/pub.alpha-1.0.0', scheme: 'file' } },
    { identifier: { id: 'pub.gone' }, version: '2.0.0', relativeLocation: 'pub.gone-2.0.0' },
    { identifier: { id: 'pub.beta' }, version: '0.1.0', location: { path: '/elsewhere/pub.beta' } },
    { identifier: { id: 'pub.evil' }, version: '1.0.0', relativeLocation: '../../etc' },
  ];

  test('extensions.json names each folder; uninstalled ones (.obsolete) are left out', () => {
    expect(installedFolders(listing, { 'pub.gone-2.0.0': true }, '/home/u/.vscode-server/extensions/').map((item) => item.folder)).toEqual([
      '/home/u/.vscode-server/extensions/pub.alpha-1.0.0',
      '/elsewhere/pub.beta',
    ]);
    expect(installedFolders('nope', null, '/x')).toEqual([]);
    // Reinstalled, the same version: another key, so its manifest (its containers' titles and icons) is read again.
    const at = (installedTimestamp: number) => installedFolders([{ ...listing[0], metadata: { installedTimestamp } }], null, '/x')[0]!.key;
    expect(at(1)).not.toBe(at(2));
    expect(at(1)).toBe(at(1));
  });

  test('entries from the server\'s files, kept when it is gone, and its address kept privately', async () => {
    const files: Record<string, string> = {
      '/ext/extensions.json': JSON.stringify(listing.slice(0, 1)),
      '/ext/pub.alpha-1.0.0/package.json': JSON.stringify({ contributes: { viewsContainers: { activitybar: [{ id: 'alphaView', title: '%t%', icon: 'media/a.svg' }] } } }),
      '/ext/pub.alpha-1.0.0/package.nls.json': JSON.stringify({ t: 'Alpha' }),
      '/ext/pub.alpha-1.0.0/media/a.svg': CIRCLE,
    };
    let reachable = true;
    const asked: string[] = [];
    const server = {
      url: 'http://vscode:8000',
      get: async (pathAndQuery: string) => {
        asked.push(pathAndQuery);
        if (!reachable) throw new Error('down');
        const path = new URL(pathAndQuery, 'http://x').searchParams.get('path')!;
        const body = files[path];
        return { status: body === undefined ? 404 : 200, contentType: 'application/octet-stream', body: Buffer.from(body ?? '') };
      },
    } as unknown as VscodeServer;
    const dir = mkdtempSync(join(tmpdir(), 'vscode-rail-'));
    let now = 1_000;
    const rail = new Rail(join(dir, 'rail.json'), () => server, () => {}, () => now);
    expect((await rail.entries()).map((entry) => entry.id)).toEqual(['explorer', 'search', 'scm', 'debug', 'extensions', 'terminal']);
    await rail.remember('http://vscode:8000', 'secret-token', '/ext');
    const entries = await rail.entries();
    expect(entries.find((entry) => entry.id === 'alpha-view')).toMatchObject({ title: 'Alpha', icon: CIRCLE, view: 'workbench.view.extension.alphaView' });
    expect(asked[0]).toBe('/vscode-remote-resource?path=%2Fext%2Fextensions.json');
    const saved = join(dir, 'rail.json');
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual({ serverUrl: 'http://vscode:8000', token: 'secret-token', extensionsPath: '/ext' });
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    // Every browser window polls: a second within a second is the same answer, not another read.
    const reads = asked.length;
    await rail.entries();
    expect(asked.length).toBe(reads);
    // The server restarts: the icons stay.
    reachable = false;
    now += 5_000;
    expect((await rail.entries()).some((entry) => entry.id === 'alpha-view')).toBe(true);
    // Uninstalled: gone with the next read.
    reachable = true;
    files['/ext/extensions.json'] = '[]';
    now += 5_000;
    expect((await rail.entries()).some((entry) => entry.id === 'alpha-view')).toBe(false);
    // Installed again while the service runs: back with the next read.
    files['/ext/extensions.json'] = JSON.stringify(listing.slice(0, 1));
    now += 5_000;
    expect((await rail.entries()).some((entry) => entry.id === 'alpha-view')).toBe(true);
    // After a restart the service still knows where to look.
    const again = new Rail(saved, () => server, () => {}, () => now);
    expect((await again.entries()).some((entry) => entry.id === 'alpha-view')).toBe(true);
  });
});
