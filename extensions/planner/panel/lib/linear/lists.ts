// The issue lists of the Linear store (store.ts), a layer on its workspaces (workspaces.ts): the Linear page's list,
// and the one the side panels share. Lists are Linear's: a saved view lists exactly the issues Linear lists for it (its
// own filter, plus what its display hides), page after page until Linear has no more; temporary filters go to Linear
// as an IssueFilter, so the answer is complete. An issue changed here shows in each list it still belongs in.
import {
  ASSIGNED_QUERY,
  CREATED_QUERY,
  ISSUES_QUERY,
  SAVE_VIEW_FILTER_MUTATION,
  SEARCH_QUERY,
  VIEW_ISSUES_QUERY,
  VIEW_PROJECTS_QUERY,
  VIEW_QUERY,
  inWorkspace,
  isClosedType,
  isProjectView,
  type LinearIssue,
  type LinearProject,
  type LinearViewMeta,
} from '../../../src/domain/linear/linear.ts';
import {
  allOf,
  displayFilter,
  projectDisplayFilter,
  projectViewDisplay,
  readPages,
  viewDisplay,
  type GraphFilter,
  type IssueDisplay,
  type Page,
  type ProjectDisplay,
} from '../../../src/domain/linear/display.ts';
import { beyondSaved, compileFilter, matchesRules, pruneFilters, readFilter, workspacesFor, type FilterContext, type FilterJoin, type LinearFilterNode } from '../../../src/domain/linear/filter.ts';
import { DEFAULT_SETTINGS, type LinearDisplayPrefs, type Settings } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { displayOf, type IssueList, type ListId, type WorkspaceView } from './types.ts';
import { LinearWorkspaces } from './workspaces.ts';

/** Pages a list reads at once (100 issues each); further pages come on scroll or Load more. */
const FIRST_PAGES = 3;

/** One workspace's part of a list: issues, or a view of projects' projects, and where Linear's next page starts. */
interface ListPart {
  issues: LinearIssue[];
  projects: LinearProject[];
  endCursor: string | null;
}

/** Whether a changed issue still belongs in a list, judged as Linear would by its filter and display. */
const stillListed = (issue: LinearIssue, list: IssueList, display: IssueDisplay, context: FilterContext): boolean => {
  if (!matchesRules(issue, list.filters, context, list.match)) return false;
  if (isClosedType(issue.state.type) && display.showCompleted === 'none') return false;
  if (!display.showSubIssues && issue.parent) return false;
  if (!display.showTriage && issue.state.type === 'triage') return false;
  if (list.source.kind === 'project' && issue.project?.id !== list.source.id) return false;
  return true;
};

export class LinearLists extends LinearWorkspaces {
  /** Each list's reads, counted: the answer to a read a newer one has replaced is dropped. */
  private readonly listSeq: Record<ListId, number> = { page: 0, side: 0 };
  /** Lists something has shown; a refresh reads only those. */
  protected readonly used = new Set<ListId>();
  /** The page's last place on its way back (page.ts): lists are read once it is there. */
  protected restoring: Promise<void> | null = null;

  list(id: ListId): IssueList {
    return this.view.lists[id];
  }

  /** A list is on screen: read it if it has not been read yet. */
  use(id: ListId): void {
    if (this.used.has(id)) return;
    this.used.add(id);
    void this.loadList(id);
  }

  /**
   * The list's filters (rules and groups, all or any of them at the top), sent
   * to Linear with the list's own: the answer is every matching issue.
   */
  setFilters(filters: LinearFilterNode[], id: ListId = 'page', match: FilterJoin = this.list(id).match): void {
    const kept = pruneFilters(filters);
    const list = this.list(id);
    if (JSON.stringify(kept) === JSON.stringify(list.filters) && match === list.match) return;
    this.patchList(id, { filters: kept, match });
    void this.loadList(id);
  }

