import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { newId } from '../../src/domain/ids.ts';
import { useUi } from '../lib/ui.ts';
import { actualMinutes, archivedTasks, tasksForDay } from '../../src/domain/selectors.ts';
import { useAgents, usePlanner, useView } from '../lib/context.ts';
import type { ServiceProblem } from '../lib/client.ts';
import { formatClock, useNow } from '../lib/time.ts';

export type Route = 'home' | 'today' | 'calendar' | 'focus' | 'planning' | 'shutdown' | 'highlights' | 'weeklyPlanning' | 'weeklyReview' | 'backlog' | 'linear' | 'github' | 'google' | 'agents' | 'archive' | 'stats' | 'settings';

const NavItem = ({ route, current, onRoute, children, badge }: { route: Route; current: Route; onRoute: (route: Route) => void; children: ComponentChildren; badge?: number }) => (
  <button class={`nav-item${route === current ? ' is-active' : ''}`} aria-current={route === current ? 'page' : undefined} onClick={() => onRoute(route)}>
    <span>{children}</span>
    {badge ? <span class="nav-badge" aria-hidden="true">{badge}</span> : null}
  </button>
);

/** The running timer, visible from every view. */
const TimerBar = ({ onRoute }: { onRoute: (route: Route) => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const timer = view.state.timer;
  const now = useNow(Boolean(timer));
  const task = timer ? view.state.tasks[timer.taskId] : null;
  if (!timer || !task) return null;
  return (
    <div class="timer-bar" role="status" aria-label="Running timer">
      <button class="timer-bar-title" onClick={() => onRoute('focus')} title="Open Focus">
        <span class="dot" aria-hidden="true" />
        <span class="title">{task.title}</span>
      </button>
      <span class="clock">{formatClock(actualMinutes(view.state, task, now))}</span>
      <button class="link" aria-label="Stop timer" onClick={() => void client.dispatch([{ type: 'timer.stopped' }])}>Stop</button>
    </div>
  );
};

export const Nav = ({ route, onRoute, onSearch, onAsk }: { route: Route; onRoute: (route: Route) => void; onSearch: () => void; onAsk: () => void }) => {
  const view = useView();
  const open = tasksForDay(view.state, view.today).filter((task) => !task.completedAt).length;
  const archived = archivedTasks(view.state).length;
  const agents = useAgents();
  const { client } = usePlanner();
  const { ui, setUi } = useUi();
  const [addingFolder, setAddingFolder] = useState(false);
  const folders = Object.values(view.state.folders).filter((folder) => !folder.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <nav class="nav" aria-label="Planner">
      <div class="brand">Planner</div>
      <button class="nav-search" onClick={onSearch} aria-label="Search and commands">
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      <button class="nav-item nav-ask" onClick={onAsk} aria-label="Ask Planner">
        <span>✦ Ask Planner</span>
      </button>
      <NavItem route="home" current={route} onRoute={onRoute}>Home</NavItem>
      <NavItem route="today" current={route} onRoute={onRoute} badge={open}>Today</NavItem>
      <NavItem route="calendar" current={route} onRoute={onRoute}>Calendar</NavItem>
      <NavItem route="focus" current={route} onRoute={onRoute}>Focus</NavItem>
      <div class="nav-section">Daily rituals</div>
      <NavItem route="planning" current={route} onRoute={onRoute}>Daily planning</NavItem>
      <NavItem route="shutdown" current={route} onRoute={onRoute}>Daily shutdown</NavItem>
      <NavItem route="highlights" current={route} onRoute={onRoute}>Daily highlights</NavItem>
      <div class="nav-section">Weekly rituals</div>
      <NavItem route="weeklyPlanning" current={route} onRoute={onRoute}>Weekly planning</NavItem>
      <NavItem route="weeklyReview" current={route} onRoute={onRoute}>Weekly review</NavItem>
      <div class="nav-section">Lists</div>
      <NavItem route="backlog" current={route === 'backlog' && ui.folderFilter && ui.folderFilter !== 'none' ? 'home' : route} onRoute={(next) => { setUi({ folderFilter: null }); onRoute(next); }}>Backlog</NavItem>
      {folders.map((folder) => (
        <button
          key={folder.id}
          class={`nav-item nav-sub${route === 'backlog' && ui.folderFilter === folder.id ? ' is-active' : ''}`}
          onClick={() => {
            setUi({ folderFilter: folder.id });
            onRoute('backlog');
          }}
        >
          <span>{folder.name}</span>
        </button>
      ))}
      {addingFolder ? (
        <input
          class="nav-input"
          aria-label="New folder name"
          placeholder="Folder name"
          ref={(element) => element?.focus()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setAddingFolder(false);
            if (event.key !== 'Enter') return;
            const name = event.currentTarget.value.trim().slice(0, 60);
            setAddingFolder(false);
            if (!name) return;
            const id = newId();
            void client.dispatch([{ type: 'folder.created', folder: { id, name } }]);
            setUi({ folderFilter: id });
            onRoute('backlog');
          }}
          onBlur={() => setAddingFolder(false)}
        />
      ) : (
        <button class="nav-item nav-sub nav-add" onClick={() => setAddingFolder(true)}><span>+ Add folder</span></button>
      )}
      <NavItem route="linear" current={route} onRoute={onRoute}>Linear</NavItem>
      <NavItem route="github" current={route} onRoute={onRoute}>GitHub</NavItem>
      <NavItem route="google" current={route} onRoute={onRoute}>Google</NavItem>
      <NavItem route="agents" current={route} onRoute={onRoute} badge={agents.attention}>Agents</NavItem>
      <NavItem route="archive" current={route} onRoute={onRoute} badge={archived}>Archive</NavItem>
      <NavItem route="stats" current={route} onRoute={onRoute}>Stats</NavItem>
      <div class="nav-spacer" />
      <TimerBar onRoute={onRoute} />
      <NavItem route="settings" current={route} onRoute={onRoute}>Settings</NavItem>
      <div class={`save-state${view.saving ? ' is-saving' : ''}`} aria-live="polite">{view.saving ? 'Saving…' : 'Saved'}</div>
    </nav>
  );
};

