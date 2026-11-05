// The Planner on oc-forge's adapted OpenChamber (adapters/openchamber): AGENTS.md's
// Cmd+click rule (a Cmd/Ctrl+click or a middle click on a page, a task or a chat
// opens it in a new browser tab; a plain click goes there in place), its
// shortcut rule (OpenChamber's own navigation keys reach OpenChamber while the
// Planner has focus; the Planner keeps its own), and the Planner as the window's
// right panel: a deep link opens it, and it stays through a switch of chat. Runs against the `adapted`
// instance of the scratch stack the adapters' own check uses, on ports and in a
// folder of its own:
//
//   export WORK=/tmp/opencode/planner-forge/e2e STACK_PORT_BASE=35360
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/planner/tests/e2e/forge.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// The stack copies this checkout's extensions when it starts (`up`), so build the
// Planner first. Never prints the UI password.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitOutMidnight } from './days.mjs';
import { watchPlannerRequests } from './drain.mjs';
import { openPlannerPanel } from './panel.mjs';

const work = process.env.WORK ?? '/tmp/opencode/planner-forge/e2e';
const out = process.argv[2] ?? '/tmp/opencode/planner-forge/screens';
mkdirSync(out, { recursive: true });
const BASE_PORT = Number(process.env.STACK_PORT_BASE ?? 35360);
const base = `http://127.0.0.1:${BASE_PORT + 1}`;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(readFileSync(join(work, 'secrets.env'), 'utf8'))[1].trim();
const PLANNER = 'oc-forge-planner';
const run = `forge-${Date.now().toString(36)}`;

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
const routeIn = (url) => new URL(url).searchParams.get('route');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// The address each new tab loaded: a deep link to a panel opens it there and leaves the address bar to OpenChamber's
// router, which drops `extension` and `route` once it writes the next one (only a page kept them).
const loaded = new WeakMap();
context.on('page', (opened) => {
  // A tab the page opens has its address from the start; one that starts blank gets it on its first navigation.
  if (opened.url().startsWith('http')) loaded.set(opened, opened.url());
  opened.on('framenavigated', (navigated) => {
    if (navigated === opened.mainFrame() && !loaded.has(opened) && navigated.url().startsWith('http')) loaded.set(opened, navigated.url());
  });
});
const routeLoaded = (tab) => (loaded.has(tab) ? routeIn(loaded.get(tab)) : null);
// Closed only once no Planner request is on its way (drain.mjs, as the harness's close()).
const drain = watchPlannerRequests(context);
let cleanup = async () => {};
const request = context.request;
try {
  // ── Seed: the demo project, a chat (a header tab: OpenChamber's session tabs on), the Planner installed ──
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  const project = join(work, 'adapted/home/projects/demo');
  mkdirSync(project, { recursive: true });
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  await request.put(`${base}/api/config/settings`, { data: { sessionTabsEnabled: true, ...(projects.some((entry) => entry.path === project) ? {} : { projects: [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }] }) } });
  const chat = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: `${run} chat`, location: { directory: project } } })).json();
  const chatId = (chat.data ?? chat).id;
  // A second chat, the header's second tab: Ctrl/Cmd+1 from a page over it must show the first.
  const other = await (await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: `${run} other chat`, location: { directory: project } } })).json();
  const otherId = (other.data ?? other).id;
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === PLANNER)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', 'planner') } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
  }
  const service = async (method, path, body) => {
    const response = await request.post(`${base}/api/guests/${PLANNER}/service/request`, { data: { method, path, ...(body ? { body: JSON.stringify(body) } : {}) } });
    return JSON.parse((await response.json()).body ?? '{}');
  };
  // A task linked to the chat, as "Track chat in Planner" makes one.
  const taskId = `${run}-task`;
  cleanup = async () => {
    await service('POST', '/commands', { commands: [{ cmd: `${run}-cleanup`, type: 'task.deleted', taskId }] });
    await request.delete(`${base}/api/session/${chatId}?directory=${encodeURIComponent(project)}`);
    await request.delete(`${base}/api/session/${otherId}?directory=${encodeURIComponent(project)}`);
  };
  // A plan no Planner window has opened yet knows no "today": its zone is the one the panel sets on its first load,
  // the browser's, here this machine's (a fresh stack's WORK).
  if (!(await service('GET', '/state')).today) await service('POST', '/commands', { commands: [{ cmd: `${run}-zone`, type: 'settings.updated', patch: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }] });
  // Today is the plan's, read once for a run of about a minute: within ten minutes of midnight in its zone, the new day first.
  await waitOutMidnight((await service('GET', '/state')).state?.settings?.timezone ?? 'UTC', 10, 'forge.mjs');
  const today = (await service('GET', '/state')).today;
  const seeded = await service('POST', '/commands', { commands: [{ cmd: `${run}-c1`, type: 'task.created', task: { id: taskId, title: `${run} write the brief`, placement: { kind: 'day', date: today }, position: 1024, sessionRef: { sessionId: chatId, title: `${run} chat`, directory: project } } }] });
  if (!seeded.applied) throw new Error(`the Planner did not take the journey's task: ${JSON.stringify(seeded)}`);

  // The chats are the header's first two tabs; the Planner's panel opens beside them.
  await context.addInitScript((ids) => {
    if (window.top !== window) return;
    if (!localStorage.getItem('oc-forge-planner-forge-seeded')) {
      localStorage.setItem('session-tabs-store', JSON.stringify({ state: { tabIds: ids, previewTabId: null }, version: 0 }));
      localStorage.setItem('oc-forge-planner-forge-seeded', '1');
    }
  }, [chatId, otherId]);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  // The Planner's panel frame (its zone pane is `absolute inset-0`); the Work Status card's frame is transparent.
  const PLANNER_PANEL = '.inset-0 > iframe[title="Planner"]:not(.bg-transparent)';
  const plannerFrame = (target) => target.frameLocator(PLANNER_PANEL);
  // The active nav item's name, without its count badge ("Today\n3").
  const activeNav = async (frame) => (await frame.locator('#planner-nav .nav-item.is-active').first().innerText().catch(() => '')).split('\n')[0];
  const navItem = (frame, name) => frame.locator('#planner-nav').getByRole('button', { name, exact: true });

  // A fresh instance's OpenCode can be slow to answer, and a frame that misses OpenChamber's load timeout shows
  // "This panel failed to load." for good: wait until the instance lists the chat, and load such a page again.
  await until(async () => {
    const health = await (await request.get(`${base}/health`, { timeout: 10_000 })).json();
    if (!health.isOpenCodeReady) return false;
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`, { timeout: 10_000 })).json();
    return (Array.isArray(listed) ? listed : listed.data ?? []).some((session) => session.id === chatId);
  }, 120_000);
  // The deep link shows the panel; expanded, the Planner has room for the menu the checks click (as on the page it had).
  const openPlanner = async (target, url) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await target.goto(url);
      const shown = await until(async () => (await plannerFrame(target).locator('.app').count()) > 0 || (await target.getByText('This panel failed to load.').count()) > 0, 90_000);
      if (shown && (await plannerFrame(target).locator('.app').count()) > 0) {
        await openPlannerPanel(target);
        return Boolean(await until(() => plannerFrame(target).locator('#planner-nav').isVisible(), 30_000));
      }
    }
    return false;
  };

  // ── 1. A deep link opens the Planner's panel on its place ──
  await openPlanner(page, `${base}/?extension=${PLANNER}&route=${encodeURIComponent('/calendar')}`);
  let frame = plannerFrame(page);
  const onCalendar = await until(async () => (await activeNav(frame)).trim() === 'Calendar', 30_000);
  check('a deep link (?extension=oc-forge-planner&route=/calendar) opens the Planner on Calendar', onCalendar, await activeNav(frame));
  await page.screenshot({ path: join(out, '01-deep-link-calendar.png') });

  // ── 2. A plain click goes there in place (a panel, unlike a page, leaves the address bar alone) ──
  await navItem(frame, 'Linear').click();
  const inPlace = await until(async () => (await activeNav(frame)).trim() === 'Linear');
  check('a plain click on a page goes there in this tab', inPlace, (await activeNav(frame)).trim());

  // ── 3. A Cmd/Ctrl+click on a page opens it in a new tab; this one stays ──
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const opened = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await navItem(frame, 'Today').click({ modifiers: [modifier] });
  const tab = await opened;
  const tabOnToday = tab && (await until(async () => (await activeNav(plannerFrame(tab))).trim() === 'Today', 90_000));
  check('a Cmd/Ctrl+click on a page opens it in a new browser tab, on that page', Boolean(tab && routeLoaded(tab) === '/today' && tabOnToday), tab ? `${routeLoaded(tab)} · ${tabOnToday ? 'Today shown' : 'not shown'}` : 'no new tab');
  check('…and this tab stays where it was', (await activeNav(frame)).trim() === 'Linear');
  if (tab) {
    await tab.screenshot({ path: join(out, '02-new-tab-today.png') });
    await tab.close();
  }

  // ── 4. A middle click does the same ──
  const opened2 = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await navItem(frame, 'Stats').click({ button: 'middle' });
  const tab2 = await opened2;
  if (tab2) await until(() => loaded.has(tab2), 10_000);
  check('a middle click on a page opens it in a new browser tab', Boolean(tab2 && routeLoaded(tab2) === '/stats'), tab2 ? String(routeLoaded(tab2)) : 'no new tab');
  await tab2?.close();

  // ── 5. A Cmd/Ctrl+click on a task opens it, on the Planner page, in a new tab; a plain click opens it here ──
  await navItem(frame, 'Today').click();
  const card = frame.getByRole('button', { name: `Open ${run} write the brief` }).first();
  await card.waitFor({ timeout: 30_000 });
  const opened3 = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await card.click({ modifiers: [modifier] });
  const tab3 = await opened3;
  const detailThere = tab3 && (await until(() => plannerFrame(tab3).getByRole('dialog', { name: 'Task details' }).isVisible(), 90_000));
  check('a Cmd/Ctrl+click on a task opens it in the Planner in a new tab, its details open', Boolean(tab3 && routeLoaded(tab3) === `/today?task=${taskId}` && detailThere), tab3 ? `${routeLoaded(tab3)} · details ${detailThere ? 'open' : 'not open'}` : 'no new tab');
  check('…and its details did not open here', (await frame.getByRole('dialog', { name: 'Task details' }).count()) === 0);
  if (tab3) {
    await tab3.screenshot({ path: join(out, '03-new-tab-task.png') });
    await tab3.close();
  }
  await card.click();
  const detail = frame.getByRole('dialog', { name: 'Task details' });
  const named = await until(() => detail.isVisible());
  check('a plain click on a task opens its details here', named);

  // ── 6. A Cmd/Ctrl+click on "Open the chat" opens the chat in a new tab ──
  const opened4 = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await detail.getByRole('button', { name: 'Open the chat' }).click({ modifiers: [modifier] });
  const tab4 = await opened4;
  check("a Cmd/Ctrl+click on a task's chat opens the chat in a new tab", Boolean(tab4 && new URL(tab4.url()).searchParams.get('session') === chatId), tab4 ? new URL(tab4.url()).search : 'no new tab');
  if (tab4) {
    await tab4.screenshot({ path: join(out, '04-new-tab-chat.png') });
    await tab4.close();
  }
  await detail.getByRole('button', { name: 'Close' }).first().click().catch(() => page.keyboard.press('Escape'));
  await page.screenshot({ path: join(out, '05-after-clicks.png') });

  // ── 7. Shortcuts: OpenChamber's own go to OpenChamber while the Planner has focus; the Planner keeps its own ──
  await frame.locator('main.main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${modifier}+k`);
  const palette = frame.getByRole('dialog', { name: 'Command palette' });
  check("Cmd/Ctrl+K in the Planner opens the Planner's own command palette", Boolean(await until(() => palette.isVisible(), 5000)));
  await page.keyboard.press('Escape');
  // The sidebar's own "Chats" heading (a "New session" button stays in the title bar when it is hidden).
  const sidebarShown = () => page.getByText('Chats', { exact: true }).first().isVisible().catch(() => false);
  const before = await sidebarShown();
  await frame.locator('main.main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${modifier}+b`);
  const toggled = await until(async () => (await sidebarShown()) !== before, 5000);
  check("Cmd/Ctrl+B in the Planner (outside the Linear page and fields) toggles OpenChamber's sidebar", toggled, `sidebar ${before ? 'shown' : 'hidden'} → ${(await sidebarShown()) ? 'shown' : 'hidden'}`);
  await frame.locator('main.main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${modifier}+b`);
  await until(async () => (await sidebarShown()) === before, 5000);
  await page.screenshot({ path: join(out, '06-keys.png') });
  // Ctrl/Cmd+1 shows the header's first tab, the first chat, where the Planner was beside the second; the Planner is
  // the window's panel, so it stays.
  const plannerShown = () => page.locator(PLANNER_PANEL).isVisible().catch(() => false);
  const overSecondChat = `${base}/?session=${otherId}&extension=${PLANNER}&route=${encodeURIComponent('/today')}`;
  await openPlanner(page, overSecondChat);
  frame = plannerFrame(page);
  await frame.locator('main.main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${modifier}+1`);
  const switched = await until(async () => new URL(page.url()).searchParams.get('session') === chatId, 5000);
  check("Ctrl/Cmd+1 in the Planner switches OpenChamber's header to its first tab (the chat), not Chrome's", Boolean(switched) && context.pages().length === 1, page.url().replace(base, ''));
  check('…and the Planner stays beside it', await plannerShown());
  await page.screenshot({ path: join(out, '07-ctrl-1-chat.png') });
  // From a field too: the field keeps what editing uses (Cmd/Ctrl+B is bold in the notes), and OpenChamber's
  // navigation keys go to OpenChamber, not to Chrome.
  await openPlanner(page, overSecondChat);
  frame = plannerFrame(page);
  await frame.getByRole('button', { name: /Add task/ }).first().click();
  const field = frame.getByRole('textbox', { name: 'New task' }).first();
  await field.waitFor({ timeout: 10_000 });
  await field.fill('forge-typing');
  const sidebarBefore = await sidebarShown();
  await page.keyboard.press(`${modifier}+b`);
  await wait(1_000);
  check('Cmd/Ctrl+B typed in a Planner field stays with the field (the sidebar does not toggle)', (await sidebarShown()) === sidebarBefore && await plannerShown() && (await field.inputValue()) === 'forge-typing');
  await page.keyboard.press(`${modifier}+1`);
  check("Ctrl/Cmd+1 typed in a Planner field switches OpenChamber's header to its first tab, not Chrome's",
    Boolean(await until(async () => new URL(page.url()).searchParams.get('session') === chatId, 5000)) && context.pages().length === 1, page.url().replace(base, ''));
  await page.screenshot({ path: join(out, '08-ctrl-1-from-field.png') });
  check('no page errors', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (error) {
  check('journey completed', false, String(error).split('\n')[0]);
  await context.pages()[0]?.screenshot({ path: join(out, '99-failure.png') }).catch(() => {});
} finally {
  // What this run made: its task and its chat, so the stack stays as the other checks expect it.
  await cleanup().catch(() => {});
  await drain.close(browser, { label: 'forge.mjs' });
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
