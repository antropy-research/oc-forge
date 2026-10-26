// End-to-end check of the VS Code extension in the dev OpenChamber (OpenChamber
// and the VS Code Server in containers/openchamber-dev, this extension installed).
// Run on the host: node extensions/vscode/tests/e2e/run.mjs [baseUrl] [outDir]
// Uses this package's playwright-core with the Chromium in ~/.cache/ms-playwright.
// The UI password and the VS Code token are read from the dev container's secrets
// file and never printed. A scratch file in the demo project and the extension's
// settings are put back as they were.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:35310';
const out = process.argv[3] ?? '/tmp/opencode/vscode-e2e';
mkdirSync(out, { recursive: true });
const secrets = readFileSync(join(homedir(), '.local/share/oc-forge-openchamber-dev/secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)?.[1]?.trim();
const token = /^VSCODE_CONNECTION_TOKEN=(.+)$/m.exec(secrets)?.[1]?.trim();
if (!password || !token) throw new Error('secrets.env needs OPENCHAMBER_UI_PASSWORD and VSCODE_CONNECTION_TOKEN');
const server = base.replace(/:\d+$/, ':35311');
// The demo project is OpenChamber's active workspace in the dev container; files outside it are not written.
const project = '/home/node/projects/planner-demo-a';
const file = `${project}/vscode-e2e-${Date.now().toString(36)}.ts`;
const name = file.slice(project.length + 1);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const docker = (...args) => execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', ...args], { encoding: 'utf8' });

docker('sh', '-c', `cat > ${file} <<'EOF'\n// A file for the VS Code editor check.\nexport const answer = 42;\nfunction greet(name: string): string {\n  return \`Hello, \${name}\`;\n}\nEOF`);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const storage = (body) => context.request.post(`${base}/api/guests/oc-forge-vscode/storage`, { data: body });
let saved;
let session = null;
const problems = [];
try {
  check('login', (await context.request.post(`${base}/auth/session`, { data: { password } })).status() === 200);
  const guests = await (await context.request.get(`${base}/api/guests`)).json();
  const guest = (Array.isArray(guests) ? guests : guests.guests ?? []).find((item) => item.id === 'oc-forge-vscode');
  check('the extension is installed and enabled, asking for no capabilities', Boolean(guest?.enabled) && guest.capabilities?.requested?.length === 0);
  saved = await (await storage({ op: 'get', key: 'settings' })).json();
  await storage({ op: 'delete', key: 'settings' });
  session = (await (await context.request.post(`${base}/api/session?directory=${encodeURIComponent(project)}`, { data: {} })).json()).id;
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.location().url?.includes('/editor/')) problems.push(`console: ${message.text()}`);
  });

  // The Files view: open the scratch file; VS Code's editor takes it.
  await page.goto(`${base}/?session=${session}`, { waitUntil: 'load' });
  await page.locator('button[aria-label="Files"]').first().click();
  for (const folder of ['projects', 'planner-demo-a']) {
    const node = page.getByText(folder, { exact: true }).last();
    if (await node.isVisible().catch(() => false)) {
      await node.click();
      await page.waitForTimeout(1000);
    }
  }
  await page.getByText(name, { exact: true }).first().click({ timeout: 20_000 });
  const frame = page.frameLocator('iframe[src*="/editor/index.html"]').first();
  await frame.locator('.monaco-editor .view-line').first().waitFor({ timeout: 30_000 });
  await frame.getByText(/VS Code \d+\.\d+\.\d+ colors/).waitFor({ timeout: 10_000 });
  const status = await frame.locator('#status').innerText();
  check("a .ts file opens in VS Code's editor, colored by VS Code's TypeScript grammar", /TypeScript/.test(status) && /VS Code 1\.140\.0 colors/.test(status), status.replace(/\s+/g, ' '));
  const colors = await frame.locator('.monaco-editor .view-lines').evaluate((lines) => {
    const found = {};
    for (const span of lines.querySelectorAll('span span')) found[span.textContent.trim()] ??= getComputedStyle(span).color;
    return found;
  });
  // Light Modern or Dark Modern, whichever OpenChamber's look picks.
  const keyword = colors.const;
  check("keywords and numbers get the VS Code theme's colors", (keyword === 'rgb(0, 0, 255)' && colors['42'] === 'rgb(9, 134, 88)') || (keyword === 'rgb(86, 156, 214)' && colors['42'] === 'rgb(181, 206, 168)'), `const ${keyword}, 42 ${colors['42']}`);
  await page.screenshot({ path: join(out, '01-editor.png') });

  // Edit and save with the keyboard: OpenChamber writes what the editor hands back.
  await frame.locator('.monaco-editor .view-line').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// saved from the VS Code editor');
  await page.keyboard.press('Control+s');
  let onDisk = '';
  for (let attempt = 0; attempt < 20 && !onDisk.includes('saved from the VS Code editor'); attempt++) {
    await page.waitForTimeout(250);
    onDisk = docker('cat', file);
  }
  check('Ctrl+S saves the edited text to the file', onDisk.trimEnd().endsWith('// saved from the VS Code editor'));

  // The VS Code panel: the server, then the folder at hand in VS Code.
  await page.locator('button[aria-label="VS Code"]').first().click();
  // The file editor's frame is titled "VS Code" too; the panel's loads panel/index.html.
  const panel = page.frameLocator('iframe[title="VS Code"][src*="/panel/index.html"]').first();
  await panel.getByRole('heading', { name: 'VS Code', exact: true }).waitFor({ timeout: 20_000 });
  check('the panel shows the folder at hand', (await panel.getByText(/This chat's folder/).innerText()).includes(project));
  await panel.getByRole('textbox', { name: 'VS Code Server address' }).fill(server);
  await panel.getByLabel('VS Code Server connection token').fill(token);
  await panel.getByRole('button', { name: 'Save' }).click();
  await panel.getByText(/^Opens /).waitFor({ timeout: 5000 });
  check('the address shown hides the token', !(await panel.getByText(/^Opens /).innerText()).includes(token));
  const popup = page.waitForEvent('popup', { timeout: 15_000 });
  await panel.getByRole('button', { name: 'Open this folder in VS Code' }).click();
  const tab = await popup;
  await tab.locator('.monaco-workbench').waitFor({ timeout: 45_000 });
  await tab.waitForFunction(() => document.title.includes('Visual Studio Code'), null, { timeout: 30_000 });
  const title = await tab.title();
  check('the folder opens in the VS Code Server', title.includes('planner-demo-a') && title.includes('Visual Studio Code'), title);
  await tab.screenshot({ path: join(out, '02-vscode.png') });
  check('no errors from the editor page', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (error) {
  check('journey completed', false, String(error).split('\n')[0]);
  await context.pages()[0]?.screenshot({ path: join(out, '99-failure.png') }).catch(() => {});
} finally {
  if (session) await context.request.delete(`${base}/api/session/${session}?directory=${encodeURIComponent(project)}`).catch(() => {});
  if (saved?.value !== undefined && saved.value !== null) await storage({ op: 'set', key: 'settings', value: saved.value });
  else await storage({ op: 'delete', key: 'settings' });
  docker('rm', '-f', file);
  await browser.close();
}
const passed = results.filter((item) => item.ok).length;
console.log(`\n${passed}/${results.length} checks passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
