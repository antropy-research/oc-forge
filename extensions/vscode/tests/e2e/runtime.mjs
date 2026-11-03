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
// RUNTIME_SIZES=none: no journeys (the two-tab and the before-the-bottom checks only).
const sizes = (process.env.RUNTIME_SIZES ?? '1440,1024').split(',').map(Number).filter(Boolean);

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
const lines = (prefix) => (existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').filter((line) => line.startsWith(prefix)) : []);

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
// A syntax error the page's language server reports.
writeFileSync(join(project, 'broken.js'), 'const = 1;\n');
// Renamed and deleted in the rail while the page shows them.
writeFileSync(join(project, 'rename-me.js'), '// rename me\n');
writeFileSync(join(project, 'delete-me.js'), '// delete me\n');
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
  // A problem matcher's problem on app.js, from a task (in the bottom).
  {
    label: 'lint', type: 'shell', command: "echo 'app.js:2:1: warning: e2e-problem'",
    problemMatcher: { owner: 'e2e', source: 'e2e', fileLocation: ['relative', '${workspaceFolder}'], pattern: { regexp: '^(.*):(\\d+):(\\d+): (warning|error): (.*)$', file: 1, line: 2, column: 3, severity: 4, message: 5 } },
  },
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
  context.subscriptions.push(vscode.commands.registerCommand('runtimeProbe.rename', (from, to) => {
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.joinPath(folder, from), vscode.Uri.joinPath(folder, to));
    return vscode.workspace.applyEdit(edit);
  }));
  // Testing: one test; its run and its debug say which part ran them (the frame's own command) and what
  // startDebugging answered.
  const fs = require('fs');
  const part = () => vscode.commands.executeCommand('openchamber.vscode.bridge.info').then((info) => info?.role ?? 'unknown', () => 'unknown');
  const tests = vscode.tests.createTestController('runtimeProbe', 'Runtime probe');
  context.subscriptions.push(tests);
  const item = tests.createTestItem('probe-test', 'probe test', vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'app.js'));
  item.range = new vscode.Range(0, 0, 0, 10);
  tests.items.add(item);
  tests.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request) => {
    const run = tests.createTestRun(request);
    run.appendOutput('probe test output\\r\\n');
    run.passed(item, 5);
    fs.appendFileSync(${JSON.stringify(runLog)}, 'test-run ' + (await part()) + '\\n');
    run.end();
  }, true);
  tests.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, async (request) => {
    const run = tests.createTestRun(request);
    const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], 'app', { testRun: run });
    fs.appendFileSync(${JSON.stringify(runLog)}, 'test-debug ' + (await part()) + ' ' + ok + '\\n');
    if (ok) await new Promise((resolve) => setTimeout(resolve, 3000));
    run.end();
  }, true);
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
/** A frame's problems on a file (by its name): owner, message, line. */
const markersIn = (frame, name) => frame.locator('html').evaluate((_html, file) => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const markers = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('markerService')));
  return markers.read().filter((marker) => marker.resource.path.endsWith(`/${file}`)).map((marker) => ({ owner: marker.owner, message: marker.message, line: marker.startLineNumber }));
}, name, { timeout: 5_000 }).catch(() => null);
/** A frame's output channels' names. */
const outputsIn = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const output = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('outputService')));
  return output.getChannelDescriptors().map((descriptor) => descriptor.label);
}, null, { timeout: 5_000 }).catch(() => null);
/** An output channel shown in a frame's Output view: its text. */
const outputText = (frame, label) => frame.locator('html').evaluate(async (_html, wanted) => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const get = (name) => instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
  const output = get('outputService');
  const descriptor = output.getChannelDescriptors().find((item) => item.label === wanted);
  if (!descriptor) return null;
  await output.showChannel(descriptor.id, true);
  const channel = output.getChannel(descriptor.id);
  return channel ? get('modelService').getModel(channel.uri)?.getValue() ?? null : null;
}, label, { timeout: 10_000 }).catch(() => null);
/** Runs a command in a frame's VS Code. */
const runIn = (frame, id) => frame.locator('html').evaluate(async (_html, commandId) => {
  const instantiation = window.__runtimeInstantiation;
  const commands = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('commandService')));
  await commands.executeCommand(commandId);
  return true;
}, id, { timeout: 10_000 }).catch(() => null);
/** Runs a command with arguments in a frame's VS Code: its answer (or the error). */
const runWith = (frame, id, args) => frame.locator('html').evaluate(async (_html, [commandId, commandArgs]) => {
  const instantiation = window.__runtimeInstantiation;
  const commands = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('commandService')));
  return commands.executeCommand(commandId, ...commandArgs);
}, [id, args], { timeout: 20_000 }).catch((error) => `error: ${error.message}`);
/** The line of the cursor in the page's editor. */
const pageCursor = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const editors = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('editorService')));
  return editors.activeTextEditorControl?.getPosition?.()?.lineNumber ?? null;
}, null, { timeout: 5_000 }).catch(() => null);
/** The panel view container a frame shows (`workbench.panel.markers`, `terminal`, …). */
const activePanel = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const panes = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('paneCompositePartService')));
  return panes.getActivePaneComposite(1)?.getId() ?? null;
}, null, { timeout: 5_000 }).catch(() => null);
/** The page's active editor: its file, the kind, whether unsaved, its text (a diff's: the modified side's). */
const activeIn = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const editors = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('editorService')));
  const active = editors.activeEditor;
  const control = editors.activeTextEditorControl;
  const model = control?.getModifiedEditor ? control.getModifiedEditor().getModel() : control?.getModel?.();
  return active ? { path: active.resource?.path ?? null, type: active.typeId, dirty: active.isDirty(), text: model?.getValue() ?? null } : null;
}, null, { timeout: 5_000 }).catch(() => null);
/** A text file's model in a frame: unsaved, orphan (its file gone). */
const fileModelIn = (frame, name) => frame.locator('html').evaluate((_html, file) => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const textFiles = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('textFileService')));
  const model = textFiles.files.models.find((item) => item.resource.path.endsWith(`/${file}`));
  return model ? { dirty: model.isDirty(), orphan: model.hasState(4), text: model.textEditorModel?.getValue() ?? null } : null;
}, name, { timeout: 5_000 }).catch(() => null);
/** Keeps these files of a frame unsaved (no auto-save for them: `IFilesConfigurationService.disableAutoSave`). */
const holdUnsaved = (frame, names) => frame.locator('html').evaluate((_html, files) => {
  const instantiation = window.__runtimeInstantiation;
  const get = (name) => instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get(name)));
  const folder = get('contextService').getWorkspace().folders[0].uri;
  window.__runtimeHeld = [...(window.__runtimeHeld ?? []), ...files.map((file) => get('filesConfigurationService').disableAutoSave(folder.with({ path: `${folder.path}/${file}` })))];
  return window.__runtimeHeld.length;
}, names, { timeout: 5_000 }).catch((error) => `error: ${error.message}`);
const releaseUnsaved = (frame) => frame.locator('html').evaluate(() => {
  for (const held of window.__runtimeHeld ?? []) held.dispose();
  window.__runtimeHeld = [];
  return true;
}, null, { timeout: 5_000 }).catch(() => null);
/** A frame's Source Control, as it holds it (for a check's detail). */
const scmDump = (frame) => frame.locator('html').evaluate(() => {
  try {
    const instantiation = window.__runtimeInstantiation;
    const scm = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('scm')));
    return [...scm.repositories].map((repository) => ({ id: repository.id, groups: repository.provider.groups.map((group) => `${group.id}:${group.resources.map((resource) => resource.sourceUri.path.split('/').pop()).join('+')}`) }));
  } catch (error) {
    return `error: ${error.message}`;
  }
}).catch((error) => `error: ${error.message}`);
/** The files a frame's Source Control lists as staged. */
const stagedIn = (frame) => frame.locator('html').evaluate(() => {
  const instantiation = window.__runtimeInstantiation;
  if (!instantiation) return null;
  const scm = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('scm')));
  const names = [];
  for (const repository of scm.repositories) for (const group of repository.provider.groups) if (group.id === 'index') for (const resource of group.resources) names.push(resource.sourceUri.path.split('/').pop());
  return names;
}, null, { timeout: 5_000 }).catch(() => null);
/** Whether OpenChamber's bottom shows VS Code's terminal (its rail entry lit; a closed zone keeps its frame, unseen). */
const bottomOpen = async (page) => (await entry(page, 'terminal').getAttribute('aria-pressed').catch(() => null)) === 'true';
/** Runs an item of a row's context menu in the rail, from the keyboard (VS Code's menus here take no click). */
const railMenu = async (page, row, item) => {
  await row.click({ button: 'right' });
  await view(page).locator('.context-view .monaco-menu .action-label', { hasText: item }).first().waitFor({ timeout: 10_000 });
  for (let step = 0; step < 40; step++) {
    const focused = (await view(page).locator('.context-view .monaco-menu .action-item.focused .action-label').first().innerText().catch(() => '')).trim();
    if (item.test(focused)) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  // Away from the row: its hover would cover the next one.
  await page.mouse.move(150, Math.round(page.viewportSize().height * 0.6));
};
/** Whether the keyboard focus is in OpenChamber's bottom (VS Code's terminal there took it). */
const focusInBottom = (page) => page.evaluate(() => Boolean(document.activeElement?.closest?.('[data-context-zone="bottom"]'))).catch(() => false);
/** The OpenChamber tab's renderer: its JS heap in MB (Chrome's own metrics). */
const heapOf = async (cdp) => Math.round(((await cdp.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576);
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
/** Runs a command from a frame's command palette, once more if a focus change closed the palette under it. */
const command = async (page, frame, label) => {
  try {
    await paletteCommand(page, frame, label);
  } catch {
    await page.keyboard.press('Escape');
    await wait(1_500);
    await paletteCommand(page, frame, label);
  }
};
const paletteCommand = async (page, frame, label) => {
  const input = frame.locator('.quick-input-widget input');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.keyboard.press('Control+Shift+p');
    if (await input.waitFor({ timeout: 8_000 }).then(() => true, () => false)) break;
    // It opened where the focus was, elsewhere: closed there, and the frame focused (its side bar's title, or its editor).
    await page.keyboard.press('Escape');
    const title = frame.locator('.part.sidebar .composite.title').first();
    if (await title.isVisible().catch(() => false)) await title.click();
    else await frame.locator('.monaco-editor .view-lines').first().click().catch(() => undefined);
  }
  await input.fill(`>${label}`);
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const row = frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: exact }) }).first();
  await row.waitFor({ timeout: 10_000 });
  // The keyboard when the row is the one chosen (as a user would), else a click.
  if (await row.evaluate((element) => element.classList.contains('focused')).catch(() => false)) await page.keyboard.press('Enter');
  else await row.click({ timeout: 10_000 });
};
const pick = async (frame, label) => {
  const row = frame.locator('.quick-input-list .monaco-list-row', { hasText: label }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
};
/** The launch configuration the rail's Run and Debug view starts (its dropdown, as the user picks one). */
const selectInRail = async (page, name) => {
  const label = view(page).locator('.start-debug-action-item-label').first();
  await label.waitFor({ timeout: 30_000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await label.innerText()).trim() === name) return;
    // VS Code 1.144's action widget: the configurations, with a filter box.
    await view(page).locator('.start-debug-action-item-dropdown-label').first().click({ timeout: 10_000 });
    const input = view(page).locator('.action-widget .action-list-filter-input').first();
    await input.waitFor({ timeout: 10_000 });
    await input.fill(name);
    const row = view(page).locator('.action-widget .monaco-list-row').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();
    if (await until(async () => (await row.count()) > 0, 3_000)) await row.click({ timeout: 10_000 });
    else await page.keyboard.press('Enter');
    if (await until(async () => (await label.innerText()).trim() === name, 3_000)) return;
    // Closed before trying again (it covers the dropdown while open).
    await page.keyboard.press('Escape');
    await wait(300);
  }
  if ((await label.innerText()).trim() !== name) throw new Error(`the rail's launch configuration is "${(await label.innerText()).trim()}", not ${name}`);
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
    // The bottom's terminals, by title; the rail's VS Code.
    const listed = async () => (await diag(bottom(page)))?.terminals ?? [];
    const rail = view(page);
    // RUNTIME_ADDENDUM_ONLY=1 (to work on them): only the checks after Output.
    if (process.env.RUNTIME_ADDENDUM_ONLY !== '1') {

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
    await selectInRail(page, 'app');
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
    // Another frame chosen in the rail's call stack: the bottom's Debug Console evaluates in it (the runtime focuses it).
    const frameRows = view(page).locator('.debug-call-stack .monaco-list-row').filter({ has: view(page).locator('.stack-frame') });
    const topName = (await diag(view(page)))?.focused?.name;
    let chosenFrame = null;
    if ((await frameRows.count()) >= 2) {
      await frameRows.nth(1).click();
      chosenFrame = await until(async () => {
        const [rail, runtime] = [await diag(view(page)), await diag(bottom(page))];
        return rail?.focused && runtime?.focused && rail.focused.name !== topName && rail.focused.name === runtime.focused.name ? runtime.focused.name : null;
      }, 10_000);
      await frameRows.nth(0).click().catch(() => undefined);
    }
    check(`[${size}] a frame chosen in the rail's call stack is the bottom's too (its Debug Console evaluates there)`, chosenFrame,
      `${await frameRows.count()} frames; chosen "${chosenFrame ?? ''}", top "${topName ?? ''}"`);
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

    // From the page: "app" chosen and started (Debug: Select and Start Debugging); F5 below starts it again.
    await seenParts(editor(page));
    await focusPage();
    await command(page, editor(page), 'Debug: Select and Start Debugging');
    const pageAt = Date.now();
    await pick(editor(page), 'app');
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
    // F5 in the page: its selected configuration again, the same way.
    await focusPage();
    const f5At = Date.now();
    await page.keyboard.press('F5');
    const f5Paused = await until(async () => (await diag(editor(page)))?.focused?.line === 3 && (await diag(view(page)))?.focused?.line === 3, 60_000, 20);
    measures[`${size}.pageF5ToPaused`] = Date.now() - f5At;
    const f5State = await sessionsOf(page);
    const f5Parts = await seenParts(editor(page));
    check(`[${size}] gap 3: F5 in the page starts the same session: paused in the page and the rail, no Debug sidebar in the page`, f5Paused && f5State.runtime.length === 2 && none(f5Parts, 'sidebar', 'panel'),
      `${measures[`${size}.pageF5ToPaused`]} ms; runtime ${f5State.runtime.length}; ${JSON.stringify(f5Parts)}`);
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
    // The compound itself goes to the runtime (its task first, its stopAll), not its launches one by one.
    const whole = watcher.bus.log.some((item) => item.type === 'debug.start' && item.command === 'both');
    check(`[${size}] a compound launch from the rail runs in the runtime as one: its own preLaunchTask once, its launches there, mirrored`, compound && whole && runs('compound') === compoundRuns + 1 && compoundState.rail.length === compoundState.runtime.length,
      `runtime ${compoundState.runtime.map((item) => item.name).join(', ')}; sent whole ${whole}; preLaunchTask ${runs('compound') - compoundRuns}×; rail ${compoundState.rail.length}`);
    await shot(page, '3-compound');
    await stopAll(page);

    // ── Gap 4: terminals from the page (palette, key), a task, a debug launch in a terminal ──
    await seenParts(editor(page));
    await seenParts(view(page));
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
      `${runs('api-task') - apiTasks}×; sent to the runtime ${routedTask}; rail terminals ${JSON.stringify((await diag(view(page)))?.terminals)}`);
    const apiTerminals = runs('api-terminal');
    await focusPage();
    await command(page, editor(page), 'Runtime Probe: Open Its Terminal');
    const movedTerminal = await until(async () => (await listed()).some((title) => /probe-terminal/.test(title)), 20_000);
    const typed = await until(() => runs('api-terminal') === apiTerminals + 1, 20_000);
    const parts5 = await seenParts(editor(page));
    check(`[${size}] a terminal an extension makes in the page through the API shows in the bottom's list (its text reaches it), no panel in the page`,
      movedTerminal && typed && none(parts5, 'panel'), `${(await listed()).filter((title) => /probe-terminal/.test(title)).join(' | ')}; sendText ran ${runs('api-terminal') - apiTerminals}×; ${JSON.stringify(parts5)}`);
    await shot(page, '5-api-terminal');

    // ── The rail's Outline and Timeline: the page's editor's, in place of VS Code's own ──
    if ((await entry(page, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page, 'explorer').click();
    await rail.locator('.explorer-folders-view').first().waitFor({ timeout: 30_000 });
    const paneTitles = async () => (await rail.locator('.pane-header .title').allInnerTexts()).map((title) => title.trim());
    const single = await until(async () => {
      const titles = await paneTitles();
      return titles.filter((title) => title === 'Outline').length === 1 && titles.filter((title) => title === 'Timeline').length === 1 ? titles : null;
    }, 15_000);
    const pane = (name) => rail.locator('.pane').filter({ has: rail.locator('.pane-header .title', { hasText: new RegExp(`^${name}$`) }) }).first();
    const expand = async (name) => {
      const header = pane(name).locator('.pane-header').first();
      if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
    };
    await focusPage();
    await goToLine(page, editor(page), 5);
    await expand('Outline');
    const outlineRows = pane('Outline').locator('.monaco-list-row');
    const symbols = await until(async () => {
      const texts = (await outlineRows.allInnerTexts()).map((row) => row.replace(/\s+/g, ' ').trim());
      return texts.some((row) => /^count\b/.test(row)) ? texts : null;
    }, 20_000);
    const ours = (await pane('Outline').locator('.customview-tree').count()) > 0;
    await outlineRows.filter({ hasText: /^\s*count\b/ }).first().click().catch(() => undefined);
    const revealed = await until(async () => (await pageCursor(editor(page))) === 1, 10_000);
    await focusPage();
    await goToLine(page, editor(page), 4);
    const followed = await until(async () => (await pane('Outline').locator('.monaco-list-row.selected').allInnerTexts()).map((row) => row.trim()).find((row) => /setInterval|doubled/.test(row)) ?? null, 10_000);
    check(`[${size}] the rail's Outline is the page's editor's: its symbols, one chosen there revealed in the page, the page's cursor followed; VS Code's own (which follows the rail's editor) hidden`,
      single && ours && symbols && revealed && followed, `${(symbols ?? []).slice(0, 4).join(' | ')}; revealed ${Boolean(revealed)}; follows "${followed ?? ''}"; panes ${(single ?? await paneTitles()).join(', ')}`);
    await expand('Timeline');
    const commits = await until(async () => {
      const texts = (await pane('Timeline').locator('.monaco-list-row').allInnerTexts()).map((row) => row.replace(/\s+/g, ' ').trim());
      return texts.some((row) => row.includes('runtime')) ? texts : null;
    }, 30_000);
    check(`[${size}] the rail's Timeline is the page's file's Git history`, commits && (await pane('Timeline').locator('.customview-tree').count()) > 0,
      commits ? commits.slice(0, 3).join(' | ') : `pane: "${(await pane('Timeline').innerText().catch((error) => error.message)).replace(/\s+/g, ' ').slice(0, 160)}"; expanded ${await pane('Timeline').locator('.pane-header').first().getAttribute('aria-expanded').catch(() => null)}`);
    await shot(page, '7-outline-timeline');

    // ── Problems, both ways ──
    // A problem the page's language server finds in a file the page shows: in the bottom's Problems, and the rail's.
    await rail.locator('.explorer-folders-view .monaco-list-row', { hasText: 'broken.js' }).first().click();
    const brokenEditor = editor(page).locator('.monaco-editor[data-uri$="broken.js"]').first();
    await brokenEditor.locator('.view-line').first().waitFor({ timeout: 30_000 });
    const pageProblem = await until(async () => ((await markersIn(editor(page), 'broken.js')) ?? []).length > 0, 60_000);
    const bottomProblem = await until(async () => {
      const list = await markersIn(bottom(page), 'broken.js');
      return list?.length ? list : null;
    }, 15_000);
    await runIn(bottom(page), 'workbench.actions.view.problems');
    const problemRow = await until(async () => (await bottom(page).locator('.markers-panel .monaco-list-row').allInnerTexts()).map((row) => row.replace(/\s+/g, ' ')).find((row) => row.includes('broken.js')) ?? null, 15_000);
    const railProblems = ((await markersIn(view(page), 'broken.js')) ?? []).length;
    check(`[${size}] Problems: a problem the page's language server finds is in the bottom's Problems (and the rail's)`, pageProblem && bottomProblem && problemRow && railProblems > 0,
      `bottom ${JSON.stringify(bottomProblem?.[0] ?? null)}; row "${problemRow ?? ''}"; rail ${railProblems}`);
    await shot(page, '7-problems');
    // A task's problem (its problem matcher's, the task in the bottom), on the page's file.
    await brokenEditor.locator('.view-lines').click();
    await command(page, editor(page), 'Tasks: Run Task');
    await pick(editor(page), 'lint');
    const fromTask = await until(async () => ((await markersIn(editor(page), 'app.js')) ?? []).find((marker) => marker.message.includes('e2e-problem')) ?? null, 30_000);
    const inRuntime = ((await markersIn(bottom(page), 'app.js')) ?? []).find((marker) => marker.message.includes('e2e-problem'));
    check(`[${size}] Problems: a task's problem (its problem matcher, the task in the bottom) is on the page's file`, fromTask && inRuntime && inRuntime.owner === 'e2e',
      `page ${JSON.stringify(fromTask)}; bottom ${JSON.stringify(inRuntime ?? null)}`);
    await rail.locator('.explorer-folders-view .monaco-list-row', { hasText: 'app.js' }).first().click();
    await ed.locator('.view-line').first().waitFor({ timeout: 30_000 });

    // ── Output: the page's and the rail's channels in the bottom's ──
    const labels = await until(async () => {
      const list = await outputsIn(bottom(page));
      return list?.includes('OpenChamber Bridge (page)') && list.includes('OpenChamber Bridge (rail)') ? list : null;
    }, 20_000);
    const pageLog = await until(async () => {
      const content = await outputText(bottom(page), 'OpenChamber Bridge (page)');
      return content?.includes('[editor] ready for') ? content : null;
    }, 20_000);
    check(`[${size}] Output: the page's and the rail's channels are in the bottom's Output, with what they wrote`, labels && pageLog,
      `${(labels ?? []).filter((label) => /\((page|rail)\)$/.test(label)).join(', ')}; the page's bridge: ${(pageLog ?? '').split('\n').length} lines`);
    await shot(page, '8-output');
    await runIn(bottom(page), 'workbench.action.terminal.focus');
    }

    // ── No terminal in the rail: the Explorer's "Open in Integrated Terminal", Ctrl+` and Run Task there ──
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const heapBefore = await heapOf(cdp);
    if ((await entry(page, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page, 'explorer').click();
    const bottomCount = (await listed()).length;
    await railMenu(page, rail.locator('.explorer-folders-view .monaco-list-row', { hasText: '.vscode' }).first(), /^Open in Integrated Terminal$/);
    const openedThere = await until(async () => (await listed()).length === bottomCount + 1, 20_000);
    // The new terminal takes the focus, as VS Code's does: then Ctrl+` from the rail, which focuses it again.
    await until(() => focusInBottom(page), 5_000);
    // VS Code focuses a new terminal again once its shell is up.
    await wait(3_000);
    await rail.locator('.explorer-folders-view .monaco-list-row', { hasText: 'app.js' }).first().click();
    await until(async () => !(await focusInBottom(page)), 5_000);
    await page.keyboard.press('Control+Backquote');
    const ctrlBackquote = await until(() => focusInBottom(page), 10_000);
    await wait(2_000);
    const taskRunsRail = runs('task');
    await rail.locator('.part.sidebar .composite.title').first().click();
    await command(page, rail, 'Tasks: Run Task');
    await pick(rail, 'note-task');
    const railTask = await until(() => runs('task') === taskRunsRail + 1, 20_000);
    await wait(5_000);
    const heapAfter = await heapOf(cdp);
    await cdp.detach().catch(() => undefined);
    const railNow = await diag(view(page));
    const railBus = watcher.bus.log.filter((item) => item.from === 'view' && ['run.command', 'task.run'].includes(item.type)).map((item) => item.command ?? item.type);
    check(`[${size}] no terminal in the rail: "Open in Integrated Terminal" from its Explorer, Ctrl+\` there and Run Task there run at the bottom; the rail makes no terminal, and the tab stays light`,
      openedThere && ctrlBackquote && railTask && railNow && railNow.terminals.length === 0 && !railNow.panel && heapAfter - heapBefore < 300,
      `bottom ${bottomCount} → ${(await listed()).length}; Ctrl+\` focused the bottom ${Boolean(ctrlBackquote)}; task ${runs('task') - taskRunsRail}×; rail terminals ${railNow?.terminals.length}; from the rail: ${railBus.slice(-4).join(', ')}; JS heap ${heapBefore} → ${heapAfter} MB`);
    await shot(page, '10-rail-terminals');

    // ── The panel's views: Ctrl+J, Ctrl+Shift+M and Ctrl+Shift+U in the page, Ctrl+Shift+M in the rail ──
    await seenParts(editor(page));
    await seenParts(view(page));
    await entry(page, 'terminal').click();
    const closedFirst = await until(async () => !(await bottomOpen(page)), 10_000);
    await focusPage();
    await page.keyboard.press('Control+j');
    const ctrlJ = await until(async () => (await bottomOpen(page)) && (await activePanel(bottom(page))) !== null, 45_000);
    await focusPage();
    await page.keyboard.press('Control+Shift+M');
    const problemsKey = await until(async () => (await activePanel(bottom(page))) === 'workbench.panel.markers', 15_000);
    // Output's key: Ctrl+K Ctrl+H on Linux (Ctrl+Shift+U elsewhere: on Ubuntu the system takes it).
    await focusPage();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+h');
    const outputKey = await until(async () => (await activePanel(bottom(page))) === 'workbench.panel.output', 15_000);
    await runIn(bottom(page), 'workbench.action.terminal.focus');
    await until(async () => (await activePanel(bottom(page))) === 'terminal', 5_000);
    await rail.locator('.explorer-folders-view .monaco-list-row', { hasText: 'app.js' }).first().click();
    await page.keyboard.press('Control+Shift+M');
    const railProblemsKey = await until(async () => (await activePanel(bottom(page))) === 'workbench.panel.markers', 15_000);
    const keysPage = await seenParts(editor(page));
    const keysRail = await seenParts(view(page));
    check(`[${size}] the panel's views from the page (Ctrl+J, Ctrl+Shift+M, Output's Ctrl+K Ctrl+H) and the rail (Ctrl+Shift+M) open the bottom on that view; never a panel in the page or the rail`,
      closedFirst && ctrlJ && problemsKey && outputKey && railProblemsKey && none(keysPage, 'panel') && none(keysRail, 'panel'),
      `bottom closed first ${Boolean(closedFirst)}; Ctrl+J ${Boolean(ctrlJ)}, Problems ${Boolean(problemsKey)}, Output ${Boolean(outputKey)}, Problems from the rail ${Boolean(railProblemsKey)}; page ${JSON.stringify(keysPage)}; rail ${JSON.stringify(keysRail)}`);
    await shot(page, '11-panel-keys');
    await runIn(bottom(page), 'workbench.action.terminal.focus');

    // ── A file the page shows, renamed in the rail (F2): the page's editor moves, with its unsaved text ──
    const frameLines = [];
    page.on('console', (message) => {
      if (/OpenChamber VS Code/.test(message.text())) frameLines.push(message.text().slice(0, 200));
    });
    const rowOf = (name) => rail.locator('.explorer-folders-view .monaco-list-row', { hasText: name }).first();
    await rowOf('rename-me.js').click();
    const renaming = editor(page).locator('.monaco-editor[data-uri$="rename-me.js"]').first();
    await renaming.locator('.view-line').first().waitFor({ timeout: 30_000 });
    // Unsaved for sure while it is renamed (no auto-save for it, in the page only, until the check is done).
    const held = await holdUnsaved(editor(page), ['rename-me.js', 'renamed.js']);
    await renaming.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// typed before the rename\n');
    const dirtyBefore = (await fileModelIn(editor(page), 'rename-me.js'))?.dirty;
    const savedBefore = readFileSync(join(project, 'rename-me.js'), 'utf8').includes('typed before');
    await railMenu(page, rowOf('rename-me.js'), /^Rename/);
    const nameBox = rail.locator('.explorer-folders-view .monaco-inputbox input').first();
    await nameBox.waitFor({ timeout: 10_000 });
    await nameBox.fill('renamed.js');
    await page.keyboard.press('Enter');
    const moved = await until(async () => {
      const active = await activeIn(editor(page));
      return active?.path?.endsWith('/renamed.js') && active.text?.includes('typed before') ? active : null;
    }, 15_000);
    await releaseUnsaved(editor(page));
    const renamedEditor = editor(page).locator('.monaco-editor[data-uri$="renamed.js"]').first();
    await renamedEditor.locator('.view-lines').click().catch(() => undefined);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// typed after the rename\n');
    await wait(4_000);
    const oldBack = existsSync(join(project, 'rename-me.js'));
    const renamedText = existsSync(join(project, 'renamed.js')) ? readFileSync(join(project, 'renamed.js'), 'utf8') : '';
    const headerTabs = (await page.locator('header [role="tab"]').allInnerTexts()).map((title) => title.trim());
    const route = decodeURIComponent(page.url());
    check(`[${size}] a file the page shows, renamed in the rail's Explorer: the page's editor moves to the new name with its unsaved text, its header tab and route follow, and nothing writes the old name`,
      dirtyBefore && moved && moved.dirty && moved.text?.includes('typed before') && !oldBack && renamedText.includes('typed before') && renamedText.includes('typed after')
        && headerTabs.some((title) => title.includes('renamed.js')) && !headerTabs.some((title) => title.includes('rename-me.js')) && route.includes('renamed.js'),
      `frame: ${frameLines.join(' / ')}; held unsaved ${held}; unsaved before ${dirtyBefore} (on disk ${savedBefore}); page on ${moved?.path?.split('/').pop() ?? 'the old name'} (unsaved ${moved?.dirty}); old name on disk again ${oldBack}; renamed.js has both edits ${renamedText.includes('typed before') && renamedText.includes('typed after')}; header ${headerTabs.filter((title) => /rename/.test(title)).join(' | ')}; route ${route.includes('renamed.js')}`);
    await shot(page, '12-renamed');
    // The same with the text unsaved for sure: renamed from the rail with no focus there (through the API, as an
    // extension or a refactoring would), the page's text unsaved meanwhile.
    await holdUnsaved(editor(page), ['renamed.js', 'renamed-again.js']);
    await renamedEditor.locator('.view-lines').click().catch(() => undefined);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// unsaved while renamed again\n');
    const unsavedThen = (await fileModelIn(editor(page), 'renamed.js'))?.dirty;
    await wait(2_500);
    const stillUnsaved = (await fileModelIn(editor(page), 'renamed.js'))?.dirty;
    frameLines.push(`unsaved 2.5 s later ${stillUnsaved}, on disk ${readFileSync(join(project, 'renamed.js'), 'utf8').includes('unsaved while renamed')}`);
    const renamedBy = await runWith(view(page), 'runtimeProbe.rename', ['renamed.js', 'renamed-again.js']);
    const movedAgain = await until(async () => {
      const active = await activeIn(editor(page));
      return active?.path?.endsWith('/renamed-again.js') && active.text?.includes('unsaved while renamed') ? active : null;
    }, 15_000);
    await wait(3_000);
    const againOld = existsSync(join(project, 'renamed.js'));
    const againDisk = existsSync(join(project, 'renamed-again.js')) ? readFileSync(join(project, 'renamed-again.js'), 'utf8') : '';
    await releaseUnsaved(editor(page));
    // Saved by the user: the new name gets it.
    await editor(page).locator('.monaco-editor[data-uri$="renamed-again.js"] .view-lines').first().click().catch(() => undefined);
    await page.keyboard.press('Control+s');
    const againSaved = await until(() => existsSync(join(project, 'renamed-again.js')) && readFileSync(join(project, 'renamed-again.js'), 'utf8').includes('unsaved while renamed'), 10_000);
    check(`[${size}] …renamed from the rail while the page has unsaved text in it: the page's editor moves with the text still unsaved, nothing writes the old name, and the new name gets the text once saved (Ctrl+S)`,
      unsavedThen && renamedBy === true && movedAgain && movedAgain.dirty && !againOld && !againDisk.includes('unsaved while renamed') && againSaved,
      `frame: ${frameLines.slice(3).join(' / ')}; unsaved ${unsavedThen}; renamed by the rail ${renamedBy}; page on ${movedAgain?.path?.split('/').pop() ?? 'the old name'} (unsaved ${movedAgain?.dirty}); old name on disk ${againOld}; on disk before a save ${againDisk.includes('unsaved while renamed')}; after auto-save ${Boolean(againSaved)}`);

    // ── A file the page shows, deleted in the rail: marked in the page, never written again; Ctrl+Z in the page brings it back ──
    await rowOf('delete-me.js').click();
    const deleting = editor(page).locator('.monaco-editor[data-uri$="delete-me.js"]').first();
    await deleting.locator('.view-line').first().waitFor({ timeout: 30_000 });
    await railMenu(page, rowOf('delete-me.js'), /^(Delete|Delete Permanently|Move to Trash)$/);
    const dialog = rail.locator('.monaco-dialog-box').first();
    if (await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await page.keyboard.press('Enter');
    const gone = await until(() => !existsSync(join(project, 'delete-me.js')), 10_000);
    await wait(4_000);
    const notBack = !existsSync(join(project, 'delete-me.js'));
    const deletedModel = await fileModelIn(editor(page), 'delete-me.js');
    await deleting.locator('.view-lines').click().catch(() => undefined);
    await page.keyboard.press('Control+z');
    // VS Code asks before it undoes a delete (in the part that ran it, the rail): the user's yes.
    const asked = await rail.locator('.monaco-dialog-box').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (asked) await rail.locator('.monaco-dialog-box .dialog-buttons .monaco-button', { hasText: /^Yes$/ }).first().click();
    const restored = await until(() => existsSync(join(project, 'delete-me.js')), 10_000);
    check(`[${size}] a file the page shows, deleted in the rail: the page's editor is marked deleted and never writes it again, and Ctrl+Z in the page undoes the delete (the rail's Undo)`,
      gone && notBack && deletedModel && !deletedModel.dirty && restored,
      `deleted ${Boolean(gone)}; written again ${!notBack}; page model ${JSON.stringify(deletedModel && { dirty: deletedModel.dirty, orphan: deletedModel.orphan })}; restored by Ctrl+Z in the page ${Boolean(restored)} (VS Code's confirmation in the rail ${asked})`);
    await shot(page, '13-deleted-undone');

    // ── Search's replace preview, from the rail, in the page ──
    if ((await entry(page, 'search').getAttribute('aria-pressed')) !== 'true') await entry(page, 'search').click();
    const searchView = rail.locator('.search-view').first();
    await searchView.waitFor({ timeout: 30_000 });
    const searchBox = rail.locator('.search-view .search-widget .search-container .monaco-inputbox textarea, .search-view .search-widget .search-container .monaco-inputbox input').first();
    const replaceBox = rail.locator('.search-view .search-widget .replace-container .monaco-inputbox textarea, .search-view .search-widget .replace-container .monaco-inputbox input').first();
    if (!(await replaceBox.isVisible().catch(() => false))) await rail.locator('.search-view .toggle-replace-button').first().click();
    await searchBox.fill('doubled');
    await replaceBox.fill('twice');
    const matchRow = rail.locator('.search-view .monaco-list-row', { hasText: 'twice' }).filter({ hasText: 'const' }).first();
    await matchRow.waitFor({ timeout: 20_000 });
    await matchRow.click();
    const preview = await until(async () => {
      const active = await activeIn(editor(page));
      return active?.type === 'workbench.editors.diffEditorInput' && active.text?.includes('const twice') ? active : null;
    }, 20_000);
    const firstPreview = (await activeIn(editor(page)))?.text?.split('\n')[3]?.trim() ?? null;
    await replaceBox.fill('thrice');
    const followedReplace = await until(async () => (await activeIn(editor(page)))?.text?.includes('const thrice'), 15_000);
    const failed = await editor(page).getByText('could not be opened').count();
    check(`[${size}] Search's replace preview from the rail opens in the page (its content the rail's), and follows the replacement typed there`, preview && followedReplace && failed === 0,
      `page shows ${preview ? 'the preview' : JSON.stringify((await activeIn(editor(page)))?.type ?? null)} ("${firstPreview}"); follows ${Boolean(followedReplace)}; errors ${failed}`);
    await shot(page, '14-replace-preview');
    await runIn(editor(page), 'workbench.action.closeActiveEditor');
    await replaceBox.fill('');
    await searchBox.fill('');

    // ── Source Control follows across parts: a stage in the page shows in the rail's, without the rail's focus ──
    if ((await entry(page, 'explorer').getAttribute('aria-pressed')) !== 'true') await entry(page, 'explorer').click();
    await rowOf('other.js').click();
    const otherEditor = editor(page).locator('.monaco-editor[data-uri$="other.js"]').first();
    await otherEditor.locator('.view-line').first().waitFor({ timeout: 30_000 });
    await otherEditor.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// changed in the page\n');
    await page.keyboard.press('Control+s');
    // The page's Git has the change (VS Code's own refresh, its window focused).
    const changedIn = (frame) => frame.locator('html').evaluate(() => {
      const instantiation = window.__runtimeInstantiation;
      const scm = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('scm')));
      const names = [];
      for (const repository of scm.repositories) for (const group of repository.provider.groups) if (group.id === 'workingTree') for (const resource of group.resources) names.push(resource.sourceUri.path.split('/').pop());
      return names;
    }).catch(() => null);
    let pageSawChange = await until(async () => (await changedIn(editor(page)))?.includes('other.js'), 10_000);
    // VS Code's Git refreshes after a file change once its window is idle and focused; the page's may not have yet.
    if (!pageSawChange) {
      await command(page, editor(page), 'Git: Refresh');
      pageSawChange = await until(async () => (await changedIn(editor(page)))?.includes('other.js'), 15_000);
    }
    await otherEditor.locator('.view-lines').click();
    await otherEditor.locator('.view-lines').click();
    const stageAt = Date.now();
    await command(page, editor(page), 'Git: Stage Changes');
    const stagedPage = await until(async () => (await stagedIn(editor(page)))?.includes('other.js'), 15_000);
    const stagedRail = await until(async () => (await stagedIn(view(page)))?.includes('other.js'), 20_000);
    measures[`${size}.stageToRail`] = Date.now() - stageAt;
    check(`[${size}] Source Control: a file staged in the page is staged in the rail's Source Control, with no focus on the rail`, stagedPage && stagedRail,
      `scm: page ${JSON.stringify(await scmDump(editor(page)))}, rail ${JSON.stringify(await scmDump(view(page)))}; the page's Git saw the change ${Boolean(pageSawChange)}; staged: page ${Boolean(stagedPage)}; rail ${Boolean(stagedRail)} in ${measures[`${size}.stageToRail`]} ms`);
    await command(page, editor(page), 'Git: Unstage Changes').catch(() => undefined);

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

/** A launch, a terminal and a task started before a window ever opened the bottom: each opens it, and runs there. */
const beforeBottom = async () => {
  const size = '1440x900';
  const viewport = { width: 1440, height: 900 };
  const zone = (page) => page.locator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]');
  let tasks = 0;
  const ways = [
    ['launch', 'a launch (F5 in the page)', 'debug.start', async (page, focusPage) => {
      await focusPage();
      await page.keyboard.press('F5');
    }, async (page) => (await sessionsOf(page)).runtime.length > 0 && (await diag(editor(page)))?.focused?.line === 3],
    ['terminal', "a terminal (Terminal: Create New Terminal in the page)", 'run.command', async (page, focusPage) => {
      await focusPage();
      await command(page, editor(page), 'Terminal: Create New Terminal');
    }, async (page) => ((await diag(bottom(page)))?.terminals.length ?? 0) > 0],
    ['task', "a task (Tasks: Run Task in the page)", 'task.run', async (page, focusPage) => {
      await focusPage();
      await command(page, editor(page), 'Tasks: Run Task');
      await pick(editor(page), 'note-task');
    }, async () => runs('task') > tasks],
  ];
  for (const [name, what, message, start, settled] of ways) {
    const context = await newWindow(viewport);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let watcher = null;
    try {
      const { focusPage } = await openParts(page, size, { terminal: false });
      watcher = watchBus(await windowKeyOf(editor(page)));
      await until(() => ['view', 'editor'].every((part) => watcher.bus.members.includes(part)), 60_000);
      const closed = (await zone(page).count()) === 0;
      tasks = runs('task');
      const at = Date.now();
      await start(page, focusPage);
      const routedNow = () => watcher.bus.log.some((item) => item.type === message && item.from === 'editor');
      const opened = await until(async () => (await zone(page).count()) > 0 && routedNow() && (await settled(page)), 90_000, 100);
      measures[`beforeBottom.${name}`] = Date.now() - at;
      const pageState = await diag(editor(page));
      const routed = watcher.bus.log.some((item) => item.type === message && item.from === 'editor');
      check(`[${size}] ${what}, before this window ever opened the bottom, opens it and runs there (the bottom opened by rail.open)`,
        closed && opened && routed && watcher.bus.members.includes('terminal') && pageState && pageState.terminals.length === 0 && !pageState.panel,
        `bottom closed at the start ${closed}; open and running in ${measures[`beforeBottom.${name}`]} ms; sent to the runtime ${routed}; page terminals ${pageState?.terminals.length}, panel ${pageState?.panel}`);
      await page.screenshot({ path: join(out, `${size}-9-before-bottom-${name}.png`) });
    } catch (error) {
      check(`[${size}] ${what} before the bottom ran to the end`, false, String(error.message ?? error).split('\n')[0]);
      await page.screenshot({ path: join(out, `${size}-9-before-bottom-${name}-error.png`) }).catch(() => undefined);
    } finally {
      await stopAll(page).catch(() => undefined);
      watcher?.close();
      await context.close();
    }
  }
};

// ── The server's extension hosts, and the bridge's sockets ──
const extHostPids = () => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
  .filter((line) => line.includes(`${work}/vscode-server/node`) && line.includes('--type=extensionHost')).map((line) => Number(line.trim().split(/\s+/)[0]));
const socketFiles = () => busDir().flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.sock')));
const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
const cpuTicksOf = (pid) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
};
const rssMbOf = (pid) => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
};

