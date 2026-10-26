// End-to-end check of the VS Code extension in the dev OpenChamber
// (containers/openchamber-dev: OpenChamber, and the VS Code Server as the
// `vscode` service). VS Code's own workbench must run inside OpenChamber's
// panel and page, with the project's files, an editor that saves, a terminal,
// search, source control and its diff, and nothing may open in another page.
// Run on the host: node extensions/vscode/tests/e2e/run.mjs [baseUrl] [outDir]
// Uses this package's playwright-core with the Chromium in ~/.cache/ms-playwright.
// The UI password and the VS Code token are read from the dev container's secrets
// file and never printed. The demo project's README, the extension's settings and
// the chats it makes are put back as they were.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:35310';
const out = process.argv[3] ?? '/tmp/opencode/vscode-e2e';
mkdirSync(out, { recursive: true });
const secrets = readFileSync(join(homedir(), '.local/share/oc-forge-openchamber-dev/secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)?.[1]?.trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)?.[1]?.trim();
if (!password || !token) throw new Error('secrets.env needs OPENCHAMBER_UI_PASSWORD and VSCODE_CONNECTION_TOKEN');
// The service reaches the VS Code Server inside the compose network.
const serverUrl = 'http://vscode:8000';
const project = '/home/node/projects/planner-demo-a';
const run = `vscode-e2e-${Date.now().toString(36)}`;
const marker = `${run} edited in the embedded VS Code`;

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const docker = (...args) => execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', ...args], { encoding: 'utf8' });
// VS Code's terminal runs where the VS Code Server runs: the `vscode` container (the home volume is shared, /tmp is not).
const inVscode = (...args) => execFileSync('docker', ['exec', 'oc-forge-vscode-dev', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const readme = docker('cat', `${project}/README.md`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const storage = (body) => context.request.post(`${base}/api/guests/oc-forge-vscode/storage`, { data: body });
const kept = {};
const sessions = [];
const problems = [];
const popups = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeout = 15_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await Promise.resolve().then(probe).catch(() => null);
    if (value) return value;
    if (Date.now() > end) return null;
    await wait(250);
  }
};
try {
  check('login', (await context.request.post(`${base}/auth/session`, { data: { password } })).status() === 200);
  const guests = await (await context.request.get(`${base}/api/guests`)).json();
  const guest = (Array.isArray(guests) ? guests : guests.guests ?? []).find((item) => item.id === 'oc-forge-vscode');
  const requested = guest?.capabilities?.requested ?? [];
  check('the extension is installed and enabled; it asks for its local service only', Boolean(guest?.enabled) && requested.length === 1 && requested[0] === 'service', JSON.stringify(guest?.capabilities ?? null));
  // The approval a user gives in Settings → Extensions.
  if (!requested.every((capability) => (guest.capabilities.granted ?? []).includes(capability))) {
    await context.request.put(`${base}/api/guests/oc-forge-vscode/capabilities`, { data: { granted: requested } });
  }
  for (const key of ['settings', 'folder', 'open-request', 'handled-open:panel', 'handled-open:page']) {
    kept[key] = (await (await storage({ op: 'get', key })).json()).value;
    await storage({ op: 'delete', key });
  }
  const sessionIn = async (directory) => {
    // OpenCode 2 takes the folder as the session's location and answers { data: session }.
    const created = await (await context.request.post(`${base}/api/session`, { data: { title: `${run} chat ${directory.split('/').pop()}`, location: { directory } } })).json();
    const id = created.data?.id ?? created.id;
    sessions.push({ id, directory });
    return id;
  };
  const session = await sessionIn(project);

  const page = await context.newPage();
  context.on('page', (opened) => popups.push(opened.url()));
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /\/(workbench|panel)\/main\.js/.test(message.location().url ?? '')) problems.push(`console: ${message.text()}`);
  });
  await page.goto(`${base}/?session=${session}`, { waitUntil: 'load' });

  // The rail panel: first the connection form, then VS Code itself.
  await page.locator('button[aria-label="VS Code"][data-context-surface]').first().click({ timeout: 20_000 });
  const panel = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
  await panel.getByRole('textbox', { name: 'VS Code Server address' }).fill(serverUrl, { timeout: 30_000 });
  await panel.getByLabel('VS Code Server connection token').fill(token);
  await panel.getByRole('button', { name: 'Connect' }).click();
  const started = Date.now();
  await panel.locator('.monaco-workbench').waitFor({ timeout: 180_000 });
  check('VS Code\'s workbench renders inside OpenChamber\'s panel', true, `${Date.now() - started} ms after Connect`);
  const explorerRow = panel.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' });
  await explorerRow.first().waitFor({ timeout: 60_000 });
  check("the Explorer lists the chat's folder from the VS Code Server", (await panel.locator('.explorer-folders-view').innerText()).includes('README.md'));
  const workbenchFrame = () => page.frames().find((frame) => frame.url().includes('/workbench/index.html'));
  const seti = await until(() => workbenchFrame()?.evaluate(() => [...document.fonts].some((font) => font.family.replace(/["']/g, '') === 'seti' && font.status === 'loaded')), 20_000);
  check("file icons load (VS Code's Seti font, through the extension's service)", Boolean(seti));
  check('the status bar names OpenChamber as the remote', (await panel.locator('.statusbar').innerText()).includes('OpenChamber'));
  await page.screenshot({ path: join(out, '01-panel.png') });

  // VS Code restores the editors of its last session; start from none.
  const command = async (title) => {
    await page.keyboard.press('Control+Shift+p');
    await panel.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
    await page.keyboard.type(title);
    await panel.locator('.quick-input-list .monaco-list-row', { hasText: title.replace(/^.*?: /, '') }).first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
  };
  await panel.locator('.monaco-workbench').click({ position: { x: 300, y: 300 } });
  await command('View: Close All Editors');
  await wait(800);

  // The editor: Quick Open, VS Code's grammar colors, typing and Ctrl+S on the server.
  await page.keyboard.press('Control+p');
  await panel.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
  await page.keyboard.type('README.md');
  await panel.locator('.quick-input-list .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  const editor = panel.locator('.editor-instance .monaco-editor[data-uri$="README.md"]').first();
  await editor.locator('.view-line').first().waitFor({ timeout: 20_000 });
  const tokenClasses = await until(async () => {
    // The heading gets a token color of its own once VS Code's TextMate grammar has run.
    const classes = await editor.locator('.view-line span span').evaluateAll((spans) => [...new Set(spans.map((span) => span.className).filter(Boolean))]);
    return classes.some((name) => /\bmtk(?!1\b)\d+/.test(name)) ? classes : null;
  }, 20_000);
  check('README.md opens in VS Code\'s editor, colored by its Markdown grammar', Boolean(tokenClasses), (tokenClasses ?? []).join(' '));
  await editor.locator('.view-line').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(marker);
  await page.keyboard.press('Control+s');
  const saved = await until(() => docker('cat', `${project}/README.md`).includes(marker), 20_000);
  check('Ctrl+S saves the edit on the VS Code Server', Boolean(saved));
  await page.screenshot({ path: join(out, '02-editor.png') });

  // Source control: the change and VS Code's diff editor.
  await page.keyboard.press('Control+Shift+g');
  const change = panel.locator('.scm-view .monaco-list-row', { hasText: 'README.md' }).first();
  await change.waitFor({ timeout: 30_000 });
  check('Source Control lists the changed file', true);
  await change.click({ position: { x: 24, y: 10 } });
  const diff = await until(() => panel.locator('.monaco-diff-editor').first().isVisible(), 20_000);
  check("clicking it opens VS Code's diff editor", Boolean(diff));
  await page.screenshot({ path: join(out, '03-scm-diff.png') });

  // Search across the folder.
  await page.keyboard.press('Control+Shift+f');
  await panel.locator('.search-view .monaco-inputbox textarea, .search-view .monaco-inputbox input').first().waitFor({ timeout: 10_000 });
  await page.keyboard.type(run);
  const hit = await until(() => panel.locator('.search-view .monaco-list-row', { hasText: 'README.md' }).first().isVisible(), 30_000);
  check('Search finds the text in the folder', Boolean(hit));
  await page.screenshot({ path: join(out, '04-search.png') });

  // The integrated terminal runs on the server.
  await page.keyboard.press('Control+Backquote');
  await panel.locator('.terminal-wrapper').first().waitFor({ timeout: 30_000 });
  await wait(2500);
  await page.keyboard.type(`echo ${run}-$((6*7)) > /tmp/${run}.txt`);
  await page.keyboard.press('Enter');
  const ran = await until(() => {
    try {
      return inVscode('cat', `/tmp/${run}.txt`).trim() === `${run}-42`;
    } catch {
      return false;
    }
  }, 20_000);
  check("the terminal runs commands on the VS Code Server's machine", Boolean(ran));
  await page.screenshot({ path: join(out, '05-terminal.png') });

  // Settings persist: the minimap goes off and stays off after the view reloads.
  const minimapShown = () => editor.locator('.minimap').first().isVisible().catch(() => false);
  await command('View: Close All Editors');
  await page.keyboard.press('Control+p');
  await page.keyboard.type('README.md');
  await panel.locator('.quick-input-list .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  await editor.locator('.view-line').first().waitFor({ timeout: 20_000 });
  const before = await minimapShown();
  await command('View: Toggle Minimap');
  await wait(1500);
  const toggled = (await minimapShown()) !== before;
  await wait(1500);
  await page.reload({ waitUntil: 'load' });
  const panelAgain = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
  if (!(await panelAgain.locator('.monaco-workbench').isVisible().catch(() => false))) await page.locator('button[aria-label="VS Code"][data-context-surface]').first().click({ timeout: 20_000 }).catch(() => {});
  await panelAgain.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  const reopened = await until(() => panelAgain.locator('.editor-instance .monaco-editor .view-line').first().isVisible(), 30_000);
  const persisted = reopened ? (await panelAgain.locator('.editor-instance .monaco-editor .minimap').first().isVisible().catch(() => false)) === !before : false;
  check('VS Code keeps its state across a reload (open editor, a toggled setting)', toggled && Boolean(reopened) && persisted, `toggled ${toggled}, editor reopened ${Boolean(reopened)}, setting kept ${persisted}`);

  // The full page: Extension pages → VS Code, in OpenChamber's main area.
  await page.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'VS Code' }).click({ timeout: 10_000 });
  // The page is the widest VS Code frame (the rail panel may be open beside it).
  const widest = await until(async () => {
    const frames = page.locator('iframe[title="VS Code"][src*="/workbench/index.html"]');
    let best = null;
    for (let index = 0; index < await frames.count(); index++) {
      const width = await frames.nth(index).evaluate((frame) => frame.getBoundingClientRect().width);
      if (!best || width > best.width) best = { index, width };
    }
    return best && best.width > 900 ? best : null;
  }, 30_000);
  const pageFrame = widest ? page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').nth(widest.index) : null;
  const pageReady = pageFrame ? await pageFrame.locator('.explorer-folders-view .monaco-list-row').first().waitFor({ timeout: 60_000 }).then(() => true).catch(() => false) : false;
  check('VS Code also fills an OpenChamber page', pageReady, widest ? `${Math.round(widest.width)} px wide` : 'no page frame');
  await page.screenshot({ path: join(out, '06-page.png') });
  await page.keyboard.press('Escape');

  // "Open in VS Code" on another chat shows that chat's folder in the panel.
  const other = '/home/node/projects/planner-demo-b';
  await sessionIn(other);
  // Opened from the sidebar, the chat takes its own project's folder.
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.getByText(`${run} chat planner-demo-b`, { exact: true }).first().click({ timeout: 20_000 });
  // The chat's own menu in the header (the sidebar has one per chat).
  await page.locator('header button[aria-label="Open session actions"]').first().click({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'Open in VS Code' }).click({ timeout: 10_000 });
  const panelOther = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
  const switched = await until(async () => (await panelOther.locator('.explorer-folders-view').innerText()).includes('planner-demo-b') || (await panelOther.locator('.explorer-viewlet').innerText()).toLowerCase().includes('planner-demo-b'), 60_000);
  check('"Open in VS Code" on a chat shows its folder in the VS Code panel', Boolean(switched));
  await page.screenshot({ path: join(out, '07-open-in-vscode.png') });

  check('nothing opened in another page or tab', popups.length === 0, popups.join(' '));
  check('no errors from the extension', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (error) {
  check('journey completed', false, String(error).split('\n')[0]);
  await context.pages()[0]?.screenshot({ path: join(out, '99-failure.png') }).catch(() => {});
} finally {
  for (const { id, directory } of sessions) await context.request.delete(`${base}/api/session/${id}?directory=${encodeURIComponent(directory)}`).catch(() => {});
  for (const [key, value] of Object.entries(kept)) {
    if (value !== undefined && value !== null) await storage({ op: 'set', key, value });
    else await storage({ op: 'delete', key });
  }
  try {
    execFileSync('docker', ['exec', '-i', 'oc-forge-openchamber-dev', 'sh', '-c', `cat > ${project}/README.md`], { input: readme });
    inVscode('rm', '-f', `/tmp/${run}.txt`);
  } catch (error) {
    console.log(`INFO cleanup: ${String(error).split('\n')[0]}`);
  }
  await browser.close();
}
const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
