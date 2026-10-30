// End-to-end check that VS Code in OpenChamber's own surfaces wears OpenChamber's theme (src/theme.ts,
// workbench/theme.ts), on the adapters' scratch stack, at 1440×900 and 1024×768, with the rail view (the Explorer),
// the page (a file's editor) and the terminal at the bottom all shown:
//   1. in OpenChamber's light theme, the pixels of the Explorer's background, a selected row in it, the editor's
//      background and the terminal's are the colors OpenChamber gave each frame (±2 per channel), every color the
//      mapping sets is in effect in each frame (VS Code's own CSS variables), and the code in the editor has
//      OpenChamber's code colors (made readable), the language server's highlighting included;
//   2. with an unsaved edit in the editor, OpenChamber switches to dark (its system mode, the OS turning dark), then
//      to another theme family (Nord, from another window of OpenChamber, as a theme picked there arrives), then to
//      Flexoki light: every frame follows at once, none reloads, the edit stays;
//   3. a theme picked in VS Code's own picker (Monokai) shows as its author made it, and picking the default again
//      brings OpenChamber's look back;
//   4. with "Follow OpenChamber's theme" off (the connection form), the frame shows VS Code's stock colors, and on
//      again OpenChamber's.
// Screenshots: <size>-<theme>.png per step; with a second out dir from another build (`THEME_BEFORE=<dir>`), the
// light and dark ones side by side (compare-<size>-<theme>.png, that build left, this one right).
//
//   export WORK=/tmp/opencode/vscode-theme/e2e STACK_PORT_BASE=35410
//   node tests/e2e/openchamber-adapters/stack.mjs prepare      # needs the network
//   node tests/e2e/openchamber-adapters/stack.mjs up
//   node extensions/vscode/tests/e2e/theme.mjs [outDir]
//   node tests/e2e/openchamber-adapters/stack.mjs down
//
// Run `up`, this and `down` in one private network namespace on a host whose interfaces change (see surfaces.mjs).
// The stack copies this checkout's extensions when it starts: build the extension first. Never prints the UI
// password or the VS Code token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { COLOR_RECIPES, DEFAULT_THEMES, parseColor, vscodeColors, vscodeTokenColors } = await import(join(here, '../../src/theme.ts'));
/** OpenChamber's built-in themes as it computes them for a frame (the unit tests' fixture). */
const { themes: BUILT_IN } = JSON.parse(readFileSync(join(here, '../fixtures/openchamber-themes.json'), 'utf8'));

const work = process.env.WORK ?? '/tmp/opencode/vscode-theme/e2e';
const out = process.argv[2] ?? '/tmp/opencode/vscode-theme/screens';
const before = process.env.THEME_BEFORE ?? null;
mkdirSync(out, { recursive: true });
const BASE = Number(process.env.STACK_PORT_BASE ?? 35410);
const base = `http://127.0.0.1:${BASE + 1}`;
const vscodeUrl = `http://127.0.0.1:${BASE + 2}`;
const { chromium } = await import(join(work, 'deps/node_modules/playwright-core/index.mjs'));
const secrets = readFileSync(join(work, 'secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)[1].trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)[1].trim();
const VSCODE = 'oc-forge-vscode';
const project = join(work, 'adapted/home/projects/demo');
const run = `theme-${Date.now().toString(36)}`;
const CHAT = 'Theme chat';
const FILE = 'theme-sample.ts';
// One of each kind of code OpenChamber colors.
const SAMPLE = `// a comment
export const answer: number = 42;
function greet(name: string): string {
  return name + "!";
}
`;

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
// Screenshots are read back as pixels in a page of their own.
const decoder = await browser.newPage();

/** The guests of the adapted OpenChamber: the VS Code extension installed, approved and alone. */
const installExtension = async () => {
  const catalog = await (await request.get(`${base}/api/guests`)).json();
  if (!catalog.guests.some((guest) => guest.id === VSCODE)) await request.post(`${base}/api/guests`, { data: { path: join(work, 'extensions', 'vscode') } });
  for (const guest of (await (await request.get(`${base}/api/guests`)).json()).guests) {
    const { requested, granted } = guest.capabilities;
    if (requested.length > 0 && !requested.every((capability) => granted.includes(capability))) await request.put(`${base}/api/guests/${guest.id}/capabilities`, { data: { granted: requested } });
    if (guest.id !== VSCODE && guest.enabled) await request.put(`${base}/api/guests/${guest.id}/enabled`, { data: { enabled: false } });
  }
};

// The demo project with the sample file and a chat, session tabs on, the extension.
const seed = async () => {
  const login = await request.post(`${base}/auth/session`, { data: { password } });
  if (login.status() !== 200) throw new Error(`login failed (${login.status()})`);
  writeFileSync(join(project, FILE), SAMPLE);
  const settings = await (await request.get(`${base}/api/config/settings`)).json();
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  const patch = { sessionTabsEnabled: true };
  if (!projects.some((entry) => entry.path === project)) patch.projects = [...projects, { id: 'demo', path: project, label: 'demo', addedAt: Date.now() }];
  await request.put(`${base}/api/config/settings`, { data: patch });
  const list = async () => {
    const listed = await (await request.get(`${base}/api/session?directory=${encodeURIComponent(project)}`, { timeout: 10_000 })).json();
    return Array.isArray(listed) ? listed : listed.data ?? [];
  };
  if (!(await list()).some((session) => session.title === CHAT)) await request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: { title: CHAT, location: { directory: project } } });
  await installExtension();
  return until(async () => (await list()).find((session) => session.title === CHAT)?.id ?? null, 120_000);
};