  /** An open view's filters back as saved. */
  resetFilters(id: ListId = 'page'): void {
    const saved = this.list(id).viewFilters;
    if (saved) this.setFilters(saved, id, 'and');
  }

  /**
   * Whether an open view's changed filters can be saved to it as they mean: not when they
   * depend on today's date here (a due date of "today" or "this week" compiles to dates, and
   * would stay those dates in Linear).
   */
  canSaveFilters(id: ListId = 'page'): boolean {
    const list = this.list(id);
    if (list.source.kind !== 'view') return false;
    const { state } = this.client.getView();
    const at = (today: string) => JSON.stringify(compileFilter(list.filters, { today, weekStartsOn: state.settings.weekStartsOn }, list.match));
    return at('2001-01-01') === at('2001-03-15');
  }

  /** An open view's filters, as changed here, saved to the view in Linear (Linear's "Save"); the view then reads as saved. */
  async saveFilters(id: ListId = 'page'): Promise<void> {
    const list = this.list(id);
    if (list.source.kind !== 'view' || !this.canSaveFilters(id)) return;
    const { state, today } = this.client.getView();
    const filterData = compileFilter(list.filters, { today, weekStartsOn: state.settings.weekStartsOn }, list.match) ?? {};
    const data = await this.graphqlIn<{ customViewUpdate: { success: boolean } | null }>(list.source.workspaceId, SAVE_VIEW_FILTER_MUTATION, { id: list.source.id, filterData });
    if (!data.customViewUpdate?.success) throw new Error('Linear did not save the view');
    // Read the view again: its saved filters are now these.
    this.patchList(id, { view: null });
    await this.loadList(id);
  }

  /**
   * Change the display. An open view's changes last while it is open, as in
   * Linear until one saves the view; otherwise they are the Planner's settings.
   * A change of what is listed (completed issues, sub-issues) reads the list again.
   */
  setDisplay(patch: Partial<IssueDisplay>, id: ListId = 'page'): Promise<void> {
    const list = this.list(id);
    const settings = this.client.getView().state.settings;
    const before = displayOf(list, settings, id);
    const after = { ...before, ...patch };
    const reread = JSON.stringify(displayFilter(before)) !== JSON.stringify(displayFilter(after));
    if (list.display) {
      this.patchList(id, { display: after });
      if (reread) void this.loadList(id);
      return Promise.resolve();
    }
    const settingsPatch: Partial<Settings> = {};
    if (patch.layout) settingsPatch.linearLayout = patch.layout;
    if (patch.groupBy) settingsPatch.linearGroupBy = patch.groupBy;
    if (patch.orderBy) settingsPatch.linearOrderBy = patch.orderBy;
    const rest: Partial<LinearDisplayPrefs> = {};
    for (const key of ['subGroupBy', 'orderReverse', 'showCompleted', 'showSubIssues', 'showEmptyGroups', 'showEmptyColumns', 'properties'] as const) {
      if (key in patch) (rest as Record<string, unknown>)[key] = patch[key];
    }
    if (Object.keys(rest).length) settingsPatch.linearDisplay = { ...DEFAULT_SETTINGS.linearDisplay, ...settings.linearDisplay, ...rest };
    return this.client.dispatch([{ type: 'settings.updated', patch: settingsPatch }]).then(() => {
      if (reread) void this.loadList(id);
    });
  }

  /** A view of projects: its grouping, ordering or completed projects, while it is open. */
  setProjectDisplay(patch: Partial<ProjectDisplay>, id: ListId = 'page'): void {
    const list = this.list(id);
    if (!list.projectDisplay) return;
    const next = { ...list.projectDisplay, ...patch };
    this.patchList(id, { projectDisplay: next });
    if (patch.showCompleted && patch.showCompleted !== list.projectDisplay.showCompleted) void this.loadList(id);
  }

