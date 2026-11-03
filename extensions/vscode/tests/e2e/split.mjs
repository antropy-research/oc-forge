// End-to-end check of VS Code's parts in OpenChamber behaving as one VS Code window where each part alone can (the
// frame-level rows of the split pre-review, 2026-10-30), on the adapters' scratch stack, at 1440×900 and 1024×768:
//   freeze       (row 1a) a terminal made in the rail view (Ctrl+` there, the Explorer's "Open in Integrated
//                Terminal") leaves OpenChamber responsive: page.evaluate answers within 1 s for 60 s, the renderers'
//                memory stays bounded, the rail view shows no panel or editor area.
//   sideBars     (row 3) Ctrl+Shift+E/F/G/D/X in the page's editor build no side bar there: they light and open the
//                rail entry; "Reveal Active File in Explorer View" reveals the file in the rail's Explorer.
//   editors      (rows 4, 6, 7) from the rail: an extension's details (twice: one tab), Settings, Keyboard Shortcuts,
//                the default keybindings, the Search view's "Open in editor" and a new search editor (with the query
//                and results), a walkthrough: each in the page with its header tab; the rail never shows an editor
//                area or a modal.
//   windows      (row 10) two browser tabs on a folder keep their own header tabs across a reload; a new tab starts
//                from the folder's latest.
//   narrow       (row 11) the page's status bar keeps the language, indentation, encoding, line endings and line and
//                column in sight, the remote indicator and keyboard layout gone; no minimap in a narrow page.
//   groups       (row 12) split, each group names its editor; zen mode brings no tab strip.
//   chrome       (row 13) the rail panel's header names the entry it shows; VS Code's Maximize and Hide Panel are not
//                shown in the bottom.
//   badges       (row 14) Source Control's count of changes on its rail icon, following a change on disk.
//   starting     (row 15) a part shows progress until it shows its content (no blank frame); the page starts with the
//                rail view, so the first file shows at once; the cost in memory, measured.
//
//   export WORK=/tmp/opencode/vssplit/e2e STACK_PORT_BASE=35470
//   node tests/e2e/openchamber-adapters/stack.mjs prepare      # outside a private network namespace
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/vscode/tests/e2e/split.mjs [outDir]
//
// Each phase runs in a browser of its own, killed when the phase runs past 8 minutes or its renderers hold more than
// 4 GB (a frozen renderer, as on a build without row 1a's fix): the phase fails, and the run goes on.
// SPLIT_ONLY=freeze,badges runs only those phases; SPLIT_SIZES=1024 only that size. Never prints the UI password or
// the VS Code token.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/vssplit/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vssplit/split';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35470);
const base = `http://127.0.0.1:${BASE + 1}`;
const vscodeUrl = `http://127.0.0.1:${BASE + 2}`;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const VSCODE = 'oc-forge-vscode';
const project = join(work, 'adapted/home/projects/demo');
const CHATS = ['Split chat one', 'Split chat two'];
const only = process.env.SPLIT_ONLY ? new Set(process.env.SPLIT_ONLY.split(',')) : null;
const SIZES = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }].filter((size) => !process.env.SPLIT_SIZES || process.env.SPLIT_SIZES.split(',').includes(String(size.width)));

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
const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=oc-forge e2e', '-c', 'user.email=e2e@oc-forge.invalid', ...args], { encoding: 'utf8' });

// ── The stack's state ───────────────────────────────────────────────────

const browser = await chromium.launch();
const setup = await browser.newContext();
const request = setup.request;

const FILES = {
  'src/app.ts': "import { greet } from './util';\n\nexport const app = (name: string): string => greet(name);\n",
  'src/util.ts': "export const greet = (name: string): string => `hello ${name}`;\n",
  'docs/guide.md': `# Guide\n\n${Array.from({ length: 12 }, (_, section) => `## Section ${section + 1}\n\n${Array.from({ length: 4 }, (_, line) => `Line ${line + 1} of section ${section + 1}.`).join('\n')}\n`).join('\n')}`,
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
};

