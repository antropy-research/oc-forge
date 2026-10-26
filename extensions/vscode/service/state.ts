// The embedded workbench's storage (VS Code keeps settings, keybindings, open
// editors and layout in IndexedDB), kept here because an opaque-origin frame
// has no IndexedDB of its own: the frame runs an in-memory IndexedDB and sends
// every change to the service, which keeps one file per VS Code Server.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

/** The largest snapshot handed back in one answer (the host's answers stop at 8 MB). */
const LOAD_MAX = 7_000_000;
const NAME = /^[\w.:@ -]{1,200}$/;

const isValue = (value: unknown): value is StoredValue => {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const record = value as Record<string, unknown>;
  return (keys[0] === 's' && typeof record.s === 'string') || (keys[0] === 'b' && typeof record.b === 'string') || keys[0] === 'j';
};

/** Ops as the frame sends them; anything malformed is dropped. */
export const readOps = (raw: unknown): StateOp[] => {
  if (!Array.isArray(raw)) return [];
  const ops: StateOp[] = [];
  for (const item of raw.slice(0, 2000)) {
    const op = item as Record<string, unknown>;
    if (typeof op?.db !== 'string' || !NAME.test(op.db)) continue;
    if (op.op === 'db' && typeof op.version === 'number' && Array.isArray(op.stores) && op.stores.every((s) => typeof s === 'string' && NAME.test(s))) {
      ops.push({ op: 'db', db: op.db, version: op.version, stores: op.stores as string[] });
    } else if (op.op === 'drop') {
      ops.push({ op: 'drop', db: op.db });
    } else if (typeof op.store === 'string' && NAME.test(op.store)) {
      if (op.op === 'clear') ops.push({ op: 'clear', db: op.db, store: op.store });
      else if (typeof op.key === 'string' && op.key.length <= 2000) {
        if (op.op === 'delete') ops.push({ op: 'delete', db: op.db, store: op.store, key: op.key });
        else if (op.op === 'put' && isValue(op.value)) {
          const part = op.part as { id?: unknown; index?: unknown; count?: unknown } | undefined;
          const validPart = part && typeof part.id === 'string' && Number.isInteger(part.index) && Number.isInteger(part.count) && (part.count as number) > 0 && (part.count as number) <= 1000;
          ops.push({ op: 'put', db: op.db, store: op.store, key: op.key, value: op.value, ...(validPart ? { part: { id: part.id as string, index: part.index as number, count: part.count as number } } : {}) });
        }
      }
    }
  }
  return ops;
};

export type Parts = Map<string, { pieces: string[]; seen: boolean[] }>;

export const applyOps = (snapshot: StateSnapshot, ops: StateOp[], parts: Parts): void => {
  for (const op of ops) {
    if (op.op === 'drop') {
      delete snapshot.dbs[op.db];
      continue;
    }
    if (op.op === 'db') {
      const db = (snapshot.dbs[op.db] ??= { version: op.version, stores: {} });
      db.version = op.version;
      for (const store of op.stores) db.stores[store] ??= {};
      continue;
    }
    const db = (snapshot.dbs[op.db] ??= { version: 1, stores: {} });
    const store = (db.stores[op.store] ??= {});
    if (op.op === 'clear') {
      db.stores[op.store] = {};
    } else if (op.op === 'delete') {
      delete store[op.key];
    } else if (!op.part) {
      store[op.key] = op.value;
    } else {
      // A long value comes in parts; it lands once every part is here.
      const entry = parts.get(op.part.id) ?? { pieces: Array.from({ length: op.part.count }, () => ''), seen: Array.from({ length: op.part.count }, () => false) };
      if (op.part.index >= 0 && op.part.index < entry.pieces.length) {
        entry.pieces[op.part.index] = 's' in op.value ? op.value.s : 'b' in op.value ? op.value.b : '';
        entry.seen[op.part.index] = true;
      }
      parts.set(op.part.id, entry);
      if (entry.seen.every(Boolean)) {
        const joined = entry.pieces.join('');
        store[op.key] = 's' in op.value ? { s: joined } : { b: joined };
        parts.delete(op.part.id);
      }
    }
  }
};

export class WorkbenchState {
  private readonly snapshots = new Map<string, StateSnapshot>();
  private readonly parts: Parts = new Map();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dir: string, private readonly log: (message: string) => void) {}

  static keyOf(serverUrl: string, folder: string | null): string {
    // One store per VS Code Server: VS Code itself separates workspaces inside it.
    void folder;
    return createHash('sha256').update(serverUrl).digest('hex').slice(0, 32);
  }

  private file(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private async get(key: string): Promise<StateSnapshot> {
    const cached = this.snapshots.get(key);
    if (cached) return cached;
    let snapshot: StateSnapshot = { format: 1, dbs: {} };
    try {
      const parsed = JSON.parse(await readFile(this.file(key), 'utf8')) as StateSnapshot;
      if (parsed?.format === 1 && typeof parsed.dbs === 'object') snapshot = parsed;
    } catch {
      // None yet.
    }
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  async load(key: string): Promise<StateSnapshot> {
    const snapshot = await this.get(key);
    const text = JSON.stringify(snapshot);
    if (text.length <= LOAD_MAX) return snapshot;
    // Too big to hand back in one answer: the state databases (layout, open editors) go first, settings stay.
    this.log(`workbench state ${key} is ${text.length} bytes; loading the user data only`);
    const trimmed: StateSnapshot = { format: 1, dbs: {} };
    for (const [name, db] of Object.entries(snapshot.dbs)) if (!name.startsWith('vscode-web-state-db')) trimmed.dbs[name] = db;
    return trimmed;
  }

  async apply(key: string, ops: StateOp[]): Promise<void> {
    applyOps(await this.get(key), ops, this.parts);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.write(key), 400));
  }

  private async write(key: string): Promise<void> {
    this.timers.delete(key);
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(key)}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(tmp, this.file(key));
    } catch (error) {
      this.log(`could not save the workbench state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.timers.keys()].map((key) => this.write(key)));
  }
}
