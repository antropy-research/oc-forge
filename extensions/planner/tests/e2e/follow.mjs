// The Planner as one right panel for the whole window, with OpenChamber's released extension API alone (the Planner
// changes nothing in OpenChamber: panel/lib/openchamber/follow.ts, panel/lib/openchamber/place.ts), on both instances of the scratch stack,
// the npm release (`stock`) and oc-forge's adapted build (`adapted`):
//
// - the rail icon shows the whole Planner in the right panel;
// - in a chat of another folder (whose panel never had it) it shows too, on the same page (its Work Status section
//   opens it there); between folders that both have it, it is the same frame, so nothing reloads; a reload shows it
//   with the window, on the same page;
// - closed by the user, it stays closed, and does not follow into another folder; opened again where it was, it is
//   the same frame, at once;
// - a second window of the same browser (its storage shared) keeps its own: the first window showing the Planner does
//   not open it there, nor bring it back once closed there; a chat switch in the second window takes it along.
//
//   export WORK=/tmp/opencode/planner-follow/e2e STACK_PORT_BASE=35370
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/planner/tests/e2e/follow.mjs [outDir] [stock|adapted|both]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// The stack copies this checkout's extensions when it starts (`up`), so build the Planner first. Never prints the UI
// password. The chats it makes are deleted at the end; its three projects (follow-alpha/-beta/-gamma) stay.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchPlannerRequests } from './drain.mjs';

const work = process.env.WORK ?? '/tmp/opencode/planner-follow/e2e';
const out = process.argv[2] ?? '/tmp/opencode/planner-follow/screens';
const which = process.argv[3] ?? 'both';
mkdirSync(out, { recursive: true });
const BASE_PORT = Number(process.env.STACK_PORT_BASE ?? 35360);
const instances = { stock: `http://127.0.0.1:${BASE_PORT}`, adapted: `http://127.0.0.1:${BASE_PORT + 1}` };
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(readFileSync(join(work, 'secrets.env'), 'utf8'))[1].trim();
const PLANNER = 'oc-forge-planner';
const MODE = `plugin:${PLANNER}`;
const run = `follow-${Date.now().toString(36)}`;

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
    await wait(100);
  }
};

/** A git project in the instance's home (OpenChamber's projects are folders it can open). */
const project = (name, folder) => {
  const dir = join(work, name, 'home/projects', folder);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `# ${folder}\n`);
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args]);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git('add', '.');
    git('commit', '-qm', folder);
  }
  return dir;
};