  /** Read the next page of every workspace that has more. */
  async loadMore(id: ListId = 'page'): Promise<void> {
    const list = this.list(id);
    const cursors = Object.entries(list.more);
    if (list.loading || list.loadingMore || cursors.length === 0) return;
    const seq = this.listSeq[id];
    this.patchList(id, { loadingMore: true });
    const settled = await Promise.allSettled(cursors.map(([workspaceId, after]) => this.readList(workspaceId, list, id, { after, maxPages: 1 })));
    if (seq !== this.listSeq[id]) return;
    const current = this.list(id);
    const more: Record<string, string> = {};
    const issues = [...current.issues];
    const projects = current.projects ? [...current.projects] : null;
    const seen = new Set([...issues.map((issue) => `${issue.workspaceId}:${issue.id}`), ...(projects ?? []).map((project) => `${project.workspaceId}:${project.id}`)]);
    let error: string | null = null;
    settled.forEach((result, index) => {
      const [workspaceId, after] = cursors[index]!;
      // A workspace taken off meanwhile: its page is no longer the list's.
      if (!this.workspace(workspaceId)) return;
      if (result.status === 'rejected') {
        error = messageOf(result.reason);
        more[workspaceId] = after;
        return;
      }
      for (const issue of result.value.issues) if (!seen.has(`${workspaceId}:${issue.id}`)) issues.push(issue);
      for (const project of result.value.projects) if (!seen.has(`${workspaceId}:${project.id}`)) projects?.push(project);
      if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
    });
    this.patchList(id, { issues, projects, more, pages: current.pages + 1, loadingMore: false, error });
  }

  /** The teams a list is about: a team's view, or the teams of its issues. */
  teamsOf(list: IssueList): string[] {
    const fromView = list.view?.team?.id;
    const own = [...new Set(list.issues.map((issue) => issue.team.id))];
    return fromView ? [...new Set([fromView, ...own])] : own;
  }

  /** The workspaces a list reads. */
  workspacesOf(list: IssueList): string[] {
    return this.targets(list).map((workspace) => workspace.id);
  }

  protected patchList(id: ListId, patch: Partial<IssueList>): void {
    this.set({ lists: { ...this.view.lists, [id]: { ...this.view.lists[id], ...patch } } });
  }

