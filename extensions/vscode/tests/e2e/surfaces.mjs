// End-to-end check of VS Code in OpenChamber's own surfaces (oc-forge's
// adapters), on the adapters' scratch stack, at 1440×900 and 1024×768 with
// screenshots:
//   1. the rail shows Explorer, Search, Source Control, Run and Debug and
//      Extensions as their own icons, and each opens its view;
//   2. a VS Code extension with an activity-bar view container, installed on
//      the VS Code Server, gets its icon within seconds and opens its view;
//      uninstalled, the icon goes; no reload;
//   3. a file opened from the Explorer is a header tab beside the chats: it
//      shows the editor in the main area, survives a trip to a chat, turns
//      dirty when edited, and closing it closes the editor, asking to save;
//      VS Code's own tab bar is not shown;
//   4. the terminal entry opens VS Code's terminal at the bottom: a command
//      runs, a second terminal, a split, the shell picker;
//   5. with focus in VS Code, Ctrl+1 and Ctrl+Alt+→ act in VS Code, and
//      OpenChamber's tab keys don't take them;
//   6. nothing opens another page or window but the tabs Cmd/Ctrl+click opens (8);
//   7. Markdown's preview (a VS Code webview) renders in the stock OpenChamber
//      (the whole workbench in its panel), in the page and in a rail view; a
//      key pressed in it reaches VS Code; VS Code restores it after a reload;
//   8. Cmd/Ctrl+click on a link to a file in a rail view, and on a file link in
//      the terminal, opens a new browser tab showing that file's editor, and
//      this tab stays as it was; a plain click opens it here, as a header tab;
//   9. OpenChamber's keys from each VS Code frame: its rail digits
//      (Ctrl+Alt+digit) reach it from the rail view, the page and the terminal,
//      its close-tab key (Alt+W) from a rail view; Alt+W stays VS Code's in its
//      editor and the shell's in the terminal;
//  10. "Open in VS Code" on a chat in another folder shows that folder's
//      Explorer in the rail panel, and the page closes the other folder's tabs;
//  11. with a file tab shown, the terminal entry opens VS Code's terminal under
//      the editor (`ocForge.page.keepBottomZone`): both take input, both stay
//      through a trip to a chat, and a file link Cmd/Ctrl+clicked there opens
//      a new browser tab (8);
//  12. closing the last unsaved file tab runs VS Code's close with its save
//      prompt (`tabs.onCloseRequest`): Cancel keeps the tab, the editor and the
//      change, Don't Save closes it without writing (opened again, the file is
//      as on disk: VS Code's backup of the change went too), Save writes and
//      closes, each back to the chat; a saved tab closes at once; across a reload the
//      tabs come back once each (Markdown's preview, which VS Code revives
//      under a new key, too), and closed tabs stay closed, VS Code's own state
//      included;
// and, with OpenChamber's session tabs off, the page keeps VS Code's own tab
// bar. It also measures each workbench's start and memory (`<size>-frames.json`).
//
//   export WORK=/tmp/opencode/vscode-surfaces/e2e STACK_PORT_BASE=35380 VSCODE_VERSION=1.143.1
//   node tests/e2e/openchamber-adapters/stack.mjs prepare      # needs the network
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/vscode/tests/e2e/surfaces.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// On a host whose network interfaces keep changing (Docker builds), run `up`,
// this and `down` inside one private network namespace (see the adapters'
// README). The stack copies this checkout's extensions when it starts (`up`),
// so build the extension first. Never prints the UI password or the VS Code token.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/vscode-surfaces/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-surfaces/screens';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
const stockBase = `http://127.0.0.1:${BASE}`;
const base = `http://127.0.0.1:${BASE + 1}`;
const vscodeUrl = `http://127.0.0.1:${BASE + 2}`;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const vscodeVersion = JSON.parse(readFileSync(join(work, 'vscode-server/package.json'), 'utf8')).version;
const VSCODE = 'oc-forge-vscode';
const project = join(work, 'adapted/home/projects/demo');
const projectB = join(work, 'adapted/home/projects/demo-b');
const run = `surfaces-${Date.now().toString(36)}`;
const CHATS = ['Surfaces chat one', 'Surfaces chat two'];
const CHAT_B = 'Surfaces chat in b';
const BUILT_INS = [['search', 'Search'], ['scm', 'Source Control'], ['debug', 'Run and Debug'], ['extensions', 'Extensions'], ['explorer', 'Explorer']];
const PROBE = { publisher: 'ocforge-e2e', name: 'surfaces-probe', container: 'surfacesProbe', entry: 'surfaces-probe', title: 'Surfaces Probe', welcome: "The surfaces probe's view is here." };
// What VS Code names the server's files: the authority is the address the extension's service reaches it at.
const linkedUri = { $mid: 1, scheme: 'vscode-remote', authority: new URL(vscodeUrl).host, path: join(project, 'linked.md') };

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
    await wait(250);
  }
};

const browser = await chromium.launch();
const setup = await browser.newContext();
const request = setup.request;

/** The guests of one OpenChamber: the VS Code extension installed, approved and alone. */
const installExtension = async (api, origin) => {
  const catalog = await (await api.get(`${origin}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === VSCODE)) await api.post(`${origin}/api/guests`, { data: { path: join(work, 'extensions', 'vscode') } });
  for (const guest of (await (await api.get(`${origin}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await api.put(`${origin}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
    if (guest.id !== VSCODE && guest.enabled) await api.put(`${origin}/api/guests/${guest.id}/enabled`, { data: { enabled: false } });
  }
};

// Two projects (demo with three files and two chats, demo-b with one file and a chat), session tabs on, the extension.
const seed = async () => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  writeFileSync(join(project, 'notes.ts'), 'export const notes = 1;\n');
  writeFileSync(join(project, 'linked.md'), '# linked\n\nline two\n');
  if (!existsSync(join(projectB, '.git'))) {
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectB, 'b.txt'), 'b\n');
    execFileSync('git', ['init', '-q', '-b', 'main', projectB]);
    execFileSync('git', ['-C', projectB, '-c', 'user.name=oc-forge e2e', '-c', 'user.email=e2e@oc-forge.invalid', 'add', '.']);
    execFileSync('git', ['-C', projectB, '-c', 'user.name=oc-forge e2e', '-c', 'user.email=e2e@oc-forge.invalid', 'commit', '-qm', 'demo-b']);
  }
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const patch = { sessionTabsEnabled: true };
  const missing = [[project, 'demo'], [projectB, 'demo-b']].filter(([path]) => !projects.some((entry) => entry.path === path));
  if (missing.length > 0) patch.projects = [...projects, ...missing.map(([path, label]) => ({ id: label, path, label, addedAt: Date.now() }))];
  await request.put(`${base}/api/config/settings`, { data: patch });
  const list = async (directory) => {
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(directory)}`, { timeout: 10_000 })).json();
    return Array.isArray(listed) ? listed : listed.data ?? [];
  };
  const wanted = [...CHATS.map((title) => [title, project]), [CHAT_B, projectB]];
  for (const [title, directory] of wanted) {
    if ((await list(directory)).some((session) => session.title === title)) continue;
    await request.post(`${base}/api/session?directory=${encodeURIComponent(directory)}`, { data: { title, location: { directory } } });
  }
  await installExtension(request, base);
  const idOf = async (title, directory) => (await until(async () => {
    const found = (await list(directory)).filter((session) => session.title === title).sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    return found[0]?.id ?? null;
  }, 120_000));
  return { chats: [await idOf(CHATS[0], project), await idOf(CHATS[1], project)], chatB: await idOf(CHAT_B, projectB) };
};

/** Before OpenChamber's own scripts: the chats' header tabs, once per browser context. */
const seedTabs = (ids) => {
  if (window.top !== window) return;
  if (!localStorage.getItem('vscode-surfaces-seeded')) {
    localStorage.setItem('session-tabs-store', JSON.stringify({ state: { tabIds: ids, previewTabId: null }, version: 0 }));
    localStorage.setItem('vscode-surfaces-seeded', '1');
  }
};

