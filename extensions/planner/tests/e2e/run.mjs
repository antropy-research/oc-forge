// End-to-end check of the Planner extension in the dev OpenChamber.
// Run on the host: node extensions/planner/tests/e2e/run.mjs [baseUrl] [outDir]
// Uses this package's playwright-core with the Chromium in ~/.cache/ms-playwright.
// The UI password is read from the dev container's secrets file and never printed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { makeFilters, page as linearPage } from './linearFake.mjs';

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
    const display = { linearLayout: 'list', linearGroupBy: 'status', linearOrderBy: 'priority', linearImportCompletion: false };
    // The Google phase's fake account must not stay the calendar sessions are written to.
    const googleLeft = state.settings.googleTimebox?.account === 'e2e@example.com';
    // The Planner shows a new account's own calendar once; the journey's fake account must not stay remembered.
    const introduced = state.settings.googleCalendarsIntroduced ?? [];
    const displayChanged = Object.entries(display).some(([key, value]) => state.settings[key] !== undefined && state.settings[key] !== value);
    const commands = [
      // The Linear page's layout is a setting; put it back so the next run starts from the list.
      ...(displayChanged ? [{ cmd: `cleanup-display-${run}-${final ? 'end' : 'start'}`, type: 'settings.updated', patch: display }] : []),
      ...(googleLeft ? [{ cmd: `cleanup-google-${run}-${final ? 'end' : 'start'}`, type: 'settings.updated', patch: { googleTimebox: null } }] : []),
      ...(introduced.includes('e2e@example.com') ? [{ cmd: `cleanup-introduced-${run}-${final ? 'end' : 'start'}`, type: 'settings.updated', patch: { googleCalendarsIntroduced: introduced.filter((email) => email !== 'e2e@example.com') } }] : []),
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

// OpenChamber's own Linear connection may be signed in to a real workspace in the dev container. Until the
// journey's fake Linear takes over (later routes win), the Planner sees no connection and reaches no Linear.
await context.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/oauth/status', (route) => route.fulfill({ json: { connected: false, account: null, hasClient: true, settings: {}, redirectUri: '' } }));
await context.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/request', (route) => route.fulfill({ json: { status: 401, body: JSON.stringify({ errors: [{ message: 'Linear is not connected in this journey yet' }] }) } }));

const page = await context.newPage();
// OpenChamber's own toasts (an OpenCode update offer) can cover the Planner's buttons.
await page.addLocatorHandler(page.getByText('OpenCode update'), async () => {
  // The toast's own Close (an older host had Dismiss); never its Update, which would change the container.
  await page.locator('li.toast', { hasText: 'OpenCode update' }).getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2000 })
    .catch(() => page.getByRole('button', { name: 'Dismiss' }).first().click({ timeout: 2000 }))
    .catch(() => {});
});
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const url = message.location().url ?? '';
  // The Planner's own frames and routes only: OpenChamber's requests for the demo projects say "planner" too.
  // A failed generate is the dev container having no model, not a Planner error.
  const planners = /\/api\/guests\/oc-forge-planner\//.test(url) || /\/api\/guest-files\/[^/]+\/panel\/(main\.js|index\.html)/.test(url);
  if (message.type() === 'error' && planners && !url.includes('/generate')) problems.push(`console: ${message.text()} (${url.replace(/guest-files\/[^/]+/, 'guest-files/…')})`);
});

const openPlanner = async () => {
  // Never reload while the Planner says "Saving…": a change still on its way to the service would be lost, as it
  // would for anyone reloading then. A slow answer from the service made "survives a reload" checks flaky.
  await page.frameLocator('.inset-0 > iframe[title="Planner"]').locator('.save-state.is-saving').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  await page.goto(`${base}/`, { waitUntil: 'load' });
  // The full page sits in the host's inset overlay; the Work Status section is a separate frame.
  // OpenChamber 2.5 serves extension frames from /api/guest-files/<grant>/; their title is the panel name.
  const frame = page.frameLocator('.inset-0 > iframe[title="Planner"]');
  const home = frame.getByRole('heading', { name: 'Home' });
  // OpenChamber 2.5 reopens the page it showed before a reload, and the sidebar's Planner button
  // toggles it; the rail's button (a panel surface) and the Work Status heading share the name.
  if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
    // OpenChamber 2.5.1 has a sidebar button per extension page; 2.5.2 lists them under "Extension pages".
    const button = page.locator('button[aria-label="Planner"]:not([data-context-surface])').first();
    if (await button.isVisible().catch(() => false)) await button.click();
    else {
      await page.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
      await page.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
    }
    await home.waitFor({ timeout: 30_000 });
  }
  return frame;
};

const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });

/**
 * The current chat's menu in OpenChamber's header: its "Open session actions" button, or, with sessions shown as
 * tabs in the header (an OpenChamber setting), the selected tab's "Session tab actions" (shown on hover).
 */
