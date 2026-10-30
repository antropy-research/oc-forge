// IndexedDB for the workbench. An opaque-origin frame may not open IndexedDB,
// and VS Code keeps its settings, keybindings, open editors and layout there.
// This is fake-indexeddb (an in-memory IndexedDB) filled from the snapshot the
// service keeps, and every change goes back to the service.
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { SHUTDOWN, type StorageService } from './vscode.ts';

export type StoredValue = { s: string } | { b: string } | { j: unknown };
export type StateOp =
  | { op: 'db'; db: string; version: number; stores: string[] }
  | { op: 'put'; db: string; store: string; key: string; value: StoredValue; part?: { id: string; index: number; count: number } }
  | { op: 'delete'; db: string; store: string; key: string }
  | { op: 'clear'; db: string; store: string }
  | { op: 'drop'; db: string };
export interface StateSnapshot {
  format: 1;
  dbs: Record<string, { version: number; stores: Record<string, Record<string, StoredValue>> }>;
}

/** Stores not worth keeping: VS Code's logs and file handles (which a browser cannot reopen anyway). */
const SKIPPED = new Set(['vscode-logs-store', 'vscode-filehandles-store']);
/** One request to the service stays well under the host's 64,000-character body. */
const BATCH_CHARS = 40_000;
const PART_CHARS = 30_000;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const encodeValue = (value: unknown): StoredValue | null => {
  if (typeof value === 'string') return { s: value };
  if (value instanceof Uint8Array) return { b: toBase64(value) };
  if (value instanceof ArrayBuffer) return { b: toBase64(new Uint8Array(value)) };
  try {
    return { j: JSON.parse(JSON.stringify(value)) as unknown };
  } catch {
    return null;
  }
};

export const decodeValue = (value: StoredValue): unknown => ('s' in value ? value.s : 'b' in value ? fromBase64(value.b) : value.j);