const rail = (page) => page.$$eval('[data-context-surface]', (buttons) => buttons.map((button) => ({
  id: button.getAttribute('data-context-surface'),
  pressed: button.getAttribute('aria-pressed') === 'true',
})));
const entrySurface = (entry) => `plugin:${VSCODE}--${entry}`;
const entryButton = (page, entry) => page.locator(`[data-context-surface="${entrySurface(entry)}"]`);
const viewFrame = (page) => page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
const bottomFrame = (page) => page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
const pageFrame = (page) => page.frameLocator(`[data-oc-forge-page="${VSCODE}"] iframe`).first();
const headerTabs = (page) => page.$$eval(`[data-oc-forge-tab^="${VSCODE}:"]`, (tabs) => tabs.map((tab) => ({
  id: tab.getAttribute('data-oc-forge-tab').slice(tab.getAttribute('data-oc-forge-tab').indexOf(':') + 1),
  title: tab.textContent?.trim() ?? '',
  active: tab.getAttribute('data-active') === 'true',
  dirty: Boolean(tab.querySelector('[data-oc-forge-dirty]')),
})));
const headerTab = (page, title) => page.locator(`[data-oc-forge-tab^="${VSCODE}:"]`, { hasText: title }).first();
const closeHeaderTab = async (page, title) => {
  await headerTab(page, title).hover();
  await headerTab(page, title).getByRole('button', { name: 'Close tab' }).click();
};
const pageShown = (page) => page.evaluate((id) => {
  const element = document.querySelector(`[data-oc-forge-page="${id}"]`);
  return Boolean(element) && getComputedStyle(element).visibility === 'visible';
}, VSCODE);
/** What a browser tab shows: the page or a chat, the chat, the VS Code tabs in its header. */
const tabState = async (page) => ({
  page: await pageShown(page),
  session: new URL(page.url()).searchParams.get('session'),
  tabs: (await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | '),
});
const sidebarTitle = async (frame) => (await frame.locator('.part.sidebar .composite.title h2').first().textContent({ timeout: 2_000 }).catch(() => ''))?.trim() ?? '';
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
/** The parts a workbench frame shows. */
const partsOf = (frame) => frame.locator('.monaco-workbench').evaluate((workbench) => {
  const shown = (selector) => {
    const element = workbench.querySelector(selector);
    return Boolean(element) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
  };
  return {
    activitybar: shown('.part.activitybar'),
    sidebar: shown('.part.sidebar'),
    editor: shown('.part.editor'),
    panel: shown('.part.panel'),
    statusbar: shown('.part.statusbar'),
    titlebar: shown('.part.titlebar'),
    tabs: [...workbench.querySelectorAll('.part.editor .tabs-container .tab')].filter((tab) => tab.getBoundingClientRect().width > 0).length,
  };
});
/** A command from VS Code's command palette, in the workbench frame that has focus: the row with exactly that label. */
const runCommand = async (page, frame, title) => {
  await page.keyboard.press('Control+Shift+p');
  await frame.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
  await page.keyboard.type(title);
  // The search lists others too, maybe first ("Markdown: Open as Preview" for "Markdown: Open Preview").
  const label = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: label }) }).first().click({ timeout: 10_000 });
};
/**
 * A page that starts for a file handed to it opens that file last, taking the focus: until it has started (a command
 * palette opened before would close under it).
 */
const pageStarted = (page) => until(async () => (await pageFrame(page).locator('html[data-oc-vscode-page-started="true"]').count()) > 0, 120_000);
/** Markdown's preview in a workbench frame: the webview's content frame. */
const previewContent = (frame) => frame.frameLocator('iframe.webview').first().frameLocator('#active-frame');
const previewHeading = async (frame) => (await previewContent(frame).locator('h1').first().innerText({ timeout: 2_000 }).catch(() => '')).trim();
/** The chat's menu in OpenChamber's header: with session tabs, the selected tab's (shown on hover). */
const openChatMenu = async (page) => {
  const button = page.locator('header button[aria-label="Open session actions"]').first();
  const tab = page.locator('header [role="tab"][aria-selected="true"]').first();
  await button.or(tab).first().waitFor({ timeout: 20_000 });
  if (await button.isVisible().catch(() => false)) return button.click();
  await tab.hover();
  await tab.getByRole('button', { name: 'Session tab actions' }).click({ timeout: 10_000 });
};

/** The editor a link to the VS Code page opens (`?extension=…&route=/editor?key=…&line=…`), or null. */
const deepLinkOf = (url) => {
  try {
    const params = new URL(url).searchParams;
    const route = /^\/editor\?(.*)$/.exec(params.get('route') ?? '');
    if (params.get('extension') !== VSCODE || !route) return null;
    const inner = new URLSearchParams(route[1]);
    return { key: inner.get('key') ?? '', line: Number(inner.get('line')) || null };
  } catch {
    return null;
  }
};

/** A Cmd/Ctrl+click that should open `file` in a new browser tab: that tab shows its editor (at `line`); closed after. */
const newTabShows = async (context, file, line, click, name) => {
  const next = context.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
  await click();
  const tab = await next;
  if (!tab) return { tab: null, ok: false, detail: 'no new tab opened' };
  try {
    // A new tab starts on about:blank.
    await tab.waitForURL((url) => url.href !== 'about:blank', { timeout: 30_000 }).catch(() => undefined);
    const link = deepLinkOf(tab.url());
    const editor = tab.frameLocator(`[data-oc-forge-page="${VSCODE}"] iframe`).first().locator(`.monaco-editor[data-uri$="/${file}"]`).first();
    const shown = await editor.locator('.view-line').first().waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
    const activeLine = shown && line ? await until(async () => (await editor.locator('.line-numbers.active-line-number').first().textContent({ timeout: 1_000 }))?.trim(), 15_000) : null;
    await tab.screenshot({ path: join(out, `${name}.png`) }).catch(() => undefined);
    const ok = Boolean(link?.key.endsWith(`/${file}`)) && shown && (!line || (link.line === line && activeLine === String(line)));
    return { tab, ok, detail: `${link ? `route to ${link.key.split('/').pop()}${link.line ? ` line ${link.line}` : ''}` : tab.url()}; its editor ${shown ? 'shown' : 'not shown'}${line ? `, cursor on line ${activeLine}` : ''}` };
  } finally {
    await tab.close().catch(() => undefined);
  }
};

/** Where the terminal's cursor row is, and a cell's size: xterm keeps its helper textarea on the cursor's cell. */
const terminalCell = (frame) => frame.locator('.xterm:visible .xterm-helper-textarea').first().evaluate((textarea) => {
  const screen = textarea.closest('.xterm').querySelector('.xterm-screen').getBoundingClientRect();
  const box = textarea.getBoundingClientRect();
  const height = parseFloat(textarea.style.height) || box.height;
  const width = parseFloat(textarea.style.width) || box.width;
  return { cursorRow: Math.round((box.top - screen.top) / height), height, width };
});

/** Lines of the VS Code Server's logs about restoring a webview panel failing (VS Code 1.143 without a ready webview). */
const restoreErrors = () => {
  const dir = join(work, 'vscode/data');
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir, { recursive: true })) {
    if (!String(name).endsWith('.log')) continue;
    count += readFileSync(join(dir, String(name)), 'utf8').split('\n').filter((line) => /deserializeWebviewPanel|reading 'resource'/.test(line)).length;
  }
  return count;
};

