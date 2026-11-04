// Projects as Linear lists them (status groups; health, lead, target date and
// progress on each row), saved views of projects, and one project's page: its
// facts, its issues as a full list (filters, display, board) and its overview.
import { useState } from 'preact/hooks';
import { monthDay } from '../../../src/domain/dates.ts';
import { HEALTH_LABELS, groupProjects } from '../../../src/domain/linearDisplay.ts';
import type { LinearProject, LinearProjectDetail } from '../../../src/domain/linear.ts';
import { useLinear, usePlanner, useView } from '../../lib/context.ts';
import { displayOf, type OpenProject } from '../../lib/linear.ts';
import { HeadSearch, SidebarToggle } from './chrome.tsx';
import { LinearErrors, excerpt, workspaceLabel } from './common.tsx';
import { Avatar, ProjectIcon } from './icons.tsx';
import { IssueCollection } from './IssueCollection.tsx';
import { ListToolbar, countText, type MenuState } from './Toolbar.tsx';

export const Progress = ({ value }: { value: number }) => {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span class="progress" title={`${percent}% complete`}>
      <span class="progress-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      <span class="progress-label">{percent}%</span>
    </span>
  );
};

export const ProjectRow = ({ project, from }: { project: LinearProject; from?: OpenProject['from'] }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const workspace = workspaceLabel(lv, project.workspaceId);
  return (
    <li>
      <button class="project-row lin-project-row" onClick={() => void linear.openProject(project, from ?? null)} aria-label={`Open project ${project.name}`}>
        <ProjectIcon color={project.color} />
        <span class="project-main">
          <span class="project-name">{project.name}</span>
          {project.description && <span class="lin-project-summary">{excerpt(project.description, 90)}</span>}
        </span>
        <span class="lin-project-props">
          {workspace && <span class="ws-badge">{workspace}</span>}
          {project.health ? <span class={`health is-${project.health}`}>{HEALTH_LABELS[project.health]}</span> : <span class="muted">{project.status.name}</span>}
          <Avatar name={project.lead?.name} />
          <span class="lin-date">{project.targetDate ? monthDay(project.targetDate) : ''}</span>
          {project.teams.nodes.length > 0 && <span class="muted">{project.teams.nodes.map((team) => team.key).join(', ')}</span>}
          <Progress value={project.progress} />
        </span>
      </button>
    </li>
  );
};

const ProjectGroups = ({ projects, display, from }: { projects: LinearProject[]; display?: Parameters<typeof groupProjects>[1]; from?: OpenProject['from'] }) => (
  <>
    {groupProjects(projects, display).map((group) => (
      <section key={group.key} class="issue-group lin-group" aria-label={`${group.label} projects`}>
        <h3 class="lin-group-head"><span class="lin-group-name">{group.label}</span> <span class="count">{group.projects.length}</span></h3>
        <ul class="project-list">{group.projects.map((project) => <ProjectRow key={`${project.workspaceId}:${project.id}`} project={project} from={from} />)}</ul>
      </section>
    ))}
  </>
);

/** All projects of the shown workspaces that are not completed or canceled, the active ones first. */
export const ProjectsPane = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  return (
    <>
      <header class="lin-head">
        <SidebarToggle />
        <div class="lin-crumbs"><h1>Projects</h1></div>
        <span class="grow" />
        <HeadSearch />
        <span class="lin-count">{lv.projectsLoaded ? countText(lv.projects.length, Object.keys(lv.projectsMore).length > 0, 'open project') : ''}</span>
        <button class="lin-icon-button" aria-label="Refresh projects" title="Refresh" onClick={() => void linear.loadProjects()}>↻</button>
      </header>
      <div class="lin-content view-scroll linear-projects">
        {lv.error && <p class="feed-errors" role="alert">{lv.error}</p>}
        {lv.projectsLoading && lv.projects.length === 0 && <p class="hint">Loading projects…</p>}
        {!lv.projectsLoading && lv.projectsLoaded && lv.projects.length === 0 && <p class="hint">No open projects here.</p>}
        <ProjectGroups projects={lv.projects} />
        {Object.keys(lv.projectsMore).length > 0 && (
          <div class="lin-more" role="status">
            <span class="hint">{lv.projects.length} shown; Linear has more open projects</span>
            <button class="link" disabled={lv.projectsLoading} onClick={() => void linear.loadMoreProjects()}>{lv.projectsLoading ? 'Loading…' : 'Load more projects'}</button>
          </div>
        )}
      </div>
    </>
  );
};

