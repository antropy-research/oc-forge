// End-to-end check of VS Code in OpenChamber's own surfaces (oc-forge's
// adapters), on the adapted instance of the adapters' scratch stack, at
// 1440×900 and 1024×768 with screenshots:
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
//   6. nothing opens another page or window;
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/vscode-surfaces/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-surfaces/screens';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
const base = `http://127.0.0.1:${BASE + 1}`;
const vscodeUrl = `http://127.0.0.1:${BASE + 2}`;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const VSCODE = 'oc-forge-vscode';
const project = join(work, 'adapted/home/projects/demo');
const run = `surfaces-${Date.now().toString(36)}`;
const CHATS = ['Surfaces chat one', 'Surfaces chat two'];
const BUILT_INS = [['search', 'Search'], ['scm', 'Source Control'], ['debug', 'Run and Debug'], ['extensions', 'Extensions'], ['explorer', 'Explorer']];
const PROBE = { publisher: 'ocforge-e2e', name: 'surfaces-probe', container: 'surfacesProbe', entry: 'surfaces-probe', title: 'Surfaces Probe', welcome: "The surfaces probe's view is here." };

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

// The demo project with two files, two chats, session tabs on, only the VS Code extension enabled and approved.
const seed = async () => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  writeFileSync(join(project, 'notes.ts'), 'export const notes = 1;\n');
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const patch = { sessionTabsEnabled: true };
  if (!projects.some((entry) => entry.path === project)) patch.projects = [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }];
  await request.put(`${base}/api/config/settings`, { data: patch });
  const list = async () => {
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`, { timeout: 10_000 })).json();
    return Array.isArray(listed) ? listed : listed.data ?? [];
  };
  const sessions = (await list()).filter((session) => CHATS.includes(session.title));
  for (const title of CHATS) {
    if (sessions.some((session) => session.title === title)) continue;
    const created = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title, location: { directory: project } } })).json();
    sessions.push(created.data ?? created);
  }
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === VSCODE)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', 'vscode') } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
    if (guest.id !== VSCODE && guest.enabled) await request.put(`${base}/api/guests/${guest.id}/enabled`, { data: { enabled: false } });
  }
  await until(async () => (await list()).filter((session) => CHATS.includes(session.title)).length >= CHATS.length, 120_000);
  const all = await list();
  return CHATS.map((title) => all.filter((session) => session.title === title).sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))[0].id);
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
const pageShown = (page) => page.evaluate((id) => {
  const element = document.querySelector(`[data-oc-forge-page="${id}"]`);
  return Boolean(element) && getComputedStyle(element).visibility === 'visible';
}, VSCODE);
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

// A VS Code extension with an activity-bar view container and a view (no code: its welcome text), as a .vsix.
const makeProbe = () => {
  const dir = mkdtempSync(join(tmpdir(), 'surfaces-probe-'));
  mkdirSync(join(dir, 'extension/media'), { recursive: true });
  writeFileSync(join(dir, 'extension/package.json'), JSON.stringify({
    name: PROBE.name, publisher: PROBE.publisher, version: '0.0.1', displayName: 'Surfaces probe', engines: { vscode: '^1.80.0' },
    contributes: {
      viewsContainers: { activitybar: [{ id: PROBE.container, title: PROBE.title, icon: 'media/probe.svg' }] },
      views: { [PROBE.container]: [{ id: `${PROBE.container}.view`, name: 'Probe view' }] },
      viewsWelcome: [{ view: `${PROBE.container}.view`, contents: PROBE.welcome }],
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

const journey = async (viewport, seeded, first) => {
  const size = `${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript((ids) => {
    if (window.top !== window) return;
    if (!localStorage.getItem('vscode-surfaces-seeded')) {
      localStorage.setItem('session-tabs-store', JSON.stringify({ state: { tabIds: ids, previewTabId: null }, version: 0 }));
      localStorage.setItem('vscode-surfaces-seeded', '1');
    }
  }, seeded);
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
  context.on('page', (opened) => popups.push(opened.url()));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /\/workbench\/main\.js/.test(message.location().url ?? '')) errors.push(`console: ${message.text()}`);
  });
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

    // ── 2. An extension installed on the VS Code Server: its icon comes, opens its view, and goes ──
    if (first) {
      const probe = makeProbe();
      try {
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
        const removedAt = Date.now();
        serverCli('--uninstall-extension', `${PROBE.publisher}.${PROBE.name}`);
        const went = await until(async () => !(await rail(page)).some((item) => item.id === entrySurface(PROBE.entry)), 30_000);
        check(`[${size}] 2 uninstalled, its icon goes, without a reload`, went, `${((Date.now() - removedAt) / 1000).toFixed(1)} s after the uninstall`);
      } finally {
        rmSync(probe.dir, { recursive: true, force: true });
      }
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
      await page.keyboard.press('Control+Shift+p');
      await pageFrame(page).locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
      await page.keyboard.type('File: Toggle Auto Save');
      await pageFrame(page).locator('.quick-input-list .monaco-list-row', { hasText: 'Toggle Auto Save' }).first().waitFor({ timeout: 10_000 });
      await page.keyboard.press('Enter');
      await wait(800);
    };
    await toggleAutoSave();
    await editor.locator('.view-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${run}`);
    const dirty = await until(async () => (await headerTabs(page)).find((tab) => tab.title.includes('README.md') && tab.dirty), 10_000);
    check(`[${size}] 3 editing makes the header tab dirty`, dirty);
    await shot(page, `${size}-3-dirty`);
    await headerTab(page, 'README.md').hover();
    await headerTab(page, 'README.md').getByRole('button', { name: 'Close tab' }).click();
    const asked = await until(async () => (await pageFrame(page).locator('.monaco-dialog-box').first().innerText({ timeout: 1_000 })).includes('README.md'), 15_000);
    await shot(page, `${size}-3-save-dialog`);
    if (asked) await pageFrame(page).locator('.monaco-dialog-box .monaco-button', { hasText: "Don't Save" }).first().click();
    const closed = await until(async () => !(await headerTabs(page)).some((tab) => tab.title.includes('README.md')) && !(await pageFrame(page).locator('.monaco-editor[data-uri$="README.md"]').count()), 15_000);
    check(`[${size}] 3 closing the tab closes the editor, asking to save as VS Code does`, asked && closed, `asked ${Boolean(asked)}, closed ${Boolean(closed)}`);
    check(`[${size}] 3 the file was not saved ("Don't Save")`, !readFileSync(join(project, 'README.md'), 'utf8').includes(run));
    await pageFrame(page).locator('.monaco-editor[data-uri$="notes.ts"] .view-line').first().click();
    await toggleAutoSave();

    // ── 4. The terminal at the bottom (under the chat: OpenChamber covers the bottom zone with a page, as for its own panels) ──
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
    await page.keyboard.press('Control+Shift+p');
    await bottom.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
    await page.keyboard.type('Terminal: Kill All Terminals');
    await bottom.locator('.quick-input-list .monaco-list-row', { hasText: 'Kill All Terminals' }).first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
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
    await chatTab.click();
    const terminalKept = await until(async () => (await bottom.locator('.monaco-workbench').evaluate(() => window.__surfacesMarker)) === 'terminal kept', 15_000);
    check(`[${size}] 4 back on a chat, the terminal at the bottom is the same one (kept while a file tab covered it)`, terminalKept);

    // ── 6. Nothing else opened ──
    check(`[${size}] 6 nothing opened another page or window`, popups.length === 0, popups.join(' '));
    check(`[${size}] no page errors from the extension`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (error) {
    check(`[${size}] the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
    await shot(page, `${size}-99-failure`).catch(() => undefined);
  }
  // Leave no header tab, panel or terminal behind for the next round.
  await context.close();
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

let seeded = null;
try {
  seeded = await seed();
  await journey({ width: 1440, height: 900 }, seeded, true);
  await journey({ width: 1024, height: 768 }, seeded, false);
  await withoutStrip(seeded);
} catch (error) {
  check('the check ran to the end', false, String(error.message ?? error).split('\n')[0]);
} finally {
  try {
    serverCli('--uninstall-extension', `${PROBE.publisher}.${PROBE.name}`);
  } catch {
    // Not installed.
  }
  rmSync(join(project, 'notes.ts'), { force: true });
  for (const file of [`${run}-1440.txt`, `${run}-1024.txt`]) rmSync(join('/tmp', file), { force: true });
  await browser.close();
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
