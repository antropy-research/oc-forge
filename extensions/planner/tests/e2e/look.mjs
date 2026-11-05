// The Planner wears OpenChamber's look in every theme (review 13, P2; Qihang 2026-11-05: "参考openchamber原来的风格"),
// at 1440×900 and 1024×768, in the dev container's OpenChamber with this checkout's panel and a private copy of its
// service (harness.mjs; nothing else is written).
// - Its controls are OpenChamber's own: a button, the primary button, a text field, a picker and a menu draw as their
//   twins in OpenChamber's UI kit, whose look the host appends to the frame (`.oc-sdk-*`, read in the same frame), so
//   the Planner follows the app's look, theme by theme.
// - Its links take the host's accent text (`--oc-primary-text`), visited too, underlined on hover, and keyboard focus
//   draws the host's hover fill, not the browser's ring. Nothing else falls back to the browser's own look either: a
//   native button, field, select or check, the text selection, a focus ring. The browser's defaults are read in the
//   same frame and colour scheme, from a shadow root no stylesheet reaches; every view of the Planner is looked at, with
//   a task's details (a merged item's Open link) and the right-hand Sources panel, in OpenChamber's light and dark
//   themes, Nord and Flexoki.
// Run on the host after `bun run build`: node extensions/planner/tests/e2e/look.mjs [outDir]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from './harness.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-look-journey';
const THEMES = [['openchamber-light', 'light'], ['openchamber-dark', 'dark'], ['nord-dark', 'dark'], ['flexoki-light', 'light']];
const VIEWS = ['Home', 'Today', 'Calendar', 'Focus', 'Daily planning', 'Daily shutdown', 'Daily highlights', 'Weekly planning', 'Weekly review', 'Backlog', 'Linear', 'GitHub', 'Google', 'Agents', 'Archive', 'Stats', 'Settings'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * In the Planner's frame: what draws in the browser's own look. Its defaults come from elements in a shadow root, which
 * no stylesheet of the page reaches, in the frame's colour scheme. `focus`: keyboard focus on each button and link
 * (and check) too, looking for the browser's ring.
 */
const audit = ({ focus }) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
  document.body.append(box);
  const shadow = box.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<a href="https://example.com/">a</a><button>b</button><input><select><option>o</option></select><textarea></textarea><input type="checkbox">';
  const [a, button, input, select, textarea, checkbox] = [...shadow.children].map((element) => getComputedStyle(element));
  const ua = {
    link: a.color,
    button: `${button.backgroundColor}|${button.borderTopColor}`,
    input: `${input.backgroundColor}|${input.borderTopColor}`,
    select: `${select.backgroundColor}|${select.borderTopColor}`,
    textarea: `${textarea.backgroundColor}|${textarea.borderTopColor}`,
    accent: checkbox.accentColor,
  };
  box.remove();
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const name = (element) => `${element.tagName.toLowerCase()}${element.classList.length ? `.${[...element.classList].join('.')}` : ''} "${(element.getAttribute('aria-label') || element.textContent || element.value || '').trim().replace(/\s+/g, ' ').slice(0, 32)}"`;
  const found = [];
  // A control in the browser's background, or the browser's border, draws in its look (a field may set one of them).
  const native = (element, kind) => {
    const [background, border] = ua[kind].split('|');
    const style = getComputedStyle(element);
    const parts = [style.backgroundColor === background && 'background', style.borderTopStyle !== 'none' && style.borderTopWidth !== '0px' && style.borderTopColor === border && 'border'].filter(Boolean);
    if (parts.length) found.push(`native ${kind} ${parts.join('+')} ${name(element)}`);
  };
  for (const element of document.querySelectorAll('a[href], button, input, select, textarea')) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const type = element.getAttribute('type');
    if (element.matches('a[href]')) {
      if (style.color === ua.link) found.push(`link colour ${name(element)} ${style.color}`);
    } else if (element.matches('button')) native(element, 'button');
    else if (element.matches('input') && (type === 'checkbox' || type === 'radio')) {
      // A check the Planner draws itself (appearance: none) has no browser look; a native one must not keep its colour.
      if (style.appearance !== 'none' && style.accentColor === ua.accent) found.push(`native check colour ${name(element)}`);
    } else if (element.matches('input')) {
      if (!['range', 'color', 'hidden', 'file'].includes(type ?? '')) native(element, 'input');
    } else if (element.matches('select')) native(element, 'select');
    else if (element.matches('textarea')) native(element, 'textarea');
  }
  const selection = getComputedStyle(document.body, '::selection').backgroundColor;
  if (selection === 'rgba(0, 0, 0, 0)') found.push('text selection in the browser\'s colour');
  if (focus) {
    const before = document.activeElement;
    const focusable = [...document.querySelectorAll('a[href], button:not([disabled]), input[type="checkbox"], [role="tab"], [role="button"]')].filter(visible).slice(0, 60);
    for (const element of focusable) {
      element.focus({ focusVisible: true });
      if (document.activeElement === element && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'auto') found.push(`browser focus ring ${name(element)}`);
    }
    if (before instanceof HTMLElement) before.focus();
    else document.activeElement?.blur?.();
  }
  return [...new Set(found)];
};