const entryButton = (page, entry) => page.locator(`[data-context-surface="plugin:${VSCODE}--${entry}"]`);
const viewFrame = (page) => page.frameLocator('[data-context-zone="right"] iframe[title="VS Code"]').first();
const bottomFrame = (page) => page.frameLocator('[data-context-zone="bottom"] iframe[src*="/workbench/index.html"]').first();
const pageFrame = (page) => page.frameLocator(`[data-oc-forge-page="${VSCODE}"] iframe`).first();
const headerTab = (page, title) => page.locator(`[data-oc-forge-tab^="${VSCODE}:"]`, { hasText: title }).first();
const tabDirty = async (page, title) => Boolean(await headerTab(page, title).locator('[data-oc-forge-dirty]').count());
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const runCommand = async (page, frame, title) => {
  await page.keyboard.press('Control+Shift+p');
  await frame.locator('.quick-input-widget input').waitFor({ timeout: 10_000 });
  await page.keyboard.type(title);
  const label = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await frame.locator('.quick-input-list .monaco-list-row').filter({ has: frame.locator('.label-name', { hasText: label }) }).first().click({ timeout: 10_000 });
};

// Colors ------------------------------------------------------------------------------------------------------------

/** The tokens OpenChamber gave a frame, as the SDK paints them on its root (`applyHostTheme`). */
const TOKEN_VARS = {
  background: '--oc-bg', elevated: '--oc-elevated', foreground: '--oc-fg', muted: '--oc-muted', subtle: '--oc-subtle', border: '--oc-border',
  hover: '--oc-hover', selection: '--oc-selection', focus: '--oc-focus', primary: '--oc-primary', mutedSurface: '--oc-muted-surface',
  elevatedForeground: '--oc-elevated-fg', active: '--oc-active', selectionForeground: '--oc-selection-fg', primaryForeground: '--oc-primary-fg',
  primaryText: '--oc-primary-text', successText: '--oc-success-text', warningText: '--oc-warning-text', errorText: '--oc-error-text', infoText: '--oc-info-text',
  success: '--oc-success', warning: '--oc-warning', error: '--oc-error', info: '--oc-info', font: '--oc-font', mono: '--oc-mono', radius: '--oc-radius',
  syntaxKeyword: '--oc-syntax-keyword', syntaxString: '--oc-syntax-string', syntaxNumber: '--oc-syntax-number', syntaxFunction: '--oc-syntax-function',
  syntaxType: '--oc-syntax-type', syntaxComment: '--oc-syntax-comment', syntaxVariable: '--oc-syntax-variable', syntaxOperator: '--oc-syntax-operator',
};
const tokensOf = (frame) => frame.locator('html').evaluate((root, vars) => {
  const style = getComputedStyle(root);
  const tokens = {};
  for (const [name, variable] of Object.entries(vars)) {
    const value = style.getPropertyValue(variable).trim();
    if (value) tokens[name] = value;
  }
  return { tokens, mode: root.dataset.ocTheme };
}, TOKEN_VARS);

