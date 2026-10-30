// Sunsama's planning layout and assigning tasks to a chosen agent, in the dev
// container's real OpenChamber with this checkout's panel and service (harness.mjs).
// Run on the host after `bun run build`:
//   node extensions/planner/tests/e2e/sunsama.mjs [outDir]
// Google and the Linear workspace are fixtures, GitHub too but in its own part: the real gh against a fake GitHub
// (fakeGithub.mjs), at 1440 and 1024 (SUNSAMA_PARTS=github runs it alone); `opencode` is a stand-in
// that lists three models, and one custom agent sits in the private service's
// OpenCode config. The agent phases start real chats in /home/node/projects/planner-demo-a
// as OpenCode's read-only plan agent, through a command file this journey writes
// to the container (oc-planner-harness-plan.md) and removes, with the chats and
// their worktrees, at the end.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startHarness } from './harness.mjs';
import { defaultGithubWorld, fakeIssue, ghConfigFiles, startFakeGithub } from './fakeGithub.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-sunsama';
const run = `harness-${Date.now().toString(36)}`;
const CONTAINER = 'oc-forge-openchamber-dev';
const DEMO = '/home/node/projects/planner-demo-a';
const COMMAND_FILE = '/home/node/.config/opencode/command/oc-planner-harness-plan.md';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const docker = (script) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8' });

// Today and tomorrow where the browser is (the harness uses Los Angeles).
const zone = 'America/Los_Angeles';
const dayKey = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: zone });
const today = dayKey(0);
const tomorrow = dayKey(1);
const after = dayKey(2);
const ACCOUNT = 'harness@example.com';

const githubItem = (n, kind = 'issue') => ({
  id: `GH_${run}_${n}`, kind, repo: 'harness/app', number: n, key: `harness/app#${n}`, title: `${run} gh ${n}`, url: `https://github.com/harness/app/${kind === 'pull' ? 'pull' : 'issues'}/${n}`, state: 'OPEN', draft: false, updatedAt: new Date().toISOString(),
});
const gtask = (n) => ({ account: ACCOUNT, listId: 'list-h', id: `gt-${run}-${n}`, title: `${run} gtask ${n}`, notes: '', due: null, completed: false, parent: null, position: String(n).padStart(5, '0'), url: `https://tasks.google.com/task/${n}`, updated: new Date().toISOString() });
const mail = (n) => ({ account: ACCOUNT, id: `m-${run}-${n}`, threadId: `t-${n}`, subject: `${run} mail ${n}`, from: `"Harness Sender" <sender${n}@example.com>`, date: new Date(Date.now() - n * 3600_000).toISOString(), snippet: `Snippet of message ${n}`, unread: n % 2 === 1, url: `https://mail.google.com/mail/u/0/#inbox/m${n}` });
const fixtures = { github: [githubItem(1), githubItem(2), githubItem(3), githubItem(4, 'pull')], tasks: [1, 2, 3, 4].map(gtask), mail: [1, 2, 3, 4].map(mail) };

/** GitHub and Google answer from the fixtures; everything else reaches the private service. */
let realGitHubStatus = false;
const serviceOverride = async ({ method, path, body }) => {
  const url = new URL(path, 'http://x');
  // The private service's own answer, from the harness's gh that is not signed in.
  if (url.pathname === '/github/status' && realGitHubStatus) return (await h.call('GET', '/github/status')).json;
  if (url.pathname === '/github/list') return { items: url.searchParams.get('kind') === 'mine' ? fixtures.github.filter((item) => item.kind === 'pull') : fixtures.github.filter((item) => item.kind === 'issue') };
  if (url.pathname === '/github/items') return { items: fixtures.github.filter((item) => (body?.ids ?? []).includes(item.id)) };
  if (url.pathname === '/google/status') return { client: { id: 'harness-client' }, accounts: [{ email: ACCOUNT, features: ['tasks', 'mail'], addedAt: new Date().toISOString() }], timeboxError: null };
  if (url.pathname === '/google/tasklists') return { lists: [{ account: ACCOUNT, id: 'list-h', title: 'Harness list' }], errors: [] };
  if (url.pathname === '/google/tasks' && method === 'GET') return { tasks: fixtures.tasks };
  if (url.pathname === '/google/tasks' && method === 'PATCH') return { task: { ...fixtures.tasks.find((item) => item.id === body?.id), ...(body?.due !== undefined ? { due: body.due } : {}) } };
  if (url.pathname === '/google/tasks/linked') return { tasks: [], errors: [] };
  if (url.pathname === '/google/mail') return { messages: fixtures.mail };
  if (url.pathname === '/google/calendars') return { calendars: [], errors: [] };
  return undefined;
};

