// End-to-end check of the Planner extension in the dev OpenChamber.
// Run on the host: node extensions/planner/tests/e2e/run.mjs [baseUrl] [outDir]
// Uses this package's playwright-core with the Chromium in ~/.cache/ms-playwright.
// The UI password is read from the dev container's secrets file and never printed.
import { execFileSync } from 'node:child_process';
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

/** Remove every e2e task, run, chat, worktree, calendar, objective, series, folder and highlight. */
const cleanUp = async (final) => {
  const call = async (method, path, body) => {
    const response = await context.request.post(`${base}/api/guests/oc-forge-planner/service/request`, { data: { method, path, ...(body ? { body: JSON.stringify(body) } : {}) } });
    const outer = await response.json().catch(() => ({}));
    return JSON.parse(outer.body ?? '{}');
  };
  const isTestTask = (task) => !task.deletedAt && (/^e2e-/.test(task.title) || Boolean(task.sessionRef?.title?.includes('e2e-')));
  try {
    const { state } = await call('GET', '/state');
    const testTaskIds = new Set(Object.values(state.tasks).filter(isTestTask).map((task) => task.id));
    const testRuns = Object.values(state.runs ?? {}).filter((item) => testTaskIds.has(item.taskId));
    // Real chats the journey started in the dev container, then the worktrees and branches it made.
    for (const session of new Map(testRuns.map((item) => [item.sessionId, item])).values()) {
      await context.request.delete(`${base}/api/session/${session.sessionId}?directory=${encodeURIComponent(session.directory ?? '')}`).catch(() => {});
    }
    try {
      execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', 'sh', '-c', "cd /home/node/projects/planner-demo-a && git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\\/heads\\/planner\\/e2e-/{print w}' | while read w; do git worktree remove --force \"$w\"; done; git worktree prune; git branch --list 'planner/e2e-*' | xargs -r git branch -D >/dev/null"]);
    } catch (error) {
      console.log(`INFO worktree cleanup: ${String(error).split('\n')[0]}`);
    }
    const commands = [
      ...testRuns.map((item) => ({ cmd: `cleanup-${item.id}`, type: 'run.removed', runId: item.id })),
      ...(state.timer && /^e2e-/.test(state.tasks[state.timer.taskId]?.title ?? '') ? [{ cmd: `cleanup-timer-${run}`, type: 'timer.stopped' }] : []),
      ...Object.values(state.tasks).filter(isTestTask).map((task) => ({ cmd: `cleanup-${task.id}`, type: 'task.deleted', taskId: task.id })),
      ...Object.values(state.calendars).filter((calendar) => /^e2e-/.test(calendar.name)).map((calendar) => ({ cmd: `cleanup-${calendar.id}`, type: 'calendar.removed', calendarId: calendar.id })),
      ...Object.values(state.objectives ?? {}).filter((objective) => /^e2e-/.test(objective.title) && !objective.deletedAt).map((objective) => ({ cmd: `cleanup-${objective.id}`, type: 'objective.deleted', objectiveId: objective.id })),
      ...Object.values(state.series ?? {}).filter((series) => /^e2e-/.test(series.template.title) && !series.stoppedFrom).map((series) => ({ cmd: `cleanup-${series.id}`, type: 'series.stopped', seriesId: series.id, from: '2000-01-01' })),
      ...Object.values(state.folders ?? {}).filter((folder) => /^e2e-/.test(folder.name) && !folder.deletedAt).map((folder) => ({ cmd: `cleanup-${folder.id}`, type: 'folder.deleted', folderId: folder.id })),
      // Custom highlights the journey typed in are not tasks; drop them from the day's record too.
      ...Object.entries(state.rituals ?? {})
        .filter(([key, record]) => key.startsWith('highlights:') && (record.items ?? []).some((item) => /^e2e-/.test(item.text)))
        .map(([key, record]) => ({ cmd: `cleanup-hl-${key.slice('highlights:'.length)}-${run}`, type: 'ritual.saved', ritual: 'highlights', date: key.slice('highlights:'.length), fields: { items: record.items.filter((item) => !/^e2e-/.test(item.text)) } })),
    ];
    if (commands.length) {
      const answer = await call('POST', '/commands', { commands });
      if (answer.error) console.log(`INFO cleanup batch rejected: ${answer.error} (command ${answer.index})`);
    }
    const after = await call('GET', '/state');
    if (final) check('cleanup leaves no live test tasks', !Object.values(after.state.tasks).some(isTestTask));
  } catch (error) {
    if (final) check('cleanup leaves no live test tasks', false, String(error));
  }
};