/** Ops cut into requests the host accepts; a long value goes in parts. */
export const batchOps = (ops: StateOp[], nextId: () => string): StateOp[][] => {
  const batches: StateOp[][] = [];
  let batch: StateOp[] = [];
  let size = 0;
  const push = (op: StateOp, length: number) => {
    if (batch.length > 0 && size + length > BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(op);
    size += length;
  };
  for (const op of ops) {
    if (op.op === 'put' && !('j' in op.value)) {
      const text = 's' in op.value ? op.value.s : op.value.b;
      if (text.length > PART_CHARS) {
        const count = Math.ceil(text.length / PART_CHARS);
        const id = nextId();
        for (let index = 0; index < count; index++) {
          const piece = text.slice(index * PART_CHARS, (index + 1) * PART_CHARS);
          push({ ...op, value: 's' in op.value ? { s: piece } : { b: piece }, part: { id, index, count } }, piece.length + 200);
        }
        continue;
      }
    }
    push(op, JSON.stringify(op).length);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

/**
 * An IndexedDB factory holding `snapshot`, which reports each change through
 * `send` (batched, in order). Await `ready` before the workbench opens it.
 */
export const persistentIndexedDB = (snapshot: StateSnapshot, send: (ops: StateOp[]) => Promise<void>): { factory: IDBFactory; ready: Promise<void>; flush: () => Promise<void> } => {
  const factory = new IDBFactory();
  let restoring = true;
  let pending: StateOp[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = Promise.resolve();
  let partId = 0;
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const ops = pending;
    pending = [];
    if (ops.length === 0) return sending;
    sending = sending.then(async () => {
      for (const batch of batchOps(ops, () => `p${Date.now().toString(36)}${partId++}`)) {
        try {
          await send(batch);
        } catch {
          // The service restarted or the request failed; the next change sends its own state.
        }
      }
    });
    return sending;
  };
  const record = (op: StateOp) => {
    if (restoring) return;
    if ('store' in op && SKIPPED.has(op.store)) return;
    pending.push(op);
    timer ??= setTimeout(() => void flush(), 500);
  };

  // Every change to an object store goes through these four.
  const store = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => { addEventListener: (type: string, listener: () => void) => void }>;
  const wrap = (name: 'put' | 'add' | 'delete' | 'clear') => {
    const original = store[name]!;
    store[name] = function (this: { name: string; keyPath: string | string[] | null; transaction: { db: { name: string } } }, ...args: unknown[]) {
      const request = original.apply(this, args);
      const db = this.transaction.db.name;
      const storeName = this.name;
      request.addEventListener('success', () => {
        if (name === 'clear') return record({ op: 'clear', db, store: storeName });
        const rawKey = name === 'delete' ? args[0] : args[1] ?? (typeof this.keyPath === 'string' ? (args[0] as Record<string, unknown>)?.[this.keyPath] : undefined);
        if (typeof rawKey !== 'string') return;
        if (name === 'delete') return record({ op: 'delete', db, store: storeName, key: rawKey });
        const value = encodeValue(args[0]);
        if (value) record({ op: 'put', db, store: storeName, key: rawKey, value });
      });
      return request;
    } as never;
  };
  for (const name of ['put', 'add', 'delete', 'clear'] as const) wrap(name);

  const open = factory.open.bind(factory);
  factory.open = ((name: string, version?: number) => {
    const request = open(name, version);
    request.addEventListener('success', () => {
      const db = request.result;
      record({ op: 'db', db: name, version: db.version, stores: [...db.objectStoreNames] });
    });
    return request;
  }) as typeof factory.open;
  const deleteDatabase = factory.deleteDatabase.bind(factory);
  factory.deleteDatabase = ((name: string) => {
    const request = deleteDatabase(name);
    request.addEventListener('success', () => record({ op: 'drop', db: name }));
    return request;
  }) as typeof factory.deleteDatabase;

  const restore = async (): Promise<void> => {
    for (const [name, saved] of Object.entries(snapshot.dbs)) {
      const storeNames = Object.keys(saved.stores);
      await new Promise<void>((resolve) => {
        const request = open(name, Math.max(1, saved.version));
        request.onupgradeneeded = () => {
          for (const storeName of storeNames) if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
        };
        request.onerror = () => resolve();
        request.onsuccess = () => {
          const db = request.result;
          const present = storeNames.filter((storeName) => db.objectStoreNames.contains(storeName));
          if (present.length === 0) {
            db.close();
            resolve();
            return;
          }
          const transaction = db.transaction(present, 'readwrite');
          for (const storeName of present) {
            const objectStore = transaction.objectStore(storeName);
            for (const [key, value] of Object.entries(saved.stores[storeName] ?? {})) objectStore.put(decodeValue(value), key);
          }
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            resolve();
          };
        };
      });
    }
  };
  const ready = restore().finally(() => {
    restoring = false;
  });
  return { factory, ready, flush };
};

/**
 * VS Code saves its state before it reloads the window (Reload Window, a
 * folder switch) and reloads once its databases have it. Here they are memory,
 * and what a frame sends as it unloads never reaches the service: that save
 * waits for the service too. Returns the same save, for this frame's own reloads.
 */
export const saveThroughService = (storageService: StorageService, flush: () => Promise<void>): (() => Promise<void>) => {
  const save = storageService.flush.bind(storageService);
  storageService.flush = async (reason?: number) => {
    await save(reason);
    if (reason === SHUTDOWN) await flush();
  };
  // VS Code for the web saves every few seconds only while its document has focus, as its state changes only then.
  // In OpenChamber the focus is often outside the frame (the chat, the header, another frame) while its state changes
  // (a webview's, the editors the header opens), and a frame that unloads can't save: it saves either way.
  if (typeof storageService.shouldFlushWhenIdle === 'function') storageService.shouldFlushWhenIdle = () => !storageService.hasPendingUpdate;
  return () => storageService.flush(SHUTDOWN);
};

export { IDBKeyRange };
