// The Linear page around its list, a layer of the Linear store (store.ts) on its lists (lists.ts): what a list shows,
// the page's sections (issue lists, all projects, the issues already planned) and the workspace it shows; its
// sidebar's saved views and favorites; projects, and the one open; the order J and K move through in the issue view;
// and where the page was, kept on this device so it opens there again.
import type { HostClient } from '@openchamber/sdk';
import {
  FAVORITE_VIEWS_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  VIEWS_QUERY,
  favoriteOrder,
  favoritesOf,
  inWorkspace,
  type LinearFavorite,
  type LinearFavoriteNode,
  type LinearProject,
  type LinearProjectDetail,
  type LinearSavedView,
} from '../../../src/domain/linear/linear.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { isFullSurface } from '../core/ui.ts';
import { emptyList, isMine, type IssueList, type IssueRef, type LinearMode, type LinearSource, type ListId, type OpenProject } from './types.ts';
import { LinearLists } from './lists.ts';

// Bounds of one read; where Linear has more, the rest is a Load more away.
const MAX_PROJECT_PAGES = 10;
const MAX_VIEW_PAGES = 10;
/** Pages of 250 favorites; past them, the sidebar says Linear has more. */
const MAX_FAVORITE_PAGES = 10;
const LOCATION_KEY = 'linear.location';

/** Where the Linear page was, kept on this device so it opens there again. */
interface LinearLocation {
  mode: LinearMode;
  source: LinearSource;
  scope: string;
  project?: { id: string; workspaceId: string } | null;
}

const isSource = (value: unknown): value is LinearSource => {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return false;
  if (isMine(item)) return true;
  if (item.kind === 'view' || item.kind === 'project') return typeof item.id === 'string' && typeof item.workspaceId === 'string';
  return item.kind === 'search' && typeof item.term === 'string';
};

