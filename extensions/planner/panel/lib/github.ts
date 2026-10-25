// Panel-side GitHub: issues and pull requests listed by the local service
// (through the gh CLI), planned as tasks, kept current while the panel is open.
import type { EventBody } from '../../src/domain/events.ts';
import { linkedGitHubIds, planGitHubSync, taskForGitHub, taskFromGitHub, type GitHubItem } from '../../src/domain/github.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import type { Placement } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';

export type GitHubListKind = 'assigned' | 'review' | 'mine';

export interface GitHubStatus {
  available: boolean;
  login: string | null;
  message: string | null;
}

export interface GitHubView {
  status: GitHubStatus | null;
  kind: GitHubListKind;
  items: GitHubItem[];
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 5 * 60_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GitHubStore {
  private view: GitHubView = { status: null, kind: 'assigned', items: [], loading: false, error: null };
  private readonly listeners = new Set<() => void>();
  private started = false;

  constructor(private readonly client: PlannerClient, private readonly surface: string) {}

  getView = (): GitHubView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started || this.surface === 'status' || this.surface === 'background') return;
    this.started = true;
    await this.checkStatus();
    setInterval(() => {
      if (this.view.status?.available && !document.hidden) void this.refresh();
    }, REFRESH_MS);
  }

  async checkStatus(): Promise<void> {
    try {
      const status = await this.client.call<GitHubStatus>('GET', '/github/status');
      this.set({ status });
      if (status.available) await this.refresh();
    } catch (error) {
      this.set({ status: { available: false, login: null, message: messageOf(error) } });
    }
  }

  setKind(kind: GitHubListKind): void {
    this.set({ kind, items: [] });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view.status?.available) return;
    this.set({ loading: true, error: null });
    try {
      const [list, linked] = await Promise.all([
        this.client.call<{ items: GitHubItem[] }>('GET', `/github/list?kind=${this.view.kind}`),
        this.client.call<{ items: GitHubItem[] }>('POST', '/github/items', { ids: linkedGitHubIds(this.client.getView().state) }),
      ]);
      this.set({ items: list.items, loading: false });
      const bodies = planGitHubSync(this.client.getView().state, new Map(linked.items.map((item) => [item.id, item])));
      if (bodies.length) await this.client.dispatch(bodies, { origin: 'github' });
    } catch (error) {
      this.set({ loading: false, error: messageOf(error) });
    }
  }

  /** Commands that plan `item` at `placement`: move its open task there, or create one. */
  importCommands(item: GitHubItem, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    const at = position ?? edgePosition(state, placement, 'bottom');
    const existing = taskForGitHub(state, item);
    if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
    const id = newId();
    return { bodies: [{ type: 'task.created', task: taskFromGitHub(item, id, placement, at) }], taskId: id };
  }

  plan(item: GitHubItem, placement: Placement, position?: number): Promise<void> {
    return this.client.dispatch(this.importCommands(item, placement, position).bodies, { undo: `Planned ${item.key}` });
  }

  private set(patch: Partial<GitHubView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}
