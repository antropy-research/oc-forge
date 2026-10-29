// End-to-end check of oc-forge's OpenChamber adapters, against the two
// instances stack.mjs starts: every API with the scratch test extension on the
// adapted build, at 1440×900 and 1024×768, and the adapted build against the
// release with no extension using the APIs.
//
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node tests/e2e/openchamber-adapters/run.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// On a host whose network interfaces change often (Docker builds), Chromium
// aborts requests with ERR_NETWORK_CHANGED; run all three inside one private
// network namespace then (README.md shows how). Never prints the UI password.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const work = process.env.WORK ?? '/tmp/opencode/oc-adapters/e2e';
const out = process.argv[2] ?? '/tmp/opencode/oc-adapters/screens';
mkdirSync(out, { recursive: true });
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const vscodeToken = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
const VSCODE_SERVER = `http://127.0.0.1:${BASE + 2}`;
const instances = { stock: `http://127.0.0.1:${BASE}`, adapted: `http://127.0.0.1:${BASE + 1}` };
const TEST = 'ocforge-test';
const ZONE = 'ocforge-test-zone';
const CHATS = ['First chat', 'Second chat', 'Third chat'];
const ENTRIES = [
  { id: 'alpha', title: 'Alpha view', icon: 'compass-3', order: 1 },
  { id: 'beta', title: 'Beta view', icon: 'route', order: 2 },
  { id: 'gamma', title: 'Gamma view (inline SVG)', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>', order: 3 },
  { id: 'dock', title: 'Bottom panel', icon: 'layout-bottom', order: 4, zone: 'bottom' },
];

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
    await wait(200);
  }
};

// Seeds an instance through its API: the demo project, three chats, session
// tabs on, the extensions installed and approved. Idempotent.
const seed = async (name, base, request) => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`${name}: login failed (${login.status()})`);
  const project = join(work, name, 'home/projects/demo');
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const patch = { sessionTabsEnabled: true };
  if (!projects.some((entry) => entry.path === project)) patch.projects = [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }];
  await request.put(`${base}/api/config/settings`, { data: patch });
  const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`)).json();
  const sessions = (Array.isArray(listed) ? listed : listed.data ?? []).filter((session) => CHATS.includes(session.title));
  for (const title of CHATS) {
    if (sessions.some((session) => session.title === title)) continue;
    const created = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title, location: { directory: project } } })).json();
    sessions.push(created.data ?? created);
  }
  const ids = CHATS.map((title) => sessions.filter((session) => session.title === title).sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))[0].id);
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  for (const folder of ['planner', 'vscode', 'ocforge-test', 'ocforge-test-zone']) {
    const id = { planner: 'oc-forge-planner', vscode: 'oc-forge-vscode' }[folder] ?? folder;
    if (!catalog.guests.some((guest) => guest.id === id)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', folder) } });
  }
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) {
      await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
    }
  }
  return { project, sessions: ids };
};

// OpenCode 2.1.4 sometimes stops answering under load (every thread parked on
// a futex), and OpenChamber's own restarts of it hang the same way. Before each
// phase: wait until the instance lists the chats; if it does not, restart the
// whole instance (stack.mjs restart), which brings up a working OpenCode.
const restarts = [];
const ready = async (request, base, seeded) => {
  const name = Object.entries(instances).find(([, url]) => url === base)[0];
  for (let attempt = 0; ; attempt += 1) {
    const answered = await until(async () => {
      const health = await (await request.get(`${base}/health`, { timeout: 10_000 })).json();
      if (!health.isOpenCodeReady) return false;
      const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(seeded.project)}`, { timeout: 10_000 })).json();
      const sessions = Array.isArray(listed) ? listed : listed.data ?? [];
      return seeded.sessions.every((id) => sessions.some((session) => session.id === id));
    }, 90_000);
    if (answered || attempt >= 2) return Boolean(answered);
    console.log(`note: ${name}'s OpenCode stopped answering; restarting ${name}`);
    restarts.push(`${name} at ${new Date().toISOString()}`);
    execFileSync('node', [join(here, 'stack.mjs'), 'restart', name], { stdio: 'inherit' });
    await request.post(`${base}/auth/session`, { data: { password } });
  }
};

const setEnabled = (request, base, id, enabled) => request.put(`${base}/api/guests/${id}/enabled`, { data: { enabled } });
const setEntries = (request, base, entries) => request.post(`${base}/api/guests/${TEST}/service/request`, {
  data: { method: 'PUT', path: '/rail', body: JSON.stringify({ entries }) },
});

// A browser window on one instance, with the three chats as pinned header tabs.
const open = async (browser, base, viewport, seeded, path = `/?session=${seeded.sessions[0]}`) => {
  const { sessions } = seeded;
  const context = await browser.newContext({ viewport });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript((ids) => {
    // Extension frames are sandboxed without storage; only the app's own window is seeded.
    if (window.top !== window) return;
    if (!localStorage.getItem('oc-forge-e2e-seeded')) {
      localStorage.setItem('session-tabs-store', JSON.stringify({ state: { tabIds: ids, previewTabId: null }, version: 0 }));
      localStorage.setItem('oc-forge-e2e-seeded', '1');
    }
  }, sessions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A page stays on its loading state when OpenCode stopped answering while it
  // loaded: make sure OpenCode answers again (ready() restarts the instance if
  // not, and logs this window in again) and load the page again rather than
  // compare that.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await ready(context.request, base, seeded);
    await page.goto(`${base}${path}`);
    const loaded = await until(() => page.locator('[data-context-surface="plugin:oc-forge-planner"]').count(), 60_000)
      && await until(async () => (await page.locator('[role="tablist"] [role="tab"]').count()) >= 3, 60_000)
      && await until(() => page.getByText(CHATS[2], { exact: true }).first().count(), 30_000);
    if (loaded) break;
  }
  return { context, page, errors };
};

