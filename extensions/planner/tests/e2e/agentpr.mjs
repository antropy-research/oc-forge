// An assigned task, end to end, as GitHub and Linear do it: "Assign to an agent" hands a
// task to OpenCode's build agent in a new worktree; the agent follows the Planner's own
// instructions (commit, push, `gh pr create`); the Planner's service finds the pull
// request with gh and shows it on the task; once it is merged, the task offers to complete.
//
// In the dev container's real OpenChamber, on the installed Planner, with a real agent and
// the real gh. The agent is OpenCode's build agent on AGENTPR_MODEL (default
// openai/gpt-6-luna), through a Planner preset the journey adds and removes: OpenCode's free
// models stop at a daily limit, so the container's OpenCode needs a provider for it
// (containers/openchamber-dev/README.md, "A model for agents"). Only GitHub is fake: tests/e2e/fakeGithub.mjs
// runs in the container, and its gh (the agent's and the service's) reaches it through a
// Unix socket (a ~/.config/gh written for the run). planner-demo-a gets an origin whose
// fetch URL is https://github.com/harness-org/planner-demo-a (what gh reads) and whose
// push URL is the fake's git server in the container (http://127.0.0.1:<port>/…, into a
// bare repository; OpenChamber makes worktrees only for http(s) or ssh remotes). A model
// that cannot answer fails the run, and the journey says so. What it changes is put back
// at the end.
//
// Run on the host, with this checkout's extension built and installed in the container:
//   node extensions/planner/tests/e2e/agentpr.mjs [baseUrl] [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { defaultGithubWorld, ghConfigFiles } from './fakeGithub.mjs';