/** Three projects with a chat each (this run's), and the Planner installed and allowed what it asks for. */
const seed = async (name, base, request) => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`${name}: login failed (${login.status()})`);
  const folders = { alpha: project(name, 'follow-alpha'), beta: project(name, 'follow-beta'), gamma: project(name, 'follow-gamma') };
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const wanted = Object.entries(folders).filter(([, path]) => !projects.some((entry) => entry.path === path))
    .map(([id, path]) => ({ id: `follow-${id}`, path, label: `follow-${id}`, addedAt: Date.now() }));
  if (wanted.length) await request.put(`${base}/api/config/settings`, { data: { projects: [...projects, ...wanted] } });
  const chats = {};
  for (const [id, dir] of Object.entries(folders)) {
    const made = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(dir)}`, { data: { title: `${run} ${id}`, location: { directory: dir } } })).json();
    chats[id] = (made.data ?? made).id;
  }
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === PLANNER)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions/planner') } });
  await request.put(`${base}/api/guests/${PLANNER}/enabled`, { data: { enabled: true } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
  }
  const cleanup = async () => {
    for (const [id, dir] of Object.entries(folders)) await request.delete(`${base}/api/session/${chats[id]}?directory=${encodeURIComponent(dir)}`).catch(() => {});
  };
  return { chats, cleanup };
};

// The right zone's Planner frame (the Work Status card's frame is transparent).
const PANEL_FRAME = 'aside[data-context-zone="right"] .inset-0 > iframe[title="Planner"]:not(.bg-transparent)';
const plannerFrame = async (page) => (await page.$(PANEL_FRAME))?.contentFrame() ?? null;
const zoneOpen = async (page) => (await page.locator('aside[data-context-zone="right"]').getAttribute('data-context-panel-open')) === 'true';
/** The whole Planner on screen in the right panel, on this page. */
const shownOn = async (page, heading) => {
  const frame = await plannerFrame(page);
  return Boolean(frame && await zoneOpen(page) && await frame.getByRole('heading', { name: heading }).isVisible().catch(() => false));
};
// A mark in the frame's document: still there after a switch = the same frame, nothing reloaded.
const mark = async (page) => (await plannerFrame(page))?.evaluate(() => window.__followMark ?? null).catch(() => null);
const setMark = async (page, value) => (await plannerFrame(page))?.evaluate((v) => { window.__followMark = v; return v; }, value);
const railIcon = (page) => page.locator(`button[data-context-surface="${MODE}"]`);
const closePanel = (page) => page.locator('aside[data-context-zone="right"] button[aria-label="Close panel"]').first().click();
const switchTo = async (page, sessionId) => {
  // A real click: OpenChamber wraps each row in a drag handle with aria-disabled, which Playwright reads as disabled.
  await page.locator(`[data-session-row="${sessionId}"]`).first().click({ force: true });
  await until(() => page.url().includes(sessionId), 10_000);
};

const journey = async (name) => {
  const base = instances[name];
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const drain = watchPlannerRequests(context);
  const { chats, cleanup } = await seed(name, base, context.request);
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/?session=${chats.alpha}`);
    await until(() => page.url().includes(chats.alpha), 20_000);
    await railIcon(page).click({ timeout: 30_000 });
    check(`[${name}] the rail icon shows the whole Planner in the right panel`, await until(() => shownOn(page, 'Home'), 30_000));
    const frame = await plannerFrame(page);
    await frame.getByRole('button', { name: 'Planner menu' }).click();
    await frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Backlog', exact: true }).click();
    await until(() => shownOn(page, 'Backlog'), 5000);
    await wait(1200);

    // A chat in a folder whose panel never had the Planner: its Work Status section shows it there, on Backlog.
    const moved = Date.now();
    await switchTo(page, chats.beta);
    const followed = await until(() => shownOn(page, 'Backlog'), 15_000);
    check(`[${name}] in another folder's chat the Planner shows too, on the same page`, followed, followed ? `${Date.now() - moved} ms` : `zone open ${await zoneOpen(page)}`);
    await page.screenshot({ path: join(out, `${name}-1-followed.png`) });
    await setMark(page, 'beta-frame');

    // Both folders have its tab now: OpenChamber keeps the one frame between them.
    await switchTo(page, chats.alpha);
    await wait(1500);
    check(`[${name}] back in the first folder: shown, the same frame (nothing reloads)`, (await shownOn(page, 'Backlog')) && (await mark(page)) === 'beta-frame', `mark ${await mark(page)}`);
    await switchTo(page, chats.beta);
    await wait(1500);
    check(`[${name}] …and again`, (await shownOn(page, 'Backlog')) && (await mark(page)) === 'beta-frame', `mark ${await mark(page)}`);

    // A reload: OpenChamber restores the folder's panel and loads the Planner with the window, on its page.
    await page.reload();
    const reloaded = Date.now();
    check(`[${name}] a reload shows the Planner with the window, on the same page`, await until(() => shownOn(page, 'Backlog'), 30_000), `${Date.now() - reloaded} ms`);

    // Closed by the user (in the second folder): it stays closed, and does not follow into a folder that never had it.
    await wait(1200);
    await closePanel(page);
    await wait(4000);
    check(`[${name}] closed, it stays closed`, !(await zoneOpen(page)), `zone open ${await zoneOpen(page)}`);
    await switchTo(page, chats.gamma);
    await wait(5000);
    check(`[${name}] closed, it does not follow into another folder`, !(await zoneOpen(page)), `zone open ${await zoneOpen(page)}`);
    // The first folder keeps its own panel (OpenChamber's, per folder): closed there too, its frame stays loaded, and
    // the rail icon shows it again at once, the same document. (The frame from before gamma is gone: gamma's panel had
    // no Planner tab, so OpenChamber dropped its pane.)
    await switchTo(page, chats.alpha);
    await wait(1500);
    if (await shownOn(page, 'Backlog')) {
      await setMark(page, 'alpha-frame');
      await closePanel(page);
      await wait(1500);
    }
    const clicked = Date.now();
    await railIcon(page).click();
    const again = await until(() => shownOn(page, 'Backlog'), 10_000);
    check(`[${name}] opened again in a folder that had it: at once, the same frame`, again && Date.now() - clicked < 1500 && (await mark(page)) === 'alpha-frame', `${Date.now() - clicked} ms, mark ${await mark(page)}`);

    // A second window of the same browser (its storage shared), while the first shows the Planner in alpha.
    const second = await context.newPage();
    second.on('pageerror', (error) => errors.push(`second window: ${error.message}`));
    await second.goto(`${base}/?session=${chats.beta}`);
    await until(() => second.url().includes(chats.beta), 20_000);
    await railIcon(second).waitFor({ timeout: 30_000 });
    if (await zoneOpen(second)) await closePanel(second);
    await wait(7000);
    check(`[${name}] a second window in another folder does not open the Planner because the first shows it`, !(await zoneOpen(second)), `zone open ${await zoneOpen(second)}`);
    await railIcon(second).click();
    check(`[${name}] …its rail icon shows it there`, await until(() => shownOn(second, 'Backlog'), 15_000));
    await wait(1500);
    await closePanel(second);
    await wait(7000);
    check(`[${name}] …closed there, it stays closed while the first window shows it`, !(await zoneOpen(second)), `zone open ${await zoneOpen(second)}`);
    check(`[${name}] …and the first window still shows it`, await shownOn(page, 'Backlog'));
    await railIcon(second).click();
    await until(() => shownOn(second, 'Backlog'), 15_000);
    await wait(1500);
    const movedSecond = Date.now();
    await switchTo(second, chats.gamma);
    const followedSecond = await until(() => shownOn(second, 'Backlog'), 15_000);
    check(`[${name}] …a chat switch in the second window takes it along`, followedSecond, followedSecond ? `${Date.now() - movedSecond} ms` : `zone open ${await zoneOpen(second)}`);
    await second.screenshot({ path: join(out, `${name}-2-second-window.png`) });
    check(`[${name}] no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (error) {
    check(`[${name}] journey completed`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
    await page.screenshot({ path: join(out, `${name}-99-failure.png`) }).catch(() => {});
  } finally {
    await cleanup();
    await drain.close(browser, { label: `follow.mjs ${name}` });
  }
};

try {
  for (const name of which === 'both' ? ['stock', 'adapted'] : [which]) await journey(name);
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
