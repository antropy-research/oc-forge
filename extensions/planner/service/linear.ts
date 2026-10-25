// Linear workspaces added with a personal API key. OpenChamber's own Linear
// connection reaches one workspace; each further one is a key the user pastes.
// Keys stay on this machine, outside the synced data repository, in a file only
// the user can read; the panel never gets them back. A key runs the Planner's
// own GraphQL documents and nothing else.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ALL_DOCUMENTS, WHOAMI_QUERY, readGraphql } from '../src/domain/linear.ts';

export const LINEAR_API = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 20_000;
const MAX_WORKSPACES = 20;
const ALLOWED = new Set(ALL_DOCUMENTS);

interface StoredWorkspace {
  id: string;
  name: string;
  urlKey: string;
  account: string;
  key: string;
  addedAt: string;
}

/** What the panel may see of a workspace: everything but the key. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  urlKey: string;
  account: string;
  addedAt: string;
}

export type Fetcher = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** A refusal with the HTTP status the service answers it with. */
export class WorkspaceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isStored = (value: unknown): value is StoredWorkspace => {
  const item = value as Record<string, unknown> | null;
  return Boolean(item) && ['id', 'name', 'urlKey', 'account', 'key', 'addedAt'].every((field) => typeof item![field] === 'string');
};

const publicInfo = ({ key: _key, ...info }: StoredWorkspace): WorkspaceInfo => info;

/** Linear takes a personal API key as is and an OAuth token as a bearer token. */
const authorization = (key: string): string => (key.startsWith('lin_oauth_') ? `Bearer ${key}` : key);

export class LinearWorkspaces {
  private items: StoredWorkspace[] = [];
  private loaded: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string, private readonly fetcher: Fetcher = fetch as unknown as Fetcher, private readonly log: (message: string) => void = () => {}) {}

  async list(): Promise<WorkspaceInfo[]> {
    await this.load();
    return this.items.map(publicInfo);
  }

  /** Check the key with Linear and keep it; a key for a workspace already here replaces the old one. */
  add(rawKey: string): Promise<WorkspaceInfo> {
    return this.serial(async () => {
      const key = rawKey.trim();
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw new WorkspaceError(400, 'That does not look like a Linear API key (Linear → Settings → Security & access → Personal API keys)');
      await this.load();
      const answer = await this.send(key, WHOAMI_QUERY, {});
      if (answer.status === 401 || answer.status === 403) throw new WorkspaceError(400, 'Linear rejected the key');
      let data: { viewer: { id: string; name: string }; organization: { id: string; name: string; urlKey: string } };
      try {
        data = readGraphql(answer.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkspaceError(400, /authenticat/i.test(message) ? 'Linear rejected the key' : `Linear answered: ${message}`);
      }
      const entry: StoredWorkspace = { id: data.organization.id, name: data.organization.name, urlKey: data.organization.urlKey, account: data.viewer.name, key, addedAt: new Date().toISOString() };
      const index = this.items.findIndex((item) => item.id === entry.id);
      if (index < 0 && this.items.length >= MAX_WORKSPACES) throw new WorkspaceError(400, `At most ${MAX_WORKSPACES} workspaces`);
      this.items = index < 0 ? [...this.items, entry] : this.items.map((item, at) => (at === index ? entry : item));
      await this.save();
      return publicInfo(entry);
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      await this.load();
      const before = this.items.length;
      this.items = this.items.filter((item) => item.id !== id);
      if (this.items.length === before) return false;
      await this.save();
      return true;
    });
  }

  /** Run one of the Planner's documents in a workspace; Linear's answer comes back as it is. */
  async graphql(id: string, query: string, variables: unknown): Promise<{ status: number; body: string }> {
    if (!ALLOWED.has(query)) throw new WorkspaceError(400, "only the Planner's own Linear queries can run");
    await this.load();
    const entry = this.items.find((item) => item.id === id);
    if (!entry) throw new WorkspaceError(404, 'that Linear workspace is not connected');
    return this.send(entry.key, query, variables);
  }

  private async send(key: string, query: string, variables: unknown): Promise<{ status: number; body: string }> {
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await this.fetcher(LINEAR_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization(key) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new WorkspaceError(502, `Could not reach Linear: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: response.status, body: await response.text() };
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string;
      try {
        text = await readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      try {
        const parsed = JSON.parse(text) as { workspaces?: unknown };
        this.items = Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isStored) : [];
      } catch {
        this.log(`${this.file} is not readable JSON; Linear workspaces need to be added again`);
      }
    })();
    return this.loaded;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, workspaces: this.items }, null, 2)}\n`, { mode: 0o600 });
    // The mode above applies only when the file is new.
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }
}
