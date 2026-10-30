// Sunsama's planning layout and assigning tasks to a chosen agent, in the dev
// container's real OpenChamber with this checkout's panel and service (harness.mjs).
// Run on the host after `bun run build`:
//   node extensions/planner/tests/e2e/sunsama.mjs [outDir]
// Google and the Linear workspace are fixtures, GitHub too but in its own part: the real gh against a fake GitHub
// (fakeGithub.mjs), at 1440 and 1024 (SUNSAMA_PARTS=github runs it alone). Gmail and the meeting import have parts of
// their own against a fake Google (fakeGoogle.mjs), at both sizes too (SUNSAMA_PARTS=gmail, meetings; a comma-separated
// list runs several; anything but all skips the agent phases); `opencode` is a stand-in
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
import { CONTACTS_SCOPES, DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE, defaultFakeWorld, startFakeGoogle } from './fakeGoogle.mjs';

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
// pull request's make tasks linked to them, as Sunsama's "Add via URL" does. Daily Highlights' Other activities list
// the day's GitHub work (pull requests opened, reviewed and merged, comments, a discussion and a comment on it), as
// Sunsama's GitHub integration surfaces it in the end-of-day review; one opens on GitHub in a new tab, one is included
// and starred; signed out, the section says how to sign in. SUNSAMA_PARTS=github runs this alone.
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
  // Another repository the viewer works in, updated last: the Repository choice lists it first.
  const sideRepo = 'harness-org/side-project';
  world.issues.push(fakeIssue(sideRepo, 9, { title: `${run} side issue`, assignees: ['someone-else'], updatedAt: new Date(Date.now() + 60_000).toISOString() }));
  // Today in the harness's zone, and an hour of it as an instant.
  const zone = 'America/Los_Angeles';
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const offsetAt = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(instant / 1000) * 1000;
  };
  const localAt = (hours) => {
    const wall = Date.parse(`${localDate}T00:00:00Z`) + hours * 3_600_000;
    return new Date(wall - offsetAt(wall)).toISOString();
  };
  world.pulls.push({ id: 'PR_planner_gh_7', number: 7, repo, url: `https://github.com/${repo}/pull/7`, title: `${run} gh pull 7`, body: '', headRefName: 'harness-feature', baseRefName: 'main', headOid: 'fake', isDraft: false, state: 'OPEN', createdAt: localAt(-20), updatedAt: new Date().toISOString(), reviewRequested: [world.viewer] });
  // The day's GitHub work, for Daily Highlights: a pull request opened, Ann's reviewed twice, mine merged by Ann, Bo's
  // reviewed and merged by me, 51 comments on issue 52 and one on Ann's pull request (past a page of 50), a discussion
  // started and a comment on it.
  const dayPull = (number, extra) => ({ id: `PR_day_${number}`, number, repo, url: `https://github.com/${repo}/pull/${number}`, title: `${run} day pull ${number}`, body: '', headRefName: `day-${number}`, baseRefName: 'main', headOid: 'fake', isDraft: false, state: 'OPEN', createdAt: localAt(-30), updatedAt: localAt(8), ...extra });
  const review = (number, n, state, hours) => ({ id: `RV_day_${number}_${n}`, author: world.viewer, state, submittedAt: localAt(hours), url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${n}` });
  world.pulls.push(
    dayPull(201, { createdAt: localAt(9), updatedAt: localAt(9) }),
    dayPull(202, { author: 'ann', reviews: [review(202, 1, 'CHANGES_REQUESTED', 10), review(202, 2, 'APPROVED', 11)] }),
    dayPull(203, { state: 'MERGED', mergedAt: localAt(12), mergedBy: 'ann' }),
    dayPull(204, { author: 'bo', state: 'MERGED', mergedAt: localAt(13), mergedBy: world.viewer, reviews: [review(204, 3, 'APPROVED', 12.5)] }),
  );
  world.issueComments = [
    ...Array.from({ length: 51 }, (_, n) => ({ id: `IC_day_${n}`, author: world.viewer, on: world.issues[51].url, url: `${world.issues[51].url}#issuecomment-${n}`, createdAt: localAt(14 + n / 120), updatedAt: localAt(14 + n / 120) })),
    { id: 'IC_day_pr', author: world.viewer, on: `https://github.com/${repo}/pull/202`, url: `https://github.com/${repo}/pull/202#issuecomment-pr`, createdAt: localAt(15), updatedAt: localAt(15) },
  ];
  world.discussions = [{ id: 'DS_day_7', number: 7, repo, title: `${run} roadmap`, url: `https://github.com/${repo}/discussions/7`, author: world.viewer, createdAt: localAt(16) }];
  world.discussionComments = [{ id: 'DCM_day_1', discussionId: 'DS_day_7', author: world.viewer, url: `https://github.com/${repo}/discussions/7#discussioncomment-1`, createdAt: localAt(16.5) }];
  const fake = await startFakeGithub({ socket: join(dir, 'gh.sock'), world });
  const config = ghConfigFiles(fake.socket);
  // The private service's gh is the real one, its config sending every request to the fake's socket (nothing reaches GitHub).
  // Signed out, for the last check: GitHub's status says so (the harness answers it, as gh would).
  let signedOut = false;
  const g = await startHarness({
    out,
    viewport,
    serviceEnv: { PATH: `${dirname(gh)}:/usr/bin:/bin`, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
    homeFiles: { '.config/gh/config.yml': config['config.yml'], '.config/gh/hosts.yml': config['hosts.yml'] },
    serviceOverride: ({ path }) => (signedOut && path === '/github/status' ? { available: false, login: null, message: 'You are not signed in to GitHub (gh auth login).', reason: 'signed-out', container: null } : undefined),
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
    // Nothing reaches github.com: a tab the Planner opens there gets a stub page.
    await g.context.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>GitHub (harness stub)</title><p>stub</p>' }));
    await g.openPlanner();
    await f.getByRole('navigation', { name: 'Sources' }).getByRole('tab', { name: 'GitHub', exact: true }).click();
    await ghRow(`${run} gh issue 50`).waitFor({ timeout: 30_000 });
    check(`${size}: the GitHub source shows the first 50 of 51 assigned issues, and says so, with Load more`, (await shown()) === 50 && (await status().innerText()).includes('Showing 50 of 51') && (await ghPanel().getByRole('button', { name: 'Load more' }).count()) === 1, await status().innerText().catch(() => 'no count'));
    check(`${size}: read through the real gh: a page of 50, from the first`, lists().length >= 1 && lists()[0].variables?.after === undefined && /assignee:@me/.test(String(lists()[0].variables?.q)), JSON.stringify(lists().map((request) => request.variables)));
    // The list's end: "Showing 50 of 51" and Load more.
    await status().scrollIntoViewIfNeeded();
    await shotHere('gh-50-of-51');
    await ghPanel().getByRole('button', { name: 'Load more' }).click();
    await ghRow(`${run} gh issue 51`).waitFor({ timeout: 15_000 });
    const after = lists().at(-1)?.variables?.after;
    check(`${size}: Load more reads the next page from the first page's cursor, and shows the 51st`, (await shown()) === 51 && typeof after === 'string' && after.length > 0 && (await status().innerText()).includes('All 51 shown'), JSON.stringify({ after, shown: await shown() }));
    await status().scrollIntoViewIfNeeded();
    await shotHere('gh-all-51');
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
    // Round 12: the repositories the viewer works in (Sunsama surfaces "the most relevant repositories"); one chosen
    // narrows the search to it, as its repo: words do.
    const repoChoice = ghPanel().getByRole('combobox', { name: 'Repository' });
    await repoChoice.waitFor({ timeout: 15_000 });
    const repoOptions = await repoChoice.locator('option').allInnerTexts();
    check(`${size}: a Repository choice lists the repositories the viewer works in, the latest updated first`, repoOptions.join('|') === `All repositories|${sideRepo}|${repo}`, repoOptions.join(' | '));
    await repoChoice.selectOption(repo);
    for (let i = 0; i < 50 && !String(lists().at(-1)?.variables?.q).includes(`repo:${repo}`); i++) await new Promise((resolve) => setTimeout(resolve, 200));
    check(`${size}: choosing one narrows the list to it (repo: in GitHub's search)`, String(lists().at(-1)?.variables?.q).includes(`repo:${repo}`) && (await ghPanel().getByRole('searchbox', { name: 'Search GitHub items' }).inputValue()) === `repo:${repo}`, String(lists().at(-1)?.variables?.q));
    await shotHere('gh-repository');
    await repoChoice.selectOption('');
    // The planned issue's card: GitHub's icon opens it there; right-click opens the task's menu; G opens it too.
    const card51 = f.locator('li.task-card', { has: f.locator('.task-title', { hasText: `${run} gh issue 51` }) }).first();
    const icon51 = card51.locator('a.source-open');
    check(`${size}: the planned issue's card shows GitHub's icon, linked to the issue`, (await icon51.getAttribute('aria-label')) === `Open ${repo}#51 in GitHub` && (await icon51.getAttribute('href')) === issue51.url, await icon51.getAttribute('href'));
    await card51.click({ button: 'right' });
    check(`${size}: right-click opens the task's menu, with Open in GitHub`, await card51.getByRole('menuitem', { name: 'Open in GitHub' }).isVisible());
    await shotHere('gh-card-menu');
    await f.getByRole('heading', { name: 'Home' }).click();
    await card51.hover();
    const gTab = g.context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await g.page.keyboard.press('g');
    const opened51 = await gTab;
    check(`${size}: G over a linked task opens it in its tool (GitHub), in a new tab`, opened51?.url() === issue51.url, opened51?.url() ?? 'no new tab');
    await opened51?.close();

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
    // `>` in Add task (Sunsama's merge during task creation): a pasted issue imported straight into an open task.
    await today.getByRole('button', { name: 'Add task' }).click();
    await today.getByRole('textbox', { name: 'New task' }).fill(`${run} gh triage`);
    await today.getByRole('textbox', { name: 'New task' }).press('Enter');
    const side = world.issues.at(-1);
    await today.getByRole('textbox', { name: 'New task' }).fill(`${side.url} >${run} gh tri`);
    const mergeChip = await today.locator('.merge-chip').innerText().catch(() => '');
    check(`${size}: > names the task it goes into, as the field says`, mergeChip === `Merges into ${run} gh triage as a subtask`, mergeChip);
    await shotHere('gh-merge-into');
    await today.getByRole('textbox', { name: 'New task' }).press('Enter');
    await today.getByRole('textbox', { name: 'New task' }).press('Escape').catch(() => {});
    let triage = null;
    for (let i = 0; i < 50 && !triage?.subtasks?.length; i++) {
      triage = Object.values((await latestState()).tasks).find((task) => task.title === `${run} gh triage` && !task.deletedAt) ?? null;
      if (!triage?.subtasks?.length) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    check(`${size}: the issue becomes a subtask of that task, linked to GitHub, and no task of its own`, triage?.subtasks?.[0]?.title === side.title && triage.subtasks[0].source?.kind === 'github' && triage.subtasks[0].source?.key === `${sideRepo}#9` && !Object.values((await latestState()).tasks).some((task) => task.title === side.title && !task.deletedAt), JSON.stringify(triage?.subtasks ?? null));

    // ── Daily Highlights: the day's GitHub work in Other activities, read through the real gh ──
    const go = async (name) => {
      if (!(await g.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
      await g.nav(name).click();
    };
    await go('Daily highlights');
    await f.getByRole('heading', { name: 'Daily highlights' }).waitFor();
    const other = f.getByRole('region', { name: 'Other activities' });
    const ghActivity = other.getByRole('region', { name: 'GitHub activity' });
    await ghActivity.locator('.activity-row').first().waitFor({ timeout: 30_000 });
    const activityRows = () => ghActivity.locator('.activity-row').evaluateAll((rows) => rows.map((row) => ({ kind: row.querySelector('.activity-kind')?.textContent ?? '', title: row.querySelector('.activity-title')?.textContent ?? '', href: row.querySelector('a.activity-title')?.getAttribute('href') ?? '' })));
    const listed = await activityRows();
    const expected = [
      ['Opened', 201], ['Reviewed · approved ×2', 202], ['Merged by ann', 203], ['Reviewed · approved', 204], ['Merged', 204],
      ['Commented ×51', 52], ['Commented', 202],
      ['Started', 7], ['Commented', 7],
    ];
    check(`${size}: Daily highlights' Other activities list the day's GitHub work: pull requests opened, reviewed and merged, comments, a discussion and a comment on it`,
      JSON.stringify(listed.map((row) => [row.kind, Number(/#(\d+)/.exec(row.title)?.[1])])) === JSON.stringify(expected), JSON.stringify(listed.map((row) => `${row.kind} ${row.title.slice(0, 40)}`)));
    const activityAsked = fake.requests.filter((request) => request.operation?.startsWith('query PlannerGitHubActivity')).map((request) => request.operation);
    check(`${size}: read through the real gh: the day's first pages in one call, then the comments' next page (52 comments, past a page of 50)`,
      JSON.stringify(activityAsked) === JSON.stringify(['query PlannerGitHubActivity', 'query PlannerGitHubActivityComments']), JSON.stringify(activityAsked));
    check(`${size}: each row links to GitHub: the latest review, the latest comment, the pull request merged`,
      listed[1]?.href === `https://github.com/${repo}/pull/202#pullrequestreview-2` && listed[5]?.href === `${world.issues[51].url}#issuecomment-50` && listed[4]?.href === `https://github.com/${repo}/pull/204`, JSON.stringify([listed[1]?.href, listed[5]?.href, listed[4]?.href]));
    await ghActivity.scrollIntoViewIfNeeded();
    await shotHere('gh-highlights');
    // Cmd/Ctrl+click opens it in a new tab; the Planner stays where it is.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const merged204 = ghActivity.locator('.activity-row').nth(4);
    const opened = g.context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
    await merged204.locator('a.activity-title').click({ modifiers: [modifier] });
    const tab = await opened;
    if (tab) await tab.waitForURL(/github\.com/, { timeout: 15_000 }).catch(() => {});
    check(`${size}: a Cmd/Ctrl+click on a row opens it on GitHub in a new tab, and the Planner stays on Daily highlights`,
      tab?.url() === `https://github.com/${repo}/pull/204` && (await f.getByRole('heading', { name: 'Daily highlights' }).isVisible()), tab ? tab.url() : 'no new tab');
    await tab?.close();
    // Include adds it to the highlights, with its link; it can be starred like any highlight.
    const mergedText = `Merged pull request ${repo}#204: ${run} day pull 204`;
    await merged204.getByRole('button', { name: `Include ${mergedText}` }).click();
    const highlight = f.locator('ul.highlights li', { has: f.locator(`input[aria-label="Highlight"][value="${mergedText}"]`) });
    await highlight.waitFor({ timeout: 15_000 });
    await highlight.getByRole('button', { name: `Star ${mergedText}` }).click();
    let savedItem = null;
    for (let i = 0; i < 50 && !savedItem?.starred; i++) {
      savedItem = Object.values((await latestState()).rituals ?? {}).flatMap((record) => record.items ?? []).find((item) => item.ref === 'github:merged:PR_day_204') ?? null;
      if (!savedItem?.starred) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    check(`${size}: Include adds the merged pull request to the highlights with its link; starred, it is saved so`,
      savedItem?.text === mergedText && savedItem.url === `https://github.com/${repo}/pull/204` && savedItem.starred === true && (await highlight.locator('a.highlight-open').getAttribute('href')) === `https://github.com/${repo}/pull/204` && (await merged204.locator('.activity-included').count()) === 1,
      JSON.stringify(savedItem));
    // The day's tasks not in the highlights are there too, as in Sunsama's Other activities.
    const openTask = other.getByRole('region', { name: 'Tasks' }).locator('.activity-row', { hasText: `${run} gh issue 51` });
    const taskShown = (await openTask.locator('.activity-kind').innerText().catch(() => '')) === 'Not done';
    await openTask.getByRole('button', { name: `Include ${run} gh issue 51` }).click().catch(() => {});
    const taskIncluded = await f.locator(`ul.highlights input[aria-label="Highlight"][value="${run} gh issue 51"]`).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    check(`${size}: the day's open tasks are in Other activities, and one included becomes a highlight`, taskShown && taskIncluded, `${taskShown} ${taskIncluded}`);
    await f.locator('ul.highlights').scrollIntoViewIfNeeded();
    await shotHere('gh-highlights-included');
    // Signed out: the section says how to sign in, as the GitHub source does.
    signedOut = true;
    await g.openPlanner();
    await go('Daily highlights');
    const signIn = f.getByRole('region', { name: 'GitHub activity' }).getByRole('status', { name: 'GitHub sign-in' });
    const signInText = await signIn.innerText({ timeout: 20_000 }).catch(() => '');
    check(`${size}: not signed in, the GitHub activity says so and where to run gh auth login`, /Sign in to GitHub/.test(signInText) && /gh auth login/.test(signInText), signInText.slice(0, 160));
    await signIn.scrollIntoViewIfNeeded().catch(() => {});
    await shotHere('gh-highlights-signin');
    signedOut = false;
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


// ── Round 12: Gmail as Sunsama's integration has it, against a fake Google (fakeGoogle.mjs), at 1440 and 1024 ──────
// (help.sunsama.com/docs/integrations/gmail) Shift G; labels one at a time, Cmd/Ctrl adds; the Archived, Spam and Trash
// filters; already imported emails left out; the import and completion automations (set in Settings, done in the
// fake's Gmail) and their prompt; an email task's thread and its actions; Superhuman as the email client (S opens it);
// an account without Gmail actions is told how; an email merged straight into a task (Alt/Option + drop), G, Convert
// to task; the card's Gmail icon and its right-click menu; Re-add Gmail account. SUNSAMA_PARTS=gmail runs it alone.
// Nothing reaches Google: the private service's Google is the fake; pages opened at Gmail or Superhuman get a stub.
const gmailPart = async (viewport) => {
  const size = String(viewport.width);
  const SECOND = 'second@example.com';
  const world = defaultFakeWorld({ account: ACCOUNT, today, zone });
  world.granted = [...DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE];
  world.mailLabels = [{ id: 'Label_7', name: 'In progress' }];
  const at = (hours) => new Date(Date.now() - hours * 3_600_000).toUTCString();
  const message = (n, subject, extra = {}) => ({ id: `gm${n}-${run}`, threadId: `gt${n}-${run}`, subject: `${run} ${subject}`, from: 'Ann Lee <ann@example.com>', date: at(n), snippet: `About ${subject}`, ...extra });
  world.mail = [
    message(1, 'budget', { body: 'Hi,\nhere is the first draft of the budget.', date: at(9) }),
    { ...message(1, 'budget'), id: `gm1b-${run}`, subject: `Re: ${run} budget`, from: 'Bo <bo@example.com>', snippet: 'Looks good to me', body: 'Looks good to me.', unread: true, date: at(8) },
    message(2, 'lunch', { unread: true }),
    message(3, 'archived note', { labels: ['Label_7'] }),
    message(4, 'in progress', { labels: ['INBOX', 'Label_7'] }),
    message(5, 'spam offer', { labels: ['SPAM', 'Label_7'] }),
    message(6, 'merge me', { unread: true }),
    message(7, 'merge two', { unread: true }),
  ];
  const fake = await startFakeGoogle(world);
  const file = JSON.parse(fake.accountsFile());
  // Two accounts: this one allowed Gmail actions; the second one only reads Gmail.
  file.accounts = [{ ...file.accounts[0], scopes: world.granted }, { ...file.accounts[0], email: SECOND, scopes: DEFAULT_SCOPES }];
  const g = await startHarness({ out, viewport, timezoneId: zone, serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base }, homeFiles: { 'google-accounts.json': JSON.stringify(file) } });
  const f = g.frame;
  const plannerErrors = [];
  g.page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  g.page.on('console', (entry) => {
    if (entry.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(entry.location().url ?? '')) plannerErrors.push(entry.text().slice(0, 300));
  });
  await g.context.route(/^https:\/\/mail\.(google|superhuman)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Mail (harness stub)</title><p>stub</p>' }));
  const shotHere = async (name) => {
    await g.page.waitForTimeout(250);
    await g.shot(`${name}-${size}`);
  };
  const latestState = async () => (await g.call('GET', '/state')).json.state;
  const until = async (test, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await test()) return true;
    return false;
  };
  const go = async (name) => {
    if (!(await g.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
    await g.nav(name).click();
  };
  const panel = () => f.locator('aside.source-panel');
  const mailRow = (subject) => panel().locator('li.issue-row', { hasText: subject }).first();
  const rowNames = () => panel().locator('li.issue-row .issue-title').allInnerTexts();
  const label = (name) => panel().getByRole('group', { name: 'Gmail labels' }).getByRole('button', { name, exact: true });
  const searches = () => fake.requests.filter((request) => request.path === '/gmail/v1/users/me/messages').map((request) => request.query.q ?? '');
  const labelsOf = (id) => [...(fake.world.mail.find((one) => one.id === id)?.labels ?? [])].sort();
  const todayColumn = () => f.locator('section.day-column[aria-label^="Today"]').first();
  const card = (title) => f.locator('li.task-card', { has: f.locator('.task-title', { hasText: title }) }).first();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const newTab = async (action) => {
    const opened = g.context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await action();
    const tab = await opened;
    if (tab) await tab.waitForLoadState('domcontentloaded').catch(() => {});
    const url = tab?.url() ?? '';
    await tab?.close();
    return url;
  };
  try {
    await g.openPlanner();
    await f.getByRole('heading', { name: 'Home' }).click();
    // Shift G opens Gmail in the right-hand panel (Sunsama's shortcut).
    await g.page.keyboard.press('Shift+G');
    await mailRow(`${run} budget`).waitFor({ timeout: 30_000 });
    check(`${size}: Shift G opens Gmail in the right-hand panel, the Inbox shown at first`, (await panel().getAttribute('aria-label')) === 'Gmail' && (await label('Inbox').getAttribute('aria-pressed')) === 'true' && searches().at(-1) === 'in:inbox');
    const inbox = await rowNames();
    check(`${size}: the Inbox lists its emails, not archived, spam or trash ones`, inbox.includes(`Re: ${run} budget`) && inbox.includes(`${run} lunch`) && inbox.includes(`${run} in progress`) && !inbox.some((name) => /archived note|spam offer/.test(name)), inbox.join(' | '));
    check(`${size}: the account's labels: Gmail's own, then the user's`, (await panel().getByRole('group', { name: 'Gmail labels' }).getByRole('button').allInnerTexts()).join('|') === 'Inbox|Starred|Important|Unread|Sent|Drafts|Spam|Trash|In progress');
    await shotHere('gm-01-inbox');
    // A label alone; Cmd/Ctrl adds one (an email must have every one shown).
    await label('In progress').click();
    await until(async () => (await rowNames()).length === 1);
    check(`${size}: a click on a label shows that label alone (in the Inbox, archived ones left out)`, (await rowNames()).join() === `${run} in progress` && searches().at(-1) === 'label:in-progress in:inbox' && (await label('Inbox').getAttribute('aria-pressed')) === 'false', `${(await rowNames()).join()} / ${searches().at(-1)}`);
    await label('Unread').click({ modifiers: [modifier] });
    await until(async () => searches().at(-1) === 'label:in-progress is:unread in:inbox');
    check(`${size}: Cmd/Ctrl+click adds a label to the ones shown (both must match)`, (await label('In progress').getAttribute('aria-pressed')) === 'true' && (await label('Unread').getAttribute('aria-pressed')) === 'true' && searches().at(-1) === 'label:in-progress is:unread in:inbox', searches().at(-1));
    await label('In progress').click();
    // Filters: archived, spam and trash, already imported.
    await panel().getByRole('button', { name: 'Gmail filters' }).click();
    const filters = f.getByRole('menu', { name: 'Show' });
    await filters.getByRole('checkbox', { name: 'Archived' }).check();
    await until(async () => (await rowNames()).length === 2);
    check(`${size}: Archived shows the label's archived emails too`, (await rowNames()).sort().join() === [`${run} archived note`, `${run} in progress`].sort().join() && searches().at(-1) === 'label:in-progress', `${(await rowNames()).join()} / ${searches().at(-1)}`);
    await filters.getByRole('checkbox', { name: 'Spam and Trash' }).check();
    await until(async () => (await rowNames()).length === 3);
    check(`${size}: Spam and Trash shows those too`, (await rowNames()).includes(`${run} spam offer`) && searches().at(-1) === 'label:in-progress in:anywhere', searches().at(-1));
    await shotHere('gm-02-filters');
    await filters.getByRole('checkbox', { name: 'Archived' }).uncheck();
    await filters.getByRole('checkbox', { name: 'Spam and Trash' }).uncheck();
    await panel().getByRole('button', { name: 'Gmail filters' }).click();
    await label('Inbox').click();
    await mailRow(`${run} lunch`).waitFor();
    // Planned, an email leaves the list (Sunsama's "Already imported" filter, off at first).
    await mailRow(`${run} lunch`).hover();
    await mailRow(`${run} lunch`).getByRole('button', { name: `Plan ${run} lunch today` }).click();
    await until(async () => !(await rowNames()).includes(`${run} lunch`));
    const note = await panel().getByRole('status').filter({ hasText: 'already imported' }).innerText().catch(() => '');
    check(`${size}: an imported email leaves the list, which says so (Show them)`, !(await rowNames()).includes(`${run} lunch`) && /1 already imported, not shown/.test(note), note);
    await shotHere('gm-03-imported-hidden');

    // Settings → Gmail: Sunsama's "Inbox Zero" set-up: on import Mark as read and Remove a label: Inbox; on completion
    // Archive, with Show prompt; Superhuman as the email client.
    await go('Settings');
    const importGroup = f.getByRole('group', { name: 'Import automations' });
    await importGroup.getByRole('checkbox', { name: 'Mark as read', exact: true }).check();
    await importGroup.getByRole('combobox', { name: 'A label for Import automations' }).selectOption('Inbox');
    await importGroup.getByRole('button', { name: 'Remove a label' }).click();
    const completeGroup = f.getByRole('group', { name: 'Completion automations' });
    await completeGroup.getByRole('checkbox', { name: 'Archive', exact: true }).check();
    await completeGroup.getByRole('checkbox', { name: /Show prompt/ }).check();
    await until(async () => (await latestState()).settings.gmailCompletePrompt === true);
    const settings = (await latestState()).settings;
    check(`${size}: Settings → Gmail keeps the automations as Sunsama names them`, JSON.stringify(settings.gmailOnImport) === JSON.stringify([{ kind: 'markRead' }, { kind: 'removeLabel', label: 'Inbox' }]) && JSON.stringify(settings.gmailOnComplete) === JSON.stringify([{ kind: 'archive' }]) && settings.gmailCompletePrompt === true, JSON.stringify([settings.gmailOnImport, settings.gmailOnComplete]));
    await importGroup.scrollIntoViewIfNeeded();
    await shotHere('gm-04-settings');

    // Import: the automations happen in Gmail.
    await go('Home');
    await mailRow(`Re: ${run} budget`).waitFor({ timeout: 20_000 });
    await mailRow(`Re: ${run} budget`).hover();
    await mailRow(`Re: ${run} budget`).getByRole('button', { name: `Plan Re: ${run} budget today` }).click();
    const imported = await until(() => labelsOf(`gm1b-${run}`).join() === '' && labelsOf(`gm1-${run}`).join() === '');
    check(`${size}: importing an email marks it read and takes it out of the Inbox, in Gmail`, imported, JSON.stringify([labelsOf(`gm1-${run}`), labelsOf(`gm1b-${run}`)]));
    // The task embeds the thread: its conversation, the latest open, what Gmail has it in, and the actions.
    await card(`Re: ${run} budget`).locator('button.task-body').click();
    const detail = f.getByRole('dialog', { name: 'Task details' });
    const section = detail.getByRole('region', { name: 'Gmail' });
    const thread = section.getByRole('list', { name: 'The conversation' });
    await thread.waitFor({ timeout: 20_000 });
    const where = await section.getByLabel('In Gmail', { exact: true }).innerText().catch(() => '');
    check(`${size}: the task shows the thread, the latest message open, and where Gmail has it (Archived)`, (await thread.locator('li').count()) === 2 && (await thread.locator('li.is-open').innerText()).includes('Looks good to me.') && where === 'Archived', `${where} / ${await thread.locator('li').count()}`);
    await thread.locator('li').first().getByRole('button').click();
    check(`${size}: a message of the thread opens with its text, to browse the conversation`, (await thread.locator('li').first().innerText()).includes('here is the first draft of the budget.'));
    check(`${size}: Archive waits for an email in the Inbox; Move to trash and Mark as unread are there`, (await section.getByRole('button', { name: 'Archive' }).isDisabled()) && (await section.getByRole('button', { name: 'Move to trash' }).isEnabled()) && (await section.getByRole('button', { name: 'Mark as unread' }).isEnabled()));
    await section.getByRole('button', { name: 'Mark as unread' }).click();
    const unread = await until(() => labelsOf(`gm1b-${run}`).includes('UNREAD'));
    await until(async () => (await section.getByLabel('In Gmail', { exact: true }).innerText().catch(() => '')) === 'Archived · Unread');
    check(`${size}: Mark as unread happens in Gmail, and the task says so`, unread && (await section.getByLabel('In Gmail', { exact: true }).innerText()) === 'Archived · Unread', JSON.stringify(labelsOf(`gm1b-${run}`)));
    await shotHere('gm-05-thread');
    await detail.press('Escape');

    // Superhuman as the email client: the task, its card and S open the email there.
    await go('Settings');
    await f.getByRole('combobox', { name: 'Custom email client' }).selectOption('superhuman');
    await until(async () => (await latestState()).settings.emailClient === 'superhuman');
    await go('Home');
    const superhuman = `https://mail.superhuman.com/${encodeURIComponent(ACCOUNT)}/thread/gt1-${run}`;
    const icon = card(`Re: ${run} budget`).locator('a.source-open');
    check(`${size}: the card shows its tool's icon, which opens the email in the email client (Superhuman)`, (await icon.getAttribute('aria-label')) === 'Open Email in Superhuman' && (await icon.getAttribute('href')) === superhuman, await icon.getAttribute('href'));
    await card(`Re: ${run} budget`).click({ button: 'right' });
    const menu = card(`Re: ${run} budget`).getByRole('menu');
    check(`${size}: right-click opens the task's menu, with Open in Superhuman`, await menu.getByRole('menuitem', { name: 'Open in Superhuman' }).isVisible());
    await shotHere('gm-06-card-menu');
    await g.page.keyboard.press('Escape');
    await f.getByRole('heading', { name: 'Home' }).click();
    await card(`Re: ${run} budget`).locator('button.task-body').click();
    await section.getByRole('link', { name: 'Open in Superhuman' }).waitFor();
    const opened = await newTab(() => g.page.keyboard.press('s'));
    check(`${size}: S opens the email in Superhuman, in a new tab`, opened === superhuman, opened);
    await detail.press('Escape');

    // Completing it asks (Show prompt), the configured action ticked; the ones picked are done in Gmail.
    await card(`Re: ${run} budget`).getByRole('button', { name: 'Mark complete' }).click();
    const prompt = f.getByRole('alertdialog', { name: `Gmail: Re: ${run} budget` });
    await prompt.waitFor({ timeout: 10_000 });
    check(`${size}: completing it asks which actions to take, Archive ticked as set`, (await prompt.getByRole('checkbox', { name: 'Archive', exact: true }).isChecked()) && !(await prompt.getByRole('checkbox', { name: 'Star', exact: true }).isChecked()));
    await prompt.getByRole('checkbox', { name: 'Star', exact: true }).check();
    await shotHere('gm-07-complete-prompt');
    await prompt.getByRole('button', { name: 'Do it' }).click();
    const starred = await until(() => labelsOf(`gm1b-${run}`).includes('STARRED'));
    check(`${size}: the actions picked are done in Gmail (starred)`, starred, JSON.stringify(labelsOf(`gm1b-${run}`)));

    // An account that has not allowed Gmail actions: its email task says how, without the actions.
    await panel().getByRole('combobox', { name: 'Gmail account' }).selectOption(SECOND);
    await mailRow(`${run} in progress`).waitFor({ timeout: 20_000 });
    await mailRow(`${run} in progress`).hover();
    await mailRow(`${run} in progress`).getByRole('button', { name: `Plan ${run} in progress today` }).click();
    await card(`${run} in progress`).waitFor({ timeout: 15_000 });
    await card(`${run} in progress`).locator('button.task-body').click();
    const allow = detail.getByRole('region', { name: 'Gmail' }).getByRole('button', { name: 'Allow Gmail actions' });
    check(`${size}: an email of an account without Gmail actions offers to allow them, with no actions`, (await allow.isVisible({ timeout: 10_000 }).catch(() => false)) && (await detail.getByRole('region', { name: 'Gmail' }).getByRole('button', { name: 'Archive' }).count()) === 0);
    await shotHere('gm-08-allow');
    await detail.press('Escape');
    await panel().getByRole('combobox', { name: 'Gmail account' }).selectOption(ACCOUNT);

    // Merge (Alt/Option + drop) an email straight from the panel into a task: a subtask, still the email, its import
    // automations done; G opens it; Convert to task gives it back.
    await todayColumn().getByRole('button', { name: 'Add task' }).click();
    await todayColumn().getByRole('textbox', { name: 'New task' }).fill(`${run} inbox triage`);
    await todayColumn().getByRole('textbox', { name: 'New task' }).press('Enter');
    await todayColumn().getByRole('textbox', { name: 'New task' }).press('Escape').catch(() => {});
    await card(`${run} inbox triage`).waitFor();
    await mailRow(`${run} merge me`).waitFor({ timeout: 20_000 });
    await g.page.keyboard.down('Alt');
    await mailRow(`${run} merge me`).dragTo(card(`${run} inbox triage`));
    await g.page.keyboard.up('Alt');
    let triage = null;
    await until(async () => {
      triage = Object.values((await latestState()).tasks).find((task) => task.title === `${run} inbox triage`);
      return triage?.subtasks?.length === 1;
    });
    check(`${size}: Alt/Option + drop merges the email into the task as a subtask, still linked to it`, triage?.subtasks?.[0]?.title === `${run} merge me` && triage.subtasks[0].source?.kind === 'email' && !Object.values((await latestState()).tasks).some((task) => task.title === `${run} merge me` && !task.deletedAt), JSON.stringify(triage?.subtasks ?? null));
    check(`${size}: merged straight from the panel, it is imported: its import automations happen in Gmail`, await until(() => labelsOf(`gm6-${run}`).join() === ''), JSON.stringify(labelsOf(`gm6-${run}`)));
    await card(`${run} inbox triage`).locator('button.task-body').click();
    const mergedSection = detail.getByRole('region', { name: 'Merged in' });
    await mergedSection.waitFor();
    await mergedSection.locator('li').first().hover();
    const gOpened = await newTab(() => g.page.keyboard.press('g'));
    check(`${size}: the task lists it under Merged in; G over it opens it in its tool`, gOpened === `https://mail.superhuman.com/${encodeURIComponent(ACCOUNT)}/thread/gt6-${run}`, gOpened);
    await shotHere('gm-09-merged');
    await mergedSection.getByRole('button', { name: `Convert ${run} merge me to a task` }).click();
    await detail.press('Escape');
    let converted = null;
    await until(async () => {
      converted = Object.values((await latestState()).tasks).find((task) => task.title === `${run} merge me` && !task.deletedAt) ?? null;
      return Boolean(converted);
    });
    check(`${size}: Convert to task gives it back as a task, still the email`, converted?.source?.kind === 'email' && (await card(`${run} merge me`).isVisible()), JSON.stringify(converted?.source ?? null));
    // Completed through the task it is merged into, as checking it off would (Sunsama keeps merged items integrated):
    // the task completed, its completion prompt asks about the merged email (Archive ticked as set), the actions picked
    // happen in Gmail; reopened, nothing is asked or done in Gmail (its automations are for importing and completing).
    await mailRow(`${run} merge two`).waitFor({ timeout: 20_000 });
    await g.page.keyboard.down('Alt');
    await mailRow(`${run} merge two`).dragTo(card(`${run} inbox triage`));
    await g.page.keyboard.up('Alt');
    const mergedTwo = await until(async () => Object.values((await latestState()).tasks).find((task) => task.title === `${run} inbox triage`)?.subtasks?.some((subtask) => subtask.source?.kind === 'email' && subtask.title === `${run} merge two`));
    await card(`${run} inbox triage`).getByRole('button', { name: 'Mark complete' }).click();
    const throughTask = f.getByRole('alertdialog', { name: `Gmail: ${run} merge two` });
    const askedThrough = await throughTask.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    const archiveTicked = askedThrough && (await throughTask.getByRole('checkbox', { name: 'Archive', exact: true }).isChecked());
    if (askedThrough) await throughTask.getByRole('checkbox', { name: 'Star', exact: true }).check();
    await shotHere('gm-09b-merged-through-task');
    if (askedThrough) await throughTask.getByRole('button', { name: 'Do it' }).click();
    const starredThrough = await until(() => labelsOf(`gm7-${run}`).includes('STARRED'));
    check(`${size}: completing the task an email is merged into asks about that email once (Archive ticked as set); the actions picked happen in Gmail`,
      mergedTwo && askedThrough && archiveTicked && starredThrough, JSON.stringify({ mergedTwo, askedThrough, archiveTicked, labels: labelsOf(`gm7-${run}`) }));
    const labelsBefore = labelsOf(`gm7-${run}`).join();
    await card(`${run} inbox triage`).getByRole('button', { name: 'Mark incomplete' }).click();
    await g.page.waitForTimeout(1500);
    check(`${size}: reopening that task asks nothing and changes nothing in Gmail`,
      (await f.getByRole('alertdialog', { name: /^Gmail: / }).count()) === 0 && labelsOf(`gm7-${run}`).join() === labelsBefore && !(await latestState()).tasks[Object.values((await latestState()).tasks).find((task) => task.title === `${run} inbox triage`)?.id ?? '']?.completedAt,
      labelsOf(`gm7-${run}`).join());

    // Access Google took back: the panel offers Re-add Gmail account (not clicked: nothing signs in here).
    fake.world.revoked = true;
    await go('Home');
    await f.getByRole('heading', { name: 'Home' }).click();
    await g.page.keyboard.press('Shift+G');
    await panel().getByRole('button', { name: 'Refresh Gmail' }).click();
    const readd = panel().getByRole('button', { name: 'Re-add Gmail account' });
    check(`${size}: when Google no longer accepts the access, the Gmail panel says so and offers Re-add Gmail account`, await readd.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false), await panel().getByRole('alert').innerText().catch(() => ''));
    await shotHere('gm-10-readd');
    fake.world.revoked = false;
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the Gmail part ran to its end`, false, error?.stack ?? String(error));
    await shotHere('gm-failure').catch(() => {});
  } finally {
    await g.close();
    await fake.close();
  }
};

// ── Round 12: Sunsama's meeting import and calendar integration, against a fake Google (fakeGoogle.mjs), at 1440 and 1024 ──
// (help.sunsama.com/docs/usage-guides/importing-meetings, …/timeboxing/timeboxing-choosing-calendar, …/integrations/calendar)
// Shift C; a day's name shows its calendar in the panel; Calendars there; "Add to tasks" from an event's details and on
// hover; auto-complete when it ends; daily planning's "Fill in calendar events" (import the suggested, Pick events);
// Remove from tasks (right-click), never added back; "Cannot merge events", and no Add subtask in an event task's
// details (Sunsama's advice instead); a Google task merged into a task completed and reopened in Google Tasks with its
// tick and with its task; Settings → Meeting import (Auto-sync from
// the calendars chosen, an import channel, an exclusion turned off and on); a Timeboxing Channel's sessions written to
// its calendar; Google Contacts suggested as guests. SUNSAMA_PARTS=meetings runs it alone.
const meetingsPart = async (viewport) => {
  const size = String(viewport.width);
  const yesterday = dayKey(-1);
  const inThree = dayKey(3);
  /** An instant of a day's wall-clock hour where the harness is. */
  const zoned = (date, hours) => {
    const wall = Date.parse(`${date}T00:00:00Z`) + hours * 3_600_000;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(wall).map((part) => [part.type, part.value]));
    return new Date(wall - (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - wall)).toISOString();
  };
  const guests = [{ email: ACCOUNT, self: true, responseStatus: 'accepted' }, { email: 'ann@example.com', displayName: 'Ann Lee', responseStatus: 'accepted' }];
  const meeting = (id, summary, date, from, to, extra = {}) => ({ id, summary, start: { dateTime: zoned(date, from) }, end: { dateTime: zoned(date, to) }, organizer: { email: ACCOUNT, self: true }, attendees: guests, ...extra });
  const world = defaultFakeWorld({ account: ACCOUNT, today, zone });
  world.granted = [...DEFAULT_SCOPES, ...CONTACTS_SCOPES];
  world.contacts = [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Andy Roe', email: 'andy@example.com' }];
  world.otherContacts = [{ name: 'Annika Berg', email: 'annika@example.org' }];
  world.events.primary.push(
    meeting('hretro', 'Harness retro', yesterday, 15, 16),
    meeting('hoo', 'Harness 1:1', tomorrow, 9, 9.5),
    meeting('hkickoff', 'Harness kickoff', tomorrow, 10, 11),
    meeting('hfocus', 'Harness focus', tomorrow, 13, 14, { transparency: 'transparent' }),
    meeting('hsolo', 'Harness dentist', tomorrow, 15, 15.5, { attendees: undefined }),
    meeting('hdemo', 'Harness demo day', inThree, 15, 16),
  );
  const fake = await startFakeGoogle(world);
  // The plan starts with the account's work and team calendars shown, and two channels.
  const seeded = [
    { type: 'settings.updated', patch: { timezone: zone } },
    { type: 'channel.created', channel: { id: 'work', name: 'work', color: '#e8590c', context: 'work' } },
    { type: 'channel.created', channel: { id: 'personal', name: 'personal', color: '#1c7ed6', context: 'personal' } },
    { type: 'calendar.added', calendar: { id: 'gcal-work', name: 'Harness work', url: 'https://calendar.google.com/calendar/r', color: '#039be5', google: { account: ACCOUNT, calendarId: 'primary' } } },
    { type: 'calendar.added', calendar: { id: 'gcal-team', name: 'Team', url: 'https://calendar.google.com/calendar/r', color: '#33b679', google: { account: ACCOUNT, calendarId: 'team@group.calendar.google.com' } } },
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: zoned(yesterday, 8), ...body }));
  const g = await startHarness({
    out,
    viewport,
    timezoneId: zone,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
  });
  const f = g.frame;
  const plannerErrors = [];
  g.page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  g.page.on('console', (entry) => {
    if (entry.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(entry.location().url ?? '')) plannerErrors.push(entry.text().slice(0, 300));
  });
  const shotHere = async (name) => {
    await g.page.waitForTimeout(250);
    await g.shot(`${name}-${size}`);
  };
  const latestState = async () => (await g.call('GET', '/state')).json.state;
  const until = async (test, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await test()) return true;
    return false;
  };
  const go = async (name) => {
    if (!(await g.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
    await g.nav(name).click();
  };
  const panel = () => f.locator('aside.source-panel');
  const eventTask = async (eventId) => Object.values((await latestState()).tasks).find((task) => task.source?.kind === 'event' && task.source.id === `${ACCOUNT}|primary|${eventId}`) ?? null;
  const column = (name) => f.locator(`section.day-column[aria-label^="${name}"]`).first();
  const card = (title) => f.locator('li.task-card', { has: f.locator('.task-title', { hasText: title }) }).first();
  const gridEvent = (title) => panel().locator('.grid-item.is-event', { hasText: title }).first();
  try {
    await g.openPlanner();
    await f.getByRole('heading', { name: 'Home' }).click();
    // Shift C: the calendar in the right-hand panel; a day's name at the top of its list shows that day there.
    await f.getByRole('navigation', { name: 'Sources' }).getByRole('tab', { name: 'Backlog', exact: true }).click();
    await f.getByRole('heading', { name: 'Home' }).click();
    await g.page.keyboard.press('Shift+C');
    check(`${size}: Shift C opens the calendar in the right-hand panel`, await until(async () => (await panel().getAttribute('aria-label').catch(() => '')) === 'Calendar'));
    await column('Tomorrow').locator('button.day-name').click();
    check(`${size}: a day's name at the top of its list shows that day's calendar in the panel`, await until(async () => (await panel().locator('.source-day-label').innerText().catch(() => '')).startsWith('Tomorrow')), await panel().locator('.source-day-label').innerText().catch(() => ''));
    await gridEvent('Harness kickoff').waitFor({ timeout: 20_000 });
    // Calendars, at the top of the calendar: which show (only what is shown changes).
    await panel().getByRole('button', { name: 'Calendars' }).click();
    const shownMenu = f.getByRole('menu', { name: 'Calendars shown' });
    await shownMenu.getByRole('checkbox', { name: 'Team' }).uncheck();
    check(`${size}: Calendars at the top of the panel's calendar hides one`, await until(async () => (await latestState()).calendars['gcal-team']?.visible === false));
    await shotHere('mt-01-calendars');
    await shownMenu.getByRole('checkbox', { name: 'Team' }).check();
    await panel().getByRole('button', { name: 'Calendars' }).click();

    // "Add to tasks" from an event's details: a task linked to the event, its length planned.
    await panel().getByRole('button', { name: 'Previous day' }).click();
    await gridEvent('Quarter planning').click();
    const details = f.getByRole('dialog', { name: 'Event: Quarter planning' });
    await details.getByRole('button', { name: 'Add to tasks' }).click();
    let planning = null;
    await until(async () => Boolean((planning = await eventTask('planning'))));
    check(`${size}: "Add to tasks" in an event's details adds it to its day, linked to the event, its length planned`, planning?.placement?.date === today && planning.plannedMinutes === 60 && planning.source.event?.invitees === true && !planning.source.event?.auto, JSON.stringify(planning?.source ?? null));
    check(`${size}: the event's details then say it is in your plan`, await details.getByRole('button', { name: /In your plan/ }).isVisible({ timeout: 5000 }).catch(() => false));
    await shotHere('mt-02-add-to-tasks');
    // Google Contacts: the event's account's contacts, and the people it emailed, as guests are typed.
    await details.getByRole('button', { name: 'Edit event' }).click();
    const editor = f.getByRole('dialog', { name: 'Edit event' });
    await editor.getByRole('combobox', { name: 'Add guests' }).or(editor.getByRole('textbox', { name: 'Add guests' })).fill('ann');
    const offered = await until(async () => (await editor.locator('datalist#ee-guest-contacts option').count()) >= 2, 10_000);
    const options = await editor.locator('datalist#ee-guest-contacts option').evaluateAll((items) => items.map((item) => `${item.textContent} <${item.value}>`));
    check(`${size}: typing a guest suggests the account's Google contacts and the people it emailed`, offered && options.join() === 'Ann Lee <ann@example.com>,Annika Berg <annika@example.org>', options.join());
    await shotHere('mt-03-contacts');
    await editor.getByRole('button', { name: 'Cancel' }).or(editor.getByRole('button', { name: 'Close' })).first().click();
    await f.getByRole('button', { name: 'Discard' }).click({ timeout: 2000 }).catch(() => {});

    // On hover: Add to tasks (yesterday's ended meeting), then completed when its event has ended (Always, at first).
    await panel().getByRole('button', { name: 'Previous day' }).click();
    await gridEvent('Harness retro').hover();
    await gridEvent('Harness retro').getByRole('button', { name: 'Add Harness retro as a task' }).click();
    let retro = null;
    await until(async () => Boolean((retro = await eventTask('hretro'))));
    await g.call('POST', '/meetings/sync');
    await until(async () => Boolean((retro = await eventTask('hretro'))?.completedAt));
    check(`${size}: added on hover; its event over, the task is completed (auto-complete: Always)`, Boolean(retro?.completedAt) && retro.completedOn === yesterday && !(await eventTask('planning'))?.completedAt === (Date.now() < Date.parse(zoned(today, 15))), JSON.stringify({ completedOn: retro?.completedOn ?? null }));

    // Daily planning, for tomorrow: "Fill in calendar events", the suggested ones ticked, the others saying why.
    await go('Daily planning');
    await f.getByRole('tablist', { name: 'Planning day' }).getByRole('tab', { name: 'Tomorrow' }).click();
    await f.getByRole('button', { name: 'Next', exact: true }).click();
    const fill = f.getByRole('region', { name: 'Fill in calendar events' });
    await fill.waitFor({ timeout: 20_000 });
    await fill.getByRole('button', { name: 'Pick events' }).click();
    const picks = await fill.locator('.meetings-pick li').evaluateAll((items) => items.map((item) => [item.querySelector('input')?.checked, item.textContent?.replace(/\s+/g, ' ').trim()]));
    const ticked = picks.filter(([on]) => on).map(([, text]) => text);
    const reasons = picks.filter(([on]) => !on).map(([, text]) => text);
    check(`${size}: the suggestions are tomorrow's meetings, ticked; the excluded kinds unticked, each saying why`,
      ticked.length === 2 && /Harness 1:1/.test(ticked[0]) && /Harness kickoff/.test(ticked[1]) && reasons.some((text) => /Vendor demo · events where attendance is not confirmed/.test(text)) && reasons.some((text) => /Harness focus · non-blocking events/.test(text)) && reasons.some((text) => /Harness dentist · events without other attendees/.test(text)),
      JSON.stringify(picks));
    await shotHere('mt-04-fill-in');
    await fill.getByRole('button', { name: 'Import 2 events' }).click();
    let tomorrowList = [];
    await until(async () => {
      const state = await latestState();
      tomorrowList = Object.values(state.tasks).filter((task) => !task.deletedAt && task.placement.kind === 'day' && task.placement.date === tomorrow).sort((a, b) => a.position - b.position).map((task) => task.title);
      return tomorrowList.length >= 2;
    });
    check(`${size}: the green button imports them, in time order`, tomorrowList.slice(0, 2).join() === 'Harness 1:1,Harness kickoff', tomorrowList.join());
    await go('Home');

    // Remove from tasks (right-click): off the list, the event left in the calendar.
    await card('Harness kickoff').click({ button: 'right' });
    await card('Harness kickoff').getByRole('menuitem', { name: 'Remove from tasks' }).click();
    const removed = await until(async () => Boolean((await eventTask('hkickoff'))?.deletedAt));
    check(`${size}: Remove from tasks takes it off the list and leaves the event in Google Calendar`, removed && fake.calendars.get('primary').events.has('hkickoff'));
    // An event task neither merges nor takes a merge (a task beside it, on its day).
    await column('Tomorrow').getByRole('button', { name: 'Add task' }).click();
    await column('Tomorrow').getByRole('textbox', { name: 'New task' }).fill('Harness notes');
    await column('Tomorrow').getByRole('textbox', { name: 'New task' }).press('Enter');
    await column('Tomorrow').getByRole('textbox', { name: 'New task' }).press('Escape').catch(() => {});
    await g.page.keyboard.down('Alt');
    await card('Harness notes').dragTo(card('Harness 1:1'));
    await g.page.keyboard.up('Alt');
    const refused = await f.getByRole('alert').filter({ hasText: 'Cannot merge events' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    await shotHere('mt-05-cannot-merge');
    check(`${size}: merging into an event says "Cannot merge events", and changes nothing`, refused && !(await latestState()).tasks[(await eventTask('hoo'))?.id ?? '']?.subtasks?.length && (await card('Harness notes').isVisible()));
    // …so an event task has no subtasks at all (Sunsama's FAQ): its details have no Add subtask, but Sunsama's advice
    // (a breakdown in its notes, or a separate task); a plain task's details have one.
    const details1 = f.getByRole('dialog', { name: 'Task details' });
    await card('Harness 1:1').getByRole('button', { name: 'Open Harness 1:1' }).click();
    await details1.waitFor({ timeout: 10_000 });
    const eventAdd = await details1.getByRole('textbox', { name: 'Add subtask' }).count();
    const advice = (await details1.getByRole('region', { name: 'Subtasks' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
    await shotHere('mt-05b-event-no-subtasks');
    await details1.getByRole('button', { name: 'Close' }).click();
    await card('Harness notes').getByRole('button', { name: 'Open Harness notes' }).click();
    const plainAdd = await details1.getByRole('textbox', { name: 'Add subtask' }).isVisible({ timeout: 5000 }).catch(() => false);
    await details1.getByRole('button', { name: 'Close' }).click();
    check(`${size}: an event task's details have no Add subtask, but Sunsama's advice (its notes, or a separate task); a plain task's have Add subtask`,
      eventAdd === 0 && advice.includes("Calendar event tasks can't have subtasks") && advice.includes('notes') && plainAdd, advice);
    // A task onto a task (Alt/Option + drop): merged in as a subtask with its planned time, the task gone.
    await column('Today').getByRole('button', { name: 'Add task' }).click();
    await column('Today').getByRole('textbox', { name: 'New task' }).fill('Harness inbox');
    await column('Today').getByRole('textbox', { name: 'New task' }).press('Enter');
    await column('Today').getByRole('textbox', { name: 'New task' }).fill('Harness reply ~15m');
    await column('Today').getByRole('textbox', { name: 'New task' }).press('Enter');
    await column('Today').getByRole('textbox', { name: 'New task' }).press('Escape').catch(() => {});
    await card('Harness reply').waitFor();
    await g.page.keyboard.down('Alt');
    await card('Harness reply').dragTo(card('Harness inbox'));
    await g.page.keyboard.up('Alt');
    let inbox = null;
    await until(async () => (inbox = Object.values((await latestState()).tasks).find((task) => task.title === 'Harness inbox'))?.subtasks?.length === 1);
    check(`${size}: a task dropped onto another with Alt/Option merges in as a subtask, its planned time kept, and is no longer a task`,
      inbox?.subtasks?.[0]?.title === 'Harness reply' && inbox.subtasks[0].plannedMinutes === 15 && !Object.values((await latestState()).tasks).some((task) => task.title === 'Harness reply' && !task.deletedAt), JSON.stringify(inbox?.subtasks ?? null));

    // A Google task merged into a task stays a synced Google task (Sunsama's merge, "Complete in Google Tasks" on):
    // its tick completes it in Google (its own subtask there first) and reopens it; its task's completion completes
    // it, and reopening the task reopens it.
    const inGoogle = (id) => fake.tasks.get('L1').find((task) => task.id === id)?.status ?? 'missing';
    await g.call('POST', '/commands', { commands: [{ cmd: `harness-gtrip-${size}`, type: 'task.created', task: { id: `harness-gtrip-${size}`, title: 'Plan the trip', placement: { kind: 'day', date: today }, position: 999_999, source: { kind: 'gtask', id: 't-trip', key: 'Google Tasks', url: 'https://tasks.google.com/task/t-trip', title: 'Plan the trip', status: { name: 'Open', type: 'open', color: '#1a73e8' }, account: ACCOUNT, listId: 'L1', notes: '' } } }] });
    await card('Plan the trip').waitFor({ timeout: 15_000 });
    await g.page.keyboard.down('Alt');
    await card('Plan the trip').dragTo(card('Harness inbox'));
    await g.page.keyboard.up('Alt');
    const tripMerged = await until(async () => Boolean(Object.values((await latestState()).tasks).find((task) => task.title === 'Harness inbox')?.subtasks?.some((subtask) => subtask.source?.kind === 'gtask' && subtask.source.id === 't-trip')));
    await card('Harness inbox').getByRole('button', { name: 'Open Harness inbox' }).click();
    const details2 = f.getByRole('dialog', { name: 'Task details' });
    const tripBox = details2.getByRole('checkbox', { name: 'Complete Plan the trip' });
    await tripBox.check();
    const tickedThere = await until(() => inGoogle('t-trip') === 'completed' && inGoogle('t-hotel') === 'completed');
    await shotHere('mt-05c-merged-google-ticked');
    await tripBox.uncheck();
    const untickedThere = await until(() => inGoogle('t-trip') === 'needsAction');
    check(`${size}: a Google task merged into a task (Alt/Option + drop): its tick completes it in Google Tasks (its subtask there first), unticking reopens it`,
      tripMerged && tickedThere && untickedThere, JSON.stringify({ tripMerged, trip: inGoogle('t-trip'), hotel: inGoogle('t-hotel') }));
    await details2.getByRole('button', { name: 'Close' }).click();
    await card('Harness inbox').getByRole('button', { name: 'Mark complete' }).click();
    const withTask = await until(() => inGoogle('t-trip') === 'completed');
    await shotHere('mt-05d-merged-google-with-task');
    await card('Harness inbox').getByRole('button', { name: 'Mark incomplete' }).click();
    const reopenedWithTask = await until(() => inGoogle('t-trip') === 'needsAction');
    const tripState = Object.values((await latestState()).tasks).find((task) => task.title === 'Harness inbox')?.subtasks?.find((subtask) => subtask.source?.id === 't-trip');
    check(`${size}: completing the task it is merged into completes it in Google Tasks; reopening the task reopens it there`,
      withTask && reopenedWithTask && tripState?.done === false && tripState.source?.status?.type === 'open', JSON.stringify({ withTask, reopenedWithTask, done: tripState?.done, status: tripState?.source?.status?.type }));

    // Settings → Meeting import: Auto-sync from the calendars chosen, with an import channel.
    await go('Settings');
    const settings = f.locator('fieldset', { has: f.locator('legend', { hasText: 'Meeting import' }) });
    await settings.getByRole('combobox', { name: /Configure how meetings get added/ }).selectOption('autoSync');
    check(`${size}: Auto-sync says calendars must be chosen first`, await settings.getByRole('alert').filter({ hasText: 'You must select Calendars to import from' }).isVisible({ timeout: 5000 }).catch(() => false));
    await settings.getByRole('group', { name: 'Calendars to import from' }).getByRole('checkbox', { name: /Harness work/ }).check();
    await settings.getByRole('combobox', { name: 'Import channel for Harness work' }).selectOption('work');
    let demo = null;
    await until(async () => Boolean((demo = await eventTask('hdemo'))), 20_000);
    check(`${size}: Auto-sync adds the week's meetings by itself, in the calendar's import channel`, demo?.placement?.date === inThree && demo.channelId === 'work' && demo.source.event?.auto === true, JSON.stringify(demo ? { date: demo.placement.date, channel: demo.channelId, auto: demo.source.event?.auto } : null));
    check(`${size}: a meeting removed from the tasks is not added back`, Boolean((await eventTask('hkickoff'))?.deletedAt));
    await settings.scrollIntoViewIfNeeded();
    await shotHere('mt-06-meeting-settings');
    // An exclusion turned off adds what it left out; on again, takes it off.
    const exclusions = settings.getByRole('group', { name: 'Exclude certain types of events' });
    await exclusions.getByRole('checkbox', { name: 'Exclude events where attendance is not confirmed' }).uncheck();
    const added = await until(async () => Boolean(await eventTask('invite')), 20_000);
    await exclusions.getByRole('checkbox', { name: 'Exclude events where attendance is not confirmed' }).check();
    const gone = await until(async () => Boolean((await eventTask('invite'))?.deletedAt), 20_000);
    check(`${size}: a changed exclusion adds or removes those meetings at once`, added && gone);
    await settings.getByRole('combobox', { name: 'Auto-complete imported calendar events' }).selectOption('invitees');
    check(`${size}: auto-complete can be Never or Only if the event has invitees`, await until(async () => (await latestState()).settings.meetingAutoComplete === 'invitees'));

    // Timeboxing Channel: #personal's sessions go to the Team calendar, though no default is set.
    const personal = f.getByRole('group', { name: 'Timeboxing channels' }).getByRole('combobox', { name: 'Calendar for #personal working sessions' });
    await personal.selectOption({ label: 'Team' });
    await until(async () => (await latestState()).settings.channelTimebox?.personal?.calendarId === 'team@group.calendar.google.com');
    await personal.scrollIntoViewIfNeeded();
    await shotHere('mt-07-timebox-channel');
    await go('Home');
    await column('Today').getByRole('button', { name: 'Add task' }).click();
    await column('Today').getByRole('textbox', { name: 'New task' }).fill('Harness errands #personal');
    await column('Today').getByRole('textbox', { name: 'New task' }).press('Enter');
    await column('Today').getByRole('textbox', { name: 'New task' }).press('Escape').catch(() => {});
    let errands = null;
    await until(async () => Boolean((errands = Object.values((await latestState()).tasks).find((task) => task.title === 'Harness errands'))));
    // Its session, as dragging it onto the calendar makes one.
    await g.call('POST', '/commands', { commands: [{ cmd: `harness-block-${size}`, type: 'block.created', block: { id: `hblock${size}`, taskId: errands.id, start: zoned(tomorrow, 8), end: zoned(tomorrow, 9) } }] });
    const teamEvents = () => [...fake.calendars.get('team@group.calendar.google.com').events.values()].map((event) => event.summary);
    const written = await until(() => teamEvents().includes('Harness errands'), 20_000);
    check(`${size}: a #personal task's session is written to the Team calendar (its Timeboxing Channel), none to the others`, written && ![...fake.calendars.get('primary').events.values()].some((event) => event.summary === 'Harness errands'), teamEvents().join());
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the meetings part ran to its end`, false, error?.stack ?? String(error));
    await shotHere('mt-failure').catch(() => {});
  } finally {
    await g.close();
    await fake.close();
  }
};

const parts = process.env.SUNSAMA_PARTS ?? 'all';
const wanted = (name) => parts === 'all' || parts.split(',').includes(name);
mkdirSync(out, { recursive: true });
for (const [name, part] of [['github', githubPart], ['gmail', gmailPart], ['meetings', meetingsPart]]) {
  if (wanted(name)) for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await part(viewport);
}
if (parts !== 'all') {
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