  /**
   * Read a list from its first page: a saved view's display first (it decides
   * which completed issues Linear sends), then pages in every workspace it
   * covers. A refresh reads as many pages as were shown and keeps the display
   * changed meanwhile.
   */
  protected async loadList(id: ListId, refreshing = false): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    await this.restoring;
    const seq = ++this.listSeq[id];
    let list = this.list(id);
    // A Load more still on its way belongs to the read before this one: dropped when it answers, its flag here.
    this.patchList(id, { loading: true, loadingMore: false, error: null });
    try {
      if (list.source.kind === 'view' && (!list.view || list.view.id !== list.source.id || refreshing)) {
        const workspaceId = list.source.workspaceId;
        // The view's filter is shown by name: the workspace's states, people and labels, read meanwhile.
        const catalogs = this.loadCatalogs([workspaceId]);
        const meta = await this.viewMeta(workspaceId, list.source.id);
        await catalogs;
        if (seq !== this.listSeq[id]) return;
        const fallback = displayOf({ display: null, source: list.source }, this.client.getView().state.settings, id);
        const saved = viewDisplay(meta.viewPreferencesValues, fallback);
        const projects = isProjectView(meta) ? projectViewDisplay(meta.viewPreferencesValues) : null;
        const { state, today } = this.client.getView();
        const catalog = this.view.catalogs[workspaceId];
        const viewFilters = projects ? [] : readFilter(meta.filterData, catalog ? [catalog] : [], { today, weekStartsOn: state.settings.weekStartsOn });
        // A view opens as saved; a refresh keeps what was changed since.
        const keep = refreshing && list.view?.id === meta.id;
        this.patchList(id, {
          view: meta,
          display: keep && list.display ? list.display : saved.display,
          projectDisplay: projects ? (keep && list.projectDisplay ? list.projectDisplay : projects.display) : null,
          unsupported: projects ? projects.unsupported : saved.unsupported,
          viewFilters,
          ...(keep ? {} : { filters: viewFilters, match: 'and' as const }),
        });
        list = this.list(id);
      }
    } catch (error) {
      if (seq !== this.listSeq[id]) return;
      this.patchList(id, { loading: false, error: messageOf(error), issues: [], projects: null, more: {} });
      return;
    }
    const targets = this.targets(list);
    const maxPages = refreshing ? Math.max(FIRST_PAGES, list.pages) : FIRST_PAGES;
    const live = () => seq === this.listSeq[id];
    const settled = await Promise.allSettled(targets.map((workspace) => this.readList(workspace.id, list, id, { maxPages, live })));
    if (seq !== this.listSeq[id]) return;
    const issues: LinearIssue[] = [];
    const projects: LinearProject[] | null = list.projectDisplay ? [] : null;
    const more: Record<string, string> = {};
    const errors = new Map<string, string>();
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'rejected') {
        errors.set(workspaceId, messageOf(result.reason));
        return;
      }
      issues.push(...result.value.issues);
      projects?.push(...result.value.projects);
      if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
    });
    this.noteErrors(errors, targets.map((workspace) => workspace.id));
    // A request may have found OpenChamber's connection gone meanwhile; that shows as Connect, not an error.
    const present = targets.filter((workspace) => this.workspace(workspace.id));
    const allFailed = present.length > 0 && present.every((workspace) => errors.has(workspace.id));
    this.patchList(id, { issues, projects, more, pages: maxPages, loading: false, loadingMore: false, error: allFailed ? errors.get(present[0]!.id) ?? null : null });
  }

  /** Put a changed issue everywhere it shows; a list it no longer belongs in (its filters, its display) lets it go. */
  protected replaceIssue(issue: LinearIssue): void {
    const { state, today } = this.client.getView();
    const context: FilterContext = { today, weekStartsOn: state.settings.weekStartsOn, viewerIds: this.viewerIds };
    const lists = { ...this.view.lists };
    for (const id of ['page', 'side'] as const) {
      const list = lists[id];
      if (!list.issues.some((item) => item.id === issue.id)) continue;
      const keep = stillListed(issue, list, displayOf(list, state.settings, id), context);
      lists[id] = { ...list, issues: keep ? list.issues.map((item) => (item.id === issue.id ? { ...issue, workspaceId: item.workspaceId ?? issue.workspaceId } : item)) : list.issues.filter((item) => item.id !== issue.id) };
    }
    this.set({ linked: { ...this.view.linked, [issue.id]: issue }, lists });
  }

  /** One workspace's part of a list, from `after` on; a read another one has replaced (`live` says) asks for no further page. */
  private async readList(workspaceId: string, list: IssueList, id: ListId, options: { after?: string | null; maxPages: number; live?: () => boolean }): Promise<ListPart> {
    const source = list.source;
    const wanted = () => {
      if (options.live && !options.live()) throw new Error('replaced by a newer read');
    };
    if (source.kind === 'view' && list.projectDisplay) {
      const filter = projectDisplayFilter(list.projectDisplay);
      const read = await readPages<LinearProject>(async (after) => {
        wanted();
        const data = await this.graphqlIn<{ customView: { projects: Page<LinearProject> } | null }>(workspaceId, VIEW_PROJECTS_QUERY, { id: source.id, after, filter });
        if (!data.customView) throw new Error('Linear no longer has this view');
        return data.customView.projects;
      }, options);
      return { issues: [], projects: read.nodes.map((project) => inWorkspace(project, workspaceId)), endCursor: read.endCursor };
    }
    const filter = this.serverFilter(list, id);
    // A view whose own filters still hold as saved is read through the view, Linear applying them;
    // once they were changed here, its team's issues are read with the filters as they are now.
    const beyond = source.kind === 'view' ? beyondSaved(list.filters, list.match, list.viewFilters ?? []) : null;
    const page = (after: string | null): Promise<Page<LinearIssue>> => {
      wanted();
      // The workspace's issues the source narrows to (`of`), with the list's filter.
      const issues = (of: GraphFilter | null) => this.graphqlIn<{ issues: Page<LinearIssue> }>(workspaceId, ISSUES_QUERY, { after, filter: allOf(of, filter) }).then((data) => data.issues);
      // Issues assigned to me or created by me; the answer says who I am there.
      const mine = (query: string, field: 'assignedIssues' | 'createdIssues') =>
        this.graphqlIn<{ viewer: { id: string } & Record<typeof field, Page<LinearIssue>> }>(workspaceId, query, { after, filter }).then((data) => {
          this.viewerIds.set(workspaceId, data.viewer.id);
          return data.viewer[field];
        });
      switch (source.kind) {
        case 'assigned':
          return mine(ASSIGNED_QUERY, 'assignedIssues');
        case 'created':
          return mine(CREATED_QUERY, 'createdIssues');
        case 'subscribed':
          return issues({ subscribers: { some: { isMe: { eq: true } } } });
        case 'project':
          return issues({ project: { id: { eq: source.id } } });
        case 'view':
          if (!beyond) return issues(list.view?.team ? { team: { id: { eq: list.view.team.id } } } : null);
          return this.graphqlIn<{ customView: { issues: Page<LinearIssue> } | null }>(workspaceId, VIEW_ISSUES_QUERY, { id: source.id, after, filter: this.serverFilter(list, id, beyond) }).then((data) => {
            if (!data.customView) throw new Error('Linear no longer has this view');
            return data.customView.issues;
          });
        case 'search':
          return this.graphqlIn<{ searchIssues: Page<LinearIssue> }>(workspaceId, SEARCH_QUERY, { term: source.term, after, filter }).then((data) => data.searchIssues);
      }
    };
    const read = await readPages(page, options);
    return { issues: read.nodes.map((issue) => inWorkspace(issue, workspaceId)), projects: [], endCursor: read.endCursor };
  }

  /** What a list asks Linear for beyond its own source: what its display hides, and its filters (or only `filters`). */
  private serverFilter(list: IssueList, id: ListId, filters: { nodes: LinearFilterNode[]; match: FilterJoin } = { nodes: list.filters, match: list.match }): GraphFilter | null {
    const { state, today } = this.client.getView();
    return allOf(displayFilter(displayOf(list, state.settings, id)), compileFilter(filters.nodes, { today, weekStartsOn: state.settings.weekStartsOn }, filters.match));
  }

  private async viewMeta(workspaceId: string, id: string): Promise<LinearViewMeta> {
    const data = await this.graphqlIn<{ customView: Omit<LinearViewMeta, 'workspaceId'> | null }>(workspaceId, VIEW_QUERY, { id });
    if (!data.customView) throw new Error('Linear no longer has this view');
    const known = this.view.views.find((view) => view.id === id && view.workspaceId === workspaceId);
    return { ...data.customView, workspaceId, ...(known?.favoriteOrder !== undefined ? { favoriteOrder: known.favoriteOrder } : {}) };
  }

  /** The workspaces a list reads: a view's or project's own, or the shown ones a workspace filter keeps. */
  private targets(list: IssueList): WorkspaceView[] {
    const source = list.source;
    if (source.kind === 'view' || source.kind === 'project') return this.view.workspaces.filter((workspace) => workspace.id === source.workspaceId);
    const shown = this.scoped();
    const kept = new Set(workspacesFor(list.filters, shown.map((workspace) => workspace.id)));
    return shown.filter((workspace) => kept.has(workspace.id));
  }
}
