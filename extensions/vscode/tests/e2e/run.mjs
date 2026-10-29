// End-to-end check of the VS Code extension in the dev OpenChamber
// (containers/openchamber-dev: OpenChamber, and the VS Code Server as the
// `vscode` service). VS Code's own workbench must run inside OpenChamber, with
// the project's files and their icons, an editor with VS Code's grammars that
// saves, Markdown's preview, source control and its diff, search, a terminal,
// its state across a reload, and "Open in VS Code" on a chat; OpenChamber's
// own editor must still open a search hit at its line, and nothing may open in
// another page. Where those are depends on the host, which its catalog tells
// (an adapted server publishes the extension's `ocForge` block):
//   - an OpenChamber with oc-forge's adapters (the dev image since 2026-10-28):
//     VS Code's Explorer, Source Control and Search are rail entries, a file is
//     a header tab on the editor page, the terminal is at the bottom;
//   - a stock OpenChamber: the whole workbench in its panel, and in a page.
// Run on the host: node extensions/vscode/tests/e2e/run.mjs [baseUrl] [outDir]
// (inside the private network namespace while Docker builds run: see the
// adapters' README). Uses this package's playwright-core with the Chromium in
// ~/.cache/ms-playwright. The UI password and the VS Code token are read from
// the dev container's secrets file and never printed. The demo project's
// README, the extension's settings, the chats, tabs and terminal it makes, and
// (on a stock host) the minimap setting it toggles are put back as they were.
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
const VSCODE = 'oc-forge-vscode';
const project = '/home/node/projects/planner-demo-a';
const projectB = '/home/node/projects/planner-demo-b';
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
/** The shells VS Code's terminals run on the server (its pty hosts' children): the run ends its own, whatever VS Code kept. */
const ptyShells = () => {
  try {
    // Not this shell, whose own command line names the pty host.
    return inVscode('sh', '-c', `hosts=""; for p in /proc/[0-9]*; do [ "$(basename $p)" = "$$" ] && continue; tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q -- '--type=ptyHost' && hosts="$hosts $(basename $p)"; done; for p in /proc/[0-9]*; do pp=$(awk '/^PPid/{print $2}' $p/status 2>/dev/null); for h in $hosts; do [ "$pp" = "$h" ] && basename $p; done; done; true`).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
};
const shellsBefore = new Set(ptyShells());
const readme = docker('cat', `${project}/README.md`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const storage = (body) => context.request.post(`${base}/api/guests/${VSCODE}/storage`, { data: body });
/** A POST to the extension's service, through OpenChamber as its frames make it; its JSON answer. */
const service = async (path, body) => {
  const answer = await (await context.request.post(`${base}/api/guests/${VSCODE}/service/request`, { data: { method: 'POST', path, body: JSON.stringify({ serverUrl, token, ...body }) } })).json();
  return answer?.status === 200 && answer.body ? JSON.parse(answer.body) : null;
};
/** A folder's header tabs, which the page keeps in the service for the rail view to bring back after a reload. */
const savedTabsOf = async (folder) => (await service('/tabs/load', { folder }).catch(() => null))?.tabs ?? null;
const kept = {};
const keptTabs = new Map();
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
/** A command from VS Code's command palette, in the workbench frame that has focus: the row with exactly that label. */
const runCommand = async (page, frame, title) => {
  await page.keyboard.press('Control+Shift+p');
  await frame.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
  await page.keyboard.type(title);
  const label = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: label }) }).first().click({ timeout: 10_000 });
};
/** The colors VS Code's TextMate grammar gave an editor's lines (a token class besides the default one), once it has run. */
const grammarColors = (editor) => until(async () => {
  const classes = await editor.locator('.view-line span span').evaluateAll((spans) => [...new Set(spans.map((span) => span.className).filter(Boolean))]);
  return classes.some((name) => /\bmtk(?!1\b)\d+/.test(name)) ? classes : null;
}, 20_000);
const setiLoaded = (frame) => frame?.evaluate(() => [...document.fonts].some((font) => font.family.replace(/["']/g, '') === 'seti' && font.status === 'loaded'));

try {
  check('login', (await context.request.post(`${base}/auth/session`, { data: { password } })).status() === 200);
  const guests = await (await context.request.get(`${base}/api/guests`)).json();
  const guest = (Array.isArray(guests) ? guests : guests.guests ?? []).find((item) => item.id === VSCODE);
  const requested = guest?.capabilities?.requested ?? [];
  check('the extension is installed and enabled; it asks for its local service only', Boolean(guest?.enabled) && requested.length === 1 && requested[0] === 'service', JSON.stringify(guest?.capabilities ?? null));
  const adapted = Boolean(guest?.ocForge);
  // The approval a user gives in Settings → Extensions.
  if (!requested.every((capability) => (guest.capabilities.granted ?? []).includes(capability))) {
    await context.request.put(`${base}/api/guests/${VSCODE}/capabilities`, { data: { granted: requested } });
  }
  for (const key of ['settings', 'folder', 'open-request', 'handled-open:panel', 'handled-open:page', 'handled-open:view']) {
    kept[key] = (await (await storage({ op: 'get', key })).json()).value;
    await storage({ op: 'delete', key });
  }
  for (const folder of [project, projectB]) keptTabs.set(folder, await savedTabsOf(folder));
  const sessionIn = async (directory) => {
    // OpenCode 2 takes the folder as the session's location and answers { data: session }.
    const created = await (await context.request.post(`${base}/api/session`, { data: { title: `${run} chat ${directory.split('/').pop()}`, location: { directory } } })).json();
    const id = created.data?.id ?? created.id;
    sessions.push({ id, directory });
    return id;
  };
  const session = await sessionIn(project);

  const page = await context.newPage();
  /**
   * The current chat's menu in OpenChamber's header: its "Open session actions" button, or, with sessions shown as
   * tabs in the header (an OpenChamber setting), the selected tab's "Session tab actions" (shown on hover).
   */
  const openChatMenu = async () => {
    const button = page.locator('header button[aria-label="Open session actions"]').first();
    const tab = page.locator('header [role="tab"][aria-selected="true"]').first();
    await button.or(tab).first().waitFor({ timeout: 20_000 });
    if (await button.isVisible().catch(() => false)) return button.click();
    await tab.hover();
    await tab.getByRole('button', { name: 'Session tab actions' }).click({ timeout: 10_000 });
  };
  context.on('page', (opened) => popups.push(opened.url()));
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /\/(workbench|panel)\/main\.js/.test(message.location().url ?? '')) problems.push(`console: ${message.text()}`);
  });
  await page.goto(`${base}/?session=${session}`, { waitUntil: 'load' });
  check(adapted ? "the host is an OpenChamber with oc-forge's adapters: VS Code in its rail, header tabs and bottom" : 'the host is a stock OpenChamber: VS Code in its panel and page', true);

  /** OpenChamber's own editor keeps its jumps: a search hit opens at its line (the extension claims no files). */
  const nativeSearchHit = async () => {
    const needleFile = `${run}-needle.ts`;
    const needle = `${run.replaceAll('-', '_')}_needle`;
    execFileSync('docker', ['exec', '-i', 'oc-forge-openchamber-dev', 'sh', '-c', `cat > ${project}/${needleFile}`], { input: Array.from({ length: 80 }, (_, index) => (index === 59 ? `export const ${needle} = 60;` : `// line ${index + 1}`)).join('\n') });
    await page.locator('button[aria-label="Files"][data-context-surface]').first().click({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Search mode', exact: true }).click({ timeout: 20_000 });
    await page.getByRole('menuitemradio', { name: 'File contents', exact: true }).click();
    await page.getByPlaceholder('Search in files...').fill(needle);
    await page.locator(`button[title="${needleFile}:60"]`).click({ timeout: 30_000 });
    const lineShown = await until(async () => {
      const line = page.locator('.cm-editor .cm-line', { hasText: needle }).first();
      if (!(await line.isVisible())) return null;
      // Within the scrolled view of the editor that holds it.
      return line.evaluate((element) => {
        const scroller = element.closest('.cm-scroller');
        if (!scroller) return false;
        const box = element.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        return box.top >= view.top && box.bottom <= view.bottom;
      });
    }, 20_000);
    const extensionEditor = await page.locator('iframe[src*="/editor/index.html"]').count();
    check("OpenChamber's own editor opens a search hit at its line (no extension editor in the way)", Boolean(lineShown) && extensionEditor === 0, `line 60 visible: ${Boolean(lineShown)}, extension editors: ${extensionEditor}`);
    await page.screenshot({ path: join(out, '08-native-search-line.png') });
  };

  /** "Open in VS Code" from a chat of the other demo project, opened from the sidebar so that it takes that folder. */
  const openOtherChat = async () => {
    await sessionIn(projectB);
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.getByText(`${run} chat planner-demo-b`, { exact: true }).first().click({ timeout: 20_000 });
    await openChatMenu();
    await page.getByRole('menuitem', { name: 'Open in VS Code' }).click({ timeout: 10_000 });
  };
  const showsOther = async (frame) => (await frame.locator('.explorer-folders-view').innerText()).includes('planner-demo-b') || (await frame.locator('.explorer-viewlet').innerText()).toLowerCase().includes('planner-demo-b');

  // ── A stock OpenChamber: the whole workbench in the panel ──
  const classic = async () => {
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
    const seti = await until(() => setiLoaded(workbenchFrame()), 20_000);
    check("file icons load (VS Code's Seti font, through the extension's service)", Boolean(seti));
    check('the status bar names OpenChamber as the remote', (await panel.locator('.statusbar').innerText()).includes('OpenChamber'));
    await page.screenshot({ path: join(out, '01-panel.png') });

    // VS Code restores the editors of its last session; start from none.
    const command = (title) => runCommand(page, panel, title);
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
    const tokenClasses = await grammarColors(editor);
    check('README.md opens in VS Code\'s editor, colored by its Markdown grammar', Boolean(tokenClasses), (tokenClasses ?? []).join(' '));
    await editor.locator('.view-line').last().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(marker);
    await page.keyboard.press('Control+s');
    const saved = await until(() => docker('cat', `${project}/README.md`).includes(marker), 20_000);
    check('Ctrl+S saves the edit on the VS Code Server', Boolean(saved));
    await page.screenshot({ path: join(out, '02-editor.png') });

    // A webview: Markdown's preview, rendered by this extension's webview host inside OpenChamber.
    await command('Markdown: Open Preview to the Side');
    const preview = panel.frameLocator('iframe.webview').first().frameLocator('#active-frame');
    const previewHeading = await preview.locator('h1').first().innerText({ timeout: 30_000 }).catch(() => '');
    check("Markdown's preview (a VS Code webview) renders the file", previewHeading.trim() === 'planner-demo-a', previewHeading);
    await page.screenshot({ path: join(out, '02b-markdown-preview.png') });

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
    // The query goes, so that the Search view doesn't keep the run's text.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

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

    // Settings persist: the minimap goes off and stays off after the view reloads; then back as it was.
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
    const minimapAgain = () => panelAgain.locator('.editor-instance .monaco-editor .minimap').first().isVisible().catch(() => false);
    const persisted = reopened ? (await minimapAgain()) === !before : false;
    check('VS Code keeps its state across a reload (open editor, a toggled setting)', toggled && Boolean(reopened) && persisted, `toggled ${toggled}, editor reopened ${Boolean(reopened)}, setting kept ${persisted}`);
    if (toggled) {
      await panelAgain.locator('.editor-instance .monaco-editor .view-line').first().click();
      await runCommand(page, panelAgain, 'View: Toggle Minimap');
      await until(async () => (await minimapAgain()) === before, 5_000);
    }

    await nativeSearchHit();

    // The full page: Extension pages → VS Code, in OpenChamber's main area (the side panel closed first).
    const closeButtons = page.locator('button[aria-label="Close panel"]');
    let rightmost = null;
    for (let index = 0; index < await closeButtons.count(); index++) {
      const box = await closeButtons.nth(index).boundingBox().catch(() => null);
      if (box && (!rightmost || box.x > rightmost.x)) rightmost = { index, x: box.x };
    }
    if (rightmost) await closeButtons.nth(rightmost.index).click().catch(() => {});
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
    await openOtherChat();
    const panelOther = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
    const switched = await until(() => showsOther(panelOther), 60_000);
    check('"Open in VS Code" on a chat shows its folder in the VS Code panel', Boolean(switched));
    await page.screenshot({ path: join(out, '07-open-in-vscode.png') });
  };

  // ── An OpenChamber with oc-forge's adapters: VS Code's parts in its rail, header tabs and bottom ──
  const surfaces = async () => {
    const entry = (id) => page.locator(`[data-context-surface="plugin:${VSCODE}--${id}"]`).first();
    const entryLit = async (id) => (await entry(id).getAttribute('aria-pressed').catch(() => null)) === 'true';
    const view = page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
    const pageFrame = page.frameLocator(`[data-oc-forge-page="${VSCODE}"] iframe`).first();
    const bottom = page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
    const headerTabs = () => page.$$eval(`[data-oc-forge-tab^="${VSCODE}:"]`, (tabs) => tabs.map((tab) => ({
      id: tab.getAttribute('data-oc-forge-tab').slice(tab.getAttribute('data-oc-forge-tab').indexOf(':') + 1),
      title: tab.textContent?.trim() ?? '',
      active: tab.getAttribute('data-active') === 'true',
    })));
    const tabById = (id) => page.locator(`[data-oc-forge-tab="${VSCODE}:${id}"]`).first();
    const pageShown = () => page.evaluate((id) => {
      const element = document.querySelector(`[data-oc-forge-page="${id}"]`);
      return Boolean(element) && getComputedStyle(element).visibility === 'visible';
    }, VSCODE);
    const roleFrame = async (role) => {
      for (const frame of page.frames()) {
        if (frame.url().includes('/workbench/index.html') && await frame.evaluate(() => document.documentElement.dataset.ocVscodeRole).catch(() => null) === role) return frame;
      }
      return null;
    };
    /** The header tabs this run opened: they go before it leaves, so that the folder's saved tabs are as they were. */
    const opened = new Map();
    const noteNewTabs = async (before) => {
      for (const tab of await headerTabs()) if (!before.includes(tab.id)) opened.set(tab.id, tab.title);
    };

    // The Explorer, a rail entry: first the connection form, then VS Code's Explorer alone in the rail panel.
    await entry('explorer').waitFor({ timeout: 60_000 });
    // OpenChamber may still be putting up its own panel: clicked until lit (a click on a lit entry closes it).
    for (let attempt = 0; attempt < 4 && !(await until(() => entryLit('explorer'), 3_000)); attempt++) await entry('explorer').click();
    await view.getByRole('textbox', { name: 'VS Code Server address' }).fill(serverUrl, { timeout: 30_000 });
    await view.getByLabel('VS Code Server connection token').fill(token);
    await view.getByRole('button', { name: 'Connect' }).click();
    const started = Date.now();
    await view.locator('.monaco-workbench').waitFor({ timeout: 180_000 });
    const explorerRow = view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' });
    await explorerRow.first().waitFor({ timeout: 60_000 });
    check("VS Code's Explorer (its rail entry) lists the chat's folder from the VS Code Server, in OpenChamber's rail panel", (await view.locator('.explorer-folders-view').innerText()).includes('README.md'), `${Date.now() - started} ms after Connect`);
    const seti = await until(async () => setiLoaded(await roleFrame('view')), 20_000);
    check("file icons load (VS Code's Seti font, through the extension's service)", Boolean(seti));
    await page.screenshot({ path: join(out, '01-rail-explorer.png') });

    // A file: its header tab, and VS Code's editor in OpenChamber's main area; Ctrl+S on the server.
    let tabs = (await headerTabs()).map((tab) => tab.id);
    const initialTabs = new Set(tabs);
    await explorerRow.first().click();
    const readmeTab = await until(async () => (await headerTabs()).find((tab) => tab.title === 'README.md' && tab.active), 30_000);
    await noteNewTabs(tabs);
    const editor = pageFrame.locator('.monaco-editor[data-uri$="README.md"]').first();
    await editor.locator('.view-line').first().waitFor({ timeout: 120_000 });
    // The page started for the file handed to it opens that file last, taking the focus: until it has started.
    await until(async () => (await pageFrame.locator('html[data-oc-vscode-page-started="true"]').count()) > 0, 120_000);
    const tokenClasses = await grammarColors(editor);
    check("README.md opens as a header tab: VS Code's editor in OpenChamber's main area, colored by its Markdown grammar", Boolean(readmeTab && tokenClasses), (tokenClasses ?? []).join(' '));
    check('the status bar under the editor names OpenChamber as the remote', (await pageFrame.locator('.statusbar').innerText()).includes('OpenChamber'));
    await editor.locator('.view-line').last().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(marker);
    await page.keyboard.press('Control+s');
    const saved = await until(() => docker('cat', `${project}/README.md`).includes(marker), 20_000);
    check('Ctrl+S saves the edit on the VS Code Server', Boolean(saved));
    await page.screenshot({ path: join(out, '02-editor.png') });

    // A webview: Markdown's preview beside the file, a header tab of its own.
    tabs = (await headerTabs()).map((tab) => tab.id);
    await editor.locator('.view-line').first().click();
    await runCommand(page, pageFrame, 'Markdown: Open Preview to the Side');
    const previewTab = await until(async () => (await headerTabs()).find((tab) => tab.title.includes('Preview')), 20_000);
    await noteNewTabs(tabs);
    const previewHeading = await until(async () => (await pageFrame.frameLocator('iframe.webview').first().frameLocator('#active-frame').locator('h1').first().innerText({ timeout: 2_000 })).trim() || null, 30_000);
    check("Markdown's preview (a VS Code webview) renders the file, as a header tab of its own", Boolean(previewTab) && previewHeading === 'planner-demo-a', `${previewTab?.title ?? 'no tab'}; heading ${JSON.stringify(previewHeading)}`);
    await page.screenshot({ path: join(out, '02b-markdown-preview.png') });

    // Source control, a rail entry: the change, and VS Code's diff editor in the page.
    await entry('scm').click();
    const change = view.locator('.scm-view .monaco-list-row', { hasText: 'README.md' }).first();
    await change.waitFor({ timeout: 30_000 });
    check('Source Control (its rail entry) lists the changed file', true);
    tabs = (await headerTabs()).map((tab) => tab.id);
    await change.click({ position: { x: 24, y: 10 } });
    const diff = await until(async () => await pageShown() && await pageFrame.locator('.monaco-diff-editor').first().isVisible(), 30_000);
    await noteNewTabs(tabs);
    check("clicking it opens VS Code's diff editor in the page, as a header tab", Boolean(diff), (await headerTabs()).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | '));
    await page.screenshot({ path: join(out, '03-scm-diff.png') });

    // Search, a rail entry, across the folder.
    await entry('search').click();
    const searchBox = view.locator('.search-view .monaco-inputbox textarea, .search-view .monaco-inputbox input').first();
    await searchBox.waitFor({ timeout: 20_000 });
    await searchBox.click();
    await page.keyboard.type(run);
    const hit = await until(() => view.locator('.search-view .monaco-list-row', { hasText: 'README.md' }).first().isVisible(), 30_000);
    check('Search (its rail entry) finds the text in the folder', Boolean(hit));
    await page.screenshot({ path: join(out, '04-search.png') });
    // The query goes, so that the Search view doesn't keep the run's text.
    await searchBox.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

    // The terminal at OpenChamber's bottom, under the page (which keeps the bottom zone), on the server's machine.
    await entry('terminal').click();
    const xterm = bottom.locator('.xterm:visible').first();
    if (!(await xterm.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false))) {
      await bottom.locator('.part.panel .action-label[aria-label^="New Terminal"]').first().click();
      await xterm.waitFor({ timeout: 60_000 });
    }
    await wait(2500);
    let ran = false;
    for (let attempt = 0; attempt < 3 && !ran; attempt++) {
      await xterm.click();
      await wait(1_000);
      await page.keyboard.type(`echo ${run}-$((6*7)) > /tmp/${run}.txt`);
      await page.keyboard.press('Enter');
      ran = Boolean(await until(() => {
        try {
          return inVscode('cat', `/tmp/${run}.txt`).trim() === `${run}-42`;
        } catch {
          return false;
        }
      }, 10_000));
    }
    check("the terminal at OpenChamber's bottom runs commands on the VS Code Server's machine", ran);
    await page.screenshot({ path: join(out, '05-terminal.png') });
    // This run's terminal goes.
    await xterm.click();
    await runCommand(page, bottom, 'Terminal: Kill the Active Terminal Instance');
    await until(async () => (await bottom.locator('.xterm:visible').count()) === 0, 10_000);
    if (await entryLit('terminal')) await entry('terminal').click();

    // State across a reload: the page's tabs come back, and the editor's cursor where it was (VS Code's state for
    // the page, which the extension's service keeps; no user setting changes, so there is none to put back).
    await tabById(readmeTab.id).click();
    await until(async () => await pageShown() && await editor.locator('.view-line').first().isVisible(), 30_000);
    const cursorLine = async () => (await editor.locator('.line-numbers.active-line-number').first().textContent({ timeout: 1_000 }))?.trim() || null;
    await editor.locator('.view-line').nth(2).click({ position: { x: 4, y: 4 } });
    const lineBefore = await until(cursorLine, 5_000);
    // VS Code for the web saves its state every few seconds; a page that reloads can't save it on the way out.
    await wait(7_000);
    await page.reload({ waitUntil: 'load' });
    // The rail view brings the page's tabs back; it starts with the rail panel.
    if (!(await until(() => entryLit('explorer'), 15_000))) await entry('explorer').click();
    const back = await until(async () => (await headerTabs()).some((tab) => tab.id === readmeTab.id), 90_000);
    if (back) await tabById(readmeTab.id).click();
    const reopened = back && await until(async () => await pageShown() && await editor.locator('.view-line').first().isVisible(), 60_000);
    const lineAfter = reopened ? await until(async () => ((await cursorLine()) === lineBefore ? lineBefore : null), 20_000) : null;
    // Each once: VS Code revives the preview under a new key, which takes its old tab's place.
    const runTitles = new Set(opened.values());
    const once = await until(async () => {
      const titles = (await headerTabs()).map((tab) => tab.title).filter((title) => runTitles.has(title));
      return titles.length === runTitles.size && new Set(titles).size === titles.length ? titles : null;
    }, 30_000);
    check("VS Code keeps its state across a reload: the file tabs come back, once each, and the editor's cursor where it was", Boolean(lineBefore) && Boolean(back) && Boolean(reopened) && lineAfter === lineBefore && Boolean(once),
      `tabs back ${Boolean(back)} (${(await headerTabs()).map((tab) => tab.title).join(' | ')}), editor reopened ${Boolean(reopened)}, cursor on line ${lineBefore} → ${reopened ? await cursorLine().catch(() => null) : '-'}`);
    await page.screenshot({ path: join(out, '06-after-reload.png') });
    // The preview VS Code revives (from the state it saved while the frame had no focus) renders the file again.
    const previewTabNow = (await headerTabs()).find((tab) => tab.title.includes('Preview'));
    if (previewTabNow) await tabById(previewTabNow.id).click();
    const previewAgain = previewTabNow && await until(async () => (await pageFrame.frameLocator('iframe.webview').first().frameLocator('#active-frame').locator('h1').first().innerText({ timeout: 2_000 })).trim() === 'planner-demo-a', 60_000);
    check("after the reload, Markdown's preview (revived by VS Code under a new key, in its tab) renders the file again", Boolean(previewAgain), previewTabNow ? `${previewTabNow.title}: ${previewAgain ? 'rendered' : 'not rendered'}` : 'no preview tab');
    await page.screenshot({ path: join(out, '06b-preview-after-reload.png') });
    // This run's tabs go (they are saved: no prompt), the last with the page; a revived preview by its title.
    const runTab = (tab) => opened.has(tab.id) || (!initialTabs.has(tab.id) && runTitles.has(tab.title));
    for (let guard = 0; guard < 8; guard++) {
      const [tab] = (await headerTabs()).filter(runTab);
      if (!tab) break;
      await tabById(tab.id).hover();
      await tabById(tab.id).getByRole('button', { name: 'Close tab' }).click();
      await until(async () => !(await headerTabs()).some((item) => item.id === tab.id), 10_000);
    }
    const ids = (tabs) => JSON.stringify((tabs ?? []).map((tab) => tab.id));
    const savedAsBefore = await until(async () => ids(await savedTabsOf(project)) === ids(keptTabs.get(project)), 10_000);
    check("the run's tabs are closed for good: the folder's saved tabs are as they were (the rail view keeps them when the page goes with the last tab)", Boolean(savedAsBefore),
      `saved: ${((await savedTabsOf(project)) ?? []).map((tab) => tab.title).join(' | ') || 'none'}`);

    await nativeSearchHit();

    // "Open in VS Code" on another chat shows that chat's folder in VS Code's Explorer, in the rail panel.
    await openOtherChat();
    const viewNow = page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]:visible').first();
    const switched = await until(async () => await entryLit('explorer') && showsOther(viewNow), 90_000);
    check('"Open in VS Code" on a chat shows its folder in VS Code\'s Explorer, in the rail panel', Boolean(switched));
    await page.screenshot({ path: join(out, '07-open-in-vscode.png') });
  };

  if (adapted) await surfaces();
  else await classic();
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
  for (const [folder, tabs] of keptTabs) {
    if (tabs && JSON.stringify(await savedTabsOf(folder)) !== JSON.stringify(tabs)) {
      console.log(`INFO cleanup: ${folder}'s saved tabs put back as they were`);
      await service('/tabs/save', { folder, tabs }).catch(() => {});
    }
  }
  const shells = ptyShells().filter((pid) => !shellsBefore.has(pid));
  if (shells.length > 0) {
    // The shell's own kill (the container has no kill binary); one that outlives its hangup is killed.
    inVscode('sh', '-c', `kill -HUP ${shells.join(' ')} 2>/dev/null; sleep 1; kill -KILL ${shells.join(' ')} 2>/dev/null; true`);
    const left = ptyShells().filter((pid) => shells.includes(pid));
    console.log(`INFO cleanup: the run's ${shells.length} shell(s) on the VS Code Server ${left.length === 0 ? 'ended' : `ended but ${left.join(' ')}`}`);
  }
  try {
    execFileSync('docker', ['exec', '-i', 'oc-forge-openchamber-dev', 'sh', '-c', `cat > ${project}/README.md`], { input: readme });
    inVscode('rm', '-f', `/tmp/${run}.txt`);
    docker('rm', '-f', `${project}/${run}-needle.ts`);
  } catch (error) {
    console.log(`INFO cleanup: ${String(error).split('\n')[0]}`);
  }
  await browser.close();
}
const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