const rail = (page) => page.$$eval('[data-context-surface]', (buttons) => buttons.map((button) => ({
  id: button.getAttribute('data-context-surface'),
  pressed: button.getAttribute('aria-pressed') === 'true',
})));
const pressed = async (page, id) => (await page.locator(`[data-context-surface="${id}"]`).getAttribute('aria-pressed')) === 'true';
const zoneFrame = (page, zone) => page.frameLocator(`[data-context-zone="${zone}"] iframe[title="oc-forge test"], [data-context-zone="${zone}"] iframe[title="oc-forge bottom panel"]`).first();
const pageFrame = (page) => page.frameLocator(`[data-oc-forge-page="${TEST}"] iframe`);
const text = async (frame, selector) => (await frame.locator(selector).textContent({ timeout: 5_000 }).catch(() => null))?.trim() ?? null;
const shot = async (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const headerTab = (page, id) => page.locator(`[data-oc-forge-tab="${TEST}:${id}"]`);
const activeHeaderTab = (page) => page.$$eval('[role="tablist"] [role="tab"][aria-selected="true"]', (tabs) => tabs.map((tab) => tab.textContent?.trim() ?? ''));
// An extension's page from the sidebar header: its own button while the pages fit there inline (a click on a pressed
// one closes the page), else the "Extension pages" menu.
const openExtensionPage = async (page, title, timeout = 60_000) => {
  const inline = page.locator(`button[aria-label="${title}"][aria-pressed]:not([data-context-surface])`).first();
  const menu = page.getByRole('button', { name: 'Extension pages' });
  await inline.or(menu).first().waitFor({ timeout });
  if (await inline.isVisible().catch(() => false)) {
    if ((await inline.getAttribute('aria-pressed')) !== 'true') await inline.click();
    return;
  }
  await menu.click();
  await page.getByRole('menuitem', { name: title }).click();
};
// Whether a round saw the new-chat draft get its folder late (R5).
let lateDraftChecked = false;
const pageShown = (page) => page.evaluate((id) => {
  const element = document.querySelector(`[data-oc-forge-page="${id}"]`);
  return Boolean(element) && getComputedStyle(element).visibility === 'visible';
}, TEST);

// Frees the instance for the next round: no extension tabs, panels closed.
const reset = async (page) => {
  for (const id of ['b', 'a']) {
    if (await headerTab(page, id).count()) {
      await headerTab(page, id).hover();
      await headerTab(page, id).getByRole('button').click().catch(() => undefined);
    }
  }
  await page.keyboard.press('Escape');
};

const apiRound = async (browser, base, viewport, seeded, request) => {
  const size = `${viewport.width}x${viewport.height}`;
  await ready(request, base, seeded);
  const { context, page, errors } = await open(browser, base, viewport, seeded);
  try {
    await apiChecks(context, page, base, size, seeded, request);
  } catch (error) {
    check(`[${size}] the API check ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
  check(`[${size}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
};

const apiChecks = async (context, page, base, size, seeded, request) => {

  // R1: rail entries. The extension was just turned back on: its service starts with the first poll, so wait for its list.
  const replaced = (now) => ENTRIES.every((entry) => now.includes(`plugin:${TEST}--${entry.id}`)) && !now.includes(`plugin:${TEST}`);
  const ids = await until(async () => {
    const now = (await rail(page)).map((entry) => entry.id);
    return replaced(now) ? now : null;
  }, 30_000) ?? (await rail(page)).map((entry) => entry.id);
  check(`[${size}] R1 the extension's icon is replaced by its entries`, ENTRIES.every((entry) => ids.includes(`plugin:${TEST}--${entry.id}`)) && !ids.includes(`plugin:${TEST}`), ids.filter((id) => id.startsWith(`plugin:${TEST}`)).join(' '));
  const mask = await page.locator(`[data-context-surface="plugin:${TEST}--gamma"] span[style*="mask"]`).getAttribute('style').catch(() => '');
  check(`[${size}] R1 an inline SVG icon is drawn as a mask`, /data:image\/svg\+xml/.test(mask ?? ''));
  await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).click();
  const right = zoneFrame(page, 'right');
  check(`[${size}] R1 an entry opens the panel on that entry`, await until(async () => (await text(right, '#entry')) === 'alpha'));
  const loaded = await text(right, '#loaded');
  check(`[${size}] R1 only the chosen entry is lit`, await pressed(page, `plugin:${TEST}--alpha`) && !await pressed(page, `plugin:${TEST}--beta`));
  await shot(page, `${size}-r1-alpha`);
  await page.locator(`[data-context-surface="plugin:${TEST}--beta"]`).click();
  check(`[${size}] R1 another entry switches the same frame, which is told`, await until(async () => (await text(right, '#entry')) === 'beta') && await text(right, '#loaded') === loaded);
  check(`[${size}] R1 the highlight follows`, await until(async () => await pressed(page, `plugin:${TEST}--beta`) && !await pressed(page, `plugin:${TEST}--alpha`)));
  await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).click();
  await until(async () => (await text(right, '#entry')) === 'alpha');
  await right.locator('#report-beta').click();
  check(`[${size}] R1 a frame that switches by itself moves the highlight`, await until(async () => await pressed(page, `plugin:${TEST}--beta`)));
  await page.locator(`[data-context-surface="plugin:${TEST}--beta"]`).click();
  check(`[${size}] R1 the lit entry closes the panel again`, await until(async () => !(await rail(page)).some((entry) => entry.id.startsWith(`plugin:${TEST}`) && entry.pressed)));
  const changed = ENTRIES.filter((entry) => entry.id !== 'beta').concat([{ id: 'delta', title: 'Delta view', icon: 'bug', order: 5 }]);
  await setEntries(request, base, changed);
  const started = Date.now();
  const came = await until(async () => {
    const now = (await rail(page)).map((entry) => entry.id);
    return now.includes(`plugin:${TEST}--delta`) && !now.includes(`plugin:${TEST}--beta`);
  }, 10_000);
  check(`[${size}] R1 entries come and go without a reload`, came, `${((Date.now() - started) / 1000).toFixed(1)} s after the service's list changed`);
  await shot(page, `${size}-r1-changed`);
  // More entries than the rail's height (40 × 36 px): every one gets its icon, the rail scrolls to the last, and the
  // last opens the panel on itself.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `many-${i + 1}`, title: `Many ${i + 1}`, icon: 'apps', order: 100 + i }));
  await setEntries(request, base, many);
  const allThere = await until(async () => (await rail(page)).filter((entry) => entry.id.startsWith(`plugin:${TEST}--many-`)).length === 40, 10_000);
  const last = page.locator(`[data-context-surface="plugin:${TEST}--many-40"]`);
  const railNav = page.locator('nav').filter({ has: last });
  const overflows = await railNav.evaluate((nav) => nav.scrollHeight > nav.clientHeight + 1).catch(() => false);
  await last.click();
  const lastOpens = await until(async () => (await text(right, '#entry')) === 'many-40');
  const scrolled = await railNav.evaluate((nav) => nav.scrollTop > 0).catch(() => false);
  check(`[${size}] R1 forty entries all get an icon; the rail scrolls to the last, which opens on itself`, allThere && overflows && scrolled && lastOpens,
    `${(await rail(page)).filter((entry) => entry.id.startsWith(`plugin:${TEST}--many-`)).length} icons; overflows ${overflows}; scrolled ${scrolled}; opened ${lastOpens}`);
  await shot(page, `${size}-r1-many`);
  await last.click();
  await until(async () => !(await pressed(page, `plugin:${TEST}--many-40`)));
  await setEntries(request, base, ENTRIES);
  await until(async () => (await rail(page)).some((entry) => entry.id === `plugin:${TEST}--beta`), 10_000);

  // R3: default zones.
  await page.locator(`[data-context-surface="plugin:${TEST}--dock"]`).click();
  const bottom = zoneFrame(page, 'bottom');
  const dock = await until(async () => (await text(bottom, '#entry')) === 'dock' && (await text(bottom, '#surface'))?.includes('own panel'));
  // The zone grows open; measure it once it has (OpenChamber's default is 320 px).
  await until(async () => ((await page.locator('[data-context-zone="bottom"]').boundingBox())?.height ?? 0) >= 160, 5_000);
  await page.waitForTimeout(500);
  const box = await page.locator('[data-context-zone="bottom"]').boundingBox();
  const chat = await page.locator('[data-workspace-chat="true"]').boundingBox();
  check(`[${size}] R3 an entry with zone bottom opens its own panel at the bottom`, dock && box && chat && box.y > chat.y + chat.height / 3 && box.width > 200 && box.height >= 160,
    box ? `bottom zone at x ${Math.round(box.x)}–${Math.round(box.x + box.width)}, y ${Math.round(box.y)}–${Math.round(box.y + box.height)}` : 'no bottom zone');
  await shot(page, `${size}-r3-entry-bottom`);
  await page.locator(`[data-context-surface="plugin:${ZONE}"]`).click();
  check(`[${size}] R3 an extension with ocForge.zone bottom opens at the bottom`, await until(async () => (await page.locator(`[data-context-zone="bottom"] iframe[title="oc-forge bottom panel"]`).count()) > 0));
  await page.waitForTimeout(800);
  await shot(page, `${size}-r3-extension-bottom`);
  // The bottom zone under a page: kept under one whose extension asks for it (ocForge.page.keepBottomZone, the test
  // extension's), covered by any other (the Planner's), as the release covers it.
  // Shown: the zone open (a covered zone collapses to height 0, its frame laid out below the window) and its frame there.
  const zoneShown = async () => ((await page.locator('[data-context-zone="bottom"]').boundingBox())?.height ?? 0) >= 100
    && await page.locator('[data-context-zone="bottom"] iframe[title="oc-forge bottom panel"]').first().isVisible().catch(() => false);
  await openExtensionPage(page, 'oc-forge test');
  const kept = await until(async () => await pageShown(page) && await zoneShown());
  await page.waitForTimeout(500);
  const pageBox = await page.locator(`[data-oc-forge-page="${TEST}"]`).boundingBox();
  const keptBox = await page.locator('[data-context-zone="bottom"]').boundingBox();
  check(`[${size}] R3 a page with ocForge.page.keepBottomZone keeps the bottom zone shown under it`, kept && pageBox && keptBox && pageBox.y + pageBox.height <= keptBox.y + 2 && keptBox.height >= 160,
    pageBox && keptBox ? `page y ${Math.round(pageBox.y)}–${Math.round(pageBox.y + pageBox.height)}, bottom zone y ${Math.round(keptBox.y)}–${Math.round(keptBox.y + keptBox.height)}` : 'not shown');
  await shot(page, `${size}-r3-page-keeps-bottom`);
  await openExtensionPage(page, 'Planner');
  check(`[${size}] R3 any other page covers the bottom zone, as the release does`,
    await until(async () => (await page.frameLocator('iframe[title="Planner"]').getByRole('heading', { name: 'Home' }).count()) > 0 && !await zoneShown(), 60_000));
  await page.getByRole('button', { name: 'Back to chat' }).click();
  check(`[${size}] R3 back on the chat, the bottom zone shows again`, await until(() => zoneShown()));
  await page.locator(`[data-context-surface="plugin:${ZONE}"]`).click();

  // R2: header tabs.
  await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).click();
  await until(async () => (await text(right, '#entry')) === 'alpha');
  await right.locator('#open-a').click();
  check(`[${size}] R2 a frame opens a header tab beside the session tabs`, await until(() => headerTab(page, 'a').count()));
  check(`[${size}] R2 choosing it shows the extension's page on that tab`, await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a'));
  const strip = await page.locator('[role="tablist"] [role="tab"]').allTextContents();
  check(`[${size}] R2 the header keeps the tab strip (no "← back")`, strip.length >= 4 && await page.getByRole('button', { name: 'Back to chat' }).count() === 0, strip.map((title) => title.trim()).join(' | '));
  await pageFrame(page).locator('#open-b').click();
  check(`[${size}] R2 a second tab, unsaved, becomes the shown one`, await until(async () => (await text(pageFrame(page), '#tab')) === 'b' && await headerTab(page, 'b').locator('[data-oc-forge-dirty]').count() === 1));
  await shot(page, `${size}-r2-tabs`);
  const pageLoaded = await text(pageFrame(page), '#loaded');
  await page.locator('[role="tablist"] [role="tab"]', { hasText: CHATS[1] }).click();
  check(`[${size}] R2 a session tab hides the page and shows that chat`, await until(async () => !await pageShown(page) && page.url().includes(seeded.sessions[1])));
  await shot(page, `${size}-r2-back-to-chat`);
  await headerTab(page, 'a').click();
  check(`[${size}] R2 back on a tab the page was kept mounted, not reloaded`, await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a') && await text(pageFrame(page), '#loaded') === pageLoaded);
  // Focus back in OpenChamber itself: its own shortcuts, not forwarding, are under test here.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press('Control+5');
  check(`[${size}] R2 mod+digit counts the extension tabs after the session tabs`, await until(async () => (await text(pageFrame(page), '#tab')) === 'b'), 'Control+5 → the second extension tab');
  await page.keyboard.press('Control+Alt+ArrowLeft');
  check(`[${size}] R2 previous/next tab moves across them`, await until(async () => (await text(pageFrame(page), '#tab')) === 'a'), 'Control+Alt+ArrowLeft → Tab A');
  await page.keyboard.press('Alt+w');
  check(`[${size}] R2 the close-tab shortcut closes the shown extension tab, and the extension is told`,
    await until(async () => await headerTab(page, 'a').count() === 0 && (await text(pageFrame(page), '#log'))?.includes('tab-closed a') && (await text(pageFrame(page), '#tab')) === 'b'));
  await headerTab(page, 'b').hover();
  await headerTab(page, 'b').getByRole('button', { name: 'Close tab' }).click();
  check(`[${size}] R2 the tab's own close button closes it and returns to the chat`, await until(async () => await headerTab(page, 'b').count() === 0 && !await pageShown(page)));
  check(`[${size}] R2 the extension is told about the close`, await until(async () => (await text(right, '#log'))?.includes('tab-closed b')));
  // The page too: after its extension's last tab it stays mounted, hidden, for a moment (OC_FORGE_PAGE_LINGER_MS), where
  // the release removes it before its frame hears anything.
  check(`[${size}] R2 after its last tab the page stays a moment, hidden, and hears the close itself`,
    await until(async () => !await pageShown(page) && (await text(pageFrame(page), '#log'))?.includes('tab-closed b'), 5_000));
  // A frame that decides how unsaved tabs close (tabs.onCloseRequest): clean tabs still close at once; closing an unsaved
  // one asks the frame and leaves the tab, until the frame closes it.
  await right.locator('#open-a').click();
  await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a');
  check(`[${size}] R2 a tab opened meanwhile brings that page back as it was, not reloaded`, (await text(pageFrame(page), '#loaded')) === pageLoaded);
  await pageFrame(page).locator('#decide-close').click();
  await until(async () => (await text(pageFrame(page), '#log'))?.includes('deciding'));
  await pageFrame(page).locator('#open-b').click();
  await until(async () => (await text(pageFrame(page), '#tab')) === 'b');
  await headerTab(page, 'a').click();
  await until(async () => (await text(pageFrame(page), '#tab')) === 'a');
  await headerTab(page, 'a').hover();
  await headerTab(page, 'a').getByRole('button', { name: 'Close tab' }).click();
  check(`[${size}] R2 with a frame deciding, a clean tab still closes at once`, await until(async () => await headerTab(page, 'a').count() === 0 && (await text(pageFrame(page), '#tab')) === 'b'));
  const echoes = async () => ((await text(pageFrame(page), '#log')) ?? '').split('\n').filter((line) => line.endsWith('tab-closed b')).length;
  const echoesBefore = await echoes();
  await headerTab(page, 'b').hover();
  await headerTab(page, 'b').getByRole('button', { name: 'Close tab' }).click();
  check(`[${size}] R2 closing an unsaved tab asks the frame that decides, and the tab stays`,
    await until(async () => (await text(pageFrame(page), '#close-request')) === 'b' && await headerTab(page, 'b').count() === 1 && await pageShown(page)));
  await shot(page, `${size}-r2-close-request`);
  await pageFrame(page).locator('#confirm-close').click();
  check(`[${size}] R2 the tab goes once the frame closes it, back to the chat as for the user's close`, await until(async () => await headerTab(page, 'b').count() === 0 && !await pageShown(page)));
  check(`[${size}] R2 …and the frame that closed it is not told it was closed`, (await echoes()) === echoesBefore);
  check(`[${size}] R2 a page left without tabs goes after a moment, as a page without tabs does in the release`,
    await until(async () => await page.locator(`[data-oc-forge-page="${TEST}"]`).count() === 0, 20_000));
  await page.locator('[role="tablist"] [role="tab"]', { hasText: CHATS[2] }).click();
  check(`[${size}] R2 session tabs still switch chats`, await until(() => page.url().includes(seeded.sessions[2])));

  // R4: keys pressed in a frame.
  await right.locator('#open-a').click();
  await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a');
  await pageFrame(page).locator('#keys').click();
  await page.keyboard.press('Control+1');
  check(`[${size}] R4 mod+1 pressed in the frame switches OpenChamber's tab`, await until(async () => !await pageShown(page) && page.url().includes(seeded.sessions[0])));
  check(`[${size}] R4 the frame learns its press was forwarded`, (await text(pageFrame(page), '#key-result')) === 'forwarded switch_session_tab');
  await shot(page, `${size}-r4-forwarded`);
  await headerTab(page, 'a').click();
  await until(() => pageShown(page));
  await pageFrame(page).locator('#keys').click();
  await page.keyboard.press('Control+i');
  check(`[${size}] R4 a non-navigation key is refused`, await until(async () => (await text(pageFrame(page), '#key-result'))?.startsWith('refused: Not one of the OpenChamber navigation shortcuts')) && await pageShown(page));
  await pageFrame(page).locator('#late-key').click();
  await wait(8_000);
  check(`[${size}] R4 a forward without a user activation is refused`, (await text(pageFrame(page), '#key-result'))?.startsWith('late: refused: A forwarded key needs a user activation'));
  await shot(page, `${size}-r4-refused`);

  // In an installed app window Chrome reserves none of its tab keys, so they act on OpenChamber's tabs there, beside
  // OpenChamber's bindings: Ctrl+Tab, Ctrl+Shift+Tab, Cmd/Ctrl+W. Headless Chromium has no app window; with
  // `oc-forge:app-window` set this window counts as one.
  const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const onChat = (index) => until(async () => page.url().includes(seeded.sessions[index]) && !await pageShown(page), 10_000);
  // After a load the address bar names the chat before OpenChamber listens for keys: wait for its rail.
  const listening = async () => {
    await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).waitFor({ timeout: 30_000 }).catch(() => undefined);
    await wait(1_500);
  };
  await page.goto(`${base}/?session=${seeded.sessions[0]}`);
  await onChat(0);
  await blur();
  await page.keyboard.press('Control+Tab');
  await wait(800);
  check(`[${size}] R4 in a normal tab Ctrl+Tab stays Chrome's: OpenChamber's tab does not move`, page.url().includes(seeded.sessions[0]), page.url().replace(base, ''));
  await page.evaluate((key) => localStorage.setItem(key, 'on'), 'oc-forge:app-window');
  await page.reload();
  await onChat(0);
  await listening();
  await blur();
  await page.keyboard.press('Control+Tab');
  const nextTab = await onChat(1);
  await page.keyboard.press('Control+Shift+Tab');
  const previousTab = await onChat(0);
  check(`[${size}] R4 in an app window Ctrl+Tab and Ctrl+Shift+Tab move across OpenChamber's tabs`, Boolean(nextTab && previousTab), page.url().replace(base, ''));
  if (!await right.locator('#open-a').isVisible({ timeout: 5_000 }).catch(() => false)) await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).click();
  await right.locator('#open-a').click();
  await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a');
  await pageFrame(page).locator('#keys').click();
  await page.keyboard.press('Control+Tab');
  const fromFrame = await until(async () => !await pageShown(page) && page.url().includes(seeded.sessions[0]), 5_000);
  check(`[${size}] R4 …and from a frame that forwards OpenChamber's keys`, Boolean(fromFrame) && (await text(pageFrame(page), '#key-result')) === 'forwarded switch_session_next', (await text(pageFrame(page), '#key-result')) ?? '');
  await headerTab(page, 'a').click();
  await until(() => pageShown(page));
  await blur();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
  check(`[${size}] R4 …and Cmd/Ctrl+W closes OpenChamber's selected tab, an extension tab here`, await until(async () => (await headerTab(page, 'a').count()) === 0, 5_000));
  await shot(page, `${size}-r4-app-window`);
  await page.evaluate((key) => localStorage.removeItem(key), 'oc-forge:app-window');
  await page.reload();
  await onChat(0);
  await listening();
  if (!await right.locator('#open-a').isVisible({ timeout: 5_000 }).catch(() => false)) await page.locator(`[data-context-surface="plugin:${TEST}--alpha"]`).click();
  await right.locator('#open-a').click();
  await until(async () => await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a');

  // R5: deep links.
  const href = await pageFrame(page).locator('#page-link').getAttribute('href');
  check(`[${size}] R5 the frame renders a real link to its page`, href === `${base}/?extension=${TEST}&route=%2Fitem%2F42`, href ?? '');
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }).catch(() => null), pageFrame(page).locator('#page-link').click({ modifiers: ['Control'] })]);
  const routed = tab && await until(async () => (await text(tab.frameLocator(`[data-oc-forge-page="${TEST}"] iframe`), '#route')) === '/item/42', 60_000);
  check(`[${size}] R5 Ctrl+click opens the page on its route in a new tab, and the frame gets the route`, routed, tab ? tab.url().replace(base, '') : 'no new tab');
  if (tab) {
    check(`[${size}] R5 the new tab's address bar keeps the deep link`, new URL(tab.url()).searchParams.get('extension') === TEST);
    await tab.screenshot({ path: join(out, `${size}-r5-new-tab.png`) });
    await tab.close();
  }
  // A header tab with a route is a link too: Ctrl+click opens the page on that route in a new browser tab.
  const [tabTab] = await Promise.all([
    context.waitForEvent('page', { timeout: 10_000 }).catch(() => null),
    headerTab(page, 'a').locator('[role="tab"]').click({ modifiers: ['Control'] }),
  ]);
  const tabRouted = tabTab && await until(async () => (await text(tabTab.frameLocator(`[data-oc-forge-page="${TEST}"] iframe`), '#route')) === '/tab/a', 60_000);
  check(`[${size}] R5 Ctrl+click on an extension's header tab opens the page on its route in a new browser tab`, tabRouted, tabTab ? tabTab.url().replace(base, '') : 'no new tab');
  check(`[${size}] R5 …and this window stays on that tab`, await pageShown(page) && (await text(pageFrame(page), '#tab')) === 'a');
  if (tabTab) await tabTab.close();
  const sessionHref = await pageFrame(page).locator('#session-link').getAttribute('href');
  check(`[${size}] R5 the frame renders a real link to a chat`, sessionHref?.startsWith(`${base}/?session=ses_`), sessionHref ?? '');
  const pages = context.pages().length;
  await pageFrame(page).locator('#page-link').click();
  await wait(1_500);
  check(`[${size}] R5 a plain click stays in this window and names the route in the address bar`,
    context.pages().length === pages && new URL(page.url()).searchParams.get('route') === '/item/42', page.url().replace(base, ''));
  const direct = await context.newPage();
  await direct.goto(`${base}/?extension=${TEST}&route=%2Fdeep`);
  check(`[${size}] R5 a deep link loads the page and hands the frame its route`, await until(async () => (await text(direct.frameLocator(`[data-oc-forge-page="${TEST}"] iframe`), '#route')) === '/deep', 60_000));
  await direct.close();
  // On a slow machine the app changes its new-chat draft after the page opened (the draft gets its folder late),
  // which closes every page: the deep link opens its page again. A fresh window lands on the draft; its folder waits.
  // (A narrow window's draft makes no folder; the case runs where it does, at one size at least.)
  const fresh = await context.browser().newContext({ viewport: page.viewportSize() });
  await fresh.request.post(`${base}/auth/session`, { data: { password } });
  let held = 0;
  await fresh.route((url) => new URL(url).pathname.endsWith('/fs/mkdir'), async (route) => {
    held += 1;
    await wait(2_500);
    await route.continue().catch(() => {});
  });
  const slow = await fresh.newPage();
  await slow.goto(`${base}/?extension=${TEST}&route=%2Fslow`);
  const slowRouted = await until(async () => (await text(slow.frameLocator(`[data-oc-forge-page="${TEST}"] iframe`), '#route')) === '/slow', 60_000);
  await wait(5_000);
  if (held > 0) {
    lateDraftChecked = true;
    check(`[${size}] R5 a deep link keeps its page when the app changes its new-chat draft late (a slow machine)`,
      slowRouted && await pageShown(slow) && new URL(slow.url()).searchParams.get('extension') === TEST, `the draft's folder held 2.5 s; ${slow.url().replace(base, '')}`);
  } else {
    console.log(`INFO [${size}] R5 the new-chat draft made no folder at this size; its late change is checked where it does`);
  }
  // …and the user still leaves it at once: the app's own changes are undone only until the user does something.
  await slow.getByRole('button', { name: 'Back to chat' }).click().catch(() => {});
  await wait(2_000);
  check(`[${size}] R5 …and Back to chat still leaves it for good`, !await pageShown(slow));
  await fresh.close();

  // R6: guest service requests over the window's WebSocket. With eight held open (more than the browser's six HTTP
  // connections per host, which two windows of VS Code used to fill), a ninth answers at once, and none of them is an
  // HTTP request of its own.
  const serviceHttp = [];
  const onRequest = (request) => {
    if (/^\/api\/guests\/[^/]+\/service\/request$/.test(new URL(request.url()).pathname)) serviceHttp.push(request.url());
  };
  page.on('request', onRequest);
  await right.locator('#hold-many').click();
  const pingMs = await until(async () => {
    const shown = await text(right, '#ping-ms');
    return shown && /^\d+$/.test(shown) ? Number(shown) : null;
  }, 25_000);
  check(`[${size}] R6 with eight service requests held open, a ninth answers at once`, pingMs !== null && pingMs < 2_500, pingMs === null ? (await text(right, '#ping-ms')) ?? 'no answer' : `${pingMs} ms`);
  check(`[${size}] R6 …all of them over the window's WebSocket, none an HTTP request of its own`, serviceHttp.length === 0, `${serviceHttp.length} HTTP requests`);
  page.off('request', onRequest);
  // The held ones end before the next round.
  await until(async () => ((await text(right, '#log')) ?? '').split('\n').filter((line) => / hold \d (answered|failed)$/.test(line)).length >= 8, 20_000);

  await reset(page);
};

