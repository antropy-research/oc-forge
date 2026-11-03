// The folder's breakpoints, as data: one list per folder, kept in a file on the server that every window's parts
// share. A change goes into it as a change (put, remove), read and written under a lock, so a window that hasn't
// heard of another's change doesn't undo it when it writes its own. Windows don't follow each other's changes as they
// happen (VS Code's windows don't either); a part takes the file's list when it joins its window's bus.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withLock } from './lock.ts';

export interface BreakpointData {
  /** `src|<uri>|<line>|<character>` or `fn|<name>`. */
  key: string;
  kind: 'source' | 'function';
  uri?: string;
  /** Zero-based, as the `vscode` API's positions. */
  line?: number;
  character?: number;
  functionName?: string;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface Delta {
  put: BreakpointData[];
  remove: string[];
}

export const sourceKey = (uri: string, line: number, character: number): string => `src|${uri}|${line}|${character}`;
export const functionKey = (name: string): string => `fn|${name}`;

/** One breakpoint as JSON with its keys in a fixed order, to compare. */
const canonical = (data: BreakpointData): string => JSON.stringify({
  key: data.key,
  kind: data.kind,
  uri: data.uri,
  line: data.line,
  character: data.character,
  functionName: data.functionName,
  enabled: data.enabled,
  condition: data.condition || undefined,
  hitCondition: data.hitCondition || undefined,
  logMessage: data.logMessage || undefined,
});

export const sorted = (list: readonly BreakpointData[]): BreakpointData[] => [...list].sort((a, b) => a.key.localeCompare(b.key));

export const sameList = (a: readonly BreakpointData[], b: readonly BreakpointData[]): boolean =>
  a.length === b.length && sorted(a).every((item, index) => canonical(item) === canonical(sorted(b)[index]!));

export const isEmpty = (delta: Delta): boolean => delta.put.length === 0 && delta.remove.length === 0;

/** What turns `before` into `after`. */
export const diff = (before: readonly BreakpointData[], after: readonly BreakpointData[]): Delta => {
  const old = new Map(before.map((item) => [item.key, canonical(item)]));
  const now = new Set(after.map((item) => item.key));
  return {
    put: after.filter((item) => old.get(item.key) !== canonical(item)),
    remove: [...old.keys()].filter((key) => !now.has(key)),
  };
};

export const applyDelta = (list: readonly BreakpointData[], delta: Delta): BreakpointData[] => {
  const byKey = new Map(list.map((item) => [item.key, item]));
  for (const key of delta.remove) byKey.delete(key);
  for (const item of delta.put) byKey.set(item.key, item);
  return sorted([...byKey.values()]);
};

/** Every list's breakpoints; for one key in several, the last list's. */
export const union = (...lists: readonly (readonly BreakpointData[])[]): BreakpointData[] => {
  const byKey = new Map<string, BreakpointData>();
  for (const list of lists) for (const item of list) byKey.set(item.key, item);
  return sorted([...byKey.values()]);
};

interface StoreFile {
  version: 1;
  at: number;
  list: BreakpointData[];
}

export class BreakpointStore {
  constructor(private readonly file: string) {}

  private get lock(): string {
    return `${this.file}.lock`;
  }

  read(): BreakpointData[] | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
      return Array.isArray(data.list) ? sorted(data.list) : null;
    } catch {
      return null;
    }
  }

  private write(list: readonly BreakpointData[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, at: Date.now(), list: sorted(list) } satisfies StoreFile));
    fs.renameSync(temporary, this.file);
  }

  /** Applies a change to the file's list: the list after it. */
  update(delta: Delta): Promise<BreakpointData[]> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.lock, () => {
      const next = applyDelta(this.read() ?? [], delta);
      this.write(next);
      return next;
    });
  }

  /** The file's list; the first time, `first` (written). */
  init(first: () => Promise<BreakpointData[]> | BreakpointData[]): Promise<{ list: BreakpointData[]; created: boolean }> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    return withLock(this.lock, async () => {
      const existing = this.read();
      if (existing) return { list: existing, created: false };
      const list = sorted(await first());
      this.write(list);
      return { list, created: true };
    }, 6_000);
  }
}