/** The project's files, committed; the chats; session tabs on; the VS Code extension installed and approved. */
const seed = async () => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  }
  rmSync(join(project, 'split-badge.txt'), { force: true });
  git('add', '-A');
  if (git('status', '--porcelain').trim()) git('commit', '-qm', 'split: the files the check opens');
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const patch = { sessionTabsEnabled: true };
  if (!projects.some((entry) => entry.path === project)) patch.projects = [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }];
  await request.put(`${base}/api/config/settings`, { data: patch });
  const list = async () => {
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`, { timeout: 10_000 })).json();
    return Array.isArray(listed) ? listed : listed.data ?? [];
  };
  for (const title of CHATS) {
    if (!(await list()).some((session) => session.title === title)) await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title, location: { directory: project } } });
  }
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === VSCODE)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', 'vscode') } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
  }
  const ids = [];
  for (const title of CHATS) {
    ids.push(await until(async () => (await list()).filter((session) => session.title === title).sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))[0]?.id ?? null, 60_000));
  }
  return ids;
};

/** Before OpenChamber's own scripts: the chats' header tabs, once per browser context. */
const seedTabs = (ids) => {
  if (window.top !== window || localStorage.getItem('vscode-split-seeded')) return;
  localStorage.setItem('session-tabs-store', JSON.stringify({ state: { tabIds: ids, previewTabId: null }, version: 0 }));
  localStorage.setItem('vscode-split-seeded', '1');
};

// ── OpenChamber's and VS Code's parts ───────────────────────────────────

const rail = (page) => page.$$eval('[data-context-surface]', (buttons) => buttons.map((button) => ({
  id: button.getAttribute('data-context-surface'),
  pressed: button.getAttribute('aria-pressed') === 'true',
  label: button.getAttribute('aria-label') ?? '',
  text: button.textContent?.trim() ?? '',
})));
const entrySurface = (entry) => `plugin:${VSCODE}--${entry}`;
const entryButton = (page, entry) => page.locator(`[data-context-surface="${entrySurface(entry)}"]`);
const lit = async (page) => (await rail(page)).filter((item) => item.pressed && item.id.startsWith(`plugin:${VSCODE}--`)).map((item) => item.id.split('--')[1]);
const viewFrame = (page) => page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
const bottomFrame = (page) => page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
const pageFrame = (page) => page.frameLocator(`[data-oc-forge-page="${VSCODE}"] iframe`).first();
const headerTabs = (page) => page.$$eval(`[data-oc-forge-tab^="${VSCODE}:"]`, (tabs) => tabs.map((tab) => ({
  id: tab.getAttribute('data-oc-forge-tab').slice(tab.getAttribute('data-oc-forge-tab').indexOf(':') + 1),
  title: tab.textContent?.trim() ?? '',
  active: tab.getAttribute('data-active') === 'true',
})));
const tabsText = async (page) => (await headerTabs(page)).map((tab) => `${tab.title}${tab.active ? '*' : ''}`).join(' | ');
const headerTab = (page, title) => page.locator(`[data-oc-forge-tab^="${VSCODE}:"]`, { hasText: title }).first();
const pageShown = (page) => page.evaluate((id) => {
  const element = document.querySelector(`[data-oc-forge-page="${id}"]`);
  return Boolean(element) && getComputedStyle(element).visibility === 'visible';
}, VSCODE);
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) }).catch(() => undefined);
/** The parts a workbench frame shows. */
const partsOf = (frame) => frame.locator('.monaco-workbench').first().evaluate((workbench) => {
  const shown = (selector) => {
    const element = workbench.querySelector(selector);
    return Boolean(element) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
  };
  return {
    sidebar: shown('.part.sidebar'),
    editor: shown('.part.editor'),
    panel: shown('.part.panel'),
    sidebarTitle: workbench.querySelector('.part.sidebar .composite.title h2')?.textContent?.trim() ?? '',
    groups: workbench.querySelectorAll('.part.editor .editor-group-container').length,
  };
});
const runCommand = async (page, frame, title) => {
  await page.keyboard.press('Control+Shift+p');
  await frame.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
  await page.keyboard.type(title);
  const label = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: label }) }).first().click({ timeout: 10_000 });
};

/** A window on the first chat, logged in, in the phase's browser (`inBrowser`). */
const open = async (size, viewport, chats, target) => {
  const context = await target.newContext({ viewport });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript(seedTabs, chats);
  const page = await context.newPage();
  await page.goto(`${base}/?session=${chats[0]}`);
  await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
  return { context, page };
};

/** The rail panel on an entry (clicked only when not lit: a click on the lit one closes the panel). */
const showEntry = async (page, entry) => {
  if (!(await lit(page)).includes(entry)) await entryButton(page, entry).click();
  await until(async () => (await lit(page)).includes(entry), 15_000);
};

/** The rail Explorer, connected (the connection form on a fresh stack), listing the project. */
const explorer = async (page) => {
  await showEntry(page, 'explorer');
  const view = viewFrame(page);
  const row = view.locator('.explorer-folders-view .monaco-list-row').first();
  const address = view.getByRole('textbox', { name: 'VS Code Server address' });
  await row.or(address).first().waitFor({ timeout: 180_000 });
  if (await address.isVisible().catch(() => false)) {
    await address.fill(vscodeUrl);
    await view.getByLabel('VS Code Server connection token').fill(token);
    await view.getByRole('button', { name: 'Connect' }).click();
    await row.waitFor({ timeout: 180_000 });
  }
  return view;
};
const explorerRow = (view, name) => view.locator('.explorer-folders-view .monaco-list-row', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }).first();

/** A file opened from the rail Explorer, shown in the page. */
const openFile = async (page, path) => {
  const view = await explorer(page);
  const parts = path.split('/');
  for (const folder of parts.slice(0, -1)) {
    const child = explorerRow(view, parts[parts.indexOf(folder) + 1]);
    if (!await child.isVisible().catch(() => false)) await explorerRow(view, folder).click();
    await child.waitFor({ timeout: 10_000 });
  }
  await explorerRow(view, parts.at(-1)).click();
  const name = parts.at(-1);
  return until(async () => await pageShown(page) && (await headerTabs(page)).some((tab) => tab.title === name && tab.active)
    && await pageFrame(page).locator('.part.editor .monaco-editor .view-line').first().isVisible(), 60_000);
};

// ── Phases ──────────────────────────────────────────────────────────────

/** The renderers of one browser process tree (its server's pid): their resident memory, in MB. */
const renderersMb = (root) => {
  const children = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const ppid = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
      if (ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    } catch {
      // Gone.
    }
  }
  let total = 0;
  const walk = (pid) => {
    for (const child of children.get(String(pid)) ?? []) {
      try {
        if (readFileSync(`/proc/${child}/cmdline`, 'utf8').includes('--type=renderer')) total += Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${child}/status`, 'utf8'))?.[1] ?? 0) / 1024;
      } catch {
        // Gone.
      }
      walk(child);
    }
  };
  walk(root);
  return Math.round(total);
};

