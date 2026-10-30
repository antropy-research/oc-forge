// Panel-side GitHub: issues and pull requests listed by the local service
// (through the gh CLI), a page at a time with Load more (and words to narrow
// the list), planned as tasks, kept current while the panel is open; an issue
// or a pull request found by its URL, pasted into a new task as in Sunsama.
import type { EventBody } from '../../src/domain/events.ts';
import { linkedGitHubIds, planGitHubSync, taskForGitHub, taskFromGitHub, type GitHubItem, githubStatus } from '../../src/domain/github.ts';
import { planSubtaskSourceSync, subtaskSourceIds } from '../../src/domain/merge.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import type { Placement } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';

export type GitHubListKind = 'assigned' | 'review' | 'mine';

export interface GitHubStatus {
  available: boolean;
  login: string | null;
  message: string | null;
  /** gh is not installed, or not signed in. */
  reason?: 'missing' | 'signed-out' | null;
  /** The container OpenChamber runs in, where gh signs in; null on a plain machine. */
  container?: string | null;
}

export interface GitHubView {
  status: GitHubStatus | null;
  kind: GitHubListKind;
  items: GitHubItem[];
  loading: boolean;
  error: string | null;
  /** How many match in all, as GitHub counts them. */
  total: number;
  /** The next page's cursor (Load more); null when every match is shown. */
  next: string | null;
  /** Words narrowing the list, in GitHub's search syntax (text, repo:owner/name, label:…). */
  text: string;
  loadingMore: boolean;
  /** The repositories the viewer contributes to, most recently pushed first (null until read). */
  repos: string[] | null;
}

/** One page of a list, as the service reads it. */
interface GitHubPage {
  items: GitHubItem[];
  total: number;
  next: string | null;
}

/** Linked items read back in one request: GitHub's batch. */
const LINKED_BATCH = 100;

/** Items of later pages after the ones shown, each once (an item updated meanwhile can move between pages). */
const appendItems = (shown: readonly GitHubItem[], more: readonly GitHubItem[]): GitHubItem[] => {
  const seen = new Set(shown.map((item) => item.id));
  return [...shown, ...more.filter((item) => !seen.has(item.id))];
};

const REFRESH_MS = 5 * 60_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GitHubStore {
  private view: GitHubView = { status: null, kind: 'assigned', items: [], loading: false, error: null, total: 0, next: null, text: '', loadingMore: false, repos: null };
  /** The list being read: a newer kind or search makes an older answer moot. */
  private seq = 0;
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
    this.set({ kind, items: [], total: 0, next: null });
    void this.refresh();
  }

  /** Words narrowing the list (GitHub's search syntax); the list is read again from its first page. */
  /** The repositories to offer, read once (Sunsama surfaces the ones the viewer most recently contributed to). */
  async loadRepos(): Promise<void> {
    if (this.view.repos) return;
    try {
      const { repos } = await this.client.call<{ repos: string[] }>('GET', '/github/repos');
      this.set({ repos });
    } catch {
      this.set({ repos: [] });
    }
  }

  setText(text: string): void {
    if (text === this.view.text) return;
    this.set({ text, items: [], total: 0, next: null });
    void this.refresh();
  }

  private page(after: string | null): Promise<GitHubPage> {
    const query = new URLSearchParams({ kind: this.view.kind, ...(this.view.text.trim() ? { q: this.view.text.trim() } : {}), ...(after ? { after } : {}) });
    return this.client.call<GitHubPage>('GET', `/github/list?${query}`);
  }

  /**
   * Read the list again: as many pages as were shown (what Load more reached stays shown), the rest still a Load more
   * away; and the linked items' state.
   */
  async refresh(): Promise<void> {
    if (!this.view.status?.available) return;
    const seq = ++this.seq;
    const shown = this.view.items.length;
    this.set({ loading: true, error: null });
    try {
      const [list] = await Promise.all([
        (async () => {
          let page = await this.page(null);
          let items = page.items;
          while (page.next && items.length < shown && seq === this.seq) {
            page = await this.page(page.next);
            items = appendItems(items, page.items);
          }
          return { items, total: page.total, next: page.next };
        })(),
        this.syncLinked(),
      ]);
      if (seq !== this.seq) return;
      this.set({ items: list.items, total: Math.max(list.total, list.items.length), next: list.next, loading: false });
    } catch (error) {
      if (seq !== this.seq) return;
      const message = messageOf(error);
      this.set({ loading: false, error: message });
      // Signed out since the last check: say how to sign in instead of an error over an empty list.
      if (/not signed in|not installed/.test(message)) void this.checkStatus();
    }
  }

  /** The next page, after the ones shown. */
  async loadMore(): Promise<void> {
    const after = this.view.next;
    if (!after || this.view.loadingMore || this.view.loading) return;
    const seq = this.seq;
    this.set({ loadingMore: true, error: null });
    try {
      const page = await this.page(after);
      if (seq !== this.seq) return;
      const items = appendItems(this.view.items, page.items);
      this.set({ items, total: Math.max(page.total, items.length), next: page.next, loadingMore: false });
    } catch (error) {
      if (seq === this.seq) this.set({ loadingMore: false, error: messageOf(error) });
    }
  }

  /** Linked tasks' items as GitHub has them now, all of them, a batch a request. */
  private async syncLinked(): Promise<void> {
    // Linked tasks' items, and items merged into tasks (they stay synced, as in Sunsama).
    const state = this.client.getView().state;
    const ids = [...new Set([...linkedGitHubIds(state), ...subtaskSourceIds(state, 'github')])];
    const found = new Map<string, GitHubItem>();
    for (let index = 0; index < ids.length; index += LINKED_BATCH) {
      const answer = await this.client.call<{ items: GitHubItem[] }>('POST', '/github/items', { ids: ids.slice(index, index + LINKED_BATCH) });
      for (const item of answer.items) found.set(item.id, item);
    }
    const latest = this.client.getView().state;
    const merged = new Map([...found].map(([id, item]) => [id, { title: item.title, status: githubStatus(item), closed: item.state !== 'OPEN' }]));
    const bodies = [...planGitHubSync(latest, found), ...planSubtaskSourceSync(latest, 'github', merged)];
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'github' });
  }

  /** An issue or a pull request by its URL, as GitHub has it now; null when GitHub has none there (or this gh can't see it). */
  async resolve(url: string): Promise<GitHubItem | null> {
    try {
      return (await this.client.call<{ item: GitHubItem }>('POST', '/github/resolve', { url })).item ?? null;
    } catch (error) {
      if (/was not found on GitHub/.test(messageOf(error))) return null;
      throw error;
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