/**
 * In the Planner's frame: its controls beside OpenChamber's own, the UI kit's twins as the host draws them (the look it
 * appends to every extension document), each pair's look properties where they differ. Both are probes the frame's
 * stylesheets draw: the kit's by their classes, the Planner's as any button, primary button, field, select and menu.
 */
const twins = () => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;';
  box.innerHTML = '<div class="oc-sdk"><button class="oc-sdk-btn" data-variant="outline">b</button><button class="oc-sdk-btn" data-variant="default">p</button><input class="oc-sdk-input"><button class="oc-sdk-trigger">t</button><div class="oc-sdk-popup">m</div></div>'
    + '<div><button>b</button><button class="primary">p</button><input><select><option>t</option></select><div class="menu">m</div></div>';
  document.body.append(box);
  const [kit, planner] = [...box.children].map((group) => [...group.children]);
  const look = ['background-color', 'color', 'border-top-left-radius', 'box-shadow'];
  const pairs = [
    ['a button (the outline button)', [...look, 'border-top-color']],
    ['the primary button', [...look, 'border-top-color']],
    ['a text field', look],
    ['a picker (the dropdown trigger)', [...look, 'border-top-color']],
    ['a menu (the popup)', [...look, 'border-top-color']],
  ];
  const differences = [];
  pairs.forEach(([what, properties], index) => {
    const [theirs, ours] = [getComputedStyle(kit[index]), getComputedStyle(planner[index])];
    for (const property of properties) {
      const [a, b] = [theirs.getPropertyValue(property), ours.getPropertyValue(property)];
      if (a !== b) differences.push(`${what} ${property}: OpenChamber ${a}, Planner ${b}`);
    }
  });
  box.remove();
  return differences;
};

/** The host's accent text, resolved in the frame, as an rgb() string. */
const token = () => {
  const probe = document.createElement('span');
  probe.style.color = 'var(--oc-primary-text, var(--oc-primary))';
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
};

/** The stylesheet the harness serves the Planner's frame: this checkout's. */
const CSS = readFileSync(new URL('../../panel/styles.css', import.meta.url), 'utf8');
/** The rules of it that colour links when visited: each in the host's accent text. */
const visitedRules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*:visited[^{}]*)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), accent: /color:\s*var\(--oc-primary-text, var\(--oc-primary\)\)/.test(body) }));