const PROBLEM_TEXT: Record<ServiceProblem, { title: string; body: string }> = {
  'not-approved': {
    title: 'Allow the Planner service',
    body: 'Planner keeps your plan in a small local service. Open Settings → Extensions, find Planner, and approve its requested access, then try again.',
  },
  disabled: { title: 'Planner is paused', body: 'Turn Planner back on in Settings → Extensions.' },
  failed: { title: 'The Planner service stopped', body: 'It crashed or did not start. Try again; if it keeps failing, check the OpenChamber server log.' },
  unavailable: { title: 'Planner is not reachable', body: 'The local service did not answer.' },
};

/** Shown until the first snapshot arrives, or when the service cannot answer. */
export const ServiceGate = () => {
  const { client } = usePlanner();
  const view = useView();
  if (!view.problem) return <div class="gate"><div class="spinner" aria-label="Loading planner" /></div>;
  const text = PROBLEM_TEXT[view.problem];
  return (
    <div class="gate" role="alert">
      <h2>{text.title}</h2>
      <p>{text.body}</p>
      {view.error && <p class="hint">{view.error}</p>}
      <button class="primary" onClick={() => void client.load()}>Try again</button>
    </div>
  );
};

/** Errors and the Undo offer share one toast slot; errors win. */
export const Toasts = () => {
  const { client } = usePlanner();
  const view = useView();
  if (!view.loaded) return null;
  if (view.error) {
    return (
      <div class="toast" role="alert">
        <span>{view.error}</span>
        <button class="link" onClick={() => client.dismissError()}>Dismiss</button>
      </div>
    );
  }
  if (view.undoLabel) {
    return (
      <div class="toast" role="status">
        <span>{view.undoLabel}</span>
        <button class="link" onClick={() => void client.undo()}>Undo</button>
      </div>
    );
  }
  return null;
};
