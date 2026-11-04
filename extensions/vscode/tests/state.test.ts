import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, readOps, WorkbenchState, type Parts, type StateSnapshot } from '../service/state.ts';
import { batchOps, decodeValue, encodeValue, persistentIndexedDB, saveInBackground, saveThroughService, watchForChanges, type StateOp, type Timers } from '../workbench/storage.ts';
import { STORAGE_SCOPES, VscodeServices, type Disposable } from '../workbench/vscode.ts';

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

  test("VS Code's save before a reload waits for the service; its periodic saves don't", async () => {
    const order: string[] = [];
    const storageService = {
      flush: async (reason?: number) => {
        order.push(`vscode ${reason ?? 0}`);
      },
    };
    let delivered: () => void = () => {};
    const service = () => new Promise<void>((resolve) => {
      order.push('service');
      delivered = () => {
        order.push('delivered');
        resolve();
      };
    });
    const saveBeforeReload = saveThroughService(storageService, service);
    await storageService.flush(0);
    expect(order).toEqual(['vscode 0']);
    const shutdown = storageService.flush(1).then(() => order.push('reload'));
    await Bun.sleep(5);
    expect(order).toEqual(['vscode 0', 'vscode 1', 'service']);
    delivered();
    await shutdown;
    expect(order.slice(-2)).toEqual(['delivered', 'reload']);
    order.length = 0;
    const own = saveBeforeReload();
    await Bun.sleep(5);
    delivered();
    await own;
    expect(order).toEqual(['vscode 1', 'service', 'delivered']);
  });

});

