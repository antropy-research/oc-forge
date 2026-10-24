// Planner skeleton: every registered project with the live state of its
// sessions. Planning data (Today, Backlog, time blocks) arrives in later
// slices; this proves the package, its theme and its workspace subscriptions.
import { connectHost, type GuestProject, type GuestSessionRecord } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

// The host allows 32 subscriptions per frame; one goes to the project list.
const MAX_PROJECT_SUBSCRIPTIONS = 31;
const SESSIONS_PER_PROJECT = 8;

const host = connectHost();
const root = document.getElementById('root') as HTMLElement;
let projects: GuestProject[] = [];
let projectsState = 'loading';
let errorMessage = '';
const sessions = new Map<string, GuestSessionRecord[]>();
const releases = new Map<string, () => void>();

const isWaiting = (session: GuestSessionRecord) =>
  session.activity === 'waiting-question' || session.activity === 'waiting-permission';
const isRunning = (session: GuestSessionRecord) => session.activity === 'running' || session.activity === 'retrying';
// Subagent sessions belong to their parent's run, and archived ones are done with.
const isShown = (session: GuestSessionRecord) => !session.archivedAt && !session.parentId;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

// An idle session only says the agent stopped; it never marks planned work done.
const badgeFor = (session: GuestSessionRecord) => {
  if (isWaiting(session)) return el('span', session.activity, 'badge waiting');
  if (isRunning(session)) return el('span', session.activity, 'badge running');
  if (session.outcome === 'failed') return el('span', 'failed', 'badge failed');
  return el('span', session.activity, 'badge muted');
};

const render = () => {
  const shown = [...sessions.values()].flat().filter(isShown);
  const header = el('header');
  header.append(
    el('h1', 'Planner'),
    el('div', `${projects.length} projects · ${shown.filter(isRunning).length} running · ${shown.filter(isWaiting).length} waiting for you`, 'summary'),
  );
  if (projectsState !== 'ready') header.append(el('p', projectsState === 'error' ? 'Some projects are unavailable.' : 'Loading projects…', 'muted'));
  if (projects.length > MAX_PROJECT_SUBSCRIPTIONS) header.append(el('p', `Showing sessions for the first ${MAX_PROJECT_SUBSCRIPTIONS} projects.`, 'muted'));
  if (errorMessage) header.append(el('p', errorMessage, 'failed'));

  const blocks = projects.map((project) => {
    const block = el('section', undefined, 'project');
    block.append(el('h2', project.name), el('div', project.directory, 'muted'));
    const list = el('ul', undefined, 'sessions');
    const own = (sessions.get(project.id) ?? [])
      .filter(isShown)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SESSIONS_PER_PROJECT);
    for (const session of own) {
      const row = el('li');
      row.append(badgeFor(session), el('span', session.title));
      row.addEventListener('click', () => { void host.openSession(session.id).catch(report); });
      list.append(row);
    }
    if (own.length === 0) list.append(el('li', sessions.has(project.id) ? 'No sessions' : 'Loading sessions…', 'muted'));
    block.append(list);
    return block;
  });
  root.replaceChildren(header, ...blocks);
};

const report = (error: unknown) => {
  errorMessage = error instanceof Error ? error.message : String(error);
  render();
};

// Follow sessions of the listed projects; drop subscriptions of removed ones.
const syncSessionSubscriptions = async () => {
  const wanted = new Set(projects.slice(0, MAX_PROJECT_SUBSCRIPTIONS).map((project) => project.id));
  for (const [id, release] of releases) {
    if (wanted.has(id)) continue;
    release();
    releases.delete(id);
    sessions.delete(id);
  }
  for (const id of wanted) {
    if (releases.has(id)) continue;
    releases.set(id, () => {});
    const release = await host.onSessions(id, (snapshot) => {
      sessions.set(id, snapshot.sessions);
      render();
    });
    // The project may have disappeared while the host registered the subscription.
    if (releases.has(id)) releases.set(id, release);
    else release();
  }
};

host.onReady((ready) => {
  applyHostReady(ready, document.documentElement);
  render();
});

void host
  .onProjects((snapshot) => {
    projects = snapshot.projects;
    projectsState = snapshot.state;
    render();
    void syncSessionSubscriptions().catch(report);
  })
  .catch(report);