const openChatMenu = async () => {
  const button = page.locator('header button[aria-label="Open session actions"]').first();
  const tab = page.locator('header [role="tab"][aria-selected="true"]').first();
  await button.or(tab).first().waitFor({ timeout: 20_000 });
  if (await button.isVisible().catch(() => false)) return button.click();
  await tab.hover();
  await tab.getByRole('button', { name: 'Session tab actions' }).click({ timeout: 10_000 });
};

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
  // The service's state once the panel has nothing left to save ("Saved"): what a check reads right after a change
  // in the UI, which the panel shows at once and the service has once it answers the panel's command.
  const savedState = async () => {
    await frame.locator('.save-state.is-saving').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    return serviceState();
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

  // Where the week would get too narrow, the unscheduled tasks fold away until asked for.
  const showPanel = frame.getByRole('button', { name: 'Show the task panel' });
  if (await showPanel.count()) await showPanel.click();
  const dragSource = frame.locator('aside li.task-card', { hasText: `${run} sort-low` });
  await dragSource.dragTo(lane, { targetPosition: { x: 40, y: 10 * 48 + 4 } });
  const lowBlock = lane.locator('.grid-item.is-block', { hasText: `${run} sort-low` });
  await lowBlock.waitFor({ timeout: 10_000 });
  // A short block reads "Title, 10am", as Google Calendar writes it; a taller one has the time on its own line ("10 AM").
  check('dragging a task onto the calendar creates a working session at 10 AM', /\b10(?::00)?\s?am\b/i.test(await lowBlock.innerText()), (await lowBlock.innerText()).replace(/\s+/g, ' '));
  await shot('11-calendar');

  const box = await lowBlock.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2 + 48, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterResize = await savedState();
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
  const afterAuto = await savedState();
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
    const moved = Object.values((await savedState()).state.tasks).find((task) => task.title === `${run} sort-low`);
    check('moving a session to the next day moves its task there', moved?.placement?.date === nextKey, JSON.stringify(moved?.placement));
    await frame.getByRole('status').filter({ hasText: 'Session moved' }).getByRole('button', { name: 'Undo' }).click();
    await page.waitForTimeout(800);
    const back = Object.values((await savedState()).state.tasks).find((task) => task.title === `${run} sort-low`);
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

  // Phase 6: Linear. First without a Linear connection (OpenChamber's own is hidden from the journey)…
  const nav = (name) => frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
  await nav('Linear').click();
  await frame.getByRole('heading', { name: 'Linear' }).waitFor();
  await frame.getByRole('button', { name: 'Connect Linear' }).waitFor({ timeout: 10_000 });
  check('without a Linear connection the page offers Connect', true);

  // …then a fake Linear behind the host's own routes, so the real workspace is never touched.
  // Two fake workspaces: OpenChamber's connection (E2E Org) and one added with an API key (Side Org).
  const makeStates = (prefix) => [
    { id: `${prefix}backlog`, name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
    { id: `${prefix}todo`, name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
    { id: `${prefix}prog`, name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    { id: `${prefix}done`, name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
  ];
  const linearStates = makeStates('st-');
  const team = { id: 'team-e2e', key: 'E2E', name: 'E2E Team' };
  const makeIssue = (n, title, stateId, assigned = true) => ({
    id: `iss-${run}-${n}`, identifier: `E2E-${n}`, title: `${run} ${title}`, url: `https://linear.app/e2e/issue/E2E-${n}/x`, priority: 2, dueDate: null, branchName: `e2e/e2e-${n}`,
    updatedAt: new Date().toISOString(), state: linearStates.find((state) => state.id === stateId), team, assignee: assigned ? { id: 'u-e2e', name: 'E2E Linear' } : null,
    project: { id: 'p1', name: 'Planner' }, cycle: null, assigned, description: null, labels: { nodes: [] }, comments: { nodes: [] },
  });
  const linearIssues = [makeIssue(1, 'linear first', 'st-todo'), makeIssue(2, 'linear second', 'st-prog'), makeIssue(3, 'linear third', 'st-backlog'), makeIssue(5, 'linear by url', 'st-todo', false)];
  // Saved views (phase 11): a favorite team view saved as a board grouped by priority, another team
  // view, a workspace view, one of my own, and a view of projects (listed as a list of projects).
  const savedView = (id, name, extra) => ({ id, name: `${run} ${name}`, description: null, icon: null, color: null, shared: true, modelName: 'Issue', slugId: `slug-${id}`, updatedAt: new Date().toISOString(), team: null, owner: { id: 'u-e2e', name: 'E2E Linear' }, ...extra });
  const viewOnlyIssue = { ...makeIssue(31, 'view only bug', 'st-todo', false), priority: 1, labels: { nodes: [{ id: 'lbl-bug', name: 'Bug', color: '#eb5757' }] } };
  const sideStates = makeStates('st-side-');
  const sideTeam = { id: 'team-side', key: 'SIDE', name: 'Side Team' };
  const sideIssue = (n, title, stateId) => ({
    id: `side-${run}-${n}`, identifier: `SIDE-${n}`, title: `${run} ${title}`, url: `https://linear.app/side/issue/SIDE-${n}/x`, priority: 1, dueDate: null, branchName: `side-me/side-${n}-${title.replace(/\s+/g, '-')}`,
    updatedAt: new Date().toISOString(), state: sideStates.find((state) => state.id === stateId), team: sideTeam, assignee: { id: 'u-side', name: 'Side Me' },
    project: { id: 'sp1', name: 'Side Project' }, cycle: null, assigned: true, description: null, labels: { nodes: [] }, comments: { nodes: [] },
  });
  const project = (id, name, statusType, extra) => ({
    id, name, url: `https://linear.app/x/project/${id}`, color: '#26b5ce', icon: null, description: `${name} in one line`, progress: 0.25, health: null, priority: 2, startDate: '2026-10-01', targetDate: '2026-11-30',
    updatedAt: new Date().toISOString(), status: { id: `ps-${statusType}`, name: statusType === 'started' ? 'In Progress' : 'Planned', type: statusType, color: '#f2c94c' }, lead: null, teams: { nodes: [] }, ...extra,
  });
  const linearOrgs = {
    host: {
      org: { id: 'org-e2e', name: 'E2E Org', urlKey: 'e2e' }, viewer: { id: 'u-e2e', name: 'E2E Linear' }, states: linearStates, teams: [team], issues: linearIssues,
      projects: [project('p1', 'Planner', 'started', { progress: 0.4, lead: { id: 'u-e2e', name: 'E2E Linear' }, teams: { nodes: [team] } })],
      members: [{ id: 'u-e2e', name: 'E2E Linear', displayName: 'e2e', active: true }, { id: 'u-mate', name: 'Teammate', displayName: 'mate', active: true }, { id: 'u-gone', name: 'Former', displayName: 'former', active: false }],
      labels: [{ id: 'lbl-bug', name: 'Bug', color: '#eb5757' }, { id: 'lbl-feat', name: 'Feature', color: '#bb87fc' }],
      workspaceLabels: [{ id: 'lbl-cust', name: 'Customer', color: '#4ea7fc' }],
      views: [
        savedView('v-fav', 'Favorite board', { team }),
        savedView('v-team', 'Team triage', { team }),
        savedView('v-ws', 'Company view'),
        savedView('v-mine', 'Mine', { shared: false }),
        savedView('v-proj', 'Projects view', { modelName: 'Project' }),
      ],
      favorites: [{ type: 'customView', sortOrder: 1, customView: { id: 'v-fav' } }, { type: 'project', sortOrder: 0, customView: null }],
      viewIssues: { 'v-fav': { prefs: { layout: 'board', issueGrouping: 'priority', viewOrdering: 'priority' }, issues: () => [...linearIssues.filter((issue) => issue.identifier !== 'E2E-5'), viewOnlyIssue] } },
    },
    side: {
      org: { id: 'org-side', name: 'Side Org', urlKey: 'side' }, viewer: { id: 'u-side', name: 'Side Me' }, states: sideStates, teams: [sideTeam], issues: [sideIssue(1, 'side first', 'st-side-todo'), sideIssue(2, 'side second', 'st-side-todo')],
      projects: [project('sp1', 'Side Project', 'planned', { health: 'atRisk', teams: { nodes: [sideTeam] } })],
      members: [{ id: 'u-side', name: 'Side Me', displayName: 'side', active: true }], labels: [], workspaceLabels: [],
    },
  };
  const linearCalls = [];
  const strip = ({ assigned, ...issue }) => issue;
  const isOpenIssue = (issue) => !['completed', 'canceled'].includes(issue.state.type);
  // The Planner sends its filters to Linear; the fake answers them the way Linear does.
  const filtersOf = (o) => makeFilters({ viewerId: o.viewer.id });
  const answerFor = (o, op, variables) => {
    const find = (id) => o.issues.find((issue) => issue.id === id || issue.identifier === id);
    const where = (list) => filtersOf(o).issuesWhere(list, variables.filter ?? null).map(strip);
    const viewMeta = (item) => ({ ...item, viewPreferencesValues: o.viewIssues?.[item.id]?.prefs ?? null });
    if (op === 'PlannerWhoAmI') return { viewer: o.viewer, organization: o.org };
    if (op === 'PlannerAssigned') return { viewer: { ...o.viewer, assignedIssues: linearPage(where(o.issues.filter((issue) => issue.assigned)), 100, variables.after) } };
    if (op === 'PlannerCreated') return { viewer: { id: o.viewer.id, createdIssues: linearPage([], 100, variables.after) } };
    if (op === 'PlannerIssues') return { issues: linearPage(where(o.issues), 100, variables.after) };
    if (op === 'PlannerViews') return { customViews: { nodes: o.views ?? [], pageInfo: { hasNextPage: false, endCursor: null } } };
    if (op === 'PlannerFavoriteViews') return { favorites: { nodes: o.favorites ?? [] } };
    if (op === 'PlannerView') {
      const found = (o.views ?? []).find((item) => item.id === variables.id);
      return { customView: found ? viewMeta(found) : null };
    }
    if (op === 'PlannerViewIssues') {
      const saved = o.viewIssues?.[variables.id];
      const nodes = where((saved?.issues() ?? []).filter(isOpenIssue));
      return { customView: (o.views ?? []).some((item) => item.id === variables.id) ? { id: variables.id, issues: linearPage(nodes, 100, variables.after) } : null };
    }
    if (op === 'PlannerViewProjects') {
      const found = (o.views ?? []).find((item) => item.id === variables.id);
      return { customView: found ? { id: found.id, projects: linearPage(found.modelName === 'Project' ? o.projects : [], 50, variables.after) } : null };
    }
    if (op === 'PlannerFilterTeams') return { teams: linearPage(o.teams.map((item) => ({ ...item, states: { nodes: o.states } })), 50, variables.after) };
    if (op === 'PlannerFilterUsers') return { users: linearPage(o.members.filter((member) => member.active).map((member) => ({ ...member, isMe: member.id === o.viewer.id })), 250, variables.after) };
    if (op === 'PlannerFilterLabels') return { issueLabels: linearPage([...o.labels.map((label) => ({ ...label, isGroup: false, parent: null, team: { id: o.teams[0].id, key: o.teams[0].key } })), ...o.workspaceLabels.map((label) => ({ ...label, isGroup: false, parent: null, team: null }))], 250, variables.after) };
    if (op === 'PlannerFilterProjects') return { projects: linearPage(o.projects.map((item) => ({ id: item.id, name: item.name, color: item.color, icon: null, status: { type: item.status.type } })), 250, variables.after) };
    if (op === 'PlannerFilterCycles') return { cycles: linearPage([], 250, variables.after) };
    if (op === 'PlannerLinked') return { issues: { nodes: o.issues.filter((issue) => variables.ids.includes(issue.id)).map(strip) } };
    if (op === 'PlannerIssue') return { issue: find(variables.id) ? strip(find(variables.id)) : null };
    if (op === 'PlannerTeamStates') return { team: { id: variables.id, states: { nodes: o.states } } };
    if (op === 'PlannerTeams') return { viewer: { id: o.viewer.id }, teams: { nodes: o.teams } };
    if (op === 'PlannerSearch') return { searchIssues: linearPage(where(o.issues.filter((issue) => issue.title.includes(variables.term))), 50, variables.after) };
    if (op === 'PlannerProjects') return { projects: { nodes: o.projects, pageInfo: { hasNextPage: false, endCursor: null } } };
    if (op === 'PlannerProject') {
      const found = o.projects.find((item) => item.id === variables.id);
      return {
        project: found ? {
          ...found, content: `${found.name} long description`,
          projectMilestones: { nodes: [{ id: 'm1', name: `${found.name} beta`, targetDate: '2026-11-15', progress: 0.5, sortOrder: 1 }] },
          lastUpdate: { id: 'u1', body: `${found.name} is slipping a little`, health: found.health ?? 'onTrack', createdAt: new Date().toISOString(), url: `${found.url}/updates`, user: o.viewer },
        } : null,
      };
    }
    if (op === 'PlannerSetState') {
      const issue = find(variables.id);
      const state = o.states.find((item) => item.id === variables.stateId);
      // A state from the other workspace would mean the move went to the wrong place.
      if (!issue || !state) return null;
      issue.state = state;
      return { issueUpdate: { success: true, issue: strip(issue) } };
    }
    if (op === 'PlannerIssueDetail') return { issue: find(variables.id) ? strip(find(variables.id)) : null };
    if (op === 'PlannerTeamOptions') return { team: { id: variables.id, states: { nodes: o.states }, members: { nodes: o.members }, labels: { nodes: o.labels } }, issueLabels: { nodes: o.workspaceLabels } };
    if (op === 'PlannerUpdateIssue') {
      const issue = find(variables.id);
      const input = variables.input ?? {};
      if (!issue) return null;
      if ('stateId' in input) {
        const state = o.states.find((item) => item.id === input.stateId);
        if (!state) return null;
        issue.state = state;
      }
      for (const field of ['title', 'description', 'priority', 'dueDate']) if (field in input) issue[field] = input[field];
      if ('assigneeId' in input) issue.assignee = input.assigneeId ? o.members.find((member) => member.id === input.assigneeId) ?? null : null;
      const allLabels = [...o.labels, ...o.workspaceLabels];
      for (const id of input.addedLabelIds ?? []) if (!issue.labels.nodes.some((label) => label.id === id)) issue.labels.nodes.push(allLabels.find((label) => label.id === id));
      if (input.removedLabelIds) issue.labels.nodes = issue.labels.nodes.filter((label) => !input.removedLabelIds.includes(label.id));
      issue.updatedAt = new Date().toISOString();
      return { issueUpdate: { success: true, issue: strip(issue) } };
    }
    if (op === 'PlannerAddComment') {
      const issue = find(variables.input.issueId);
      if (!issue) return null;
      const comment = { id: `c-${issue.comments.nodes.length + 1}`, body: variables.input.body, createdAt: new Date().toISOString(), editedAt: null, user: { id: o.viewer.id, name: o.viewer.name }, botActor: null, parent: null };
      issue.comments.nodes.push(comment);
      return { commentCreate: { success: true, comment } };
    }
    if (op === 'PlannerCreateIssue') {
      const issue = makeIssue(o.issues.length + 10, 'x', 'st-todo');
      issue.title = variables.input.title;
      o.issues.push(issue);
      return { issueCreate: { success: true, issue: strip(issue) } };
    }
    return null;
  };
  const isRequestRoute = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/request';
  const isStatusRoute = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/oauth/status';
  await context.route(isStatusRoute, (route) => route.fulfill({ json: { connected: true, account: 'E2E Linear', hasClient: true, settings: {}, redirectUri: '' } }));
  await context.route(isRequestRoute, async (route) => {
    const { query, variables = {} } = JSON.parse(route.request().postDataJSON().body);
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    linearCalls.push({ op, variables });
    const data = answerFor(linearOrgs.host, op, variables);
    const answer = data ? { data } : { errors: [{ message: `unexpected ${op}` }] };
    await route.fulfill({ json: { status: 200, body: JSON.stringify(answer) } });
  });

  frame = await openPlanner();
  await nav('Linear').click();
  // The Linear page lays issues out as Linear does: one line per issue, in groups of exact workflow states.
  const issueRow = (n) => frame.locator('.linear-page li.lin-row, .linear-page li.lin-card', { hasText: new RegExp(`E2E-${n}(?!\\d)`) }).first();
  const linearNav = () => frame.getByRole('navigation', { name: 'Linear sections' });
  const openDisplay = async () => {
    await frame.locator('.linear-page').getByRole('button', { name: 'Display', exact: true }).click();
    const menu = frame.getByRole('dialog', { name: 'Display options' });
    await menu.waitFor({ timeout: 5000 });
    return menu;
  };
  const closeDisplay = () => frame.locator('.linear-page').getByRole('button', { name: 'Display', exact: true }).click();
  const chooseIn = async (menu, name, option) => {
    await menu.getByRole('button', { name: new RegExp(`^${name}: `) }).click();
    await menu.getByRole('dialog', { name }).getByRole('option', { name: option, exact: true }).click();
  };
  await issueRow(1).waitFor({ timeout: 15_000 });
  const groups = await frame.locator('.linear-page .lin-group-head .lin-group-name').allInnerTexts();
  check('My issues lists assigned open issues grouped by state', groups.join('|').includes('In Progress') && groups.join('|').includes('Todo') && groups.join('|').includes('Backlog'), groups.join(' | '));
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

  // Phase 9: more Linear workspaces, projects, grouping, the board and Linear's branch names (after Orca).
  // A key Linear does not accept goes through the real service, which asks Linear and refuses it.
  await frame.getByRole('textbox', { name: 'Linear API key' }).fill(`lin_api_e2e-made-up-key-${run}`);
  await frame.getByRole('button', { name: 'Add workspace' }).click();
  const refusal = frame.getByRole('alert').filter({ hasText: /rejected the key|reach Linear|Linear answered/ });
  check('a key Linear does not accept is refused', await refusal.waitFor({ timeout: 30_000 }).then(() => true).catch(() => false), (await refusal.innerText().catch(() => '')).slice(0, 100));
  // From here the service's workspace endpoints answer for a fake second workspace.
  const sideWorkspace = { id: 'org-side', name: 'Side Org', urlKey: 'side', account: 'Side Me', addedAt: new Date().toISOString() };
  let sideConnected = false;
  const sideCalls = [];
  const isServiceRoute = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/service/request';
  await context.route(isServiceRoute, async (route) => {
    const outer = route.request().postDataJSON();
    if (!outer?.path?.startsWith('/linear/')) return route.continue();
    let payload;
    if (outer.path === '/linear/workspaces' && outer.method === 'GET') payload = { workspaces: sideConnected ? [sideWorkspace] : [] };
    else if (outer.path === '/linear/workspaces' && outer.method === 'POST') {
      sideConnected = true;
      payload = { workspace: sideWorkspace };
    } else if (outer.path === `/linear/workspaces/${sideWorkspace.id}` && outer.method === 'DELETE') {
      sideConnected = false;
      payload = { removed: true };
    } else if (outer.path === '/linear/graphql') {
      const { workspaceId, query, variables = {} } = JSON.parse(outer.body);
      const op = /(?:query|mutation) (\w+)/.exec(query)?.[1];
      sideCalls.push({ workspaceId, op, variables });
      const data = workspaceId === sideWorkspace.id ? answerFor(linearOrgs.side, op, variables) : null;
      payload = { status: 200, body: JSON.stringify(data ? { data } : { errors: [{ message: `unexpected ${op} in ${workspaceId}` }] }) };
    }
    await route.fulfill({ json: payload ? { status: 200, body: JSON.stringify(payload) } : { status: 404, body: JSON.stringify({ error: 'not found' }) } });
  });
  await frame.getByRole('textbox', { name: 'Linear API key' }).fill(`lin_api_e2e-side-key-${run}`);
  await frame.getByRole('button', { name: 'Add workspace' }).click();
  const workspaceList = frame.getByRole('list', { name: 'Linear workspaces' });
  await workspaceList.locator('li', { hasText: 'Side Org' }).waitFor({ timeout: 10_000 });
  check('a second workspace can be added with an API key', (await workspaceList.innerText()).includes('E2E Org'), (await workspaceList.innerText()).replace(/\s+/g, ' '));

  await nav('Linear').click();
  const sideRow = (n) => frame.locator('.linear-page li.lin-row, .linear-page li.lin-card', { hasText: new RegExp(`SIDE-${n}(?!\\d)`) }).first();
  await sideRow(1).waitFor({ timeout: 15_000 });
  check('All workspaces merges the issues of both, each marked with its workspace', (await issueRow(3).count()) === 1 && (await sideRow(1).locator('.ws-badge').innerText()) === 'Side Org');
  let displayMenu = await openDisplay();
  await chooseIn(displayMenu, 'Grouping', 'Workspace');
  await closeDisplay();
  await frame.locator('.linear-page .lin-group-head', { hasText: 'Side Org' }).waitFor({ timeout: 10_000 });
  const workspaceGroups = await frame.locator('.linear-page .lin-group-head .lin-group-name').allInnerTexts();
  check('issues group by workspace', workspaceGroups.join('|') === 'E2E Org|Side Org', workspaceGroups.join(' | '));
  const chooseWorkspace = async (option) => {
    await frame.getByRole('button', { name: /^Linear workspace: / }).click();
    await frame.getByRole('dialog', { name: 'Linear workspace' }).getByRole('option', { name: option }).click();
  };
  await chooseWorkspace(/^Side Org/);
  await frame.locator('.linear-page li.lin-row', { hasText: /E2E-\d/ }).first().waitFor({ state: 'detached', timeout: 10_000 });
  // The other workspace's rows go before this one's arrive: wait for them.
  check('one workspace can be shown on its own', await sideRow(2).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false) && (await frame.locator('.linear-page li.lin-row', { hasText: /E2E-\d/ }).count()) === 0);
  await chooseWorkspace('All workspaces');
  displayMenu = await openDisplay();
  await chooseIn(displayMenu, 'Grouping', 'Status');
  await displayMenu.getByRole('radio', { name: 'Board' }).click();
  await closeDisplay();
  const column = (label) => frame.locator(`.lin-board section.board-column[aria-label="${label}"]`);
  await column('Todo').locator('li.lin-card', { hasText: /SIDE-1(?!\d)/ }).waitFor({ timeout: 10_000 });
  // Both workspaces' teams have the same four states, one column each, in workflow order.
  check('the board shows status columns in workflow order', (await frame.locator('.lin-board section.board-column').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))).join('|') === 'Backlog|Todo|In Progress|Done');
  await shot('26-linear-board');
  // A drag cannot scroll the board on its way: the source column goes to the left edge first.
  await column('Todo').evaluate((element) => element.scrollIntoView({ inline: 'start', block: 'nearest' }));
  await column('Todo').locator('li.lin-card', { hasText: /SIDE-1(?!\d)/ }).dragTo(column('In Progress'));
  await column('In Progress').locator('li.lin-card', { hasText: /SIDE-1(?!\d)/ }).waitFor({ timeout: 10_000 });
  const boardMove = sideCalls.find((call) => call.op === 'PlannerSetState' && call.variables.id === `side-${run}-1`);
  check('dropping a card on a column moves the issue in its own workspace', boardMove?.workspaceId === 'org-side' && boardMove.variables.stateId === 'st-side-prog', JSON.stringify(boardMove ?? null));

  await linearNav().getByRole('button', { name: 'All projects', exact: true }).click();
  await frame.getByRole('button', { name: 'Open project Side Project' }).waitFor({ timeout: 10_000 });
  check('Projects lists the open projects of every workspace', (await frame.getByRole('button', { name: 'Open project Planner' }).count()) === 1);
  await frame.getByRole('button', { name: 'Open project Side Project' }).click();
  const projectView = frame.locator('.project-detail');
  await projectView.getByRole('heading', { name: 'Side Project' }).waitFor({ timeout: 10_000 });
  await projectView.getByRole('button', { name: 'Plan SIDE-2 today' }).waitFor({ timeout: 10_000 });
  const facts = (await projectView.locator('.project-facts').innerText()).replace(/\s+/g, ' ');
  check('a project shows status, progress and health', facts.includes('Planned') && facts.includes('25%') && facts.includes('At risk'), facts);
  await projectView.getByRole('button', { name: 'Plan SIDE-2 today' }).click();
  const plannedSide = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.source?.key === 'SIDE-2' && !task.deletedAt));
  const sideTask = Object.values(plannedSide.state.tasks).find((task) => task.source?.key === 'SIDE-2' && !task.deletedAt);
  check('planning a project issue links it with its workspace and branch', sideTask?.source?.workspaceId === 'org-side' && sideTask.source.branch === 'side-me/side-2-side-second', JSON.stringify(sideTask?.source ?? null).slice(0, 200));
  await projectView.getByRole('tab', { name: 'Overview' }).click();
  await projectView.getByText('Side Project beta').waitFor({ timeout: 5000 });
  check('the project overview shows milestones and the latest update', (await projectView.innerText()).includes('Side Project is slipping a little'));
  await shot('27-linear-project');
  await projectView.getByRole('button', { name: '← All projects' }).click();

  await linearNav().getByRole('button', { name: 'Planned', exact: true }).click();
  const plannedToday = frame.locator('section.issue-group[aria-label="Planned Today"]');
  await plannedToday.locator('li', { hasText: /SIDE-2(?!\d)/ }).waitFor({ timeout: 10_000 });
  check('Planned lists the Linear issues already in the plan', (await plannedToday.locator('li', { hasText: /SIDE-2(?!\d)/ }).locator('.ws-badge').innerText()) === 'Side Org');

  await nav('Today').click();
  await linearCard('side second').getByRole('button', { name: 'Mark complete' }).click();
  const sidePrompt = frame.getByRole('alertdialog', { name: 'Update SIDE-2 in Linear' });
  await sidePrompt.waitFor({ timeout: 10_000 });
  await sidePrompt.getByRole('button', { name: 'Move' }).click();
  await page.waitForTimeout(1500);
  const sideDone = sideCalls.find((call) => call.op === 'PlannerSetState' && call.variables.id === `side-${run}-2`);
  check('completing it moves the issue to Done in its own workspace, not through OpenChamber', sideDone?.variables.stateId === 'st-side-done' && !linearCalls.some((call) => call.variables?.id === `side-${run}-2`), JSON.stringify(sideDone ?? null));

  await nav('Linear').click();
  await linearNav().getByRole('button', { name: 'Assigned', exact: true }).click();
  await frame.getByRole('button', { name: 'Plan SIDE-1 today' }).click();
  await nav('Today').click();
  await linearCard('side first').getByRole('button', { name: new RegExp(`Open ${run} side first`) }).click();
  const sideDialog = frame.getByRole('dialog', { name: 'Task details' });
  await sideDialog.getByRole('button', { name: 'Send to an agent' }).click();
  await sideDialog.getByRole('combobox', { name: 'Agent workspace' }).selectOption('new');
  const suggestedBranch = await sideDialog.getByRole('textbox', { name: 'Worktree branch' }).inputValue();
  check("an agent's new worktree defaults to Linear's branch name", suggestedBranch === 'side-me/side-1-side-first', suggestedBranch);
  check('the task shows which workspace its issue is in', (await sideDialog.locator('section[aria-label="Linear"] .ws-badge').innerText()) === 'Side Org');
  await sideDialog.getByRole('button', { name: 'Cancel' }).click();
  await sideDialog.getByRole('button', { name: 'Close' }).click();

  await nav('Settings').click();
  await frame.getByRole('button', { name: 'Remove the Linear workspace Side Org' }).click();
  await workspaceList.locator('li', { hasText: 'Side Org' }).waitFor({ state: 'detached', timeout: 10_000 });
  await nav('Linear').click();
  await issueRow(3).waitFor({ timeout: 10_000 });
  check('removing a workspace takes its issues away', (await frame.locator('.linear-page li.lin-card, .linear-page li.lin-row', { hasText: /SIDE-\d/ }).count()) === 0);
  displayMenu = await openDisplay();
  await displayMenu.getByRole('radio', { name: 'List' }).click();
  await closeDisplay();
  await context.unroute(isServiceRoute);

  // Phase 10: edit a Linear issue in the Planner, in Markdown.
  const until = async (test, timeout = 10_000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) {
      const value = test();
      if (value) return value;
    }
    return null;
  };
  const updates = () => linearCalls.filter((call) => call.op === 'PlannerUpdateIssue');
  const edited = linearOrgs.host.issues.find((issue) => issue.identifier === 'E2E-3');
  edited.description = '### Plan\nFix **the agent** and `a < b`, see [docs](https://example.com/docs).\n<img src=x onerror=alert(1)> [bad](javascript:alert(1))\n\n- [ ] write tests\n- [x] read the code';
  edited.comments.nodes.push({ id: 'c-0', body: 'Earlier _note_', createdAt: '2026-10-20T10:00:00.000Z', editedAt: null, user: { id: 'u-mate', name: 'Teammate' }, botActor: null, parent: null });
  await frame.getByRole('button', { name: 'Edit E2E-3' }).click();
  const issueEditor = frame.getByRole('dialog', { name: 'Linear issue E2E-3' });
  const shown = issueEditor.locator('section.issue-description .md');
  await shown.locator('.md-h3').waitFor({ timeout: 10_000 });
  const rendered = {
    heading: await shown.locator('.md-h3').innerText(),
    strong: await shown.locator('strong').innerText(),
    code: await shown.locator('code').first().innerText(),
    link: await shown.getByRole('link', { name: 'docs' }).getAttribute('href'),
    images: await issueEditor.locator('img').count(),
    scriptLinks: await issueEditor.locator('a[href^="javascript"]').count(),
    rawHtmlAsText: (await shown.innerText()).includes('<img src=x onerror=alert(1)>'),
    boxes: await shown.getByRole('checkbox').count(),
  };
  check('the description renders as Markdown; raw HTML and script links stay inert', rendered.heading === 'Plan' && rendered.strong === 'the agent' && rendered.code === 'a < b' && rendered.link === 'https://example.com/docs' && rendered.images === 0 && rendered.scriptLinks === 0 && rendered.rawHtmlAsText && rendered.boxes === 2, JSON.stringify(rendered));
  await shown.getByRole('checkbox', { name: 'Tick this item', exact: true }).click();
  const ticked = await until(() => updates().find((call) => call.variables.input.description?.includes('- [x] write tests')));
  check('ticking a checklist item saves the Markdown to Linear', Boolean(ticked) && Object.keys(ticked.variables.input).join() === 'description', JSON.stringify(ticked?.variables.input ?? null).slice(0, 120));
  await shown.getByRole('checkbox', { name: 'Tick this item', exact: true }).waitFor({ state: 'detached', timeout: 10_000 });

  await issueEditor.getByRole('button', { name: 'Edit title and description' }).click();
  await issueEditor.getByRole('textbox', { name: 'Issue title' }).fill(`${run} linear third edited`);
  const descriptionBox = issueEditor.getByRole('textbox', { name: 'Issue description' });
  await descriptionBox.fill(`${await descriptionBox.inputValue()}\n\n## Next\n- [ ] ship it`);
  await issueEditor.getByRole('tablist', { name: 'Issue description mode' }).getByRole('tab', { name: 'Preview' }).click();
  await issueEditor.locator('.md-preview .md-h2', { hasText: 'Next' }).waitFor({ timeout: 5000 });
  check('Preview shows the Markdown being written', (await issueEditor.locator('.md-preview').getByRole('checkbox').count()) === 3);
  await issueEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await issueEditor.getByRole('heading', { name: `${run} linear third edited` }).waitFor({ timeout: 10_000 });
  const savedText = updates().at(-1)?.variables.input;
  const followed = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.title === `${run} linear third edited` && !task.deletedAt));
  check(
    'saving sends the title and the Markdown description; the linked task follows the title',
    savedText?.title === `${run} linear third edited` && savedText.description.endsWith('## Next\n- [ ] ship it') && Object.values(followed.state.tasks).some((task) => task.title === `${run} linear third edited`),
    JSON.stringify(savedText ?? null).slice(0, 160),
  );

  edited.description = 'Rewritten by a teammate';
  await issueEditor.getByRole('button', { name: 'Edit title and description' }).click();
  await issueEditor.getByRole('textbox', { name: 'Issue description' }).fill('My version');
  await issueEditor.getByRole('button', { name: 'Save', exact: true }).click();
  const conflictBanner = issueEditor.getByRole('alert').filter({ hasText: 'changed this issue in Linear' });
  await conflictBanner.waitFor({ timeout: 10_000 });
  check('an edit that would overwrite a change made in Linear meanwhile is held back', edited.description === 'Rewritten by a teammate');
  await conflictBanner.getByRole('button', { name: 'Replace it with mine' }).click();
  check('…and goes through once I choose to replace it', Boolean(await until(() => edited.description === 'My version')));
  await issueEditor.getByRole('button', { name: 'Edit title and description' }).waitFor({ timeout: 10_000 });

  // The properties sidebar: each property opens a searchable menu.
  const property = (name) => issueEditor.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: new RegExp(`^${name}: `) });
  const pickIn = async (name, menu, option) => {
    await property(name).click();
    await issueEditor.getByRole('dialog', { name: menu }).getByRole('option', { name: option }).first().click();
  };
  await property('Assignee').click();
  await issueEditor.getByRole('dialog', { name: 'Assign to' }).waitFor({ timeout: 10_000 });
  const formerListed = await issueEditor.getByRole('dialog', { name: 'Assign to' }).getByRole('option', { name: /Former/ }).count();
  await page.keyboard.press('Escape');
  await pickIn('Priority', 'Change priority', 'Urgent');
  await until(() => updates().find((call) => call.variables.input.priority === 1));
  await pickIn('Assignee', 'Assign to', /^Teammate/);
  await until(() => updates().find((call) => call.variables.input.assigneeId === 'u-mate'));
  await pickIn('Status', 'Change status', 'In Progress');
  await until(() => updates().find((call) => call.variables.input.stateId === 'st-prog'));
  await pickIn('Labels', 'Change labels', 'Bug');
  await until(() => updates().find((call) => call.variables.input.addedLabelIds?.includes('lbl-bug')));
  await page.keyboard.press('Escape');
  await property('Due date').click();
  await issueEditor.getByRole('dialog', { name: 'Change due date' }).locator('input[aria-label="Issue due date"]').fill('2026-11-02');
  await issueEditor.getByRole('dialog', { name: 'Change due date' }).getByRole('button', { name: 'Set' }).click();
  await until(() => updates().find((call) => call.variables.input.dueDate === '2026-11-02'));
  const fieldInputs = updates().map((call) => Object.keys(call.variables.input).join('+'));
  check(
    'status, priority, assignee, labels and due date each go to Linear at once',
    ['priority', 'assigneeId', 'stateId', 'addedLabelIds', 'dueDate'].every((field) => fieldInputs.includes(field)) && edited.state.id === 'st-prog' && edited.labels.nodes.some((label) => label.id === 'lbl-bug') && formerListed === 0,
    fieldInputs.join(', '),
  );
  const syncedState = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.source?.key === 'E2E-3' && task.source.status?.name === 'In Progress'));
  check('the linked task shows the new status', Object.values(syncedState.state.tasks).some((task) => task.source?.key === 'E2E-3' && task.source.status?.name === 'In Progress'));

  const commentBox = issueEditor.getByRole('textbox', { name: 'New comment' });
  await commentBox.click();
  await issueEditor.getByRole('button', { name: 'Bold' }).click();
  await page.waitForTimeout(150);
  await page.keyboard.type('LGTM');
  check('the toolbar writes Markdown', (await commentBox.inputValue()) === '**LGTM**', await commentBox.inputValue());
  await issueEditor.getByRole('button', { name: 'Comment', exact: true }).click();
  await issueEditor.locator('.comment-list li', { hasText: 'LGTM' }).locator('.md strong').waitFor({ timeout: 10_000 });
  const posted = linearCalls.find((call) => call.op === 'PlannerAddComment');
  check(
    'a Markdown comment is posted and shown under the earlier ones',
    posted?.variables.input.body === '**LGTM**' && (await issueEditor.locator('.comment-list li').count()) === 2 && (await issueEditor.locator('.comment-list li').first().locator('em').innerText()) === 'note',
    JSON.stringify(posted?.variables.input ?? null),
  );
  await shot('28-issue-editor');
  await page.keyboard.press('Escape');
  await issueEditor.waitFor({ state: 'detached', timeout: 5000 });

  await nav('Today').click();
  await linearCard('linear third edited').getByRole('button', { name: new RegExp(`Open ${run} linear third edited`) }).click();
  const thirdTask = frame.getByRole('dialog', { name: 'Task details' });
  await thirdTask.getByRole('button', { name: 'Edit issue' }).click();
  await issueEditor.locator('.issue-title-view').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await issueEditor.waitFor({ state: 'detached', timeout: 5000 });
  check('from a task, Escape closes the issue editor and leaves the task open', await thirdTask.isVisible());
  await thirdTask.getByRole('button', { name: 'Close' }).click();

  // Phase 11: the views saved in Linear, opened as saved, and Linear's temporary filters.
  await nav('Linear').click();
  await linearNav().getByRole('button', { name: 'Assigned', exact: true }).click();
  const favoritesGroup = linearNav().getByRole('group', { name: 'Favorites' });
  await favoritesGroup.waitFor({ timeout: 15_000 });
  const favoriteNames = await favoritesGroup.locator('.lin-nav-label').allInnerTexts();
  const pickerGroups = await linearNav().getByRole('group', { name: 'Views' }).getByRole('group').evaluateAll((items) => items.map((item) => `${item.getAttribute('aria-label')}: ${[...item.querySelectorAll('.lin-nav-label')].map((label) => label.textContent).join(', ')}`));
  check(
    'the sidebar lists favorites, then every view by team, workspace and mine, views of projects too',
    favoriteNames.join(', ') === `${run} Favorite board` && pickerGroups.join(' | ') === `E2E · E2E Team: ${run} Favorite board, ${run} Team triage | Workspace views: ${run} Company view, ${run} Projects view | My views: ${run} Mine`,
    `${favoriteNames.join(', ')} · ${pickerGroups.join(' | ')}`,
  );
  await favoritesGroup.getByRole('button', { name: `${run} Favorite board`, exact: true }).click();
  const viewRow = frame.locator('.linear-page li.lin-card, .linear-page li.lin-row', { hasText: 'E2E-31' });
  await viewRow.waitFor({ timeout: 15_000 });
  const boardColumns = await frame.locator('.lin-board section.board-column').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  // A board shows every priority as a column, as Linear's boards show empty columns.
  check('a saved view opens with its own layout and grouping (a board by priority)', boardColumns.join('|') === 'Urgent|High|Medium|Low|No priority', boardColumns.join('|'));
  check("opening a view does not change the Planner's own display settings", (await savedState()).state.settings.linearLayout === 'list');
  await shot('31-linear-view');

  const filterBar = frame.locator('.linear-page .lin-filters').first();
  const shownRows = () => frame.locator('.linear-page li.lin-card, .linear-page li.lin-row').count();
  // What the fake view holds now (earlier phases moved and labelled some of its issues).
  const inView = () => linearOrgs.host.viewIssues['v-fav'].issues().filter(isOpenIssue);
  const shownKeys = async () => (await frame.locator('.linear-page li.lin-card, .linear-page li.lin-row').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? ''))).map((label) => /^E2E-\d+/.exec(label)?.[0]).sort();
  const keysWhere = (test) => inView().filter(test).map((issue) => issue.identifier).sort();
  const allInView = await shownRows();
  // Filters go to Linear as an IssueFilter; the fake Linear answers them as Linear does.
  await filterBar.getByRole('button', { name: 'Filter', exact: true }).click();
  await frame.getByRole('dialog', { name: 'Filter' }).getByRole('option', { name: 'Status' }).click();
  const statusMenu = frame.getByRole('dialog', { name: 'Filter by Status' });
  await statusMenu.getByRole('option', { name: 'Todo' }).click();
  await filterBar.getByRole('button', { name: 'Edit filter: Status is Todo' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await statusMenu.waitFor({ state: 'detached', timeout: 5000 });
  const expectedTodo = keysWhere((issue) => issue.state.name === 'Todo');
  const todoOnly = (await until(async () => ((await shownKeys()).join() === expectedTodo.join() ? shownKeys() : null))) ?? (await shownKeys());
  check('a status filter keeps only those issues, and says how many', todoOnly.join() === expectedTodo.join() && todoOnly.length < allInView && (await frame.locator('.linear-page .lin-count').innerText()).startsWith(`${todoOnly.length} issue`), `${todoOnly.join(', ')} (want ${expectedTodo.join(', ')}) of ${allInView}`);
  await filterBar.getByRole('button', { name: 'Operator of Status: is' }).click();
  await frame.getByRole('dialog', { name: 'Status filter operator' }).getByRole('option', { name: 'is not' }).click();
  await filterBar.getByRole('button', { name: 'Edit filter: Status is not Todo' }).waitFor({ timeout: 5000 });
  await until(async () => (await shownRows()) === allInView - todoOnly.length);
  check('"is not" turns the filter around', (await frame.locator('.linear-page li.lin-card, .linear-page li.lin-row', { hasText: /E2E-31(?!\d)/ }).count()) === 0 && (await shownRows()) === allInView - todoOnly.length);
  await filterBar.getByRole('button', { name: 'Remove filter: Status is not Todo' }).click();
  await filterBar.getByRole('button', { name: 'Filter', exact: true }).click();
  await frame.getByRole('dialog', { name: 'Filter' }).getByRole('option', { name: 'Labels' }).click();
  await frame.getByRole('dialog', { name: 'Filter by Labels' }).getByRole('option', { name: 'Bug' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const expectedBug = keysWhere((issue) => issue.labels.nodes.some((label) => label.name === 'Bug'));
  check('a label filter keeps the issues that have it', (await shownKeys()).join() === expectedBug.join() && expectedBug.includes('E2E-31'), `${(await shownKeys()).join(', ')} (want ${expectedBug.join(', ')})`);
  await shot('32-linear-filters');

  // Assign an issue to an agent from its row: the assignee picker; "More options…" plans it today and opens the assignment.
  await viewRow.getByRole('button', { name: 'Assign E2E-31 to an agent' }).click();
  await frame.getByRole('dialog', { name: 'Assign to an agent' }).getByRole('button', { name: 'More options…' }).click();
  const assignFromRow = frame.getByRole('dialog', { name: 'Task details' }).getByRole('group', { name: 'Assign to an agent' });
  await assignFromRow.waitFor({ timeout: 10_000 });
  const rowBranch = await assignFromRow.getByRole('textbox', { name: 'Worktree branch' }).inputValue();
  const rowTask = Object.values((await savedState()).state.tasks).find((task) => task.title === `${run} view only bug` && !task.deletedAt);
  check("an issue row's Agent plans it today and opens the assignment on Linear's branch name", rowBranch === 'e2e/e2e-31' && rowTask?.placement.kind === 'day' && rowTask.source?.key === 'E2E-31', `${rowBranch} · ${JSON.stringify(rowTask?.placement ?? null)}`);
  await assignFromRow.getByRole('button', { name: 'Cancel' }).click();
  await frame.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click();

  await linearNav().getByRole('button', { name: 'Assigned', exact: true }).click();
  await issueRow(3).waitFor({ timeout: 10_000 });
  check("another list starts without filters, in the Planner's own display", (await filterBar.locator('.lin-chip').count()) === 0 && (await frame.locator('.lin-board').count()) === 0);

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
  const afterStart = await savedState();
  check('starting twice quickly makes one run (no duplicate dispatch)', runsOf(afterStart, agentTitle).length === 1, `${runsOf(afterStart, agentTitle).length} runs`);
  const agentRun = runsOf(afterStart, agentTitle)[0];
  check('the run keeps project, directory and session', Boolean(agentRun?.sessionId && agentRun.projectId && agentRun.directory?.endsWith('planner-demo-a')), JSON.stringify(agentRun ?? null).slice(0, 160));
  // A turn ends ready for review, or failed when the model could not answer.
  const settledRow = firstAgent.dialog.locator('li.run-row', { hasText: /Ready for review|Agent run failed/ }).first();
  const settled = await settledRow.waitFor({ timeout: 180_000 }).then(() => settledRow.innerText()).catch(() => '');
  const reviewed = settled.includes('Ready for review');
  if (reviewed) {
    check('a finished turn shows as Ready for review', true);
  } else {
    // Tell a slow or failing model apart from a stale Planner: ask OpenCode how the turn ended.
    const messages = await (await context.request.get(`${base}/api/session/${agentRun.sessionId}/message?directory=${encodeURIComponent(agentRun.directory)}`)).json().catch(() => []);
    // OpenCode v2 names a message's author `type`; v1 said `role`.
    const ended = (Array.isArray(messages) ? messages : messages.data ?? []).map((message) => message.info ?? message).filter((info) => (info.role ?? info.type) === 'assistant' && info.time?.completed);
    const failure = ended.map((info) => info.error).find(Boolean);
    const shown = await firstAgent.dialog.locator('li.run-row').first().innerText().catch(() => '');
    if (failure) {
      // The dev container's free model has a usage limit; its error ends the turn. OpenChamber reports
      // a failed turn only when OpenCode sends session.error; otherwise the run just goes idle.
      const said = String(failure.data?.message ?? failure.message ?? failure.name ?? 'an error').slice(0, 160);
      check('a turn the model could not finish is not shown as running or ready for review', /Agent run failed|Agent idle/.test(shown) && !/Agent working|Ready for review/.test(shown), `${shown.split('\n')[0]} · the model said: ${said}`);
      console.log(`INFO the dev container's model did not answer (${said}); skipped the review checks`);
    } else if (ended.some((info) => info.finish)) check('a finished turn shows as Ready for review', false, `OpenCode finished the turn but the Planner shows: ${shown.split('\n')[0]}`);
    else console.log("INFO the dev container's free model did not finish within 3 minutes; skipped the review checks");
  }
  check('a finished turn does not complete the task', !taskTitled(await savedState(), agentTitle)?.completedAt);
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
  const worktreeRun = runsOf(await waitForState((latest) => Boolean(runsOf(latest, worktreeTitle)[0]?.worktree), 30_000), worktreeTitle)[0];
  check('an agent can work in a new worktree', worktreeRun?.worktree?.branch === branchName, JSON.stringify(worktreeRun?.worktree ?? null));
  await secondAgent.dialog.getByRole('button', { name: 'Close' }).click();

  // Phase 12: assign a task to an agent, as in GitHub or Linear: a new worktree, then a pull request.
  await nav('Home').click();
  const assignTitle = `${run} assigned task`;
  await addInToday(assignTitle);
  const assignCard = frame.locator('section.day-column.is-today li.task-card', { hasText: assignTitle });
  await assignCard.hover();
  await assignCard.getByRole('button', { name: 'Task actions' }).click();
  await assignCard.getByRole('menuitem', { name: 'Assign to an agent' }).click();
  const cardPicker = frame.getByRole('dialog', { name: 'Assign to an agent' });
  check('"Assign to an agent…" in the card menu opens the assignee picker on the card', await cardPicker.getByRole('group', { name: 'Agents' }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  await cardPicker.getByRole('button', { name: 'More options…' }).click();
  const assignDialog = frame.getByRole('dialog', { name: 'Task details' });
  const assignForm = assignDialog.getByRole('group', { name: 'Assign to an agent' });
  check('"More options…" opens the task on the assignment', await assignForm.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
  // This phase follows OpenChamber's own default agent; tests/e2e/sunsama.mjs assigns to chosen ones.
  await assignForm.getByRole('button', { name: 'Agent', exact: true }).click();
  await frame.getByRole('dialog', { name: 'Choose the agent' }).getByRole('option', { name: "OpenChamber's default" }).click();
  await assignForm.getByRole('combobox', { name: 'Agent project' }).selectOption({ label: 'planner-demo-a' });
  const assignBranch = `planner/${run}-assign`;
  await assignForm.getByRole('textbox', { name: 'Worktree branch' }).fill(assignBranch);
  await assignForm.getByRole('button', { name: 'Edit the instructions' }).click();
  const instructions = await assignForm.getByRole('textbox', { name: 'Agent prompt' }).inputValue();
  check('the assignment asks for a pull request from its branch', instructions.includes(`branch \`${assignBranch}\``) && instructions.includes('gh pr create'), instructions.slice(-240).replace(/\s+/g, ' '));
  // Kept quick here: the dev container's free model only has to answer, and the lookup is answered below.
  // tests/e2e/agentpr.mjs runs the whole thing: the agent pushes and opens the pull request with gh (a fake GitHub).
  await assignForm.getByRole('textbox', { name: 'Agent prompt' }).fill(TRIVIAL);
  // Pull requests are looked up with gh through the service; answer for this run's branch.
  let fakePull = null;
  const pullLookups = [];
  await context.route(isServiceRoute, async (route) => {
    const outer = route.request().postDataJSON();
    if (outer?.path !== '/github/pulls') return route.continue();
    const { runs: asked } = JSON.parse(outer.body);
    pullLookups.push(...asked);
    const results = asked.map((item) => ({ runId: item.runId, pullRequest: item.branch === assignBranch ? fakePull : null }));
    await route.fulfill({ json: { status: 200, body: JSON.stringify({ results }) } });
  });
  await assignForm.getByRole('button', { name: 'Assign', exact: true }).click();
  await assignDialog.locator('li.run-row').first().waitFor({ timeout: 200_000 });
  // The row shows as soon as the panel has the run; the service has it once the panel's command is answered.
  const assignedRun = runsOf(await waitForState((latest) => Boolean(runsOf(latest, assignTitle)[0]?.worktree), 30_000), assignTitle)[0];
  check('an assigned run works in a new worktree on its branch and expects a pull request', assignedRun?.worktree?.branch === assignBranch && assignedRun.wantsPr === true, JSON.stringify(assignedRun ?? null).slice(0, 200));
  await assignDialog.getByRole('button', { name: 'Close' }).click();
  fakePull = { number: 4242, url: 'https://github.com/e2e/demo/pull/4242', state: 'open', draft: false, title: assignTitle, repo: 'e2e/demo' };
  // A freshly opened Planner looks pull requests up within seconds.
  frame = await openPlanner();
  const withPull = await waitForState((latest) => runsOf(latest, assignTitle)[0]?.pullRequest?.number === 4242, 20_000);
  check(
    "the pull request from the run's branch is found in its worktree and logged",
    runsOf(withPull, assignTitle)[0]?.pullRequest?.state === 'open' && pullLookups.some((item) => item.branch === assignBranch && item.directories[0] === assignedRun?.worktree?.directory),
    JSON.stringify(pullLookups.slice(-2)).slice(0, 200),
  );
  await nav('Agents').click();
  check('the run shows its pull request', await frame.locator('li.agent-task', { hasText: assignTitle }).getByRole('button', { name: 'Open pull request e2e/demo#4242 (Open)' }).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
  await shot('33-assigned-pr');
  fakePull = { ...fakePull, state: 'merged' };
  frame = await openPlanner();
  await waitForState((latest) => runsOf(latest, assignTitle)[0]?.pullRequest?.state === 'merged', 20_000);
  await nav('Agents').click();
  await frame.locator('li.agent-task', { hasText: assignTitle }).getByRole('button', { name: 'Merged: complete the task' }).click();
  const completedByPr = await waitForState((latest) => Boolean(taskTitled(latest, assignTitle)?.completedAt));
  check('a merged pull request offers to complete the task', Boolean(taskTitled(completedByPr, assignTitle)?.completedAt));
  await context.unroute(isServiceRoute);

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
  await openChatMenu();
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

  // Phase 8b: GitHub source state, Ask Planner, and git sync with another machine.
  await nav('GitHub').click();
  const ghState = (await frame.locator('.view-scroll').innerText({ timeout: 10_000 })).replace(/\s+/g, ' ');
  // The dev container has gh (2.5.2 image) but no GitHub sign-in; elsewhere gh may be missing or signed in.
  check('GitHub says plainly how to connect when gh is missing or signed out', /GitHub CLI \(gh\) is not installed|gh auth login|Signed in as/.test(ghState + (await frame.locator('.view-sub').first().innerText())), ghState.slice(0, 120));

  const isAskGenerate = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/generate';
  await context.route(isAskGenerate, (route) => {
    const prompt = JSON.parse(route.request().postData() ?? '{}').prompt ?? '';
    const gymId = new RegExp(`\\[([A-Za-z0-9_-]+)\\] ${run} gym`).exec(prompt)?.[1] ?? 'missing';
    return route.fulfill({ json: { ok: true, result: { text: JSON.stringify({ reply: 'Moved the gym and added a stretch.', ops: [{ op: 'move', taskId: gymId, when: 'tomorrow' }, { op: 'create', title: `${run} stretch`, when: 'today', minutes: 10, channel: null }] }) } } });
  });
  await nav('Home').click();
  await frame.getByRole('heading', { name: 'Home' }).click();
  await page.keyboard.press('Control+k');
  await frame.getByRole('combobox', { name: 'Search tasks or commands' }).fill('move my gym to tomorrow');
  await frame.getByRole('option', { name: /^Ask Planner: "move my gym to tomorrow"/ }).click();
  const ask = frame.getByRole('dialog', { name: 'Ask Planner' });
  check('the palette hands a question to Ask Planner', (await ask.getByRole('textbox', { name: 'Ask Planner' }).inputValue()) === 'move my gym to tomorrow');
  await ask.getByRole('button', { name: 'Ask', exact: true }).click();
  await ask.getByRole('button', { name: 'Apply 2 changes' }).waitFor({ timeout: 10_000 });
  const preview = (await ask.locator('.assistant-ops').innerText()).replace(/\s+/g, ' ');
  await shot('23-ask');
  await ask.getByRole('button', { name: 'Apply 2 changes' }).click();
  const tomorrowKey2 = (() => { const d = new Date(`${todayKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const asked = await waitForState((latest) => Object.values(latest.state.tasks).some((task) => task.title === `${run} gym` && task.placement.date === tomorrowKey2 && !task.deletedAt) && Boolean(taskTitled(latest, `${run} stretch`)));
  check('Ask Planner previews and applies the changes', preview.includes(`Move "${run} gym" to tomorrow`) && Boolean(taskTitled(asked, `${run} stretch`)), preview.slice(0, 140));
  await frame.getByRole('status').filter({ hasText: 'Assistant made 2 changes' }).getByRole('button', { name: 'Undo' }).click();
  const undone = await waitForState((latest) => !taskTitled(latest, `${run} stretch`) && !Object.values(latest.state.tasks).some((task) => task.title === `${run} gym` && task.placement.date === tomorrowKey2 && !task.deletedAt));
  check('the assistant changes undo in one step', !taskTitled(undone, `${run} stretch`));
  await context.unroute(isAskGenerate);

  const bare = '/home/node/planner-sync-e2e.git';
  execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', 'sh', '-c', `rm -rf ${bare} /tmp/planner-replica && git init --quiet --bare -b main ${bare}`]);
  await nav('Settings').click();
  await frame.getByRole('textbox', { name: 'Sync remote' }).fill(bare);
  // Settings has more than one Save (Google's client form too); this is Sync's.
  await frame.getByRole('group', { name: 'Sync', exact: true }).getByRole('button', { name: 'Save' }).click();
  await frame.getByRole('button', { name: 'Sync now' }).click();
  await frame.getByText(/^Last synced /).waitFor({ timeout: 60_000 });
  const pushed = execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', 'git', `--git-dir=${bare}`, 'log', '--oneline', '-1', 'main'], { encoding: 'utf8' }).trim();
  check('Sync pushes the planner history to the remote', pushed.length > 0, pushed);
  const remoteAt = new Date().toISOString();
  const remoteEvent = JSON.stringify({ v: 1, id: `zz-${run}`, at: remoteAt, type: 'task.created', task: { id: `remote-${run}`, title: `${run} from another machine`, placement: { kind: 'day', date: todayKey }, position: 999999 } });
  execFileSync('docker', ['exec', '-i', 'oc-forge-openchamber-dev', 'sh', '-c', [
    `git clone --quiet ${bare} /tmp/planner-replica`,
    'cd /tmp/planner-replica',
    `cat >> events/${remoteAt.slice(0, 7)}.jsonl`,
    'git -c user.name=Other -c user.email=other@localhost commit --quiet -am "From another machine"',
    'git push --quiet origin HEAD:main',
  ].join(' && ')], { input: `${remoteEvent}\n` });
  await frame.getByRole('button', { name: 'Sync now' }).click();
  const merged = await waitForState((latest) => Boolean(taskTitled(latest, `${run} from another machine`)), 30_000);
  check('a change pushed from another machine arrives on Sync now', Boolean(taskTitled(merged, `${run} from another machine`)));
  await shot('24-sync');
  await frame.getByRole('textbox', { name: 'Sync remote' }).fill('');
  await frame.getByRole('button', { name: 'Remove' }).click();
  await frame.getByRole('button', { name: 'Sync now' }).waitFor({ state: 'detached', timeout: 10_000 });
  execFileSync('docker', ['exec', 'oc-forge-openchamber-dev', 'sh', '-c', `rm -rf ${bare} /tmp/planner-replica`]);
  check('the remote can be removed again', !(await savedState()).sync?.remote);

  // Parity polish: playlist times, folders leave on scheduling, subtask → task, date jump.
  await nav('Home').click();
  await todayCol.getByRole('button', { name: 'Today actions' }).click();
  await todayCol.getByRole('menuitem', { name: 'Show playlist times' }).click();
  await todayCol.locator('.playlist-time').first().waitFor({ timeout: 10_000 });
  check('the playlist shows when open tasks would run, in order', (await todayCol.locator('.playlist-time').count()) > 0, (await todayCol.locator('.playlist-time').first().innerText()).trim());
  await shot('25-playlist');
  await todayCol.getByRole('button', { name: 'Today actions' }).click();
  await todayCol.getByRole('menuitem', { name: 'Hide playlist times' }).click();

  await nav('Backlog').click();
  const paper = frame.locator('li.task-card', { hasText: `${run} paper on planning` }).first();
  await paper.hover();
  await paper.getByRole('button', { name: 'Task actions' }).click();
  await paper.getByRole('menuitem', { name: 'Move to today' }).click();
  const scheduled = await waitForState((latest) => taskTitled(latest, `${run} paper on planning`)?.placement.kind === 'day');
  check('scheduling a folder task on a day takes it out of the folder', taskTitled(scheduled, `${run} paper on planning`)?.folderId === null);

  await nav('Home').click();
  await todayCol.locator('li.task-card', { hasText: `${run} paper on planning` }).getByRole('button', { name: new RegExp(`Open ${run} paper on planning`) }).click();
  const paperDialog = frame.getByRole('dialog', { name: 'Task details' });
  await paperDialog.getByRole('textbox', { name: 'Add subtask' }).fill(`${run} read section 2`);
  await paperDialog.getByRole('textbox', { name: 'Add subtask' }).press('Enter');
  await paperDialog.getByRole('button', { name: `Turn ${run} read section 2 into a task` }).click();
  const split = await waitForState((latest) => Boolean(taskTitled(latest, `${run} read section 2`)));
  check('a subtask can become its own task', Boolean(taskTitled(split, `${run} read section 2`)) && taskTitled(split, `${run} paper on planning`)?.subtasks.length === 0);
  await paperDialog.getByRole('button', { name: 'Close' }).click();

  const jumpTo = (() => { const d = new Date(`${todayKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 10); return d.toISOString().slice(0, 10); })();
  await frame.getByRole('textbox', { name: 'Jump to date' }).fill(jumpTo);
  const firstColumn = (await frame.locator('section.day-column').first().getAttribute('aria-label')) ?? '';
  check('the board jumps to a picked date', firstColumn.includes(monthDayLabel(jumpTo)), firstColumn);
  await frame.getByRole('button', { name: 'Today', exact: true }).last().click().catch(() => {});

  // Phase 13: Google Calendar, Google Tasks and Gmail. The service's /google routes answer from a
  // fake account here: the real ones would need Google and a person to sign in.
  const GMAIL = 'e2e@example.com';
  const gtask = (id, title, due) => ({ account: GMAIL, listId: 'L1', id, title: `${run} ${title}`, notes: id === 'gt1' ? 'at the post office' : '', due, completed: false, parent: null, position: id, url: `https://tasks.google.com/task/${id}`, updated: new Date().toISOString() });
  const fake = {
    client: null,
    accounts: [],
    signedIn: false,
    calendars: [
      { account: GMAIL, id: 'primary', name: `${run} Me`, color: '#4285f4', primary: true, writable: true },
      { account: GMAIL, id: 'holidays', name: `${run} Holidays`, color: '#0b8043', primary: false, writable: false },
    ],
    lists: [{ account: GMAIL, id: 'L1', title: 'My Tasks' }],
    tasks: [gtask('gt1', 'buy stamps', todayKey), gtask('gt2', 'call the bank', tomorrowKey), gtask('gt3', 'renew passport', null)],
    calendarOn: false,
    mail: [{ account: GMAIL, id: 'm1', threadId: 'th1', subject: `${run} review the deck`, from: 'Ann Lee <ann@example.com>', date: new Date().toISOString(), snippet: 'Could you look at slides 3 to 5?', unread: true, url: 'https://mail.google.com/mail/u/e2e%40example.com/#all/th1' }],
    writes: [],
  };
  const googleAnswer = (method, path, body) => {
    const url = new URL(path, 'http://service');
    const status = () => ({ client: fake.client, accounts: fake.accounts, timeboxError: null });
    if (url.pathname === '/google/status') return status();
    if (url.pathname === '/google/client' && method === 'PUT') {
      if (!/\.apps\.googleusercontent\.com$/.test(body.id)) return { httpStatus: 400, error: 'That is not an OAuth client ID (it ends in .apps.googleusercontent.com)' };
      fake.client = { id: body.id };
      return status();
    }
    if (url.pathname === '/google/connect' && method === 'POST') return { id: 'signin-e2e-1', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e', redirectUri: 'http://127.0.0.1:43210/' };
    if (url.pathname === '/google/connect/signin-e2e-1') return fake.signedIn ? { status: 'connected', email: GMAIL, features: ['calendar', 'tasks', 'mail'] } : { status: 'pending' };
    if (url.pathname === '/google/connect/signin-e2e-1/finish') {
      if (!body.url.startsWith('http://127.0.0.1:43210/') || !body.url.includes('code=')) return { httpStatus: 400, error: 'That address is not the one this sign-in waits for' };
      fake.signedIn = true;
      fake.accounts = [{ email: GMAIL, features: ['calendar', 'tasks', 'mail'], addedAt: new Date().toISOString() }];
      return { status: 'connected', email: GMAIL, features: ['calendar', 'tasks', 'mail'] };
    }
    if (url.pathname === '/google/calendars') return { calendars: fake.accounts.length ? fake.calendars : [], errors: [] };
    if (url.pathname === '/google/tasklists') return { lists: fake.accounts.length ? fake.lists : [], errors: [] };
    if (url.pathname === '/google/tasks' && method === 'GET') return { tasks: fake.tasks.filter((item) => !item.completed) };
    // A list's every task, completed ones too: completing a task reads it for the subtasks that complete with it.
    if (url.pathname === '/google/tasks/all' && method === 'GET') return { tasks: fake.tasks.filter((item) => item.listId === url.searchParams.get('list')), complete: true };
    if (url.pathname === '/google/tasks/linked') return { tasks: fake.tasks.filter((item) => body.groups.some((group) => group.ids.includes(item.id))) };
    if (url.pathname === '/google/tasks' && method === 'PATCH') {
      fake.writes.push({ method, ...body });
      const item = fake.tasks.find((task) => task.id === body.id);
      if (body.completed !== undefined) item.completed = body.completed;
      if (body.due !== undefined) item.due = body.due;
      return { task: item };
    }
    if (url.pathname === '/google/tasks' && method === 'POST') {
      fake.writes.push({ method, ...body });
      const item = { ...gtask(`gt${fake.tasks.length + 1}`, 'x', body.due ?? null), title: body.title };
      fake.tasks.push(item);
      return { task: item };
    }
    if (url.pathname === '/google/mail') return { messages: fake.mail };
    return null;
  };
  // The calendar the service would read from Google: a meeting and a Google task due that day.
  const isoAt = (minutes, dayKey) => localToUtc(minutes, dayKey).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6.000Z');
  const dayAfter = (key) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const fakeCalendar = (from) => {
    const gcalId = Object.values(lastState?.state.calendars ?? {}).find((calendar) => calendar.google?.calendarId === 'primary')?.id ?? 'none';
    const due = fake.tasks.find((item) => item.id === 'gt9');
    return [
      { id: `${gcalId}:review`, calendarId: gcalId, title: `${run} design review`, location: '', start: isoAt(15 * 60, from), end: isoAt(16 * 60, from), allDay: false, busy: true },
      ...(due ? [{ id: 'gtask:L1:gt9', calendarId: 'google-tasks', title: due.title, location: '', start: isoAt(0, from), end: isoAt(0, dayAfter(from)), allDay: true, busy: false, googleTask: { ...due, due: from } }] : []),
    ];
  };
  let lastState = null;
  await context.route(isServiceRoute, async (route) => {
    const outer = route.request().postDataJSON();
    if (fake.calendarOn && String(outer?.path ?? '').startsWith('/calendar?')) {
      const from = new URL(outer.path, 'http://service').searchParams.get('from');
      return route.fulfill({ json: { status: 200, body: JSON.stringify({ events: fakeCalendar(from), errors: [] }) } });
    }
    if (!String(outer?.path ?? '').startsWith('/google/')) return route.continue();
    const answer = googleAnswer(outer.method ?? 'GET', outer.path, outer.body ? JSON.parse(outer.body) : {});
    if (!answer) return route.continue();
    await route.fulfill({ json: answer.httpStatus ? { status: answer.httpStatus, body: JSON.stringify({ error: answer.error }) } : { status: 200, body: JSON.stringify(answer) } });
  });
  // Google's sign-in page is not visited for real.
  await context.route('https://accounts.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Google sign-in (e2e)</p>' }));
  frame = await openPlanner();
  await nav('Settings').click();
  const googleBox = frame.getByRole('group', { name: 'Google', exact: true });
  await googleBox.getByRole('textbox', { name: 'Google OAuth client ID' }).fill('not-a-client');
  await googleBox.getByRole('textbox', { name: 'Google OAuth client secret' }).fill('GOCSPX-e2e-secret-value');
  await googleBox.getByRole('button', { name: 'Save' }).click();
  check('a client ID that is not one is refused, with the reason', await googleBox.getByRole('alert').filter({ hasText: 'OAuth client ID' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
  await googleBox.getByRole('textbox', { name: 'Google OAuth client ID' }).fill('123456789012-e2eabcdefghijklmnop.apps.googleusercontent.com');
  await googleBox.getByRole('button', { name: 'Save' }).click();
  await googleBox.getByText('No account connected yet.').waitFor({ timeout: 5000 });
  await googleBox.getByRole('button', { name: 'Connect a Google account' }).click();
  const pasteBox = googleBox.getByRole('textbox', { name: 'Address Google sent the browser to' });
  check('connecting waits for Google and offers to paste the address it ends on', await pasteBox.waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
  await pasteBox.fill('http://127.0.0.1:43210/?state=e2e&code=e2e-code&scope=x');
  await googleBox.getByRole('button', { name: 'Finish' }).click();
  const accountRow = googleBox.getByRole('list', { name: 'Google accounts' }).getByRole('listitem').filter({ hasText: GMAIL });
  await accountRow.waitFor({ timeout: 8000 });
  check('the connected account shows with what it allows', (await accountRow.innerText()).includes('Calendar, Tasks, Gmail'), (await accountRow.innerText()).replace(/\s+/g, ' '));
  await googleBox.getByRole('checkbox', { name: `${run} Me` }).check();
  const withCalendar = await waitForState((latest) => Object.values(latest.state.calendars).some((calendar) => calendar.google?.account === GMAIL && calendar.google.calendarId === 'primary'));
  check('a Google calendar shows beside the plan, read through its account', Object.values(withCalendar.state.calendars).some((calendar) => calendar.google?.calendarId === 'primary' && calendar.visible));
  await googleBox.getByRole('combobox', { name: 'Google calendar for working sessions' }).selectOption({ label: `${run} Me` });
  const withTarget = await waitForState((latest) => latest.state.settings.googleTimebox?.calendarId === 'primary');
  check('working sessions can be written to a Google calendar (only writable ones are offered)', withTarget.state.settings.googleTimebox?.account === GMAIL && (await googleBox.getByRole('combobox', { name: 'Google calendar for working sessions' }).locator('option', { hasText: `${run} Holidays` }).count()) === 0);
  await shot('34-google-settings');

  await nav('Today').click();
  await frame.getByRole('tab', { name: 'Google Tasks' }).click();
  const stamps = frame.locator('.side-panel li.issue-row', { hasText: `${run} buy stamps` });
  await stamps.waitFor({ timeout: 8000 });
  check('Google Tasks shows a list\'s open tasks with their due dates', (await stamps.innerText()).includes('Due today') && (await frame.locator('.side-panel li.issue-row', { hasText: `${run} renew passport` }).count()) === 1);
  await stamps.getByRole('button', { name: `Plan ${run} buy stamps today` }).click();
  await frame.locator('.side-panel li.issue-row', { hasText: `${run} renew passport` }).getByRole('button', { name: `Plan ${run} renew passport today` }).click();
  const plannedGoogle = await waitForState((latest) => Boolean(taskTitled(latest, `${run} buy stamps`)) && Boolean(taskTitled(latest, `${run} renew passport`)));
  const stampsTask = taskTitled(plannedGoogle, `${run} buy stamps`);
  check('a Google task becomes a linked task, with its notes and due date', stampsTask?.source?.kind === 'gtask' && stampsTask.source.listId === 'L1' && stampsTask.notes === 'at the post office' && stampsTask.dueDate === todayKey, JSON.stringify(stampsTask?.source ?? null));
  const dueWrite = await (async () => { for (let i = 0; i < 40 && !fake.writes.some((write) => write.id === 'gt3'); i++) await page.waitForTimeout(250); return fake.writes.find((write) => write.id === 'gt3'); })();
  check('planning a Google task on a day makes it due that day in Google, unless it already was', dueWrite?.due === todayKey && !fake.writes.some((write) => write.id === 'gt1' && write.due), JSON.stringify(fake.writes));
  const stampsCard = todayCol.locator('li.task-card', { hasText: `${run} buy stamps` });
  await stampsCard.getByRole('button', { name: 'Mark complete' }).click();
  const completedThere = await (async () => { for (let i = 0; i < 40 && !fake.writes.some((write) => write.id === 'gt1' && write.completed === true); i++) await page.waitForTimeout(250); return fake.writes.some((write) => write.id === 'gt1' && write.completed === true); })();
  const syncedDone = await waitForState((latest) => taskTitled(latest, `${run} buy stamps`)?.source?.status?.type === 'completed');
  check('completing it here completes it in Google Tasks', completedThere && taskTitled(syncedDone, `${run} buy stamps`)?.source?.status?.name === 'Completed');

  await frame.getByRole('tab', { name: 'Gmail' }).click();
  const deck = frame.locator('.side-panel li.issue-row', { hasText: `${run} review the deck` });
  await deck.waitFor({ timeout: 8000 });
  check('Gmail lists the inbox, sender first', (await deck.innerText()).includes('Ann Lee'));
  await deck.getByRole('button', { name: `Plan ${run} review the deck today` }).click();
  const mailed = await waitForState((latest) => Boolean(taskTitled(latest, `${run} review the deck`)));
  const deckTask = taskTitled(mailed, `${run} review the deck`);
  check('an email becomes a task linked back to Gmail, with who sent it', deckTask?.source?.kind === 'email' && deckTask.source.url === fake.mail[0].url && deckTask.notes.startsWith('From Ann Lee'), JSON.stringify(deckTask?.source ?? null));
  await shot('35-gmail');

  await addInToday(`${run} plain errand`);
  await todayCol.locator('li.task-card', { hasText: `${run} plain errand` }).getByRole('button', { name: new RegExp(`Open ${run} plain errand`) }).click();
  const errandDialog = frame.getByRole('dialog', { name: 'Task details' });
  await errandDialog.getByRole('button', { name: 'Add to Google Tasks' }).click();
  const added = await waitForState((latest) => taskTitled(latest, `${run} plain errand`)?.source?.kind === 'gtask');
  check('a task can be added to Google Tasks, and stays linked to it', taskTitled(added, `${run} plain errand`)?.source?.listId === 'L1' && fake.writes.some((write) => write.method === 'POST' && write.title === `${run} plain errand` && write.due === todayKey));
  check('the task detail offers to open it in Google Tasks', await errandDialog.getByRole('button', { name: 'Open in Google Tasks' }).isVisible());
  await errandDialog.getByRole('button', { name: 'Close' }).click();

  // On the calendar: a Google task due today, as Google Calendar shows it, and an event that becomes a task.
  fake.tasks.push(gtask('gt9', 'renew library card', todayKey));
  lastState = await serviceState();
  fake.calendarOn = true;
  await nav('Home').click();
  await nav('Today').click();
  await frame.getByRole('tab', { name: 'Calendar' }).click();
  const dueChip = frame.getByRole('button', { name: new RegExp(`^Google task ${run} renew library card, due `) });
  check('a Google task due today shows on the calendar, as in Google Calendar', await dueChip.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  await dueChip.click();
  await frame.getByRole('dialog', { name: `Google task: ${run} renew library card` }).getByRole('button', { name: /^Plan on today/ }).click();
  const fromDue = await waitForState((latest) => taskTitled(latest, `${run} renew library card`)?.source?.kind === 'gtask');
  check('its details plan it today, linked to the Google task', taskTitled(fromDue, `${run} renew library card`)?.placement.date === todayKey && taskTitled(fromDue, `${run} renew library card`)?.source?.id === 'gt9');
  const plannedChip = frame.getByRole('button', { name: new RegExp(`^Google task ${run} renew library card, due .*planned in the Planner`) });
  check('a planned Google task stays on its due day, as Google Calendar shows it, marked planned', await plannedChip.waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
  const reviewEvent = frame.locator('.grid-item.is-event', { hasText: `${run} design review` });
  await reviewEvent.hover();
  await reviewEvent.getByRole('button', { name: `Add ${run} design review as a task` }).click();
  const fromMeeting = await waitForState((latest) => Boolean(taskTitled(latest, `${run} design review`)));
  const meetingTask = taskTitled(fromMeeting, `${run} design review`);
  check('a calendar event becomes a task on its day, its length as planned time', meetingTask?.placement.date === todayKey && meetingTask.plannedMinutes === 60, JSON.stringify({ placement: meetingTask?.placement, minutes: meetingTask?.plannedMinutes }));
  await shot('36-calendar-google-tasks');
  fake.calendarOn = false;

  // Leave no Google calendar or session calendar behind for later runs (the real service has no such account).
  await nav('Settings').click();
  await googleBox.getByRole('checkbox', { name: `${run} Me` }).uncheck();
  await googleBox.getByRole('combobox', { name: 'Google calendar for working sessions' }).selectOption({ label: "Don't write them" });
  const reset = await waitForState((latest) => !latest.state.settings.googleTimebox && !Object.values(latest.state.calendars).some((calendar) => calendar.google?.account === GMAIL));
  check('a Google calendar and the session calendar can be turned off again', !reset.state.settings.googleTimebox);
  await context.unroute(isServiceRoute);
  await context.unroute('https://accounts.google.com/**');
  frame = await openPlanner();

  // The Work Status section sits in the chat's Work Status panel (shown on the home screen too).
  await page.goto(`${base}/`, { waitUntil: 'load' });
  const statusSelector = '.rounded-md > iframe[title="Planner"]';
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