// A crashed earlier run may have left test data behind; start from a clean planner.
await cleanUp(false);

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
  // The dev container has no Small Model; answer the host's generate route like a model would.
  const isSummaryGenerate = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/generate';
  let summaryPrompt = '';
  await context.route(isSummaryGenerate, (route) => {
    summaryPrompt = JSON.parse(route.request().postData() ?? '{}').prompt ?? '';
    return route.fulfill({ json: { ok: true, result: { text: `I shipped the calendar and helped a teammate (${run}).` } } });
  });
  // A summary saved by an earlier run turns the button into "Summarize again".
  await frame.getByRole('button', { name: /^Summarize (with AI|again)$/ }).click();
  // The field is re-created when the summary is saved, so look it up again each time.
  const expectedSummary = `I shipped the calendar and helped a teammate (${run}).`;
  let summaryText = '';
  for (let i = 0; i < 40 && summaryText !== expectedSummary; i++) {
    summaryText = (await frame.getByRole('textbox', { name: 'Summary' }).inputValue().catch(() => '')).trim();
    if (summaryText !== expectedSummary) await page.waitForTimeout(250);
  }
  check('the AI summary is written from the highlights', summaryText === expectedSummary && summaryPrompt.includes(`${run} helped a teammate`), summaryText);
  await context.unroute(isSummaryGenerate);
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

  // Phase 7: agents. Real OpenCode chats in the dev container's demo project, with a trivial prompt.
  const TRIVIAL = 'Reply with exactly the word OK. Do not use any tools and do not edit files.';
  const sendToAgent = async (title, setup) => {
    await nav('Home').click();
    await addInToday(title);
    const card = frame.locator('section.day-column.is-today li.task-card', { hasText: title });
    await card.getByRole('button', { name: new RegExp(`Open ${title}`) }).click();
    const dialog = frame.getByRole('dialog', { name: 'Task details' });
    await dialog.getByRole('button', { name: 'Send to an agent' }).click();
    await dialog.getByRole('combobox', { name: 'Agent project' }).selectOption({ label: 'planner-demo-a' });
    await dialog.getByRole('textbox', { name: 'Agent prompt' }).fill(TRIVIAL);
    if (setup) await setup(dialog);
    return { card, dialog };
  };
  const taskTitled = (latest, title) => Object.values(latest.state.tasks).find((task) => task.title === title && !task.deletedAt);
  const runsOf = (latest, title) => Object.values(latest.state.runs).filter((item) => item.taskId === taskTitled(latest, title)?.id);

  const agentTitle = `${run} agent task`;
  const firstAgent = await sendToAgent(agentTitle);
  await firstAgent.dialog.getByRole('button', { name: 'Start agent' }).dblclick();
  await firstAgent.dialog.locator('li.run-row').first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const afterStart = await serviceState();
  check('starting twice quickly makes one run (no duplicate dispatch)', runsOf(afterStart, agentTitle).length === 1, `${runsOf(afterStart, agentTitle).length} runs`);
  const agentRun = runsOf(afterStart, agentTitle)[0];
  check('the run keeps project, directory and session', Boolean(agentRun?.sessionId && agentRun.projectId && agentRun.directory?.endsWith('planner-demo-a')), JSON.stringify(agentRun ?? null).slice(0, 160));
  const reviewed = await firstAgent.dialog.locator('li.run-row', { hasText: 'Ready for review' }).waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
  if (reviewed) {
    check('a finished turn shows as Ready for review', true);
  } else {
    // Tell a slow free model apart from a stale Planner: ask OpenCode whether the turn finished.
    const messages = await (await context.request.get(`${base}/api/session/${agentRun.sessionId}/message?directory=${encodeURIComponent(agentRun.directory)}`)).json().catch(() => []);
    const finished = (Array.isArray(messages) ? messages : messages.data ?? []).some((message) => (message.info ?? message).time?.completed && (message.info ?? message).finish);
    if (finished) check('a finished turn shows as Ready for review', false, 'OpenCode finished the turn but the Planner still shows it running');
    else console.log('INFO the dev container\'s free model did not finish within 3 minutes; skipped the review checks');
  }
  check('a finished turn does not complete the task', !taskTitled(await serviceState(), agentTitle)?.completedAt);
  await shot('19-agent-run');
  await firstAgent.dialog.getByRole('button', { name: 'Close' }).click();
  const sessionsResponse = await context.request.get(`${base}/api/session?directory=${encodeURIComponent(agentRun.directory)}`);
  const chat = (await sessionsResponse.json()).data.find((item) => item.id === agentRun.sessionId);
  check('the chat is named with the task chip', /^PLN-\w{4} /.test(chat?.title ?? '') && chat.title.includes(agentTitle), chat?.title);
  if (reviewed) {
    check('the card shows the agent state', (await firstAgent.card.locator('.agent-chip').innerText().catch(() => '')).includes('Review'));
    await nav('Agents').click();
    const reviewGroup = frame.locator('section.agent-group[aria-label="Ready for review"]');
    await reviewGroup.locator('li.agent-task', { hasText: agentTitle }).waitFor({ timeout: 10_000 });
    check('Agents lists the run under Ready for review', true);
    await shot('20-agents');
    await reviewGroup.locator('li.agent-task', { hasText: agentTitle }).getByRole('button', { name: 'Accept and complete' }).click();
    const accepted = await waitForState((latest) => Boolean(taskTitled(latest, agentTitle)?.completedAt) && runsOf(latest, agentTitle)[0]?.review?.verdict === 'accepted');
    check('Accept and complete records the review and completes the task', Boolean(taskTitled(accepted, agentTitle)?.completedAt) && runsOf(accepted, agentTitle)[0]?.review?.verdict === 'accepted');
  }

  const worktreeTitle = `${run} worktree task`;
  const branchName = `planner/${run}`;
  const secondAgent = await sendToAgent(worktreeTitle, async (dialog) => {
    await dialog.getByRole('combobox', { name: 'Agent workspace' }).selectOption('new');
    await dialog.getByRole('textbox', { name: 'Worktree branch' }).fill(branchName);
  });
  await secondAgent.dialog.getByRole('button', { name: 'Start agent' }).click();
  await secondAgent.dialog.locator('li.run-row').first().waitFor({ timeout: 200_000 });
  const worktreeRun = runsOf(await serviceState(), worktreeTitle)[0];
  check('an agent can work in a new worktree', worktreeRun?.worktree?.branch === branchName, JSON.stringify(worktreeRun?.worktree ?? null));
  await secondAgent.dialog.getByRole('button', { name: 'Close' }).click();

  // From the chat: a message action, /task, and the session action.
  await nav('Agents').click();
  await frame.locator('li.agent-task', { hasText: agentTitle }).getByRole('button', { name: 'Open chat' }).click();
  await page.waitForURL((url) => url.searchParams.get('session') === agentRun.sessionId, { timeout: 15_000 });
  const reply = page.getByText(/^OK\.?$/).last();
  if (await reply.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) {
    await reply.hover();
    await page.getByRole('button', { name: 'More actions' }).last().click();
    await page.getByRole('menuitem', { name: 'Add to Planner' }).click();
    const fromMessage = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.sessionRef?.sessionId === agentRun.sessionId && task.notes.startsWith('From "') && !task.deletedAt), 15_000);
    check('"Add to Planner" on a message makes a task linked to the chat', Object.values(fromMessage.state.tasks).some((task) => task.sessionRef?.sessionId === agentRun.sessionId && task.notes.startsWith('From "')));
  } else {
    console.log('INFO the agent did not answer exactly OK; skipped the message action check');
  }
  const composer = page.getByRole('textbox').last();
  await composer.click();
  await composer.fill(`/task ${run} from slash ~15m`);
  await composer.press('Enter');
  const slashed = await waitForState((latest) => Boolean(taskTitled(latest, `${run} from slash`)), 15_000);
  const slashTask = taskTitled(slashed, `${run} from slash`);
  check('/task in a chat adds a task linked to that chat', slashTask?.plannedMinutes === 15 && slashTask?.sessionRef?.sessionId === agentRun.sessionId, JSON.stringify(slashTask ? [slashTask.plannedMinutes, slashTask.sessionRef?.sessionId] : null));
  await page.getByRole('button', { name: 'Open session actions' }).click();
  await page.getByRole('menuitem', { name: 'Track chat in Planner' }).click();
  const tracked = await waitForState((latest) => Object.values(latest.state.runs).filter((item) => item.sessionId === agentRun.sessionId).length >= 2, 15_000);
  check('"Track chat in Planner" links the chat to a new task as its run', Object.values(tracked.state.runs).filter((item) => item.sessionId === agentRun.sessionId).length >= 2);
  await shot('21-chat-actions');

  // Phase 8a: folders, backlog search, Braindump, suggestions, context filter, duplicate, Pomodoro.
  frame = await openPlanner();
  await nav('Backlog').click();
  await frame.getByRole('button', { name: '+ Add folder' }).click();
  await frame.getByRole('textbox', { name: 'New folder name' }).fill(`${run} Reading`);
  await frame.getByRole('textbox', { name: 'New folder name' }).press('Enter');
  await frame.getByRole('heading', { name: `${run} Reading` }).waitFor({ timeout: 10_000 });
  const somedayBucket = frame.locator('section.bucket[aria-label="Someday"]');
  await somedayBucket.getByRole('button', { name: /Add task/ }).click();
  await somedayBucket.getByRole('textbox', { name: 'New task' }).fill(`${run} paper on planning`);
  await somedayBucket.getByRole('textbox', { name: 'New task' }).press('Enter');
  await somedayBucket.getByRole('textbox', { name: 'New task' }).press('Escape');
  const inFolder = await waitForState((latest) => Boolean(taskTitled(latest, `${run} paper on planning`)?.folderId));
  const folderId = taskTitled(inFolder, `${run} paper on planning`)?.folderId;
  check('a task added inside a folder belongs to it', Boolean(folderId) && inFolder.state.folders[folderId]?.name === `${run} Reading`);
  await frame.getByRole('combobox', { name: 'Folder' }).selectOption('none');
  check('the folder filter hides tasks of other folders', (await frame.locator('li.task-card', { hasText: `${run} paper on planning` }).count()) === 0);
  await frame.getByRole('combobox', { name: 'Folder' }).selectOption('');
  await frame.getByRole('textbox', { name: 'Search backlog' }).fill(`${run} paper`);
  await frame.locator('li.task-card', { hasText: `${run} paper on planning` }).waitFor({ timeout: 5000 });
  check('backlog search finds a task by its words', (await frame.locator('.view-scroll li.task-card').count()) === 1);
  await frame.getByRole('textbox', { name: 'Search backlog' }).fill('');

  await frame.getByRole('button', { name: 'Braindump' }).click();
  const dump = frame.getByRole('dialog', { name: 'Braindump' });
  await dump.getByRole('textbox', { name: 'Brain dump' }).fill(`- ${run} call the bank ~15m\n- ${run} renew passport #personal\n- ${run} not this one`);
  await dump.getByRole('button', { name: 'One task per line' }).click();
  await dump.getByRole('checkbox', { name: `Keep ${run} not this one` }).uncheck();
  await dump.getByRole('button', { name: 'Add 2 tasks' }).click();
  const dumped = await waitForState((latest) => Boolean(taskTitled(latest, `${run} call the bank`)) && Boolean(taskTitled(latest, `${run} renew passport`)));
  const bank = taskTitled(dumped, `${run} call the bank`);
  check('Braindump by line adds the kept lines with their syntax', bank?.plannedMinutes === 15 && bank.placement.kind === 'backlog' && !taskTitled(dumped, `${run} not this one`) && dumped.state.channels[taskTitled(dumped, `${run} renew passport`)?.channelId]?.name === 'personal');

  const isGenerate = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/generate';
  await context.route(isGenerate, (route) => route.fulfill({ json: { ok: true, result: { text: JSON.stringify([{ title: `${run} book flights`, minutes: 30, when: 'tomorrow', channel: 'work' }, { title: `${run} pay rent`, minutes: null, when: 'someday', channel: null }]) } } }));
  await frame.getByRole('button', { name: 'Braindump' }).click();
  await dump.getByRole('textbox', { name: 'Brain dump' }).fill('I need to book flights for the trip and pay the rent at some point');
  await dump.getByRole('button', { name: 'Organize with AI' }).click();
  await dump.getByRole('button', { name: 'Add 2 tasks' }).click();
  const organized = await waitForState((latest) => Boolean(taskTitled(latest, `${run} book flights`)));
  const flights = taskTitled(organized, `${run} book flights`);
  check('Braindump with AI adds what the model proposed', flights?.plannedMinutes === 30 && flights.placement.kind === 'day' && taskTitled(organized, `${run} pay rent`)?.placement.kind === 'backlog');
  await context.unroute(isGenerate);

  await nav('Home').click();
  await addInToday(`${run} weekly report ~40m`);
  await frame.locator('section.day-column.is-today li.task-card', { hasText: `${run} weekly report` }).first().getByRole('button', { name: 'Mark complete' }).click();
  await page.waitForTimeout(800);
  await todayCol.getByRole('button', { name: /Add task/ }).click();
  await todayCol.getByRole('textbox', { name: 'New task' }).fill(`${run} weekly report`);
  const suggestedChips = (await todayCol.locator('.chips.suggested').innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ');
  await todayCol.getByRole('textbox', { name: 'New task' }).press('Enter');
  await todayCol.getByRole('textbox', { name: 'New task' }).press('Escape');
  const suggestedState = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.title === `${run} weekly report` && !task.completedAt && !task.deletedAt));
  const suggestedTask = Object.values(suggestedState.state.tasks).find((task) => task.title === `${run} weekly report` && !task.completedAt && !task.deletedAt);
  check('a similar past task suggests the planned time', suggestedChips.includes('≈0:40') && suggestedTask?.plannedMinutes === 40, `${suggestedChips} → ${suggestedTask?.plannedMinutes}`);

  await addInToday(`${run} gym #personal`);
  await frame.getByRole('combobox', { name: 'Filter by channel' }).selectOption('ctx:personal');
  const personalVisible = await todayCol.locator('li.task-card', { hasText: `${run} gym` }).count();
  const workVisible = await todayCol.locator('li.task-card', { hasText: `${run} sort-low` }).count();
  check('the personal context filter shows personal tasks only', personalVisible === 1 && workVisible === 0, `${personalVisible}/${workVisible}`);
  await frame.getByRole('combobox', { name: 'Filter by channel' }).selectOption('');

  const gym = todayCol.locator('li.task-card', { hasText: `${run} gym` }).first();
  await gym.hover();
  await gym.getByRole('button', { name: 'Task actions' }).click();
  await gym.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.waitForTimeout(800);
  check('Duplicate makes a second copy', (await todayCol.locator('li.task-card', { hasText: `${run} gym` }).count()) === 2);

  await nav('Settings').click();
  await frame.getByRole('spinbutton', { name: 'Pomodoro focus minutes' }).fill('1');
  await frame.getByRole('spinbutton', { name: 'Pomodoro focus minutes' }).press('Tab');
  await frame.getByRole('spinbutton', { name: 'Pomodoro break minutes' }).fill('1');
  await frame.getByRole('spinbutton', { name: 'Pomodoro break minutes' }).press('Tab');
  await nav('Focus').click();
  await frame.getByRole('button', { name: 'Start a 1-minute Pomodoro' }).click();
  await frame.locator('.pomodoro-phase.is-focus').waitFor({ timeout: 5000 });
  const focusRunning = Boolean((await waitForState((latest) => Boolean(latest.state.timer))).state.timer);
  await frame.locator('.pomodoro-phase.is-break').waitFor({ timeout: 75_000 });
  const breakState = await waitForState((latest) => !latest.state.timer);
  check('a Pomodoro runs the timer, then stops it for the break', focusRunning && !breakState.state.timer, `${focusRunning} → ${Boolean(breakState.state.timer)}`);
  await frame.getByRole('button', { name: 'Stop Pomodoro' }).click();
  await nav('Settings').click();
  await frame.getByRole('spinbutton', { name: 'Pomodoro focus minutes' }).fill('25');
  await frame.getByRole('spinbutton', { name: 'Pomodoro focus minutes' }).press('Tab');
  await frame.getByRole('spinbutton', { name: 'Pomodoro break minutes' }).fill('5');
  await frame.getByRole('spinbutton', { name: 'Pomodoro break minutes' }).press('Tab');
  await shot('22-settings');

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
  await cleanUp(true);
  check('no page errors from the extension', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
