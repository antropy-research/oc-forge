// Planner UI harness: the real OpenChamber host UI of the shared dev container
// (http://100.116.120.66:35310), with the Planner's panel bundle and service
// taken from YOUR worktree, so you can check a build without touching the
// shared container's extension folder or its Planner data.
//
// - panel/main.js and panel/styles.css are served from <worktree>/extensions/planner/panel/
//   (index.html still comes from the container, so do not change index.html).
// - The Planner's service requests go to a private copy of <worktree>/extensions/planner/service/main.js
//   that this harness starts on 127.0.0.1 with a temporary HOME and PLANNER_DATA_DIR (empty plan).
// - Linear (the host integration route) answers from an in-memory fixture world (`h.linear`), never a real workspace.
// - GitHub service paths answer from fixtures (`h.github`) unless you pass `serviceOverride`.
// - The Small Model (`/generate`) answers from `generate` (default: an empty JSON array).
// - Google: start tests/e2e/fakeGoogle.mjs and pass `serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base }` and
//   `homeFiles: { 'google-accounts.json': fake.accountsFile() }`; your service then signs in to the fake (see calendar.mjs).
//
// Usage (node >= 22, run on the host, from any checkout of this repository):
//   import { startHarness } from './harness.mjs';
//   const h = await startHarness({ out: '/tmp/opencode/<you>' });   // worktree: this checkout
//   await h.openPlanner();               // returns the Planner FrameLocator, also h.frame
//   await h.nav('Calendar').click();     // left navigation of the Planner page
//   await h.shot('calendar');            // <out>/calendar.png
//   await h.call('GET', '/state');       // talk to your private service directly
//   await h.close();
// Build first: (cd <worktree>/extensions/planner && bun run build).
// Never print the UI password. Anything you create through the host (chats, worktrees via
// startSession) is real in the shared container: prefix titles with `harness-` and delete them.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

