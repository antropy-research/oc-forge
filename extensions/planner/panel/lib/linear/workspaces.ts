// Linear as the Planner reaches it, the layer the Linear store (store.ts) is built on: OpenChamber's own Linear
// connection, plus workspaces added with a personal API key, whose keys the local service keeps and whose requests it
// sends; a GraphQL document goes to a workspace the way that workspace is reached. It holds the view every layer above
// shows, and what each workspace offers, read once and kept: its teams, their workflow states and options, the
// filters' catalog, and my user id there.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import {
  FILTER_CYCLES_QUERY,
  FILTER_LABELS_QUERY,
  FILTER_MILESTONES_QUERY,
  FILTER_PROJECTS_QUERY,
  FILTER_TEAMS_QUERY,
  FILTER_USERS_QUERY,
  ISSUE_QUERY,
  TEAMS_QUERY,
  TEAM_OPTIONS_QUERY,
  TEAM_STATES_QUERY,
  WHOAMI_QUERY,
  WORKSPACE_LABELS_QUERY,
  inWorkspace,
  readGraphql,
  teamOptionPageQuery,
  workflowOrder,
  type LinearCycle,
  type LinearIssue,
  type LinearLabel,
  type LinearState,
  type LinearWorkspace,
  type TeamOptionField,
  type TeamOptions,
} from '../../../src/domain/linear/linear.ts';
import { readPages, type Page } from '../../../src/domain/linear/display.ts';
import type { CatalogPart, FilterCatalog } from '../../../src/domain/linear/filter.ts';
import type { TaskSourceRef } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { PlannerClient } from '../core/client.ts';
import { emptyList, type LinearTeam, type LinearView, type WorkspaceView } from './types.ts';

/** Pages of 100 teams for the team picker. */
const MAX_TEAM_PAGES = 20;
/** Pages of 250 of one of a team's options (people, labels…) after the first. */
const MAX_OPTION_PAGES = 20;
/** Pages of each part of a filter catalog; where Linear has more, the filter menu says so. */
const MAX_CATALOG_PAGES = 20;
/** How long a workspace's catalog is kept before it is read again. */
const CATALOG_MS = 10 * 60_000;

