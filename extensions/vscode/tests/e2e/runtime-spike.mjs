// Spike (round 14, phase 1): VS Code's three parts in OpenChamber as one VS Code, through the bridge extension
// (bridge/extension.js) installed on the scratch stack's VS Code Server. At 1440×900, with screenshots and delays:
//   1. a breakpoint set in the page's editor appears in the rail's Run and Debug view;
//   2. a launch from the rail stops at it: call stack and variables in the rail; the paused line, a hover value and
//      F10 in the page; the real session runs in the bottom terminal's workbench, the rail and page mirror it;
//   3. F5 in the page starts the same session there, and no Debug side bar opens in the page;
//   4. "Terminal: Create New Terminal" from the page's command palette, and its key, add a terminal to the bottom's
//      list, and no panel shows in the page (sampled every animation frame);
//   5. a task run from the page runs once, in the bottom;
//   6. closing the bottom zone keeps its workbench and a paused session; F10 still steps.
//
//   export WORK=/tmp/opencode/vscode-runtime/e2e STACK_PORT_BASE=35440
//   node tests/e2e/openchamber-adapters/stack.mjs up && node /tmp/opencode/vscode-surfaces/tools/install-vscode.mjs
//   node extensions/vscode/bridge/pack.mjs /tmp/bridge.vsix && code-server --install-extension /tmp/bridge.vsix
//   node extensions/vscode/tests/e2e/runtime-spike.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/vscode-runtime/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-runtime/spike';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35440);
const base = `http://127.0.0.1:${BASE + 1}`;
const serverUrl = `http://127.0.0.1:${BASE + 2}`;
const ID = 'oc-forge-vscode';
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const project = join(work, 'adapted/home/projects/spike');
const taskLog = join(out, 'task-runs.log');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const measures = {};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (probe, timeout = 15_000, every = 50) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await Promise.resolve().then(probe).catch(() => null);
    if (value) return value;
    if (Date.now() > end) return null;
    await wait(every);
  }
};

