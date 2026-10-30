// End-to-end check that VS Code's parts in one OpenChamber window (the rail view, the page, the bottom terminal) are
// one VS Code: the bridge extension (bridge/), which the frames install on the VS Code Server, on the adapters' scratch
// stack, at 1440×900 and 1024×768, with screenshots. REVIEW-13's Verify, word for word:
//   gap 3: "At both sizes, a breakpoint in a host-header file must appear in the rail Debug view and stop a launch
//          initiated there. Starting from either surface must expose the same session, call stack, variables and
//          controls in the intended surfaces, without a second independent Debug sidebar inside the editor."
//   gap 4: "Create terminals from the editor's command palette/keybinding and from a normal task/debug workflow. They
//          must appear in the host-bottom terminal's native list, with working selection/splits/shell choice, and no
//          additional independent terminal panel left inside the editor or rail view."
// And: Restart, a breakpoint's verification, a compound launch, a task and a terminal an extension makes through the
// API (the test extension `runtime-probe`, like the NPM Scripts view), Stop from the rail; once per run the bridge
// installing itself, and two browser tabs on the folder not talking across (each its own runtime: needs the host's
// `window-id`).
//
//   export WORK=/tmp/opencode/vscode-runtime/e2e STACK_PORT_BASE=35440
//   node tests/e2e/openchamber-adapters/stack.mjs up && node <tools>/install-vscode.mjs
//   node extensions/vscode/tests/e2e/runtime.mjs [outDir]
//
// RUNTIME_SIZES=1440 runs one size. Every check names its gap; on a build without the bridge (b7dfa40, the negative
// control) every gap check fails.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const work = process.env.WORK ?? '/tmp/opencode/vscode-runtime/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-runtime/runtime';
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35440);
const base = `http://127.0.0.1:${BASE + 1}`;
const serverUrl = `http://127.0.0.1:${BASE + 2}`;
const ID = 'oc-forge-vscode';
const BRIDGE = 'openchamber.openchamber-bridge';
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const project = join(work, 'adapted/home/projects/runtime-demo');
const runLog = join(out, 'runs.log');
const sizes = (process.env.RUNTIME_SIZES ?? '1440,1024').split(',').map(Number);

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
const runs = (what) => (existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').filter((line) => line.trim() === what).length : 0);

// ── The project: a program that ticks every 300 ms; launches (one with a preLaunchTask, one in a terminal, a
// compound); a task; a file no launch loads (an unverified breakpoint) ──
rmSync(project, { recursive: true, force: true });
mkdirSync(join(project, '.vscode'), { recursive: true });
writeFileSync(join(project, 'app.js'), [
  'let count = 0;',
  'setInterval(() => {',
  "  const tick = { count: ++count, at: 'runtime' };",
  '  const doubled = tick.count * 2;',
  '  console.log(`tick ${tick.count} ${doubled}`);',
  '}, 300);',
  '',
].join('\n'));
writeFileSync(join(project, 'other.js'), 'module.exports = 1;\n');
writeFileSync(join(project, '.vscode/launch.json'), JSON.stringify({
  version: '0.2.0',
  configurations: [
    { name: 'app', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js', skipFiles: ['<node_internals>/**'], preLaunchTask: 'note-launch' },
    { name: 'app in a terminal', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js', skipFiles: ['<node_internals>/**'], console: 'integratedTerminal' },
  ],
  compounds: [{ name: 'both', configurations: ['app', 'app in a terminal'], preLaunchTask: 'note-compound', stopAll: true }],
}, null, 2));
// Any shell (the server's user may run bash, zsh or fish).
writeFileSync(join(project, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
  { label: 'note-launch', type: 'shell', command: `echo launch >> ${runLog}`, problemMatcher: [] },
  { label: 'note-compound', type: 'shell', command: `echo compound >> ${runLog}`, problemMatcher: [] },
  { label: 'note-task', type: 'shell', command: `echo task >> ${runLog}`, problemMatcher: [] },
] }, null, 2));
rmSync(runLog, { force: true });
execFileSync('git', ['init', '-q', '-b', 'main', project]);
execFileSync('git', ['-C', project, '-c', 'user.name=runtime', '-c', 'user.email=runtime@oc-forge.invalid', 'add', '.']);
execFileSync('git', ['-C', project, '-c', 'user.name=runtime', '-c', 'user.email=runtime@oc-forge.invalid', 'commit', '-qm', 'runtime']);

// ── A test extension that does what NPM Scripts does (a provider's task, run through the API) and makes a terminal
// through the API, from whichever part runs its command ──
const PROBE = { publisher: 'ocforge-e2e', name: 'runtime-probe' };
const serverCli = (...args) => execFileSync(join(work, 'vscode-server/bin/code-server'), ['--server-data-dir', join(work, 'vscode/data'), ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(work, 'vscode/home') }, stdio: ['ignore', 'pipe', 'pipe'],
});
const installProbe = () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-probe-'));
  mkdirSync(join(dir, 'extension'), { recursive: true });
  writeFileSync(join(dir, 'extension/package.json'), JSON.stringify({
    name: PROBE.name, publisher: PROBE.publisher, version: '0.0.1', displayName: 'Runtime probe', engines: { vscode: '^1.80.0' }, extensionKind: ['workspace'],
    main: './main.js', activationEvents: ['onStartupFinished'],
    contributes: {
      taskDefinitions: [{ type: 'runtimeProbe', required: ['name'], properties: { name: { type: 'string' } } }],
      commands: [{ command: 'runtimeProbe.runTask', title: 'Runtime Probe: Run Its Task' }, { command: 'runtimeProbe.terminal', title: 'Runtime Probe: Open Its Terminal' }],
    },
  }));
  writeFileSync(join(dir, 'extension/main.js'), `
const vscode = require('vscode');
exports.activate = (context) => {
  const make = () => new vscode.Task({ type: 'runtimeProbe', name: 'probe' }, vscode.TaskScope.Workspace, 'probe', 'runtimeProbe', new vscode.ShellExecution(${JSON.stringify(`echo api-task >> ${runLog}`)}), []);
  context.subscriptions.push(vscode.tasks.registerTaskProvider('runtimeProbe', { provideTasks: () => [make()], resolveTask: () => undefined }));
  context.subscriptions.push(vscode.commands.registerCommand('runtimeProbe.runTask', async () => {
    const [task] = await vscode.tasks.fetchTasks({ type: 'runtimeProbe' });
    await vscode.tasks.executeTask(task);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('runtimeProbe.terminal', () => {
    const terminal = vscode.window.createTerminal({ name: 'probe-terminal' });
    terminal.show();
    setTimeout(() => terminal.sendText(${JSON.stringify(`echo api-terminal >> ${runLog}`)}), 1500);
  }));
};
`);
  writeFileSync(join(dir, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${PROBE.name}" Version="0.0.1" Publisher="${PROBE.publisher}" /><DisplayName>Runtime probe</DisplayName><Description xml:space="preserve">e2e</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" /></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets></PackageManifest>
`);
  writeFileSync(join(dir, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>');
  execFileSync('zip', ['-qr', join(dir, 'probe.vsix'), '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dir });
  serverCli('--install-extension', join(dir, 'probe.vsix'), '--force');
  rmSync(dir, { recursive: true, force: true });
};
installProbe();
// The bridge installs itself: start from a server without it.
try {
  serverCli('--uninstall-extension', BRIDGE);
} catch {
  // Not installed.
}

// ── The bridge's bus (the probe joins as a member to watch it; the key is the window's: `host|folder|window`) ──
const busDir = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith('ocvsb-')).map((entry) => join(tmpdir(), entry));
const busLogs = [];
const watchBus = (windowKey) => {
  const bus = { log: [], members: [], socket: null, me: { part: 'probe', member: randomUUID() }, closed: false };
  const name = `${createHash('sha1').update(`${hostname()}|file://${project}|${windowKey}`).digest('hex').slice(0, 20)}.sock`;
  const connect = () => {
    if (bus.closed) return;
    const file = busDir().map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
    if (!file) {
      setTimeout(connect, 300);
      return;
    }
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
        bus.log.push({ at: Date.now(), type: message.type, from: message.from?.part, command: message.command ?? message.event ?? message.name, reqId: message.reqId?.slice(0, 8) });
        if (['bp.ask', 'diag.all'].includes(message.type) && message.to === bus.me.member) socket.write(`${JSON.stringify({ type: 'reply', to: message.from.member, reqId: message.reqId, ok: true, value: [], from: bus.me })}\n`);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      bus.socket = null;
      setTimeout(connect, 300);
    });
  };
  connect();
  busLogs.push(bus);
  return { bus, close: () => {
    bus.closed = true;
    bus.socket?.destroy();
  } };
};

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
await api.put(`${base}/api/config/settings`, { data: { sessionTabsEnabled: true, projects: [...projects, { id: 'runtime-demo', path: project, label: 'runtime-demo', addedAt: Date.now() }] } });
await storage({ op: 'set', key: 'settings', value: { serverUrl, token, followTheme: true } });
await storage({ op: 'set', key: 'folder', value: project });
for (const key of ['open-request', 'handled-open:panel', 'handled-open:page', 'handled-open:view']) await storage({ op: 'delete', key });
const created = await (await api.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: 'Runtime chat', location: { directory: project } } })).json();
const chat = (created.data ?? created).id;

const view = (page) => page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
const editor = (page) => page.frameLocator(`[data-oc-forge-page="${ID}"] iframe`).first();
const bottom = (page) => page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
const entry = (page, name) => page.locator(`[data-context-surface="plugin:${ID}--${name}"]`).first();
/** A workbench frame's VS Code, from its services (the init script keeps its instantiation service). */
const diag = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const get = (name) => instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
  const debug = get('debugService');
  const layout = get('layoutService');
  const focused = debug.getViewModel().focusedStackFrame;
  const session = debug.getViewModel().focusedSession;
  return {
    role: document.documentElement.dataset.ocVscodeRole,
    breakpoints: debug.getModel().getBreakpoints().map((bp) => ({ file: bp.uri.path.split('/').pop(), line: bp.lineNumber, verified: bp.verified })),
    sessions: debug.getModel().getSessions().map((item) => ({ name: item.getLabel(), type: item.configuration.type, state: item.state, child: Boolean(item.parentSession) })),
    focused: focused ? { line: focused.range.startLineNumber, name: focused.name } : null,
    sessionType: session?.configuration.type ?? null,
    terminals: get('terminalService').instances.map((instance) => instance.title),
    panel: layout.isVisible('workbench.parts.panel'),
    sidebar: layout.isVisible('workbench.parts.sidebar'),
    debugViewlet: Boolean(document.querySelector('.part.sidebar .debug-viewlet, .part.auxiliarybar .debug-viewlet')) && layout.isVisible('workbench.parts.sidebar'),
  };
}, null, { timeout: 5_000 }).catch(() => null);
const sessionsOf = async (page) => ({ runtime: (await diag(bottom(page)))?.sessions ?? [], rail: (await diag(view(page)))?.sessions ?? [], page: (await diag(editor(page)))?.sessions ?? [] });
/** Whether these parts show, every animation frame in a frame: counts of frames. */
const PAGE_PARTS = { panel: '.monaco-workbench .part.panel', sidebar: '.monaco-workbench .part.sidebar', terminal: '.monaco-workbench .terminal-outer-container' };
const RAIL_PARTS = { editor: '.monaco-workbench .part.editor', panel: '.monaco-workbench .part.panel', terminal: '.monaco-workbench .terminal-outer-container' };
const BOTTOM_PARTS = { sidebar: '.monaco-workbench .part.sidebar', editor: '.monaco-workbench .part.editor', toolbar: '.debug-toolbar' };
const watchParts = (frame, parts) => frame.locator('html').evaluate((_html, selectors) => {
  const seen = { frames: 0, counts: Object.fromEntries(Object.keys(selectors).map((name) => [name, 0])) };
  window.__runtimeSeen = seen;
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
}, parts).catch(() => undefined);
const seenParts = (frame) => frame.locator('html').evaluate(() => {
  const seen = window.__runtimeSeen;
  if (!seen) return null;
  const result = { frames: seen.frames, ...seen.counts };
  seen.frames = 0;
  for (const name of Object.keys(seen.counts)) seen.counts[name] = 0;
  return result;
}).catch(() => null);
const none = (parts, ...names) => Boolean(parts) && parts.frames > 0 && names.every((name) => parts[name] === 0);
const command = async (page, frame, label) => {
  await page.keyboard.press('Control+Shift+p');
  const input = frame.locator('.quick-input-widget input');
  await input.waitFor({ timeout: 10_000 });
  await input.fill(`>${label}`);
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: exact }) }).first().click({ timeout: 10_000 });
};
const pick = async (frame, label) => {
  const row = frame.locator('.quick-input-list .monaco-list-row', { hasText: label }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
};
const goToLine = async (page, frame, line) => {
  await page.keyboard.press('Control+g');
  await frame.locator('.quick-input-widget input').fill(`:${line}`);
  await page.keyboard.press('Enter');
  await frame.locator('.quick-input-widget').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
};
const stopAll = async (page) => {
  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      if (!window.__runtimeInstantiation) return;
      const get = (name) => window.__runtimeInstantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
      await get('debugService').stopSession(undefined, false, true);
    }).catch(() => undefined);
  }
  await until(async () => (await sessionsOf(page)).runtime.length === 0 && (await sessionsOf(page)).page.length === 0, 15_000);
  await wait(500);
};
const newWindow = async (viewport) => {
  const context = await browser.newContext({ viewport });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  await context.addInitScript(() => {
    let hooks;
    Object.defineProperty(globalThis, '__ocVSCode', {
      configurable: true,
      get: () => hooks,
      set: (value) => {
        hooks = value;
        const original = value.services;
        value.services = function (instantiation) {
          globalThis.__runtimeInstantiation = instantiation;
          return original.apply(this, arguments);
        };
      },
    });
  });
  return context;
};
/** OpenChamber's window id as the frames tell the bridge (`forge.window.id()`), or 'folder' on a host without it. */
const windowKeyOf = async (frame) => (await frame.locator('html').evaluate(async () => {
  try {
    const instantiation = window.__runtimeInstantiation;
    const get = (name) => instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
    const info = await get('commandService').executeCommand('openchamber.vscode.bridge.info');
    return info?.window ?? null;
  } catch {
    return null;
  }
}).catch(() => null)) ?? 'folder';