/** A CSS color VS Code or the browser writes (hex, rgb(), rgba()) as channels, alpha 0–255. */
const channels = (value) => {
  const color = parseColor(String(value ?? ''));
  return color ? [color.r, color.g, color.b, color.a * 255] : null;
};
/** Channels within `tolerance`; alpha within 2/255 more, as VS Code writes it with two decimals (`rgba(…, 0.38)`). */
const close = (a, b, tolerance = 2) => Boolean(a && b) && a.every((value, index) => Math.abs(value - b[index]) <= tolerance + (index === 3 ? 2 : 0));
const show = (c) => (c ? `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : 'none');
/** `front` over the opaque `back`. */
const overOpaque = (front, back) => [0, 1, 2].map((i) => front[i] * (front[3] / 255) + back[i] * (1 - front[3] / 255)).concat(255);

/** The pixel at (x, y) of the page as it shows (the median of the 3×3 around it). */
const pixel = async (page, x, y) => {
  const png = await page.screenshot({ clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 3, height: 3 } });
  return decoder.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const median = (offset) => [...Array(data.length / 4).keys()].map((index) => data[index * 4 + offset]).sort((a, b) => a - b)[Math.floor(data.length / 8)];
    return [median(0), median(1), median(2), 255];
  }, png.toString('base64'));
};

/** Where to sample each surface, in page coordinates: an empty spot of it. */
const spots = async (page) => {
  const box = (locator) => locator.first().boundingBox({ timeout: 5_000 }).catch(() => null);
  const sidebar = await box(viewFrame(page).locator('.explorer-folders-view'));
  const row = await box(viewFrame(page).locator('.explorer-folders-view .monaco-list-row.selected'));
  const editor = await box(pageFrame(page).locator('.part.editor .monaco-editor .overflow-guard'));
  const terminal = await box(bottomFrame(page).locator('.xterm:visible .xterm-screen'));
  return {
    explorer: sidebar && { x: sidebar.x + sidebar.width - 14, y: sidebar.y + sidebar.height - 14 },
    selectedRow: row && { x: row.x + row.width * 0.7, y: row.y + row.height / 2 },
    editor: editor && { x: editor.x + editor.width * 0.5, y: editor.y + editor.height - 24 },
    terminal: terminal && { x: terminal.x + terminal.width - 12, y: terminal.y + terminal.height - 8 },
  };
};

/** VS Code's own CSS variables for colors, on a frame's workbench: key → value. */
const vscodeVars = (frame, keys) => frame.locator('.monaco-workbench').first().evaluate((workbench, names) => {
  const style = getComputedStyle(workbench);
  return Object.fromEntries(names.map((key) => [key, style.getPropertyValue(`--vscode-${key.replace(/\./g, '-')}`).trim()]));
}, keys);

/** Each of the mapping's colors as VS Code shows it in a frame, against what the frame's tokens make of it. */
const colorsInEffect = async (frame) => {
  const { tokens } = await tokensOf(frame);
  const expected = vscodeColors(tokens);
  const actual = await vscodeVars(frame, Object.keys(expected));
  const off = Object.keys(expected).filter((key) => !close(channels(actual[key]), channels(expected[key]), 1));
  return { count: Object.keys(expected).length, off: off.map((key) => `${key}: ${actual[key] || 'unset'} (want ${expected[key]})`), tokens };
};

const FRAMES = { view: viewFrame, page: pageFrame, terminal: bottomFrame };

/** Whether a frame has OpenChamber's theme `id` (its colors as OpenChamber computes them) and shows its look. */
const frameSettled = async (page, name, id) => {
  const theme = BUILT_IN[id];
  const mode = theme.mode;
  const frame = FRAMES[name](page);
  const { tokens, mode: frameMode } = await tokensOf(frame);
  if (frameMode !== mode || !close(channels(tokens.primary), channels(theme.tokens.primary), 1)) return false;
  const want = vscodeColors(tokens);
  const vars = await vscodeVars(frame, ['editor.background', 'sideBar.background', 'list.activeSelectionBackground']);
  const kind = await frame.locator('.monaco-workbench').first().evaluate((workbench) => (workbench.classList.contains('vs-dark') ? 'dark' : workbench.classList.contains('vs') ? 'light' : 'other'));
  return kind === mode && ['editor.background', 'sideBar.background', 'list.activeSelectionBackground'].every((key) => close(channels(vars[key]), channels(want[key]), 1));
};
const settled = (page, id, timeout = 30_000) => until(async () => (await Promise.all(Object.keys(FRAMES).map((name) => frameSettled(page, name, id)))).every(Boolean), timeout);

/** Whether a frame's tokens are OpenChamber's own for the theme: every color the same, the surface a page's or a docked panel's. */
const tokensAreTheme = (tokens, id) => {
  const theme = BUILT_IN[id];
  return Object.entries(theme.tokens).every(([name, value]) => {
    if (['font', 'mono', 'radius'].includes(name)) return true;
    const accepted = name in theme.docked ? [value, theme.docked[name]] : [value];
    return accepted.some((candidate) => close(channels(tokens[name]), channels(candidate), 1));
  });
};

/**
 * The checks of OpenChamber's look in all three frames: the surfaces' pixels against the tokens each frame got,
 * every mapped color in effect, the code colors in the editor.
 */
const checkLook = async (page, size, label, id) => {
  const mode = BUILT_IN[id].mode;
  const ok = await settled(page, id);
  check(`[${size}] ${label}: every frame shows VS Code's ${DEFAULT_THEMES[mode]} with OpenChamber's colors`, ok);
  const at = await spots(page);
  const { tokens: viewTokens } = await tokensOf(viewFrame(page));
  const { tokens: pageTokens } = await tokensOf(pageFrame(page));
  const { tokens: bottomTokens } = await tokensOf(bottomFrame(page));
  check(`[${size}] ${label}: each frame got OpenChamber's own tokens for ${id}`, [viewTokens, pageTokens, bottomTokens].every((tokens) => tokensAreTheme(tokens, id)),
    `backgrounds ${[viewTokens, pageTokens, bottomTokens].map((tokens) => tokens.background).join(' ')}`);
  const samples = [
    ['the Explorer\'s background', at.explorer, channels(viewTokens.background)],
    ['a selected row in the Explorer', at.selectedRow, channels(viewTokens.selection) && overOpaque(channels(viewTokens.selection), channels(viewTokens.background))],
    ['the editor\'s background', at.editor, channels(pageTokens.background)],
    ['the terminal\'s background', at.terminal, channels(bottomTokens.background)],
  ];
  for (const [what, spot, want] of samples) {
    const got = spot ? await pixel(page, spot.x, spot.y) : null;
    check(`[${size}] ${label}: ${what} is OpenChamber's color (±2)`, close(got, want), `pixel ${show(got)}, token ${show(want)}`);
  }
  for (const [name, frame] of Object.entries(FRAMES)) {
    const { count, off } = await colorsInEffect(frame(page));
    check(`[${size}] ${label}: all ${count} colors of the mapping are in effect in the ${name} frame`, off.length === 0, off.slice(0, 6).join('; '));
  }
  // The code's colors: one span of each kind, as VS Code painted it.
  const rules = vscodeTokenColors(pageTokens)?.textMateRules ?? [];
  const want = (kind) => channels(rules.find((rule) => rule.name === `OpenChamber ${kind}`)?.settings.foreground);
  const editor = pageFrame(page).locator(`.monaco-editor[data-uri$="${FILE}"]`).first();
  const spanColor = (text) => editor.locator('.view-lines span span', { hasText: text instanceof RegExp ? text : new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().evaluate((span) => getComputedStyle(span).color).catch(() => null);
  // VS Code writes a line's spaces as no-break spaces.
  const kinds = [[/a\scomment$/, 'comment'], ['export', 'keyword'], ['function', 'keyword'], ['answer', 'variable'], ['42', 'number'], ['greet', 'function'], ['"!"', 'string'], ['number', 'type'], ['+', 'operator']];
  const wrong = [];
  for (const [text, kind] of kinds) {
    const got = channels(await spanColor(text));
    if (!close(got, want(kind), 1)) wrong.push(`${text} ${show(got)} (want ${kind} ${show(want(kind))})`);
  }
  check(`[${size}] ${label}: the code in the editor has OpenChamber's code colors (comment, keyword, variable, number, function, string, type, operator)`, wrong.length === 0, wrong.join('; '));
};

/** OpenChamber's theme preferences from another of its windows (its `storage` event), as a theme picked there arrives. */
const setOpenChamberTheme = async (context, page, preferences) => {
  const key = await page.evaluate(() => Object.keys(localStorage).find((name) => name.startsWith('openchamber.theme.v2:')));
  const other = await context.newPage();
  await other.goto(`${base}/health`);
  await other.evaluate(([name, value]) => localStorage.setItem(name, value), [key, JSON.stringify(preferences)]);
  await other.close();
  return key;
};

/** Marks each frame's window, to tell a reload (the mark gone) from a frame that followed in place. */
const markFrames = (page) => Promise.all(Object.values(FRAMES).map((frame) => frame(page).locator('html').evaluate((root, mark) => {
  window.__themeMark = mark;
}, run)));
/** Which frames reloaded since `markFrames`: none, or their names. */
const framesReloaded = async (page) => (await Promise.all(Object.entries(FRAMES).map(async ([name, frame]) => ((await frame(page).locator('html').evaluate(() => window.__themeMark).catch(() => null)) === run ? null : name)))).filter(Boolean);

const journey = async (viewport, chat, first) => {
  const size = `${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.request.post(`${base}/auth/session`, { data: { password } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/?session=${chat}`);
    await until(async () => (await entryButton(page, 'explorer').count()) > 0, 60_000);
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
    await view.locator('.monaco-workbench').waitFor({ timeout: 240_000 });
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: FILE }).first().waitFor({ timeout: 90_000 });
    /** "Follow OpenChamber's theme" on or off, in the connection form (an older build calls it "Start in OpenChamber's light or dark look"). */
    const toggleFollow = async (on) => {
      await view.locator('.part.sidebar').first().click();
      await runCommand(page, view, 'OpenChamber: VS Code Server Connection…');
      const box = view.getByRole('checkbox', { name: /Follow OpenChamber's theme|light or dark look/ });
      await box.waitFor({ timeout: 60_000 });
      if ((await box.isChecked()) !== on) await box.click();
      await view.getByRole('button', { name: 'Connect' }).click();
      await view.locator('.explorer-folders-view .monaco-list-row', { hasText: FILE }).first().waitFor({ timeout: 120_000 });
    };
    // A run that stopped half way may have left it off.
    if (!(await until(() => frameSettled(page, 'view', 'openchamber-light'), 20_000))) {
      console.log('(following was off: on again)');
      await toggleFollow(true);
    }
    await view.locator('.explorer-folders-view .monaco-list-row', { hasText: FILE }).first().click();
    const editor = pageFrame(page).locator(`.monaco-editor[data-uri$="${FILE}"]`).first();
    await until(async () => editor.locator('.view-line').first().isVisible(), 180_000);
    await entryButton(page, 'terminal').click();
    const xterm = bottomFrame(page).locator('.xterm:visible').first();
    if (!(await xterm.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false))) {
      await bottomFrame(page).locator('.part.panel .action-label[aria-label^="New Terminal"]').first().click();
      await xterm.waitFor({ timeout: 60_000 });
    }
    // The language server's semantic highlighting comes a few seconds after the file opens.
    await wait(12_000);

    // ── 1. OpenChamber's light theme ──
    await checkLook(page, size, '1 OpenChamber light', 'openchamber-light');
    await shot(page, `${size}-openchamber-light`);

    // An unsaved edit (VS Code for the web saves a second after an edit by default: off for this).
    const mark = `${run}-${viewport.width}`;
    // VS Code for the web saves a second after an edit by default: off for this (toggled again if an earlier run left it off).
    let dirty = false;
    for (let attempt = 0; attempt < 2 && !dirty; attempt++) {
      await editor.locator('.view-line').first().click();
      await runCommand(page, pageFrame(page), 'File: Toggle Auto Save');
      await wait(800);
      await editor.locator('.view-line').first().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(attempt === 0 ? `// ${mark}` : ' ');
      await wait(2_500);
      dirty = await tabDirty(page, FILE);
    }
    check(`[${size}] 2 an unsaved edit in the editor`, dirty);
    await markFrames(page);
    /** The frames followed in place and the edit is still there, unsaved: '' when so, else what is not. */
    const inPlace = async () => {
      const reloaded = await framesReloaded(page);
      const text = (await editor.locator('.view-lines').innerText()).replace(/\u00a0/g, ' ').includes(mark);
      const unsaved = await tabDirty(page, FILE);
      return [reloaded.length ? `reloaded: ${reloaded.join(', ')}` : '', text ? '' : 'the edit is gone', unsaved ? '' : 'the file is not dirty'].filter(Boolean).join('; ');
    };

    // ── 2. Dark, as OpenChamber follows the system ──
    await page.emulateMedia({ colorScheme: 'dark' });
    await checkLook(page, size, '2 OpenChamber dark (its system mode)', 'openchamber-dark');
    const darkKept = await inPlace();
    check(`[${size}] 2 dark: every frame followed in place, none reloaded, and the edit is still there, unsaved`, darkKept === '', darkKept);
    await shot(page, `${size}-openchamber-dark`);

    // ── 2. Another theme family, from another OpenChamber window ──
    await setOpenChamberTheme(context, page, { themeMode: 'dark', lightThemeId: 'openchamber-light', darkThemeId: 'nord-dark' });
    await checkLook(page, size, '2 Nord dark (another family)', 'nord-dark');
    const nordKept = await inPlace();
    check(`[${size}] 2 Nord: every frame followed in place, the edit still there, unsaved`, nordKept === '', nordKept);
    await shot(page, `${size}-nord-dark`);

    // ── 3. A theme picked in VS Code's own picker shows as its author made it ──
    await editor.locator('.view-line').first().click();
    const pickTheme = async (name) => {
      await runCommand(page, pageFrame(page), 'Preferences: Color Theme');
      await page.keyboard.type(name);
      const row = pageFrame(page).locator('.quick-input-list .monaco-list-row').filter({ has: pageFrame(page).locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first();
      await row.click({ timeout: 10_000 });
    };
    await pickTheme('Monokai');
    const monokai = JSON.parse(readFileSync(join(work, 'vscode-server/extensions/theme-monokai/themes/monokai-color-theme.json'), 'utf8')).colors;
    const ownKeys = Object.keys(monokai).filter((key) => key in COLOR_RECIPES);
    const untouched = await until(async () => {
      const vars = await vscodeVars(pageFrame(page), ownKeys);
      return ownKeys.every((key) => close(channels(vars[key]), channels(monokai[key]), 1)) ? vars : null;
    }, 20_000);
    const editorSpot = (await spots(page)).editor;
    const monokaiPixel = await pixel(page, editorSpot.x, editorSpot.y);
    check(`[${size}] 3 Monokai picked in VS Code's picker: its ${ownKeys.length} colors that the mapping also sets are Monokai's own, and its editor is Monokai's`,
      untouched && close(monokaiPixel, channels(monokai['editor.background'])), `editor pixel ${show(monokaiPixel)}, Monokai ${monokai['editor.background']}`);
    await shot(page, `${size}-monokai-picked`);
    await pickTheme(DEFAULT_THEMES.dark);
    check(`[${size}] 3 ${DEFAULT_THEMES.dark} picked again: OpenChamber's look is back`, await settled(page, 'nord-dark'));

    // ── 2. Flexoki light: family and mode ──
    await setOpenChamberTheme(context, page, { themeMode: 'light', lightThemeId: 'flexoki-light', darkThemeId: 'nord-dark' });
    await checkLook(page, size, '2 Flexoki light (another family, light)', 'flexoki-light');
    const flexokiKept = await inPlace();
    check(`[${size}] 2 Flexoki: every frame followed in place, the edit still there, unsaved`, flexokiKept === '', flexokiKept);
    await shot(page, `${size}-flexoki-light`);

    // ── 4. "Follow OpenChamber's theme" off: VS Code's own colors ──
    await toggleFollow(false);
    // VS Code's own theme: its default (or one a user of these settings picked with following off, which is theirs).
    const stockOf = async () => {
      const dark = await view.locator('.monaco-workbench').first().evaluate((workbench) => workbench.classList.contains('vs-dark')).catch(() => false);
      const name = dark ? DEFAULT_THEMES.dark : DEFAULT_THEMES.light;
      return { name, colors: JSON.parse(readFileSync(join(work, `vscode-server/extensions/theme-defaults/themes/2026-${dark ? 'dark' : 'light'}.json`), 'utf8')).colors };
    };
    const stockKeys = ['sideBar.background', 'sideBar.foreground', 'list.hoverBackground', 'focusBorder'];
    const plain = await until(async () => {
      const { name, colors } = await stockOf();
      const vars = await vscodeVars(view, stockKeys);
      return stockKeys.every((key) => close(channels(vars[key]), channels(colors[key]), 1)) ? { name, colors } : null;
    }, 30_000);
    const explorerSpot = (await spots(page)).explorer;
    const plainPixel = explorerSpot ? await pixel(page, explorerSpot.x, explorerSpot.y) : null;
    check(`[${size}] 4 "Follow OpenChamber's theme" off: the Explorer shows VS Code's own ${plain?.name ?? 'default theme'}, OpenChamber's colors gone`, plain && close(plainPixel, channels(plain.colors['sideBar.background'])),
      `explorer pixel ${show(plainPixel)}, ${plain?.name} ${plain?.colors['sideBar.background']}`);
    await shot(page, `${size}-follow-off`);
    await toggleFollow(true);
    check(`[${size}] 4 on again: OpenChamber's look is back`, await until(() => frameSettled(page, 'view', 'flexoki-light'), 30_000));

    // For the eye: the same file in OpenChamber's own Files view (the rail panel) beside VS Code's editor (the page).
    try {
      await page.locator('button[data-context-surface][aria-label="Files"]').first().click({ timeout: 5_000 });
      const zone = page.locator('[data-context-zone="right"]');
      await zone.getByText(FILE, { exact: true }).first().click({ timeout: 10_000 });
      await zone.locator('.cm-editor').first().waitFor({ timeout: 15_000 });
      await wait(1_000);
      await shot(page, `${size}-files-view-beside-vscode`);
    } catch (error) {
      console.log(`(no Files view screenshot: ${String(error?.message ?? error).split('\n')[0]}; rail ${(await page.$$eval('[data-context-surface]', (buttons) => buttons.map((button) => `${button.getAttribute('data-context-surface')}=${button.getAttribute('aria-label')}`))).join(' ')})`);
    }

    // The edit undone and VS Code's saving after an edit back on, for the next run.
    await editor.locator('.view-line').first().click();
    await runCommand(page, pageFrame(page), 'File: Revert File');
    await until(async () => !(await tabDirty(page, FILE)), 10_000);
    await runCommand(page, pageFrame(page), 'File: Toggle Auto Save');
    await wait(800);
    check(`[${size}] no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    // The next run starts as a fresh install would: OpenChamber in its system mode, the edit undone.
    await setOpenChamberTheme(context, page, { themeMode: 'system', lightThemeId: 'openchamber-light', darkThemeId: 'openchamber-dark' }).catch(() => undefined);
    await context.close();
    writeFileSync(join(project, FILE), SAMPLE);
  }
};

/** That build's screenshot (left) and this one's (right), side by side. */
const compare = async (name) => {
  const left = join(before, `${name}.png`);
  const right = join(out, `${name}.png`);
  if (!existsSync(left) || !existsSync(right)) return;
  const joined = await decoder.evaluate(async ([a, b]) => {
    const load = async (base64) => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const [x, y] = [await load(a), await load(b)];
    const gap = 16;
    const canvas = new OffscreenCanvas(x.width + gap + y.width, Math.max(x.height, y.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#808080';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(x, 0, 0);
    context.drawImage(y, x.width + gap, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, [readFileSync(left).toString('base64'), readFileSync(right).toString('base64')]);
  writeFileSync(join(out, `compare-${name}.png`), Buffer.from(joined, 'base64'));
};

try {
  const chat = await seed();
  await journey({ width: 1440, height: 900 }, chat, true);
  await journey({ width: 1024, height: 768 }, chat, false);
  if (before) for (const size of ['1440x900', '1024x768']) for (const theme of ['openchamber-light', 'openchamber-dark']) await compare(`${size}-${theme}`);
} catch (error) {
  check('the check ran to its end', false, error?.stack ?? String(error));
} finally {
  await browser.close();
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} checks passed (VS Code ${JSON.parse(readFileSync(join(work, 'vscode-server/package.json'), 'utf8')).version}); screenshots in ${out}`);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