export class LinearPage extends LinearLists {
  private projectSeq = 0;
  /** The saved views being read: an older read's answer (`loadViews`) is dropped. */
  private viewsSeq = 0;
  private loadingViews = false;
  /** Where the favorites put each view, by workspace (a view read by Load more views takes its place too). */
  private readonly viewOrders = new Map<string, Map<string, number>>();
  /** The issues the Linear page shows, in order, for moving through them in the issue view. */
  private order: IssueRef[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A project to reopen once its workspace is connected. */
  private pendingProject: { id: string; workspaceId: string } | null = null;

  /** Show another list; like opening another view in Linear, it starts without temporary filters. */
  setSource(source: LinearSource, id: ListId = 'page'): void {
    this.used.add(id);
    this.patchList(id, { ...emptyList(source), loading: true });
    if (id === 'page') this.set({ mode: 'issues', project: null });
    void this.loadList(id);
    if (id === 'page') this.saveLocation();
  }

  setMode(mode: LinearMode): void {
    this.set({ mode, ...(mode !== 'projects' ? { project: null } : {}) });
    if (mode === 'projects' && !this.view.projectsLoaded && !this.view.projectsLoading) void this.loadProjects();
    this.saveLocation();
  }

  /** Show one workspace, or all of them merged. */
  setScope(scope: string): void {
    const fix = (list: IssueList): LinearSource =>
      (list.source.kind === 'view' || list.source.kind === 'project') && scope !== 'all' && list.source.workspaceId !== scope ? { kind: 'assigned' } : list.source;
    this.set({
      scope,
      lists: { page: { ...emptyList(fix(this.view.lists.page)), loading: true }, side: { ...emptyList(fix(this.view.lists.side)), loading: true } },
      projects: [],
      projectsLoaded: false,
      projectsMore: {},
      project: null,
    });
    for (const id of this.used) void this.loadList(id);
    if (this.view.mode === 'projects') void this.loadProjects();
    this.saveLocation();
  }

  /** Projects of the shown workspaces that are not completed or canceled. */
  async loadProjects(): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    const seq = ++this.projectSeq;
    const targets = this.scoped();
    this.set({ projectsLoading: true });
    const settled = await Promise.allSettled(targets.map((workspace) => this.pagesIn<LinearProject>(workspace.id, PROJECTS_QUERY, 'projects', { maxPages: MAX_PROJECT_PAGES })));
    if (seq !== this.projectSeq) return;
    const errors = new Map<string, string>();
    const projects: LinearProject[] = [];
    const more: Record<string, string> = {};
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'fulfilled') {
        projects.push(...result.value.nodes.map((project) => inWorkspace(project, workspaceId)));
        // More than a read takes: the rest a Load more away, never left out silently.
        if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
      } else errors.set(workspaceId, messageOf(result.reason));
    });
    this.noteErrors(errors, targets.map((workspace) => workspace.id));
    const allFailed = targets.length > 0 && errors.size === targets.length;
    this.set({ projects, projectsLoaded: true, projectsLoading: false, projectsMore: more, error: allFailed ? errors.get(targets[0]!.id) ?? null : this.view.error });
  }

  /** The next open projects of the workspaces that have more, after the ones shown. */
  async loadMoreProjects(): Promise<void> {
    const pending = Object.entries(this.view.projectsMore);
    if (!pending.length || this.view.projectsLoading) return;
    const seq = this.projectSeq;
    this.set({ projectsLoading: true });
    const settled = await Promise.allSettled(pending.map(([workspaceId, after]) => this.pagesIn<LinearProject>(workspaceId, PROJECTS_QUERY, 'projects', { after, maxPages: MAX_PROJECT_PAGES })));
    if (seq !== this.projectSeq) return;
    const known = new Set(this.view.projects.map((project) => project.id));
    const projects = [...this.view.projects];
    const more: Record<string, string> = {};
    settled.forEach((result, index) => {
      const [workspaceId, after] = pending[index]!;
      if (!this.workspace(workspaceId)) return;
      if (result.status === 'rejected') {
        more[workspaceId] = after;
        this.set({ error: messageOf(result.reason) });
        return;
      }
      for (const project of result.value.nodes) if (!known.has(project.id)) projects.push(inWorkspace(project, workspaceId));
      if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
    });
    this.set({ projects, projectsMore: more, projectsLoading: false });
  }

  /** Open a project: its overview, and its issues as the page's list. */
  async openProject(project: LinearProject, from: OpenProject['from'] = null): Promise<void> {
    const workspaceId = project.workspaceId ?? '';
    this.set({ mode: 'projects', project: { project, detail: null, loading: true, error: null, from } });
    this.used.add('page');
    this.patchList('page', { ...emptyList({ kind: 'project', id: project.id, workspaceId }), loading: true });
    void this.loadList('page');
    this.saveLocation();
    try {
      const data = await this.graphqlIn<{ project: LinearProjectDetail | null }>(workspaceId, PROJECT_QUERY, { id: project.id });
      if (this.view.project?.project.id !== project.id) return;
      if (!data.project) throw new Error('Linear no longer has this project');
      this.set({ project: { project, detail: inWorkspace(data.project, workspaceId), loading: false, error: null, from } });
    } catch (error) {
      if (this.view.project?.project.id !== project.id) return;
      this.set({ project: { project, detail: null, loading: false, error: messageOf(error), from } });
    }
  }

  /** Back from a project: to the view of projects it came from, or to all projects. */
  closeProject(): void {
    const from = this.view.project?.from;
    this.set({ project: null });
    if (from) this.setSource({ kind: 'view', id: from.id, workspaceId: from.workspaceId });
    else this.setMode('projects');
  }

  /** The next saved views of the workspaces that have more, after the ones read (the sidebar's Load more views). */
  async loadMoreViews(): Promise<void> {
    const pending = Object.entries(this.view.viewsMore);
    if (!pending.length || this.loadingViews) return;
    this.loadingViews = true;
    const shown = this.view.views;
    try {
      const settled = await Promise.allSettled(pending.map(([workspaceId, after]) => this.pagesIn<LinearSavedView>(workspaceId, VIEWS_QUERY, 'customViews', { after, maxPages: MAX_VIEW_PAGES })));
      // The views read again meanwhile, or a workspace's taken off: these pages follow a list no longer shown.
      if (this.view.views !== shown) return;
      const known = new Set(this.view.views.map((view) => `${view.workspaceId}:${view.id}`));
      const views = [...this.view.views];
      const more: Record<string, string> = {};
      settled.forEach((result, index) => {
        const [workspaceId, after] = pending[index]!;
        if (result.status === 'rejected') {
          more[workspaceId] = after;
          this.set({ error: messageOf(result.reason) });
          return;
        }
        const order = this.viewOrders.get(workspaceId);
        for (const view of result.value.nodes) {
          if (known.has(`${workspaceId}:${view.id}`)) continue;
          views.push(inWorkspace(order?.has(view.id) ? { ...view, favoriteOrder: order.get(view.id)! } : view, workspaceId));
        }
        if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
      });
      this.set({ views, viewsMore: more });
    } finally {
      this.loadingViews = false;
    }
  }

  /** The issues the Linear page shows, in order, so J and K move through them in the issue view. */
  setOrder(refs: IssueRef[]): void {
    this.order = refs;
  }

  /** The issue `delta` places from `ref` in the page's order, if there is one. */
  neighbor(ref: IssueRef, delta: number): IssueRef | null {
    const index = this.order.findIndex((item) => item.id === ref.id);
    if (index < 0) return null;
    return this.order[index + delta] ?? null;
  }

  position(ref: IssueRef): { index: number; total: number } | null {
    const index = this.order.findIndex((item) => item.id === ref.id);
    return index < 0 ? null : { index, total: this.order.length };
  }

  /** Saved views and favorites of every workspace; optional, My issues works without. */
  protected async loadViews(): Promise<void> {
    const seq = ++this.viewsSeq;
    const workspaces = this.view.workspaces;
    const settled = await Promise.allSettled(workspaces.map((workspace) => this.viewsIn(workspace.id)));
    // A newer read of them since: its answer stands.
    if (seq !== this.viewsSeq) return;
    const views: LinearSavedView[] = [];
    const favorites: LinearFavorite[] = [];
    const more: Record<string, string> = {};
    let favoritesCut = false;
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      views.push(...result.value.views.map((item) => inWorkspace(item, workspaces[index]!.id)));
      favorites.push(...result.value.favorites);
      if (result.value.more) more[workspaces[index]!.id] = result.value.more;
      favoritesCut ||= result.value.favoritesCut;
    });
    this.set({ views, favorites, viewsLoaded: true, viewsMore: more, favoritesCut });
  }

  /** Open where the page was last time, on this device. */
  protected async restoreLocation(): Promise<void> {
    try {
      const saved = (await this.host.storage.get(LOCATION_KEY, { scope: 'device' })) as Partial<LinearLocation> | undefined;
      if (!saved || !isSource(saved.source)) return;
      const mode: LinearMode = saved.mode === 'projects' || saved.mode === 'planned' ? saved.mode : 'issues';
      const scope = typeof saved.scope === 'string' ? saved.scope : 'all';
      const page = saved.source.kind === 'project' ? emptyList() : emptyList(saved.source);
      this.set({ mode, scope, lists: { ...this.view.lists, page } });
      const project = saved.project;
      if (mode === 'projects' && project && typeof project.id === 'string' && typeof project.workspaceId === 'string') this.pendingProject = project;
    } catch {
      // Device storage is optional (older hosts): the page opens on My issues.
    }
  }

  /** Reopen the project the page showed last time, once its workspace is connected. */
  protected reopenProject(): void {
    const pending = this.pendingProject;
    if (!pending || !this.workspace(pending.workspaceId)) return;
    this.pendingProject = null;
    const known = this.view.projects.find((project) => project.id === pending.id && project.workspaceId === pending.workspaceId);
    if (known) void this.openProject(known);
    else {
      void this.graphqlIn<{ project: LinearProjectDetail | null }>(pending.workspaceId, PROJECT_QUERY, { id: pending.id })
        .then((data) => data.project && this.openProject(inWorkspace(data.project, pending.workspaceId)))
        .catch(() => {});
    }
  }

  /** One workspace's saved views, and my favorites there, in the order the favorites put them. */
  private async viewsIn(workspaceId: string): Promise<{ views: LinearSavedView[]; favorites: LinearFavorite[]; more: string | null; favoritesCut: boolean }> {
    let favoritesCut = false;
    const favoriteNodes = this.pagesIn<LinearFavoriteNode>(workspaceId, FAVORITE_VIEWS_QUERY, 'favorites', { maxPages: MAX_FAVORITE_PAGES })
      .then((read) => {
        favoritesCut = read.hasMore;
        return read.nodes;
      })
      .catch(() => [] as LinearFavoriteNode[]);
    const read = await this.pagesIn<LinearSavedView>(workspaceId, VIEWS_QUERY, 'customViews', { maxPages: MAX_VIEW_PAGES });
    const nodes = await favoriteNodes;
    const order = favoriteOrder(nodes);
    this.viewOrders.set(workspaceId, order);
    const known = new Set(read.nodes.map((view) => view.id));
    return {
      views: read.nodes.map((view) => (order.has(view.id) ? { ...view, favoriteOrder: order.get(view.id)! } : view)),
      // A favorite view I can no longer see is left out (one past the views read so far may come with Load more views).
      favorites: favoritesOf(nodes, workspaceId).filter((favorite) => favorite.kind !== 'view' || known.has(favorite.id) || read.hasMore),
      more: read.endCursor,
      favoritesCut,
    };
  }

  private saveLocation(): void {
    if (!isFullSurface(this.surface)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const project = this.view.project?.project;
      const location: LinearLocation = {
        mode: this.view.mode,
        source: this.view.lists.page.source,
        scope: this.view.scope,
        project: project ? { id: project.id, workspaceId: project.workspaceId ?? '' } : null,
      };
      void this.host.storage.set(LOCATION_KEY, location as unknown as Parameters<HostClient['storage']['set']>[1], { scope: 'device' }).catch(() => {});
    }, 300);
  }
}
