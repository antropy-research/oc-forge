import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, readOps, WorkbenchState, type Parts, type StateSnapshot } from '../service/state.ts';
import { batchOps, decodeValue, encodeValue, persistentIndexedDB, type StateOp } from '../workbench/storage.ts';

describe('the service keeps the workbench storage', () => {
  test('ops are checked; malformed ones are dropped', () => {
    expect(readOps([
      { op: 'db', db: 'vscode-web-db', version: 3, stores: ['vscode-userdata-store'] },
      { op: 'put', db: 'vscode-web-db', store: 'vscode-userdata-store', key: '/User/settings.json', value: { b: 'e30=' } },
      { op: 'put', db: 'x', store: 's', key: 'k', value: { s: 'v', extra: 1 } },
      { op: 'put', db: '../etc', store: 's', key: 'k', value: { s: 'v' } },
      { op: 'delete', db: 'x', store: 's' },
      'nonsense',
    ])).toEqual([
      { op: 'db', db: 'vscode-web-db', version: 3, stores: ['vscode-userdata-store'] },
      { op: 'put', db: 'vscode-web-db', store: 'vscode-userdata-store', key: '/User/settings.json', value: { b: 'e30=' } },
    ]);
  });

  test('puts, deletes, clears and drops; a long value lands once all its parts are in', () => {
    const snapshot: StateSnapshot = { format: 1, dbs: {} };
    const parts: Parts = new Map();
    applyOps(snapshot, [
      { op: 'db', db: 'state', version: 1, stores: ['ItemTable'] },
      { op: 'put', db: 'state', store: 'ItemTable', key: 'a', value: { s: '1' } },
      { op: 'put', db: 'state', store: 'ItemTable', key: 'b', value: { s: '2' } },
      { op: 'delete', db: 'state', store: 'ItemTable', key: 'a' },
      { op: 'put', db: 'state', store: 'ItemTable', key: 'long', value: { s: 'wor' }, part: { id: 'p1', index: 1, count: 2 } },
    ], parts);
    expect(snapshot.dbs.state!.stores.ItemTable).toEqual({ b: { s: '2' } });
    applyOps(snapshot, [{ op: 'put', db: 'state', store: 'ItemTable', key: 'long', value: { s: 'hello ' }, part: { id: 'p1', index: 0, count: 2 } }], parts);
    expect(snapshot.dbs.state!.stores.ItemTable!.long).toEqual({ s: 'hello wor' });
    applyOps(snapshot, [{ op: 'clear', db: 'state', store: 'ItemTable' }], parts);
    expect(snapshot.dbs.state!.stores.ItemTable).toEqual({});
    applyOps(snapshot, [{ op: 'drop', db: 'state' }], parts);
    expect(snapshot.dbs.state).toBeUndefined();
  });

  test('one private file per VS Code Server, written after changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-state-'));
    const key = WorkbenchState.keyOf('http://vscode:8000', null);
    const state = new WorkbenchState(dir, () => {});
    await state.apply(key, [{ op: 'put', db: 'd', store: 's', key: 'k', value: { s: 'v' } }]);
    await state.flush();
    const file = join(dir, `${key}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8')).dbs.d.stores.s.k).toEqual({ s: 'v' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new WorkbenchState(dir, () => {});
    expect((await again.load(key)).dbs.d!.stores.s!.k).toEqual({ s: 'v' });
    expect(WorkbenchState.keyOf('http://other:8000', null)).not.toBe(key);
  });

  test('in OpenChamber\'s own surfaces each part keeps its layout; all share the user\'s settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vscode-state-'));
    const key = WorkbenchState.keyOf('http://vscode:8000', null);
    const state = new WorkbenchState(dir, () => {});
    // The whole workbench of a stock OpenChamber, before: its settings and its layout.
    await state.apply(key, [
      { op: 'put', db: 'vscode-web-db', store: 'vscode-userdata-store', key: '/User/settings.json', value: { s: '{"a":1}' } },
      { op: 'put', db: 'vscode-web-state-db-ws1', store: 'ItemTable', key: 'workbench.sideBar.hidden', value: { s: 'false' } },
    ]);
    // The page's editor area starts from that layout and its open editors; a rail view from nothing.
    const editor = await state.loadRole(key, 'editor');
    expect(editor.dbs['vscode-web-state-db-ws1']!.stores.ItemTable!['workbench.sideBar.hidden']).toEqual({ s: 'false' });
    const view = await state.loadRole(key, 'view');
    expect(view.dbs['vscode-web-state-db-ws1']).toBeUndefined();
    expect(view.dbs['vscode-web-db']!.stores['vscode-userdata-store']!['/User/settings.json']).toEqual({ s: '{"a":1}' });
    // A part's layout stays its own; a setting changed in one is everyone's.
    await state.applyRole(key, 'view', [
      { op: 'put', db: 'vscode-web-state-db-ws1', store: 'ItemTable', key: 'workbench.sideBar.hidden', value: { s: 'true' } },
      { op: 'put', db: 'vscode-web-db', store: 'vscode-userdata-store', key: '/User/settings.json', value: { s: '{"a":2}' } },
    ]);
    await state.flush();
    const again = new WorkbenchState(dir, () => {});
    expect((await again.loadRole(key, 'view')).dbs['vscode-web-state-db-ws1']!.stores.ItemTable!['workbench.sideBar.hidden']).toEqual({ s: 'true' });
    expect((await again.loadRole(key, 'editor')).dbs['vscode-web-state-db-ws1']!.stores.ItemTable!['workbench.sideBar.hidden']).toEqual({ s: 'false' });
    expect((await again.load(key)).dbs['vscode-web-state-db-ws1']!.stores.ItemTable!['workbench.sideBar.hidden']).toEqual({ s: 'false' });
    expect((await again.loadRole(key, 'terminal')).dbs['vscode-web-db']!.stores['vscode-userdata-store']!['/User/settings.json']).toEqual({ s: '{"a":2}' });
    expect(statSync(join(dir, `${key}.view.json`)).mode & 0o777).toBe(0o600);
  });
});

describe('the frame runs an IndexedDB that persists through the service', () => {
  test('values round-trip as text, bytes or JSON', () => {
    expect(decodeValue(encodeValue('text')!)).toBe('text');
    expect([...(decodeValue(encodeValue(new Uint8Array([1, 2, 250]))!) as Uint8Array)]).toEqual([1, 2, 250]);
    expect(decodeValue(encodeValue({ a: [1] })!)).toEqual({ a: [1] });
  });

  test('batches fit a request; a long value is cut into parts', () => {
    const ops: StateOp[] = [
      { op: 'put', db: 'd', store: 's', key: 'small', value: { s: 'x' } },
      { op: 'put', db: 'd', store: 's', key: 'big', value: { b: 'A'.repeat(70_000) } },
    ];
    let id = 0;
    const batches = batchOps(ops, () => `p${id++}`);
    const flat = batches.flat();
    expect(flat.filter((op) => op.op === 'put' && op.key === 'big').length).toBe(3);
    for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThan(64_000);
  });

  test('restores the snapshot before the workbench opens it, then reports its changes', async () => {
    const snapshot = { format: 1 as const, dbs: { 'vscode-web-state-db-global': { version: 1, stores: { ItemTable: { 'workbench.colorTheme': { s: 'Dark 2026' } } } } } };
    const sent: StateOp[][] = [];
    const storage = persistentIndexedDB(snapshot, async (ops) => {
      sent.push(ops);
    });
    await storage.ready;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = storage.factory.open('vscode-web-state-db-global', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve) => {
      const request = db.transaction('ItemTable').objectStore('ItemTable').get('workbench.colorTheme');
      request.onsuccess = () => resolve(request.result);
    });
    expect(value).toBe('Dark 2026');
    await new Promise<void>((resolve) => {
      const transaction = db.transaction('ItemTable', 'readwrite');
      transaction.objectStore('ItemTable').put('Light 2026', 'workbench.colorTheme');
      transaction.objectStore('ItemTable').delete('gone');
      transaction.oncomplete = () => resolve();
    });
    await storage.flush();
    const ops = sent.flat();
    expect(ops).toContainEqual({ op: 'put', db: 'vscode-web-state-db-global', store: 'ItemTable', key: 'workbench.colorTheme', value: { s: 'Light 2026' } });
    expect(ops).toContainEqual({ op: 'delete', db: 'vscode-web-state-db-global', store: 'ItemTable', key: 'gone' });
    expect(ops).toContainEqual({ op: 'db', db: 'vscode-web-state-db-global', version: 1, stores: ['ItemTable'] });
  });
});