const h = await startHarness({ out, viewport: { width: 1440, height: 900 } });
const profile = mkdtempSync(join(tmpdir(), 'planner-look-visited-'));
const visitedBrowser = await createRequire(new URL('../../package.json', import.meta.url))('playwright-core').chromium.launchPersistentContext(profile, { channel: 'chromium' });
const { page, frame } = h;
try {
  await h.openPlanner();
  const today = (await h.call('GET', '/state')).json.today;
  let seq = 0;
  const commands = async (...bodies) => {
    const answer = await h.call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `harness-look-${Date.now().toString(36)}-${++seq}`, ...body })) });
    if (answer.status !== 200) throw new Error(`commands: ${answer.text}`);
  };
  // A task on today with a merged Linear issue (its details have an Open link) and a plain subtask.
  const source = { kind: 'linear', id: h.linearWorld.issues[0].id, key: h.linearWorld.issues[0].identifier, url: h.linearWorld.issues[0].url, title: h.linearWorld.issues[0].title, status: { name: 'Todo', type: 'unstarted', color: '#e2e2e2' } };
  await commands({ type: 'task.created', task: { id: 'harness-look-task', title: 'Harness look task', placement: { kind: 'day', date: today }, position: 1, notes: 'Some [notes](https://example.com/notes) to read', subtasks: [{ id: 'harness-look-sub', title: 'merged issue', done: false, source }, { id: 'harness-look-plain', title: 'plain step', done: false }] } });
  const go = async (name) => {
    const nav = frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
    if (!(await nav.isVisible().catch(() => false))) await frame.getByRole('button', { name: 'Planner menu' }).click();
    await nav.click();
  };
  const themeKey = await page.evaluate(() => Object.keys(localStorage).find((key) => key.startsWith('openchamber.theme.v2:')) ?? null);
  const setTheme = async (id, mode) => {
    const before = await frame.locator('body').evaluate(token);
    // Written from another page of the same origin, as a user's choice in another window reaches this one (storage event).
    const other = await h.context.newPage();
    await other.goto(`${new URL(page.url()).origin}/health`);
    await other.evaluate(([key, theme, scheme]) => localStorage.setItem(key, JSON.stringify({ themeMode: scheme, lightThemeId: scheme === 'light' ? theme : 'openchamber-light', darkThemeId: scheme === 'dark' ? theme : 'openchamber-dark' })), [themeKey, id, mode]);
    await other.close();
    for (let i = 0; i < 40 && (await frame.locator('body').evaluate(token)) === before; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
  };

  /**
   * A visited link as the Planner's stylesheet draws it, `accent` the theme's accent text. Chrome never tells a script
   * a :visited colour, and the Planner's links open through OpenChamber, so none is ever visited in its frame; nor does
   * a headless browser without a profile keep visited links. So: a browser with a profile of its own (Chromium's new
   * headless mode keeps them), a page with the Planner's stylesheet and the theme's accent, a link in it followed and
   * the page drawn again, its pixels read. A link in a shadow root, which no stylesheet reaches, shows the browser's own
   * visited colour: the visited state is real.
   */
  const visitedInk = async (accent) => {
    const p = await visitedBrowser.newPage();
    try {
      const html = `<!doctype html><style>:root { --oc-primary-text: ${accent}; } html, body { background: #fff; color: #000; } body { margin: 0; padding: 20px; font: 32px/1.3 sans-serif; }</style><style>${CSS}</style><p><a class="link" id="planner" href="http://visited.test/look">Visited link</a></p><p id="host"></p><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<a href="http://visited.test/look" style="font: 32px/1.3 sans-serif">Visited link</a>';</script>`;
      await p.route('http://look.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
      await p.route('http://visited.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>visited</p>' }));
      await p.goto('http://look.test/');
      await p.click('#planner');
      await p.waitForURL(/visited\.test/);
      await p.goBack();
      await p.waitForTimeout(600);
      /** The pixel farthest from the white page: the link's own colour (anti-aliasing only blends it toward the page). */
      const ink = async (locator) => p.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let best = [255, 255, 255];
        let far = -1;
        for (let i = 0; i < data.length; i += 4) {
          const distance = 765 - data[i] - data[i + 1] - data[i + 2];
          if (distance > far) [far, best] = [distance, [data[i], data[i + 1], data[i + 2]]];
        }
        return `rgb(${best.join(', ')})`;
      }, (await locator.screenshot()).toString('base64'));
      return { planner: await ink(p.locator('#planner')), browser: await ink(p.locator('#host')) };
    } finally {
      await p.close();
    }
  };
  const near = (a, b, within = 30) => {
    const [x, y] = [a, b].map((color) => color.match(/\d+/g).slice(0, 3).map(Number));
    return x.reduce((sum, value, index) => sum + Math.abs(value - y[index]), 0) <= within;
  };

  for (const size of [1440, 1024]) {
    await page.setViewportSize(size === 1440 ? { width: 1440, height: 900 } : { width: 1024, height: 768 });
    for (const [id, mode] of THEMES) {
      if (themeKey) await setTheme(id, mode);
      const accent = await frame.locator('body').evaluate(token);
      if (size === 1440) {
        const differences = await frame.locator('body').evaluate(twins);
        check(`${id}: a button, the primary button, a text field, a picker and a menu draw as OpenChamber's own (its UI kit's look, from the host)`, differences.length === 0, differences.join(' | '));
      }
      const fallbacks = [];
      // Every view.
      for (const view of VIEWS) {
        await go(view);
        await page.waitForTimeout(250);
        for (const item of await frame.locator('body').evaluate(audit, { focus: view === 'Home' || view === 'Settings' })) fallbacks.push(`${view}: ${item}`);
      }
      // A task's details: its notes' link, a merged item's Open link, Subtasks; and the Sources panel's Linear tab.
      await go('Home');
      await frame.locator('li.task-card', { hasText: 'Harness look task' }).first().getByRole('button', { name: /Open Harness look task/ }).click();
      const details = frame.getByRole('dialog', { name: 'Task details' });
      await details.waitFor();
      for (const item of await frame.locator('body').evaluate(audit, { focus: true })) fallbacks.push(`details: ${item}`);
      const open = details.getByRole('link', { name: `Open ${source.key} in Linear` });
      const openRest = await open.evaluate((element) => getComputedStyle(element).color);
      await details.getByRole('button', { name: 'Close' }).click();
      await frame.getByRole('navigation', { name: 'Sources' }).getByRole('tab', { name: 'Linear', exact: true }).click();
      const create = frame.getByRole('link', { name: 'Create a view in Linear', exact: true });
      await create.waitFor({ timeout: 15_000 });
      for (const item of await frame.locator('body').evaluate(audit, { focus: true })) fallbacks.push(`Sources panel: ${item}`);
      // The link's states: at rest, hovered, focused from the keyboard; visited takes the same rule as unvisited.
      const rest = await create.evaluate((element) => ({ color: getComputedStyle(element).color, decoration: getComputedStyle(element).textDecorationLine }));
      await create.hover();
      const hovered = await create.evaluate((element) => getComputedStyle(element).textDecorationLine);
      await frame.locator('h1').first().hover();
      const focused = await create.evaluate((element) => {
        element.focus({ focusVisible: true });
        const style = getComputedStyle(element);
        const result = { visible: element.matches(':focus-visible'), outline: style.outlineStyle, decoration: style.textDecorationLine, fill: style.backgroundImage };
        element.blur();
        return result;
      });
      // Visited: the stylesheet's rules for it, and a visited link drawn by it (`visitedInk`).
      const visited = { rules: visitedRules, ...(await visitedInk(accent)) };
      const sameRule = visitedRules.length > 0 && visitedRules.every((rule) => rule.accent) && near(visited.planner, accent) && near(visited.browser, 'rgb(85, 26, 139)', 60);
      await h.shot(`look-${id}-${size}`);
      check(
        `${size} px, ${id}: the Planner's links take the host's accent text (${accent}), at rest (Create a view in Linear, a merged item's Open), underlined on hover, keyboard focus as the host's fill with no browser ring, visited by the same rule`,
        rest.color === accent && openRest === accent && rest.decoration === 'none' && hovered.includes('underline') && focused.visible && focused.outline !== 'auto' && focused.fill !== 'none' && focused.decoration.includes('underline') && sameRule,
        JSON.stringify({ accent, rest, openRest, hovered, focused, visited }),
      );
      // Each finding once, with the first place it was seen.
      const seen = new Map();
      for (const item of fallbacks) {
        const [where, what] = [item.slice(0, item.indexOf(': ')), item.slice(item.indexOf(': ') + 2)];
        if (!seen.has(what)) seen.set(what, where);
      }
      check(`${size} px, ${id}: nothing in ${VIEWS.length} views, a task's details or the Sources panel falls back to the browser's own look`, fallbacks.length === 0, `${seen.size} found: ${[...seen].slice(0, 60).map(([what, where]) => `${what} (${where})`).join(' | ')}`);
    }
  }
  check('no page errors', h.problems.filter((problem) => problem.includes('pageerror')).length === 0, h.problems.filter((problem) => problem.includes('pageerror')).join(' | '));
} catch (error) {
  check('journey ran to the end', false, String(error).split('\n')[0]);
  await h.shot('99-look-error').catch(() => {});
} finally {
  await visitedBrowser.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  await h.close();
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