// ── The project: a program that ticks every 300 ms, a launch for it, a task that notes each run ──
rmSync(project, { recursive: true, force: true });
mkdirSync(join(project, '.vscode'), { recursive: true });
writeFileSync(join(project, 'spike-debug.js'), [
  'let count = 0;',
  'setInterval(() => {',
  "  const tick = { count: ++count, at: 'spike' };",
  '  const doubled = tick.count * 2;',
  '  console.log(`spike tick ${tick.count} ${doubled}`);',
  '}, 300);',
  '',
].join('\n'));
writeFileSync(join(project, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'spike-debug', type: 'node', request: 'launch', program: '${workspaceFolder}/spike-debug.js', skipFiles: ['<node_internals>/**'], preLaunchTask: 'spike-task' }] }, null, 2));
// Any shell (the server's user may run bash, zsh or fish).
writeFileSync(join(project, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'spike-task', type: 'shell', command: `echo ran >> ${taskLog}`, problemMatcher: [] }] }, null, 2));
rmSync(taskLog, { force: true });
/** How many times the task ran: run from the page (5), or as the launch's preLaunchTask (2, 3, 7). */
const taskRuns = () => (existsSync(taskLog) ? readFileSync(taskLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);
execFileSync('git', ['init', '-q', '-b', 'main', project]);
execFileSync('git', ['-C', project, '-c', 'user.name=spike', '-c', 'user.email=spike@oc-forge.invalid', 'add', '.']);
execFileSync('git', ['-C', project, '-c', 'user.name=spike', '-c', 'user.email=spike@oc-forge.invalid', 'commit', '-qm', 'spike']);

// ── The bridge's bus, watched: every message with its time (the probe answers the breakpoints' roll call, empty) ──
const busKey = `${hostname()}|file://${project}`;
const busFile = () => {
  const name = `${createHash('sha1').update(busKey).digest('hex').slice(0, 20)}.sock`;
  for (const dir of readdirSync('/tmp').filter((entry) => entry.startsWith('ocvsb-'))) if (existsSync(join('/tmp', dir, name))) return join('/tmp', dir, name);
  return null;
};
const bus = { log: [], members: [], socket: null, me: { part: 'probe', member: randomUUID() } };
const watchBus = () => {
  const file = busFile();
  if (!file) return setTimeout(watchBus, 500);
  const socket = net.connect(file);
  let buffer = '';
  socket.on('connect', () => {
    bus.socket = socket;
    socket.write(`${JSON.stringify({ type: 'hello', from: bus.me })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.type === 'members') bus.members = message.list.map((item) => item.part);
      bus.log.push({ at: Date.now(), type: message.type, from: message.from?.part, to: message.to, command: message.command ?? message.event ?? message.config?.name ?? message.name, realId: message.realId?.slice(0, 8), reqId: message.reqId?.slice(0, 8) });
      if (message.type === 'bp.ask' && (!message.to || message.to === bus.me.member)) socket.write(`${JSON.stringify({ type: 'reply', to: message.from.member, reqId: message.reqId, ok: true, value: [], from: bus.me })}\n`);
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => {
    bus.socket = null;
    setTimeout(watchBus, 300);
  });
};
const busSince = (at, type, command) => bus.log.find((item) => item.at >= at && item.type === type && (!command || item.command === command));

// ── OpenChamber ──
const browser = await chromium.launch();
const setup = await browser.newContext();
const api = setup.request;
await api.post(`${base}/auth/session`, { data: { password } });
const settings = await (await api.get(`${base}/api/config/settings`)).json();
const storage = async (body) => (await (await api.post(`${base}/api/guests/${ID}/storage`, { data: body })).json());
const kept = {};
for (const key of (await storage({ op: 'keys' })).keys) kept[key] = (await storage({ op: 'get', key })).value;
const projects = (settings.projects ?? []).filter((entry) => entry.path !== project);
await api.put(`${base}/api/config/settings`, { data: { sessionTabsEnabled: true, projects: [...projects, { id: 'spike', path: project, label: 'spike', addedAt: Date.now() }] } });
await storage({ op: 'set', key: 'settings', value: { serverUrl, token, followTheme: true } });
await storage({ op: 'set', key: 'folder', value: project });
for (const key of ['open-request', 'handled-open:panel', 'handled-open:page', 'handled-open:view']) await storage({ op: 'delete', key });
const created = await (await api.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: 'Spike chat', location: { directory: project } } })).json();
const chat = (created.data ?? created).id;

const view = (page) => page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
const editor = (page) => page.frameLocator(`[data-oc-forge-page="${ID}"] iframe`).first();
const bottom = (page) => page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
const entry = (page, name) => page.locator(`[data-context-surface="plugin:${ID}--${name}"]`).first();
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
/** A workbench frame's VS Code, from its services (the probe's init script keeps its instantiation service). */
const diag = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__spikeInstantiation;
  if (!instantiation) return null;
  const get = (name) => instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
  const debug = get('debugService');
  const layout = get('layoutService');
  const focused = debug.getViewModel().focusedStackFrame;
  return {
    role: document.documentElement.dataset.ocVscodeRole,
    breakpoints: debug.getModel().getBreakpoints().map((bp) => ({ file: bp.uri.path.split('/').pop(), line: bp.lineNumber })),
    state: debug.state,
    sessions: debug.getModel().getSessions().map((session) => ({ name: session.getLabel(), type: session.configuration.type, state: session.state, child: Boolean(session.parentSession) })),
    focused: focused ? { line: focused.range.startLineNumber, name: focused.name } : null,
    terminals: get('terminalService').instances.map((instance) => instance.title),
    panel: layout.isVisible('workbench.parts.panel'),
    sidebar: layout.isVisible('workbench.parts.sidebar'),
  };
}, null, { timeout: 5_000 });
/** Whether these parts show (in the DOM, sized, displayed), sampled every animation frame in a frame: counts of frames. */
const PAGE_PARTS = { panel: '.monaco-workbench .part.panel', sidebar: '.monaco-workbench .part.sidebar' };
const RAIL_PARTS = { editor: '.monaco-workbench .part.editor', panel: '.monaco-workbench .part.panel' };
const BOTTOM_PARTS = { sidebar: '.monaco-workbench .part.sidebar', editor: '.monaco-workbench .part.editor', toolbar: '.debug-toolbar' };
const watchParts = (frame, parts = PAGE_PARTS) => frame.locator('html').evaluate((_html, selectors) => {
  const seen = { frames: 0, counts: Object.fromEntries(Object.keys(selectors).map((name) => [name, 0])) };
  window.__spikeSeen = seen;
  const shown = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  };
  const tick = () => {
    seen.frames++;
    for (const [name, selector] of Object.entries(selectors)) if (shown(selector)) seen.counts[name]++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, parts);
const seenParts = (frame) => frame.locator('html').evaluate(() => {
  const seen = window.__spikeSeen;
  const result = { frames: seen.frames, ...seen.counts };
  seen.frames = 0;
  for (const name of Object.keys(seen.counts)) seen.counts[name] = 0;
  return result;
});
const command = async (page, frame, label) => {
  await page.keyboard.press('Control+Shift+p');
  const input = frame.locator('.quick-input-widget input');
  await input.waitFor({ timeout: 10_000 });
  await input.fill(`>${label}`);
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: exact }) }).first().click({ timeout: 10_000 });
};
/**
 * Into the page's editor, on its last line: clear of the floating debug toolbar (over line 1) and of a hover, and
 * inside the page's frame (narrow beside the rail panel), which a click past its edge would scroll.
 */
let focusPage = async () => undefined;
const goToLine = async (page, frame, line) => {
  await page.keyboard.press('Control+g');
  await frame.locator('.quick-input-widget input').fill(`:${line}`);
  await page.keyboard.press('Enter');
  await frame.locator('.quick-input-widget').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
};
const sessionsOf = async (page) => ({ runtime: (await diag(bottom(page)))?.sessions ?? [], rail: (await diag(view(page)))?.sessions ?? [], page: (await diag(editor(page)))?.sessions ?? [] });
const stopAll = async (page) => {
  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      if (!window.__spikeInstantiation) return;
      const get = (name) => window.__spikeInstantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
      await get('debugService').stopSession(undefined, false, true);
    }).catch(() => undefined);
  }
  await until(async () => (await diag(bottom(page)))?.sessions.length === 0, 15_000);
};

/** A browser window signed in, whose VS Code frames keep their instantiation service for `diag`. */
const newWindow = async () => {
  const created = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await created.request.post(`${base}/auth/session`, { data: { password } });
  await created.addInitScript(() => {
    let hooks;
    Object.defineProperty(globalThis, '__ocVSCode', {
      configurable: true,
      get: () => hooks,
      set: (value) => {
        hooks = value;
        const original = value.services;
        value.services = function (instantiation) {
          globalThis.__spikeInstantiation = instantiation;
          return original.apply(this, arguments);
        };
      },
    });
  });
  return created;
};
const context = await newWindow();
const page = await context.newPage();
page.setDefaultTimeout(20_000);
let second = null;
try {
  await page.goto(`${base}/?session=${chat}`);
  await entry(page, 'explorer').waitFor({ timeout: 60_000 });
  await page.locator('header [role="tab"][aria-selected="true"]').filter({ hasText: 'Spike chat' }).waitFor({ timeout: 30_000 });
  await wait(1_500);
  if ((await entry(page, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page, 'explorer').click();
  const row = view(page).locator('.explorer-folders-view .monaco-list-row', { hasText: 'spike-debug.js' }).first();
  await row.waitFor({ timeout: 180_000 });
  // The runtime: VS Code's terminal at OpenChamber's bottom.
  await entry(page, 'terminal').click();
  await bottom(page).locator('.xterm:visible').first().waitFor({ timeout: 120_000 });
  await row.click();
  const ed = editor(page).locator('.monaco-editor[data-uri$="spike-debug.js"]').first();
  await ed.locator('.view-line').first().waitFor({ timeout: 120_000 });
  focusPage = async () => {
    await page.mouse.move(150, 600);
    await wait(400);
    await ed.locator('.view-lines').click({ position: { x: 120, y: 125 } });
  };
  await until(async () => (await editor(page).locator('html[data-oc-vscode-page-started="true"]').count()) > 0, 120_000);
  watchBus();
  const joined = await until(() => ['view', 'editor', 'terminal'].every((part) => bus.members.includes(part)), 60_000);
  check('the bridge runs in the rail view, the page and the terminal, and they found each other', joined, `members: ${bus.members.join(', ')}`);
  await watchParts(editor(page));
  await watchParts(view(page), RAIL_PARTS);
  await watchParts(bottom(page), BOTTOM_PARTS);
  await shot(page, '0-start');

  // ── 1. A breakpoint set in the page appears in the rail's Run and Debug view ──
  await focusPage();
  await goToLine(page, editor(page), 3);
  if ((await diag(editor(page))).breakpoints.some((bp) => bp.line === 3)) await page.keyboard.press('F9');
  const setAt = Date.now();
  await page.keyboard.press('F9');
  const inPage = await until(async () => (await diag(editor(page))).breakpoints.some((bp) => bp.file === 'spike-debug.js' && bp.line === 3), 5_000);
  const inRail = await until(async () => (await diag(view(page))).breakpoints.some((bp) => bp.file === 'spike-debug.js' && bp.line === 3), 10_000, 20);
  measures.breakpointToRail = Date.now() - setAt;
  const inRuntime = await until(async () => (await diag(bottom(page))).breakpoints.some((bp) => bp.file === 'spike-debug.js' && bp.line === 3), 10_000);
  await entry(page, 'debug').click();
  await view(page).locator('.debug-viewlet').first().waitFor({ timeout: 30_000 });
  const railRow = await until(async () => {
    const rows = await view(page).locator('.debug-breakpoints .monaco-list-row').allInnerTexts();
    return rows.find((text) => text.includes('spike-debug.js') && /\b3\b/.test(text)) ?? null;
  }, 15_000);
  check('1 a breakpoint set in the page appears in the rail\'s Run and Debug view (and in the runtime)', inPage && inRail && inRuntime && railRow,
    `${measures.breakpointToRail} ms to the rail's model; its row "${(railRow ?? '').replace(/\s+/g, ' ')}"`);
  await shot(page, '1-breakpoint-in-rail');

  // ── 2. A launch from the rail stops at it ──
  await view(page).locator('.part.sidebar .composite.title').first().click();
  const railLaunchAt = Date.now();
  await page.keyboard.press('F5');
  // Each part's own time, all watched at once.
  const timed = (name, probe, timeout = 60_000, every = 20) => until(probe, timeout, every).then((value) => {
    measures[name] = Date.now() - railLaunchAt;
    return value;
  });
  const [railPaused, railStack, variables, pagePaused] = await Promise.all([
    timed('railLaunchToRailPaused', async () => (await diag(view(page)))?.focused?.line === 3),
    timed('railLaunchToRailCallStack', async () => {
      const rows = await view(page).locator('.debug-call-stack .monaco-list-row').allInnerTexts();
      return rows.find((text) => text.includes('spike-debug.js') && text.includes('3:')) ?? null;
    }),
    // At line 3, `tick` is not initialized yet (V8 doesn't list it): the Local scope shows `this`.
    timed('railLaunchToRailVariables', async () => {
      const rows = await view(page).locator('.debug-variables .monaco-list-row').allInnerTexts();
      return rows.some((text) => text.trim() === 'Local') && rows.some((text) => /^this\b/.test(text.trim())) ? rows : null;
    }),
    timed('railLaunchToPageHighlight', async () => (await diag(editor(page)))?.focused?.line === 3 && (await ed.locator('.debug-top-stack-frame-line').count()) > 0),
  ]);
  const where = await sessionsOf(page);
  check('2 a launch from the rail runs in the runtime (the bottom terminal\'s workbench), mirrored in the rail and the page',
    where.runtime.length > 0 && where.rail.length === where.runtime.length && where.page.length === where.runtime.length,
    `runtime ${JSON.stringify(where.runtime.map((s) => `${s.name}${s.child ? ' (child)' : ''}:${s.type}`))}; rail ${where.rail.map((s) => s.type).join(',')}; page ${where.page.map((s) => s.type).join(',')}`);
  check('2 it stops at the page\'s breakpoint: the rail shows the call stack and the variables', railPaused && railStack && variables,
    `${measures.railLaunchToRailPaused} ms to paused in the rail, ${measures.railLaunchToRailCallStack} ms to its call stack row "${(railStack ?? '').replace(/\s+/g, ' ')}"; variables ${(variables ?? []).slice(0, 4).map((text) => text.replace(/\s+/g, ' ')).join(' | ')}`);
  check('2 the page shows the paused line', pagePaused, `${measures.railLaunchToPageHighlight} ms after the launch`);
  check('2 the launch\'s preLaunchTask ran once, in the runtime', taskRuns() === 1, `${taskRuns()} run(s)`);
  await shot(page, '2-paused-from-rail');
  // F10 in the page.
  await focusPage();
  const stepAt = Date.now();
  await page.keyboard.press('F10');
  const [stepped, railStepped, railVariablesAfter] = await Promise.all([
    until(async () => (await diag(editor(page)))?.focused?.line === 4, 10_000, 10).then((value) => ((measures.f10ToPageLine = Date.now() - stepAt), value)),
    until(async () => (await diag(view(page)))?.focused?.line === 4, 10_000, 10).then((value) => ((measures.f10ToRailLine = Date.now() - stepAt), value)),
    until(async () => {
      const rows = (await view(page).locator('.debug-variables .monaco-list-row').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
      return rows.some((text) => /^tick = \{count: 1/.test(text)) ? rows : null;
    }, 10_000).then((value) => ((measures.f10ToRailVariables = Date.now() - stepAt), value)),
  ]);
  const highlightLine = await ed.locator('.view-overlays .debug-top-stack-frame-line').first().evaluate((element) => {
    const top = element.parentElement.getBoundingClientRect().top;
    const line = [...element.closest('.monaco-editor').querySelectorAll('.margin-view-overlays .line-numbers')].find((number) => Math.abs(number.parentElement.getBoundingClientRect().top - top) < 2);
    return line?.textContent?.trim() ?? null;
  }).catch(() => null);
  check('2 F10 in the page steps: the paused line moves to 4 in the page and in the rail', stepped && railStepped && highlightLine === '4',
    `${measures.f10ToPageLine} ms in the page, ${measures.f10ToRailLine} ms in the rail; highlighted line ${highlightLine}`);
  // A hover value.
  const tickToken = ed.locator('.view-line', { hasText: 'const doubled' }).locator('span', { hasText: /^tick$/ }).first();
  await tickToken.hover();
  const hover = await until(async () => {
    const widget = editor(page).locator('.debug-hover-widget').first();
    return (await widget.isVisible()) ? (await widget.innerText()).replace(/\s+/g, ' ') : null;
  }, 10_000);
  check('2 hovering `tick` in the page shows its value', hover && /count/.test(hover), hover ?? 'no hover');
  await shot(page, '2-stepped-hover');
  await page.locator(`[data-oc-forge-page="${ID}"] iframe`).first().screenshot({ path: join(out, '2-stepped-hover-page.png') }).catch(() => undefined);
  check('2 the rail\'s variables follow the step', railVariablesAfter, `${measures.f10ToRailVariables} ms: ${(railVariablesAfter ?? []).slice(0, 4).join(' | ')}`);
  const pageParts = await seenParts(editor(page));
  check('2 no Debug side bar or panel showed in the page meanwhile (every animation frame)', pageParts.sidebar === 0 && pageParts.panel === 0, JSON.stringify(pageParts));
  // Shift+F5 in the page stops the real session.
  await focusPage();
  await page.keyboard.press('Shift+F5');
  const stopAt = Date.now();
  const stopped = await until(async () => {
    const now = await sessionsOf(page);
    return now.runtime.length === 0 && now.rail.length === 0 && now.page.length === 0;
  }, 15_000);
  measures.stopToAllEnded = Date.now() - stopAt;
  check('2 Shift+F5 in the page stops the real session, and its mirrors end', stopped, `${measures.stopToAllEnded} ms; ${JSON.stringify(await sessionsOf(page))}`);

  // ── 3. F5 in the page ──
  await seenParts(editor(page));
  await focusPage();
  const pageLaunchAt = Date.now();
  await page.keyboard.press('F5');
  const pagePaused3 = await until(async () => (await diag(editor(page)))?.focused?.line === 3 && (await ed.locator('.debug-top-stack-frame-line').count()) > 0, 60_000, 20);
  measures.pageLaunchToPageHighlight = Date.now() - pageLaunchAt;
  const railPaused3 = await until(async () => (await diag(view(page)))?.focused?.line === 3, 15_000);
  const where3 = await sessionsOf(page);
  const pageParts3 = await seenParts(editor(page));
  const pageNow = await diag(editor(page));
  check('3 F5 in the page starts the same session in the runtime: paused in the page and the rail', pagePaused3 && railPaused3 && where3.runtime.length > 0,
    `${measures.pageLaunchToPageHighlight} ms to the paused line; runtime ${where3.runtime.map((s) => s.type).join(',')}`);
  check('3 its preLaunchTask ran once more, in the runtime', taskRuns() === 2, `${taskRuns()} run(s) in all`);
  check('3 no Debug side bar (or panel) in the page, at any animation frame', !pageNow.sidebar && !pageNow.panel && pageParts3.sidebar === 0 && pageParts3.panel === 0, JSON.stringify(pageParts3));
  await shot(page, '3-paused-from-page');
  const railParts = await seenParts(view(page));
  const bottomParts = await seenParts(bottom(page));
  check('1–3 meanwhile the rail showed no editor area or panel, and the bottom no side bar, editor area or debug toolbar, at any animation frame',
    railParts.editor === 0 && railParts.panel === 0 && bottomParts.sidebar === 0 && bottomParts.editor === 0 && bottomParts.toolbar === 0,
    `rail ${JSON.stringify(railParts)}; bottom ${JSON.stringify(bottomParts)}`);

  // ── 6. The bottom zone closed: its workbench and the paused session stay; F10 still steps ──
  const bottomFrames = () => page.locator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').count();
  await entry(page, 'terminal').click();
  const closed = await until(async () => (await entry(page, 'terminal').getAttribute('aria-pressed')) !== 'true', 5_000);
  await wait(1_500);
  const keptFrame = (await bottomFrames()) === 1 && bus.members.includes('terminal');
  await focusPage();
  await page.keyboard.press('F10');
  const steppedClosed = await until(async () => (await diag(editor(page)))?.focused?.line === 4, 10_000);
  check('6 with the bottom zone closed, its workbench stays (the session too), and F10 in the page still steps', closed && keptFrame && steppedClosed,
    `closed ${Boolean(closed)}, frame kept ${keptFrame}, stepped ${Boolean(steppedClosed)}`);
  await shot(page, '6-zone-closed');
  await entry(page, 'terminal').click();
  await until(async () => (await entry(page, 'terminal').getAttribute('aria-pressed')) === 'true', 5_000);

  // ── 8. The page reloads while paused: the real session goes on, and the page mirrors it again ──
  const runtimeBefore = (await diag(bottom(page))).sessions.length;
  await focusPage();
  await command(page, editor(page), 'Developer: Reload Window');
  const reloadAt = Date.now();
  await wait(1_000);
  const back = await until(async () => (await diag(editor(page)))?.focused?.line === 4 && (await ed.locator('.debug-top-stack-frame-line').count()) > 0, 120_000, 100);
  measures.pageReloadToPausedLine = Date.now() - reloadAt;
  const runtimeAfter = (await diag(bottom(page))).sessions.length;
  check('8 the page reloads while paused: the real session goes on in the runtime, and the page shows its paused line again', back && runtimeBefore > 0 && runtimeAfter === runtimeBefore,
    `${measures.pageReloadToPausedLine} ms to the paused line; runtime sessions ${runtimeBefore} → ${runtimeAfter}`);
  await shot(page, '8-page-reloaded');
  await until(async () => (await editor(page).locator('html[data-oc-vscode-page-started="true"]').count()) > 0, 60_000);
  await watchParts(editor(page));
  await stopAll(page);

  // ── 4. "Terminal: Create New Terminal" from the page: palette, then key ──
  await seenParts(editor(page));
  const terminalsBefore = (await diag(bottom(page))).terminals.length;
  await focusPage();
  const paletteAt = Date.now();
  await command(page, editor(page), 'Terminal: Create New Terminal');
  const added = await until(async () => (await diag(bottom(page))).terminals.length === terminalsBefore + 1, 15_000, 20);
  measures.paletteToBottomTerminal = Date.now() - paletteAt;
  await wait(800);
  const pageAfter = await diag(editor(page));
  const parts4 = await seenParts(editor(page));
  const focusInBottom = await bottom(page).locator('html').evaluate(() => document.hasFocus()).catch(() => false);
  check('4 "Terminal: Create New Terminal" from the page\'s palette adds a terminal to the bottom\'s list', added, `${terminalsBefore} → ${(await diag(bottom(page))).terminals.length} in ${measures.paletteToBottomTerminal} ms; bottom focused ${focusInBottom}`);
  check('4 no terminal and no panel in the page, at any animation frame', pageAfter.terminals.length === 0 && !pageAfter.panel && parts4.panel === 0, `page terminals ${pageAfter.terminals.length}; ${JSON.stringify(parts4)}`);
  await shot(page, '4-terminal-from-palette');
  await focusPage();
  const keyAt = Date.now();
  await page.keyboard.press('Control+Shift+Backquote');
  const addedByKey = await until(async () => (await diag(bottom(page))).terminals.length === terminalsBefore + 2, 15_000, 20);
  measures.keyToBottomTerminal = Date.now() - keyAt;
  await wait(800);
  const parts4b = await seenParts(editor(page));
  const pageAfterKey = await diag(editor(page));
  check('4 its key (Ctrl+Shift+`) in the page does the same', addedByKey && pageAfterKey.terminals.length === 0 && parts4b.panel === 0, `${(await diag(bottom(page))).terminals.length} in the bottom after ${measures.keyToBottomTerminal} ms; page terminals ${pageAfterKey.terminals.length}; ${JSON.stringify(parts4b)}`);
  const tabs = (await bottom(page).locator('.terminal-tabs-entry').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
  check('4 the bottom\'s native list shows them', tabs.length >= terminalsBefore + 2, tabs.join(' | '));
  await shot(page, '4-terminal-from-key');

  // ── 5. A task run from the page runs once, in the bottom ──
  await focusPage();
  const runsBefore = taskRuns();
  const taskAt = Date.now();
  await command(page, editor(page), 'Tasks: Run Task');
  const pick = editor(page).locator('.quick-input-list .monaco-list-row', { hasText: 'spike-task' }).first();
  await pick.waitFor({ timeout: 15_000 });
  await pick.click();
  const ran = await until(() => taskRuns() > runsBefore, 20_000, 20);
  measures.taskToRun = Date.now() - taskAt;
  await wait(4_000);
  const runs = taskRuns() - runsBefore;
  const bottomTerminals = (await diag(bottom(page))).terminals;
  const pageAfterTask = await diag(editor(page));
  const parts5 = await seenParts(editor(page));
  check('5 a task run from the page runs once, in the bottom (its terminal in the bottom\'s list), nothing in the page',
    ran && runs === 1 && bottomTerminals.some((title) => /spike-task/.test(title)) && pageAfterTask.terminals.length === 0 && parts5.panel === 0,
    `${runs} run(s), ${measures.taskToRun} ms from the palette to the run; bottom: ${bottomTerminals.join(' | ')}; page terminals ${pageAfterTask.terminals.length}; ${JSON.stringify(parts5)}`);
  await shot(page, '5-task');

  // ── 7. Two browser tabs on the folder: a launch runs once, in one runtime, and both tabs mirror it ──
  second = await newWindow();
  const page2 = await second.newPage();
  page2.setDefaultTimeout(20_000);
  await page2.goto(`${base}/?session=${chat}`);
  await entry(page2, 'explorer').waitFor({ timeout: 60_000 });
  await wait(1_500);
  if ((await entry(page2, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page2, 'explorer').click();
  await view(page2).locator('.explorer-folders-view .monaco-list-row', { hasText: 'spike-debug.js' }).first().waitFor({ timeout: 180_000 });
  await entry(page2, 'terminal').click();
  await bottom(page2).locator('.xterm:visible').first().waitFor({ timeout: 120_000 });
  const twoRuntimes = await until(() => bus.members.filter((part) => part === 'terminal').length === 2, 60_000);
  await entry(page2, 'debug').click();
  await view(page2).locator('.debug-viewlet').first().waitFor({ timeout: 30_000 });
  await view(page2).locator('.part.sidebar .composite.title').first().click();
  const runsBefore7 = taskRuns();
  await page2.keyboard.press('F5');
  const pausedBoth = await until(async () => (await diag(view(page2)))?.focused?.line === 3 && (await diag(view(page)))?.focused?.line === 3, 60_000);
  await wait(1_500);
  const real = [(await diag(bottom(page))).sessions.length, (await diag(bottom(page2))).sessions.length];
  check('7 two browser tabs on the folder: a launch from the second tab\'s rail runs once, in one runtime, and both tabs\' rails show it paused',
    twoRuntimes && pausedBoth && real.filter((count) => count > 0).length === 1 && Math.max(...real) === 2 && taskRuns() === runsBefore7 + 1,
    `terminal parts on the bus ${bus.members.filter((part) => part === 'terminal').length}; real sessions in each tab's runtime ${JSON.stringify(real)}; preLaunchTask runs ${taskRuns() - runsBefore7}`);
  await shot(page2, '7-second-tab');
  await stopAll(page);
  await stopAll(page2);
} catch (error) {
  check('the spike ran to the end', false, String(error.message ?? error).split('\n')[0]);
  await shot(page, 'error').catch(() => undefined);
} finally {
  await stopAll(page).catch(() => undefined);
  bus.socket?.destroy();
  await second?.close();
  await context.close();
  await api.delete(`${base}/api/session/${chat}?directory=${encodeURIComponent(project)}`).catch(() => undefined);
  for (const key of (await storage({ op: 'keys' })).keys) if (!(key in kept)) await storage({ op: 'delete', key });
  for (const [key, value] of Object.entries(kept)) await storage({ op: 'set', key, value });
  await api.put(`${base}/api/config/settings`, { data: { projects: settings.projects ?? [] } });
  await browser.close();
  // A mirror's latency: each relayed DAP request's round trip on the bus (the runtime's customRequest), by command.
  const asked = new Map(bus.log.filter((item) => item.type === 'dap.request' && item.reqId).map((item) => [item.reqId, item]));
  const trips = {};
  for (const item of bus.log) {
    if (item.type !== 'reply' || !asked.has(item.reqId)) continue;
    const request = asked.get(item.reqId);
    (trips[request.command] ??= []).push(item.at - request.at);
  }
  const stats = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1) };
  };
  measures.relay = Object.fromEntries(Object.entries(trips).map(([command, list]) => [command, stats(list)]));
  measures.relayAll = stats(Object.values(trips).flat());
  measures.busMessages = bus.log.length;
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ results, measures, bus: bus.log }, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; measures ${JSON.stringify(measures)}; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