/** A small Linear world: one workspace, four states, a team, issues, saved views, projects, members, labels. */
export const defaultLinearWorld = () => {
  const states = [
    { id: 'st-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
    { id: 'st-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
    { id: 'st-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    { id: 'st-review', name: 'In Review', type: 'started', color: '#0f783c', position: 3 },
    { id: 'st-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 4 },
    { id: 'st-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3', position: 5 },
  ];
  const team = { id: 'team-h', key: 'HAR', name: 'Harness Team' };
  const viewer = { id: 'u-h', name: 'Harness User' };
  const members = [{ id: 'u-h', name: 'Harness User', displayName: 'harness', active: true }, { id: 'u-mate', name: 'Teammate', displayName: 'mate', active: true }];
  const labels = [{ id: 'lbl-bug', name: 'Bug', color: '#eb5757' }, { id: 'lbl-feat', name: 'Feature', color: '#bb87fc' }];
  const issue = (n, title, stateId, extra = {}) => ({
    id: `iss-h-${n}`, identifier: `HAR-${n}`, title: `harness ${title}`, url: `https://linear.app/harness/issue/HAR-${n}/x`, priority: (n % 4) + 1, dueDate: null,
    branchName: `harness/har-${n}`, updatedAt: new Date(Date.now() - n * 3600_000).toISOString(), state: states.find((s) => s.id === stateId), team,
    assignee: viewer, project: { id: 'p1', name: 'Planner' }, cycle: null, assigned: true, description: `Issue ${n} description.\n\n- [ ] first\n- [x] second`,
    labels: { nodes: n % 2 ? [labels[0]] : [labels[1]] }, comments: { nodes: [] }, ...extra,
  });
  const issues = [
    issue(1, 'first', 'st-todo'), issue(2, 'second', 'st-prog'), issue(3, 'third', 'st-backlog'), issue(4, 'in review', 'st-review'),
    issue(5, 'finished', 'st-done'), issue(6, 'dropped', 'st-canceled'), issue(7, 'unassigned', 'st-todo', { assignee: null, assigned: false }),
  ];
  const view = (id, name, extra = {}) => ({ id, name: `harness ${name}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `slug-${id}`, updatedAt: new Date().toISOString(), team, owner: viewer, ...extra });
  const project = (id, name, statusType, extra = {}) => ({
    id, name, url: `https://linear.app/harness/project/${id}`, color: '#26b5ce', icon: null, description: `${name} in one line`, progress: 0.25, health: 'onTrack', priority: 2, startDate: '2026-10-01', targetDate: '2026-11-30',
    updatedAt: new Date().toISOString(), status: { id: `ps-${statusType}`, name: statusType === 'started' ? 'In Progress' : 'Planned', type: statusType, color: '#f2c94c' }, lead: viewer, teams: { nodes: [team] }, ...extra,
  });
  return {
    org: { id: 'org-h', name: 'Harness Org', urlKey: 'harness' }, viewer, states, teams: [team], issues, members, labels, workspaceLabels: [],
    projects: [project('p1', 'Planner', 'started')],
    views: [view('v-open', 'Open work'), view('v-done', 'Finished work'), view('v-proj', 'Projects view', { modelName: 'Project' })],
    favorites: [{ type: 'customView', sortOrder: 1, customView: { id: 'v-open' } }],
    // Which issues each saved view holds; a real saved view may hold completed issues.
    viewIssues: { 'v-open': { prefs: { layout: 'list', issueGrouping: 'workflowState', viewOrdering: 'priority' }, ids: ['iss-h-1', 'iss-h-2', 'iss-h-3', 'iss-h-4'] }, 'v-done': { prefs: { layout: 'list', issueGrouping: 'none', viewOrdering: 'updatedAt' }, ids: ['iss-h-5', 'iss-h-6'] } },
  };
};

/** The default GraphQL answers for the Planner's documents, by operation name; null when unknown. */
export const answerLinear = (o, op, variables = {}) => {
  const strip = ({ assigned, ...rest }) => rest;
  const open = (i) => !['completed', 'canceled'].includes(i.state.type);
  const find = (id) => o.issues.find((i) => i.id === id || i.identifier === id);
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  switch (op) {
    case 'PlannerWhoAmI': return { viewer: o.viewer, organization: o.org };
    case 'PlannerAssigned': return { viewer: { ...o.viewer, assignedIssues: page(o.issues.filter((i) => i.assigned && open(i)).map(strip)) } };
    case 'PlannerViews': return { customViews: page(o.views) };
    case 'PlannerFavoriteViews': return { favorites: { nodes: o.favorites } };
    case 'PlannerViewIssues': {
      const saved = o.viewIssues[variables.id];
      if (!o.views.some((v) => v.id === variables.id)) return { customView: null };
      return { customView: { id: variables.id, viewPreferencesValues: saved?.prefs ?? null, issues: page((saved?.ids ?? []).map(find).filter(Boolean).map(strip)) } };
    }
    case 'PlannerLinked': return { issues: { nodes: o.issues.filter((i) => (variables.ids ?? []).includes(i.id)).map(strip) } };
    case 'PlannerIssue': case 'PlannerIssueDetail': return { issue: find(variables.id) ? strip(find(variables.id)) : null };
    case 'PlannerTeamStates': return { team: { id: variables.id, states: { nodes: o.states } } };
    case 'PlannerTeams': return { viewer: { id: o.viewer.id }, teams: { nodes: o.teams } };
    case 'PlannerSearch': return { searchIssues: { nodes: o.issues.filter((i) => i.title.includes(variables.term ?? '')).map(strip) } };
    case 'PlannerProjects': return { projects: page(o.projects) };
    case 'PlannerTeamOptions': return { team: { id: variables.id, states: { nodes: o.states }, members: { nodes: o.members }, labels: { nodes: o.labels } }, issueLabels: { nodes: o.workspaceLabels } };
    case 'PlannerSetState': {
      const i = find(variables.id); const s = o.states.find((x) => x.id === variables.stateId);
      if (!i || !s) return null; i.state = s; return { issueUpdate: { success: true, issue: strip(i) } };
    }
    case 'PlannerUpdateIssue': {
      const i = find(variables.id); const input = variables.input ?? {};
      if (!i) return null;
      if ('stateId' in input) i.state = o.states.find((x) => x.id === input.stateId) ?? i.state;
      for (const f of ['title', 'description', 'priority', 'dueDate']) if (f in input) i[f] = input[f];
      if ('assigneeId' in input) i.assignee = input.assigneeId ? o.members.find((m) => m.id === input.assigneeId) ?? null : null;
      for (const id of input.addedLabelIds ?? []) if (!i.labels.nodes.some((l) => l.id === id)) i.labels.nodes.push(o.labels.find((l) => l.id === id));
      if (input.removedLabelIds) i.labels.nodes = i.labels.nodes.filter((l) => !input.removedLabelIds.includes(l.id));
      i.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: strip(i) } };
    }
    case 'PlannerAddComment': {
      const i = find(variables.input.issueId); if (!i) return null;
      const comment = { id: `c-${i.comments.nodes.length + 1}`, body: variables.input.body, createdAt: new Date().toISOString(), editedAt: null, user: { id: o.viewer.id, name: o.viewer.name }, botActor: null, parent: null };
      i.comments.nodes.push(comment); return { commentCreate: { success: true, comment } };
    }
    default: return null;
  }
};

export async function startHarness({
  worktree = resolve(import.meta.dirname, '../../../..'),
  out = '/tmp/opencode/planner-harness/out',
  base = 'http://100.116.120.66:35310',
  viewport = { width: 1440, height: 900 },
  linearWorld = defaultLinearWorld(),
  /** (op, variables, world) => data | undefined (undefined: use the default answer). */
  linear,
  /** ({ method, path, body }) => answer object | undefined (undefined: your private service answers). */
  serviceOverride,
  /** (request) => text the Small Model answers. */
  generate = () => '[]',
  timezoneId = 'America/Los_Angeles',
  /** Extra environment for your private service, e.g. PLANNER_GOOGLE_API_BASE from tests/e2e/fakeGoogle.mjs. */
  serviceEnv = {},
  /** Files written into the private service's temporary HOME before it starts, by path under HOME (e.g. 'google-accounts.json'). */
  homeFiles = {},
} = {}) {
  const planner = join(worktree, 'extensions/planner');
  for (const file of ['panel/main.js', 'service/main.js']) if (!existsSync(join(planner, file))) throw new Error(`build first: ${file} is missing`);
  mkdirSync(out, { recursive: true });
  const require = createRequire(join(planner, 'package.json'));
  const { chromium } = require('playwright-core');

  // The private service, with an empty plan in a temporary home.
  const home = mkdtempSync(join(tmpdir(), 'planner-harness-'));
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  // A gh that is not signed in, so GitHub never reaches a real account; override /github/* to fake data.
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: not logged in (planner harness)" >&2\nexit 4\n');
  chmodSync(join(bin, 'gh'), 0o755);
  for (const [path, text] of Object.entries(homeFiles)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text, { mode: 0o600 });
  }
  const child = spawn(process.execPath, [join(planner, 'service/main.js')], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TZ: process.env.TZ ?? '', LANG: 'C.UTF-8', OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, PLANNER_DATA_DIR: join(home, 'data'), ...serviceEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serviceLog = [];
  child.stdout.on('data', (d) => serviceLog.push(String(d)));
  child.stderr.on('data', (d) => serviceLog.push(String(d)));
  const serviceUrl = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${serviceUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await response.text();
    try { return { status: response.status, json: JSON.parse(text), text }; } catch { return { status: response.status, json: null, text }; }
  };
  for (let i = 0; ; i++) {
    try { const r = await call('GET', '/health'); if (r.status < 500) break; } catch {}
    if (i > 100) throw new Error(`service did not start:\n${serviceLog.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const secrets = readFileSync(join(homedir(), '.local/share/oc-forge-openchamber-dev/secrets.env'), 'utf8');
  const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)?.[1]?.trim();
  if (!password) throw new Error('no UI password in secrets.env');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, timezoneId });
  const login = await context.request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`);

  // Which extension each frame grant opens (the host mints one per frame).
  const grants = new Map();
  await context.route((url) => /^\/api\/guests\/[^/]+\/frame-grant$/.test(new URL(url).pathname), async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const response = await route.fetch();
    const json = await response.json().catch(() => null);
    if (json?.grant) grants.set(json.grant, id);
    await route.fulfill({ response, json });
  });
  // Your panel bundle and stylesheet, with the host's own headers.
  await context.route((url) => /\/api\/guest-files\/[^/]+\/panel\/(main\.js|styles\.css)$/.test(new URL(url).pathname), async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const original = await route.fetch();
    if (grants.get(parts[3]) !== 'oc-forge-planner') return route.fulfill({ response: original });
    await route.fulfill({ response: original, body: readFileSync(join(planner, 'panel', parts.at(-1))) });
  });

  const github = {
    status: { available: true, login: 'harness-user', message: null },
    issues: [], reviews: [], pulls: [],
  };
  const serviceCalls = [];
  await context.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/service/request', async (route) => {
    const outer = route.request().postDataJSON();
    const body = outer.body ? (() => { try { return JSON.parse(outer.body); } catch { return outer.body; } })() : undefined;
    serviceCalls.push({ method: outer.method, path: outer.path });
    const custom = serviceOverride ? await serviceOverride({ method: outer.method, path: outer.path, query: outer.query, body }) : undefined;
    if (custom !== undefined) return route.fulfill({ json: { status: custom.__status ?? 200, body: JSON.stringify(custom.__status ? custom.body : custom) } });
    if (outer.path === '/github/status') return route.fulfill({ json: { status: 200, body: JSON.stringify(github.status) } });
    const query = outer.query ? `?${new URLSearchParams(outer.query)}` : '';
    const answer = await call(outer.method, `${outer.path}${outer.path.includes('?') ? '' : query}`, outer.body);
    await route.fulfill({ json: { status: answer.status, body: answer.text } });
  });

  const linearCalls = [];
  await context.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/oauth/status', (route) => route.fulfill({ json: { connected: true, account: linearWorld.viewer.name, hasClient: true, settings: {}, redirectUri: '' } }));
  await context.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/request', async (route) => {
    const { query, variables = {} } = JSON.parse(route.request().postDataJSON().body);
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    linearCalls.push({ op, variables, query });
    const custom = linear ? await linear(op, variables, linearWorld) : undefined;
    const data = custom !== undefined ? custom : answerLinear(linearWorld, op, variables);
    await route.fulfill({ json: { status: 200, body: JSON.stringify(data ? { data } : { errors: [{ message: `harness: unexpected ${op}` }] }) } });
  });
  await context.route((url) => /\/api\/guests\/oc-forge-planner\/generate$/.test(new URL(url).pathname), async (route) => {
    const request = route.request().postDataJSON();
    route.fulfill({ json: { ok: true, result: { text: await generate(request) } } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.addLocatorHandler(page.getByText('OpenCode update'), async () => {
    await page.getByRole('button', { name: 'Dismiss' }).first().click({ timeout: 2000 }).catch(() => {});
  });
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`); });

  const frame = page.frameLocator('.inset-0 > iframe[title="Planner"]');
  const openPlanner = async () => {
    await page.goto(`${base}/`, { waitUntil: 'load' });
    const home = frame.getByRole('heading', { name: 'Home' });
    if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
      // OpenChamber 2.5.1 has a sidebar button per extension page; 2.5.2 lists them under "Extension pages".
      const button = page.locator('button[aria-label="Planner"]:not([data-context-surface])').first();
      if (await button.isVisible().catch(() => false)) await button.click();
      else {
        await page.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
        await page.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
      }
      await home.waitFor({ timeout: 30_000 });
    }
    return frame;
  };
  const nav = (name) => frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
  const close = async () => {
    // A route callback still forwarding a request (route.fetch) fails once the browser is gone; without this its
    // rejection is unhandled and ends the journey before it reports.
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await browser.close().catch(() => {});
    child.kill('SIGTERM');
  };
  return { page, context, browser, frame, openPlanner, nav, shot, call, linearWorld, linearCalls, serviceCalls, github, problems, serviceLog, home, close };
}