export class LinearWorkspaces {
  protected view: LinearView = {
    connected: null,
    account: '',
    workspaces: [],
    scope: 'all',
    mode: 'issues',
    lists: { page: emptyList(), side: emptyList() },
    views: [],
    viewsLoaded: false,
    viewsMore: {},
    favorites: [],
    linked: {},
    projects: [],
    projectsLoaded: false,
    projectsLoading: false,
    projectsMore: {},
    project: null,
    catalogs: {},
    error: null,
    syncedAt: null,
    prompt: null,
    moving: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  /** OpenChamber's workspace, once a request has said which it is. */
  protected hostWorkspace: WorkspaceView | null = null;
  /** The workspaces added with a key, as the service keeps them. */
  protected keyWorkspaces: WorkspaceView[] = [];
  private identifying: Promise<boolean> | null = null;
  /** My user id in each workspace, for assigning new issues. */
  protected readonly viewerIds = new Map<string, string>();
  /** Each team's workflow states, in workflow order. */
  private readonly teamStates = new Map<string, LinearState[]>();
  private readonly teamLists = new Map<string, LinearTeam[]>();
  private readonly teamOptionCache = new Map<string, TeamOptions>();
  /** Workspaces with more teams than `teams()` reads (MAX_TEAM_PAGES of 100): the team picker says so. */
  readonly teamsCut = new Set<string>();
  private readonly catalogLoads = new Map<string, Promise<void>>();
  private readonly catalogTimes = new Map<string, number>();

  constructor(protected readonly host: HostClient, protected readonly client: PlannerClient, protected readonly surface: string) {}

  getView = (): LinearView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Some workspace can be read. */
  available(): boolean {
    return this.view.workspaces.length > 0;
  }

  connect(): Promise<void> {
    return this.host.oauthStart();
  }

  workspace(id: string | null | undefined): WorkspaceView | null {
    return this.view.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  /** The workspace a linked task's issue lives in; older links mean OpenChamber's connection. */
  workspaceOf(source: TaskSourceRef): string | null {
    return source.workspaceId ?? this.hostWorkspace?.id ?? null;
  }

  /** My user id in a workspace, once known. */
  viewerId(workspaceId: string | null): string | null {
    return workspaceId ? this.viewerIds.get(workspaceId) ?? null : null;
  }

  /**
   * An issue by its identifier (NEX-110) or id; null when no connected workspace
   * knows it. `urlKey` (from an issue URL) picks the workspace it belongs to.
   */
  async issue(id: string, urlKey?: string): Promise<LinearIssue | null> {
    const candidates = urlKey ? this.view.workspaces.filter((workspace) => workspace.urlKey.toLowerCase() === urlKey.toLowerCase()) : this.view.workspaces;
    let failure: unknown = null;
    for (const workspace of candidates) {
      try {
        const issue = await this.issueIn(workspace.id, id);
        if (issue) return issue;
      } catch (error) {
        failure = error;
      }
    }
    if (failure && candidates.length === 1) throw failure;
    return null;
  }

  /** Teams of every connected workspace, for creating an issue. */
  async teams(): Promise<LinearTeam[]> {
    const settled = await Promise.allSettled(
      this.view.workspaces.map(async (workspace) => {
        const cached = this.teamLists.get(workspace.id);
        if (cached) return cached;
        // Every team, a page at a time (the picker used to stop at the first 100).
        const read = await readPages<Omit<LinearTeam, 'workspaceId'>>(
          (after) =>
            this.graphqlIn<{ viewer: { id: string }; teams: Page<Omit<LinearTeam, 'workspaceId'>> }>(workspace.id, TEAMS_QUERY, { after }).then((data) => {
              this.viewerIds.set(workspace.id, data.viewer.id);
              return data.teams;
            }),
          { maxPages: MAX_TEAM_PAGES },
        );
        const teams = read.nodes.map((team) => ({ ...team, workspaceId: workspace.id }));
        if (read.hasMore) this.teamsCut.add(workspace.id);
        else this.teamsCut.delete(workspace.id);
        this.teamLists.set(workspace.id, teams);
        return teams;
      }),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  /** What an issue of `teamId` can be set to: states in workflow order, active members, labels, cycles, projects, estimates. */
  async teamOptions(workspaceId: string, teamId: string): Promise<TeamOptions> {
    const cached = this.teamOptionCache.get(teamId);
    if (cached) return cached;
    type Answer = {
      team: {
        cyclesEnabled?: boolean;
        issueEstimationType?: string;
        issueEstimationAllowZero?: boolean;
        issueEstimationExtended?: boolean;
        states: Page<LinearState>;
        members: Page<TeamOptions['members'][number]>;
        labels: Page<LinearLabel>;
        cycles?: Page<LinearCycle>;
        projects?: Page<TeamOptions['projects'][number]>;
      } | null;
      issueLabels: Page<LinearLabel>;
    };
    const data = await this.graphqlIn<Answer>(workspaceId, TEAM_OPTIONS_QUERY, { id: teamId });
    if (!data.team) throw new Error('Linear no longer has this team');
    // A team or workspace with more than one read's worth (more than 250 people or labels): the rest, page by page,
    // so every one can be picked (they used to stop at the first page).
    const rest = async <T>(first: Page<T> | undefined, more: (after: string) => Promise<Page<T>>): Promise<T[]> => {
      if (!first) return [];
      if (!first.pageInfo?.hasNextPage || !first.pageInfo.endCursor) return first.nodes;
      const read = await readPages<T>((after) => more(after!), { after: first.pageInfo.endCursor, maxPages: MAX_OPTION_PAGES });
      return [...first.nodes, ...read.nodes];
    };
    const ofTeam = <T>(field: TeamOptionField) => (after: string) =>
      this.graphqlIn<{ team: Record<string, Page<T>> | null }>(workspaceId, teamOptionPageQuery(field), { id: teamId, after }).then((answer) => answer.team?.[field] ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
    const team = data.team;
    const [states, members, teamLabels, workspaceLabels, cycles, projects] = await Promise.all([
      rest(team.states, ofTeam<LinearState>('states')),
      rest(team.members, ofTeam<TeamOptions['members'][number]>('members')),
      rest(team.labels, ofTeam<LinearLabel>('labels')),
      rest(data.issueLabels, (after) => this.graphqlIn<{ issueLabels: Page<LinearLabel> }>(workspaceId, WORKSPACE_LABELS_QUERY, { after }).then((answer) => answer.issueLabels)),
      rest(team.cycles, ofTeam<LinearCycle>('cycles')),
      rest(team.projects, ofTeam<TeamOptions['projects'][number]>('projects')),
    ]);
    const labels = new Map([...teamLabels, ...workspaceLabels].map((label) => [label.id, label]));
    const options: TeamOptions = {
      states: workflowOrder(states),
      members: members.filter((member) => member.active).sort((a, b) => a.name.localeCompare(b.name)),
      labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
      cycles: team.cyclesEnabled === false ? [] : [...cycles].sort((a, b) => a.number - b.number),
      projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)),
      estimation: { type: team.issueEstimationType ?? 'notUsed', allowZero: Boolean(team.issueEstimationAllowZero), extended: Boolean(team.issueEstimationExtended) },
    };
    this.teamStates.set(teamId, options.states);
    this.teamOptionCache.set(teamId, options);
    return options;
  }

  /** What filters offer and boards need, for the given workspaces: read once, then kept for a while. */
  loadCatalogs(workspaceIds: readonly string[] = this.scoped().map((workspace) => workspace.id)): Promise<void> {
    return Promise.all(
      workspaceIds
        .filter((workspaceId) => this.workspace(workspaceId))
        .map((workspaceId) => {
          const fresh = Date.now() - (this.catalogTimes.get(workspaceId) ?? 0) < CATALOG_MS && this.view.catalogs[workspaceId];
          if (fresh) return Promise.resolve();
          const running = this.catalogLoads.get(workspaceId);
          if (running) return running;
          const load = this.readCatalog(workspaceId)
            .then((catalog) => {
              this.catalogTimes.set(workspaceId, Date.now());
              for (const team of catalog.teams) this.teamStates.set(team.id, workflowOrder(team.states));
              this.set({ catalogs: { ...this.view.catalogs, [workspaceId]: catalog } });
            })
            .catch((error) => console.warn(`[planner] Linear filter choices unavailable: ${messageOf(error)}`))
            .finally(() => this.catalogLoads.delete(workspaceId));
          this.catalogLoads.set(workspaceId, load);
          return load;
        }),
    ).then(() => undefined);
  }

  /** Workflow states of the teams, from the catalogs (for board columns without issues yet). */
  statesForTeams(teamIds: readonly string[]): LinearState[] {
    return teamIds.flatMap((teamId) => this.teamStates.get(teamId) ?? []);
  }

  /** The workflow states of an issue's team, by its link (a task's, or a merged subtask's): the status prompt's choices. */
  async statesForSource(source: TaskSourceRef | null): Promise<LinearState[]> {
    if (source?.kind !== 'linear') return [];
    const workspaceId = this.reachable(source);
    if (!workspaceId) return [];
    const teamId = source.teamId ?? (await this.issueIn(workspaceId, source.id))?.team.id;
    return teamId ? this.statesOf(workspaceId, teamId) : [];
  }

  /** An issue's team's states (a pasted issue's, to choose its status before it is added). */
  statesForIssue(issue: LinearIssue): Promise<LinearState[]> {
    const workspaceId = this.reachable(issue);
    return workspaceId ? this.statesOf(workspaceId, issue.team.id) : Promise.resolve([]);
  }

  protected set(patch: Partial<LinearView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Which workspace OpenChamber's connection reaches, so its issues carry that workspace. */
  protected identifyHost(): Promise<boolean> {
    this.identifying ??= (async () => {
      try {
        const data = await this.hostGraphql<{ viewer: { id: string; name: string }; organization: { id: string; name: string; urlKey: string } }>(WHOAMI_QUERY);
        this.viewerIds.set(data.organization.id, data.viewer.id);
        this.set({ connected: true, error: null });
        this.setHost({ id: data.organization.id, name: data.organization.name, urlKey: data.organization.urlKey, account: data.viewer.name, via: 'host', error: null });
        return true;
      } catch (error) {
        // A missing connection shows as Connect, not as an error.
        if (this.view.connected !== false) this.set({ error: messageOf(error) });
        return false;
      } finally {
        this.identifying = null;
      }
    })();
    return this.identifying;
  }

  protected setHost(workspace: WorkspaceView | null): void {
    this.hostWorkspace = workspace;
    this.compose();
  }

  protected async loadKeyWorkspaces(): Promise<void> {
    try {
      const answer = await this.client.call<{ workspaces: Omit<LinearWorkspace, 'via'>[] }>('GET', '/linear/workspaces');
      this.keyWorkspaces = answer.workspaces.map((workspace) => ({ ...workspace, via: 'key', error: null }));
      this.compose();
    } catch (error) {
      // OpenChamber's own connection works without the service's workspaces.
      console.warn(`[planner] Linear workspaces unavailable: ${messageOf(error)}`);
    }
  }

  /** OpenChamber's workspace first; a key for that same workspace is not needed while it is connected. */
  private compose(): void {
    const errors = new Map(this.view.workspaces.map((workspace) => [workspace.id, workspace.error]));
    const host = this.hostWorkspace;
    const workspaces = [...(host ? [host] : []), ...this.keyWorkspaces.filter((workspace) => workspace.id !== host?.id)].map((workspace) => ({ ...workspace, error: errors.get(workspace.id) ?? null }));
    const scope = this.view.scope === 'all' || workspaces.some((workspace) => workspace.id === this.view.scope) ? this.view.scope : 'all';
    this.set({ workspaces, scope });
  }

  /** Remember which workspaces failed and clear the ones that answered. */
  protected noteErrors(errors: ReadonlyMap<string, string>, asked: readonly string[]): void {
    const touched = new Set(asked);
    if (touched.size === 0) return;
    this.set({ workspaces: this.view.workspaces.map((workspace) => (touched.has(workspace.id) ? { ...workspace, error: errors.get(workspace.id) ?? null } : workspace)) });
  }

  /** The shown workspaces: all, or the one chosen. */
  protected scoped(): WorkspaceView[] {
    return this.view.scope === 'all' ? this.view.workspaces : this.view.workspaces.filter((workspace) => workspace.id === this.view.scope);
  }

  /** The connected workspace an issue or a link lives in (none named: OpenChamber's connection), or null. */
  protected reachable(item: { workspaceId?: string | null }): string | null {
    const workspaceId = item.workspaceId ?? this.hostWorkspace?.id ?? null;
    return workspaceId && this.workspace(workspaceId) ? workspaceId : null;
  }

  /** A connected workspace for an issue, or an error saying it is not. */
  protected resolve(item: { workspaceId?: string | null }): string {
    const workspaceId = this.reachable(item);
    if (!workspaceId) throw new Error('its Linear workspace is not connected');
    return workspaceId;
  }

  /** Run a document in a workspace: OpenChamber's connection, or the service with that workspace's key. */
  protected async graphqlIn<T>(workspaceId: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new Error('that Linear workspace is not connected');
    if (workspace.via === 'host') return this.hostGraphql<T>(query, variables);
    const answer = await this.client.call<{ status: number; body: string }>('POST', '/linear/graphql', { workspaceId, query, variables });
    if (answer.status === 401) throw new Error(`Linear rejected the API key for ${workspace.name}; add it again in Settings`);
    if (!answer.body) throw new Error(`Linear answered HTTP ${answer.status}`);
    return readGraphql<T>(answer.body);
  }

  /** Every page of one of a workspace's connections (`key` in the answer), from `after` on, up to `maxPages`. */
  protected pagesIn<T>(workspaceId: string, query: string, key: string, options: { after?: string | null; maxPages: number }): Promise<{ nodes: T[]; endCursor: string | null; hasMore: boolean }> {
    return readPages<T>((after) => this.graphqlIn<Record<string, Page<T>>>(workspaceId, query, { after }).then((data) => data[key]!), options);
  }

  protected async issueIn(workspaceId: string, id: string): Promise<LinearIssue | null> {
    try {
      const issue = (await this.graphqlIn<{ issue: LinearIssue | null }>(workspaceId, ISSUE_QUERY, { id })).issue;
      return issue ? inWorkspace(issue, workspaceId) : null;
    } catch (error) {
      if (/not found/i.test(messageOf(error))) return null;
      throw error;
    }
  }

  protected async statesOf(workspaceId: string, teamId: string): Promise<LinearState[]> {
    const cached = this.teamStates.get(teamId);
    if (cached) return cached;
    const data = await this.graphqlIn<{ team: { states: { nodes: LinearState[] } } | null }>(workspaceId, TEAM_STATES_QUERY, { id: teamId });
    const states = workflowOrder(data.team?.states.nodes ?? []);
    this.teamStates.set(teamId, states);
    return states;
  }

  private async hostGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      const response = await this.host.request({ method: 'POST', path: '/graphql', body: JSON.stringify({ query, variables }) });
      if (response.status === 401) {
        this.set({ connected: false });
        this.setHost(null);
        throw new Error('Linear needs to be connected again');
      }
      if (!response.body) throw new Error(`Linear answered HTTP ${response.status}`);
      return readGraphql<T>(response.body);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === 'DISCONNECTED') {
        this.set({ connected: false });
        this.setHost(null);
      }
      throw error;
    }
  }

  /** A workspace's filter catalog: teams and their states, people, labels, projects, cycles and milestones. */
  private async readCatalog(workspaceId: string): Promise<FilterCatalog> {
    // What Linear has more of than this read (its bound of pages): the filter menu says so.
    const partial = new Set<CatalogPart>();
    const all = <T>(query: string, key: string, part: CatalogPart) =>
      this.pagesIn<T>(workspaceId, query, key, { maxPages: MAX_CATALOG_PAGES }).then((read) => {
        if (read.hasMore) partial.add(part);
        return read.nodes;
      });
    type TeamNode = { id: string; key: string; name: string; issueEstimationType?: string; issueEstimationAllowZero?: boolean; issueEstimationExtended?: boolean; states: Page<LinearState> };
    const [teams, users, labels, projects, cycles, milestones] = await Promise.all([
      all<TeamNode>(FILTER_TEAMS_QUERY, 'teams', 'teams'),
      all<FilterCatalog['users'][number]>(FILTER_USERS_QUERY, 'users', 'users').catch(() => []),
      all<FilterCatalog['labels'][number]>(FILTER_LABELS_QUERY, 'issueLabels', 'labels').catch(() => []),
      all<FilterCatalog['projects'][number]>(FILTER_PROJECTS_QUERY, 'projects', 'projects').catch(() => []),
      all<FilterCatalog['cycles'][number]>(FILTER_CYCLES_QUERY, 'cycles', 'cycles').catch(() => []),
      all<NonNullable<FilterCatalog['milestones']>[number]>(FILTER_MILESTONES_QUERY, 'projectMilestones', 'milestones').catch(() => []),
    ]);
    // A team's states are its first 50 here (the issue editor reads them all).
    if (teams.some((team) => team.states.pageInfo?.hasNextPage)) partial.add('states');
    const me = users.find((user) => user.isMe);
    if (me) this.viewerIds.set(workspaceId, me.id);
    return {
      workspaceId,
      teams: teams.map((team) => ({
        id: team.id,
        key: team.key,
        name: team.name,
        states: team.states.nodes,
        ...(team.issueEstimationType ? { estimation: { type: team.issueEstimationType, allowZero: Boolean(team.issueEstimationAllowZero), extended: Boolean(team.issueEstimationExtended) } } : {}),
      })),
      users,
      labels,
      projects,
      cycles,
      milestones,
      ...(partial.size ? { partial: [...partial] } : {}),
    };
  }
}