const base = process.argv[2] ?? 'http://100.116.120.66:35310';
const out = process.argv[3] ?? '/tmp/opencode/planner-agentpr';
mkdirSync(out, { recursive: true });
const CONTAINER = 'oc-forge-openchamber-dev';
const DEMO = '/home/node/projects/planner-demo-a';
const STATE = '/home/node/.planner-harness-github';
const BARE = `${STATE}/planner-demo-a.git`;
const SOCKET = `${STATE}/gh.sock`;
const GH_DIR = '/home/node/.config/gh';
const GH_SAVED = `${STATE}/gh-config-before`;
const OWNER = 'harness-org';
const REPO = 'planner-demo-a';
const FETCH_URL = `https://github.com/${OWNER}/${REPO}.git`;
const MODEL = process.env.AGENTPR_MODEL ?? 'openai/gpt-6-luna';
const PRESET = { id: 'agentpr-build', name: 'Build · agentpr', agent: 'build', model: MODEL };
const AGENT_MS = 15 * 60_000;
const QUIET_MS = 4 * 60_000;
// Its own prefix: other journeys clean up planner/harness-* and planner/e2e-* in the same project.
const run = `agentpr-${Date.now().toString(36)}`;
const title = `${run} add CONTRIBUTING.md`;
const branch = `planner/${run}`;
const LINE = 'Keep pull requests small and focused.';
const secrets = readFileSync(join(homedir(), '.local/share/oc-forge-openchamber-dev/secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)?.[1]?.trim();
if (!password) throw new Error('no UI password in secrets.env');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
};
const docker = (script, input) => execFileSync('docker', ['exec', ...(input === undefined ? [] : ['-i']), CONTAINER, 'sh', '-c', script], { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeState = () => {
  try {
    return JSON.parse(docker(`cat ${STATE}/state.json 2>/dev/null || echo null`));
  } catch {
    return null;
  }
};

/**
 * Put the container back: the fake stopped, gh's config as it was (none, in the dev
 * container), planner-demo-a without the origin the run gave it, and the run's folder gone.
 * Also run first, for anything an interrupted run left.
 */
const restoreContainer = () => {
  docker(`[ -f ${STATE}/state.json ] && kill "$(node -e 'console.log(require(process.argv[1]).pid)' ${STATE}/state.json)" 2>/dev/null; true`);
  docker(`if grep -qs ${quote(`http_unix_socket: ${SOCKET}`)} ${GH_DIR}/config.yml; then rm -rf ${GH_DIR}; fi; if [ -d ${GH_SAVED} ] && [ ! -e ${GH_DIR} ]; then mv ${GH_SAVED} ${GH_DIR}; fi; true`);
  docker(`cd ${DEMO} && if [ "$(git config --get remote.origin.url)" = ${quote(FETCH_URL)} ]; then git remote remove origin; fi; true`);
  docker(`[ -e ${GH_SAVED} ] || rm -rf ${STATE}; true`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const serviceCall = async (method, path, body) => {
  const response = await context.request.post(`${base}/api/guests/oc-forge-planner/service/request`, { data: { method, path, ...(body ? { body: JSON.stringify(body) } : {}) } });
  const outer = await response.json().catch(() => ({}));
  return JSON.parse(outer.body ?? outer.result?.body ?? '{}');
};
const serviceState = () => serviceCall('GET', '/state');
const waitForState = async (predicate, timeout) => {
  const end = Date.now() + timeout;
  let latest = await serviceState();
  while (!predicate(latest) && Date.now() < end) {
    await sleep(1000);
    latest = await serviceState();
  }
  return latest;
};
const taskOf = (latest) => Object.values(latest.state?.tasks ?? {}).find((task) => task.title === title && !task.deletedAt);
const runOf = (latest) => Object.values(latest.state?.runs ?? {}).find((item) => item.taskId === taskOf(latest)?.id);
const messagesOf = async (item) => {
  const directory = item.worktree?.directory ?? item.directory ?? '';
  const response = await context.request.get(`${base}/api/session/${item.sessionId}/message?directory=${encodeURIComponent(directory)}`);
  const body = await response.json().catch(() => null);
  return (Array.isArray(body) ? body : body?.data ?? []);
};
/** The shell commands the agent ran, from its chat (whatever shape the messages have). */
const commandsIn = (messages) => [...JSON.stringify(messages).matchAll(/"command":"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));

/** The run's task, chats, worktree and branch (the Planner's own data and OpenChamber's). */
const cleanUpRun = async () => {
  try {
    const { state } = await serviceState();
    const tasks = Object.values(state?.tasks ?? {}).filter((task) => /^agentpr-/.test(task.title) && !task.deletedAt);
    const runs = Object.values(state?.runs ?? {}).filter((item) => tasks.some((task) => task.id === item.taskId));
    const chats = new Map();
    for (const item of runs) {
      const directory = item.worktree?.directory ?? item.directory ?? '';
      chats.set(item.sessionId, directory);
      // The empty "Worktree for …" chat that made the worktree is the run's too.
      if (item.worktree?.directory) {
        const listed = await context.request.get(`${base}/api/session?directory=${encodeURIComponent(directory)}`).then((response) => response.json()).catch(() => null);
        for (const session of Array.isArray(listed) ? listed : listed?.data ?? []) {
          if (session?.id && (session.directory ?? session.location?.directory) === directory) chats.set(session.id, directory);
        }
      }
    }
    for (const [id, directory] of chats) {
      const response = await context.request.delete(`${base}/api/session/${id}?directory=${encodeURIComponent(directory)}`).catch(() => null);
      console.log(`INFO deleted chat ${id}: ${response?.status() ?? 'failed'}`);
    }
    const presets = state?.settings?.agentPresets ?? [];
    const commands = [
      ...runs.map((item) => ({ cmd: `cleanup-${item.id}`, type: 'run.removed', runId: item.id })),
      ...tasks.map((task) => ({ cmd: `cleanup-${task.id}`, type: 'task.deleted', taskId: task.id })),
      // The journey's preset, and with it its OpenCode command.
      ...(presets.some((preset) => preset.id === PRESET.id) ? [{ cmd: `cleanup-preset-${Date.now().toString(36)}`, type: 'settings.updated', patch: { agentPresets: presets.filter((preset) => preset.id !== PRESET.id) } }] : []),
    ];
    if (commands.length) await serviceCall('POST', '/commands', { commands });
  } catch (error) {
    console.log(`INFO Planner cleanup: ${String(error).split('\n')[0]}`);
  }
  try {
    docker(`cd ${DEMO} && git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\\/heads\\/planner\\/agentpr-/{print w}' | while read w; do git worktree remove --force "$w"; done; git worktree prune; git branch --list 'planner/agentpr-*' | xargs -r git branch -D >/dev/null; true`);
    console.log(`INFO ${DEMO}: ${docker(`cd ${DEMO} && git worktree list | wc -l`).trim()} worktree(s), ${docker(`cd ${DEMO} && git branch --list 'planner/agentpr-*' | wc -l`).trim()} run branch(es) left`);
  } catch (error) {
    console.log(`INFO worktree cleanup: ${String(error).split('\n')[0]}`);
  }
};

try {
  const login = await context.request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login: status ${login.status()}`);
  await cleanUpRun();
  restoreContainer();

  // The container: a bare "GitHub" repository, planner-demo-a's origin, the fake, and gh pointed at it.
  const origin = docker(`cd ${DEMO} && git remote get-url origin 2>/dev/null; true`).trim();
  if (origin) throw new Error(`${DEMO} already has an origin (${origin}); this journey only adds its own`);
  if (docker(`[ -e ${GH_DIR} ] && echo yes || echo no`).trim() === 'yes') docker(`mkdir -p ${STATE} && mv ${GH_DIR} ${GH_SAVED}`);
  docker(`mkdir -p ${STATE} && git init -q --bare -b main ${BARE}`);
  docker(`cat > ${STATE}/fakeGithub.mjs`, readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fakeGithub.mjs'), 'utf8'));
  docker(`cat > ${STATE}/world.json`, JSON.stringify(defaultGithubWorld({ owner: OWNER, repo: REPO, bare: BARE })));
  execFileSync('docker', ['exec', '-d', CONTAINER, 'node', `${STATE}/fakeGithub.mjs`, SOCKET, `${STATE}/state.json`, `${STATE}/world.json`, '0']);
  for (let i = 0; i < 50 && !fakeState()?.gitPort; i++) await sleep(200);
  const pushUrl = `http://127.0.0.1:${fakeState()?.gitPort}/${OWNER}/${REPO}.git`;
  docker(`cd ${DEMO} && git remote add origin ${FETCH_URL} && git remote set-url --push origin ${pushUrl} && git push -q origin main`);
  const files = ghConfigFiles(SOCKET);
  docker(`mkdir -p ${GH_DIR} && chmod 700 ${GH_DIR} && umask 077 && cat > ${GH_DIR}/config.yml`, files['config.yml']);
  docker(`umask 077 && cat > ${GH_DIR}/hosts.yml`, files['hosts.yml']);
  const listed = docker(`cd ${DEMO} && gh pr list --state all --json number 2>&1; true`).trim();
  check("the container's gh reaches the fake GitHub for planner-demo-a's origin", listed === '[]', listed);

  // A model the agent can run on: its provider in the container's OpenCode, and a preset naming it.
  const providers = await context.request.get(`${base}/api/provider`).then((response) => response.json()).catch(() => null);
  const providerIds = Object.values(providers?.data ?? providers ?? {}).map((provider) => provider?.id);
  if (!providerIds.includes(MODEL.split('/')[0])) throw new Error(`the container's OpenCode has no provider ${MODEL.split('/')[0]} for ${MODEL} (it has ${providerIds.join(', ') || 'none'}): connect one, see containers/openchamber-dev/README.md`);
  const before = (await serviceState()).state?.settings?.agentPresets ?? [];
  await serviceCall('POST', '/commands', { commands: [{ cmd: `agentpr-preset-${run}`, type: 'settings.updated', patch: { agentPresets: [...before.filter((preset) => preset.id !== PRESET.id), PRESET] } }] });

  // Restart the Planner's service so it runs the installed build, then open the Planner.
  for (const enabled of [false, true]) await context.request.put(`${base}/api/guests/oc-forge-planner/enabled`, { data: { enabled } });
  await page.goto(`${base}/`, { waitUntil: 'load' });
  const frame = page.frameLocator('.inset-0 > iframe[title="Planner"]');
  const openPlanner = async () => {
    await page.goto(`${base}/`, { waitUntil: 'load' });
    const home = frame.getByRole('heading', { name: 'Home' });
    if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
      await page.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
      await page.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
      await home.waitFor({ timeout: 30_000 });
    }
  };
  await openPlanner();
  const nav = (name) => frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
  await nav('Home').click();
  const today = frame.locator('section.day-column.is-today');
  await today.getByRole('button', { name: /Add task/ }).click();
  const box = today.getByRole('textbox', { name: 'New task' });
  await box.fill(title);
  await box.press('Enter');
  await box.press('Escape');
  const card = today.locator('li.task-card', { hasText: title });
  await card.getByRole('button', { name: `Open ${title}` }).click();
  const detail = frame.getByRole('dialog', { name: 'Task details' });
  const notes = `Add a file named CONTRIBUTING.md at the root of the repository, with exactly this one line:\n${LINE}\nChange nothing else.`;
  await detail.getByRole('textbox', { name: 'Notes' }).fill(notes);
  await detail.getByRole('textbox', { name: 'Notes' }).blur();
  await waitForState((latest) => taskOf(latest)?.notes === notes, 10_000);

  // Assign it, as in GitHub or Linear: the build agent, planner-demo-a, a new worktree on the run's branch.
  await detail.getByRole('button', { name: 'Assign with options…' }).click();
  const form = detail.getByRole('group', { name: 'Assign to an agent' });
  await form.getByRole('combobox', { name: 'Agent project' }).selectOption({ label: 'planner-demo-a' });
  await form.getByRole('button', { name: 'Agent', exact: true }).click();
  await frame.getByRole('dialog', { name: 'Choose the agent' }).getByRole('option', { name: PRESET.name, exact: true }).click();
  await form.getByRole('textbox', { name: 'Worktree branch' }).fill(branch);
  await form.getByRole('button', { name: 'Edit the instructions' }).click();
  const instructions = await form.getByRole('textbox', { name: 'Agent prompt' }).inputValue();
  check("the agent gets the Planner's own instructions: the task, its notes, then push and gh pr create", instructions.includes(LINE) && instructions.includes(`branch \`${branch}\``) && instructions.includes('gh pr create'), instructions.slice(-200).replace(/\s+/g, ' '));
  await shot('agentpr-01-assign');
  await form.getByRole('button', { name: 'Assign', exact: true }).click();
  const started = await waitForState((latest) => Boolean(runOf(latest)?.sessionId), 240_000);
  const item = runOf(started);
  check(`the run works in a new worktree on its branch, as the build agent on ${MODEL}, and expects a pull request`, item?.worktree?.branch === branch && item.assignee?.agent === 'build' && item.assignee?.model === MODEL && item.wantsPr === true, JSON.stringify({ branch: item?.worktree?.branch, assignee: item?.assignee, wantsPr: item?.wantsPr }));
  if (!item?.sessionId) throw new Error('no run started');

  // The agent works: wait for its pull request, or its error, or a long silence.
  const begun = Date.now();
  let pull = null;
  let messages = [];
  let lastSize = -1;
  let lastChange = Date.now();
  let failure = '';
  while (Date.now() - begun < AGENT_MS) {
    pull = fakeState()?.pulls?.find((candidate) => candidate.headRefName === branch) ?? null;
    messages = await messagesOf(item).catch(() => messages);
    const size = JSON.stringify(messages).length;
    if (size !== lastSize) [lastSize, lastChange] = [size, Date.now()];
    const failed = messages.map((message) => message.info ?? message).find((message) => (message.type === 'assistant' || message.role === 'assistant') && message.error);
    if (failed) failure = `the model failed: ${JSON.stringify(failed.error).slice(0, 300)}`;
    if (pull || failure || Date.now() - lastChange > QUIET_MS) break;
    await sleep(10_000);
  }
  const ran = commandsIn(messages);
  console.log(`INFO the agent ran ${ran.length} command(s) in ${Math.round((Date.now() - begun) / 1000)} s:\n${ran.map((command) => `       $ ${command.split('\n')[0].slice(0, 160)}`).join('\n')}`);
  check('the agent pushed its branch and opened a pull request with gh', Boolean(pull) && ran.some((command) => /\bgh\s+pr\s+create\b/.test(command)), failure || (pull ? pull.url : 'no pull request'));
  if (!pull) throw new Error(failure || 'the agent opened no pull request');
  const pushed = (fakeState()?.requests ?? []).some((request) => request.operation === 'git git-receive-pack');
  check("the branch reached the fake GitHub's git server (git push over its http push URL)", pushed);
  const changed = docker(`git --git-dir=${BARE} diff --name-only main ${quote(branch)}`).trim();
  const content = docker(`git --git-dir=${BARE} show ${quote(`${branch}:CONTRIBUTING.md`)} 2>/dev/null; true`);
  check('its commits on the branch are in the repository: CONTRIBUTING.md with the line asked for', changed.split('\n').includes('CONTRIBUTING.md') && content.includes(LINE), `${changed.replace(/\n/g, ', ')}: ${content.trim().slice(0, 80)}`);
  check('the pull request goes from the run branch into main, with a title and a description', pull.headRefName === branch && pull.baseRefName === 'main' && pull.title.trim().length > 0 && pull.body.trim().length > 0, JSON.stringify({ title: pull.title, body: pull.body.slice(0, 120) }));

  // The agent's turn ends with the pull request's URL (or let it finish talking).
  const replied = async () => JSON.stringify(await messagesOf(item).catch(() => [])).includes(pull.url);
  for (let i = 0; i < 36 && !(await replied()); i++) await sleep(5000);
  check("the agent's reply names the pull request", await replied());

  // The Planner looks it up with gh: by the run's branch in its worktree (gh pr list --head), or by the URL the
  // agent linked to its chat (gh pr view <url>). A freshly opened Planner does it within seconds.
  await openPlanner();
  const withPull = await waitForState((latest) => runOf(latest)?.pullRequest?.url === pull.url, 60_000);
  const requests = fakeState()?.requests ?? [];
  const opened = requests.findIndex((request) => request.operation === 'mutation PullRequestCreate');
  const lookups = requests.slice(opened + 1).filter((request) => (request.operation === 'query PullRequestList' && request.variables?.headBranch === branch) || (request.operation === 'query PullRequestByNumber' && request.variables?.pr_number === pull.number));
  check(
    "the Planner's service finds it with gh (by the run's branch, or the URL the agent linked) and logs it on the run",
    runOf(withPull)?.pullRequest?.state === 'open' && runOf(withPull).pullRequest.number === pull.number && lookups.length > 0,
    `${JSON.stringify(runOf(withPull)?.pullRequest ?? null)}; gh lookups: ${[...new Set(lookups.map((request) => request.operation))].join(', ') || 'none'}`,
  );
  await nav('Home').click();
  await card.getByRole('button', { name: `Open ${title}` }).click();
  const chip = detail.getByRole('button', { name: `Open pull request ${OWNER}/${REPO}#${pull.number} (Open)` });
  check('the task shows the pull request, as GitHub and Linear show an agent\'s', await chip.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  await detail.locator('li.run-row').first().scrollIntoViewIfNeeded().catch(() => {});
  await shot('agentpr-02-task-pr');
  await detail.getByRole('button', { name: 'Close' }).click();
  await nav('Agents').click();
  const agentRow = frame.locator('li.agent-task', { hasText: title });
  check('the Agents page lists the run with its pull request', await agentRow.getByRole('button', { name: `Open pull request ${OWNER}/${REPO}#${pull.number} (Open)` }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  await shot('agentpr-03-agents');

  // The agent's chat in OpenChamber.
  await agentRow.getByRole('button', { name: 'Open chat' }).first().click().catch(() => {});
  await page.waitForTimeout(3000);
  await shot('agentpr-04-chat');

  // Merged on GitHub: the Planner sees it and offers to complete the task.
  const merged = docker(`cd ${DEMO} && gh api -X PUT repos/${OWNER}/${REPO}/pulls/${pull.number}/merge --jq .merged 2>&1; true`).trim();
  await openPlanner();
  const afterMerge = await waitForState((latest) => runOf(latest)?.pullRequest?.state === 'merged', 60_000);
  await nav('Agents').click();
  const complete = frame.locator('li.agent-task', { hasText: title }).getByRole('button', { name: 'Merged: complete the task' });
  const offered = await complete.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  await shot('agentpr-05-merged');
  if (offered) await complete.click();
  const completed = await waitForState((latest) => Boolean(taskOf(latest)?.completedAt), 10_000);
  check('once merged, the run says so and completes the task', merged === 'true' && runOf(afterMerge)?.pullRequest?.state === 'merged' && offered && Boolean(taskOf(completed)?.completedAt), `merge: ${merged}; state: ${runOf(afterMerge)?.pullRequest?.state}`);
} catch (error) {
  check('the journey ran to the end', false, String(error).split('\n').slice(0, 3).join(' '));
  await shot('agentpr-99-error').catch(() => {});
} finally {
  await cleanUpRun();
  try {
    restoreContainer();
    console.log(`INFO gh config left in the container: ${docker(`[ -e ${GH_DIR} ] && echo yes || echo no`).trim()}; planner-demo-a remotes: [${docker(`cd ${DEMO} && git remote | tr '\\n' ' '`).trim()}]; fake running: ${docker(`[ -e ${SOCKET} ] && echo yes || echo no`).trim()}`);
  } catch (error) {
    console.log(`INFO container restore: ${String(error).split('\n')[0]}`);
  }
  await browser.close();
}
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
