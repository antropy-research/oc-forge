// End-to-end check of the Planner extension in the dev OpenChamber.
// Run on the host: node extensions/planner/tests/e2e/run.mjs [baseUrl] [outDir]
// Uses this package's playwright-core with the Chromium in ~/.cache/ms-playwright.
// The UI password is read from the dev container's secrets file and never printed.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:35310';
const out = process.argv[3] ?? '/tmp/opencode/planner-e2e';
mkdirSync(out, { recursive: true });
const secrets = readFileSync(join(homedir(), '.local/share/oc-forge-openchamber-dev/secrets.env'), 'utf8');
const password = /^OPENCHAMBER_UI_PASSWORD=(.+)$/m.exec(secrets)?.[1]?.trim();
if (!password) throw new Error('no UI password in secrets.env');

const run = `e2e-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const login = await context.request.post(`${base}/auth/session`, { data: { password } });
check('login', login.status() === 200, `status ${login.status()}`);

// Restart the local service so it runs the code that was just built.
for (const enabled of [false, true]) {
  const toggle = await context.request.put(`${base}/api/guests/oc-forge-planner/enabled`, { data: { enabled } });
  if (toggle.status() !== 200) check(`service restart (${enabled ? 'enable' : 'pause'})`, false, `status ${toggle.status()}`);
}

const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' && /oc-forge-planner|planner/i.test(message.location().url ?? '')) problems.push(`console: ${message.text()}`);
});

const openPlanner = async () => {
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Planner', exact: true }).first().click({ timeout: 20_000 });
  const frame = page.frameLocator('iframe[src*="oc-forge-planner"]');
  await frame.getByRole('heading', { name: 'Home' }).waitFor({ timeout: 30_000 });
  return frame;
};

const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });

try {
  let frame = await openPlanner();
  check('page opens and the service answers', true);
  await shot('01-home');

  const today = frame.locator('section.day-column.is-today');
  await today.getByRole('button', { name: /Add task/ }).click();
  const input = today.getByRole('textbox', { name: 'New task' });
  await input.fill(`${run} write plan ~30m #work !high`);
  check('quick add shows parsed chips', (await today.locator('.chip').allTextContents()).join(' ').includes('~0:30'));
  await input.press('Enter');
  await input.fill(`${run} later idea @someday`);
  await input.press('Enter');
  await input.press('Escape');

  const card = today.locator('li.task-card', { hasText: `${run} write plan` });
  await card.waitFor({ timeout: 10_000 });
  const cardText = await card.innerText();
  check('task lands in today with planned time, channel and priority', /0:30/.test(cardText) && /#work|work/.test(cardText) && /High/.test(cardText), cardText.replace(/\s+/g, ' '));
  check('@someday task stays out of today', (await today.locator('li.task-card', { hasText: `${run} later idea` }).count()) === 0);

  await card.getByRole('button', { name: 'Mark complete' }).click();
  await card.locator('.check[aria-pressed="true"]').waitFor({ timeout: 10_000 });
  check('completing marks the card done', (await card.getAttribute('class'))?.includes('is-done') ?? false);
  await page.waitForTimeout(1200);
  await shot('02-today-after-add');

  frame = await openPlanner();
  const reloaded = frame.locator('section.day-column.is-today li.task-card', { hasText: `${run} write plan` });
  await reloaded.waitFor({ timeout: 10_000 });
  check('task and completion survive a reload', (await reloaded.getAttribute('class'))?.includes('is-done') ?? false);

  await frame.getByRole('button', { name: 'Backlog', exact: true }).click();
  const someday = frame.locator('section.bucket', { has: frame.getByRole('heading', { name: /^Someday\b/ }) }).filter({ hasText: `${run} later idea` });
  check('backlog shows the @someday task in Someday', (await someday.count()) === 1);
  await shot('03-backlog');

  await frame.getByRole('button', { name: 'Today', exact: true }).click();
  await frame.getByRole('heading', { name: 'Today' }).waitFor();
  await shot('04-today-view');

  // Phase 2: task detail, badges, undo, archive, sort.
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  const todayCol = frame.locator('section.day-column.is-today');
  const addInToday = async (line) => {
    await todayCol.getByRole('button', { name: /Add task/ }).click();
    const box = todayCol.getByRole('textbox', { name: 'New task' });
    await box.fill(line);
    await box.press('Enter');
    await box.press('Escape');
  };
  await addInToday(`${run} detail ~20m`);
  const detailCard = todayCol.locator('li.task-card', { hasText: `${run} detail` });
  await detailCard.getByRole('button', { name: new RegExp(`Open ${run} detail`) }).click();
  const dialog = frame.getByRole('dialog', { name: 'Task details' });
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.locator('label.field', { hasText: 'Priority' }).locator('select').selectOption('high');
  await dialog.locator('label.field', { hasText: 'Due' }).locator('input').fill('2030-01-15');
  await dialog.getByRole('textbox', { name: 'Add subtask' }).fill('first step');
  await dialog.getByRole('textbox', { name: 'Add subtask' }).press('Enter');
  await dialog.getByRole('checkbox', { name: 'Complete first step' }).check();
  await dialog.getByRole('textbox', { name: 'Notes' }).fill('some notes');
  await dialog.getByRole('textbox', { name: 'Add subtask' }).click();
  await page.waitForTimeout(1500);
  const activityText = (await dialog.locator('.activity').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('activity log records detail edits', /set priority to High/.test(activityText) && /updated subtasks/.test(activityText), activityText.slice(0, 160));
  await shot('05-detail');
  await dialog.getByRole('button', { name: 'Close' }).click();
  const badges = (await detailCard.innerText()).replace(/\s+/g, ' ');
  check('card shows priority, due date, subtask and notes badges', /High/.test(badges) && /Due January 15/.test(badges) && /1\/1/.test(badges) && /≡/.test(badges), badges);

  await detailCard.hover();
  await detailCard.getByRole('button', { name: 'Task actions' }).click();
  await detailCard.getByRole('menuitem', { name: 'Delete' }).click();
  await frame.getByRole('status').filter({ hasText: 'Task deleted' }).getByRole('button', { name: 'Undo' }).click();
  await todayCol.locator('li.task-card', { hasText: `${run} detail` }).waitFor({ timeout: 10_000 });
  check('undo brings a deleted task back', true);

  const again = todayCol.locator('li.task-card', { hasText: `${run} detail` });
  await again.hover();
  await again.getByRole('button', { name: 'Task actions' }).click();
  await again.getByRole('menuitem', { name: 'Archive' }).click();
  await frame.getByRole('button', { name: /^Archive/ }).first().click();
  const archivedRow = frame.locator('li.archive-row', { hasText: `${run} detail` });
  await archivedRow.waitFor({ timeout: 10_000 });
  await shot('06-archive');
  await archivedRow.getByRole('button', { name: 'Move to today' }).click();
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  check('archived task returns to today', (await todayCol.locator('li.task-card', { hasText: `${run} detail` }).count()) === 1);

  await addInToday(`${run} sort-low !low`);
  await addInToday(`${run} sort-urgent !urgent`);
  await todayCol.getByRole('button', { name: 'Today actions' }).click();
  await todayCol.getByRole('menuitem', { name: 'Sort by priority' }).click();
  await page.waitForTimeout(800);
  const order = (await todayCol.locator('li.task-card .task-title').allTextContents()).filter((title) => title.includes(run));
  check('sort by priority puts urgent first', order.findIndex((title) => title.includes('sort-urgent')) < order.findIndex((title) => title.includes('sort-low')), order.join(' | '));
  await shot('07-sorted');

  // Clean up this run's tasks through the task menu.
  for (const view of ['Home', 'Backlog']) {
    await frame.getByRole('button', { name: view, exact: true }).click();
    for (let guard = 0; guard < 20; guard++) {
      const target = frame.locator('li.task-card', { hasText: run }).first();
      if (!(await target.count())) break;
      await target.hover();
      await target.getByRole('button', { name: 'Task actions' }).click();
      await target.getByRole('menuitem', { name: 'Delete' }).click();
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(800);
  check('cleanup leaves no test tasks', (await frame.locator('li.task-card', { hasText: run }).count()) === 0);
} catch (error) {
  check('journey completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  await shot('99-failure').catch(() => {});
} finally {
  check('no page errors from the extension', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
