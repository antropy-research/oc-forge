// End-to-end check of oc-forge's OpenChamber adapters, against the two
// instances stack.mjs starts: every API with the scratch test extensions on the
// adapted build, at 1440×900 and 1024×768, the adapted build against the
// release with no extension using the APIs, and the Planner on both.
//
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node tests/e2e/openchamber-adapters/run.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// OC_FORGE_E2E_PARTS=compare,extensions,api runs only those parts (all by default).
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
const BASE = Number(process.env.STACK_PORT_BASE ?? 35350);
const instances = { stock: `http://127.0.0.1:${BASE}`, adapted: `http://127.0.0.1:${BASE + 1}` };
const TEST = 'ocforge-test';
const PLAIN = 'ocforge-test-plain';
const CHATS = ['First chat', 'Second chat', 'Third chat'];

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
  for (const folder of ['planner', 'ocforge-test', 'ocforge-test-plain']) {
    const id = { planner: 'oc-forge-planner' }[folder] ?? folder;
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
const zoneFrame = (page, zone) => page.frameLocator(`[data-context-zone="${zone}"] iframe[title="oc-forge test"]`).first();
// The open page: OpenChamber mounts it over the chat (`absolute inset-0 z-10`), apart from the zones' frames.
const PAGE_FRAME = '.inset-0.z-10 > iframe[title="oc-forge test"]';
const pageFrame = (page) => page.frameLocator(PAGE_FRAME);
const pageShown = (page) => page.locator(PAGE_FRAME).isVisible().catch(() => false);
const text = async (frame, selector) => (await frame.locator(selector).textContent({ timeout: 5_000 }).catch(() => null))?.trim() ?? null;
const shot = async (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
// An extension's page from the sidebar header: its own button while the pages fit there inline (a click on a pressed
// one closes the page), else the "Extension pages" menu (2.5), or the header's "More" menu, which holds every page (2.6).
const openExtensionPage = async (page, title, timeout = 60_000) => {
  const inline = page.locator(`button[aria-label="${title}"][aria-pressed]:not([data-context-surface])`).first();
  const menu = page.locator('button[aria-label="Extension pages"], button[aria-label="More"]').first();
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

const apiRound = async (browser, base, viewport, seeded, request) => {
  const size = `${viewport.width}x${viewport.height}`;
  await ready(request, base, seeded);
  const { context, page, errors } = await open(browser, base, viewport, seeded);
  try {
    await apiChecks(context, page, base, size, seeded);
  } catch (error) {
    check(`[${size}] the API check ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
  check(`[${size}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
};

const apiChecks = async (context, page, base, size, seeded) => {
  const right = zoneFrame(page, 'right');
  const panelIcon = page.locator(`[data-context-surface="plugin:${TEST}"]`);
  // The test extension's panel, where OpenChamber opens an extension's panel (the right zone).
  const showPanel = async () => {
    if (!await pressed(page, `plugin:${TEST}`)) await panelIcon.click();
    return until(async () => (await text(right, '#status'))?.startsWith('oc-forge'), 30_000);
  };
  const hidePanel = async () => {
    if (await pressed(page, `plugin:${TEST}`)) await panelIcon.click();
    await until(async () => !await pressed(page, `plugin:${TEST}`));
  };
  const tabCount = () => page.locator('[role="tablist"] [role="tab"]').count();

  // ocForge.modals: the test extension asks for allow-modals, so its frame's print() opens the print dialog (headless
  // Chromium fires beforeprint and afterprint); in an allow-scripts frame Chrome ignores it with a console error.
  const printNotes = [];
  page.on('console', (message) => { if (message.text().includes("call to 'print()'")) printNotes.push(message.text()); });
  await showPanel();
  const testSandbox = await page.locator('[data-context-zone="right"] iframe[title="oc-forge test"]').first().getAttribute('sandbox').catch(() => null);
  const status = await text(right, '#status');
  check(`[${size}] modals: the extension that asks gets allow-modals, and its hello says so`, testSandbox === 'allow-scripts allow-modals' && /\bmodals\b/.test(status ?? ''),
    `sandbox "${testSandbox}"; ${status}`);
  await right.locator('#print').click();
  check(`[${size}] modals: its print() opens the print dialog instead of being ignored`, await until(async () => (await text(right, '#printed')) === 'printed') && printNotes.length === 0,
    `${await text(right, '#printed')}; ${printNotes.join(' | ') || 'no console error'}`);
  await shot(page, `${size}-modals`);
  await hidePanel();
  const plainIcon = page.locator(`[data-context-surface="plugin:${PLAIN}"]`);
  await plainIcon.click();
  const plainFrame = page.locator('[data-context-zone] iframe[title="oc-forge plain panel"]').first();
  await plainFrame.waitFor({ timeout: 30_000 }).catch(() => undefined);
  const plainSandbox = await plainFrame.getAttribute('sandbox').catch(() => null);
  check(`[${size}] modals: an extension that doesn't ask keeps the release's sandbox`, plainSandbox === 'allow-scripts', `sandbox "${plainSandbox}"`);
  await plainIcon.click();
  await until(async () => !await pressed(page, `plugin:${PLAIN}`));

  // R4: keys pressed in a frame. On the second chat, Ctrl+1 in the panel goes to OpenChamber: its first tab, the first
  // chat, not the browser's first tab.
  await page.locator('[role="tablist"] [role="tab"]', { hasText: CHATS[1] }).click();
  await until(() => page.url().includes(seeded.sessions[1]));
  await showPanel();
  await right.locator('#keys').click();
  await page.keyboard.press('Control+1');
  check(`[${size}] R4 mod+1 pressed in a frame switches OpenChamber's tab`, await until(() => page.url().includes(seeded.sessions[0])) && context.pages().length === 1, page.url().replace(base, ''));
  check(`[${size}] R4 the frame learns its press was forwarded`, await until(async () => (await text(right, '#key-result')) === 'forwarded switch_session_tab'), (await text(right, '#key-result')) ?? '');
  await shot(page, `${size}-r4-forwarded`);
  await right.locator('#keys').click();
  await page.keyboard.press('Control+i');
  check(`[${size}] R4 a non-navigation key is refused`, await until(async () => (await text(right, '#key-result'))?.startsWith('refused: Not one of the OpenChamber navigation shortcuts')));
  await right.locator('#late-key').click();
  await wait(8_000);
  check(`[${size}] R4 a forward without a user activation is refused`, (await text(right, '#key-result'))?.startsWith('late: refused: A forwarded key needs a user activation'));
  await shot(page, `${size}-r4-refused`);

  // In an installed app window Chrome reserves none of its tab keys, so they act on OpenChamber's tabs there, beside
  // OpenChamber's bindings: Ctrl+Tab, Ctrl+Shift+Tab, Cmd/Ctrl+W. Headless Chromium has no app window; with
  // `oc-forge:app-window` set this window counts as one.
  const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const onChat = (index) => until(() => page.url().includes(seeded.sessions[index]), 10_000);
  // After a load the address bar names the chat before OpenChamber listens for keys: wait for its rail.
  const listening = async () => {
    await panelIcon.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await wait(1_500);
  };
  await page.goto(`${base}/?session=${seeded.sessions[0]}`);
  await onChat(0);
  await listening();
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
  await showPanel();
  await right.locator('#keys').click();
  await page.keyboard.press('Control+Tab');
  const fromFrame = await onChat(1);
  check(`[${size}] R4 …and from a frame that forwards OpenChamber's keys`,
    Boolean(fromFrame) && await until(async () => (await text(right, '#key-result')) === 'forwarded switch_session_next', 5_000), (await text(right, '#key-result')) ?? '');
  await blur();
  const before = await tabCount();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
  check(`[${size}] R4 …and Cmd/Ctrl+W closes OpenChamber's selected tab, the chat's`,
    await until(async () => (await tabCount()) === before - 1 && !page.url().includes(seeded.sessions[1]), 5_000), `${before} → ${await tabCount()} tabs; ${page.url().replace(base, '')}`);
  await shot(page, `${size}-r4-app-window`);
  await page.evaluate((key) => localStorage.removeItem(key), 'oc-forge:app-window');

  // R5: deep links. The panel renders real links, to its page on a route and to the current chat; a Ctrl+click on one
  // opens it in a new browser tab, and this window stays as it is.
  await page.goto(`${base}/?session=${seeded.sessions[0]}`);
  await onChat(0);
  await listening();
  await showPanel();
  const href = await right.locator('#page-link').getAttribute('href');
  check(`[${size}] R5 the frame renders a real link to its page`, href === `${base}/?extension=${TEST}&route=%2Fitem%2F42`, href ?? '');
  const sessionHref = await right.locator('#session-link').getAttribute('href');
  check(`[${size}] R5 the frame renders a real link to a chat`, sessionHref?.startsWith(`${base}/?session=ses_`), sessionHref ?? '');
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }).catch(() => null), right.locator('#page-link').click({ modifiers: ['Control'] })]);
  const routed = tab && await until(async () => (await text(pageFrame(tab), '#route')) === '/item/42', 60_000);
  check(`[${size}] R5 Ctrl+click opens the page on its route in a new tab, and the frame gets the route`, routed, tab ? tab.url().replace(base, '') : 'no new tab');
  if (tab) {
    check(`[${size}] R5 the new tab's address bar keeps the deep link`, new URL(tab.url()).searchParams.get('extension') === TEST);
    await tab.screenshot({ path: join(out, `${size}-r5-new-tab.png`) });
    await tab.close();
  }
  check(`[${size}] R5 …and this window stays on its chat`, page.url().includes(seeded.sessions[0]) && !await pageShown(page) && context.pages().length === 1, page.url().replace(base, ''));
  // A deep link loads the page and hands the frame its route; there a plain click on the page's own link stays in this
  // window and names the route in the address bar; Back to chat leaves the page, and the address bar drops it.
  await page.goto(`${base}/?session=${seeded.sessions[0]}&extension=${TEST}&route=%2Fdeep`);
  check(`[${size}] R5 a deep link loads the page and hands the frame its route`, await until(async () => (await text(pageFrame(page), '#route')) === '/deep', 60_000));
  const pages = context.pages().length;
  await pageFrame(page).locator('#page-link').click();
  await wait(1_500);
  check(`[${size}] R5 a plain click stays in this window and names the route in the address bar`,
    context.pages().length === pages && new URL(page.url()).searchParams.get('route') === '/item/42', page.url().replace(base, ''));
  await shot(page, `${size}-r5-page`);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  check(`[${size}] R5 Back to chat leaves the page, and the address bar drops it`,
    await until(async () => !await pageShown(page) && !new URL(page.url()).searchParams.has('extension'), 10_000), page.url().replace(base, ''));
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
  const slowRouted = await until(async () => (await text(pageFrame(slow), '#route')) === '/slow', 60_000);
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
  await page.keyboard.press('Escape');
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

// The repository's own extension, untouched, on either build: it must load and work.
const realExtensions = async (browser, name, base, seeded, request) => {
  await ready(request, base, seeded);
  const { context, page } = await open(browser, base, { width: 1440, height: 900 }, seeded);
  try {
    await planner(page, name);
  } catch (error) {
    check(`[${name}] the extension's check ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  }
  await context.close();
};

const planner = async (page, name) => {
  await openExtensionPage(page, 'Planner');
  const planner = page.frameLocator('.inset-0 > iframe[title="Planner"]');
  check(`[${name}] the Planner page loads`, await planner.getByRole('heading', { name: 'Home' }).waitFor({ timeout: 120_000 }).then(() => true).catch(() => false));
  // The Planner asks for allow-modals (it prints task lists and the calendar); the release ignores the ocForge block.
  const plannerSandbox = await page.locator('.inset-0 > iframe[title="Planner"]').first().getAttribute('sandbox').catch(() => null);
  const wanted = name === 'adapted' ? 'allow-scripts allow-modals' : 'allow-scripts';
  check(`[${name}] the Planner's frame is sandboxed with ${wanted}`, plannerSandbox === wanted, `sandbox "${plannerSandbox}"`);
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
};

const parts = new Set((process.env.OC_FORGE_E2E_PARTS ?? 'compare,extensions,api').split(','));
const browser = await chromium.launch();
const request = (await browser.newContext()).request;
const seeded = {};
for (const [name, base] of Object.entries(instances)) seeded[name] = await seed(name, base, request);

// With no extension using the APIs: the test extensions off. The Planner only uses links, keys and modals, which show
// nothing until it is used.
const usingTheApis = [TEST, PLAIN];
for (const base of Object.values(instances)) {
  await request.post(`${base}/auth/session`, { data: { password } });
  for (const id of usingTheApis) await setEnabled(request, base, id, false);
}
if (parts.has('compare')) for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await compare(browser, seeded, request, viewport);
if (parts.has('extensions')) for (const [name, base] of Object.entries(instances)) await realExtensions(browser, name, base, seeded[name], request);

// Every API, with the test extensions on.
const base = instances.adapted;
await request.post(`${base}/auth/session`, { data: { password } });
for (const id of usingTheApis) await setEnabled(request, base, id, true);
if (parts.has('api')) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) await apiRound(browser, base, viewport, seeded.adapted, request);
  check('R5 the deep link\'s late new-chat draft ran at one size at least', lateDraftChecked);
}

await browser.close();
writeFileSync(join(out, 'results.json'), `${JSON.stringify({ results, restarts }, null, 2)}\n`);
const failed = results.filter((result) => !result.ok);
if (restarts.length > 0) console.log(`instances restarted because OpenCode stopped answering: ${restarts.join('; ')}`);
console.log(`${results.length - failed.length}/${results.length} passed; screenshots in ${out}`);
process.exitCode = failed.length > 0 ? 1 : 0;