/**
 * Row 1a: a terminal made in the rail view. A frozen renderer never answers again, not even the key's release that
 * made the terminal: the press is let go after a few seconds, and the phase returns as soon as three asks go
 * unanswered, so that its browser is killed (`inBrowser`) before the frozen renderer grows further.
 */
const freeze = async (size, viewport, chats, trigger, target, pid) => {
  const letGo = (pressing) => Promise.race([pressing.catch(() => undefined), wait(5_000)]);
  try {
    const { page } = await open(size, viewport, chats, target);
    const view = await explorer(page);
    const src = explorerRow(view, 'src');
    await src.waitFor({ timeout: 30_000 });
    await wait(3_000);
    const before = renderersMb(pid);
    if (trigger === 'key') {
      await view.locator('.explorer-folders-view .monaco-list-row').first().click();
      await letGo(page.keyboard.press('Control+Backquote'));
    } else {
      await src.click({ button: 'right' });
      await view.locator('.context-view .action-label').first().waitFor({ timeout: 4_000 });
      let reached = false;
      for (let step = 0; step < 30 && !reached; step += 1) {
        await page.keyboard.press('ArrowDown');
        reached = (await view.locator('.context-view .action-item.focused .action-label').first().innerText({ timeout: 2_000 }).catch(() => '')).trim() === 'Open in Integrated Terminal';
      }
      if (!reached) throw new Error('the context menu has no "Open in Integrated Terminal"');
      // Playwright's clicks on VS Code's context-menu items don't fire them: the keyboard does.
      await letGo(page.keyboard.press('Enter'));
    }
    const what = trigger === 'key' ? 'Ctrl+` in the rail Explorer' : '"Open in Integrated Terminal" on src in the rail Explorer';
    const started = Date.now();
    let late = 0;
    let worst = 0;
    let most = before;
    while (Date.now() - started < 60_000) {
      const asked = Date.now();
      const answered = await Promise.race([page.evaluate(() => 1).then(() => Date.now() - asked).catch(() => null), wait(5_000).then(() => null)]);
      worst = Math.max(worst, answered ?? 5_000);
      if (answered === null || answered > 1_000) late += 1;
      most = Math.max(most, renderersMb(pid));
      // A frozen renderer answers nothing: no use waiting out the minute.
      if (late >= 3) break;
      await wait(2_000);
    }
    check(`[${size}] row 1a ${what}: OpenChamber answers within 1 s for 60 s`, late === 0, `worst ${worst} ms, ${late} late or unanswered`);
    check(`[${size}] row 1a ${what}: the renderers' memory stays bounded`, most - before < 1_000 && late === 0, `${before} MB before, at most ${most} MB`);
    if (late === 0) {
      const parts = await partsOf(view).catch(() => null);
      check(`[${size}] row 1a ${what}: the rail view shows no panel and no editor area`, parts && parts.sidebar && !parts.panel && !parts.editor, JSON.stringify(parts));
      await shot(page, `${size}-1a-${trigger}`);
    }
  } catch (error) {
    check(`[${size}] row 1a (${trigger}) ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
};

/** Row 3: side bars from the page open on the rail. */
const sideBars = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  try {
    check(`[${size}] row 3 src/util.ts opens in the page`, await openFile(page, 'src/util.ts'));
    await wait(2_000);
    const editor = pageFrame(page).locator('.part.editor .monaco-editor').first();
    for (const [key, entry, title] of [['Control+Shift+F', 'search', 'Search'], ['Control+Shift+G', 'scm', 'Source Control'], ['Control+Shift+D', 'debug', 'Run and Debug'], ['Control+Shift+X', 'extensions', 'Extensions'], ['Control+Shift+E', 'explorer', 'Explorer']]) {
      await editor.click({ position: { x: 150, y: 40 } });
      await wait(300);
      await page.keyboard.press(key);
      const opened = await until(async () => (await lit(page)).includes(entry) && (await partsOf(viewFrame(page))).sidebarTitle.toLowerCase().startsWith(title.toLowerCase()), 15_000);
      await wait(1_000);
      const pageParts = await partsOf(pageFrame(page));
      check(`[${size}] row 3 ${key} in the page opens ${title} on the rail, no side bar in the page`, opened && !pageParts.sidebar && !pageParts.panel,
        `rail lit ${(await lit(page)).join(' ')}; rail view "${(await partsOf(viewFrame(page))).sidebarTitle}"; page ${JSON.stringify(pageParts)}`);
    }
    await shot(page, `${size}-3-keys`);
    const view = viewFrame(page);
    if (await explorerRow(view, 'util.ts').isVisible().catch(() => false)) await explorerRow(view, 'src').click();
    await editor.click({ position: { x: 150, y: 40 } });
    await runCommand(page, pageFrame(page), 'File: Reveal Active File in Explorer View');
    const revealed = await until(async () => (await view.locator('.explorer-folders-view .monaco-list-row.selected').allInnerTexts()).map((text) => text.trim()).includes('util.ts'), 15_000);
    const pageParts = await partsOf(pageFrame(page));
    check(`[${size}] row 3 "Reveal Active File in Explorer View" in the page reveals util.ts in the rail's Explorer, no side bar in the page`, revealed && !pageParts.sidebar,
      `rail lit ${(await lit(page)).join(' ')}; page ${JSON.stringify(pageParts)}`);
    await shot(page, `${size}-3-reveal`);
  } catch (error) {
    check(`[${size}] row 3 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Rows 4, 6, 7: editors the rail can't hand over as files open in the page by command. */
const editors = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  const view = viewFrame(page);
  const tabs = () => tabsText(page);
  const noEditorInRail = async () => {
    const parts = await partsOf(view);
    const modal = await view.locator('.monaco-modal-editor-block, .modal-editor-part').first().isVisible().catch(() => false);
    return !parts.editor && !modal;
  };
  const shows = (selector, tab) => until(async () => await pageShown(page) && await pageFrame(page).locator(selector).first().isVisible() && (await headerTabs(page)).some((item) => item.active && tab.test(item.title)), 30_000);
  try {
    await explorer(page);
    // Row 6: an extension's details, chosen twice.
    await showEntry(page, 'extensions');
    const search = view.locator('.extensions-viewlet .monaco-editor').first();
    await search.waitFor({ timeout: 30_000 });
    await search.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('@builtin git');
    // Git itself, not Git Base, which the search lists too.
    const first = view.locator('.extensions-list .monaco-list-row').filter({ has: view.locator('.name', { hasText: /^Git$/ }) }).first();
    await first.waitFor({ timeout: 30_000 });
    for (const round of [1, 2]) {
      await first.click();
      const shown = await shows('.extension-editor', /^Extension: Git$/);
      const count = (await headerTabs(page)).filter((tab) => /^Extension: Git$/.test(tab.title)).length;
      check(`[${size}] row 6 the extension's details chosen in the rail (${round === 1 ? 'first' : 'again'}) show in the page, with one tab`, shown && count === 1 && await noEditorInRail(), `header ${await tabs()}`);
    }
    await shot(page, `${size}-6-extension`);
    // Row 7: Settings, Keyboard Shortcuts, the default keybindings, from the rail.
    await showEntry(page, 'explorer');
    for (const [keys, selector, tab, name] of [
      [['Control+Comma'], '.settings-editor', /^Settings$/, 'Settings (Ctrl+,)'],
      [['Control+K', 'Control+S'], '.keybindings-editor', /^Keyboard Shortcuts$/, 'Keyboard Shortcuts (Ctrl+K Ctrl+S)'],
    ]) {
      await view.locator('.explorer-folders-view .monaco-list-row').first().click();
      await wait(300);
      for (const key of keys) await page.keyboard.press(key);
      const shown = await shows(selector, tab);
      check(`[${size}] row 7 ${name} from the rail opens in the page as an editor with its header tab, no modal in the rail`, shown && await noEditorInRail(), `header ${await tabs()}`);
      await shot(page, `${size}-7-${name.split(' ')[0].toLowerCase()}`);
    }
    await view.locator('.explorer-folders-view .monaco-list-row').first().click();
    await runCommand(page, view, 'Preferences: Open Default Keyboard Shortcuts (JSON)');
    const defaults = await shows('.part.editor .monaco-editor .view-line', /^Default Keybindings|keybindings\.json$/);
    check(`[${size}] row 7 the default keybindings from the rail open in the page with their header tab`, defaults && await noEditorInRail(), `header ${await tabs()}`);
    // Row 4: the Search view's "Open in editor", a new search editor, a walkthrough.
    await showEntry(page, 'search');
    const query = view.locator('textarea[aria-label^="Search:"]').first();
    await query.waitFor({ timeout: 15_000 });
    await query.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Section 9');
    await until(async () => /result/.test(await view.locator('.search-view .messages').first().innerText().catch(() => '')), 20_000);
    await view.locator('.search-view .messages a, .search-view .messages .monaco-link', { hasText: 'Open in editor' }).first().click();
    const searchShown = await shows('.search-editor', /^Search: Section 9/);
    const asked = await pageFrame(page).locator('.search-editor .search-widget textarea').first().inputValue().catch(() => '');
    const found = await until(async () => (await pageFrame(page).locator('.search-editor .monaco-editor .view-line', { hasText: 'Line 1 of section 9' }).count()) > 0, 30_000);
    check(`[${size}] row 4 the Search view's "Open in editor" in the rail opens a search editor in the page, with the query and its results`, searchShown && asked === 'Section 9' && found && await noEditorInRail(), `query "${asked}"; results ${Boolean(found)}; header ${await tabs()}`);
    await shot(page, `${size}-4-open-in-editor`);
    const before = (await headerTabs(page)).filter((tab) => tab.title.startsWith('Search')).length;
    await query.focus();
    await runCommand(page, view, 'Search Editor: New Search Editor');
    const another = await until(async () => await pageShown(page) && (await headerTabs(page)).filter((tab) => tab.title.startsWith('Search')).length > before && await pageFrame(page).locator('.search-editor').first().isVisible(), 30_000);
    const dialogs = await view.locator('.monaco-dialog-box').count();
    check(`[${size}] row 4 "Search Editor: New Search Editor" from the rail opens a search editor in the page, no error in the rail`, another && dialogs === 0 && await noEditorInRail(), `header ${await tabs()}`);
    await query.focus();
    await runCommand(page, view, 'Welcome: Open Walkthrough...');
    await view.locator('.quick-input-list .monaco-list-row').first().waitFor({ timeout: 10_000 });
    await view.locator('.quick-input-list .monaco-list-row').first().click();
    const walkthrough = await shows('.gettingStartedContainer', /^Welcome$/);
    check(`[${size}] row 4 a walkthrough from the rail opens in the page with its header tab`, walkthrough && await noEditorInRail(), `header ${await tabs()}`);
    await shot(page, `${size}-4-walkthrough`);
  } catch (error) {
    check(`[${size}] rows 4, 6, 7 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
    await shot(page, `${size}-467-error`);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Row 10: two browser tabs keep their own header tabs; a new one starts from the folder's latest. */
const windows = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  try {
    // Start from no VS Code tabs: closed in this window.
    for (const tab of await headerTabs(page)) {
      await headerTab(page, tab.title).hover();
      await headerTab(page, tab.title).getByRole('button', { name: 'Close tab' }).click().catch(() => undefined);
      await wait(400);
    }
    await until(async () => (await headerTabs(page)).length === 0, 15_000);
    check(`[${size}] row 10 tab A opens app.ts`, await openFile(page, 'src/app.ts'));
    const second = await context.newPage();
    await second.goto(`${base}/?session=${chats[1]}`);
    await until(async () => (await rail(second)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    check(`[${size}] row 10 tab B opens tsconfig.json`, await openFile(second, 'tsconfig.json'));
    await wait(4_000);
    // The window id the host keeps for the browser tab (its session storage), before and after the reload.
    const windowId = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('oc-forge:window') ?? 'null')?.id ?? null);
    const idBefore = await windowId();
    await page.reload();
    await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    await explorer(page);
    const restored = await until(async () => {
      const titles = (await headerTabs(page)).map((tab) => tab.title);
      return titles.length > 0 ? titles : null;
    }, 60_000);
    await wait(5_000);
    const idAfter = await windowId();
    check(`[${size}] row 10 tab A keeps its window id across the reload`, Boolean(idBefore) && idBefore === idAfter, `${idBefore} → ${idAfter}`);
    const afterReload = (await headerTabs(page)).map((tab) => tab.title);
    check(`[${size}] row 10 tab A reloaded brings back its own tabs, not tab B's`, afterReload.includes('app.ts') && !afterReload.includes('tsconfig.json'), `A: ${afterReload.join(' | ') || (restored ? '' : 'none')}; B: ${(await headerTabs(second)).map((tab) => tab.title).join(' | ')}`);
    await shot(page, `${size}-10-reloaded`);
    // B changes last: a new browser tab starts from its list.
    check(`[${size}] row 10 tab B opens util.ts too`, await openFile(second, 'src/util.ts'));
    await wait(4_000);
    const third = await context.newPage();
    await third.goto(`${base}/?session=${chats[1]}`);
    await until(async () => (await rail(third)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    await explorer(third);
    const latest = await until(async () => {
      const titles = (await headerTabs(third)).map((tab) => tab.title);
      return titles.includes('util.ts') ? titles : null;
    }, 60_000);
    const listB = (await headerTabs(second)).map((tab) => tab.title).sort();
    check(`[${size}] row 10 a new browser tab starts from the folder's latest tabs (tab B's)`, latest && JSON.stringify([...latest].sort()) === JSON.stringify(listB), `C: ${(await headerTabs(third)).map((tab) => tab.title).join(' | ')}; B: ${listB.join(' | ')}`);
    await shot(third, `${size}-10-new-tab`);
  } catch (error) {
    check(`[${size}] row 10 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Row 11: the page beside the rail panel keeps the editor's status in sight; no minimap when narrow. */
const narrow = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  try {
    await openFile(page, 'src/app.ts');
    await wait(3_000);
    const frame = pageFrame(page);
    const status = await frame.locator('.part.statusbar').first().evaluate((bar) => {
      const width = innerWidth;
      const item = (id) => {
        const element = bar.querySelector(`[id="${id}"]`);
        const box = element?.getBoundingClientRect();
        return { shown: Boolean(box && box.width > 0 && getComputedStyle(element).display !== 'none'), inside: Boolean(box && box.width > 0 && box.left >= 0 && box.right <= width + 0.5) };
      };
      return {
        width,
        editor: ['status.editor.mode', 'status.editor.indentation', 'status.editor.encoding', 'status.editor.eol', 'status.editor.selection'].map((id) => ({ id, ...item(id) })),
        gone: ['status.host', 'status.workbench.keyboardLayout'].map((id) => ({ id, ...item(id) })),
      };
    });
    check(`[${size}] row 11 the page's status bar (${status.width} px) shows the language, indentation, encoding, line endings and line and column`, status.editor.every((item) => item.inside),
      status.editor.filter((item) => !item.inside).map((item) => item.id).join(', ') || 'all in sight');
    check(`[${size}] row 11 the page's status bar has no remote indicator and no keyboard layout`, status.gone.every((item) => !item.shown), status.gone.filter((item) => item.shown).map((item) => item.id).join(', '));
    // The widest minimap on screen (an editor's; a hidden editor's has none).
    const minimapWidth = () => frame.locator('.part.editor').first().evaluate((part) => Math.max(0, ...[...part.querySelectorAll('.minimap')].map((element) => element.getBoundingClientRect().width))).catch(() => 0);
    const minimap = await minimapWidth();
    check(`[${size}] row 11 the narrow page (${status.width} px) shows no minimap`, status.width >= 600 || minimap === 0, `minimap ${Math.round(minimap)} px wide`);
    await shot(page, `${size}-11-status`);
    if (size === '1440x900') {
      // The rail panel closed: the page is wide, and the minimap is back.
      await entryButton(page, (await lit(page))[0]).click();
      const wide = await until(async () => {
        const width = await minimapWidth();
        return width > 0 ? Math.round(width) : null;
      }, 15_000);
      check(`[${size}] row 11 the page made wide again (rail panel closed) shows its minimap`, wide, `minimap ${wide ?? 0} px`);
    }
  } catch (error) {
    check(`[${size}] row 11 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Row 12: split groups name their editor; zen mode shows no tab strip. */
const groups = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  try {
    await openFile(page, 'src/util.ts');
    await wait(2_000);
    const frame = pageFrame(page);
    // A group's own tab: VS Code's tab strip (`.tab`) or its single tab (`.label-container`), not the breadcrumbs.
    const titles = () => frame.locator('.part.editor .editor-group-container').evaluateAll((items) => items.map((group) => [...group.querySelectorAll('.title .tab, .title .label-container')]
      .filter((tab) => tab.getBoundingClientRect().width > 0).map((tab) => tab.textContent?.trim() ?? '').join('/')));
    await frame.locator('.part.editor .monaco-editor').first().click({ position: { x: 150, y: 40 } });
    await runCommand(page, frame, 'View: Join All Editor Groups');
    await until(async () => (await partsOf(frame)).groups === 1, 10_000);
    await frame.locator('.part.editor .monaco-editor').first().click({ position: { x: 150, y: 40 } });
    await page.keyboard.press('Control+Backslash');
    await until(async () => (await partsOf(frame)).groups > 1, 10_000);
    await wait(1_500);
    const split = await titles();
    check(`[${size}] row 12 split in two, each group names its editor`, split.length === 2 && split.every((title) => title.includes('util.ts')), JSON.stringify(split));
    await shot(page, `${size}-12-split`);
    await runCommand(page, frame, 'View: Join All Editor Groups');
    await until(async () => (await partsOf(frame)).groups === 1, 10_000);
    await wait(1_000);
    const joined = await titles();
    check(`[${size}] row 12 joined again, the group shows no tab (the header has it)`, joined.length === 1 && joined[0] === '', JSON.stringify(joined));
    await frame.locator('.part.editor .monaco-editor').first().click({ position: { x: 150, y: 40 } });
    await page.keyboard.press('Control+K');
    await page.keyboard.press('z');
    await wait(2_000);
    const zen = await frame.locator('.part.editor .tabs-container .tab').evaluateAll((items) => items.filter((tab) => tab.getBoundingClientRect().width > 0).length);
    check(`[${size}] row 12 zen mode shows no tab strip`, zen === 0, `${zen} tabs`);
    await shot(page, `${size}-12-zen`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  } catch (error) {
    check(`[${size}] row 12 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Row 13: the rail panel's header names its entry; VS Code's Maximize and Hide Panel aren't in the bottom. */
const chrome = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  try {
    await explorer(page);
    const header = async () => page.locator('[data-context-zone="right"]').first().evaluate((zone) => {
      const own = zone.querySelector('[data-oc-forge-panel-title]');
      if (own) return own.textContent?.trim() ?? '';
      const label = [...zone.querySelectorAll('.typography-ui-label')].find((element) => element.getBoundingClientRect().width > 0);
      return label?.textContent?.trim() ?? '';
    }).catch(() => '');
    for (const [entry, title] of [['explorer', 'Explorer'], ['search', 'Search'], ['scm', 'Source Control']]) {
      await showEntry(page, entry);
      const named = await until(async () => (await header()) === title, 10_000);
      check(`[${size}] row 13 the rail panel's header names ${title}, not "VS Code"`, named, `header "${await header()}"`);
    }
    await shot(page, `${size}-13-header`);
    await entryButton(page, 'terminal').click();
    const bottom = bottomFrame(page);
    await bottom.locator('.xterm').first().waitFor({ timeout: 60_000 });
    await wait(2_000);
    const actions = await bottom.locator('.part.panel > .title .global-actions .action-item').evaluateAll((items) => items
      .filter((item) => item.getBoundingClientRect().width > 0)
      .map((item) => item.querySelector('.action-label')?.getAttribute('aria-label') ?? ''));
    check(`[${size}] row 13 the bottom shows no VS Code "Maximize Panel" or "Hide Panel" (OpenChamber's zone has its own)`, !actions.some((label) => /Maximize Panel|Restore Panel|Hide Panel/.test(label)), actions.join(' | ') || 'none');
    await shot(page, `${size}-13-bottom`);
  } catch (error) {
    check(`[${size}] row 13 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await context.close().catch(() => undefined);
  }
};

/** Row 14: Source Control's count on its rail icon, following the files on disk. */
const badges = async (size, viewport, chats, target) => {
  const { context, page } = await open(size, viewport, chats, target);
  const badge = async () => (await rail(page)).find((entry) => entry.id === entrySurface('scm'))?.text ?? '';
  // VS Code's own refresh in the rail's Source Control: each part's Git refreshes by itself only while that part has
  // the focus (keeping them all fresh is round 14's bridge, row 9); the badge shows what VS Code's Source Control counts.
  const refresh = async () => {
    await showEntry(page, 'scm');
    const view = viewFrame(page);
    await view.locator('.scm-view').first().click({ position: { x: 20, y: 200 } }).catch(() => undefined);
    await runCommand(page, view, 'Git: Refresh').catch(() => undefined);
  };
  try {
    await explorer(page);
    const before = git('status', '--porcelain').trim().split('\n').filter(Boolean).length;
    writeFileSync(join(project, 'split-badge.txt'), `${Date.now()}\n`);
    const expected = before + 1;
    await refresh();
    const shown = await until(async () => (await badge()) === String(expected), 30_000);
    check(`[${size}] row 14 Source Control's rail icon shows its count of changes (${expected})`, shown, `badge "${await badge()}"`);
    await shot(page, `${size}-14-badge`);
    rmSync(join(project, 'split-badge.txt'), { force: true });
    await refresh();
    const followed = await until(async () => (await badge()) === (before ? String(before) : ''), 30_000);
    check(`[${size}] row 14 the count follows the files on disk (${before || 'none'}) as the rail's Source Control counts them`, followed, `badge "${await badge()}"`);
  } catch (error) {
    check(`[${size}] row 14 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    rmSync(join(project, 'split-badge.txt'), { force: true });
    await context.close().catch(() => undefined);
  }
};

/** VS Code's extension hosts on the server: their resident memory, in MB. */
const extensionHostsMb = () => {
  let total = 0;
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const line = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (line.includes(join(work, 'vscode-server')) && line.includes('--type=extensionHost')) total += Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
    } catch {
      // Gone.
    }
  }
  return Math.round(total);
};

/** Row 15: progress while a part starts; the page starts with the rail view; what that costs. */
const starting = async (size, viewport, chats, target, pid) => {
  try {
    const { context, page } = await open(size, viewport, chats, target);
    // No saved tabs for the folder (the rail view would bring them back, which starts the page): the page then starts
    // with the first file, or with the rail view. Closed with the rail view running, which keeps them empty.
    await explorer(page);
    await wait(3_000);
    for (const tab of await headerTabs(page)) {
      await headerTab(page, tab.title).hover();
      await headerTab(page, tab.title).getByRole('button', { name: 'Close tab' }).click().catch(() => undefined);
      await wait(400);
    }
    await until(async () => (await headerTabs(page)).length === 0, 15_000);
    await wait(3_000);
    await entryButton(page, 'explorer').click();
    await until(async () => (await lit(page)).length === 0, 10_000);
    await page.reload();
    await until(async () => (await rail(page)).some((entry) => entry.id === entrySurface('explorer')), 60_000);
    await wait(8_000);
    if ((await lit(page)).length > 0 || (await headerTabs(page)).length > 0) throw new Error(`the window didn't start without VS Code: lit ${(await lit(page)).join(' ')}, tabs ${await tabsText(page)}`);
    const rendererBefore = renderersMb(pid);
    const hostsBefore = extensionHostsMb();
    await entryButton(page, 'explorer').click();
    // Every 100 ms until the Explorer lists the project: the rail panel shows VS Code's progress or the view, never a blank frame.
    const view = viewFrame(page);
    const clicked = Date.now();
    let blank = 0;
    let samples = 0;
    let listed = false;
    while (Date.now() - clicked < 120_000) {
      const state = await page.locator('[data-context-zone="right"] iframe[title="VS Code"]').first().evaluate(() => null).then(async () => view.locator('body').evaluate(() => {
        const boot = document.getElementById('oc-boot');
        const progress = Boolean(boot && boot.getBoundingClientRect().height > 0 && getComputedStyle(boot).display !== 'none' && boot.textContent?.trim());
        const list = Boolean(document.querySelector('.explorer-folders-view .monaco-list-row'));
        return { progress, list };
      })).catch(() => ({ progress: true, list: false }));
      samples += 1;
      if (state.list) {
        listed = true;
        break;
      }
      if (!state.progress) blank += 1;
      await wait(100);
    }
    check(`[${size}] row 15 while VS Code starts in the rail panel it shows its progress: never a blank frame`, listed && blank === 0, `${blank} of ${samples} samples blank before the Explorer listed (${((Date.now() - clicked) / 1000).toFixed(1)} s)`);
    // The page, started with the rail view: the first file shows at once.
    const pageStarted = await until(async () => page.locator(`[data-oc-forge-page="${VSCODE}"] iframe`).first().evaluate(() => null).then(() => pageFrame(page).locator('html').evaluate(() => document.documentElement.dataset.ocVscodePageStarted === 'true')), 60_000);
    await wait(3_000);
    const rendererWarm = renderersMb(pid);
    const hostsWarm = extensionHostsMb();
    const row = explorerRow(view, 'tsconfig.json');
    const from = Date.now();
    await row.click();
    const shown = await until(async () => await pageShown(page) && await pageFrame(page).locator('.part.editor .monaco-editor .view-line').first().isVisible() && (await headerTabs(page)).some((tab) => tab.title === 'tsconfig.json' && tab.active), 60_000);
    const firstFileMs = Date.now() - from;
    check(`[${size}] row 15 the page started with the rail view, so the first file shows within 2 s`, Boolean(pageStarted) && shown && firstFileMs < 2_000, `page started ahead: ${Boolean(pageStarted)}; first file after ${firstFileMs} ms`);
    const cost = { rendererBeforeMb: rendererBefore, rendererWithRailAndPageMb: rendererWarm, extensionHostsBeforeMb: hostsBefore, extensionHostsWithRailAndPageMb: hostsWarm, firstFileMs };
    writeFileSync(join(out, `${size}-15-cost.json`), `${JSON.stringify(cost, null, 2)}\n`);
    console.log(`  [${size}] row 15 cost: ${JSON.stringify(cost)}`);
    await shot(page, `${size}-15-first-file`);
    await context.close();
  } catch (error) {
    check(`[${size}] row 15 ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
};

// ── Run ─────────────────────────────────────────────────────────────────

/** The longest a phase may take; the most its browser's renderers may hold (a run here peaks near 1.5 GB). */
const PHASE_MAX_MS = 8 * 60_000;
const RENDERERS_MAX_MB = 4_000;

/**
 * Each phase in a browser of its own, killed when the phase overruns or its renderers outgrow RENDERERS_MAX_MB: a
 * frozen renderer answers nothing (the phase's calls then fail as the browser goes) and grows by about a gigabyte a
 * minute, which would otherwise hold the whole run until its timeout.
 */
const inBrowser = async (label, run) => {
  const server = await chromium.launchServer();
  const pid = server.process().pid;
  let stopped = null;
  const stop = (why) => {
    if (stopped) return;
    stopped = why;
    void server.kill().catch(() => undefined);
  };
  const deadline = setTimeout(() => stop(`it ran past ${PHASE_MAX_MS / 60_000} min`), PHASE_MAX_MS);
  const watch = setInterval(() => {
    const held = renderersMb(pid);
    if (held > RENDERERS_MAX_MB) stop(`its renderers held ${held} MB`);
  }, 5_000);
  try {
    await run(await chromium.connect(server.wsEndpoint()), pid);
  } catch (error) {
    check(`${label} ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    clearTimeout(deadline);
    clearInterval(watch);
    if (stopped) check(`${label}: its browser kept answering`, false, `killed: ${stopped}`);
    await server.kill().catch(() => undefined);
  }
};

const runs = (phase) => !only || only.has(phase);
try {
  const chats = await seed();
  for (const viewport of SIZES) {
    const size = `${viewport.width}x${viewport.height}`;
    const phases = [
      ['freeze', (target, pid) => freeze(size, viewport, chats, 'key', target, pid)],
      ['freeze', (target, pid) => freeze(size, viewport, chats, 'menu', target, pid)],
      ['sideBars', (target) => sideBars(size, viewport, chats, target)],
      ['editors', (target) => editors(size, viewport, chats, target)],
      ['windows', (target) => windows(size, viewport, chats, target)],
      ['narrow', (target) => narrow(size, viewport, chats, target)],
      ['groups', (target) => groups(size, viewport, chats, target)],
      ['chrome', (target) => chrome(size, viewport, chats, target)],
      ['badges', (target) => badges(size, viewport, chats, target)],
      ['starting', (target, pid) => starting(size, viewport, chats, target, pid)],
    ];
    for (const [phase, run] of phases) if (runs(phase)) await inBrowser(`[${size}] ${phase}`, run);
  }
} catch (error) {
  check('the check ran to the end', false, String(error.message ?? error).split('\n')[0]);
} finally {
  rmSync(join(project, 'split-badge.txt'), { force: true });
  await browser.close();
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
