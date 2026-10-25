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
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthDayLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
const weekStartKey = (key) => { const d = new Date(`${key}T00:00:00Z`); const offset = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - offset); return d.toISOString().slice(0, 10); };
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
  const url = message.location().url ?? '';
  // A failed generate is the dev container having no model, not a Planner error.
  if (message.type() === 'error' && /oc-forge-planner|planner/i.test(url) && !url.includes('/generate')) problems.push(`console: ${message.text()}`);
});

const openPlanner = async () => {
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Planner', exact: true }).first().click({ timeout: 20_000 });
  // The full page sits in the host's inset overlay; the Work Status section is a separate frame.
  const frame = page.frameLocator('.inset-0 > iframe[src*="oc-forge-planner"]');
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

  // Phase 3a: timer, actual time, Focus, Work Status section.
  const timed = todayCol.locator('li.task-card', { hasText: `${run} sort-urgent` });
  await timed.hover();
  await timed.getByRole('button', { name: `Start timer for ${run} sort-urgent` }).click();
  const timerBar = frame.getByRole('status', { name: 'Running timer' });
  await timerBar.waitFor({ timeout: 10_000 });
  check('timer bar shows the running task', (await timerBar.innerText()).includes(`${run} sort-urgent`));
  await page.waitForTimeout(2200);
  check('running card shows a ticking clock', /\d+:\d{2}/.test(await timed.locator('.actual.is-running').innerText().catch(() => '')));
  await shot('08-timer');
  await timerBar.getByRole('button', { name: 'Stop timer' }).click();
  await timerBar.waitFor({ state: 'detached', timeout: 10_000 });
  await timed.getByRole('button', { name: new RegExp(`Open ${run} sort-urgent`) }).click();
  const timedDialog = frame.getByRole('dialog', { name: 'Task details' });
  const entriesText = await timedDialog.locator('section[aria-label="Actual time"]').innerText();
  check('stopping the timer records an actual-time entry', /timer/.test(entriesText), entriesText.replace(/\s+/g, ' ').slice(0, 120));
  await timedDialog.getByRole('button', { name: 'Close' }).click();

  await frame.getByRole('button', { name: 'Focus', exact: true }).click();
  await frame.getByRole('heading', { name: 'Focus' }).waitFor();
  const focusTitle = async () => (await frame.locator('.focus-title-row h2').innerText()).trim();
  const first = await focusTitle();
  await frame.locator('.focus-view').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowDown');
  const second = await focusTitle();
  check('Focus shows one task and ↓ moves to the next', Boolean(first) && first !== second, `${first} → ${second}`);
  await shot('09-focus');
  await frame.locator('.focus-card .check').click();
  await page.waitForTimeout(600);
  const third = await focusTitle().catch(() => '');
  check('completing in Focus moves on to another task', third !== second, `${second} → ${third || 'done for the day'}`);

  // Phase 3b: calendar subscription, timeboxing, auto-schedule, resize and move.
  const serviceState = async () => {
    const response = await context.request.post(`${base}/api/guests/oc-forge-planner/service/request`, { data: { method: 'GET', path: '/state' } });
    const outer = await response.json();
    return JSON.parse(outer.body ?? outer.result?.body ?? '{}');
  };
  const waitForState = async (predicate, timeout = 8000) => {
    const end = Date.now() + timeout;
    let latest = await serviceState();
    while (!predicate(latest) && Date.now() < end) {
      await page.waitForTimeout(300);
      latest = await serviceState();
    }
    return latest;
  };
  const snapshot = await serviceState();
  const zone = snapshot.state?.settings?.timezone ?? 'UTC';
  const todayKey = snapshot.today;
  const tomorrowKey = (() => { const d = new Date(`${todayKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const localToUtc = (minutes, dayKey = todayKey) => {
    // Find the UTC instant whose wall clock in `zone` is dayKey + minutes.
    const [y, m, d] = dayKey.split('-').map(Number);
    let guess = Date.UTC(y, m - 1, d, 0, minutes);
    for (let i = 0; i < 2; i++) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, Number(p.value)]));
      const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
      guess += Date.UTC(y, m - 1, d, 0, minutes) - wall;
    }
    return new Date(guess).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', `UID:${run}-meeting`, `DTSTART:${localToUtc(13 * 60)}`, `DTEND:${localToUtc(14 * 60)}`, `SUMMARY:${run} meeting`, 'END:VEVENT',
    'BEGIN:VEVENT', `UID:${run}-morning`, `DTSTART:${localToUtc(9 * 60, tomorrowKey)}`, `DTEND:${localToUtc(10 * 60, tomorrowKey)}`, `SUMMARY:${run} morning`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync('docker', ['exec', '-i', 'oc-forge-openchamber-dev', 'sh', '-c', 'cat > /home/node/planner-e2e.ics'], { input: ics });

  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Calendar name' }).fill(`${run} cal`);
  await frame.getByRole('textbox', { name: 'Calendar URL' }).fill('file:///home/node/planner-e2e.ics');
  await frame.getByRole('button', { name: 'Subscribe' }).click();
  await frame.locator('.channel-list li', { hasText: `${run} cal` }).waitFor({ timeout: 10_000 });

  await frame.getByRole('button', { name: 'Calendar', exact: true }).click();
  await frame.getByRole('heading', { name: 'Calendar' }).waitFor();
  const lane = frame.locator(`.day-lane[data-date="${todayKey}"]`);
  const meeting = lane.locator('.grid-item.is-event', { hasText: `${run} meeting` });
  await meeting.waitFor({ timeout: 15_000 });
  check('subscribed calendar event shows on the grid', true);

  const dragSource = frame.locator('aside li.task-card', { hasText: `${run} sort-low` });
  await dragSource.dragTo(lane, { targetPosition: { x: 40, y: 10 * 48 + 4 } });
  const lowBlock = lane.locator('.grid-item.is-block', { hasText: `${run} sort-low` });
  await lowBlock.waitFor({ timeout: 10_000 });
  check('dragging a task onto the calendar creates a working session at 10 AM', /10 AM/.test(await lowBlock.innerText()), (await lowBlock.innerText()).replace(/\s+/g, ' '));
  await shot('11-calendar');

  const box = await lowBlock.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2 + 48, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterResize = await serviceState();
  const lowTask = Object.values(afterResize.state.tasks).find((task) => task.title === `${run} sort-low`);
  check('resizing the session updates planned time', lowTask?.plannedMinutes === 90, `planned ${lowTask?.plannedMinutes}`);

  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await addInToday(`${run} auto ~45m @tomorrow`);
  const autoCard = frame.locator('section.day-column li.task-card', { hasText: `${run} auto` });
  await autoCard.waitFor({ timeout: 10_000 });
  await autoCard.hover();
  await autoCard.getByRole('button', { name: 'Task actions' }).click();
  await autoCard.getByRole('menuitem', { name: 'Timebox automatically' }).click();
  await page.waitForTimeout(1500);
  const afterAuto = await serviceState();
  const autoTask = Object.values(afterAuto.state.tasks).find((task) => task.title === `${run} auto`);
  const autoBlock = Object.values(afterAuto.state.blocks).find((block) => block.taskId === autoTask?.id);
  const expected = localToUtc(10 * 60, tomorrowKey).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6.000Z');
  check('auto-timebox takes the first free slot after the morning meeting', autoBlock?.start === expected, autoBlock ? `${autoBlock.start} (expected ${expected})` : 'no block');
  check('timeboxed card shows its session time', (await autoCard.locator('.timebox').count()) === 1);

  await frame.getByRole('button', { name: 'Calendar', exact: true }).click();
  const nextKey = (() => { const d = new Date(`${todayKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const nextLane = frame.locator(`.day-lane[data-date="${nextKey}"]`);
  if (await nextLane.count()) {
    const session = lane.locator('.grid-item.is-block', { hasText: `${run} sort-low` });
    await session.waitFor();
    await page.waitForTimeout(600);
    await session.scrollIntoViewIfNeeded();
    const blockBox = await session.boundingBox();
    const laneBox = await nextLane.boundingBox();
    await page.mouse.move(blockBox.x + blockBox.width / 3, blockBox.y + blockBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(laneBox.x + laneBox.width / 2, blockBox.y + blockBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const moved = Object.values((await serviceState()).state.tasks).find((task) => task.title === `${run} sort-low`);
    check('moving a session to the next day moves its task there', moved?.placement?.date === nextKey, JSON.stringify(moved?.placement));
    await frame.getByRole('status').filter({ hasText: 'Session moved' }).getByRole('button', { name: 'Undo' }).click();
    await page.waitForTimeout(800);
    const back = Object.values((await serviceState()).state.tasks).find((task) => task.title === `${run} sort-low`);
    check('undo puts the session and task back', back?.placement?.date === todayKey, JSON.stringify(back?.placement));
  } else {
    check('moving a session to the next day moves its task there', true, 'today is the last day of the week view; skipped');
  }
  await shot('12-calendar-after');

  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  await frame.locator('.channel-list li', { hasText: `${run} cal` }).getByRole('button', { name: 'Remove' }).click();
  execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', 'rm', '-f', '/home/node/planner-e2e.ics']);

  // Phase 4: weekly planning → daily planning → shutdown → highlights → weekly review.
  await frame.getByRole('button', { name: 'Weekly planning', exact: true }).click();
  await frame.getByRole('heading', { name: 'Weekly planning' }).waitFor();
  const subtitle = async () => (await frame.locator('.view-header .view-sub').first().innerText()).trim();
  // Planning on a late weekday looks at next week; go back to this week for today's tasks.
  if (!(await subtitle()).includes(monthDayLabel(weekStartKey(todayKey)))) await frame.getByRole('button', { name: 'Previous week' }).click();
  await frame.getByRole('button', { name: /Objectives/ }).click();
  await frame.getByRole('textbox', { name: 'Add objective' }).fill(`${run} launch planner`);
  await frame.getByRole('textbox', { name: 'Add objective' }).press('Enter');
  await frame.locator('li.objective input.objective-title').first().waitFor({ timeout: 10_000 });
  await frame.getByRole('button', { name: /Intention/ }).click();
  await frame.getByRole('textbox', { name: 'Weekly intention' }).fill('Get the Sunsama features in.');
  await frame.getByRole('button', { name: 'Finish planning' }).click();
  await frame.getByRole('heading', { name: 'Home' }).waitFor();
  check('weekly planning saves an objective and finishes', true);

  await frame.getByRole('button', { name: 'Daily planning', exact: true }).click();
  await frame.getByRole('heading', { name: 'Daily planning' }).waitFor();
  await frame.getByRole('tab', { name: 'Today' }).click();
  await frame.getByRole('button', { name: /Add tasks/ }).click();
  const planDay = frame.locator('.ritual-body section.day-column');
  await planDay.getByRole('button', { name: /Add task/ }).click();
  await planDay.getByRole('textbox', { name: 'New task' }).fill(`${run} ritual task ~25m $launch`);
  await planDay.getByRole('textbox', { name: 'New task' }).press('Enter');
  const ritualCard = planDay.locator('li.task-card', { hasText: `${run} ritual task` });
  await ritualCard.waitFor({ timeout: 10_000 });
  check('a $objective in Add Task aligns the task to the week objective', (await ritualCard.locator('.objective-badge').innerText().catch(() => '')).includes('launch planner'));
  await frame.getByRole('button', { name: /Estimate/ }).click();
  check('estimate step shows the workload against the threshold', /of work planned/.test(await frame.locator('.workload').innerText()));
  await frame.getByRole('button', { name: /Finalize/ }).click();
  check('finalize step lists the plan', (await frame.locator('.plan-text').innerText()).includes(`${run} ritual task (0:25)`));
  await frame.getByRole('textbox', { name: 'Obstacles' }).fill('Too many meetings');
  await frame.locator('.plan-text').click();
  await shot('13-daily-planning');
  await frame.getByRole('button', { name: 'Start my day' }).click();
  await frame.getByRole('heading', { name: 'Today' }).waitFor();
  const planned = await waitForState((latest) => Boolean(latest.state.rituals[`planning:${todayKey}`]?.completedAt) && latest.state.rituals[`planning:${todayKey}`]?.obstacles === 'Too many meetings');
  check('daily planning records completion and obstacles', Boolean(planned.state.rituals[`planning:${todayKey}`]?.completedAt) && planned.state.rituals[`planning:${todayKey}`]?.obstacles === 'Too many meetings', JSON.stringify(planned.state.rituals[`planning:${todayKey}`] ?? Object.keys(planned.state.rituals)));

  await frame.getByRole('button', { name: 'Daily shutdown', exact: true }).click();
  await frame.getByRole('heading', { name: 'Daily shutdown' }).waitFor();
  check('shutdown review lists today\'s completed work', (await frame.locator('.review-list').innerText()).includes(run));
  await frame.getByRole('button', { name: /Reflect/ }).click();
  await frame.getByRole('textbox', { name: 'Reflection' }).fill('Calendar work went well.');
  await frame.locator('.ritual-section label.stacked').click({ position: { x: 2, y: 2 } });
  await frame.getByRole('button', { name: 'Done for the day' }).click();
  await frame.getByRole('heading', { name: 'Daily highlights' }).waitFor();
  const shutdownState = await waitForState((latest) => latest.state.rituals[`shutdown:${todayKey}`]?.reflection === 'Calendar work went well.' && Boolean(latest.state.rituals[`shutdown:${todayKey}`]?.completedAt));
  check('shutdown records reflection and completion', shutdownState.state.rituals[`shutdown:${todayKey}`]?.reflection === 'Calendar work went well.' && Boolean(shutdownState.state.rituals[`shutdown:${todayKey}`]?.completedAt), JSON.stringify(shutdownState.state.rituals[`shutdown:${todayKey}`] ?? {}));

  await frame.getByRole('button', { name: new RegExp(`^Star ${run}`) }).first().click();
  await frame.getByRole('textbox', { name: 'Add highlight' }).fill(`${run} helped a teammate`);
  await frame.getByRole('textbox', { name: 'Add highlight' }).press('Enter');
  await frame.getByRole('button', { name: `Remove ${run} helped a teammate` }).waitFor({ timeout: 10_000 });
  const summarize = frame.getByRole('button', { name: /Summarize with AI/ });
  if (await summarize.isEnabled()) {
    await summarize.click();
    const summary = frame.getByRole('textbox', { name: 'Summary' });
    const filled = await summary.evaluate(async (element) => {
      for (let i = 0; i < 90; i++) {
        if (element.value.trim()) return element.value.trim();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return '';
    }).catch(() => '');
    console.log(`INFO AI summary (small model, soft check): ${filled ? `"${filled.slice(0, 140)}"` : 'no summary — see the toast for the model error'}`);
  }
  await frame.getByRole('button', { name: /^Publish/ }).click();
  await page.waitForTimeout(800);
  check('highlights publish with a starred and an added item', (await subtitle()).includes('published'));
  const highlightState = await waitForState((latest) => Boolean(latest.state.rituals[`highlights:${todayKey}`]?.publishedAt));
  const items = highlightState.state.rituals[`highlights:${todayKey}`]?.items ?? [];
  check('published highlights keep the star and the extra item', items.some((item) => item.starred) && items.some((item) => item.text === `${run} helped a teammate`), `${items.length} items`);
  await shot('14-highlights');

  await frame.getByRole('button', { name: 'Weekly review', exact: true }).click();
  await frame.getByRole('heading', { name: 'Weekly review' }).waitFor();
  const reviewText = await frame.locator('.ritual-body').innerText();
  check('weekly review shows the objective and the body of work', reviewText.includes(`${run} launch planner`) && reviewText.includes(`${run} write plan`));
  await frame.getByRole('textbox', { name: 'Weekly journal' }).fill('Solid week.');
  // Ritual records are per week and persist across runs; either label is fine.
  await frame.getByRole('button', { name: /^(Wrap up the week|Wrapped up)$/ }).click();
  await frame.getByRole('button', { name: 'Wrapped up' }).waitFor({ timeout: 10_000 });
  check('weekly review wraps up', true);
  await shot('15-weekly-review');

  // Phase 5: recurring tasks, command palette, quick add, shortcuts, stats.
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await frame.getByRole('heading', { name: 'Home' }).waitFor();
  await addInToday(`${run} repeat ~10m`);
  const repeatCard = frame.locator('section.day-column.is-today li.task-card', { hasText: `${run} repeat` });
  await repeatCard.getByRole('button', { name: new RegExp(`Open ${run} repeat`) }).click();
  const repeatDialog = frame.getByRole('dialog', { name: 'Task details' });
  await repeatDialog.locator('section[aria-label="Repeat"] select').selectOption('daily');
  await repeatDialog.locator('.repeat-rule').waitFor({ timeout: 10_000 });
  check('a task can repeat every day', (await repeatDialog.locator('.repeat-rule').innerText()).includes('Every day'));
  await repeatDialog.getByRole('button', { name: 'Close' }).click();
  const tomorrowColumn = frame.locator('section.day-column', { has: frame.locator('.day-name', { hasText: 'Tomorrow' }) });
  const tomorrowInstance = tomorrowColumn.locator('li.task-card', { hasText: `${run} repeat` });
  await tomorrowInstance.waitFor({ timeout: 10_000 });
  check('tomorrow already shows the next instance, marked as repeating', (await tomorrowInstance.locator('.repeats').count()) === 1);
  await repeatCard.getByRole('button', { name: new RegExp(`Open ${run} repeat`) }).click();
  await repeatDialog.getByRole('button', { name: 'Stop repeating' }).click();
  await repeatDialog.getByRole('button', { name: 'Close' }).click();
  await tomorrowInstance.waitFor({ state: 'detached', timeout: 10_000 });
  check('stopping the series removes upcoming instances', true);

  await frame.getByRole('heading', { name: 'Home' }).click();
  await page.keyboard.press('Control+k');
  const palette = frame.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor({ timeout: 5000 });
  await palette.getByRole('combobox', { name: 'Search tasks or commands' }).fill(`${run} sort-l`);
  await palette.getByRole('option', { name: new RegExp(`${run} sort-low`) }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  await frame.getByRole('dialog', { name: 'Task details' }).waitFor({ timeout: 5000 });
  check('Ctrl+K finds a task and opens it', (await frame.getByRole('dialog', { name: 'Task details' }).getByRole('textbox', { name: 'Title' }).inputValue()).includes('sort-low'));
  await frame.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click();

  await frame.getByRole('heading', { name: 'Home' }).click();
  await page.keyboard.press('a');
  const quick = frame.getByRole('dialog', { name: 'Add task' });
  await quick.waitFor({ timeout: 5000 });
  await quick.getByRole('textbox', { name: 'New task' }).fill(`${run} quick ~5m @tomorrow`);
  await page.keyboard.press('Enter');
  await tomorrowColumn.locator('li.task-card', { hasText: `${run} quick` }).waitFor({ timeout: 10_000 });
  check('A opens Add task and @tomorrow lands it on tomorrow', true);

  const quickCard = tomorrowColumn.locator('li.task-card', { hasText: `${run} quick` });
  await quickCard.hover();
  await page.keyboard.press('z');
  await quickCard.waitFor({ state: 'detached', timeout: 10_000 });
  check('Z on a hovered card moves it to the backlog', true);
  await page.keyboard.press('t');
  await frame.getByRole('heading', { name: 'Today' }).waitFor({ timeout: 5000 });
  check('T jumps to Today', true);

  await frame.getByRole('button', { name: 'Stats', exact: true }).click();
  await frame.getByRole('heading', { name: 'Stats' }).waitFor();
  const completedCount = Number((await frame.locator('.stat-card', { hasText: 'Tasks completed' }).locator('strong').innerText()).trim());
  check('Stats counts completed tasks', completedCount > 0, `${completedCount} completed`);
  await shot('16-stats');

  // Phase 6: Linear. First the real state of the dev container (not connected)…
  const nav = (name) => frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
  await nav('Linear').click();
  await frame.getByRole('heading', { name: 'Linear' }).waitFor();
  await frame.getByRole('button', { name: 'Connect Linear' }).waitFor({ timeout: 10_000 });
  check('without a Linear connection the page offers Connect', true);

  // …then a fake Linear behind the host's own routes, so the real workspace is never touched.
  const linearStates = [
    { id: 'st-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
    { id: 'st-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
    { id: 'st-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    { id: 'st-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
  ];
  const team = { id: 'team-e2e', key: 'E2E', name: 'E2E Team' };
  const makeIssue = (n, title, stateId, assigned = true) => ({
    id: `iss-${run}-${n}`, identifier: `E2E-${n}`, title: `${run} ${title}`, url: `https://linear.app/e2e/issue/E2E-${n}/x`, priority: 2, dueDate: null,
    updatedAt: new Date().toISOString(), state: linearStates.find((state) => state.id === stateId), team, project: { id: 'p1', name: 'Planner' }, cycle: null, assigned,
  });
  const linearIssues = [makeIssue(1, 'linear first', 'st-todo'), makeIssue(2, 'linear second', 'st-prog'), makeIssue(3, 'linear third', 'st-backlog'), makeIssue(5, 'linear by url', 'st-todo', false)];
  const linearCalls = [];
  const strip = ({ assigned, ...issue }) => issue;
  const isRequestRoute = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/request';
  const isStatusRoute = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/oauth/status';
  await context.route(isStatusRoute, (route) => route.fulfill({ json: { connected: true, account: 'E2E Linear', hasClient: true, settings: {}, redirectUri: '' } }));
  await context.route(isRequestRoute, async (route) => {
    const { query, variables = {} } = JSON.parse(route.request().postDataJSON().body);
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    linearCalls.push({ op, variables });
    const find = (id) => linearIssues.find((issue) => issue.id === id || issue.identifier === id);
    let data;
    if (op === 'PlannerAssigned') data = { viewer: { id: 'u-e2e', name: 'E2E Linear', assignedIssues: { nodes: linearIssues.filter((issue) => issue.assigned && !['completed', 'canceled'].includes(issue.state.type)).map(strip), pageInfo: { hasNextPage: false, endCursor: null } } } };
    else if (op === 'PlannerViews') data = { customViews: { nodes: [] } };
    else if (op === 'PlannerLinked') data = { issues: { nodes: linearIssues.filter((issue) => variables.ids.includes(issue.id)).map(strip) } };
    else if (op === 'PlannerIssue') data = { issue: find(variables.id) ? strip(find(variables.id)) : null };
    else if (op === 'PlannerTeamStates') data = { team: { id: variables.id, states: { nodes: linearStates } } };
    else if (op === 'PlannerTeams') data = { viewer: { id: 'u-e2e' }, teams: { nodes: [team] } };
    else if (op === 'PlannerSetState') {
      const issue = find(variables.id);
      issue.state = linearStates.find((state) => state.id === variables.stateId);
      data = { issueUpdate: { success: true, issue: strip(issue) } };
    } else if (op === 'PlannerCreateIssue') {
      const issue = makeIssue(linearIssues.length + 10, 'x', 'st-todo');
      issue.title = variables.input.title;
      linearIssues.push(issue);
      data = { issueCreate: { success: true, issue: strip(issue) } };
    } else if (op === 'PlannerSearch') data = { searchIssues: { nodes: linearIssues.filter((issue) => issue.title.includes(variables.term)).map(strip) } };
    const answer = data ? { data } : { errors: [{ message: `unexpected ${op}` }] };
    await route.fulfill({ json: { status: 200, body: JSON.stringify(answer) } });
  });

  frame = await openPlanner();
  await nav('Linear').click();
  const issueRow = (n) => frame.locator('li.issue-row', { hasText: `E2E-${n}` }).first();
  await issueRow(1).waitFor({ timeout: 15_000 });
  const groups = await frame.locator('.linear-page .issue-group h3').allInnerTexts();
  check('My issues lists assigned open issues grouped by state', groups.join('|').includes('In progress') && groups.join('|').includes('Todo') && groups.join('|').includes('Backlog'), groups.join(' | '));
  await shot('17-linear');

  await frame.getByRole('button', { name: 'Plan E2E-1 today' }).click();
  await issueRow(1).getByRole('button', { name: 'Open the task for E2E-1 (Today)' }).waitFor({ timeout: 10_000 });
  await nav('Today').click();
  const todayList = frame.locator('section.day-column.is-today');
  const linearCard = (title) => todayList.locator('li.task-card', { hasText: `${run} ${title}` });
  await linearCard('linear first').waitFor({ timeout: 10_000 });
  check('planning an issue makes a linked task with its key', (await linearCard('linear first').locator('.source-chip').innerText()).includes('E2E-1'));

  await frame.getByRole('tab', { name: 'Linear' }).click();
  await frame.locator('aside li.issue-row', { hasText: 'E2E-3' }).dragTo(todayList.locator('ul.task-list'));
  await linearCard('linear third').waitFor({ timeout: 10_000 });
  check('dragging an issue into the day plans it', true);

  await linearCard('linear first').getByRole('button', { name: 'Mark complete' }).click();
  const prompt = frame.getByRole('alertdialog', { name: 'Update E2E-1 in Linear' });
  await prompt.waitFor({ timeout: 10_000 });
  await prompt.getByRole('button', { name: 'Move' }).click();
  await linearCard('linear first').locator('.source-chip', { hasText: 'E2E-1' }).waitFor();
  await page.waitForTimeout(1500);
  const setState = linearCalls.find((call) => call.op === 'PlannerSetState' && call.variables.id === `iss-${run}-1`);
  check('completing asks, then moves the issue to the team Done state', setState?.variables.stateId === 'st-done', JSON.stringify(setState?.variables ?? null));

  await nav('Settings').click();
  await frame.getByRole('checkbox', { name: /Complete a task when its issue is closed in Linear/ }).check();
  await nav('Today').click();
  await frame.getByRole('tab', { name: 'Linear' }).click();
  await frame.getByRole('button', { name: 'Plan E2E-2 today' }).click();
  await linearCard('linear second').waitFor({ timeout: 10_000 });
  linearIssues.find((issue) => issue.identifier === 'E2E-2').state = linearStates.find((state) => state.id === 'st-done');
  linearIssues.find((issue) => issue.identifier === 'E2E-3').title = `${run} linear third renamed`;
  await frame.getByRole('button', { name: 'Refresh Linear' }).click();
  const synced = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.title === `${run} linear second` && task.completedAt) && Object.values(latest.state.tasks).some((task) => task.title === `${run} linear third renamed`));
  const closedTask = Object.values(synced.state.tasks).find((task) => task.title === `${run} linear second`);
  check('an issue closed in Linear completes its task (when turned on)', Boolean(closedTask?.completedAt));
  check('a rename in Linear follows to an unrenamed task', Object.values(synced.state.tasks).some((task) => task.title === `${run} linear third renamed`));
  check('a completion that came from Linear is not written back', !linearCalls.some((call) => call.op === 'PlannerSetState' && call.variables.id === `iss-${run}-2`));

  await addInToday(`${run} make an issue`);
  await linearCard('make an issue').getByRole('button', { name: new RegExp(`Open ${run} make an issue`) }).click();
  const issueDialog = frame.getByRole('dialog', { name: 'Task details' });
  await issueDialog.getByRole('button', { name: 'Create Linear issue' }).click();
  await issueDialog.locator('section[aria-label="Linear"] .source-chip').waitFor({ timeout: 10_000 });
  const created = linearCalls.find((call) => call.op === 'PlannerCreateIssue');
  check('a task can become a Linear issue assigned to me', created?.variables.input.title === `${run} make an issue` && created?.variables.input.assigneeId === 'u-e2e', JSON.stringify(created?.variables.input ?? null));
  await shot('18-linear-detail');
  await issueDialog.getByRole('button', { name: 'Unlink' }).click();
  await issueDialog.locator('section[aria-label="Linear"] .source-chip').waitFor({ state: 'detached', timeout: 10_000 });
  check('unlinking removes the link', true);
  await issueDialog.getByRole('button', { name: 'Close' }).click();

  await addInToday('https://linear.app/e2e/issue/E2E-5/linear-by-url ~20m');
  await linearCard('linear by url').waitFor({ timeout: 10_000 });
  check('pasting an issue URL into Add task links that issue', (await linearCard('linear by url').innerText()).includes('0:20'));

  await nav('Settings').click();
  await frame.getByRole('checkbox', { name: /Complete a task when its issue is closed in Linear/ }).uncheck();
  await context.unroute(isRequestRoute);
  await context.unroute(isStatusRoute);

  // The Work Status section sits in the chat's Work Status panel (shown on the home screen too).
  await page.goto(`${base}/`, { waitUntil: 'load' });
  const statusSelector = '.rounded-md > iframe[src*="oc-forge-planner"]';
  const statusMounted = () => page.locator(statusSelector).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  let mounted = await statusMounted();
  const toggle = page.getByRole('button', { name: 'Toggle work-status panel' }).first();
  if (!mounted && (await toggle.count())) {
    await toggle.click();
    mounted = await statusMounted();
  }
  const statusText = mounted ? await page.frameLocator(statusSelector).locator('.status-section').innerText({ timeout: 8000 }).catch(() => '') : '';
  check('Work Status section shows today\'s progress', /done today/.test(statusText), statusText.replace(/\s+/g, ' ').slice(0, 120) || 'section not mounted');
  await shot('10-work-status');
  frame = await openPlanner();

} catch (error) {
  check('journey completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  await shot('99-failure').catch(() => {});
} finally {
  // Remove every e2e task and calendar through the service, so a failed run cannot leak into the next.
  const call = async (method, path, body) => {
    const response = await context.request.post(`${base}/api/guests/oc-forge-planner/service/request`, { data: { method, path, ...(body ? { body: JSON.stringify(body) } : {}) } });
    const outer = await response.json().catch(() => ({}));
    return JSON.parse(outer.body ?? '{}');
  };
  try {
    const { state } = await call('GET', '/state');
    const commands = [
      ...(state.timer && /^e2e-/.test(state.tasks[state.timer.taskId]?.title ?? '') ? [{ cmd: `cleanup-timer-${run}`, type: 'timer.stopped' }] : []),
      ...Object.values(state.tasks).filter((task) => /^e2e-/.test(task.title) && !task.deletedAt).map((task) => ({ cmd: `cleanup-${task.id}`, type: 'task.deleted', taskId: task.id })),
      ...Object.values(state.calendars).filter((calendar) => /^e2e-/.test(calendar.name)).map((calendar) => ({ cmd: `cleanup-${calendar.id}`, type: 'calendar.removed', calendarId: calendar.id })),
      ...Object.values(state.objectives ?? {}).filter((objective) => /^e2e-/.test(objective.title) && !objective.deletedAt).map((objective) => ({ cmd: `cleanup-${objective.id}`, type: 'objective.deleted', objectiveId: objective.id })),
      ...Object.values(state.series ?? {}).filter((series) => /^e2e-/.test(series.template.title) && !series.stoppedFrom).map((series) => ({ cmd: `cleanup-${series.id}`, type: 'series.stopped', seriesId: series.id, from: '2000-01-01' })),
    ];
    if (commands.length) await call('POST', '/commands', { commands });
    const after = await call('GET', '/state');
    check('cleanup leaves no live test tasks', !Object.values(after.state.tasks).some((task) => /^e2e-/.test(task.title) && !task.deletedAt));
  } catch (error) {
    check('cleanup leaves no live test tasks', false, String(error));
  }
  check('no page errors from the extension', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
