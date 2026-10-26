// Linear as a full page, laid out like Linear: its own sidebar (My issues,
// Favorites, Views, Projects), and the open list with its name, filters and
// Display options; projects and the issues already planned here. Keys as in
// Linear: F filter, Shift V display, Cmd/Ctrl B list or board, / search,
// G then I (my issues), V (views) or P (projects).
import { useEffect, useRef, useState } from 'preact/hooks';
import { isProjectView, viewUrl } from '../../../src/domain/linear.ts';
import { useLinear, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { displayOf, type IssueList, type LinearView } from '../../lib/linear.ts';
import { ConnectLinear, LinearErrors, needsConnect, workspaceLabel } from './common.tsx';
import { ViewIcon } from './icons.tsx';
import { IssueCollection } from './IssueCollection.tsx';
import { PlannedPane } from './Planned.tsx';
import { ProjectCollection, ProjectPage, ProjectsPane } from './Projects.tsx';
import { LinearSidebar } from './Sidebar.tsx';
import { ListToolbar, type MenuState } from './Toolbar.tsx';

/** What the open list is called, and where it sits, as Linear's header shows it. */
const titleOf = (list: IssueList, lv: LinearView): { crumb: string; name: string; projects: boolean } => {
  const source = list.source;
  switch (source.kind) {
    case 'assigned':
      return { crumb: 'My issues', name: 'Assigned', projects: false };
    case 'created':
      return { crumb: 'My issues', name: 'Created', projects: false };
    case 'subscribed':
      return { crumb: 'My issues', name: 'Subscribed', projects: false };
    case 'search':
      return { crumb: 'Search', name: `“${source.term}”`, projects: false };
    case 'project':
      return { crumb: 'Projects', name: lv.project?.project.name ?? 'Project', projects: false };
    case 'view': {
      const view = list.view ?? lv.views.find((item) => item.id === source.id && item.workspaceId === source.workspaceId);
      const workspace = workspaceLabel(lv, source.workspaceId);
      const where = view?.team ? `${view.team.name}` : view?.shared === false ? 'My views' : 'Workspace views';
      return { crumb: workspace ? `${workspace} · ${where}` : where, name: view?.name ?? 'View', projects: Boolean(view && isProjectView(view)) };
    }
  }
};

const IssuesPane = ({ menus }: { menus: MenuState }) => {
  const { linear, host } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const list = lv.lists.page;
  const display = displayOf(list, view.state.settings, 'page');
  const title = titleOf(list, lv);
  const source = list.source;
  const workspace = source.kind === 'view' ? linear.workspace(source.workspaceId) : null;
  const favorite = list.view?.favoriteOrder !== undefined;
  return (
    <>
      <header class="lin-head">
        <div class="lin-crumbs">
          <span class="lin-crumb">{title.crumb}</span>
          <span class="lin-crumb-sep" aria-hidden="true">›</span>
          {source.kind === 'view' && <ViewIcon projects={title.projects} color={list.view?.color} />}
          <h1>{title.name}</h1>
          {favorite && <span class="lin-star" title="In your favorites">★</span>}
        </div>
        <span class="grow" />
        {source.kind === 'view' && workspace && list.view && (
          <button class="lin-button" onClick={() => void host.openUrl(viewUrl(workspace.urlKey, list.view!))} title="Open this view in Linear">Open in Linear ↗</button>
        )}
        <button class="lin-icon-button" aria-label="Refresh Linear" title={lv.syncedAt ? `Synced ${new Date(lv.syncedAt).toLocaleTimeString()}` : 'Refresh'} onClick={() => void linear.refresh()}>↻</button>
      </header>
      {list.view?.description && <p class="lin-description">{list.view.description}</p>}
      <ListToolbar listId="page" menus={menus} />
      <div class={`lin-content view-scroll${display.layout === 'board' && !list.projectDisplay ? ' is-board' : ''}`}>
        <LinearErrors error={list.error ?? lv.error} workspaceIds={linear.workspacesOf(list)} />
        {list.loading && list.issues.length === 0 && !list.projects?.length && <p class="hint">Loading…</p>}
        {list.projectDisplay ? (
          <ProjectCollection />
        ) : (
          <>
            {!list.loading && list.issues.length === 0 && !list.error && (
              <p class="hint lin-empty">{list.filters.length ? 'No issues match these filters.' : source.kind === 'view' ? 'No issues in this view.' : 'No issues here.'}</p>
            )}
            {list.issues.length > 0 && <IssueCollection listId="page" issues={list.issues} display={display} />}
          </>
        )}
      </div>
    </>
  );
};

export const LinearPage = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const { ui } = useUi();
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const menus: MenuState = { filterOpen, setFilterOpen, displayOpen, setDisplayOpen };
  const listShown = lv.mode === 'issues' || (lv.mode === 'projects' && Boolean(lv.project));

  useEffect(() => linear.use('page'), [linear]);
  useEffect(() => {
    if (lv.mode === 'projects' && !lv.projectsLoaded && !lv.projectsLoading) void linear.loadProjects();
  }, [lv.mode]);
  // A new list closes the menus of the old one.
  useEffect(() => {
    setFilterOpen(false);
    setDisplayOpen(false);
  }, [JSON.stringify(lv.lists.page.source), lv.mode]);

  // Linear's keys on this page; the Planner's own (A, T, P…) still work, F opens the filter here.
  const state = useRef({ g: 0 });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
      if (typing || event.defaultPrevented || ui.openTaskId || ui.openIssue || document.querySelector('.modal-backdrop')) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'b' && listShown) {
        event.preventDefault();
        const list = linear.list('page');
        if (!list.projectDisplay) void linear.setDisplay({ layout: displayOf(list, view.state.settings, 'page').layout === 'board' ? 'list' : 'board' });
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.current.g && Date.now() - state.current.g < 1500) {
        state.current.g = 0;
        if (key === 'i') linear.setSource({ kind: 'assigned' });
        else if (key === 'v') findRef.current?.focus();
        else if (key === 'p') linear.setMode('projects');
        else return;
        event.preventDefault();
        return;
      }
      if (key === 'g' && !event.shiftKey) {
        state.current.g = Date.now();
        event.preventDefault();
        return;
      }
      // F is the filter on this page, never Focus; where nothing can be filtered it does nothing.
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault();
        if (!listShown || linear.list('page').projectDisplay) return;
        setDisplayOpen(false);
        setFilterOpen(true);
        return;
      }
      if (key === 'v' && event.shiftKey) {
        event.preventDefault();
        if (!listShown) return;
        setFilterOpen(false);
        setDisplayOpen(true);
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ui.openTaskId, ui.openIssue, listShown, linear, view.state.settings]);

  return (
    <section class="view linear-view">
      <div class="lin-shell">
        <LinearSidebar searchRef={searchRef} findRef={findRef} />
        <div class="lin-main linear-page">
          {needsConnect(lv) ? (
            <div class="lin-content"><ConnectLinear /></div>
          ) : lv.mode === 'planned' ? (
            <PlannedPane />
          ) : lv.mode === 'projects' ? (
            lv.project ? <ProjectPage key={lv.project.project.id} open={lv.project} menus={menus} /> : <ProjectsPane />
          ) : (
            <IssuesPane menus={menus} />
          )}
        </div>
      </div>
    </section>
  );
};
