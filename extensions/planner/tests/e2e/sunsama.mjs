// Sunsama's planning layout and assigning tasks to a chosen agent, in the dev
// container's real OpenChamber with this checkout's panel and service (harness.mjs).
// Run on the host after `bun run build`:
//   node extensions/planner/tests/e2e/sunsama.mjs [outDir]
// GitHub, Google and the Linear workspace are fixtures; `opencode` is a stand-in
// that lists three models, and one custom agent sits in the private service's
// OpenCode config. The agent phases start real chats in /home/node/projects/planner-demo-a
// as OpenCode's read-only plan agent, through a command file this journey writes
// to the container (oc-planner-harness-plan.md) and removes, with the chats and
// their worktrees, at the end.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness } from './harness.mjs';

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
const serviceOverride = ({ method, path, body }) => {
  const url = new URL(path, 'http://x');
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

mkdirSync(out, { recursive: true });
const h = await startHarness({ out, serviceOverride });
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
/** Wait until the container's OpenCode lists the command for the demo project (it reloads 100 ms after a change). */
const commandListed = () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listed = docker(`cd /tmp && opencode api GET "/api/command?location%5Bdirectory%5D=${DEMO}" 2>/dev/null || true`);
    if (listed.includes('"oc-planner-harness-plan"')) return true;
    execFileSync('sleep', ['0.5']);
  }
  return false;
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

/** The Planner page; when the shared UI was left elsewhere, through the host's "Extension pages" menu. */
const openPlanner = async () => {
  await page.goto(`${'http://100.116.120.66:35310'}/`, { waitUntil: 'load' });
  const home = frame.getByRole('heading', { name: 'Home' });
  if (await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false)) return;
  await page.getByRole('button', { name: 'Extension pages' }).click({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'Planner' }).click();
  await home.waitFor({ timeout: 30_000 });
};

try {
  // The preset "Harness plan" names the command written into the container for the agent phases.
  await commands([
    { type: 'settings.updated', patch: { agentPresets: [{ id: 'harness-plan', name: 'Harness plan', agent: 'plan', model: null }, { id: 'build-claude-h1', name: 'Build · Claude', agent: 'build', model: 'anthropic/claude-sonnet-5-5' }] } },
    ...['assign', 'menu', 'hello'].map((name, index) => ({ type: 'task.created', task: { id: `${run.replace(/[^a-z0-9]/g, '')}${index}`, title: `${run} ${name}`, placement: { kind: 'day', date: today }, position: 100 + index } })),
  ]);
  check('the container\'s OpenCode lists /oc-planner-harness-plan', commandListed());
  await openPlanner();

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

  // The panel folds down to the rail and comes back.
  await railTab('Linear').click();
  const folded = (await panel().count()) === 0 && (await rail().isVisible());
  await shot('05-home-folded');
  await rail().getByRole('button', { name: 'Show the panel' }).click();
  check('clicking the open source folds the panel to its rail; the rail brings it back', folded && (await panel().getAttribute('aria-label')) === 'Linear');

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
  commandListed();
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
  console.log(`problems: ${h.problems.slice(0, 5).join(' | ') || 'none'}`);
} finally {
  await cleanUp();
  await h.close();
  const failed = results.filter((result) => !result.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
