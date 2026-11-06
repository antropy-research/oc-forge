// The chat's agent in the browser, on this checkout's build (harness.mjs): Ask Planner, Braindump's Organize with the
// agent and Daily highlights' Summarize each start a chat in the dev container's OpenChamber, beside the Planner, whose
// first message carries the request and the Planner's command line. Those first messages are held here, so no model
// runs and nothing reaches the container's real plan; the journey runs the command line on the host as each chat's
// agent would (OPENCODE_SESSION_ID). The Planner shows the agent's changes; Ask Planner lists them under the request
// and takes them back. The chats are deleted at the end.
// Run on the host: node extensions/planner/tests/e2e/ask.mjs [outDir]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { startHarness } from './harness.mjs';
import { PLANNER_FRAME } from './panel.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-ask-journey';
const h = await startHarness({ out });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${String(detail).slice(0, 300)})`}`);
};
const waitFor = async (probe, timeout = 20_000) => {
  for (const end = Date.now() + timeout; ; await new Promise((resolve) => setTimeout(resolve, 250))) {
    const value = await probe();
    if (value || Date.now() > end) return value;
  }
};
const tag = `harness-ask-${Date.now().toString(36)}`;
const request = `${tag}: add a 15 minute email task for today`;
const MARK = 'Ask Planner: this is about my plan';
/** The chats' first messages, held: whatever path carries them, they never reach OpenCode. */
const held = [];
/** The runs the journey started, for their chats to be deleted at the end. */
const chats = [];
/** The run of the request `label`, once the Planner knows its chat. */
const runOf = (label) => waitFor(async () => (await h.call('GET', '/ask/runs')).json?.runs.find((entry) => entry.request === label && entry.sessionId));
/** The command line, as the agent of `run`'s chat runs it with its shell. */
const agentOf = (run) => (...args) => spawnSync(join(h.home, 'bin', 'planner'), args, { env: { PATH: process.env.PATH, HOME: h.home, OPENCODE_SESSION_ID: run?.sessionId ?? '' }, encoding: 'utf8', timeout: 20_000 });
try {
  await h.context.route((url) => /^\/api\/session\/[^/]+\/.+/.test(new URL(url).pathname), async (route) => {
    const sent = route.request();
    if (sent.method() !== 'POST' || !(sent.postData() ?? '').includes(MARK)) return route.fallback();
    held.push({ path: new URL(sent.url()).pathname, body: sent.postData() ?? '' });
    await route.fulfill({ status: 204, body: '' });
  });

  // ASK_TRACE=1: every answer of 400 or more, by path.
  if (process.env.ASK_TRACE) h.page.on('response', (response) => response.status() >= 400 && console.error(`TRACE ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname} ${(response.request().postData() ?? '').slice(0, 200)}`));
  await h.openPlanner();
  await h.frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Ask Planner' }).click();
  const dialog = h.frame.getByRole('dialog', { name: 'Ask Planner' });
  check('Ask Planner says where the request goes', (await dialog.innerText()).includes('Goes to the agent you chat with, in a new chat beside the Planner'));
  await dialog.getByRole('textbox', { name: 'Ask Planner' }).fill(request);
  await h.shot('ask-1-dialog');
  await dialog.getByRole('button', { name: 'Ask', exact: true }).click();

  const first = await waitFor(() => held[0]);
  check('the chat\'s first message carries the request and the Planner\'s command line', Boolean(first?.body.includes(request) && first.body.includes(`${join(h.home, 'bin', 'planner')} help`)), first ? first.path : 'no first message seen');
  const run = await runOf(request);
  if (run) chats.push(run);
  check('the Planner knows which chat the Ask became', Boolean(run?.sessionId), JSON.stringify(run));
  check('the dialog closed, and the Planner stays beside the chat', (await waitFor(async () => !(await dialog.isVisible()) && (await h.page.locator(PLANNER_FRAME).first().isVisible()), 10_000)) === true);
  await h.shot('ask-2-chat');

  // The chat's agent, as OpenCode's shell runs the command.
  const agent = agentOf(run);
  const added = agent('add', `${tag} email`, '--minutes', '15');
  check('the agent adds a task with the command line', added.status === 0 && /^Added ".+ email" for today \(0:15\)/.test(added.stdout), added.stderr || added.stdout);
  await h.nav('Today').click();
  const card = h.frame.locator('li.task-card', { hasText: `${tag} email` });
  check('the Planner shows the agent\'s change', await card.first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await h.shot('ask-3-change');

  await h.frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Ask Planner' }).click();
  const recent = h.frame.getByRole('region', { name: 'Recent asks' });
  const row = recent.locator('li.assistant-run', { hasText: request });
  check('Ask Planner lists the request with what its agent changed', await row.getByText(`Added "${tag} email" for today (0:15)`).waitFor({ timeout: 10_000 }).then(() => true, () => false));
  check('it can open the chat', await row.getByRole('button', { name: 'Open chat' }).isVisible());
  await h.shot('ask-4-recent');
  await row.getByRole('button', { name: 'Undo its change' }).click();
  check('Undo its change takes the task back', await card.first().waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false));
  check('the change shows as taken back', await row.locator('li.undone', { hasText: `${tag} email` }).waitFor({ timeout: 10_000 }).then(() => true, () => false));
  const plan = (await h.call('GET', '/state')).json.state;
  check('the plan has the task no more', !Object.values(plan.tasks).some((task) => task.title === `${tag} email` && !task.deletedAt));
  await h.shot('ask-5-undone');
  await h.frame.getByRole('dialog', { name: 'Ask Planner' }).getByRole('textbox', { name: 'Ask Planner' }).press('Escape');

  // Braindump: Organize with the agent hands the notes to a chat of their own.
  await h.nav('Backlog').click();
  await h.frame.getByRole('button', { name: 'Braindump' }).click();
  const dump = h.frame.getByRole('dialog', { name: 'Braindump' });
  const notes = `${tag} buy paint ~30m\n${tag} call the plumber about the leak`;
  await dump.getByRole('textbox', { name: 'Brain dump' }).fill(notes);
  await dump.getByRole('button', { name: 'Organize with the agent' }).click();
  const dumped = await waitFor(() => held.find((entry) => entry.body.includes('Braindump: turn my notes below into tasks')));
  check('Braindump hands the notes to the agent, with the command line', Boolean(dumped?.body.includes(`${tag} call the plumber about the leak`) && dumped.body.includes(`${join(h.home, 'bin', 'planner')} help`)), dumped?.path ?? 'no first message seen');
  const dumpRun = await runOf(`Braindump: ${tag} buy paint ~30m`);
  if (dumpRun) chats.push(dumpRun);
  check('the Braindump\'s chat is named for its notes, and the dialog closed', Boolean(dumpRun) && !(await dump.isVisible()));
  const painted = agentOf(dumpRun)('add', `${tag} Buy paint`, '--minutes', '30', '--when', 'next-weeks');
  check('its agent adds the tasks with the command line', painted.status === 0, painted.stderr || painted.stdout);
  check('the Backlog shows them', await h.frame.locator('li.task-card', { hasText: `${tag} Buy paint` }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await h.shot('ask-6-braindump');

  // Daily highlights: Summarize hands the day to a chat; its agent saves the summary on the page.
  const { today } = (await h.call('GET', '/health')).json;
  const done = `harness-${Date.now().toString(36)}`;
  await h.call('POST', '/commands', { commands: [{ cmd: `${done}a`, type: 'task.created', task: { id: `${done}t`, title: `${tag} shipped the calendar`, placement: { kind: 'day', date: today }, position: 1 } }, { cmd: `${done}b`, type: 'task.completed', taskId: `${done}t`, on: today }] });
  await h.nav('Daily highlights').click();
  await h.frame.getByRole('heading', { name: 'Daily highlights' }).waitFor();
  // A highlight is an editable field: find it by its star, which is named for it.
  await h.frame.getByRole('button', { name: `Star ${tag} shipped the calendar` }).waitFor({ timeout: 15_000 });
  await h.frame.getByRole('button', { name: 'Summarize with the agent' }).click();
  const asked = await waitFor(() => held.find((entry) => entry.body.includes('Daily highlights: write the summary of my workday')));
  check('Summarize hands the day to the agent, with where the summary goes', Boolean(asked?.body.includes(`planner summary ${today}`)), asked?.path ?? 'no first message seen');
  const summaryRun = await waitFor(async () => (await h.call('GET', '/ask/runs')).json?.runs.find((entry) => entry.request?.startsWith('Highlights summary:') && entry.sessionId && !chats.some((known) => known.id === entry.id)));
  if (summaryRun) chats.push(summaryRun);
  const wrote = agentOf(summaryRun)('summary', today, `I shipped the calendar (${tag}).`);
  check('its agent saves the summary with the command line', wrote.status === 0, wrote.stderr || wrote.stdout);
  const summary = await waitFor(async () => (await h.frame.getByRole('textbox', { name: 'Summary' }).inputValue().catch(() => '')) === `I shipped the calendar (${tag}).`, 15_000);
  check('the page shows the summary', summary === true);
  await h.shot('ask-7-highlights');

  // A status the host answered (OpenChamber's own source-control binding answers 422 for the demo folder) is no error
  // of the page's, as in linear.mjs.
  const errors = h.problems.filter((problem) => !/favicon|ERR_ABORTED|Failed to load resource/.test(problem));
  check('no page errors', errors.length === 0, errors.join('; '));
} catch (error) {
  check('the journey ran to its end', false, error instanceof Error ? error.stack : String(error));
} finally {
  for (const chat of chats) await h.context.request.delete(`${h.base}/api/session/${encodeURIComponent(chat.sessionId)}${chat.directory ? `?directory=${encodeURIComponent(chat.directory)}` : ''}`).catch(() => {});
  await h.close();
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${failed ? 'FAIL' : 'PASS'} ask.mjs: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