// The release vs the adapted build, with no extension using the APIs.
const compare = async (browser, seeded, request, viewport) => {
  const size = `${viewport.width}x${viewport.height}`;
  const views = {};
  for (const [name, base] of Object.entries(instances)) {
    await ready(request, base, seeded[name]);
    const { context, page } = await open(browser, base, viewport, seeded[name]);
    await page.waitForTimeout(3_000);
    const railBox = await page.locator('nav[aria-label="Panel surfaces"]').boundingBox();
    const headerBox = await page.locator('[role="tablist"]').first().boundingBox();
    const view = {
      rail: (await rail(page)).map((entry) => `${entry.id}${entry.pressed ? '*' : ''}`),
      tabs: (await page.locator('[role="tablist"] [role="tab"]').allTextContents()).map((title) => title.trim()),
      railShot: await page.screenshot({ clip: railBox ?? undefined }),
      headerShot: await page.screenshot({ clip: headerBox ?? undefined }),
    };
    await page.screenshot({ path: join(out, `${size}-compare-${name}-chat.png`) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await page.reload();
      await openExtensionPage(page, 'Planner');
      const home = await page.frameLocator('iframe[title="Planner"]').getByRole('heading', { name: 'Home' }).waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
      if (home) break;
    }
    await page.waitForTimeout(2_000);
    view.back = await page.getByRole('button', { name: 'Back to chat' }).count();
    view.pageShot = await page.screenshot();
    await page.screenshot({ path: join(out, `${size}-compare-${name}-planner-page.png`) });
    views[name] = view;
    await context.close();
  }
  const diff = async (left, right) => {
    const page = await browser.newPage();
    const ratio = await page.evaluate(async ([a, b]) => {
      const load = (data) => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.src = `data:image/png;base64,${data}`; });
      const [one, two] = await Promise.all([load(a), load(b)]);
      if (one.width !== two.width || one.height !== two.height) return 1;
      const canvas = (image) => { const element = document.createElement('canvas'); element.width = image.width; element.height = image.height; const context = element.getContext('2d'); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data; };
      const x = canvas(one); const y = canvas(two);
      let different = 0;
      for (let index = 0; index < x.length; index += 4) if (Math.abs(x[index] - y[index]) + Math.abs(x[index + 1] - y[index + 1]) + Math.abs(x[index + 2] - y[index + 2]) > 24) different += 1;
      return different / (x.length / 4);
    }, [left.toString('base64'), right.toString('base64')]);
    await page.close();
    return ratio;
  };
  const { stock, adapted } = views;
  check(`[${size}] stock vs adapted: the same rail`, JSON.stringify(stock.rail) === JSON.stringify(adapted.rail), adapted.rail.filter((id) => id.startsWith('plugin:')).join(' '));
  const railDiff = await diff(stock.railShot, adapted.railShot);
  check(`[${size}] stock vs adapted: the rail looks the same`, railDiff < 0.002, `${(railDiff * 100).toFixed(2)}% pixels differ`);
  check(`[${size}] stock vs adapted: the same header tabs`, JSON.stringify(stock.tabs) === JSON.stringify(adapted.tabs), adapted.tabs.join(' | '));
  const headerDiff = await diff(stock.headerShot, adapted.headerShot);
  check(`[${size}] stock vs adapted: the header looks the same`, headerDiff < 0.002, `${(headerDiff * 100).toFixed(2)}% pixels differ`);
  check(`[${size}] stock vs adapted: an extension page keeps the release's "← back" header`, stock.back === 1 && adapted.back === 1);
  const pageDiff = await diff(stock.pageShot, adapted.pageShot);
  check(`[${size}] stock vs adapted: the Planner page looks the same`, pageDiff < 0.01, `${(pageDiff * 100).toFixed(2)}% pixels differ`);
};

