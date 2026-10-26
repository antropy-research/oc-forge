// The Linear page's own sidebar, as in Linear: My issues (Assigned, Created,
// Subscribed), the issues planned here, Favorites, every saved view by team
// and workspace (searchable), and Projects; ↑/↓ move through it, Enter opens.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { groupViews, isProjectView, type LinearFavorite, type LinearSavedView } from '../../../src/domain/linear.ts';
import { searchChoices } from '../../../src/domain/linearFilter.ts';
import { useLinear, usePlanner } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import { sameSource, type LinearSource } from '../../lib/linear.ts';
import { workspaceLabel, workspaceNames } from './common.tsx';
import { Kbd, ProjectIcon, StatusIcon, ViewIcon } from './icons.tsx';
import { Picker, PickerButton } from './Picker.tsx';

const NavItem = ({ label, active, onClick, icon, hint, sub = false, title }: { label: string; active: boolean; onClick: () => void; icon?: ComponentChildren; hint?: ComponentChildren; sub?: boolean; title?: string }) => (
  <button type="button" class={`lin-nav-item${sub ? ' is-sub' : ''}${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} title={title} onClick={onClick}>
    {icon && <span class="lin-nav-icon" aria-hidden="true">{icon}</span>}
    <span class="lin-nav-label">{label}</span>
    {hint && <span class="lin-nav-hint" aria-hidden="true">{hint}</span>}
  </button>
);

/** ↑/↓ move between the sidebar's items and fields, as in a menu. */
const onNavKeys = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.lin-nav-item, .lin-nav-find')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = items[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
};

const WorkspaceSwitcher = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  if (lv.workspaces.length < 2) return null;
  const current = lv.scope === 'all' ? 'All workspaces' : lv.workspaces.find((workspace) => workspace.id === lv.scope)?.name ?? 'All workspaces';
  return (
    <PickerButton class="lin-workspace" label="Linear workspace" value={current} open={open} onOpen={() => setOpen(!open)}>
      <Picker
        label="Linear workspace"
        placeholder="Workspace…"
        options={[{ value: 'all', label: 'All workspaces' }, ...lv.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, hint: workspace.account }))]}
        selected={[lv.scope]}
        onClose={close}
        onPick={(option) => {
          linear.setScope(option.value);
          setOpen(false);
        }}
      />
    </PickerButton>
  );
};

export const LinearSidebar = ({ searchRef, findRef }: { searchRef: { current: HTMLInputElement | null }; findRef: { current: HTMLInputElement | null } }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const { setUi } = useUi();
  const [term, setTerm] = useState('');
  const [find, setFind] = useState('');
  const page = lv.lists.page;
  const onIssues = lv.mode === 'issues';
  const is = (source: LinearSource) => onIssues && sameSource(page.source, source);
  const views = lv.views.filter((view) => lv.scope === 'all' || view.workspaceId === lv.scope);
  const names = lv.scope === 'all' ? workspaceNames(lv) : undefined;
  const found = find.trim() ? searchChoices(views.map((view) => ({ ...view, label: view.name, hint: view.team?.key })), find) : views;
  const groups = groupViews(found as LinearSavedView[], names, { favoritesFirst: false });
  const favorites = lv.favorites.filter((favorite) => lv.scope === 'all' || favorite.workspaceId === lv.scope);
  const openView = (view: LinearSavedView) => linear.setSource({ kind: 'view', id: view.id, workspaceId: view.workspaceId ?? '' });
  const viewOf = (favorite: LinearFavorite) => lv.views.find((view) => view.id === favorite.id && view.workspaceId === favorite.workspaceId);
  const sub =
    lv.workspaces.length > 1
      ? `${lv.workspaces.length} workspaces`
      : lv.workspaces[0]
        ? `${lv.workspaces[0].name} · ${lv.workspaces[0].account}`
        : lv.connected === false
          ? 'Not connected'
          : 'Checking the connection…';
  return (
    <aside class="lin-sidebar" aria-label="Linear">
      <div class="lin-brand">
        <h2>Linear</h2>
        <span class="muted" title={lv.workspaces.map((workspace) => workspace.name).join(', ')}>{sub}</span>
      </div>
      <WorkspaceSwitcher />
      <form
        class="lin-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const query = term.trim();
          if (query) linear.setSource({ kind: 'search', term: query });
        }}
      >
        <input ref={searchRef} type="search" value={term} placeholder="Search issues…" aria-label="Search Linear issues" onInput={(event) => setTerm(event.currentTarget.value)} />
        <Kbd>/</Kbd>
      </form>
      <nav class="lin-nav" aria-label="Linear sections" onKeyDown={onNavKeys}>
        <div class="lin-nav-section">
          <NavItem label="My issues" icon="◎" active={false} hint={<Kbd>G I</Kbd>} title="My issues (G then I)" onClick={() => linear.setSource({ kind: 'assigned' })} />
          <NavItem sub label="Assigned" active={is({ kind: 'assigned' })} onClick={() => linear.setSource({ kind: 'assigned' })} />
          <NavItem sub label="Created" active={is({ kind: 'created' })} onClick={() => linear.setSource({ kind: 'created' })} />
          <NavItem sub label="Subscribed" active={is({ kind: 'subscribed' })} onClick={() => linear.setSource({ kind: 'subscribed' })} />
          {page.source.kind === 'search' && <NavItem sub label={`Search: ${page.source.term}`} active={onIssues} onClick={() => {}} />}
          <NavItem label="Planned" icon="✓" hint="in your plan" active={lv.mode === 'planned'} onClick={() => linear.setMode('planned')} />
        </div>
        {favorites.length > 0 && (
          <div class="lin-nav-section" role="group" aria-label="Favorites">
            <h2 class="lin-nav-heading">Favorites</h2>
            {favorites.map((favorite) => {
              const workspace = workspaceLabel(lv, favorite.workspaceId);
              if (favorite.kind === 'view') {
                const view = viewOf(favorite);
                if (!view) return null;
                return <NavItem key={`f:${favorite.workspaceId}:${favorite.id}`} label={view.name} icon={<ViewIcon projects={isProjectView(view)} color={view.color} />} hint={workspace ?? undefined} active={is({ kind: 'view', id: view.id, workspaceId: favorite.workspaceId })} onClick={() => openView(view)} />;
              }
              if (favorite.kind === 'project') {
                return <NavItem key={`f:${favorite.workspaceId}:${favorite.id}`} label={favorite.project.name} icon={<ProjectIcon color={favorite.project.color} />} hint={workspace ?? undefined} active={lv.mode === 'projects' && lv.project?.project.id === favorite.id} onClick={() => void linear.openProject(favorite.project)} />;
              }
              return <NavItem key={`f:${favorite.workspaceId}:${favorite.id}`} label={`${favorite.identifier} ${favorite.title}`} icon={<StatusIcon type={favorite.state.type} color={favorite.state.color} />} hint={workspace ?? undefined} active={false} onClick={() => setUi({ openIssue: { id: favorite.id, workspaceId: favorite.workspaceId } })} />;
            })}
          </div>
        )}
        <div class="lin-nav-section" role="group" aria-label="Views">
          <h2 class="lin-nav-heading">Views <Kbd>G V</Kbd></h2>
          <input ref={findRef} class="lin-nav-find" type="search" value={find} placeholder="Find a view…" aria-label="Find a view" onInput={(event) => setFind(event.currentTarget.value)} />
          {!lv.viewsLoaded && <p class="hint lin-nav-note">Loading views…</p>}
          {lv.viewsLoaded && views.length === 0 && <p class="hint lin-nav-note">No saved views.</p>}
          {lv.viewsLoaded && views.length > 0 && groups.length === 0 && <p class="hint lin-nav-note">No view matches.</p>}
          {groups.map((group) => (
            <div key={group.key} class="lin-nav-group" role="group" aria-label={group.label}>
              <div class="lin-nav-subheading">{group.label}</div>
              {group.views.map((view) => (
                <NavItem
                  key={`${view.workspaceId}:${view.id}`}
                  sub
                  label={view.name}
                  icon={<ViewIcon projects={isProjectView(view)} color={view.color} />}
                  hint={view.favoriteOrder !== undefined ? '★' : undefined}
                  title={view.description ?? (isProjectView(view) ? 'A view of projects' : 'A view of issues')}
                  active={is({ kind: 'view', id: view.id, workspaceId: view.workspaceId ?? '' })}
                  onClick={() => openView(view)}
                />
              ))}
            </div>
          ))}
        </div>
        <div class="lin-nav-section" role="group" aria-label="Projects">
          <h2 class="lin-nav-heading">Projects <Kbd>G P</Kbd></h2>
          <NavItem sub label="All projects" icon="▣" active={lv.mode === 'projects' && !lv.project} onClick={() => linear.setMode('projects')} />
          {lv.mode === 'projects' && lv.project && <NavItem sub label={lv.project.project.name} icon={<ProjectIcon color={lv.project.project.color} />} active onClick={() => {}} />}
        </div>
      </nav>
    </aside>
  );
};