// A VS Code extension with an activity-bar view container and a view (no code: its welcome text, with a link to a file), as a .vsix.
const makeProbe = () => {
  const dir = mkdtempSync(join(tmpdir(), 'surfaces-probe-'));
  mkdirSync(join(dir, 'extension/media'), { recursive: true });
  const link = `command:vscode.open?${encodeURIComponent(JSON.stringify([linkedUri]))}`;
  writeFileSync(join(dir, 'extension/package.json'), JSON.stringify({
    name: PROBE.name, publisher: PROBE.publisher, version: '0.0.1', displayName: 'Surfaces probe', engines: { vscode: '^1.80.0' },
    contributes: {
      viewsContainers: { activitybar: [{ id: PROBE.container, title: PROBE.title, icon: 'media/probe.svg' }] },
      views: { [PROBE.container]: [{ id: `${PROBE.container}.view`, name: 'Probe view' }] },
      viewsWelcome: [{ view: `${PROBE.container}.view`, contents: `${PROBE.welcome}\nOpen [linked.md](${link}) from here.` }],
    },
  }, null, 2));
  writeFileSync(join(dir, 'extension/media/probe.svg'), '<?xml version="1.0"?>\n<!-- probe -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>\n');
  writeFileSync(join(dir, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${PROBE.name}" Version="0.0.1" Publisher="${PROBE.publisher}" /><DisplayName>Surfaces probe</DisplayName><Description xml:space="preserve">A view container for the end-to-end check.</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" /></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`);
  writeFileSync(join(dir, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".svg" ContentType="image/svg+xml"/></Types>');
  const vsix = join(dir, 'probe.vsix');
  execFileSync('zip', ['-qr', vsix, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dir });
  return { dir, vsix };
};
/** The VS Code Server's own CLI, on its extensions folder. */
const serverCli = (...args) => execFileSync(join(work, 'vscode-server/bin/code-server'), ['--server-data-dir', join(work, 'vscode/data'), ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(work, 'vscode/home') }, stdio: ['ignore', 'pipe', 'pipe'],
});

/** The VS Code Server's extension hosts: pid → resident MB (one per workbench connection). */
const extensionHosts = () => {
  const hosts = new Map();
  try {
    for (const line of execFileSync('ps', ['-eo', 'pid=,rss=,args='], { encoding: 'utf8' }).split('\n')) {
      if (!line.includes(join(work, 'vscode-server')) || !/--type=extensionHost/.test(line)) continue;
      const [pid, rss] = line.trim().split(/\s+/);
      hosts.set(pid, Math.round(Number(rss) / 1024));
    }
  } catch {
    // No ps: no numbers.
  }
  return hosts;
};

/** Each workbench frame's own clock: from its navigation to its workbench running. */
const frameStarts = async (page) => {
  const starts = {};
  for (const frame of page.frames()) {
    if (!frame.url().includes('/workbench/index.html')) continue;
    const info = await frame.evaluate(() => ({ role: document.documentElement.dataset.ocVscodeRole ?? null, started: document.documentElement.dataset.ocVscodeStarted ?? null })).catch(() => null);
    if (info?.role && info.started) starts[info.role] = Number(info.started);
  }
  return starts;
};

// ── 7. Markdown's preview in the classic layout: the stock OpenChamber, the whole workbench in its panel ──
const classic = async () => {
  const size = '1440x900 classic';
  const stockProject = join(work, 'stock/home/projects/demo');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const api = context.request;
  const consoleErrors = [];
  try {
    const login = await api.post(`${stockBase}/auth/session`, { data: { password } });
    if (login.status() !== 200) throw new Error(`stock login failed (${login.status()})`);
    const settings = await (await api.get(`${stockBase}/api/config/settings`)).json();
    const projects = Array.isArray(settings.projects) ? settings.projects : [];
    if (!projects.some((entry) => entry.path === stockProject)) await api.put(`${stockBase}/api/config/settings`, { data: { projects: [...projects, { id: 'demo', path: stockProject, label: 'demo', addedAt: Date.now() }] } });
    await installExtension(api, stockBase);
    const created = await (await api.post(`${stockBase}/api/session?directory=${encodeURIComponent(stockProject)}`, { data: { title: 'Classic chat', location: { directory: stockProject } } })).json();
    const chat = (created.data ?? created).id;
    const page = await context.newPage();
    page.on('console', (message) => {
      if (/deserializeWebviewPanel|reading 'resource'/.test(message.text())) consoleErrors.push(message.text().split('\n')[0]);
    });
    await page.goto(`${stockBase}/?session=${chat}`);
    await page.locator('button[aria-label="VS Code"][data-context-surface]').first().click({ timeout: 60_000 });
    const panel = page.frameLocator('iframe[title="VS Code"][src*="/workbench/index.html"]').first();
    const form = await panel.getByRole('textbox', { name: 'VS Code Server address' }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
    if (form) {
      await panel.getByRole('textbox', { name: 'VS Code Server address' }).fill(vscodeUrl);
      await panel.getByLabel('VS Code Server connection token').fill(token);
      await panel.getByRole('button', { name: 'Connect' }).click();
    }
    await panel.locator('.monaco-workbench').waitFor({ timeout: 240_000 });
    await panel.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 90_000 });
    // VS Code restores the editors of its last session; start from none.
    await panel.locator('.monaco-workbench').click({ position: { x: 300, y: 300 } });
    await runCommand(page, panel, 'View: Close All Editors');
    await wait(800);
    await page.keyboard.press('Control+p');
    await panel.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
    await page.keyboard.type('README.md');
    await panel.locator('.quick-input-list .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await panel.locator('.monaco-editor[data-uri$="README.md"] .view-line').first().waitFor({ timeout: 30_000 });
    const errorsBefore = restoreErrors();
    await runCommand(page, panel, 'Markdown: Open Preview to the Side');
    const heading = await until(async () => (await previewHeading(panel)) || null, 30_000);
    check(`[${size}] 7 Markdown's preview renders on VS Code ${vscodeVersion}, the whole workbench in a stock OpenChamber's panel`, heading === 'demo', `heading ${JSON.stringify(heading)}`);
    await shot(page, 'classic-7-preview');
    // VS Code 1.143 runs a webview's keys only with the token its host page sent when it was ready.
    await previewContent(panel).locator('h1').first().click();
    await page.keyboard.press('Control+Shift+p');
    const palette = await panel.locator('.quick-input-widget input').waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
    check(`[${size}] 7 a key pressed in the preview reaches VS Code (Ctrl+Shift+P opens its command palette)`, palette);
    await shot(page, 'classic-7-preview-key');
    await page.keyboard.press('Escape');
    // Reload Window saves VS Code's state first: the preview comes back from the state its page saved.
    await panel.locator('.monaco-workbench').evaluate(() => {
      window.__classicMarker = 'before';
    });
    await panel.locator('.monaco-workbench').click({ position: { x: 300, y: 300 } });
    await runCommand(page, panel, 'Developer: Reload Window');
    const reloaded = await until(async () => (await panel.locator('.monaco-workbench').evaluate(() => window.__classicMarker ?? 'after', null, { timeout: 2_000 })) === 'after', 120_000);
    const restored = reloaded && await until(async () => (await previewHeading(panel)) === 'demo', 120_000);
    const errorsAfter = restoreErrors();
    check(`[${size}] 7 after VS Code reloads, it restores the preview, which renders again; nothing failed restoring it`, restored && errorsAfter === errorsBefore && consoleErrors.length === 0,
      `${reloaded ? 'reloaded' : 'did not reload'}; ${errorsAfter - errorsBefore} restore errors in the server's logs${consoleErrors.length ? `; console: ${consoleErrors[0]}` : ''}`);
    await shot(page, 'classic-7-restored');
  } catch (error) {
    check(`[${size}] the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close();
  }
};

const journey = async (viewport, seeded, first) => {
  const size = `${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript(seedTabs, seeded);
  const page = await context.newPage();
  // The extension's frames are sandboxed in the page's own renderer: its heap, after a collection, before and after each one starts.
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    return Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6);
  };
  const marks = {};
  const hostsBefore = extensionHosts();
  const popups = [];
  context.on('page', (opened) => popups.push(opened));
  /** The new tabs the Cmd/Ctrl+clicks (8) opened, to be told from any other. */
  const deepLinks = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /\/workbench\/main\.js/.test(message.location().url ?? '')) errors.push(`console: ${message.text()}`);
  });
  let probe = null;
  try {
    await page.goto(`${base}/?session=${seeded[0]}`);

    // ── 1. The activity bar's items as rail icons ──
    const listed = await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    const ids = (await rail(page)).map((entry) => entry.id);
    check(`[${size}] 1 the rail shows Explorer, Search, Source Control, Run and Debug, Extensions and the terminal as their own icons`,
      listed && [...BUILT_INS.map(([id]) => id), 'terminal'].every((id) => ids.includes(entrySurface(id))) && !ids.includes(`plugin:${VSCODE}`),
      ids.filter((id) => id.startsWith(`plugin:${VSCODE}`)).map((id) => id.split('--')[1]).join(' '));
    marks.before = { heap: await heap() };
    const viewStart = Date.now();
    await entryButton(page, 'explorer').click();
    const view = viewFrame(page);
    if (first) {
      const form = await view.getByRole('textbox', { name: 'VS Code Server address' }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
      if (form) {
        await view.getByRole('textbox', { name: 'VS Code Server address' }).fill(vscodeUrl);
        await view.getByLabel('VS Code Server connection token').fill(token);
        await view.getByRole('button', { name: 'Connect' }).click();
      }
    }
    const started = Date.now();
    await view.locator('.monaco-workbench').waitFor({ timeout: 240_000 });
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 90_000 });
    check(`[${size}] 1 the Explorer opens in the rail panel, VS Code's Explorer alone`, true, `${((Date.now() - started) / 1000).toFixed(1)} s to its files`);
    marks.view = { readyMs: Date.now() - (first ? started : viewStart), heap: await heap() };
    const viewParts = await partsOf(view);
    check(`[${size}] 1 the rail panel's workbench shows the view container alone: no activity bar, editor area, panel or status bar`,
      viewParts.sidebar && !viewParts.activitybar && !viewParts.editor && !viewParts.panel && !viewParts.statusbar, JSON.stringify(viewParts));
    await shot(page, `${size}-1-explorer`);
    for (const [entry, title] of BUILT_INS) {
      await entryButton(page, entry).click();
      const shown = await until(async () => (await sidebarTitle(view)).toLowerCase().startsWith(title.toLowerCase()), 20_000);
      const lit = await until(async () => (await rail(page)).find((item) => item.id === entrySurface(entry))?.pressed, 5_000);
      check(`[${size}] 1 ${title}: its rail icon opens its view, and only its icon is lit`, shown && lit, await sidebarTitle(view));
      await shot(page, `${size}-1-${entry}`);
    }

    // ── 2. An extension installed on the VS Code Server: its icon comes and opens its view (it goes in 8) ──
    if (first) {
      probe = makeProbe();
      const before = Date.now();
      serverCli('--install-extension', probe.vsix, '--force');
      const came = await until(async () => (await rail(page)).some((item) => item.id === entrySurface(PROBE.entry)), 30_000);
      check(`[${size}] 2 installing an extension with an activity-bar view container gives it a rail icon, without a reload`, came, `${((Date.now() - before) / 1000).toFixed(1)} s after the install`);
      const mask = await entryButton(page, PROBE.entry).locator('span[style*="mask"]').getAttribute('style').catch(() => '');
      check(`[${size}] 2 its icon is the extension's own SVG`, /data:image\/svg\+xml/.test(mask ?? ''));
      await shot(page, `${size}-2-installed`);
      await entryButton(page, PROBE.entry).click();
      const opened = await until(async () => (await view.locator('.part.sidebar').innerText({ timeout: 2_000 })).includes(PROBE.welcome), 30_000);
      check(`[${size}] 2 its icon opens its view`, opened, await sidebarTitle(view));
      await shot(page, `${size}-2-probe-view`);
      await entryButton(page, 'explorer').click();
    }
    await until(async () => (await sidebarTitle(view)).toLowerCase() === 'explorer', 15_000);

    // ── 3. Files as header tabs ──
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click();
    const tabbed = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.active), 30_000);
    const chatTab = page.locator('[role="tablist"] [role="tab"]', { hasText: CHATS[0] }).first();
    check(`[${size}] 3 a file opened from the Explorer gets its header tab beside the chats' tabs`, tabbed && await chatTab.count() > 0, (await headerTabs(page)).map((tab) => tab.title).join(' | '));
    const pageStart = Date.now();
    const editorShown = await until(async () => await pageShown(page) && await pageFrame(page).locator('.part.editor .monaco-editor[data-uri$="README.md"] .view-line').first().isVisible(), 120_000);
    marks.editor = { readyMs: Date.now() - pageStart, heap: await heap() };
    check(`[${size}] 3 its tab shows the editor in the main area`, editorShown);
    await pageStarted(page);
    const pageParts = await partsOf(pageFrame(page)).catch(() => ({}));
    check(`[${size}] 3 the page is VS Code's editor area: no activity bar, side bar or panel, and no VS Code tab bar`, editorShown && pageParts.editor && !pageParts.activitybar && !pageParts.sidebar && !pageParts.panel && pageParts.tabs === 0, JSON.stringify(pageParts));
    await shot(page, `${size}-3-header-tab`);
    await pageFrame(page).locator('.monaco-workbench').evaluate(() => {
      window.__surfacesMarker = 'kept';
    });
    await chatTab.click();
    const toChat = await until(async () => !(await pageShown(page)) && page.url().includes(seeded[0]), 15_000);
    await shot(page, `${size}-3-back-to-chat`);
    await headerTab(page, 'README.md').click();
    const back = await until(async () => await pageShown(page) && await pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').first().isVisible(), 15_000);
    const kept = await pageFrame(page).locator('.monaco-workbench').evaluate(() => window.__surfacesMarker).catch(() => null);
    check(`[${size}] 3 switching to a chat and back keeps the editor (the same workbench, not reloaded)`, toChat && back && kept === 'kept', `marker ${kept}`);
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'notes.ts' }).first().click();
    const second = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('notes.ts') && tab.active), 20_000);
    check(`[${size}] 3 a second file opens as a second header tab`, second, (await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | '));
    await headerTab(page, 'README.md').click();
    await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.active), 10_000);
    const editor = pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').first();
    await editor.locator('.view-line').first().click();
    // VS Code for the web saves a second after an edit by default: off for this, so there is something to ask about.
    const toggleAutoSave = async () => {
      await runCommand(page, pageFrame(page), 'File: Toggle Auto Save');
      await wait(800);
    };
    await toggleAutoSave();
    await editor.locator('.view-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${run}`);
    const dirty = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.dirty), 10_000);
    check(`[${size}] 3 editing makes the header tab dirty`, dirty);
    await shot(page, `${size}-3-dirty`);
    await closeHeaderTab(page, 'README.md');
    const asked = await until(async () => (await pageFrame(page).locator('.monaco-dialog-box').first().innerText({ timeout: 1_000 })).includes('README.md'), 15_000);
    await shot(page, `${size}-3-save-dialog`);
    if (asked) await pageFrame(page).locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).first().click();
    const closed = await until(async () => !(await headerTabs(page)).some((tab) => tab.title.includes('README.md')) && !(await pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').count()), 15_000);
    check(`[${size}] 3 closing the tab closes the editor, asking to save as VS Code does`, asked && closed, `asked ${Boolean(asked)}, closed ${Boolean(closed)}`);
    check(`[${size}] 3 the file was not saved ("Don't Save")`, !readFileSync(join(project, 'README.md'), 'utf8').includes(run));
    await pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"] .view-line').first().click();
    await toggleAutoSave();

    // ── 7. Markdown's preview (a VS Code webview) in the page, and in a rail view ──
    if (first) {
      await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click();
      await until(async () => await pageShown(page) && (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.active), 20_000);
      const readmeLine = pageFrame(page).locator('.monaco-editor[data-uri$="README.md"] .view-line').first();
      await until(() => readmeLine.isVisible(), 20_000);
      await readmeLine.click();
      // A webview panel (what VS Code restores with deserializeWebviewPanel), beside the file in the page.
      await runCommand(page, pageFrame(page), 'Markdown: Open Preview to the Side');
      const previewTab = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('Preview')), 20_000);
      const pageHeading = await until(async () => (await previewHeading(pageFrame(page))) || null, 30_000);
      check(`[${size}] 7 Markdown's preview opened in the page is a header tab of its own, and renders`, previewTab && pageHeading === 'demo',
        `${(await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | ')}; heading ${JSON.stringify(pageHeading)}`);
      await shot(page, `${size}-7-preview-page`);
      await previewContent(pageFrame(page)).locator('h1').first().click();
      await page.keyboard.press('Control+Shift+p');
      const palette = await pageFrame(page).locator('.quick-input-widget input').waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
      check(`[${size}] 7 a key pressed in the page's preview reaches VS Code (Ctrl+Shift+P opens its command palette)`, palette);
      await page.keyboard.press('Escape');
      await closeHeaderTab(page, 'Preview');
      await until(async () => !(await headerTabs(page)).some((tab) => tab.title.includes('Preview')), 10_000);
      await closeHeaderTab(page, 'README.md');
      await until(async () => !(await headerTabs(page)).some((tab) => tab.title.includes('README.md')), 10_000);
      // From a rail view: a webview can't go to the page, so it opens in the rail panel.
      await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click({ button: 'right' });
      const openPreview = view.locator('.context-view .action-label', { hasText: /^Open Preview$/ }).first();
      await openPreview.waitFor({ timeout: 10_000 });
      // VS Code's menus take a click only 100 ms after they show.
      await wait(500);
      await openPreview.click();
      const viewHeading = await until(async () => (await previewHeading(view)) || null, 30_000);
      const previewParts = await partsOf(view).catch(() => ({}));
      check(`[${size}] 7 Markdown's preview opened from the Explorer renders in the rail panel`, viewHeading === 'demo' && previewParts.editor && previewParts.sidebar, `heading ${JSON.stringify(viewHeading)}; ${JSON.stringify(previewParts)}`);
      await shot(page, `${size}-7-preview-view`);
      await page.keyboard.press('Escape');
      await view.locator('.part.sidebar .composite.title').first().click();
      await runCommand(page, view, 'View: Close All Editors');
      const bare = await until(async () => !(await partsOf(view)).editor, 10_000);
      check(`[${size}] 7 closed, the rail panel is the Explorer alone again`, bare);
    }

    // ── 4. The terminal at the bottom, under a chat first (under a file's editor in 11) ──
    await chatTab.click();
    await until(async () => !(await pageShown(page)), 10_000);
    await entryButton(page, 'terminal').click();
    const bottom = bottomFrame(page);
    const termStart = Date.now();
    const xterm = bottom.locator('.xterm:visible').first();
    // VS Code revives the terminals of this workbench's last session; one whose process is gone shows nothing: a new one then.
    if (!(await xterm.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false))) {
      await bottom.locator('.part.panel .action-label[aria-label^="New Terminal"]').first().click();
      await xterm.waitFor({ timeout: 60_000 });
    }
    await until(async () => ((await page.locator('[data-context-zone="bottom"]').boundingBox())?.height ?? 0) >= 160, 10_000);
    await wait(2_500);
    marks.terminal = { readyMs: Date.now() - termStart, heap: await heap() };
    const zone = await page.locator('[data-context-zone="bottom"]').boundingBox();
    const terminalParts = await partsOf(bottom).catch(() => ({}));
    check(`[${size}] 4 the terminal entry opens VS Code's panel at OpenChamber's bottom, maximized, nothing else`, zone && zone.y > viewport.height / 3 && zone.height >= 160 && terminalParts.panel && !terminalParts.editor && !terminalParts.sidebar && !terminalParts.activitybar,
      `${((Date.now() - termStart) / 1000).toFixed(1)} s; zone ${zone ? `${Math.round(zone.x)},${Math.round(zone.y)} ${Math.round(zone.width)}×${Math.round(zone.height)}` : 'none'}; ${JSON.stringify(terminalParts)}`);
    const marker = join('/tmp', `${run}-${viewport.width}.txt`);
    // Any shell: the server's user may run bash, zsh or fish. Typed again if the shell wasn't listening yet.
    let ran = false;
    for (let attempt = 0; attempt < 3 && !ran; attempt++) {
      await xterm.click();
      await wait(1_000);
      await page.keyboard.type(`echo ${run}-ran > ${marker}`);
      await page.keyboard.press('Enter');
      ran = Boolean(await until(() => existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${run}-ran`, 10_000));
    }
    check(`[${size}] 4 a command runs in it, on the VS Code Server's machine`, ran);
    await shot(page, `${size}-4-terminal`);
    // From one terminal: VS Code keeps the terminals of every earlier session, and lists only the rows that fit.
    await xterm.click();
    await runCommand(page, bottom, 'Terminal: Kill All Terminals');
    await until(async () => (await bottom.locator('.xterm:visible').count()) === 0, 15_000);
    await bottom.locator('.part.panel .action-label[aria-label^="New Terminal"]').first().click();
    await xterm.waitFor({ timeout: 30_000 });
    const terminals = () => bottom.locator('.terminal-tabs-entry').count();
    const before = await terminals();
    await bottom.locator('.part.panel .action-label[aria-label^="New Terminal"]').first().click();
    const added = await until(async () => (await terminals()) >= 2 && (await terminals()) > before, 20_000);
    await wait(1_500);
    await bottom.locator('.xterm:visible').first().click();
    await page.keyboard.press('Control+Shift+5');
    const split = await until(async () => (await bottom.locator('.xterm:visible').count()) >= 2, 20_000);
    check(`[${size}] 4 a second terminal, and a split (two terminals side by side)`, added && split, `${await terminals()} terminals listed, ${await bottom.locator('.xterm:visible').count()} shown`);
    await shot(page, `${size}-4-split`);
    await bottom.locator('.part.panel .action-label[aria-label="Launch Profile..."]').first().click();
    const profiles = await until(async () => {
      const items = await bottom.locator('.context-view .action-label, .quick-input-widget .quick-input-list .monaco-list-row').allTextContents();
      return items.filter((item) => item.trim()).length > 0 ? items : null;
    }, 10_000);
    check(`[${size}] 4 the shell picker is there`, profiles, (profiles ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 6).join(' | '));
    await shot(page, `${size}-4-shell-picker`);
    await page.keyboard.press('Escape');
    await bottom.locator('.monaco-workbench').evaluate(() => {
      window.__surfacesMarker = 'terminal kept';
    });

    // ── Cost: the three workbenches (rail view, page, terminal) running at once ──
    const starts = await frameStarts(page);
    const hosts = [...extensionHosts()].filter(([pid]) => !hostsBefore.has(pid)).map(([, mb]) => mb);
    const cost = {
      // MB of JS heap each one added to the page's renderer, in the order they started.
      heapMB: { view: marks.view.heap - marks.before.heap, editor: marks.editor.heap - marks.view.heap, terminal: marks.terminal.heap - marks.editor.heap, total: marks.terminal.heap - marks.before.heap },
      // ms from the frame's navigation to its workbench running (its own clock), and from the click to its content.
      startMs: starts,
      readyMs: { view: marks.view.readyMs, editor: marks.editor.readyMs, terminal: marks.terminal.readyMs },
      // The VS Code Server's extension hosts this window started (one per workbench), resident MB.
      extensionHostsMB: hosts,
    };
    writeFileSync(join(out, `${size}-frames.json`), `${JSON.stringify(cost, null, 2)}\n`);
    check(`[${size}] the three workbenches' start and memory are measured`, ['view', 'editor', 'terminal'].every((role) => starts[role]), JSON.stringify(cost));

    if (first) {
      // ── 8. Cmd/Ctrl+click on a link to a file in a rail view: a new browser tab; a plain click: a header tab here ──
      await entryButton(page, PROBE.entry).click();
      const probeLink = view.locator('.welcome-view-content a', { hasText: 'linked.md' }).first();
      await probeLink.waitFor({ timeout: 30_000 });
      const beforeView = await tabState(page);
      const viaView = await newTabShows(context, 'linked.md', null, () => probeLink.click({ modifiers: ['Control'] }), `${size}-8-new-tab-from-view`);
      if (viaView.tab) deepLinks.push(viaView.tab);
      await wait(1_500);
      const afterView = await tabState(page);
      check(`[${size}] 8 Ctrl+click on a link to a file in a rail view opens a new browser tab, which shows that file's editor`, viaView.ok, viaView.detail);
      check(`[${size}] 8 ... and this tab stays as it was`, JSON.stringify(afterView) === JSON.stringify(beforeView), `${JSON.stringify(beforeView)} → ${JSON.stringify(afterView)}`);
      await shot(page, `${size}-8-after-ctrl-click-view`);
      await probeLink.click();
      const here = await until(async () => await pageShown(page) && (await headerTabs(page)).find((tab) => tab.title.includes('linked.md') && tab.active)
        && await pageFrame(page).locator('.monaco-editor[data-uri$="linked.md"] .view-line').first().isVisible(), 60_000);
      check(`[${size}] 8 a plain click on it opens the file here, as a header tab`, here, (await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | '));
      await shot(page, `${size}-8-plain-click`);

      // ── 9. Alt+W, OpenChamber's close-tab key, from a rail view: VS Code binds nothing to it there ──
      await view.locator('.welcome-view-content p', { hasText: PROBE.welcome }).first().click();
      await page.keyboard.press('Alt+w');
      const closedByKey = await until(async () => !(await headerTabs(page)).some((tab) => tab.title.includes('linked.md')), 10_000);
      check(`[${size}] 9 Alt+W in a rail view reaches OpenChamber: its close-tab key closes the selected file tab`, closedByKey, (await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | '));

      // ── 2. The extension uninstalled: its icon goes ──
      await entryButton(page, 'explorer').click();
      const removedAt = Date.now();
      serverCli('--uninstall-extension', `${PROBE.publisher}.${PROBE.name}`);
      const went = await until(async () => !(await rail(page)).some((item) => item.id === entrySurface(PROBE.entry)), 30_000);
      check(`[${size}] 2 uninstalled, its icon goes, without a reload`, went, `${((Date.now() - removedAt) / 1000).toFixed(1)} s after the uninstall`);

      // ── 11. The terminal under a file's editor: the page keeps OpenChamber's bottom zone ──
      const terminalLit = async () => (await rail(page)).find((item) => item.id === entrySurface('terminal'))?.pressed;
      await headerTab(page, 'notes.ts').click();
      await until(async () => await pageShown(page) && await pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"] .view-line').first().isVisible(), 30_000);
      // Closed first, so that the entry opens it with the page shown.
      if (await terminalLit()) {
        await entryButton(page, 'terminal').click();
        await until(async () => !(await terminalLit()), 10_000);
      }
      await entryButton(page, 'terminal').click();
      const stacking = async () => {
        if (!(await pageShown(page)) || !(await bottom.locator('.xterm:visible').first().isVisible())) return null;
        const pageBox = await page.locator(`[data-oc-forge-page="${VSCODE}"]`).boundingBox();
        const zoneBox = await page.locator('[data-context-zone="bottom"]').boundingBox();
        if (!pageBox || !zoneBox || zoneBox.height < 120) return null;
        const gap = Math.round(zoneBox.y - (pageBox.y + pageBox.height));
        const sameColumn = zoneBox.x < pageBox.x + pageBox.width && zoneBox.x + zoneBox.width > pageBox.x;
        return { pageBox, zoneBox, gap, ok: sameColumn && Math.abs(gap) <= 12 };
      };
      const stacked = await until(async () => (await stacking())?.ok ? stacking() : null, 60_000) ?? await stacking();
      const boxes = stacked ? `page ${Math.round(stacked.pageBox.y)}–${Math.round(stacked.pageBox.y + stacked.pageBox.height)}, zone ${Math.round(stacked.zoneBox.y)}–${Math.round(stacked.zoneBox.y + stacked.zoneBox.height)} (x ${Math.round(stacked.zoneBox.x)}–${Math.round(stacked.zoneBox.x + stacked.zoneBox.width)}), gap ${stacked.gap} px` : 'not both shown';
      check(`[${size}] 11 with a file tab shown, the terminal entry opens VS Code's terminal under the editor: the page ends where the bottom zone begins`, stacked?.ok, boxes);
      await shot(page, `${size}-11-terminal-under-editor`);
      const underMarker = join('/tmp', `${run}-under-${viewport.width}.txt`);
      let typed = false;
      for (let attempt = 0; attempt < 3 && !typed; attempt++) {
        await bottom.locator('.xterm:visible').first().click();
        await wait(800);
        await page.keyboard.type(`echo ${run}-under > ${underMarker}`);
        await page.keyboard.press('Enter');
        typed = Boolean(await until(() => existsSync(underMarker) && readFileSync(underMarker, 'utf8').trim() === `${run}-under`, 10_000));
      }
      // VS Code for the web saves a second after an edit (auto save is on again since 3).
      await pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"] .view-line').first().click({ position: { x: 4, y: 4 } });
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(`// ${run}-edited`);
      const edited = await until(() => readFileSync(join(project, 'notes.ts'), 'utf8').includes(`${run}-edited`), 15_000);
      check(`[${size}] 11 both take input: a command typed in the terminal runs, and an edit in the editor above it is saved`, typed && edited, `terminal ${typed ? 'ran it' : 'did not run it'}, editor ${edited ? 'saved' : 'did not save'}`);
      await pageFrame(page).locator('.monaco-workbench').evaluate(() => {
        window.__underMarker = 'page';
      });
      await bottom.locator('.monaco-workbench').evaluate(() => {
        window.__underMarker = 'terminal';
      });
      await chatTab.click();
      const underChat = await until(async () => !(await pageShown(page)) && await bottom.locator('.xterm:visible').first().isVisible(), 15_000);
      await headerTab(page, 'notes.ts').click();
      const bothBack = await until(async () => (await stacking())?.ok
        && (await pageFrame(page).locator('.monaco-workbench').evaluate(() => window.__underMarker)) === 'page'
        && (await bottom.locator('.monaco-workbench').evaluate(() => window.__underMarker)) === 'terminal', 15_000);
      check(`[${size}] 11 to a chat and back: the terminal stays under the chat, then both are there again (the same two workbenches)`, underChat && bothBack, `under the chat ${Boolean(underChat)}, back ${Boolean(bothBack)}`);

      // ── 8. Cmd/Ctrl+click on a file link in the terminal, under the editor ──
      const shell = bottom.locator('.xterm:visible').first();
      await shell.click();
      await page.keyboard.type('clear');
      await page.keyboard.press('Enter');
      await wait(800);
      await page.keyboard.type("printf 'linked.md:2\\n%.0s' 1 2 3 4 5 6");
      await page.keyboard.press('Enter');
      await wait(1_500);
      // Once xterm has put its helper on the cursor's cell, under the six lines.
      const cell = await until(async () => {
        const measured = await terminalCell(bottom);
        return measured.cursorRow >= 6 && measured.height > 0 && measured.width > 0 ? measured : null;
      }, 15_000) ?? await terminalCell(bottom);
      // The six lines are above the prompt: the third from the bottom, on its fifth character.
      const position = { x: cell.width * 4.5, y: (cell.cursorRow - 3 + 0.5) * cell.height };
      const screen = bottom.locator('.xterm:visible .xterm-screen').first();
      const beforeTerminal = await tabState(page);
      let viaTerminal = { tab: null, ok: false, detail: '' };
      for (let attempt = 0; attempt < 2 && !viaTerminal.tab; attempt++) {
        // VS Code checks a link (that the file is there) while the pointer is over it; a click with the modifier then opens it.
        await screen.hover({ position });
        await wait(2_000);
        viaTerminal = await newTabShows(context, 'linked.md', 2, () => screen.click({ position, modifiers: ['Control'] }), `${size}-8-new-tab-from-terminal`);
      }
      if (viaTerminal.tab) deepLinks.push(viaTerminal.tab);
      await wait(1_500);
      const afterTerminal = await tabState(page);
      check(`[${size}] 8 Ctrl+click on a file link in the terminal, under the editor, opens a new browser tab, which shows that file's editor at its line`, viaTerminal.ok, `${viaTerminal.detail}; clicked row ${cell.cursorRow - 3}`);
      check(`[${size}] 8 ... and this tab stays as it was`, JSON.stringify(afterTerminal) === JSON.stringify(beforeTerminal), `${JSON.stringify(beforeTerminal)} → ${JSON.stringify(afterTerminal)}`);
      await shot(page, `${size}-8-after-ctrl-click-terminal`);
    }

    // ── 5. Keys, with focus in VS Code: two editors in the page, README.md the active one ──
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click();
    await until(async () => await pageShown(page) && (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.active), 20_000);
    const readme = pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').first();
    await readme.locator('.view-line').first().click();
    const sessionBefore = new URL(page.url()).searchParams.get('session');
    const groupCount = () => pageFrame(page).locator('.part.editor .editor-group-container').count();
    await page.keyboard.press('Control+Alt+ArrowRight');
    const moved = await until(async () => (await groupCount()) >= 2, 5_000);
    const stayed = await pageShown(page) && new URL(page.url()).searchParams.get('session') === sessionBefore;
    check(`[${size}] 5 Ctrl+Alt+→ in VS Code acts in VS Code (moves the editor to a group of its own), not OpenChamber's next tab`, moved && stayed, `groups ${await groupCount()}, page still shown ${stayed}`);
    await page.keyboard.press('Control+1');
    const firstGroup = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes("notes.ts") && tab.active), 5_000);
    const stillPage = await pageShown(page) && new URL(page.url()).searchParams.get('session') === sessionBefore;
    check(`[${size}] 5 Ctrl+1 in VS Code acts in VS Code (focuses its first group, whose notes.ts the header then selects), not OpenChamber's first chat tab`, firstGroup && stillPage, `page shown ${stillPage}, header ${(await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | ')}`);
    await shot(page, `${size}-5-keys`);

    /** Ctrl+Alt+<n> from a frame: OpenChamber's rail shows its own surface n (the first it doesn't show now), not the main area's change. */
    const railDigitFrom = async (where, focus) => {
      const items = await rail(page);
      // Only OpenChamber's own surfaces up to it: those count the same in the rail and in OpenChamber's digit handler.
      const index = items.findIndex((item, at) => at < 9 && !item.id.startsWith('plugin:') && item.id !== 'terminal' && !item.pressed && items.slice(0, at).every((other) => !other.id.startsWith('plugin:')));
      if (index < 0) {
        check(`[${size}] 9 Ctrl+Alt+<n> from ${where} reaches OpenChamber's rail`, false, `no surface of its own to switch to: ${items.map((item) => item.id).join(' ')}`);
        return;
      }
      const target = items[index];
      const mainBefore = await pageShown(page);
      await focus();
      await page.keyboard.press(`Control+Alt+${index + 1}`);
      const switched = await until(async () => (await rail(page)).find((item) => item.id === target.id)?.pressed, 5_000);
      const mainKept = (await pageShown(page)) === mainBefore;
      check(`[${size}] 9 Ctrl+Alt+${index + 1} from ${where} reaches OpenChamber: its rail shows ${target.id}`, switched && mainKept, `shown now: ${(await rail(page)).filter((item) => item.pressed).map((item) => item.id).join(' ')}; main area ${mainKept ? 'unchanged' : 'changed'}`);
      await shot(page, `${size}-9-rail-digit-${where.split(' ').pop()}`);
      await entryButton(page, 'explorer').click();
      await until(async () => (await rail(page)).find((item) => item.id === entrySurface('explorer'))?.pressed && (await sidebarTitle(view)).toLowerCase() === 'explorer', 60_000);
    };
    if (first) {
      // ── 9. OpenChamber's keys from each VS Code frame ──
      // Alt+W is VS Code's in its editor (Toggle Find: Match Whole Word): the tab stays.
      const activeBefore = (await headerTabs(page)).find((tab) => tab.active)?.title;
      await page.keyboard.press('Alt+w');
      await wait(1_500);
      const activeAfter = (await headerTabs(page)).find((tab) => tab.active)?.title;
      check(`[${size}] 9 Alt+W in the page's editor stays VS Code's (Toggle Match Whole Word): the file tab stays`, activeBefore && activeAfter === activeBefore && await pageShown(page), `${activeBefore} → ${activeAfter}`);
      // Into the editor's text, past its gutter: in a narrow group its lines may be scrolled sideways.
      await railDigitFrom("the page's editor", () => pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"]').first().click({ position: { x: 90, y: 12 } }));
      await railDigitFrom('the rail view', async () => {
        const list = view.locator('.explorer-folders-view .monaco-list').first();
        const box = await list.boundingBox();
        await list.click({ position: { x: 40, y: Math.max(4, (box?.height ?? 40) - 8) } });
      });
    }
    await chatTab.click();
    const terminalKept = await until(async () => (await bottom.locator('.monaco-workbench').evaluate(() => window.__surfacesMarker)) === 'terminal kept', 15_000);
    check(`[${size}] 4 back on a chat, the terminal at the bottom is the same one (kept while file tabs showed)`, terminalKept);
    if (first) {
      await railDigitFrom('the terminal', () => bottom.locator('.xterm:visible').first().click());
      // Alt+W is the shell's in the terminal (Esc w: readline, tmux, Emacs): OpenChamber's chat tab stays.
      await bottom.locator('.xterm:visible').first().click();
      await page.keyboard.press('Alt+w');
      await wait(1_500);
      check(`[${size}] 9 Alt+W in the terminal stays the shell's: OpenChamber's chat tab stays`, await chatTab.count() > 0 && new URL(page.url()).searchParams.get('session') === seeded[0], page.url());

      // ── 12. Closing the last unsaved file tab: VS Code's own close, with its save prompt ──
      const readmeFile = join(project, 'README.md');
      const original = readFileSync(readmeFile, 'utf8');
      const dialog = pageFrame(page).locator('.monaco-dialog-box').first();
      // Every file tab closed first (they are saved: auto save is on), so that README.md is the last one.
      for (let guard = 0; guard < 12 && (await headerTabs(page)).length > 0; guard++) {
        const [tab] = await headerTabs(page);
        const element = page.locator(`[data-oc-forge-tab="${VSCODE}:${tab.id}"]`).first();
        await element.hover();
        await element.getByRole('button', { name: 'Close tab' }).click();
        if (await until(() => dialog.isVisible(), 1_500)) await dialog.locator('.monaco-button', { hasText: /^Don't Save$/ }).first().click();
        await until(async () => !(await headerTabs(page)).some((item) => item.id === tab.id), 10_000);
      }
      const readmeRow = view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first();
      const readmeEditor = pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').first();
      const openReadmeAlone = async () => {
        await readmeRow.click();
        const alone = await until(async () => {
          const tabs = await headerTabs(page);
          return await pageShown(page) && tabs.length === 1 && tabs[0].title.includes('README.md') && await readmeEditor.locator('.view-line').first().isVisible();
        }, 30_000);
        await pageStarted(page);
        return alone;
      };
      const changeReadme = async (text) => {
        await readmeEditor.locator('.view-line').first().click();
        await page.keyboard.press('End');
        await page.keyboard.type(text);
        return until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.dirty), 10_000);
      };
      /** VS Code's save prompt for README.md in the page, answered. */
      const answer = async (button) => {
        const asked = await until(async () => (await dialog.innerText({ timeout: 1_000 })).includes('README.md'), 15_000);
        if (asked) await dialog.locator('.monaco-button', { hasText: button }).first().click();
        return Boolean(asked);
      };
      const backOnChat = () => until(async () => (await headerTabs(page)).length === 0 && !(await pageShown(page)) && new URL(page.url()).searchParams.get('session') === seeded[0], 15_000);
      const lone = await openReadmeAlone();
      await readmeEditor.locator('.view-line').first().click();
      // Off, so that a change waits for the prompt.
      await toggleAutoSave();
      const dirtied = await changeReadme(` ${run}-cancelled`);
      // A middle click closes a tab, as its × does.
      await headerTab(page, 'README.md').click({ button: 'middle' });
      const askedCancel = await answer(/^Cancel$/);
      await shot(page, `${size}-12-cancel-asked`);
      await wait(1_500);
      const tabKept = (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.dirty);
      const textKept = (await readmeEditor.locator('.view-lines').innerText().catch(() => '')).includes(`${run}-cancelled`);
      const notWritten = !readFileSync(readmeFile, 'utf8').includes(`${run}-cancelled`);
      check(`[${size}] 12 closing the last unsaved tab (a middle click) asks as VS Code does; Cancel keeps the tab, the editor and the unsaved change`, lone && dirtied && askedCancel && tabKept && await pageShown(page) && textKept && notWritten,
        `asked ${askedCancel}; tab ${tabKept ? 'kept, unsaved' : 'gone'}; page ${await pageShown(page) ? 'shown' : 'hidden'}; change ${textKept ? 'in the editor' : 'lost'}, ${notWritten ? 'not written' : 'written'}`);
      await shot(page, `${size}-12-cancelled`);
      // The close-tab key, from the rail view (VS Code binds nothing to it there).
      const explorerList = view.locator('.explorer-folders-view .monaco-list').first();
      const listBox = await explorerList.boundingBox();
      await explorerList.click({ position: { x: 40, y: Math.max(4, (listBox?.height ?? 40) - 8) } });
      await page.keyboard.press('Alt+w');
      const askedDont = await answer(/^Don't Save$/);
      const closedDont = await backOnChat();
      const unwritten = !readFileSync(readmeFile, 'utf8').includes(`${run}-cancelled`);
      check(`[${size}] 12 the close-tab key (Alt+W) asks too; Don't Save closes it without writing the file, back to the chat`, askedDont && closedDont && unwritten, `asked ${askedDont}; closed and back on the chat ${Boolean(closedDont)}; file ${unwritten ? 'unchanged' : 'written'}`);
      // Opened again, it is the file: what Don't Save threw away doesn't come back from VS Code's backup of it.
      await openReadmeAlone();
      const asOnDisk = async () => !(await readmeEditor.locator('.view-lines').innerText()).includes(`${run}-cancelled`) && !(await headerTabs(page)).some((tab) => tab.dirty);
      const discarded = await until(asOnDisk, 10_000);
      check(`[${size}] 12 opened again after Don't Save, the file is as on disk: the thrown-away change doesn't come back`, Boolean(discarded), `${(await headerTabs(page)).map((tab) => `${tab.title}${tab.dirty ? ' (unsaved)' : ''}`).join(' | ')}`);
      await changeReadme(` ${run}-saved`);
      await closeHeaderTab(page, 'README.md');
      const askedSave = await answer(/^Save$/);
      const closedSave = await backOnChat();
      const written = readFileSync(readmeFile, 'utf8').includes(`${run}-saved`);
      check(`[${size}] 12 its × asks too; Save writes the file and closes it, back to the chat`, askedSave && closedSave && written, `asked ${askedSave}; closed and back on the chat ${Boolean(closedSave)}; file ${written ? 'written' : 'not written'}`);
      await shot(page, `${size}-12-saved`);
      // As it was, and auto save on again; a saved tab closes at once.
      writeFileSync(readmeFile, original);
      await openReadmeAlone();
      await until(async () => !(await readmeEditor.locator('.view-lines').innerText()).includes(`${run}-saved`), 10_000);
      await readmeEditor.locator('.view-line').first().click();
      await toggleAutoSave();
      await closeHeaderTab(page, 'README.md');
      const atOnce = await until(async () => (await headerTabs(page)).length === 0, 3_000);
      const unasked = !(await dialog.isVisible().catch(() => false));
      check(`[${size}] 12 a saved tab closes at once, as before (no prompt)`, atOnce && unasked, `closed ${Boolean(atOnce)}, prompt ${unasked ? 'none' : 'shown'}`);

      // ── 12. Across a reload: the tabs come back once each, and closed tabs stay closed ──
      const titles = async () => (await headerTabs(page)).map((tab) => tab.title);
      const railBack = async () => {
        if (!(await until(async () => (await rail(page)).find((item) => item.id === entrySurface('explorer'))?.pressed, 15_000))) await entryButton(page, 'explorer').click();
        await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'notes.ts' }).first().waitFor({ timeout: 90_000 });
      };
      await openReadmeAlone();
      await readmeEditor.locator('.view-line').first().click();
      const commandAt = Date.now();
      await runCommand(page, pageFrame(page), 'Markdown: Open Preview to the Side');
      // Each page start is a new extension host, which takes its time on a server without DNS (the private network
      // namespace): its built-in extensions wait out their lookups first.
      const previewBefore = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('Preview')), 120_000);
      const previewAfter = ((Date.now() - commandAt) / 1000).toFixed(1);
      // Rendered, the preview has its state (the file it shows), which VS Code saves every few seconds; a page that
      // reloads can't save it on the way out.
      const renderedBefore = await until(async () => (await previewHeading(pageFrame(page))) === 'demo', 90_000);
      const renderedAfter = ((Date.now() - commandAt) / 1000).toFixed(1);
      await wait(7_000);
      await page.reload({ waitUntil: 'load' });
      await railBack();
      // The rail view brings the tabs back and the page starts behind them: VS Code revives the preview under a new
      // key, which takes its old tab's place.
      const revived = await until(async () => {
        const tabs = await headerTabs(page);
        const previews = tabs.filter((tab) => tab.title.includes('Preview'));
        return tabs.length === 2 && previews.length === 1 && previews[0].id !== previewBefore?.id ? tabs : null;
      }, 90_000);
      await headerTab(page, 'Preview').click();
      const rendered = await until(async () => (await previewHeading(pageFrame(page))) === 'demo', 90_000);
      await wait(2_000);
      check(`[${size}] 12 after a reload the tabs come back once each: Markdown's preview, which VS Code revives under a new key, takes its old tab's place`,
        Boolean(previewBefore && revived) && (await titles()).length === 2, `${(await titles()).join(' | ')}; before the reload its tab came ${previewBefore ? `${previewAfter} s` : 'never'} after the command`);
      check(`[${size}] 12 ... and the revived preview renders the file again`, Boolean(renderedBefore && rendered),
        renderedBefore ? `rendered ${renderedAfter} s after the command before the reload; after it ${rendered ? 'rendered' : 'not rendered'}` : 'it never rendered before the reload (its extension host made no progress), so it had no state to come back with');
      await shot(page, `${size}-12-reloaded`);
      // Both closed, the last with the page (the rail view keeps the folder's tabs then): they stay closed.
      await closeHeaderTab(page, 'Preview');
      await until(async () => (await titles()).length === 1, 10_000);
      await closeHeaderTab(page, 'README.md');
      await until(async () => (await titles()).length === 0, 10_000);
      await wait(1_500);
      await page.reload({ waitUntil: 'load' });
      await railBack();
      await wait(5_000);
      const afterReload = await titles();
      await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'notes.ts' }).first().click();
      const onlyNotes = await until(async () => {
        const now = await titles();
        return now.length === 1 && now[0].includes('notes.ts') && await pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"] .view-line').first().isVisible();
      }, 90_000);
      await wait(2_000);
      const settled = await titles();
      check(`[${size}] 12 closed tabs stay closed: none comes back after a reload, and the next file opened is the only tab (VS Code doesn't reopen them)`,
        afterReload.length === 0 && Boolean(onlyNotes) && settled.length === 1, `after the reload: ${afterReload.join(' | ') || 'none'}; then: ${settled.join(' | ')}`);
      await closeHeaderTab(page, 'notes.ts');
      await until(async () => (await titles()).length === 0, 10_000);
    }

    // ── 6. Nothing else opened ──
    const others = popups.filter((opened) => !deepLinks.includes(opened));
    check(`[${size}] 6 nothing opened another page or window${first ? ' but the Ctrl+click tabs (8)' : ''}`, others.length === 0, others.map((opened) => opened.url()).join(' ') || `${deepLinks.length} Ctrl+click tabs`);
    check(`[${size}] no page errors from the extension`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (error) {
    check(`[${size}] the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
    await shot(page, `${size}-99-failure`).catch(() => undefined);
  } finally {
    if (probe) rmSync(probe.dir, { recursive: true, force: true });
  }
  // Leave no header tab, panel or terminal behind for the next round.
  await context.close();
};

// ── 10. "Open in VS Code" on a chat in another folder, and back ──
const openInVscode = async (seeded, chatB) => {
  const size = '1440x900';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript(seedTabs, [...seeded, chatB]);
  const page = await context.newPage();
  const popups = [];
  context.on('page', (opened) => popups.push(opened.url()));
  // The rail panel shown now (OpenChamber keeps one per folder).
  const view = page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]:visible').first();
  const explorerRows = () => view.locator('.explorer-folders-view .monaco-list-row').allTextContents();
  const explorerLit = async () => (await rail(page)).find((item) => item.id === entrySurface('explorer'))?.pressed;
  const openInVscodeOn = async (title) => {
    await page.locator('[role="tablist"] [role="tab"]', { hasText: title }).first().click();
    await until(async () => !(await pageShown(page)), 10_000);
    await openChatMenu(page);
    await page.getByRole('menuitem', { name: 'Open in VS Code' }).click({ timeout: 10_000 });
  };
  try {
    await page.goto(`${base}/?session=${seeded[0]}`);
    await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    if (!(await explorerLit())) await entryButton(page, 'explorer').click();
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click({ timeout: 120_000 });
    await until(async () => await pageShown(page) && await pageFrame(page).locator('.monaco-editor[data-uri$="README.md"] .view-line').first().isVisible(), 120_000);
    const tabsBefore = (await headerTabs(page)).map((tab) => tab.title);
    await openInVscodeOn(CHAT_B);
    const inB = await until(async () => {
      const rows = await explorerRows();
      return await explorerLit() && rows.some((row) => row.includes('b.txt')) && !rows.some((row) => row.includes('README.md')) ? rows : null;
    }, 120_000);
    check(`[${size}] 10 "Open in VS Code" on a chat in another folder shows that folder in VS Code's Explorer, in the rail panel`, inB, (inB ?? await explorerRows().catch(() => [])).map((row) => row.trim()).join(' | '));
    const closedThere = await until(async () => !(await headerTabs(page)).some((tab) => /README\.md|notes\.ts|linked\.md/.test(tab.title)), 30_000);
    check(`[${size}] 10 the page follows that folder: the first folder's file tabs close`, closedThere, `${tabsBefore.join(' | ')} → ${(await headerTabs(page)).map((tab) => tab.title).join(' | ') || 'none'}`);
    await shot(page, `${size}-10-open-in-vscode`);
    await openInVscodeOn(CHATS[0]);
    const backHome = await until(async () => {
      const rows = await explorerRows();
      return await explorerLit() && rows.some((row) => row.includes('README.md')) && !rows.some((row) => row.includes('b.txt'));
    }, 120_000);
    const tabsBack = await until(async () => (await headerTabs(page)).some((tab) => tab.title.includes('README.md')), 60_000);
    check(`[${size}] 10 and on the first chat, its folder comes back in the Explorer, with its file tabs (kept per folder)`, backHome && tabsBack, (await headerTabs(page)).map((tab) => tab.title).join(' | ') || 'no file tabs');
    await shot(page, `${size}-10-back`);
    check(`[${size}] 10 nothing opened another page or window`, popups.length === 0, popups.join(' '));
  } catch (error) {
    check(`[${size}] 10 the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
    await shot(page, `${size}-10-99-failure`).catch(() => undefined);
  } finally {
    await context.close();
  }
};

// With OpenChamber's session tabs off there is no header strip: the page keeps VS Code's own tab bar.
const withoutStrip = async (seeded) => {
  const size = '1440x900, session tabs off';
  await request.put(`${base}/api/config/settings`, { data: { sessionTabsEnabled: false } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/?session=${seeded[0]}`);
    await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    await entryButton(page, 'explorer').click();
    const view = viewFrame(page);
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().click({ timeout: 120_000 });
    const shown = await until(async () => await pageShown(page) && await pageFrame(page).locator('.monaco-editor[data-uri$="README.md"] .view-line').first().isVisible(), 60_000);
    const parts = await partsOf(pageFrame(page)).catch(() => ({}));
    check(`[${size}] a file opened from the Explorer shows in the page, with VS Code's own tab bar`, shown && parts.tabs >= 1, JSON.stringify(parts));
    await page.screenshot({ path: join(out, '1440x900-strip-off.png') });
  } catch (error) {
    check(`[${size}] the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close();
    await request.put(`${base}/api/config/settings`, { data: { sessionTabsEnabled: true } });
  }
};

try {
  const seeded = await seed();
  await classic();
  await journey({ width: 1440, height: 900 }, seeded.chats, true);
  await journey({ width: 1024, height: 768 }, seeded.chats, false);
  await openInVscode(seeded.chats, seeded.chatB);
  await withoutStrip(seeded.chats);
} catch (error) {
  check('the check ran to the end', false, String(error.message ?? error).split('\n')[0]);
} finally {
  try {
    serverCli('--uninstall-extension', `${PROBE.publisher}.${PROBE.name}`);
  } catch {
    // Not installed.
  }
  for (const file of ['notes.ts', 'linked.md']) rmSync(join(project, file), { force: true });
  for (const file of [`${run}-1440.txt`, `${run}-1024.txt`, `${run}-under-1440.txt`]) rmSync(join('/tmp', file), { force: true });
  await browser.close();
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