// ── Review 11 (P1-3): GitHub through the real gh, against a fake GitHub (fakeGithub.mjs), at 1440 and 1024 ──────
// 51 issues are assigned to me: the source shows 50, says so ("Showing 50 of 51") and Load more reaches the 51st,
// which plans as a task linked to it (its real id, title and URL); Refresh reads both pages again (not the first
// alone); the search field narrows the list. An issue's URL pasted alone into Add task (one not assigned to me) and a
// pull request's make tasks linked to them, as Sunsama's "Add via URL" does. SUNSAMA_PARTS=github runs this alone.
/** The GitHub CLI itself (never mise's shim, which wants a trusted folder; never the harness's signed-out stub). */
const realGh = () => {
  const candidates = [process.env.GH_BIN, '/home/qihang/.local/share/mise/installs/gh/latest/gh_2.103.3_linux_amd64/bin/gh', ...(process.env.PATH ?? '').split(':').filter((dir) => dir && !/mise\/shims|planner-harness-/.test(dir)).map((dir) => join(dir, 'gh'))];
  return candidates.find((path) => path && existsSync(path)) ?? null;
};
const githubPart = async (viewport) => {
  const size = String(viewport.width);
  const gh = realGh();
  if (!gh) {
    check(`${size}: the GitHub part has the GitHub CLI to run`, false, 'gh not found: set GH_BIN');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'planner-sunsama-gh-'));
  const repo = 'harness-org/planner-gh';
  const world = defaultGithubWorld({ owner: 'harness-org', repo: 'planner-gh' });
  // Issue 1 updated last: GitHub's search (updated, newest first) gives 1 to 50 a page, then 51.
  world.issues = Array.from({ length: 51 }, (_, n) => fakeIssue(repo, n + 1, { title: `${run} gh issue ${n + 1}`, assignees: [world.viewer], updatedAt: new Date(Date.now() - n * 60_000).toISOString() }));
  world.issues.push(fakeIssue(repo, 52, { title: `${run} gh unassigned 52`, assignees: ['someone-else'] }));
  world.pulls.push({ id: 'PR_planner_gh_7', number: 7, repo, url: `https://github.com/${repo}/pull/7`, title: `${run} gh pull 7`, body: '', headRefName: 'harness-feature', baseRefName: 'main', headOid: 'fake', isDraft: false, state: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewRequested: [world.viewer] });
  const fake = await startFakeGithub({ socket: join(dir, 'gh.sock'), world });
  const config = ghConfigFiles(fake.socket);
  // The private service's gh is the real one, its config sending every request to the fake's socket (nothing reaches GitHub).
  const g = await startHarness({
    out,
    viewport,
    serviceEnv: { PATH: `${dirname(gh)}:/usr/bin:/bin`, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
    homeFiles: { '.config/gh/config.yml': config['config.yml'], '.config/gh/hosts.yml': config['hosts.yml'] },
  });
  const f = g.frame;
  const plannerErrors = [];
  g.page.on('console', (message) => {
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  g.page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  const shotHere = async (name) => {
    await g.page.waitForTimeout(250);
    await g.shot(`${name}-${size}`);
  };
  const latestState = async () => (await g.call('GET', '/state')).json.state;
  const lists = () => fake.requests.filter((request) => request.operation === 'query PlannerGitHubList');
  const ghPanel = () => f.locator('aside.source-panel');
  const ghRow = (text) => ghPanel().locator('li.issue-row', { hasText: text }).first();
  const shown = () => ghPanel().locator('li.issue-row').count();
  const status = () => ghPanel().getByRole('status', { name: 'GitHub items shown' });
  try {
    await g.openPlanner();
    await f.getByRole('navigation', { name: 'Sources' }).getByRole('tab', { name: 'GitHub', exact: true }).click();
    await ghRow(`${run} gh issue 50`).waitFor({ timeout: 30_000 });
    check(`${size}: the GitHub source shows the first 50 of 51 assigned issues, and says so, with Load more`, (await shown()) === 50 && (await status().innerText()).includes('Showing 50 of 51') && (await ghPanel().getByRole('button', { name: 'Load more' }).count()) === 1, await status().innerText().catch(() => 'no count'));
    check(`${size}: read through the real gh: a page of 50, from the first`, lists().length >= 1 && lists()[0].variables?.after === undefined && /assignee:@me/.test(String(lists()[0].variables?.q)), JSON.stringify(lists().map((request) => request.variables)));
    await shotHere('gh-50-of-51');
    await ghPanel().getByRole('button', { name: 'Load more' }).click();
    await ghRow(`${run} gh issue 51`).waitFor({ timeout: 15_000 });
    const after = lists().at(-1)?.variables?.after;
    check(`${size}: Load more reads the next page from the first page's cursor, and shows the 51st`, (await shown()) === 51 && typeof after === 'string' && after.length > 0 && (await status().innerText()).includes('All 51 shown'), JSON.stringify({ after, shown: await shown() }));
    // Planned from the source: a task linked to issue 51, its real id, title and URL.
    await ghRow(`${run} gh issue 51`).hover();
    await ghRow(`${run} gh issue 51`).getByRole('button', { name: new RegExp(`^Plan ${repo}#51 `) }).first().click();
    const issue51 = world.issues[50];
    let latest = null;
    for (let i = 0; i < 50; i++) {
      latest = await latestState();
      if (Object.values(latest.tasks).some((task) => task.source?.id === issue51.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const planned = Object.values(latest.tasks).find((task) => task.source?.id === issue51.id);
    check(`${size}: the 51st plans as a task linked to it: its real id, title and URL`, planned?.title === issue51.title && planned.source.kind === 'github' && planned.source.key === `${repo}#51` && planned.source.url === issue51.url, JSON.stringify(planned?.source ?? null));
    await shotHere('gh-51-planned');
    // Refresh reads both pages again: the 51st stays reachable.
    const before = lists().length;
    await ghPanel().getByRole('button', { name: 'Refresh GitHub' }).click();
    for (let i = 0; i < 50 && lists().length < before + 2; i++) await new Promise((resolve) => setTimeout(resolve, 200));
    const again = lists().slice(before).map((request) => request.variables?.after ?? null);
    check(`${size}: Refresh reads both pages again, from the first, not the first alone; the 51st is still there`, again.length === 2 && again[0] === null && again[1] === after && (await shown()) === 51, JSON.stringify(again));
    // Words narrow it (GitHub's search syntax).
    await ghPanel().getByRole('searchbox', { name: 'Search GitHub items' }).fill(`${run} gh issue 51`);
    for (let i = 0; i < 50 && (await shown()) !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 200));
    check(`${size}: the search field narrows the list (sent to GitHub's search)`, (await shown()) === 1 && (await ghRow(`${run} gh issue 51`).count()) === 1 && String(lists().at(-1)?.variables?.q).endsWith(`${run} gh issue 51`), String(lists().at(-1)?.variables?.q));
    await ghPanel().getByRole('searchbox', { name: 'Search GitHub items' }).fill('');

    // Pasted alone into Add task: issue 52 (not assigned to me, so in no list) and pull request 7, as Sunsama imports them.
    const today = f.locator('section.day-column[aria-label^="Today"]').first();
    for (const [url, item, kind] of [[world.issues[51].url, world.issues[51], 'issue'], [world.pulls[0].url, world.pulls[0], 'pull request']]) {
      await today.getByRole('button', { name: 'Add task' }).click();
      const field = today.getByRole('textbox', { name: 'New task' });
      await field.fill(url);
      const hint = await today.locator('.url-hint').innerText().catch(() => '');
      check(`${size}: a pasted ${kind} URL says Enter imports it`, hint === `Enter imports the GitHub ${kind} ${repo}#${item.number}`, hint);
      await shotHere(`gh-paste-${kind === 'issue' ? 'issue' : 'pull'}`);
      await field.press('Enter');
      let task = null;
      for (let i = 0; i < 50 && !task; i++) {
        task = Object.values((await latestState()).tasks).find((one) => one.source?.id === item.id) ?? null;
        if (!task) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      check(`${size}: Enter makes a task linked to the ${kind}: its real id, title and URL (not a task titled with the URL)`, task?.title === item.title && task.source.kind === 'github' && task.source.url === item.url && task.source.key === `${repo}#${item.number}`, JSON.stringify(task ? { title: task.title, source: task.source } : null));
      await field.press('Escape').catch(() => {});
    }
    check(`${size}: the paste was looked up on GitHub by its URL`, fake.requests.filter((request) => request.operation === 'query PlannerGitHubResource').map((request) => request.variables?.url).join() === `${world.issues[51].url},${world.pulls[0].url}`);
    await shotHere('gh-paste-tasks');
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the GitHub part ran to its end`, false, error?.stack ?? String(error));
    await shotHere('gh-failure').catch(() => {});
  } finally {
    await g.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const parts = process.env.SUNSAMA_PARTS ?? 'all';
mkdirSync(out, { recursive: true });
if (parts === 'all' || parts === 'github') for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await githubPart(viewport);
if (parts === 'github') {
  const failed = results.filter((result) => !result.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

mkdirSync(out, { recursive: true });
let h = null;
h = await startHarness({ out, serviceOverride });
const { page, frame } = h;

// `opencode` where the private service runs: OpenCode's background server is "stopped", three models.
writeFileSync(join(h.home, 'bin', 'opencode'), `#!/bin/sh
case "$1" in
  service) echo stopped ;;
  models) printf 'anthropic/claude-sonnet-5-5\\nopenai/gpt-6\\nopencode/big-pickle\\n' ;;
  *) echo "harness opencode: $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(h.home, 'bin', 'opencode'), 0o755);
mkdirSync(join(h.home, '.config', 'opencode', 'agent'), { recursive: true });
writeFileSync(join(h.home, '.config', 'opencode', 'agent', 'harness-reviewer.md'), '---\ndescription: Reviews pull requests for the harness\ncolor: "#aa3355"\n---\nYou review pull requests.\n');

const state = async () => (await h.call('GET', '/state')).json.state;
/** A file's text once it is there (or '' once it is gone), within ten seconds. */
const waitForFile = async (file, present) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (Boolean(text) === present) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const commands = (list) => h.call('POST', '/commands', { commands: list.map((body, index) => ({ cmd: `${run}-${Date.now().toString(36)}-${index}`, ...body })) });
const waitFor = async (test, timeout = 15_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const latest = await state();
    if (test(latest) || Date.now() > until) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};
const taskBy = (latest, test) => Object.values(latest.tasks).find((task) => !task.deletedAt && test(task));
const bySource = (latest, key) => taskBy(latest, (task) => task.source?.key === key || task.source?.id === key);
const placedOn = (task) => (task?.placement.kind === 'day' ? task.placement.date : task?.placement.kind ?? 'missing');
const column = (label) => frame.locator(`section.day-column[aria-label^="${label}"]`).first();
const rail = () => frame.getByRole('navigation', { name: 'Sources' });
const railTab = (name) => rail().getByRole('tab', { name, exact: true });
const panel = () => frame.locator('aside.source-panel');
const shot = async (name) => {
  await page.waitForTimeout(250);
  await h.shot(name);
};
// The command the agent phases start chats with, in the container's OpenCode config; the
// only file this journey writes there, removed at the end (with its folder, if it made it).
const commandDirExisted = docker('test -d /home/node/.config/opencode/command && echo yes || echo no').trim() === 'yes';
execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', `mkdir -p /home/node/.config/opencode/command && cat > ${COMMAND_FILE}`], {
  input: '---\n# Written by the OpenChamber Planner (preset); it rewrites and removes this file.\ndescription: "Planner: a task assigned to Harness plan"\nagent: "plan"\n---\n$ARGUMENTS\n',
});
/**
 * The command file is in place; OpenChamber's OpenCode reloads commands 100 ms after a change.
 * (Asking OpenCode with the `opencode` CLI would start its background server in the container,
 * which is not OpenChamber's, so the journey only waits; the chats' own messages are the check.)
 */
const commandListed = () => {
  const there = docker(`test -f ${COMMAND_FILE} && grep -c '^agent: "plan"$' ${COMMAND_FILE} || echo 0`).trim() === '1';
  execFileSync('sleep', ['1']);
  return there;
};

/** What OpenCode recorded for a run's chat: the agents its turns ran as, and the first user text. */
const agentOf = async (runRecord, timeout = 90_000) => {
  const until = Date.now() + timeout;
  let note = '';
  for (;;) {
    if (runRecord?.sessionId) {
      const directory = runRecord.worktree?.directory ?? runRecord.directory ?? '';
      const response = await h.context.request.get(`http://100.116.120.66:35310/api/session/${runRecord.sessionId}/message?directory=${encodeURIComponent(directory)}`);
      const body = await response.json().catch(() => null);
      const items = (Array.isArray(body) ? body : body?.data ?? []).map((item) => item.info ?? item);
      const agents = [...new Set(items.filter((item) => (item.type === 'assistant' || item.type === 'agent-switched' || item.role === 'assistant') && item.agent).map((item) => item.agent))];
      const user = items.find((item) => item.type === 'user' || item.role === 'user');
      const userText = String(user?.text ?? '');
      const failed = items.find((item) => item.type === 'assistant' && item.error);
      note = `${items.length} messages${failed ? `; the model said: ${JSON.stringify(failed.error).slice(0, 100)}` : ''}`;
      if (items.some((item) => item.type === 'assistant')) return { agents, userText, rawCommand: userText.startsWith('/oc-planner-'), note };
    }
    if (Date.now() > until) return { agents: [], userText: '', rawCommand: false, note: note || 'no session' };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

/** The chats (the agents' and the empty ones that made their worktrees), worktrees and branches the agent phases made, and the command file. */
const cleanUp = async () => {
  const base = 'http://100.116.120.66:35310';
  try {
    const latest = await state();
    const chats = new Map();
    for (const record of Object.values(latest.runs ?? {})) {
      const directory = record.worktree?.directory ?? record.directory ?? '';
      chats.set(record.sessionId, directory);
      // Every chat in a harness worktree is the journey's own.
      if (/\/planner-harness-/.test(record.worktree?.directory ?? '')) {
        const listed = await h.context.request.get(`${base}/api/session?directory=${encodeURIComponent(directory)}`).then((response) => response.json()).catch(() => null);
        // The list can hold other folders' chats; only the ones in this very worktree go.
        for (const session of (Array.isArray(listed) ? listed : listed?.data ?? [])) {
          const folder = session?.directory ?? session?.location?.directory;
          if (session?.id && folder === directory && /^(PLN-|HAR-|harness\/)/.test(session.title ?? '')) chats.set(session.id, directory);
        }
      }
    }
    for (const [id, directory] of chats) {
      const response = await h.context.request.delete(`${base}/api/session/${id}?directory=${encodeURIComponent(directory)}`).catch(() => null);
      console.log(`INFO deleted chat ${id}: ${response?.status() ?? 'failed'}`);
    }
  } catch (error) {
    console.log(`INFO chat cleanup: ${String(error).split('\n')[0]}`);
  }
  for (const project of [DEMO, DEMO.replace(/-a$/, '-b')]) {
    try {
      docker(`cd ${project} && git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\\/heads\\/planner\\/harness-/{print w}' | while read w; do git worktree remove --force "$w"; done; git worktree prune; git branch --list 'planner/harness-*' | xargs -r git branch -D >/dev/null; true`);
      console.log(`INFO ${project}: ${docker(`cd ${project} && git worktree list | wc -l`).trim()} worktree(s), ${docker(`cd ${project} && git branch --list 'planner/harness-*' | wc -l`).trim()} harness branch(es) left`);
    } catch (error) {
      console.log(`INFO worktree cleanup in ${project}: ${String(error).split('\n')[0]}`);
    }
  }
  docker(`rm -f ${COMMAND_FILE}${commandDirExisted ? '' : '; rmdir /home/node/.config/opencode/command 2>/dev/null || true'}`);
  console.log(`INFO command file removed: ${docker(`test -e ${COMMAND_FILE} && echo still there || echo yes`).trim()}`);
};


try {
  // The preset "Harness plan" names the command written into the container for the agent phases.
  await commands([
    { type: 'settings.updated', patch: { agentPresets: [{ id: 'harness-plan', name: 'Harness plan', agent: 'plan', model: null }, { id: 'build-claude-h1', name: 'Build · Claude', agent: 'build', model: 'anthropic/claude-sonnet-5-5' }] } },
    ...['assign', 'menu', 'hello'].map((name, index) => ({ type: 'task.created', task: { id: `${run.replace(/[^a-z0-9]/g, '')}${index}`, title: `${run} ${name}`, placement: { kind: 'day', date: today }, position: 100 + index } })),
  ]);
  check('the container has /oc-planner-harness-plan, naming the plan agent', commandListed());
  await h.openPlanner();

  // Phase 1: Home has the day columns, the panel and its icon rail.
  const tabs = await rail().getByRole('tab').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('Home shows the sources rail: Calendar, Backlog, Linear, GitHub, Gmail, Google Tasks', tabs.join('|') === 'Calendar|Backlog|Linear|GitHub|Gmail|Google Tasks', tabs.join('|'));
  check('the panel opens on the calendar beside the day columns', (await panel().getAttribute('aria-label')) === 'Calendar' && (await frame.locator('.sunsama-layout .board section.day-column').count()) === 7);
  await shot('01-home-calendar');

  await railTab('Linear').click();
  await panel().locator('li.issue-row').first().waitFor();
  await shot('02-home-linear');

  // Drag each source's items onto tomorrow's column and onto today's.
  const row = (text) => panel().locator('li.issue-row', { hasText: text }).first();
  const dropOn = async (text, day) => {
    await row(text).dragTo(column(day === today ? 'Today' : 'Tomorrow').locator('ul.task-list'));
  };
  await dropOn('HAR-1', tomorrow);
  await dropOn('HAR-2', today);
  let latest = await waitFor((s) => placedOn(bySource(s, 'HAR-1')) === tomorrow && placedOn(bySource(s, 'HAR-2')) === today);
  check('a Linear issue dragged onto tomorrow and one onto today land there', placedOn(bySource(latest, 'HAR-1')) === tomorrow && placedOn(bySource(latest, 'HAR-2')) === today, `${placedOn(bySource(latest, 'HAR-1'))}, ${placedOn(bySource(latest, 'HAR-2'))}`);

  await railTab('GitHub').click();
  await row(`${run} gh 1`).waitFor();
  await dropOn(`${run} gh 1`, tomorrow);
  await dropOn(`${run} gh 2`, today);
  latest = await waitFor((s) => placedOn(bySource(s, 'harness/app#1')) === tomorrow && placedOn(bySource(s, 'harness/app#2')) === today);
  check('a GitHub issue dragged onto tomorrow and one onto today land there', placedOn(bySource(latest, 'harness/app#1')) === tomorrow && placedOn(bySource(latest, 'harness/app#2')) === today, `${placedOn(bySource(latest, 'harness/app#1'))}, ${placedOn(bySource(latest, 'harness/app#2'))}`);

  await railTab('Gmail').click();
  await row(`${run} mail 1`).waitFor();
  await dropOn(`${run} mail 1`, tomorrow);
  await dropOn(`${run} mail 2`, today);
  const titled = (s, title) => taskBy(s, (task) => task.title === title);
  latest = await waitFor((s) => placedOn(titled(s, `${run} mail 1`)) === tomorrow && placedOn(titled(s, `${run} mail 2`)) === today);
  check('a Gmail message dragged onto tomorrow and one onto today become tasks there', placedOn(titled(latest, `${run} mail 1`)) === tomorrow && titled(latest, `${run} mail 1`)?.source?.kind === 'email' && placedOn(titled(latest, `${run} mail 2`)) === today);

  await railTab('Google Tasks').click();
  await row(`${run} gtask 1`).waitFor();
  await dropOn(`${run} gtask 1`, tomorrow);
  await dropOn(`${run} gtask 2`, today);
  latest = await waitFor((s) => placedOn(titled(s, `${run} gtask 1`)) === tomorrow && placedOn(titled(s, `${run} gtask 2`)) === today);
  check('a Google task dragged onto tomorrow and one onto today land there', placedOn(titled(latest, `${run} gtask 1`)) === tomorrow && titled(latest, `${run} gtask 1`)?.source?.kind === 'gtask' && placedOn(titled(latest, `${run} gtask 2`)) === today);
  await shot('03-home-dragged');

  // A row's quick actions offer the days on screen: the menu lists every visible column.
  await railTab('Linear').click();
  await row('HAR-3').getByRole('button', { name: 'More days for HAR-3' }).click();
  const dayMenu = frame.getByRole('menu', { name: 'Plan HAR-3 on' });
  const menuDays = await dayMenu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.textContent));
  await shot('04-plan-menu');
  const afterLabel = new Date(`${after}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).replace(/^(\w+), /, '$1, ');
  await dayMenu.getByRole('menuitem', { name: `Plan HAR-3 on ${afterLabel}` }).click();
  latest = await waitFor((s) => placedOn(bySource(s, 'HAR-3')) === after);
  check("a row's day menu lists the visible days and plans on the one picked", menuDays.length >= 8 && placedOn(bySource(latest, 'HAR-3')) === after, `${menuDays.length} items; HAR-3 on ${placedOn(bySource(latest, 'HAR-3'))}`);

  // The panel folds down to the rail and comes back; the open source's tab keeps it open.
  await railTab('Linear').click();
  const kept = (await panel().getAttribute('aria-label')) === 'Linear';
  await panel().getByRole('button', { name: 'Close the panel' }).click();
  const folded = kept && (await panel().count()) === 0 && (await rail().isVisible());
  await shot('05-home-folded');
  await rail().getByRole('button', { name: 'Show the panel' }).click();
  check('the panel folds to its rail and the rail brings it back', folded && (await panel().getAttribute('aria-label')) === 'Linear');

  // The calendar under the list: an issue dropped on a time is planned and timeboxed.
  await panel().getByRole('button', { name: 'Calendar below' }).click();
  const lane = panel().locator(`div.day-lane[data-date="${today}"]`);
  await lane.waitFor();
  await row('HAR-4').dragTo(lane, { targetPosition: { x: 30, y: 10 * 48 + 4 } });
  latest = await waitFor((s) => Object.values(s.blocks).some((block) => block.taskId === bySource(s, 'HAR-4')?.id));
  const boxed = Object.values(latest.blocks).find((block) => block.taskId === bySource(latest, 'HAR-4')?.id);
  check('with the calendar under the list, an issue dropped on a time is planned today and timeboxed', placedOn(bySource(latest, 'HAR-4')) === today && Boolean(boxed), boxed ? new Date(boxed.start).toLocaleTimeString('en-US', { timeZone: zone }) : 'no session');
  await shot('06-split-calendar');
  await panel().getByRole('button', { name: 'Calendar below' }).click();

  // Phase 2: Today has the same panel and rail.
  await h.nav('Today').click();
  await frame.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
  check('Today has the same rail and panel', (await rail().getByRole('tab').count()) === 6 && (await panel().getAttribute('aria-label')) === 'Linear');
  await railTab('Gmail').click();
  await row(`${run} mail 3`).waitFor();
  await shot('07-today-gmail');

  // Phase 3: daily planning for tomorrow collects from Gmail and Google Tasks onto tomorrow.
  await h.nav('Daily planning').click();
  await frame.getByRole('tablist', { name: 'Planning day' }).getByRole('tab', { name: 'Tomorrow' }).click();
  await frame.getByRole('button', { name: 'Next', exact: true }).click();
  const sources = frame.locator('aside.ritual-aside');
  const sourceTabs = await sources.getByRole('tablist', { name: 'Sources' }).getByRole('tab').evaluateAll((items) => items.map((item) => item.textContent));
  check('daily planning collects from Gmail and Google Tasks too', sourceTabs.includes('Gmail') && sourceTabs.includes('Google Tasks'), sourceTabs.join(', '));
  await sources.getByRole('tab', { name: 'Gmail' }).click();
  await sources.locator('li.issue-row', { hasText: `${run} mail 3` }).getByRole('button', { name: `Plan ${run} mail 3 tomorrow` }).click();
  await shot('08-planning-gmail');
  await sources.getByRole('tab', { name: 'Google Tasks' }).click();
  await sources.locator('li.issue-row', { hasText: `${run} gtask 3` }).getByRole('button', { name: `Plan ${run} gtask 3 tomorrow` }).click();
  latest = await waitFor((s) => placedOn(titled(s, `${run} mail 3`)) === tomorrow && placedOn(titled(s, `${run} gtask 3`)) === tomorrow);
  check('in daily planning for tomorrow, a message and a Google task are planned onto tomorrow', placedOn(titled(latest, `${run} mail 3`)) === tomorrow && placedOn(titled(latest, `${run} gtask 3`)) === tomorrow, `${placedOn(titled(latest, `${run} mail 3`))}, ${placedOn(titled(latest, `${run} gtask 3`))}`);
  await shot('09-planning-tasks');

  // Phase 4: the assignee picker in the task detail, as GitHub's and Linear's.
  const sent = [];
  // Every request that starts a command, or names one: the host's requests to OpenCode, whatever the frame.
  const capture = (request) => {
    if (request.method() !== 'POST') return;
    const body = request.postData() ?? '';
    if (/\/command$/.test(new URL(request.url()).pathname) || body.includes('oc-planner-')) sent.push({ url: request.url(), body });
  };
  page.on('request', capture);
  // The run can be adopted from the session list before OpenChamber sends the first message.
  const sentMatching = async (test, timeout = 60_000) => {
    const until = Date.now() + timeout;
    while (!sent.some(test) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
    return sent.find(test);
  };
  await h.nav('Home').click();
  const card = (title) => column('Today').locator('li.task-card', { hasText: title });
  await card(`${run} assign`).getByRole('button', { name: `Open ${run} assign` }).click();
  const detail = frame.getByRole('dialog', { name: 'Task details' });
  await detail.getByRole('button', { name: 'Assign to an agent' }).click();
  const picker = frame.getByRole('dialog', { name: 'Assign to an agent' });
  const group = (name) => picker.getByRole('group', { name }).getByRole('option');
  await group('Agents').first().waitFor();
  const names = async (name) => group(name).evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  const presetsShown = await names('Presets');
  const agentsShown = await names('Agents');
  check('the picker lists the presets, then OpenCode\'s agents (built in and from its config)', presetsShown.join('|') === 'Harness plan|Build · Claude' && agentsShown.join('|') === 'Build|Plan|Harness-reviewer', `${presetsShown.join(', ')} / ${agentsShown.join(', ')}`);
  check('it has a search box, avatars and no assignee checked yet', (await picker.getByRole('combobox', { name: 'Search agents' }).getAttribute('placeholder')) === 'Assign to…' && (await picker.locator('.avatar').count()) >= 5 && (await picker.locator('[role="option"][aria-selected="true"]').count()) === 0);
  await shot('10-picker');
  const search = picker.getByRole('combobox', { name: 'Search agents' });
  await search.fill('plan');
  const planOnly = await picker.getByRole('listbox').getByRole('option').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('search narrows to the matching presets and agents', planOnly.join('|') === 'Harness plan|Plan', planOnly.join(', '));
  await shot('11-picker-search');
  await search.fill('gpt');
  const modelRows = await names('Models');
  check('typing a model offers an agent on it, to keep as a preset', modelRows.join('|') === 'Build · gpt-6', modelRows.join(', '));
  await shot('12-picker-models');
  // The demo project, so the worktree lands where the cleanup looks.
  await picker.getByRole('combobox', { name: 'Agent project' }).selectOption({ label: 'planner-demo-a' }).catch(() => {});
  await search.fill('harness pl');
  await search.press('ArrowDown');
  await search.press('ArrowUp');
  const activeName = await picker.locator('[role="option"].is-active').getAttribute('aria-label');
  await search.press('Enter');
  check('arrows move through the list and Enter picks', activeName === 'Harness plan' && (await picker.count()) === 0, activeName);
  latest = await waitFor((s) => Object.values(s.runs).some((r) => r.taskId === titled(s, `${run} assign`)?.id), 240_000);
  const assigned = Object.values(latest.runs).find((r) => r.taskId === titled(latest, `${run} assign`)?.id);
  check('the run keeps its assignee, works in a new worktree and expects a pull request', assigned?.assignee?.id === 'harness-plan' && assigned.assignee.agent === 'plan' && assigned.wantsPr === true && /^planner\/harness-/.test(assigned.worktree?.branch ?? ''), JSON.stringify({ assignee: assigned?.assignee, branch: assigned?.worktree?.branch }));
  const first = await sentMatching((request) => /oc-planner-harness-plan/.test(request.body));
  const firstBody = first ? JSON.parse(first.body) : null;
  check(
    'the chat starts with /oc-planner-harness-plan and the assignment as its arguments (OpenCode\'s command route)',
    Boolean(first) && new URL(first.url).pathname.endsWith('/command') && (firstBody?.name ?? firstBody?.command) === 'oc-planner-harness-plan' && String(firstBody?.text ?? firstBody?.arguments ?? '').includes('gh pr create'),
    first ? `${new URL(first.url).pathname} ${JSON.stringify(firstBody).slice(0, 160)}` : `no request named the command (${sent.length} requests)`,
  );
  await detail.locator('li.run-row').first().waitFor();
  await shot('13-detail-assigned');
  await detail.getByRole('button', { name: 'Assign to an agent' }).click();
  const checkedNow = await picker.locator('[role="option"][aria-selected="true"]').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  check('the task detail shows the assignee, and the picker checks it', (await detail.locator('.assignee-field').innerText()).includes('Harness plan') && checkedNow.join('|') === 'Harness plan', checkedNow.join(', '));
  await search.press('Escape');
  await detail.getByRole('button', { name: 'Close' }).click();
  check('the card shows the assignee', (await card(`${run} assign`).locator('.agent-chip .avatar').innerText().catch(() => '')) === 'HP');
  await shot('14-card-assignee');

  // The session ran as OpenCode's plan agent: OpenChamber's own record of its messages.
  const ranAs = await agentOf(assigned);
  check('OpenCode ran the assignment as the plan agent', ranAs.agents.includes('plan') && !ranAs.rawCommand, `agents ${ranAs.agents.join(', ') || 'none yet'}; first user text: ${ranAs.userText.slice(0, 60)}`);

  // Phase 5: the same picker in place from a card's menu and from an issue row.
  await card(`${run} menu`).hover();
  await card(`${run} menu`).getByRole('button', { name: 'Task actions' }).click();
  await card(`${run} menu`).getByRole('menuitem', { name: 'Assign to an agent…' }).click();
  await picker.getByRole('group', { name: 'Agents' }).waitFor();
  check('the card menu opens the picker on the card, with the project to work in', (await picker.locator('.assignee-footer').innerText()).includes('planner-demo-a') || (await picker.getByRole('combobox', { name: 'Agent project' }).count()) === 1);
  await shot('15-card-menu-picker');
  await picker.getByRole('combobox', { name: 'Search agents' }).press('Escape');
  await railTab('GitHub').click();
  await row(`${run} gh 3`).getByRole('button', { name: 'Assign harness/app#3 to an agent' }).click();
  await picker.getByRole('group', { name: 'Agents' }).waitFor();
  const box = await picker.boundingBox();
  const pane = await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  const inside = Boolean(box && pane) && box.x >= pane.x && box.x + box.width <= pane.x + pane.width && box.y >= pane.y && box.y + box.height <= pane.y + pane.height + 1;
  check('an issue row opens it too, whole inside the Planner', inside, box ? `${Math.round(box.x - pane.x)},${Math.round(box.y - pane.y)} ${Math.round(box.width)}x${Math.round(box.height)} in ${Math.round(pane.width)}x${Math.round(pane.height)}` : 'not shown');
  await shot('16-row-picker');
  await picker.getByRole('combobox', { name: 'Search agents' }).press('Escape');

  // Phase 6: "/oc-planner-harness-plan hello" through the options form, checked in OpenCode's messages.
  await card(`${run} hello`).getByRole('button', { name: `Open ${run} hello` }).click();
  await detail.getByRole('button', { name: 'Assign with options…' }).click();
  const form = detail.getByRole('group', { name: 'Assign to an agent' });
  await form.getByRole('combobox', { name: 'Agent project' }).selectOption({ label: 'planner-demo-a' });
  await form.getByRole('button', { name: 'Agent' }).click();
  await frame.getByRole('dialog', { name: 'Choose the agent' }).getByRole('option', { name: 'Harness plan' }).click();
  await form.getByRole('button', { name: 'Edit the instructions' }).click();
  await form.getByRole('textbox', { name: 'Agent prompt' }).fill('hello');
  await shot('17-options-form');
  await form.getByRole('button', { name: 'Assign', exact: true }).click();
  latest = await waitFor((s) => Object.values(s.runs).some((r) => r.taskId === titled(s, `${run} hello`)?.id), 240_000);
  const hello = Object.values(latest.runs).find((r) => r.taskId === titled(latest, `${run} hello`)?.id);
  const helloSent = await sentMatching((request) => request !== first && /oc-planner-harness-plan/.test(request.body));
  const helloBody = helloSent ? JSON.parse(helloSent.body) : null;
  check('the form sends /oc-planner-harness-plan hello', (helloBody?.name ?? helloBody?.command) === 'oc-planner-harness-plan' && (helloBody?.text ?? helloBody?.arguments) === 'hello', JSON.stringify(helloBody).slice(0, 120));
  const helloRan = await agentOf(hello);
  check('OpenChamber\'s API shows the hello turn ran as the plan agent', helloRan.agents.includes('plan') && helloRan.userText.trim() === 'hello', `agents ${helloRan.agents.join(', ') || 'none'}; user text "${helloRan.userText.slice(0, 40)}"; ${helloRan.note}`);
  await detail.getByRole('button', { name: 'Close' }).click();

  // The Agents page groups the runs and shows who each was assigned to.
  await h.nav('Agents').click();
  await frame.locator('li.agent-task', { hasText: `${run} hello` }).waitFor();
  const filter = frame.getByRole('combobox', { name: 'Show runs of' });
  check('the Agents page shows each run\'s assignee, and filters by it', (await frame.locator('li.agent-task', { hasText: `${run} hello` }).locator('.assignee-chip').innerText()).includes('Harness plan') && (await filter.locator('option').count()) >= 2);
  await shot('18-agents-page');

  // Phase 7: Settings → Agents names presets; the service keeps one command file per preset.
  await h.nav('Settings').click();
  const agentSettings = frame.getByRole('group', { name: 'Agents' });
  await agentSettings.scrollIntoViewIfNeeded();
  const newPreset = agentSettings.getByRole('group', { name: 'New agent preset' });
  await newPreset.getByRole('combobox', { name: 'Preset agent' }).selectOption('plan');
  await newPreset.getByRole('combobox', { name: 'Preset model' }).selectOption('openai/gpt-6');
  await newPreset.getByRole('button', { name: 'Add preset' }).click();
  latest = await waitFor((s) => s.settings.agentPresets.some((preset) => preset.name === 'Plan · gpt-6'));
  const added = latest.settings.agentPresets.find((preset) => preset.name === 'Plan · gpt-6');
  const commandPath = (id) => join(h.home, '.config', 'opencode', 'command', `oc-planner-${id}.md`);
  const written = added ? await waitForFile(commandPath(added.id), true) : '';
  check('a preset made in Settings → Agents becomes an OpenCode command naming its agent and model', /^agent: "plan"$/m.test(written) && /^model: "openai\/gpt-6"$/m.test(written) && written.trim().endsWith('$ARGUMENTS'), added ? `oc-planner-${added.id}` : 'no preset');
  await shot('19-settings-agents');
  await agentSettings.getByRole('button', { name: 'Remove the preset Plan · gpt-6' }).click();
  check('removing the preset removes its command', added ? (await waitForFile(commandPath(added.id), false)) === '' : false);

  // Phase 8: gh not signed in: the GitHub source says how to sign in, not an empty list.
  realGitHubStatus = true;
  await h.openPlanner();
  await railTab('GitHub').click();
  const signIn = panel().getByRole('status', { name: 'GitHub sign-in' });
  await signIn.waitFor();
  const said = await signIn.innerText();
  check('with gh signed out, the GitHub source shows where to run gh auth login', said.includes('Sign in to GitHub') && said.includes('gh auth login') && (await signIn.getByRole('button', { name: 'Copy' }).count()) === 1, said.replace(/\s+/g, ' ').slice(0, 140));
  await shot('20-github-signin');
  realGitHubStatus = false;

  // Phase 9: a narrow page, OpenChamber's own sidebar open in a 1024×768 window. The menu folds into a rail and opens
  // over the page; Home's header stays whole; a source stays open beside a whole day, and dragging to the board's
  // edge scrolls the days so the drop reaches tomorrow.
  await page.setViewportSize({ width: 1024, height: 768 });
  await h.openPlanner();
  const frameBox = await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  const plannerNav = frame.getByRole('navigation', { name: 'Planner' });
  const menuButton = frame.getByRole('button', { name: 'Planner menu' });
  const menuFolded = (await menuButton.isVisible()) && (await plannerNav.count()) === 0;
  await menuButton.click();
  const opened = await plannerNav.getByRole('button', { name: 'Today', exact: true }).isVisible();
  await shot('21-narrow-menu');
  await page.keyboard.press('Escape');
  const escaped = (await plannerNav.count()) === 0;
  await menuButton.click();
  await plannerNav.getByRole('button', { name: 'Home', exact: true }).click();
  const picked = (await plannerNav.count()) === 0 && (await frame.getByRole('heading', { name: 'Home' }).isVisible());
  check(`in a narrow page (${Math.round(frameBox?.width ?? 0)} px) the menu folds into a rail and opens over the page; Escape and a pick close it`, menuFolded && opened && escaped && picked, JSON.stringify({ menuFolded, opened, escaped, picked }));

  const header = frame.locator('section.view > header.view-header').first();
  const inPage = (box) => Boolean(box && frameBox && box.x >= frameBox.x - 1 && box.x + box.width <= frameBox.x + frameBox.width + 1);
  const headerControls = [header.getByRole('button', { name: 'Earlier' }), header.getByRole('button', { name: 'Today', exact: true }), header.getByRole('button', { name: 'Later' }), header.getByRole('textbox', { name: 'Jump to date' }).or(header.locator('input.date-jump')), header.locator('select').first()];
  const boxes = await Promise.all(headerControls.map((control) => control.first().boundingBox()));
  const rangeBox = await header.locator('.view-sub').boundingBox();
  check("Home's header keeps every control inside the page, the dates on one line", boxes.every(inPage) && (rangeBox?.height ?? 99) < 28, JSON.stringify(boxes.map((box) => box && Math.round(box.x + box.width))));

  await railTab('Gmail').click();
  await row(`${run} mail 4`).waitFor();
  const board = frame.locator('.sunsama-layout .board');
  const boardBox = await board.boundingBox();
  const within = (box) => Boolean(box && boardBox && box.x >= boardBox.x - 1 && box.x + box.width <= boardBox.x + boardBox.width + 1);
  const todayCard = column('Today').locator('li.task-card').first();
  const titleCut = await todayCard.locator('.task-title').first().evaluate((element) => element.scrollWidth > element.clientWidth + 1).catch(() => true);
  check('with Gmail open beside it, today is a whole column and its cards read in full', within(await column('Today').boundingBox()) && within(await todayCard.boundingBox()) && !titleCut, JSON.stringify({ board: boardBox && Math.round(boardBox.width), titleCut }));
  await shot('22-narrow-home-gmail');

  const tomorrowBefore = await column('Tomorrow').boundingBox();
  const source = await row(`${run} mail 4`).boundingBox();
  await page.mouse.move(source.x + 24, source.y + 12);
  await page.mouse.down();
  const edgeX = boardBox.x + boardBox.width - 10;
  const middleY = boardBox.y + Math.min(boardBox.height / 2, 260);
  await page.mouse.move(edgeX, middleY, { steps: 8 });
  for (let i = 0; i < 40 && (await board.evaluate((element) => element.scrollLeft)) < 160; i++) await page.mouse.move(edgeX - (i % 2), middleY + (i % 3));
  const scrolled = await board.evaluate((element) => element.scrollLeft);
  const target = await column('Tomorrow').locator('ul.task-list').boundingBox();
  await page.mouse.move(target.x + Math.min(target.width / 2, 80), target.y + 24, { steps: 5 });
  await page.mouse.up();
  latest = await waitFor((s) => placedOn(titled(s, `${run} mail 4`)) === tomorrow);
  check(
    'dragging a message to the edge of the board scrolls the days, and it lands on tomorrow',
    !within(tomorrowBefore) && scrolled > 0 && placedOn(titled(latest, `${run} mail 4`)) === tomorrow,
    JSON.stringify({ tomorrowWasWhole: within(tomorrowBefore), scrolled, placed: placedOn(titled(latest, `${run} mail 4`)) }),
  );
  await shot('23-narrow-dropped-tomorrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log(`problems: ${h.problems.slice(0, 5).join(' | ') || 'none'}`);
} finally {
  await cleanUp();
  await h.close();
  const failed = results.filter((result) => !result.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