/** Timers on a clock the test moves. */
const manualClock = () => {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    set: (run, ms) => {
      pending.set(++next, { at: now + ms, run });
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  const settle = async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  };
  return {
    timers,
    armed: () => pending.size,
    /** Moves the clock by `ms`, running each timer that falls due, and what it sets in motion. */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
};

describe("VS Code's state saved while the frame doesn't have the focus", () => {
  /** A storage service whose saves the test ends; how many ran and how many at once at most. */
  const storageService = () => {
    const ends: (() => void)[] = [];
    const counts = { started: 0, running: 0, most: 0 };
    return {
      counts,
      ends,
      flush: () => {
        counts.started += 1;
        counts.running += 1;
        counts.most = Math.max(counts.most, counts.running);
        return new Promise<void>((resolve) => ends.push(() => {
          counts.running -= 1;
          resolve();
        }));
      },
      endAll: () => ends.splice(0).forEach((end) => end()),
    };
  };

  test('a few seconds after a change it saves, once; while nothing changed it never does', async () => {
    const clock = manualClock();
    const storage = storageService();
    const saves = saveInBackground(storage, () => false, { interval: 5_000, timers: clock.timers });
    await clock.advance(60_000);
    expect(storage.counts.started).toBe(0);
    saves.changed();
    await clock.advance(4_999);
    expect(storage.counts.started).toBe(0);
    await clock.advance(1);
    expect(storage.counts.started).toBe(1);
    storage.endAll();
    await clock.advance(60_000);
    expect(storage.counts.started).toBe(1);
  });

  test('with the focus VS Code saves itself: the frame waits until the focus is gone', async () => {
    const clock = manualClock();
    const storage = storageService();
    let focused = true;
    const saves = saveInBackground(storage, () => focused, { interval: 5_000, timers: clock.timers });
    saves.changed();
    await clock.advance(30_000);
    expect(storage.counts.started).toBe(0);
    focused = false;
    await clock.advance(5_000);
    expect(storage.counts.started).toBe(1);
  });

  test('one save at a time: a slow one holds the next, which comes an interval after it ended', async () => {
    const clock = manualClock();
    const storage = storageService();
    const saves = saveInBackground(storage, () => false, { interval: 5_000, timers: clock.timers });
    saves.changed();
    await clock.advance(5_000);
    expect(storage.counts.started).toBe(1);
    expect(saves.saving()).toBe(true);
    saves.changed();
    await clock.advance(60_000);
    // Still the first: nothing is timed while it runs.
    expect(storage.counts.started).toBe(1);
    expect(clock.armed()).toBe(0);
    storage.endAll();
    await clock.advance(0);
    expect(saves.saving()).toBe(false);
    await clock.advance(4_999);
    expect(storage.counts.started).toBe(1);
    await clock.advance(1);
    expect(storage.counts.started).toBe(2);
    expect(storage.counts.most).toBe(1);
  });

  test("what VS Code stores while a save collects its state is that save's, not a change; what comes after is", async () => {
    const clock = manualClock();
    let saves: ReturnType<typeof saveInBackground> | null = null;
    let started = 0;
    let later = false;
    const storage = {
      flush: async () => {
        started += 1;
        // onWillSaveState: everyone stores their state at once, which VS Code reports as changed values.
        saves?.changed();
        if (later) queueMicrotask(() => saves?.changed());
      },
    };
    saves = saveInBackground(storage, () => false, { interval: 5_000, timers: clock.timers });
    saves.changed();
    await clock.advance(30_000);
    expect(started).toBe(1);
    later = true;
    saves.changed();
    await clock.advance(5_000);
    expect(started).toBe(2);
    later = false;
    await clock.advance(5_000);
    expect(started).toBe(3);
    await clock.advance(30_000);
    expect(started).toBe(3);
  });

  test('a failed save stops nothing; disposed, it saves no more', async () => {
    const clock = manualClock();
    let started = 0;
    const saves = saveInBackground({ flush: async () => {
      started += 1;
      throw new Error('the databases are gone');
    } }, () => false, { interval: 5_000, timers: clock.timers });
    saves.changed();
    await clock.advance(5_000);
    saves.changed();
    await clock.advance(5_000);
    expect(started).toBe(2);
    saves.changed();
    saves.dispose();
    await clock.advance(30_000);
    expect(started).toBe(2);
    expect(clock.armed()).toBe(0);
  });

  test("a change is what VS Code's interfaces report (editors, view containers, stored values, a webview's state) and the user's input in the frame", () => {
    /** An event of VS Code's: its listeners, and what removed them. */
    const emitter = () => {
      const listeners = new Set<() => void>();
      const event = (listener: () => void): Disposable => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      };
      return { event, fire: () => listeners.forEach((listener) => listener()), count: () => listeners.size };
    };
    const editors = emitter();
    const panes = emitter();
    const values = new Map<number, ReturnType<typeof emitter>>(STORAGE_SCOPES.map((scope) => [scope, emitter()]));
    const kept: Disposable[] = [];
    const webviewState = [emitter(), emitter()];
    const webviews: { onDidUpdateState: ReturnType<typeof emitter>['event'] }[] = [{ onDidUpdateState: webviewState[0]!.event }];
    const registry: Record<string, unknown> = {
      storageService: {
        flush: async () => {},
        onDidChangeValue: (scope: number, key: string | undefined, store: { add<T extends Disposable>(disposable: T): T }) => {
          expect(key).toBeUndefined();
          kept.push(store.add({ dispose: () => {} }));
          return values.get(scope)!.event;
        },
      },
      editorService: { onDidEditorsChange: editors.event },
      paneCompositePartService: { onDidPaneCompositeOpen: panes.event },
      webviewService: { get webviews() {
        return webviews;
      } },
    };
    const services = new VscodeServices({ invokeFunction: (fn) => fn({ get: (id) => registry[id as string] }) }, new Map(Object.keys(registry).map((name) => [name, name])));
    const handlers = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: () => void) => void handlers.set(type, listener),
      removeEventListener: (type: string) => void handlers.delete(type),
    };
    let changes = 0;
    const watch = watchForChanges(services, target, () => {
      changes += 1;
    });
    expect(kept.length).toBe(STORAGE_SCOPES.length);
    const fired: string[] = [];
    const counted = (what: string, fire: () => void) => {
      const before = changes;
      fire();
      if (changes > before) fired.push(what);
    };
    for (const scope of STORAGE_SCOPES) counted(`value ${scope}`, () => values.get(scope)!.fire());
    counted('editors', () => editors.fire());
    counted('view container', () => panes.fire());
    // Webviews are looked for again at each change: the first is watched now, a later one after the next change.
    counted('webview state', () => webviewState[0]!.fire());
    webviews.push({ onDidUpdateState: webviewState[1]!.event });
    counted('webview not watched yet', () => webviewState[1]!.fire());
    counted('editors again', () => editors.fire());
    counted('second webview state', () => webviewState[1]!.fire());
    for (const type of ['wheel', 'pointerdown', 'keydown', 'blur']) counted(type, () => handlers.get(type)!());
    expect(fired).toEqual([...STORAGE_SCOPES.map((scope) => `value ${scope}`), 'editors', 'view container', 'webview state', 'editors again', 'second webview state', 'wheel', 'pointerdown', 'keydown', 'blur']);
    watch.dispose();
    expect(editors.count() + panes.count() + webviewState[0]!.count() + webviewState[1]!.count() + handlers.size).toBe(0);
    for (const scope of STORAGE_SCOPES) expect(values.get(scope)!.count()).toBe(0);
  });
});