/** Opens a window's three parts: the Explorer, the terminal at the bottom, app.js in the page. */
const openParts = async (page, size, { terminal = true } = {}) => {
  await page.goto(`${base}/?session=${chat}`);
  await entry(page, 'explorer').waitFor({ timeout: 60_000 });
  await page.locator('header [role="tab"][aria-selected="true"]').filter({ hasText: 'Runtime chat' }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await wait(1_500);
  if ((await entry(page, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page, 'explorer').click();
  const row = view(page).locator('.explorer-folders-view .monaco-list-row', { hasText: 'app.js' }).first();
  await row.waitFor({ timeout: 180_000 });
  if (terminal) {
    await entry(page, 'terminal').click();
    await bottom(page).locator('.xterm:visible').first().waitFor({ timeout: 120_000 });
  }
  await row.click();
  const ed = editor(page).locator('.monaco-editor[data-uri$="app.js"]').first();
  await ed.locator('.view-line').first().waitFor({ timeout: 120_000 });
  await until(async () => (await editor(page).locator('html[data-oc-vscode-page-started="true"]').count()) > 0, 120_000);
  const focusPage = async () => {
    await page.mouse.move(150, Math.round(page.viewportSize().height * 0.6));
    await wait(300);
    await ed.locator('.view-lines').click({ position: { x: 60, y: 125 } });
  };
  return { ed, focusPage };
};

const journey = async (viewport, first) => {
  const size = `${viewport.width}x${viewport.height}`;
  const shot = (page, name) => page.screenshot({ path: join(out, `${size}-${name}.png`) });
  const context = await newWindow(viewport);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  let watcher = null;
  try {
    const startedAt = Date.now();
    const { ed, focusPage } = await openParts(page, size);
    const windowKey = await windowKeyOf(editor(page));
    watcher = watchBus(windowKey);
    const joined = await until(() => ['view', 'editor', 'terminal'].every((part) => watcher.bus.members.includes(part)), first ? 180_000 : 60_000);
    if (first) measures.installToJoined = Date.now() - startedAt;
    check(`[${size}] the bridge runs in the rail view, the page and the terminal of this window${first ? ', installed by the frames on the VS Code Server' : ''}`, joined,
      `members: ${watcher.bus.members.join(', ') || 'none'}; window ${windowKey}${first ? `; ${((Date.now() - startedAt) / 1000).toFixed(1)} s from the window's start` : ''}`);
    if (first) {
      const listed = serverCli('--list-extensions', '--show-versions');
      check(`[${size}] the bridge is installed on the VS Code Server (by the frames, no CLI)`, listed.includes(BRIDGE), listed.split('\n').filter((line) => line.includes('openchamber')).join(' '));
    }
    await watchParts(editor(page), PAGE_PARTS);
    await watchParts(view(page), RAIL_PARTS);
    await watchParts(bottom(page), BOTTOM_PARTS);

    // ── Gap 3: a breakpoint in the page's file (a header tab) in the rail's Debug view, and a launch from there ──
    await focusPage();
    await goToLine(page, editor(page), 3);
    if ((await diag(editor(page)))?.breakpoints.some((bp) => bp.file === 'app.js' && bp.line === 3)) await page.keyboard.press('F9');
    const setAt = Date.now();
    await page.keyboard.press('F9');
    const inRail = await until(async () => (await diag(view(page)))?.breakpoints.some((bp) => bp.file === 'app.js' && bp.line === 3), 10_000, 20);
    measures[`${size}.breakpointToRail`] = Date.now() - setAt;
    await entry(page, 'debug').click();
    await view(page).locator('.debug-viewlet').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    const railRow = await until(async () => (await view(page).locator('.debug-breakpoints .monaco-list-row').allInnerTexts()).find((text) => text.includes('app.js') && /\b3\b/.test(text)) ?? null, 15_000);
    check(`[${size}] gap 3: a breakpoint set in the page's editor (a header-tab file) appears in the rail Debug view`, inRail && railRow, `${measures[`${size}.breakpointToRail`]} ms to the rail's model; row "${(railRow ?? '').replace(/\s+/g, ' ')}"`);
    await shot(page, '3-breakpoint-in-rail');

    // From the rail: its selected configuration ("app"), with F5.
    const launchRuns = runs('launch');
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await command(page, view(page), 'Debug: Select Debug Configuration');
    await pick(view(page), 'app');
    await wait(500);
    await view(page).locator('.part.sidebar .composite.title').first().click();
    const railAt = Date.now();
    await page.keyboard.press('F5');
    const timed = (name, probe, timeout = 60_000) => until(probe, timeout, 20).then((value) => ((measures[`${size}.${name}`] = Date.now() - railAt), value));
    const [railPaused, railStack, pagePaused] = await Promise.all([
      timed('railLaunchToRailPaused', async () => (await diag(view(page)))?.focused?.line === 3),
      timed('railLaunchToRailCallStack', async () => (await view(page).locator('.debug-call-stack .monaco-list-row').allInnerTexts()).find((text) => text.includes('app.js') && text.includes('3:')) ?? null),
      timed('railLaunchToPagePausedLine', async () => (await diag(editor(page)))?.focused?.line === 3 && (await ed.locator('.debug-top-stack-frame-line').count()) > 0),
    ]);
    const where = await sessionsOf(page);
    const realOnce = where.runtime.length === 2 && where.runtime.every((item) => item.type === 'pwa-node');
    check(`[${size}] gap 3: a launch from the rail stops at the page's breakpoint (paused in the rail's call stack and on the page's line)`, railPaused && railStack && pagePaused,
      `${measures[`${size}.railLaunchToRailPaused`]} ms to paused in the rail, ${measures[`${size}.railLaunchToPagePausedLine`]} ms to the page's paused line; "${(railStack ?? '').replace(/\s+/g, ' ')}"`);
    check(`[${size}] gap 3: it is one session, the runtime's (the bottom's), that the rail and the page show (mirrors); its preLaunchTask ran once`, realOnce && where.rail.length === 2 && where.page.length === 2 && runs('launch') === launchRuns + 1,
      `runtime ${where.runtime.map((item) => `${item.name}:${item.type}`).join(', ')}; rail ${where.rail.length}, page ${where.page.length} mirrors; preLaunchTask ${runs('launch') - launchRuns}×`);
    // Variables in the rail; controls in the page: its toolbar, F10, a hover.
    await focusPage();
    const stepAt = Date.now();
    await page.keyboard.press('F10');
    const [stepped, railStepped, variables] = await Promise.all([
      until(async () => (await diag(editor(page)))?.focused?.line === 4, 10_000, 10).then((value) => ((measures[`${size}.f10ToPage`] = Date.now() - stepAt), value)),
      until(async () => (await diag(view(page)))?.focused?.line === 4, 10_000, 10).then((value) => ((measures[`${size}.f10ToRail`] = Date.now() - stepAt), value)),
      until(async () => {
        const rows = (await view(page).locator('.debug-variables .monaco-list-row').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
        return rows.some((text) => /^tick = \{count: \d+/.test(text)) ? rows : null;
      }, 10_000),
    ]);
    const toolbar = await editor(page).locator('.debug-toolbar').first().isVisible().catch(() => false);
    const railToolbar = await view(page).locator('.debug-toolbar').first().isVisible().catch(() => false);
    const tickToken = ed.locator('.view-line', { hasText: 'const doubled' }).locator('span', { hasText: /^tick$/ }).first();
    await tickToken.hover().catch(() => undefined);
    const hover = await until(async () => {
      const widget = editor(page).locator('.debug-hover-widget').first();
      return (await widget.isVisible()) ? (await widget.innerText()).replace(/\s+/g, ' ') : null;
    }, 10_000);
    check(`[${size}] gap 3: from the rail, the rail shows its call stack and variables, the page its controls: the toolbar (the page's only), F10 (to line 4 in both), a hover value`,
      stepped && railStepped && variables && toolbar && !railToolbar && hover && /count/.test(hover),
      `F10 ${measures[`${size}.f10ToPage`]} ms (page), ${measures[`${size}.f10ToRail`]} ms (rail); variables ${(variables ?? []).slice(0, 3).join(' | ')}; toolbar page ${toolbar}, rail ${railToolbar}; hover "${hover ?? ''}"`);
    await shot(page, '3-paused-from-rail');
    // Restart (the page's toolbar, Ctrl+Shift+F5): VS Code's restart, in the runtime; paused again.
    await page.mouse.move(150, Math.round(viewport.height * 0.6));
    await focusPage();
    const restartAt = Date.now();
    const before = (await sessionsOf(page)).runtime.length;
    await page.keyboard.press('Control+Shift+F5');
    await wait(1_000);
    const restarted = await until(async () => (await diag(editor(page)))?.focused?.line === 3 && (await diag(view(page)))?.focused?.line === 3, 60_000);
    measures[`${size}.restartToPaused`] = Date.now() - restartAt;
    const afterRestart = await sessionsOf(page);
    check(`[${size}] Restart from the page restarts the runtime's session: paused again in the page and the rail, still one`, restarted && afterRestart.runtime.length === before && afterRestart.page.length === before,
      `${measures[`${size}.restartToPaused`]} ms; runtime ${afterRestart.runtime.length}, page ${afterRestart.page.length}, rail ${afterRestart.rail.length} sessions`);
    // Verification: the real adapter's word on each breakpoint, in the page's model.
    const verified = await until(async () => (await diag(editor(page)))?.breakpoints.find((bp) => bp.file === 'app.js' && bp.line === 3)?.verified === true, 10_000);
    check(`[${size}] a breakpoint's verification is the real adapter's, in the page and the rail`, verified && (await diag(view(page)))?.breakpoints.find((bp) => bp.file === 'app.js' && bp.line === 3)?.verified === true);
    const pageParts = await seenParts(editor(page));
    check(`[${size}] gap 3: no Debug side bar (or panel) inside the page at any animation frame, launched from the rail`, none(pageParts, 'sidebar', 'panel'), JSON.stringify(pageParts));
    // Stop from the rail.
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await page.keyboard.press('Shift+F5');
    const stoppedFromRail = await until(async () => {
      const now = await sessionsOf(page);
      return now.runtime.length === 0 && now.rail.length === 0 && now.page.length === 0;
    }, 15_000);
    check(`[${size}] Stop from the rail (Shift+F5 there) stops the runtime's session; every mirror ends`, stoppedFromRail);
    if (!stoppedFromRail) await stopAll(page);

    // From the page: its selected configuration ("app"), with F5.
    await seenParts(editor(page));
    await focusPage();
    await command(page, editor(page), 'Debug: Select Debug Configuration');
    await pick(editor(page), 'app');
    await wait(500);
    await focusPage();
    const pageAt = Date.now();
    await page.keyboard.press('F5');
    const [pageStopped, railFromPage] = await Promise.all([
      until(async () => (await diag(editor(page)))?.focused?.line === 3 && (await ed.locator('.debug-top-stack-frame-line').count()) > 0, 60_000, 20).then((value) => ((measures[`${size}.pageLaunchToPausedLine`] = Date.now() - pageAt), value)),
      until(async () => (await diag(view(page)))?.focused?.line === 3 && (await view(page).locator('.debug-call-stack .monaco-list-row').allInnerTexts()).some((text) => text.includes('3:')), 60_000),
    ]);
    const fromPage = await sessionsOf(page);
    const pageNow = await diag(editor(page));
    const parts3 = await seenParts(editor(page));
    check(`[${size}] gap 3: a launch from the page gives the same: the runtime's session, the rail's call stack, the page's paused line`, pageStopped && railFromPage && fromPage.runtime.length === 2 && fromPage.page.length === 2 && fromPage.rail.length === 2,
      `${measures[`${size}.pageLaunchToPausedLine`]} ms to the paused line; runtime ${fromPage.runtime.length}, rail ${fromPage.rail.length}, page ${fromPage.page.length} sessions`);
    check(`[${size}] gap 3: without a second, independent Debug sidebar inside the editor (at any animation frame)`, pageNow && !pageNow.sidebar && !pageNow.debugViewlet && none(parts3, 'sidebar', 'panel'), JSON.stringify(parts3));
    await shot(page, '3-paused-from-page');
    await focusPage();
    await page.keyboard.press('Shift+F5');
    await until(async () => (await sessionsOf(page)).runtime.length === 0, 15_000);
    await stopAll(page);

    // A compound from the rail: its preLaunchTask once, in the runtime; both configurations there.
    const compoundRuns = runs('compound');
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await command(page, view(page), 'Debug: Select and Start Debugging');
    await pick(view(page), 'both');
    const compound = await until(async () => {
      const now = await sessionsOf(page);
      return now.runtime.length >= 4 && now.rail.length === now.runtime.length;
    }, 60_000);
    const compoundState = await sessionsOf(page);
    check(`[${size}] a compound launch from the rail runs in the runtime: its own preLaunchTask once, its launches there, mirrored`, compound && runs('compound') === compoundRuns + 1 && compoundState.rail.length === compoundState.runtime.length,
      `runtime ${compoundState.runtime.map((item) => item.name).join(', ')}; preLaunchTask ${runs('compound') - compoundRuns}×; rail ${compoundState.rail.length}`);
    await shot(page, '3-compound');
    await stopAll(page);

    // ── Gap 4: terminals from the page (palette, key), a task, a debug launch in a terminal ──
    await seenParts(editor(page));
    await seenParts(view(page));
    const listed = async () => (await diag(bottom(page)))?.terminals ?? [];
    const count0 = (await listed()).length;
    await focusPage();
    const paletteAt = Date.now();
    await command(page, editor(page), 'Terminal: Create New Terminal');
    const byPalette = await until(async () => (await listed()).length === count0 + 1, 15_000, 20);
    measures[`${size}.paletteToBottomTerminal`] = Date.now() - paletteAt;
    await focusPage();
    const keyAt = Date.now();
    await page.keyboard.press('Control+Shift+Backquote');
    const byKey = await until(async () => (await listed()).length === count0 + 2, 15_000, 20);
    measures[`${size}.keyToBottomTerminal`] = Date.now() - keyAt;
    check(`[${size}] gap 4: "Terminal: Create New Terminal" from the page's palette, and its key, make terminals in the bottom's list`, byPalette && byKey,
      `${count0} → ${(await listed()).length}; palette ${measures[`${size}.paletteToBottomTerminal`]} ms, key ${measures[`${size}.keyToBottomTerminal`]} ms`);
    // A normal task workflow: Run Task from the page, VS Code's own picker.
    const taskRuns = runs('task');
    await focusPage();
    await command(page, editor(page), 'Tasks: Run Task');
    await pick(editor(page), 'note-task');
    const ranTask = await until(() => runs('task') === taskRuns + 1, 20_000);
    await wait(2_000);
    const taskTerminal = (await listed()).find((title) => /note-task/.test(title));
    check(`[${size}] gap 4: a task run from the page (VS Code's picker) runs once, its terminal in the bottom's list`, ranTask && runs('task') === taskRuns + 1 && taskTerminal, `${runs('task') - taskRuns}×; ${taskTerminal ?? 'no task terminal'}`);
    // A debug workflow: a launch whose program runs in the integrated terminal.
    await stopAll(page);
    await focusPage();
    await command(page, editor(page), 'Debug: Select and Start Debugging');
    await pick(editor(page), 'app in a terminal');
    // VS Code names the terminal after the launch (and reuses one a launch made before).
    const debugTerminal = await until(async () => (await sessionsOf(page)).runtime.length > 0 && (await listed()).some((title) => /app in a terminal/.test(title)), 60_000);
    const pageTerminals = (await diag(editor(page)))?.terminals ?? [];
    check(`[${size}] gap 4: a debug launch with its program in the integrated terminal opens that terminal in the bottom's list (not the page's)`, debugTerminal && pageTerminals.length === 0, `${(await listed()).filter((title) => /app in a terminal/.test(title)).join(' | ') || (await listed()).join(' | ')}; page terminals ${pageTerminals.length}`);
    await shot(page, '4-debug-terminal');
    await stopAll(page);
    // Selection, splits and the shell choice, natively in the bottom.
    const tabs = bottom(page).locator('.terminal-tabs-entry');
    const tabCount = await tabs.count();
    await tabs.nth(0).click().catch(() => undefined);
    const selected0 = await bottom(page).locator('.terminal-tabs-entry.is-active, .terminal-tabs-entry[aria-selected="true"]').first().innerText().catch(() => '');
    await tabs.nth(Math.max(tabCount - 1, 0)).click().catch(() => undefined);
    const selectedLast = await bottom(page).locator('.terminal-tabs-entry.is-active, .terminal-tabs-entry[aria-selected="true"]').first().innerText().catch(() => '');
    await bottom(page).locator('.xterm:visible').first().click().catch(() => undefined);
    await page.keyboard.press('Control+Shift+5');
    const split = await until(async () => (await bottom(page).locator('.xterm:visible').count()) >= 2, 15_000);
    await bottom(page).locator('.part.panel .action-label[aria-label="Launch Profile..."]').first().click().catch(() => undefined);
    const profiles = await until(async () => {
      const items = await bottom(page).locator('.context-view .action-label, .quick-input-widget .quick-input-list .monaco-list-row').allTextContents();
      return items.filter((item) => item.trim()).length > 0 ? items : null;
    }, 10_000);
    await page.keyboard.press('Escape');
    check(`[${size}] gap 4: in the bottom's list, selecting a terminal, a split and the shell choice work`, tabCount >= 3 && split && profiles,
      `${tabCount} listed; selected "${selected0.replace(/\s+/g, ' ').trim()}" then "${selectedLast.replace(/\s+/g, ' ').trim()}"; split ${Boolean(split)}; shells ${(profiles ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 3).join(' | ')}`);
    await shot(page, '4-bottom-list');
    const pageAfter = await diag(editor(page));
    const railAfter = await diag(view(page));
    const parts4 = await seenParts(editor(page));
    const rail4 = await seenParts(view(page));
    check(`[${size}] gap 4: no terminal panel inside the page or the rail view (at any animation frame), and no terminal of theirs`,
      pageAfter && railAfter && pageAfter.terminals.length === 0 && railAfter.terminals.length === 0 && none(parts4, 'panel', 'terminal') && none(rail4, 'panel', 'terminal'),
      `page ${JSON.stringify(parts4)} terminals ${pageAfter?.terminals.length}; rail ${JSON.stringify(rail4)} terminals ${railAfter?.terminals.length}`);

    // ── A task and a terminal an extension makes through the API (as NPM Scripts does), from the rail and the page ──
    const apiTasks = runs('api-task');
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await command(page, view(page), 'Runtime Probe: Run Its Task');
    const apiTask = await until(() => runs('api-task') === apiTasks + 1, 20_000);
    await wait(2_000);
    // VS Code runs a task in the task terminal another task left (its title the earlier task's): the bus says where.
    const routedTask = watcher.bus.log.some((item) => item.type === 'task.run' && item.from === 'view');
    check(`[${size}] a task an extension runs through the API from the rail (as NPM Scripts does) runs once, in the bottom`,
      apiTask && runs('api-task') === apiTasks + 1 && routedTask && ((await diag(view(page)))?.terminals.length ?? 1) === 0,
      `${runs('api-task') - apiTasks}×; sent to the runtime ${routedTask}; rail terminals ${(await diag(view(page)))?.terminals.length}`);
    const apiTerminals = runs('api-terminal');
    await focusPage();
    await command(page, editor(page), 'Runtime Probe: Open Its Terminal');
    const movedTerminal = await until(async () => (await listed()).some((title) => /probe-terminal/.test(title)), 20_000);
    const typed = await until(() => runs('api-terminal') === apiTerminals + 1, 20_000);
    const parts5 = await seenParts(editor(page));
    check(`[${size}] a terminal an extension makes in the page through the API shows in the bottom's list (its text reaches it), no panel in the page`,
      movedTerminal && typed && none(parts5, 'panel'), `${(await listed()).filter((title) => /probe-terminal/.test(title)).join(' | ')}; sendText ran ${runs('api-terminal') - apiTerminals}×; ${JSON.stringify(parts5)}`);
    await shot(page, '5-api-terminal');

    const bottomParts = await seenParts(bottom(page));
    check(`[${size}] the bottom showed no side bar, editor area or debug toolbar of its own throughout`, none(bottomParts, 'sidebar', 'editor', 'toolbar'), JSON.stringify(bottomParts));
  } catch (error) {
    check(`[${size}] the journey ran to the end`, false, String(error.message ?? error).split('\n')[0]);
    await page.screenshot({ path: join(out, `${size}-error.png`) }).catch(() => undefined);
  } finally {
    await stopAll(page).catch(() => undefined);
    watcher?.close();
    await context.close();
  }
};

/** Two browser tabs on the folder: each is its own VS Code, with its own runtime. */
const twoTabs = async () => {
  const size = '1440x900';
  const viewport = { width: 1440, height: 900 };
  const one = await newWindow(viewport);
  const two = await newWindow(viewport);
  const first = await one.newPage();
  const second = await two.newPage();
  try {
    await openParts(first, size);
    await openParts(second, size);
    const [keyOne, keyTwo] = [await windowKeyOf(editor(first)), await windowKeyOf(editor(second))];
    await entry(second, 'debug').click();
    await view(second).locator('.part.sidebar .composite.title').first().click();
    await second.keyboard.press('F5');
    const paused = await until(async () => (await diag(view(second)))?.focused?.line === 3, 60_000);
    await wait(1_500);
    const inOne = await sessionsOf(first);
    const inTwo = await sessionsOf(second);
    check(`[${size}] two browser tabs on the folder: a launch from the second runs in the second's bottom, and the first tab shows none of it`,
      keyOne !== keyTwo && paused && inTwo.runtime.length === 2 && inOne.runtime.length === 0 && inOne.rail.length === 0 && inOne.page.length === 0,
      `windows ${keyOne} / ${keyTwo}; first: runtime ${inOne.runtime.length}, rail ${inOne.rail.length}, page ${inOne.page.length}; second: runtime ${inTwo.runtime.length}`);
    await second.screenshot({ path: join(out, `${size}-6-second-tab.png`) });
    await first.screenshot({ path: join(out, `${size}-6-first-tab.png`) });
  } catch (error) {
    check(`[${size}] two tabs ran to the end`, false, String(error.message ?? error).split('\n')[0]);
  } finally {
    await stopAll(second).catch(() => undefined);
    await one.close();
    await two.close();
  }
};

try {
  for (const [index, width] of sizes.entries()) await journey(width === 1024 ? { width: 1024, height: 768 } : { width: 1440, height: 900 }, index === 0);
  if (process.env.RUNTIME_TWO_TABS !== '0') await twoTabs();
} catch (error) {
  check('the check ran to the end', false, String(error.message ?? error).split('\n')[0]);
} finally {
  try {
    await api.delete(`${base}/api/session/${chat}?directory=${encodeURIComponent(project)}`).catch(() => undefined);
    for (const key of (await storage({ op: 'keys' })).keys) if (!(key in kept)) await storage({ op: 'delete', key });
    for (const [key, value] of Object.entries(kept)) await storage({ op: 'set', key, value });
    await api.put(`${base}/api/config/settings`, { data: { projects: settings.projects ?? [] } });
  } catch (error) {
    console.log(`could not put OpenChamber's settings back: ${error.message}`);
  }
  try {
    serverCli('--uninstall-extension', `${PROBE.publisher}.${PROBE.name}`);
  } catch {
    // Not installed.
  }
  await browser.close();
  // A relayed DAP request's round trip on the bus, by command.
  const trips = {};
  for (const bus of busLogs) {
    const asked = new Map(bus.log.filter((item) => item.type === 'dap.request' && item.reqId).map((item) => [item.reqId, item]));
    for (const item of bus.log) {
      if (item.type !== 'reply' || !asked.has(item.reqId)) continue;
      (trips[asked.get(item.reqId).command] ??= []).push(item.at - asked.get(item.reqId).at);
    }
  }
  const stats = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted.at(-1) };
  };
  measures.relay = stats(Object.values(trips).flat());
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ results, measures }, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