// The repository's own extensions, untouched, on either build: they must load and work.
const realExtensions = async (browser, name, base, seeded, request) => {
  await ready(request, base, seeded);
  const { context, page } = await open(browser, base, { width: 1440, height: 900 }, seeded);
  try {
    await plannerAndVscode(page, name);
  } catch (error) {
    check(`[${name}] the extensions' check ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
  await context.close();
};

const plannerAndVscode = async (page, name) => {
  await openExtensionPage(page, 'Planner');
  const planner = page.frameLocator('.inset-0 > iframe[title="Planner"]');
  check(`[${name}] the Planner page loads`, await planner.getByRole('heading', { name: 'Home' }).waitFor({ timeout: 120_000 }).then(() => true).catch(() => false));
  const title = `oc-forge e2e ${name} ${Date.now().toString(36)}`;
  const today = planner.locator('section.day-column.is-today');
  await today.getByRole('button', { name: /Add task/ }).click();
  const box = today.getByRole('textbox', { name: 'New task' });
  await box.fill(title);
  await box.press('Enter');
  await box.press('Escape');
  check(`[${name}] the Planner works: a task added to Today stays there`, await until(() => today.locator('li.task-card', { hasText: title }).count(), 15_000));
  await page.screenshot({ path: join(out, `extensions-${name}-planner.png`) });
  // The task goes again (through the Planner's service), so the next run compares the same Planner page on both.
  const plannerService = async (method, path, body) => {
    const response = await page.request.post(`${new URL(page.url()).origin}/api/guests/oc-forge-planner/service/request`, { data: { method, path, ...(body ? { body: JSON.stringify(body) } : {}) } });
    return JSON.parse((await response.json()).body ?? '{}');
  };
  const added = Object.values((await plannerService('GET', '/state')).state?.tasks ?? {}).filter((task) => task.title === title && !task.deletedAt);
  if (added.length) await plannerService('POST', '/commands', { commands: added.map((task) => ({ cmd: `e2e-clean-${task.id}`, type: 'task.deleted', taskId: task.id })) });
  await page.getByRole('button', { name: 'Back to chat' }).click();
  // Its one rail icon on the release; on the adapted build, its first rail entry (VS Code's Explorer).
  await page.locator('[data-context-surface="plugin:oc-forge-vscode"], [data-context-surface^="plugin:oc-forge-vscode--"]').first().click();
  // The panel's frame in its zone: a file tab VS Code restored mounts its page, a second "VS Code" frame.
  const panel = page.frameLocator('[data-context-zone] iframe[title="VS Code"][src*="/workbench/index.html"]').first();
  const form = await panel.getByRole('textbox', { name: 'VS Code Server address' }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  if (form) {
    await panel.getByRole('textbox', { name: 'VS Code Server address' }).fill(VSCODE_SERVER);
    await panel.getByLabel('VS Code Server connection token').fill(vscodeToken);
    await panel.getByRole('button', { name: 'Connect' }).click();
  }
  const started = Date.now();
  const workbench = await panel.locator('.monaco-workbench').waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
  check(`[${name}] the VS Code panel loads VS Code's workbench`, workbench, `${((Date.now() - started) / 1000).toFixed(0)} s after Connect`);
  const listed = workbench && await panel.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
  check(`[${name}] VS Code works: its Explorer lists the project's files`, listed);
  await page.screenshot({ path: join(out, `extensions-${name}-vscode.png`) });
};

const browser = await chromium.launch();
const request = (await browser.newContext()).request;
const seeded = {};
for (const [name, base] of Object.entries(instances)) seeded[name] = await seed(name, base, request);

// With no extension using the APIs: the test extensions off, and the VS Code extension too (on the adapted build its
// rail shows one icon per VS Code view container). The Planner only uses links and keys, which show nothing.
const usingTheApis = [TEST, ZONE, 'oc-forge-vscode'];
for (const base of Object.values(instances)) {
  await request.post(`${base}/auth/session`, { data: { password } });
  for (const id of usingTheApis) await setEnabled(request, base, id, false);
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await compare(browser, seeded, request, viewport);
for (const base of Object.values(instances)) await setEnabled(request, base, 'oc-forge-vscode', true);
for (const [name, base] of Object.entries(instances)) await realExtensions(browser, name, base, seeded[name], request);

// Every API, with the test extensions on.
const base = instances.adapted;
await request.post(`${base}/auth/session`, { data: { password } });
for (const id of [TEST, ZONE]) await setEnabled(request, base, id, true);
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await apiRound(browser, base, viewport, seeded.adapted, request);
check('R5 the deep link\'s late new-chat draft ran at one size at least', lateDraftChecked);

await browser.close();
writeFileSync(join(out, 'results.json'), `${JSON.stringify({ results, restarts }, null, 2)}\n`);
const failed = results.filter((result) => !result.ok);
if (restarts.length > 0) console.log(`instances restarted because OpenCode stopped answering: ${restarts.join('; ')}`);
console.log(`${results.length - failed.length}/${results.length} passed; screenshots in ${out}`);
process.exitCode = failed.length > 0 ? 1 : 0;
