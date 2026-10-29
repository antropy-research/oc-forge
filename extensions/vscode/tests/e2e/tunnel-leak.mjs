// The VS Code extension's connections to the VS Code Server end with its frames:
// a workbench opened in OpenChamber whose browser then goes away (a closed tab,
// the end of a test run) leaves no connection behind, so the server starts its
// reconnection grace and then frees that workbench's extension host. Until
// 2026-10-28 the service closed them with a WebSocket close(), which the server
// never answers, and the dev container kept 153 extension hosts (24.5 GiB).
// Runs against the stock instance of the adapters' scratch stack:
//
//   export WORK=/tmp/opencode/vscode-leak/e2e STACK_PORT_BASE=35370
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/vscode/tests/e2e/tunnel-leak.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// The stack copies this checkout's extensions when it starts (`up`), so build
// the extension first. Never prints the UI password or the VS Code token.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/oc-adapters/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-leak/screens';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
const base = `http://127.0.0.1:${BASE}`;
const vscodePort = BASE + 2;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const VSCODE = 'oc-forge-vscode';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (probe, timeout = 15_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await Promise.resolve().then(probe).catch(() => null);
    if (value) return value;
    if (Date.now() > end) return null;
    await wait(500);
  }
};
/** Connections open to the VS Code Server, counted on the clients' side. */
const connections = () => execFileSync('ss', ['-tnH', 'state', 'established', 'dport', '=', `:${vscodePort}`], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
const serverLog = () => readFileSync(join(work, 'vscode', 'vscode.log'), 'utf8');

const browser = await chromium.launch();
try {
  // ── Seed: the demo project, a chat in it, the VS Code extension installed ──
  const setup = await browser.newContext();
  const request = setup.request;
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  const project = join(work, 'stock/home/projects/demo');
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  if (!projects.some((entry) => entry.path === project)) {
    await request.put(`${base}/api/config/settings`, { data: { projects: [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }] } });
  }
  const chat = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: `tunnel-leak ${Date.now().toString(36)}`, location: { directory: project } } })).json();
  const chatId = (chat.data ?? chat).id;
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === VSCODE)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', 'vscode') } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
  }
  const health = async () => {
    const answer = await (await request.post(`${base}/api/guests/${VSCODE}/service/request`, { data: { method: 'GET', path: '/health' } })).json();
    return JSON.parse(answer.body ?? '{}');
  };
  // OpenCode can be slow to answer on a fresh instance: wait until it lists the chat.
  await until(async () => {
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`, { timeout: 10_000 })).json();
    return (Array.isArray(listed) ? listed : listed.data ?? []).some((session) => session.id === chatId);
  }, 120_000);

  // An earlier run's tunnels close once nobody has polled them for 45 s; until then its connections would count as
  // this run's, and their end as this run's end.
  const quiet = await until(async () => connections() === 0 && (await health()).tunnels === 0, 150_000);
  check('the VS Code Server is quiet before the run: no earlier connection left', quiet, `${connections()} open`);

  // ── 1. A workbench in OpenChamber's VS Code panel holds its connections ──
  const before = connections();
  const logBefore = serverLog().length;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  const page = await context.newPage();
  await page.goto(`${base}/?session=${chatId}`);
  await page.locator(`[data-context-surface="plugin:${VSCODE}"]`).click({ timeout: 120_000 });
  const panel = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
  const form = await panel.getByRole('textbox', { name: 'VS Code Server address' }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  if (form) {
    await panel.getByRole('textbox', { name: 'VS Code Server address' }).fill(`http://127.0.0.1:${vscodePort}`);
    await panel.getByLabel('VS Code Server connection token').fill(token);
    await panel.getByRole('button', { name: 'Connect' }).click();
  }
  const workbench = await panel.locator('.monaco-workbench').waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
  check("the VS Code panel loads VS Code's workbench through the service's tunnels", workbench);
  const listed = workbench && (await panel.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false));
  check("…and VS Code works over them: its Explorer lists the project's files", listed);
  const held = await until(() => connections() >= before + 2, 30_000);
  check('the workbench holds its connections to the VS Code Server (management, extension host)', held, `${connections() - before} open`);
  const live = await health();
  check("the service's /health counts them", live.tunnels >= 2 && live.sockets === live.tunnels, JSON.stringify(live));
  await page.screenshot({ path: join(out, '01-workbench.png') });

  // ── 2. The browser goes away: every connection ends, and the server starts its grace ──
  await context.close();
  const closedAt = Date.now();
  const ended = await until(() => connections() <= before, 150_000);
  check('with the browser gone, every connection to the VS Code Server ends (tunnels nobody polls are closed after 45 s)', ended, `${connections() - before} left after ${((Date.now() - closedAt) / 1000).toFixed(0)} s`);
  const after = await health();
  check("the service's /health shows no tunnel and no open socket left", after.tunnels === 0 && after.sockets === 0, JSON.stringify(after));
  const graced = await until(() => /The client has disconnected, will wait for reconnection/.test(serverLog().slice(logBefore)), 15_000);
  check("the VS Code Server sees the client gone and starts the grace after which it frees the workbench's extension host", graced);
  await setup.close();
} catch (error) {
  check('journey completed', false, String(error).split('\n')[0]);
} finally {
  await browser.close();
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