/** A window at rest: its extension hosts' memory and CPU (run on the old build too: the difference is the bridge's). */
const costs = async () => {
  const size = '1440x900';
  for (const pid of extHostPids()) {
    try {
      process.kill(pid);
    } catch {
      // Gone.
    }
  }
  await wait(3_000);
  const context = await newWindow({ width: 1440, height: 900 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await openParts(page, size);
    await wait(30_000);
    const pids = extHostPids();
    const ticks = () => pids.reduce((sum, pid) => sum + cpuTicksOf(pid), 0);
    const before = ticks();
    await wait(30_000);
    measures.costs = {
      extensionHosts: pids.length,
      rssMB: Math.round(pids.reduce((sum, pid) => sum + rssMbOf(pid), 0)),
      idleCpuPercent: Math.round(((ticks() - before) / clockTicks / 30) * 10_000) / 100,
      bridgeSockets: socketFiles().length,
    };
    console.log(`Costs, a window at rest: ${JSON.stringify(measures.costs)}`);
  } catch (error) {
    measures.costs = { error: String(error.message ?? error).split('\n')[0] };
  } finally {
    await context.close();
  }
};

/** Many reloads and windows: the bridge's sockets and the live window's bus stay one window's; VS Code's hosts, as they go. */
const bounds = async () => {
  const size = '1440x900';
  // The server's own word on each window that went: a client that said goodbye ("gracefully": its extension host
  // goes at once) or one that vanished ("will wait for reconnection": its extension host waits out the grace).
  const serverLog = () => readFileSync(join(work, 'vscode', 'vscode.log'), 'utf8');
  const logFrom = serverLog().length;
  const said = () => {
    const log = serverLog().slice(logFrom);
    return {
      graceful: (log.match(/\[ManagementConnection\] The client has disconnected gracefully/g) ?? []).length,
      vanished: (log.match(/\[ManagementConnection\] The client has disconnected, will wait for reconnection/g) ?? []).length,
      exited: (log.match(/Extension Host Process exited/g) ?? []).length,
    };
  };
  const snapshot = (at) => ({ at, extensionHosts: extHostPids().length, sockets: socketFiles().length });
  const trail = [snapshot('start')];
  const context = await newWindow({ width: 1440, height: 900 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  let members = null;
  try {
    for (let round = 1; round <= 6; round++) {
      await openParts(page, size);
      trail.push(snapshot(`load ${round}`));
    }
    for (let round = 1; round <= 4; round++) {
      const other = await newWindow({ width: 1440, height: 900 });
      const otherPage = await other.newPage();
      otherPage.setDefaultTimeout(30_000);
      await openParts(otherPage, size);
      await other.close();
      trail.push(snapshot(`window ${round} opened and closed`));
    }
    const watcher = watchBus(await windowKeyOf(editor(page)));
    await wait(25_000);
    members = [...watcher.bus.members].sort();
    watcher.close();
    trail.push(snapshot('settled'));
  } catch (error) {
    trail.push({ at: 'error', error: String(error.message ?? error).split('\n')[0] });
  } finally {
    await context.close();
  }
  await wait(25_000);
  trail.push(snapshot('closed'));
  measures.bounds = { trail, members, server: said() };
  const settled = trail.find((item) => item.at === 'settled');
  const closed = trail.at(-1);
  check(`[${size}] across 6 loads of a window and 4 windows opened and closed: the bridge keeps one socket per live window, the live window's bus has its three parts, and they go with it`,
    settled && settled.sockets <= 1 && members?.join(',') === 'editor,probe,terminal,view' && closed.sockets === 0,
    `${trail.map((item) => `${item.at}: ${item.extensionHosts ?? '?'} hosts, ${item.sockets ?? '?'} sockets`).join('; ')}; live bus ${members?.join(', ')}; server: ${JSON.stringify(measures.bounds.server)}`);
};

/** Testing, as it is across the parts (investigated, not built): where a run runs and shows, what Debug Test gets. */
const testing = async () => {
  const size = '1440x900';
  const context = await newWindow({ width: 1440, height: 900 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const results = (frame) => frame.locator('html').evaluate(() => {
    const instantiation = window.__runtimeInstantiation;
    if (!instantiation) return null;
    const service = instantiation.invokeFunction((accessor) => accessor.get(window.__ocVSCode.serviceIds.get('testResultService')));
    return service.results.map((result) => ({ passed: result.counts[1] ?? 0, total: Object.values(result.counts).reduce((a, b) => a + b, 0) }));
  }).catch(() => null);
  const observed = {};
  try {
    await openParts(page, size);
    await stopAll(page);
    const before = lines('test-').length;
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await command(page, view(page), 'Test: Run All Tests');
    await until(() => lines('test-run').length > 0 && lines('test-').length > before, 30_000);
    await wait(1_500);
    observed.runFromRail = { ranIn: lines('test-run').at(-1), results: { rail: await results(view(page)), page: await results(editor(page)), bottom: await results(bottom(page)) } };
    await view(page).locator('.part.sidebar .composite.title').first().click();
    await command(page, view(page), 'Test: Debug All Tests');
    await until(() => lines('test-debug').length > 0, 60_000);
    await wait(2_000);
    observed.debugFromRail = { ranIn: lines('test-debug').at(-1), sessions: Object.fromEntries(Object.entries(await sessionsOf(page)).map(([part, list]) => [part, list.length])) };
    await page.screenshot({ path: join(out, `${size}-15-testing.png`) });
  } catch (error) {
    observed.error = String(error.message ?? error).split('\n')[0];
  } finally {
    measures.testing = observed;
    console.log(`Testing, as it is: ${JSON.stringify(observed)}`);
    await stopAll(page).catch(() => undefined);
    await context.close();
  }
};

/** Two browser tabs on the folder: each is its own VS Code, with its own runtime, sessions and terminals. */
const twoTabs = async () => {
  const size = '1440x900';
  const viewport = { width: 1440, height: 900 };
  const one = await newWindow(viewport);
  const two = await newWindow(viewport);
  const first = await one.newPage();
  const second = await two.newPage();
  first.setDefaultTimeout(30_000);
  second.setDefaultTimeout(30_000);
  const watchers = [];
  let stage = 'opening the first tab';
  try {
    await openParts(first, size);
    stage = 'opening the second tab';
    const { focusPage: focusSecond } = await openParts(second, size);
    stage = "reading each tab's window";
    const [keyOne, keyTwo] = [await windowKeyOf(editor(first)), await windowKeyOf(editor(second))];
    const [busOne, busTwo] = [watchBus(keyOne), watchBus(keyTwo)];
    watchers.push(busOne, busTwo);
    stage = "each tab's parts joining their own bus";
    const joined = await until(() => [busOne, busTwo].every(({ bus }) => ['view', 'editor', 'terminal'].every((part) => bus.members.includes(part))), 120_000);
    stage = "the second tab's Run and Debug";
    if ((await entry(second, 'debug').getAttribute('aria-pressed')) !== 'true') await entry(second, 'debug').click();
    await view(second).locator('.debug-viewlet').first().waitFor({ timeout: 30_000 });
    stage = "a launch from the second tab's rail";
    await view(second).locator('.part.sidebar .composite.title').first().click();
    await command(second, view(second), 'Debug: Select and Start Debugging');
    await pick(view(second), 'app');
    const paused = await until(async () => (await diag(view(second)))?.focused?.line === 3, 60_000);
    await wait(1_500);
    const inOne = await sessionsOf(first);
    const inTwo = await sessionsOf(second);
    const crossed = busOne.bus.log.filter((item) => ['debug.start', 'session.started', 'dap.request'].includes(item.type)).length;
    check(`[${size}] two browser tabs on the folder: a launch from the second runs in the second's bottom, and the first tab shows none of it`,
      joined && keyOne !== keyTwo && paused && inTwo.runtime.length === 2 && inOne.runtime.length === 0 && inOne.rail.length === 0 && inOne.page.length === 0 && crossed === 0,
      `windows ${keyOne} / ${keyTwo}; first: runtime ${inOne.runtime.length}, rail ${inOne.rail.length}, page ${inOne.page.length}, its bus ${crossed} debug messages; second: runtime ${inTwo.runtime.length}, rail ${inTwo.rail.length}, page ${inTwo.page.length}`);
    await second.screenshot({ path: join(out, `${size}-6-second-tab.png`) });
    await stopAll(second);
    stage = "a terminal from the second tab's page";
    const before = [(await diag(bottom(first)))?.terminals.length ?? -1, (await diag(bottom(second)))?.terminals.length ?? -1];
    await focusSecond();
    await command(second, editor(second), 'Terminal: Create New Terminal');
    const grew = await until(async () => ((await diag(bottom(second)))?.terminals.length ?? 0) === before[1] + 1, 20_000);
    await wait(1_500);
    const firstAfter = (await diag(bottom(first)))?.terminals.length ?? -1;
    const commandsInOne = busOne.bus.log.filter((item) => item.type === 'run.command').length;
    check(`[${size}] two browser tabs: a terminal from the second tab's page is in the second's bottom, not the first's`, grew && firstAfter === before[0] && commandsInOne === 0,
      `first ${before[0]} → ${firstAfter}; second ${before[1]} → ${(await diag(bottom(second)))?.terminals.length}; run.command on the first's bus ${commandsInOne}`);
    await first.screenshot({ path: join(out, `${size}-6-first-tab.png`) });
  } catch (error) {
    check(`[${size}] two tabs ran to the end`, false, `${stage}: ${String(error.message ?? error).split('\n')[0]}`);
    await second.screenshot({ path: join(out, `${size}-6-error-second.png`) }).catch(() => undefined);
    await first.screenshot({ path: join(out, `${size}-6-error-first.png`) }).catch(() => undefined);
  } finally {
    await stopAll(second).catch(() => undefined);
    for (const watcher of watchers) watcher.close();
    await one.close();
    await two.close();
  }
};

try {
  for (const [index, width] of sizes.entries()) await journey(width === 1024 ? { width: 1024, height: 768 } : { width: 1440, height: 900 }, index === 0);
  if (process.env.RUNTIME_BEFORE_BOTTOM !== '0') await beforeBottom();
  if (process.env.RUNTIME_TESTING !== '0') await testing();
  if (process.env.RUNTIME_COSTS === '1') await costs();
  if (process.env.RUNTIME_BOUNDS === '1') await bounds();
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
  // RUNTIME_EXPECT=<a complete run's results.json> (the negative control): a check an earlier failure kept from
  // running fails too, as not reached.
  if (process.env.RUNTIME_EXPECT) {
    const seen = new Set(results.map((result) => result.label));
    for (const { label } of JSON.parse(readFileSync(process.env.RUNTIME_EXPECT, 'utf8')).results) {
      if (seen.has(label) || / ran to the end$/.test(label)) continue;
      results.push({ label, ok: false, detail: 'not reached' });
      console.log(`FAIL ${label} — not reached`);
    }
  }
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ results, measures }, null, 2)}\n`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