/** A saved view of projects: the projects its filter holds, grouped and ordered as saved. */
export const ProjectCollection = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists.page;
  const more = Object.keys(list.more).length > 0;
  const projects = list.projects ?? [];
  const from = list.view && list.source.kind === 'view' ? { kind: 'view' as const, id: list.view.id, workspaceId: list.source.workspaceId, name: list.view.name } : null;
  return (
    <div class="linear-projects">
      {!list.loading && projects.length === 0 && !list.error && <p class="hint">No projects in this view.</p>}
      <ProjectGroups projects={projects} display={list.projectDisplay ?? undefined} from={from} />
      {more && (
        <div class="lin-more">
          <span class="muted">{projects.length} loaded · Linear has more</span>
          <button type="button" class="lin-button" disabled={list.loadingMore || list.loading} onClick={() => void linear.loadMore('page')}>{list.loadingMore || list.loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </div>
  );
};

export const ProjectOverview = ({ detail }: { detail: LinearProjectDetail }) => {
  const { host } = usePlanner();
  const milestones = [...detail.projectMilestones.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  const update = detail.lastUpdate;
  if (!update && milestones.length === 0 && !detail.content?.trim()) return <p class="hint">This project has no updates, milestones or description yet.</p>;
  return (
    <div class="project-overview">
      {update && (
        <section aria-label="Latest update">
          <h3>
            Latest update
            <span class={`health is-${update.health}`}>{HEALTH_LABELS[update.health] ?? update.health}</span>
            <span class="count">{update.user.name} · {new Date(update.createdAt).toLocaleDateString()}</span>
            <button class="link" onClick={() => void host.openUrl(update.url)}>Open</button>
          </h3>
          <p class="pre">{excerpt(update.body, 1500)}</p>
        </section>
      )}
      {milestones.length > 0 && (
        <section aria-label="Milestones">
          <h3>Milestones</h3>
          <ul class="milestones">
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <span class="milestone-name">{milestone.name}</span>
                {milestone.targetDate && <span class="muted">{monthDay(milestone.targetDate)}</span>}
                <Progress value={milestone.progress} />
              </li>
            ))}
          </ul>
          {detail.projectMilestones.pageInfo?.hasNextPage && (
            <p class="hint" role="note">
              Linear has more milestones than the first {milestones.length}: <button class="link" onClick={() => void host.openUrl(detail.url)}>Open in Linear</button>
            </p>
          )}
        </section>
      )}
      {detail.content?.trim() && (
        <section aria-label="Description">
          <h3>Description</h3>
          <p class="pre">{excerpt(detail.content, 5000)}</p>
        </section>
      )}
    </div>
  );
};

/** One project: its facts, then its issues (a full list, to filter, group and plan) or its overview. */
export const ProjectPage = ({ open, menus }: { open: OpenProject; menus: MenuState }) => {
  const { linear, host } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const [tab, setTab] = useState<'issues' | 'overview'>('issues');
  const project = open.detail ?? open.project;
  const workspace = workspaceLabel(lv, project.workspaceId);
  const list = lv.lists.page;
  const display = displayOf(list, view.state.settings, 'page');
  const more = Object.keys(list.more).length > 0;
  return (
    <div class="project-detail lin-project-page" aria-label={`Project ${project.name}`}>
      <header class="lin-head">
        <SidebarToggle />
        <button class="link lin-back" onClick={() => linear.closeProject()}>{open.from ? `← ${open.from.name}` : '← All projects'}</button>
        <span class="lin-crumb-sep" aria-hidden="true">›</span>
        <ProjectIcon color={project.color} />
        <h2>{project.name}</h2>
        {workspace && <span class="ws-badge">{workspace}</span>}
        <span class="grow" />
        <HeadSearch />
        <button class="lin-button" onClick={() => void host.openUrl(project.url)}>Open in Linear ↗</button>
      </header>
      <div class="lin-project-top">
        {project.description && <p class="project-summary">{project.description}</p>}
        <dl class="facts project-facts">
          <dt>Status</dt>
          <dd><span class="project-status" style={{ '--item-color': project.status.color }}>{project.status.name}</span></dd>
          <dt>Progress</dt>
          <dd><Progress value={project.progress} /></dd>
          {project.health && (<><dt>Health</dt><dd class={`health is-${project.health}`}>{HEALTH_LABELS[project.health]}</dd></>)}
          <dt>Lead</dt>
          <dd>{project.lead?.name ?? 'No lead'}</dd>
          {(project.startDate || project.targetDate) && (<><dt>Dates</dt><dd>{project.startDate ? monthDay(project.startDate) : 'No start'} → {project.targetDate ? monthDay(project.targetDate) : 'no target'}</dd></>)}
          {project.teams.nodes.length > 0 && (<><dt>Teams</dt><dd>{project.teams.nodes.map((team) => `${team.key} · ${team.name}`).join(', ')}</dd></>)}
        </dl>
        <div class="tabs project-tabs" role="tablist" aria-label="Project">
          <button role="tab" aria-selected={tab === 'issues'} onClick={() => setTab('issues')}>Issues {list.loading ? '' : `${list.issues.length}${more ? '+' : ''}`}</button>
          <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Overview</button>
        </div>
      </div>
      {tab === 'issues' && <ListToolbar listId="page" menus={menus} />}
      <div class={`lin-content view-scroll${display.layout === 'board' && tab === 'issues' ? ' is-board' : ''}`}>
        {open.error && <p class="feed-errors" role="alert">{open.error}</p>}
        {tab === 'issues' && (
          <>
            <LinearErrors error={list.error} workspaceIds={[project.workspaceId ?? '']} />
            {list.loading && list.issues.length === 0 && <p class="hint">Loading issues…</p>}
            {!list.loading && list.issues.length === 0 && !list.error && <p class="hint">{list.filters.length ? 'No issue in this project matches these filters.' : 'No issues in this project.'}</p>}
            {list.issues.length > 0 && <IssueCollection listId="page" issues={list.issues} display={display} />}
          </>
        )}
        {tab === 'overview' && (open.loading ? <p class="hint">Loading the project…</p> : open.detail ? <ProjectOverview detail={open.detail} /> : null)}
      </div>
    </div>
  );
};
