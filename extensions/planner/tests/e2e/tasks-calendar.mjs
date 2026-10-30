// Google Calendar's joint workflow with Google Tasks beyond the task itself (review 8, P1-7), end to end at
// 1440x900 and at 1024x768: the dev container's OpenChamber UI with this checkout's panel and a private service
// signed in to the fake Google (tests/e2e/fakeGoogle.mjs).
// - Pending tasks: today's "N pending tasks" entry (Week, Day, Month, Schedule) opens the open tasks of the past 365
//   days, latest first; one is rescheduled to today, one to a date picked, one edited, then completed, each written
//   to Google; after a reload nothing is pending and each is where it was moved.
// - Advanced settings: a timed task set Busy and Private; Busy makes "Timebox automatically" plan around it, Free
//   lets it take that time; its visibility goes to the working session written to Google Calendar for it; all of it
//   after a reload; a task without a time has neither (as in Google Calendar).
// - Task notifications as OpenChamber notifications: a date-only task's 9 AM and a deadline's 9 AM, missed while the
//   Planner was closed (set yesterday), come when it opens; a task's time comes at that time; none comes twice, after
//   a reload either; the setting turns them off.
// - Printing (round 11, `print`): Print list and Ctrl/⌘+P in the Tasks view, the list alone and whole in print
//   media; Google Calendar's Settings → Print, its preview and options, Day, Week, Month and Schedule.
// - Declining meetings (round 11, `decline`): review 10's three daily series, and passes that carry on after a bound.
// The zone is one where it is between 10 AM and 10 PM now, so 9 AM has passed and today lasts the journey.
// Run on the host after `bun run build`, in the netns: node extensions/planner/tests/e2e/tasks-calendar.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness } from './harness.mjs';
import { DEFAULT_SCOPES, defaultFakeWorld, fakeAuthCode, startFakeGoogle } from './fakeGoogle.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-tasks-calendar';
const ME = 'harness@example.com';
const minutesIn = (zone, ms = Date.now()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return (parts.hour % 24) * 60 + parts.minute + parts.second / 60;
};
const ZONE = ['America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Honolulu'].find((zone) => minutesIn(zone) >= 600 && minutesIn(zone) < 1320) ?? 'UTC';
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDay = (key) => `${WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]}, ${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8))}`;
/** Google's compact clock: "9am", "2:05pm". */
const clock = (minutes) => {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${hour < 12 ? 'am' : 'pm'}`;
};
/** The instant of a wall-clock time in ZONE. */
const at = (key, minutes) => {
  const [y, m, d] = key.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((part) => [part.type, Number(part.value)]));
    guess += wall - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
  }
  return guess;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeout = 10_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > end) return value;
    await sleep(200);
  }
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
};
let seq = 0;

const journey = async (viewport) => {
  const size = `${viewport.width}`;
  const today = dayOf(Date.now());
  const tomorrow = addDays(today, 1);
  const due = (days) => `${addDays(today, days)}T00:00:00.000Z`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const world = defaultFakeWorld({ account: ME, today, zone: ZONE });
  // Send the report is tomorrow's here (the timed task of the advanced settings); today has its own tasks.
  world.tasks.L1[0].due = due(1);
  world.tasks.L1.push(
    { id: 't-gift', title: 'Buy a gift', notes: '', due: due(-1), status: 'needsAction', updated: yesterday },
    { id: 't-passport', title: 'Renew the passport', notes: '', due: due(-3), status: 'needsAction', updated: yesterday },
    { id: 't-ancient', title: 'Older than a year', notes: '', due: due(-400), status: 'needsAction', updated: yesterday },
    { id: 't-done-late', title: 'Done late', notes: '', due: due(-2), status: 'completed', completed: yesterday, updated: yesterday },
    { id: 't-call', title: 'Call the bank', notes: '', due: due(0), status: 'needsAction', updated: yesterday },
    { id: 't-dentist', title: 'Book the dentist', notes: '', due: due(0), status: 'needsAction', updated: yesterday },
  );
  world.tasks.L2.push({ id: 't-books', title: 'Return the books', notes: '', due: due(-10), status: 'needsAction', updated: yesterday });
  const fake = await startFakeGoogle(world);
  // What the Planner kept yesterday: the passport's time (11pm), Buy stamps' deadline (today; it has no date).
  const seeded = [
    { type: 'settings.updated', patch: { timezone: ZONE } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-passport', patch: { time: 23 * 60 } },
    { type: 'gtask.kept', account: ME, listId: 'L2', taskId: 't-stamps', patch: { deadline: today } },
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const h = await startHarness({
    out,
    viewport,
    timezoneId: ZONE,
    taskNotifications: true,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
  });
  const { page } = h;
  const plannerErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  const shot = (name) => h.shot(`${name}-${size}`);
  const state = async () => (await h.call('GET', '/state')).json.state;
  const commands = (...bodies) => h.call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `tc${size}x${String(++seq).padStart(6, '0')}`, ...body })) });
  const googleTask = (listId, id) => fake.tasks.get(listId)?.find((task) => task.id === id);
  const toast = (text) => page.locator('li[data-sonner-toast]', { hasText: text });
  /** OK on each of these notifications, the front one first (OpenChamber stacks them). */
  const dismiss = async (...texts) => {
    for (let round = 0; round < 3 * texts.length; round++) {
      const left = [];
      for (const text of texts) if ((await toast(text).count()) > 0) left.push(text);
      if (!left.length) return;
      const front = page.locator('li[data-sonner-toast][data-front="true"]').first();
      const frontText = (await front.count()) ? await front.innerText().catch(() => '') : '';
      const target = left.some((text) => frontText.includes(text)) ? front : toast(left[0]).first();
      await target.getByRole('button', { name: 'OK' }).click({ timeout: 3000 }).catch(() => {});
      await sleep(400);
    }
  };
  const takes = () => h.serviceCalls.filter((call) => call.method === 'POST' && call.path === '/google/tasks/notifications').length;
  /** The Planner's own menu; in a narrow page (1024 px with OpenChamber's sidebar) it folds into a rail and opens over the page. */
  const go = async (name) => {
    if (!(await h.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
    await h.nav(name).click();
  };
  // Working hours 3pm to 7pm tomorrow; working sessions go to the account's own calendar.
  const setup = await commands({ type: 'settings.updated', patch: { workdayStart: 15 * 60, workdayEnd: 19 * 60, googleTimebox: { account: ME, calendarId: 'primary' } } });
  if (setup.status !== 200) throw new Error(`setup: ${setup.text}`);

  let f;
  try {
    f = await h.openPlanner();
    // ── Task notifications missed while the Planner was closed come when it opens, as Google's apps deliver theirs.
    // Call the bank and Book the dentist are due today with no time (9 AM), Buy stamps' deadline is today (9 AM).
    const callToast = toast('Task today: Call the bank');
    const stampsToast = toast('Deadline today: Buy stamps');
    const dentistDay = toast('Task today: Book the dentist');
    const missed = await until(async () => (await callToast.count()) > 0 && (await stampsToast.count()) > 0 && (await dentistDay.count()) > 0, 20_000);
    check(`${size}: the 9 AM notifications of today's date-only tasks and of a deadline today, missed while the Planner was closed, come as OpenChamber notifications when it opens`, missed, await page.locator('li[data-sonner-toast]').allInnerTexts().catch(() => []));
    check(`${size}: they stay until dismissed, with OK`, (await callToast.getByRole('button', { name: 'OK' }).count()) === 1);
    const ours = (await page.locator('li[data-sonner-toast]').allInnerTexts()).filter((text) => /Task (today|at)|Deadline today/.test(text));
    check(`${size}: no other task notifies (the passport's 11pm has not come, nothing else is today)`, ours.length === 3, JSON.stringify(ours));
    await shot('tc-01-missed-notifications');
    await dismiss('Task today: Call the bank', 'Deadline today: Buy stamps', 'Task today: Book the dentist');
    check(`${size}: OK dismisses each`, (await page.locator('li[data-sonner-toast]').filter({ hasText: /Task today|Deadline today/ }).count()) === 0);

    // ── Pending tasks, from the calendar.
    await go('Calendar');
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    const lane = (date) => f.locator(`.day-lane[data-date="${date}"]`);
    /** The all-day row shows three lines and "N more", as Google Calendar does: open it all, as one would to look. */
    const allDay = async () => {
      const toggle = f.getByRole('button', { name: 'Show all all-day events' });
      if (await toggle.count()) await toggle.first().click();
    };
    const pickView = async (name) => {
      await f.getByRole('button', { name: /^View:/ }).click();
      await f.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
    };
    const entry = f.getByRole('button', { name: /^\d+ pending tasks?, from the past 365 days$/ });
    await until(async () => (await f.getByRole('button', { name: /^Google task Call the bank/ }).count()) > 0 || (await f.getByRole('button', { name: 'Show all all-day events' }).count()) > 0, 15_000);
    await allDay();
    check(`${size}: today's all-day section has "3 pending tasks" (Week)`, await entry.first().waitFor({ timeout: 15_000 }).then(async () => (await entry.first().getAttribute('aria-label'))?.startsWith('3 pending tasks')).catch(() => false), await entry.count());
    const allDayCell = await entry.first().evaluate((node) => node.style.gridColumn).catch(() => '');
    const todayColumn = await f.locator('.grid-day-head').evaluateAll((heads) => heads.findIndex((head) => head.classList.contains('is-today')) + 2).catch(() => -1);
    check(`${size}: it is on today's column, as Google Calendar shows it`, allDayCell.startsWith(`${todayColumn} `) || allDayCell === String(todayColumn), `${allDayCell} vs ${todayColumn}`);
    await shot('tc-02-week-pending');
    const views = {};
    for (const view of ['Day', 'Month', 'Schedule']) {
      await pickView(view);
      if (view === 'Day') await allDay();
      // Month: a day with more than fits shows "N more", which lists the rest (as Google Calendar does).
      if (view === 'Month' && !(await entry.first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false))) {
        const row = f.locator('.month-row', { has: f.locator(`.month-cell[data-date="${today}"]`) });
        const index = await row.evaluate((element, date) => {
          const column = [...element.querySelectorAll('.month-cell')].findIndex((cell) => cell.dataset.date === date) + 1;
          return [...element.querySelectorAll('.month-more')].findIndex((button) => button.style.gridColumn.split('/')[0].trim() === String(column));
        }, today);
        if (index >= 0) await row.locator('.month-more').nth(index).click();
      }
      views[view] = await entry.first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
      if (view === 'Month') await page.keyboard.press('Escape');
      await shot(`tc-02-${view.toLowerCase()}-pending`);
    }
    await pickView('Week');
    await allDay();
    check(`${size}: the entry is there in Day, Month and Schedule too`, views.Day && views.Month && views.Schedule, JSON.stringify(views));

    await entry.first().click();
    const pop = f.getByRole('dialog', { name: 'Pending tasks' });
    await pop.waitFor();
    const rows = pop.getByRole('listitem');
    const rowTexts = await rows.allInnerTexts();
    check(`${size}: Pending tasks lists the open tasks of the past 365 days, latest first; done ones, today's and older ones are not there`, rowTexts.length === 3 && rowTexts[0].includes('Buy a gift') && rowTexts[1].includes('Renew the passport') && rowTexts[2].includes('Return the books') && !rowTexts.join('').includes('Older than a year') && !rowTexts.join('').includes('Done late') && !rowTexts.join('').includes('Call the bank'), JSON.stringify(rowTexts));
    check(`${size}: each row has its date, its time (or All day) and its list, as Google lists them`, (await pop.innerText()).includes('In the past 365 days') && rowTexts[1].includes(String(Number(addDays(today, -3).slice(8)))) && rowTexts[1].includes('11pm') && rowTexts[0].includes('All day') && rowTexts[2].includes('Errands'), JSON.stringify(rowTexts));
    const box = await pop.boundingBox();
    const frameBox = await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
    check(`${size}: the list fits inside the Planner`, box && frameBox && box.x >= frameBox.x && box.x + box.width <= frameBox.x + frameBox.width + 1 && box.y + box.height <= frameBox.y + frameBox.height + 1, JSON.stringify({ box, frameBox }));
    await shot('tc-03-pending-list');

    // Reschedule this task → Today: Google gets the date (its time kept in the Planner stays).
    const passport = pop.getByRole('listitem', { name: new RegExp(`^Renew the passport, ${longDay(addDays(today, -3))}`) });
    await passport.hover();
    await passport.getByRole('button', { name: 'Reschedule Renew the passport' }).click();
    const menu = pop.getByRole('menu', { name: 'Reschedule Renew the passport' });
    await shot('tc-04-reschedule-menu');
    await menu.getByRole('menuitem', { name: 'Today' }).click();
    const movedToday = await until(() => googleTask('L1', 't-passport')?.due === due(0), 10_000);
    check(`${size}: "Reschedule this task" → Today writes today's date to Google`, movedToday, googleTask('L1', 't-passport')?.due);
    check(`${size}: the task leaves the list and the entry counts 2`, await until(async () => (await rows.count()) === 2 && (await entry.first().getAttribute('aria-label'))?.startsWith('2 pending tasks'), 10_000));
    check(`${size}: the snackbar says so`, await f.locator('.gcal-snack', { hasText: 'Task rescheduled to today' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    check(`${size}: it shows on today at its kept time, 11pm`, await until(async () => (await lane(today).locator('.grid-item', { hasText: 'Renew the passport' }).count()) === 1, 15_000));

    // Reschedule → a date picked.
    if (!(await pop.isVisible().catch(() => false))) await entry.first().click();
    const books = pop.getByRole('listitem', { name: /^Return the books/ });
    await books.hover();
    await books.getByRole('button', { name: 'Reschedule Return the books' }).click();
    const booksMenu = pop.getByRole('menu', { name: 'Reschedule Return the books' });
    await booksMenu.getByLabel('Pick a date').fill(addDays(today, 2));
    await booksMenu.getByRole('button', { name: 'Reschedule', exact: true }).click();
    check(`${size}: Reschedule → a date picked writes that date (in another list of the account too)`, await until(() => googleTask('L2', 't-books')?.due === due(2), 10_000), googleTask('L2', 't-books')?.due);
    check(`${size}: one is left pending`, await until(async () => (await rows.count()) === 1 && (await entry.first().getAttribute('aria-label'))?.startsWith('1 pending task,'), 10_000));

    // Edit from the list: the task's editor over the calendar.
    const gift = pop.getByRole('listitem', { name: /^Buy a gift/ });
    await gift.hover();
    await gift.getByRole('button', { name: 'Edit Buy a gift' }).click();
    const giftEditor = f.getByRole('dialog', { name: /^Edit task: Buy a gift/ });
    await giftEditor.waitFor();
    await giftEditor.getByRole('textbox', { name: 'Title' }).fill('Buy a birthday gift');
    await giftEditor.getByRole('button', { name: 'Done' }).click();
    check(`${size}: Edit from the list opens the task's editor; its change reaches Google`, await until(() => googleTask('L1', 't-gift')?.title === 'Buy a birthday gift', 10_000), googleTask('L1', 't-gift')?.title);
    await giftEditor.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    // Complete from the list, at its left.
    await entry.first().click();
    await pop.waitFor();
    const renamed = pop.getByRole('listitem', { name: /^Buy a birthday gift/ });
    await renamed.waitFor({ timeout: 10_000 });
    await renamed.getByRole('checkbox', { name: 'Mark Buy a birthday gift complete' }).click();
    check(`${size}: its circle completes it in Google`, await until(() => googleTask('L1', 't-gift')?.status === 'completed', 10_000));
    check(`${size}: nothing is pending now: the list says so and the entry goes`, await until(async () => (await pop.getByText('No pending tasks.').count()) === 1 && (await entry.count()) === 0, 15_000));
    await shot('tc-05-none-pending');
    await page.keyboard.press('Escape');

    // After a reload: nothing pending; each task where it was moved, as Google has it.
    const takesBefore = takes();
    await page.reload({ waitUntil: 'load' });
    f = await h.openPlanner();
    await go('Calendar');
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    await lane(today).waitFor();
    await until(async () => (await lane(today).locator('.grid-item', { hasText: 'Renew the passport' }).count()) === 1, 15_000);
    await sleep(1500);
    await allDay();
    check(`${size}: after a reload, nothing is pending and the passport is on today`, (await entry.count()) === 0 && (await lane(today).locator('.grid-item', { hasText: 'Renew the passport' }).count()) === 1);
    const booksDay = addDays(today, 2);
    if (!(await lane(booksDay).count())) await f.getByRole('button', { name: 'Next week' }).click();
    await allDay();
    check(`${size}: and the books are on the date picked`, await until(async () => (await f.getByRole('button', { name: /^Google task Return the books, due/ }).count()) === 1, 15_000));
    if (!(await lane(today).count())) await f.getByRole('button', { name: 'Previous week' }).click();
    // The notifications given before the reload do not come again.
    await until(() => takes() > takesBefore, 20_000);
    await sleep(2500);
    check(`${size}: after a reload, the notifications already given do not come again`, takes() > takesBefore && (await callToast.count()) === 0 && (await stampsToast.count()) === 0, `takes ${takesBefore} → ${takes()}`);
    await shot('tc-06-after-reload');

    // ── Advanced settings: Send the report, tomorrow at 3–4pm, Busy and Private.
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    const reportChip = () => f.getByRole('button', { name: /^Google task Send the report, due/ }).first();
    const openEditor = async () => {
      await reportChip().click();
      await f.getByRole('dialog', { name: /^Google task: Send the report/ }).getByRole('button', { name: 'Edit task' }).click();
      const editor = f.getByRole('dialog', { name: /^Edit task: Send the report/ });
      await editor.waitFor();
      return editor;
    };
    let editor = await openEditor();
    await editor.getByRole('combobox', { name: 'Time', exact: true }).selectOption('900');
    await editor.getByRole('combobox', { name: 'End time' }).selectOption('960');
    await editor.getByRole('button', { name: 'Advanced settings' }).click();
    const availability = editor.getByRole('combobox', { name: 'Availability' });
    const visibility = editor.getByRole('combobox', { name: 'Visibility' });
    check(`${size}: a timed task's Advanced settings offer Free or Busy, and Default visibility, Public or Private, as Google Calendar's`, (await availability.isEnabled()) && (await visibility.isEnabled()) && JSON.stringify(await availability.locator('option').allInnerTexts()) === '["Free","Busy"]' && JSON.stringify(await visibility.locator('option').allInnerTexts()) === '["Default visibility","Public","Private"]');
    check(`${size}: they say what they do here, and that they stay in the Planner`, (await editor.innerText()).includes('Busy: the Planner plans other work around it') && (await editor.innerText()).includes('working sessions') && (await editor.innerText()).includes('availability or visibility'));
    // Round 10: a personal account has a task color and Drive attachments, but not Do not disturb or declining, as Google Calendar.
    check(`${size}: a personal account's task has Task color and "Add a Google Drive attachment", but no Do not disturb or declining (work and school accounts only, as Google Calendar says)`, (await editor.getByRole('button', { name: /^Task color: / }).count()) === 1 && (await editor.getByRole('button', { name: 'Add a Google Drive attachment' }).count()) === 1 && (await editor.getByRole('checkbox', { name: 'Do not disturb' }).count()) === 0 && (await editor.getByRole('checkbox', { name: 'Automatically decline meetings' }).count()) === 0 && (await editor.innerText()).includes('for work and school accounts, as in Google Calendar'));
    await availability.selectOption('busy');
    await visibility.selectOption('private');
    await shot('tc-07-advanced-settings');
    await editor.getByRole('button', { name: 'Done' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
    const keptReport = async () => (await state()).googleTasks?.[`${ME}\nt-report`];
    check(`${size}: kept in the Planner: 3–4pm, Busy, Private (Google gets none of them)`, await until(async () => { const kept = await keptReport(); return kept?.time === 900 && kept?.duration === 60 && kept?.busy === true && kept?.visibility === 'private'; }, 10_000), JSON.stringify(await keptReport()));
    check(`${size}: Google got no time, availability or visibility`, !('busy' in (googleTask('L1', 't-report') ?? {})) && !('visibility' in (googleTask('L1', 't-report') ?? {})) && googleTask('L1', 't-report')?.due === due(1));
    await reportChip().click();
    const details = f.getByRole('dialog', { name: /^Google task: Send the report/ });
    check(`${size}: its details say Busy · Private`, await details.getByText('Busy · Private').waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    await shot('tc-08-details-busy-private');
    // Plan it tomorrow (a Planner task planning it) before closing: its working session shows its visibility below.
    await details.getByRole('button', { name: 'Plan on tomorrow' }).click();
    await until(async () => Object.values((await state()).tasks).some((task) => task.source?.id === 't-report' && !task.deletedAt), 10_000);
    await page.keyboard.press('Escape');

    // Busy: "Timebox automatically" plans around it (3pm is taken, so 4pm); Free: it may take 3pm.
    const created = await commands(
      { type: 'task.created', task: { id: `summary${size}`, title: 'Write the summary', placement: { kind: 'day', date: tomorrow }, position: 1, plannedMinutes: 60 } },
      { type: 'task.created', task: { id: `agenda${size}`, title: 'Draft the agenda', placement: { kind: 'day', date: tomorrow }, position: 2, plannedMinutes: 60 } },
    );
    if (created.status !== 200) throw new Error(`tasks: ${created.text}`);
    const timebox = async (title) => {
      await go('Home');
      const card = f.locator('section.day-column li.task-card', { hasText: title });
      await card.waitFor({ timeout: 15_000 });
      await card.scrollIntoViewIfNeeded();
      await card.hover();
      await card.getByRole('button', { name: 'Task actions' }).click();
      await card.getByRole('menuitem', { name: 'Timebox automatically' }).click();
    };
    const blockOf = async (taskId) => Object.values((await state()).blocks).find((block) => block.taskId === taskId);
    await timebox('Write the summary');
    const summaryBlock = await until(() => blockOf(`summary${size}`), 10_000);
    check(`${size}: Busy counts: "Timebox automatically" plans around the task (4pm, not 3pm)`, summaryBlock?.start === new Date(at(tomorrow, 16 * 60)).toISOString(), JSON.stringify(summaryBlock));
    await shot('tc-09-timeboxed-around-busy');
    await go('Calendar');
    await f.locator('.day-lane').first().waitFor();
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    editor = await openEditor();
    await editor.getByRole('combobox', { name: 'Availability' }).selectOption('free');
    await editor.getByRole('button', { name: 'Done' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
    await until(async () => (await keptReport())?.busy === undefined, 10_000);
    await timebox('Draft the agenda');
    const agendaBlock = await until(() => blockOf(`agenda${size}`), 10_000);
    check(`${size}: Free does not: the next one takes 3pm, the task's time`, agendaBlock?.start === new Date(at(tomorrow, 15 * 60)).toISOString(), JSON.stringify(agendaBlock));

    // Visibility: the working session written to Google Calendar for the task planning it is private, then public.
    const linked = Object.values((await state()).tasks).find((task) => task.source?.id === 't-report' && !task.deletedAt);
    await timebox(linked.title);
    const sessionOf = () => [...fake.calendars.get('primary').events.values()].find((event) => event.extendedProperties?.private?.plannerTaskId === linked.id);
    const privateSession = await until(() => sessionOf()?.visibility === 'private' && sessionOf(), 15_000);
    check(`${size}: its working session is written to Google Calendar as private (others see it as busy, without its title)`, privateSession, JSON.stringify(sessionOf()));
    await go('Calendar');
    await f.locator('.day-lane').first().waitFor();
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    editor = await openEditor();
    await editor.getByRole('combobox', { name: 'Visibility' }).selectOption('public');
    await editor.getByRole('button', { name: 'Done' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
    check(`${size}: a new visibility reaches the session in Google Calendar`, await until(() => sessionOf()?.visibility === 'public', 15_000), JSON.stringify(sessionOf()));

    // After a reload: Free and Public, in the editor and the details.
    await page.reload({ waitUntil: 'load' });
    f = await h.openPlanner();
    await go('Calendar');
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    await reportChip().waitFor({ timeout: 15_000 });
    await reportChip().click();
    const after = f.getByRole('dialog', { name: /^Google task: Send the report/ });
    const afterText = await after.innerText();
    check(`${size}: after a reload its details say Free · Public, at 3 – 4pm`, afterText.includes('Free · Public') && afterText.includes('3 – 4pm'), afterText);
    await after.getByRole('button', { name: 'Edit task' }).click();
    editor = f.getByRole('dialog', { name: /^Edit task: Send the report/ });
    await editor.waitFor();
    const advancedOpen = (await editor.getByRole('combobox', { name: 'Availability' }).count()) === 1;
    check(`${size}: and its editor opens its Advanced settings on Free and Public`, advancedOpen && (await editor.getByRole('combobox', { name: 'Availability' }).inputValue()) === 'free' && (await editor.getByRole('combobox', { name: 'Visibility' }).inputValue()) === 'public');
    await shot('tc-10-after-reload-advanced');
    await editor.getByRole('button', { name: 'Cancel' }).click();

    // A task without a time has neither, as in Google Calendar.
    if (!(await lane(addDays(today, 3)).count())) await f.getByRole('button', { name: 'Next week' }).click();
    await allDay();
    await f.getByRole('button', { name: /^Google task Plan the trip, due/ }).first().click();
    await f.getByRole('dialog', { name: /^Google task: Plan the trip/ }).getByRole('button', { name: 'Edit task' }).click();
    const tripEditor = f.getByRole('dialog', { name: /^Edit task: Plan the trip/ });
    await tripEditor.getByRole('button', { name: 'Advanced settings' }).click();
    check(`${size}: a task without a time has no availability or visibility to set (free and private), and says why`, (await tripEditor.getByRole('combobox', { name: 'Availability' }).isDisabled()) && (await tripEditor.getByRole('combobox', { name: 'Visibility' }).isDisabled()) && (await tripEditor.innerText()).includes('A task without a time is free and private'));
    await shot('tc-11-untimed-advanced');
    await tripEditor.getByRole('button', { name: 'Cancel' }).click();

    // ── A task's time notifies at that time: Book the dentist, today at the next minute (set now, before it).
    const minute = Math.ceil(minutesIn(ZONE)) + 1;
    const dentistAt = at(today, minute);
    const dentistText = `Task at ${clock(minute)}: Book the dentist`;
    expect200(await commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-dentist', patch: { time: minute } }));
    const dentist = toast(dentistText);
    await until(async () => (await dentist.count()) > 0 || Date.now() >= dentistAt - 1500, 3 * 60_000);
    check(`${size}: not before its time`, (await dentist.count()) === 0, `${new Date().toISOString()} < ${new Date(dentistAt).toISOString()}`);
    const came = await until(async () => (await dentist.count()) > 0, Math.max(0, dentistAt - Date.now()) + 45_000);
    const late = Date.now() - dentistAt;
    check(`${size}: at its time ("${dentistText}"), within 35 s`, came && late < 35_000, `${late} ms after`);
    console.log(`  ${size}: the time notification came ${late} ms after its time`);
    // Once it has slid in.
    await sleep(800);
    await shot('tc-12-time-notification');
    await dismiss(dentistText);
    check(`${size}: and OK dismisses it`, (await dentist.count()) === 0);
    // Each comes once: not again after a reload.
    const before = takes();
    await page.reload({ waitUntil: 'load' });
    f = await h.openPlanner();
    await until(() => takes() > before, 20_000);
    await sleep(2500);
    check(`${size}: after a reload it does not come again`, takes() > before && (await dentist.count()) === 0);

    // The setting: on by default, off stops them.
    await go('Settings');
    const setting = f.getByRole('checkbox', { name: /^Task notifications, as Google Calendar gives them/ });
    await setting.waitFor({ timeout: 10_000 });
    check(`${size}: Settings → Google has "Task notifications", on`, await setting.isChecked());
    check(`${size}: and says where they come from and what Google's own apps can't notify`, (await f.getByText(/The Planner gives these itself, as OpenChamber notifications/).count()) === 1);
    await setting.uncheck();
    await until(async () => (await state()).settings.googleTaskNotifications === false, 10_000);
    expect200(await commands({ type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-call', patch: { time: Math.ceil(minutesIn(ZONE)) + 1 } }));
    const off = await h.call('POST', '/google/tasks/notifications');
    check(`${size}: off, none comes`, off.status === 200 && off.json.notifications.length === 0 && off.json.next === null, off.text);
    await shot('tc-13-setting');
    await setting.check();
    await until(async () => (await state()).settings.googleTaskNotifications === true, 10_000);
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the journey ran to its end`, false, error?.stack ?? String(error));
    await shot('tc-99-failure').catch(() => {});
  } finally {
    await h.close();
    await fake.close();
  }
};

const expect200 = (answer) => {
  if (answer.status !== 200) throw new Error(`the service refused: ${answer.text}`);
};

/**
 * Round 10 (review 9's P1): the rest of a task's settings in Google Calendar, for a work account (the fake's ID token
 * says example.com) that has not allowed Drive yet.
 * - Drive attachments: "Add a Google Drive attachment" asks Google for Drive (a sign-in whose redirect is pasted),
 *   then finds the account's files by name; Insert; the file opens in Drive from the task's details; Remove attachment.
 * - Task color: a task's own (Advanced settings) and a task list's (its row under "My calendars"), on the calendar;
 *   a list's checkbox hides its tasks.
 * - Do not disturb: a task notification due during such a task is held until it ends, then comes.
 * - Automatically decline meetings (Busy): the invitation overlapping the task is declined in the fake Calendar, with
 *   the task's message, for the organizer; the one after it and the one I organize are not.
 * - All of it after a reload; Google Tasks gets none of it.
 */
const advancedJourney = async (viewport) => {
  const size = `${viewport.width}`;
  const today = dayOf(Date.now());
  const tomorrow = addDays(today, 1);
  const due = (days) => `${addDays(today, days)}T00:00:00.000Z`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const world = defaultFakeWorld({ account: ME, today, zone: ZONE });
  world.hostedDomain = 'example.com';
  world.granted = [...DEFAULT_SCOPES];
  world.driveFiles = [
    { id: 'drive-plan', name: 'Q4 plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/drive-plan/edit', modifiedTime: '2026-10-20T10:00:00Z' },
    { id: 'drive-budget', name: 'Budget 2027', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://docs.google.com/spreadsheets/d/drive-budget/edit', modifiedTime: '2026-10-25T10:00:00Z' },
    { id: 'drive-folder', name: 'Plans folder', mimeType: 'application/vnd.google-apps.folder', webViewLink: 'https://drive.google.com/drive/folders/drive-folder' },
  ];
  // Send the report is tomorrow at 3–4pm once timed; Buy stamps (Errands) tomorrow too, for its list's color.
  world.tasks.L1[0].due = due(1);
  world.tasks.L2[0].due = due(1);
  // Do not disturb: Focus block (today, from 3 minutes ago for 6) holds Call the bank's notification (a minute ago).
  const now = Math.floor(minutesIn(ZONE));
  world.tasks.L1.push({ id: 't-focus', title: 'Focus block', notes: '', due: due(0), status: 'needsAction', updated: yesterday }, { id: 't-call', title: 'Call the bank', notes: '', due: due(0), status: 'needsAction', updated: yesterday });
  // Tomorrow's invitations: one overlaps 3–4pm, one comes after it, and one I organize overlaps it too.
  const at = (key, minutes) => new Date(atZone(key, minutes)).toISOString();
  const invitation = (id, summary, from, to) => ({ id, summary, created: '2026-01-05T10:00:00.000Z', start: { dateTime: at(tomorrow, from) }, end: { dateTime: at(tomorrow, to) }, organizer: { email: 'lead@example.com', displayName: 'Lead' }, attendees: [{ email: 'lead@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'needsAction' }] });
  world.events.primary.push(
    invitation('inv-overlap', 'Roadmap sync', 15 * 60 + 15, 15 * 60 + 45),
    invitation('inv-after', 'Retro prep', 16 * 60 + 30, 17 * 60),
    { id: 'inv-mine', summary: 'My review', created: '2026-01-05T10:00:00.000Z', start: { dateTime: at(tomorrow, 15 * 60) }, end: { dateTime: at(tomorrow, 15 * 60 + 30) }, organizer: { email: ME, self: true }, attendees: [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@example.com', responseStatus: 'needsAction' }] },
  );
  const fake = await startFakeGoogle(world);
  const seeded = [
    { type: 'settings.updated', patch: { timezone: ZONE } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-focus', patch: { time: now - 3, duration: 6, doNotDisturb: true } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-call', patch: { time: now - 1 } },
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const focusEnd = atZone(today, now + 3);
  // The sign-in Google's page would make: the service's answer to "connect", read on its way to the page.
  const connects = [];
  let h;
  h = await startHarness({
    out,
    viewport,
    timezoneId: ZONE,
    taskNotifications: true,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
    serviceOverride: async ({ method, path, body }) => {
      if (method !== 'POST' || path !== '/google/connect') return undefined;
      const answer = await h.call('POST', '/google/connect', body);
      connects.push(answer.json);
      return answer.status === 200 ? answer.json : { __status: answer.status, body: answer.json };
    },
  });
  const { page, context } = h;
  // Google's own pages are not visited for real: what the Planner opens is recorded.
  const opened = [];
  for (const origin of ['https://accounts.google.com/**', 'https://docs.google.com/**', 'https://drive.google.com/**']) {
    await context.route(origin, (route) => {
      opened.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: '<p>Google (e2e)</p>' });
    });
  }
  const plannerErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  const shot = (name) => h.shot(`${name}-${size}`);
  const state = async () => (await h.call('GET', '/state')).json.state;
  const googleTask = (listId, id) => fake.tasks.get(listId)?.find((task) => task.id === id);
  const toast = (text) => page.locator('li[data-sonner-toast]', { hasText: text });
  const keptReport = async () => (await state()).googleTasks?.[`${ME}\nt-report`];
  const callText = `Task at ${clock(now - 1)}: Call the bank`;
  let f;
  try {
    f = await h.openPlanner();
    const go = async (name) => {
      if (!(await h.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
      await h.nav(name).click();
    };
    // ── Do not disturb: Focus block's own notification comes (it says to begin); Call the bank's waits for its end.
    const focusToast = toast('Focus block');
    await until(async () => (await focusToast.count()) > 0, 20_000);
    const takes = () => h.serviceCalls.filter((call) => call.method === 'POST' && call.path === '/google/tasks/notifications').length;
    await until(() => takes() >= 2, 20_000);
    check(`${size}: Do not disturb: a task with it gets its own notification at its start (missed while closed, it comes on opening)`, (await focusToast.count()) > 0, await page.locator('li[data-sonner-toast]').allInnerTexts().catch(() => []));
    check(`${size}: but a task's notification due during it does not come then (${callText})`, Date.now() < focusEnd && (await toast(callText).count()) === 0, `${new Date().toISOString()} vs ${new Date(focusEnd).toISOString()}`);
    await shot('tc-20-dnd-held');
    await focusToast.getByRole('button', { name: 'OK' }).click({ timeout: 3000 }).catch(() => {});
    const came = await until(async () => (await toast(callText).count()) > 0, Math.max(0, focusEnd - Date.now()) + 45_000);
    const after = Date.now() - focusEnd;
    check(`${size}: it comes when the task with Do not disturb ends, within 35 s`, came && after >= -1000 && after < 35_000, `${after} ms after its end`);
    console.log(`  ${size}: the held notification came ${after} ms after Do not disturb ended`);
    await shot('tc-21-dnd-released');
    await toast(callText).getByRole('button', { name: 'OK' }).click({ timeout: 3000 }).catch(() => {});

    // ── The calendar: Send the report, tomorrow.
    await go('Calendar');
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    const lane = (date) => f.locator(`.day-lane[data-date="${date}"]`);
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    const allDay = async () => {
      const toggle = f.getByRole('button', { name: 'Show all all-day events' });
      if (await toggle.count()) await toggle.first().click();
    };
    await until(async () => (await f.getByRole('button', { name: /^Google task Send the report, due/ }).count()) > 0 || (await f.getByRole('button', { name: 'Show all all-day events' }).count()) > 0, 15_000);
    await allDay();
    const reportChip = () => f.getByRole('button', { name: /^Google task Send the report, due/ }).first();
    const openEditor = async () => {
      await reportChip().click();
      await f.getByRole('dialog', { name: /^Google task: Send the report/ }).getByRole('button', { name: 'Edit task' }).click();
      const editor = f.getByRole('dialog', { name: /^Edit task: Send the report/ });
      await editor.waitFor();
      return editor;
    };
    let editor = await openEditor();
    await editor.getByRole('combobox', { name: 'Time', exact: true }).selectOption('900');
    await editor.getByRole('combobox', { name: 'End time' }).selectOption('960');

    // ── Drive: not allowed yet, so the picker asks for it, as Google asks for one more permission.
    await editor.getByRole('button', { name: 'Add a Google Drive attachment' }).click();
    const picker = f.getByRole('dialog', { name: 'Add a Google Drive attachment' });
    await picker.waitFor();
    check(`${size}: "Add a Google Drive attachment" first asks to allow Google Drive, saying what it sees (names, never contents)`, (await picker.getByRole('button', { name: 'Allow Google Drive' }).count()) === 1 && (await picker.innerText()).includes('never their contents'));
    await shot('tc-22-drive-allow');
    await picker.getByRole('button', { name: 'Allow Google Drive' }).click();
    await until(() => connects.length > 0, 10_000);
    const started = connects.at(-1);
    const auth = new URL(started.authUrl);
    check(`${size}: it asks Google for what the account has plus Drive (read-only names), keeping what it granted before`, auth.searchParams.get('scope').split(' ').includes('https://www.googleapis.com/auth/drive.metadata.readonly') && auth.searchParams.get('scope').includes('auth/tasks') && auth.searchParams.get('include_granted_scopes') === 'true', auth.searchParams.get('scope'));
    check(`${size}: Google's consent page opens in the browser`, await until(() => opened.some((url) => url.startsWith('https://accounts.google.com/')), 10_000), JSON.stringify(opened));
    const paste = picker.getByRole('textbox', { name: 'Address Google sent the browser to' });
    await paste.waitFor({ timeout: 10_000 });
    await paste.fill(`${started.redirectUri}?${new URLSearchParams({ state: auth.searchParams.get('state'), code: fakeAuthCode(auth.searchParams.get('scope')) })}`);
    await picker.getByRole('button', { name: 'Finish' }).click();
    const search = picker.getByRole('searchbox', { name: 'Search in Drive' });
    check(`${size}: once allowed, the picker searches the account's Drive (its latest files; no folders)`, await search.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false) && (await until(async () => (await picker.getByRole('checkbox').count()) === 2, 10_000)), await picker.innerText().catch(() => ''));
    check(`${size}: the account now has Drive too, beside what it had`, await until(async () => JSON.stringify((await h.call('GET', '/google/status')).json.accounts[0].features) === '["calendar","tasks","mail","drive"]', 10_000));
    await search.fill('plan');
    await until(async () => (await picker.getByRole('checkbox').count()) === 1, 10_000);
    check(`${size}: typing finds files by name in Drive`, (await picker.getByRole('checkbox', { name: 'Q4 plan' }).count()) === 1 && fake.requests.some((request) => request.path === '/drive/v3/files' && /name contains 'plan'/.test(request.query.q ?? '')));
    await picker.getByRole('checkbox', { name: 'Q4 plan' }).check();
    await shot('tc-23-drive-picker');
    await picker.getByRole('button', { name: 'Insert' }).click();
    await picker.waitFor({ state: 'detached', timeout: 5000 });
    check(`${size}: Insert puts it in the task's form, with "Remove attachment"`, (await editor.getByRole('button', { name: 'Open Q4 plan' }).count()) === 1 && (await editor.getByRole('button', { name: 'Remove attachment Q4 plan' }).count()) === 1);

    // ── Advanced settings, as Google Calendar's for a work account: color, availability, Do not disturb, declining, visibility.
    await editor.getByRole('button', { name: 'Advanced settings' }).click();
    const decline = editor.getByRole('checkbox', { name: 'Automatically decline meetings' });
    check(`${size}: a work account's task offers Task color, Free/Busy, Do not disturb, Automatically decline meetings and visibility`, (await editor.getByRole('button', { name: /^Task color: / }).count()) === 1 && (await editor.getByRole('combobox', { name: 'Availability' }).count()) === 1 && (await editor.getByRole('checkbox', { name: 'Do not disturb' }).count()) === 1 && (await decline.count()) === 1 && (await editor.getByRole('combobox', { name: 'Visibility' }).count()) === 1);
    check(`${size}: declining is "Unavailable for "Free" time entries", as in Google Calendar`, (await decline.isDisabled()) && (await editor.innerText()).includes('Unavailable for "Free" time entries'));
    check(`${size}: Do not disturb says what it mutes here, and what it can't (Chat, other apps)`, (await editor.innerText()).includes("Mutes the Planner's own task notifications") && (await editor.innerText()).includes("Google Chat, other apps and OpenChamber's own notifications aren't muted"));
    await editor.getByRole('button', { name: 'Task color: List color' }).click();
    const colors = editor.getByRole('menu', { name: 'Task color' });
    check(`${size}: the color menu has Google Calendar's colors and the list's`, (await colors.getByRole('menuitemradio').count()) === 12 && (await colors.getByRole('menuitemradio', { name: 'Basil' }).count()) === 1);
    await shot('tc-24-color-menu');
    await colors.getByRole('menuitemradio', { name: 'Basil' }).click();
    await editor.getByRole('combobox', { name: 'Availability' }).selectOption('busy');
    await decline.check();
    await editor.getByRole('combobox', { name: 'Meetings to decline' }).selectOption('all');
    const message = 'Declined: heads down on the Q4 plan';
    await editor.getByRole('textbox', { name: 'Message' }).fill(message);
    await editor.getByRole('checkbox', { name: 'Do not disturb' }).check();
    await shot('tc-25-advanced-work-account');
    await editor.getByRole('button', { name: 'Done' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
    check(`${size}: kept in the Planner: 3–4pm, Busy, Basil, Q4 plan attached, Do not disturb, declining new and existing meetings with the message`, await until(async () => {
      const kept = await keptReport();
      return kept?.time === 900 && kept.busy === true && kept.color === '#0b8043' && kept.attachments?.[0]?.id === 'drive-plan' && kept.doNotDisturb === true && kept.decline?.mode === 'all' && kept.decline.message === message;
    }, 10_000), JSON.stringify(await keptReport()));
    const report = googleTask('L1', 't-report');
    check(`${size}: Google Tasks got none of them (its API has no color, attachments, Do not disturb or declining)`, report && !['color', 'attachments', 'doNotDisturb', 'decline', 'links'].some((key) => key in report) && report.due === due(1), JSON.stringify(report));

    // ── Declined: the invitation overlapping 3–4pm, with the message, which Google sends the organizer.
    const self = (id) => fake.calendars.get('primary').events.get(id)?.attendees?.find((guest) => guest.self);
    const declined = await until(() => self('inv-overlap')?.responseStatus === 'declined', 20_000);
    check(`${size}: the overlapping invitation is declined in Google Calendar, with the task's message for the organizer`, declined && self('inv-overlap')?.comment === message, JSON.stringify(self('inv-overlap')));
    const patches = fake.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/events/inv-overlap'));
    check(`${size}: once, and the organizer is told (sendUpdates=all)`, patches.length === 1 && patches[0].query.sendUpdates === 'all', JSON.stringify(patches.map((request) => request.query)));
    check(`${size}: the meeting after the task and the one I organize are left alone`, self('inv-after')?.responseStatus === 'needsAction' && !fake.requests.some((request) => request.method === 'PATCH' && /\/events\/inv-(after|mine)$/.test(request.path)));
    check(`${size}: the Planner says what it declined`, await until(async () => (await f.getByText('Declined a meeting during "Send the report": "Roadmap sync"').count()) > 0, 5000));

    // ── On the calendar: Basil; its details: Do not disturb, what was declined, the attachment, which opens in Drive.
    const chipColor = async () => reportChip().evaluate((node) => getComputedStyle(node).getPropertyValue('--item-color').trim() || node.style.getPropertyValue('--item-color'));
    check(`${size}: the task is Basil on the calendar`, await until(async () => (await chipColor()).toLowerCase() === '#0b8043', 10_000), await chipColor());
    await reportChip().click();
    const details = f.getByRole('dialog', { name: /^Google task: Send the report/ });
    await details.waitFor();
    check(`${size}: its details say Busy, Do not disturb · Declines meetings, and which meeting was declined`, await until(async () => (await details.innerText()).includes('Do not disturb · Declines meetings') && (await details.innerText()).includes('Declined: Roadmap sync'), 10_000), await details.innerText());
    const openDoc = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
    await details.getByRole('button', { name: 'Open Q4 plan' }).click();
    const docTab = await openDoc;
    check(`${size}: its attachment opens in Google Drive (a new browser tab)`, await until(() => opened.includes('https://docs.google.com/document/d/drive-plan/edit'), 10_000), JSON.stringify(opened));
    await docTab?.close().catch(() => {});
    await shot('tc-26-details-attachment');
    await page.keyboard.press('Escape');

    // ── A task list's color, under "My calendars": Errands' tasks take it; its checkbox hides them.
    // At 1024 px the calendars fold away, as in Google Calendar: its main menu shows them.
    const rail = f.getByRole('list', { name: 'My calendars' });
    if (!(await rail.isVisible().catch(() => false))) await f.getByRole('button', { name: 'Main menu' }).click();
    await rail.waitFor({ timeout: 5000 });
    const stampsChip = () => f.getByRole('button', { name: /^Google task Buy stamps, due/ }).first();
    await allDay();
    const errandsRow = rail.locator('li', { hasText: 'Errands' });
    const listRows = await rail.locator('li.cal-row.is-nested').allInnerTexts().catch(() => []);
    check(`${size}: "My calendars" lists Tasks and each task list (My Tasks, Errands), with a checkbox each`, listRows.some((text) => text.includes('My Tasks')) && listRows.some((text) => text.includes('Errands')), JSON.stringify(listRows));
    await errandsRow.hover();
    await errandsRow.getByRole('button', { name: 'Options for Errands' }).click();
    await f.getByRole('menu', { name: 'Options for Errands' }).getByRole('button', { name: 'Color #f4511e' }).click();
    check(`${size}: a list's color is kept (the Planner's: Google Tasks has none)`, await until(async () => (await state()).settings.googleTaskListColors?.[`${ME}\nL2`] === '#f4511e', 10_000));
    const stampsColor = async () => stampsChip().evaluate((node) => getComputedStyle(node).getPropertyValue('--item-color').trim() || node.style.getPropertyValue('--item-color'));
    check(`${size}: Errands' task takes its list's color; Send the report keeps its own`, await until(async () => (await stampsColor()).toLowerCase() === '#f4511e', 10_000) && (await chipColor()).toLowerCase() === '#0b8043', `${await stampsColor()} / ${await chipColor()}`);
    await shot('tc-27-list-color');
    await errandsRow.getByRole('checkbox').uncheck();
    check(`${size}: unchecking Errands hides its tasks; the other list's stay`, await until(async () => (await stampsChip().count()) === 0, 10_000) && (await reportChip().count()) === 1);
    await errandsRow.getByRole('checkbox').check();
    check(`${size}: checking it shows them again`, await until(async () => (await stampsChip().count()) === 1, 10_000));

    // ── After a reload: all of it, in the editor; then Remove attachment.
    await page.reload({ waitUntil: 'load' });
    f = await h.openPlanner();
    await go('Calendar');
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    await reportChip().waitFor({ timeout: 15_000 });
    editor = await openEditor();
    const advancedOpen = (await editor.getByRole('checkbox', { name: 'Do not disturb' }).count()) === 1;
    check(`${size}: after a reload the editor has it all: Basil, Busy, Do not disturb, declining with its message, Q4 plan`, advancedOpen && (await editor.getByRole('button', { name: 'Task color: Basil' }).count()) === 1 && (await editor.getByRole('combobox', { name: 'Availability' }).inputValue()) === 'busy' && (await editor.getByRole('checkbox', { name: 'Do not disturb' }).isChecked()) && (await editor.getByRole('checkbox', { name: 'Automatically decline meetings' }).isChecked()) && (await editor.getByRole('textbox', { name: 'Message' }).inputValue()) === message && (await editor.getByRole('button', { name: 'Open Q4 plan' }).count()) === 1);
    await shot('tc-28-after-reload');
    await editor.getByRole('button', { name: 'Remove attachment Q4 plan' }).click();
    check(`${size}: Remove attachment takes it off the form`, (await editor.getByRole('button', { name: 'Open Q4 plan' }).count()) === 0);
    await editor.getByRole('button', { name: 'Done' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
    check(`${size}: and, saved, off the task (the rest stays)`, await until(async () => { const kept = await keptReport(); return kept && !kept.attachments && kept.color === '#0b8043' && kept.doNotDisturb === true; }, 10_000), JSON.stringify(await keptReport()));
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the work-account journey ran to its end`, false, error?.stack ?? String(error));
    await shot('tc-29-failure').catch(() => {});
  } finally {
    await h.close();
    await fake.close();
  }
};

/**
 * Round 10's inventory of Google Tasks' help: the operations the Planner lacked, in Tasks in Calendar.
 * - Sort by Deadline and by Title; shared tasks (assigned in a Doc: no repeat, no subtasks) and a task from Gmail
 *   show where they came from.
 * - Keyboard shortcuts: s stars, Ctrl+Shift+Down moves to the bottom, Space completes, Ctrl+/ lists them.
 * - Delete, then Undo (the snackbar's, and Ctrl+Z): Google has the task back, with what the Planner kept.
 * - Complete, then Undo ("Task completed · Undo", and Ctrl+Z): a plain task open again; a daily one too, its next task
 *   gone again.
 * - Lists reordered with Alt+Up; Starred sorted by Date, a starred task added to the list chosen, moved to another.
 * - Gmail's "Add to Tasks".
 */
const inventoryJourney = async (viewport) => {
  const size = `${viewport.width}`;
  const today = dayOf(Date.now());
  const due = (days) => `${addDays(today, days)}T00:00:00.000Z`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const world = defaultFakeWorld({ account: ME, today, zone: ZONE });
  // Send the report and the done Water the plants are today's, on the calendar's day whatever the week.
  world.tasks.L1[0].due = due(0);
  world.tasks.L1.push(
    { id: 't-shared', title: 'Review the draft', notes: '', status: 'needsAction', updated: yesterday, assignmentInfo: { surfaceType: 'DOCUMENT', linkToTask: 'https://docs.google.com/document/d/doc-1/edit' } },
    { id: 't-mailed', title: 'Reply to Ann', notes: '', status: 'needsAction', updated: yesterday, links: [{ type: 'email', description: 'Quarterly numbers', link: 'https://mail.google.com/mail/u/0/#all/thread-1' }] },
    { id: 't-watered', title: 'Water the plants', notes: '', due: due(0), status: 'completed', completed: yesterday, updated: yesterday },
  );
  world.mail = [{ id: 'msg-1', threadId: 'thread-9', subject: 'Budget review', from: 'Lead <lead@example.com>', date: new Date(Date.now() - 3_600_000).toUTCString(), snippet: 'Can you look at the numbers', unread: true }];
  const fake = await startFakeGoogle(world);
  const seeded = [
    { type: 'settings.updated', patch: { timezone: ZONE } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-report', patch: { deadline: addDays(today, 5) } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 't-shared', patch: { deadline: addDays(today, -1) } },
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const h = await startHarness({
    out,
    viewport,
    timezoneId: ZONE,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
  });
  const { page } = h;
  const plannerErrors = [];
  page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  const shot = (name) => h.shot(`${name}-${size}`);
  const state = async () => (await h.call('GET', '/state')).json.state;
  const googleTask = (listId, id) => fake.tasks.get(listId)?.find((task) => task.id === id);
  const order = (listId) => (fake.tasks.get(listId) ?? []).filter((task) => !task.parent && task.status !== 'completed').map((task) => task.id);
  let f;
  try {
    f = await h.openPlanner();
    const go = async (name) => {
      if (!(await h.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
      await h.nav(name).click();
    };
    await go('Calendar');
    await f.getByRole('radio', { name: 'Tasks' }).click();
    const myTasks = f.getByRole('region', { name: 'My Tasks' });
    await myTasks.getByRole('listitem', { name: 'Review the draft' }).waitFor({ timeout: 20_000 });

    // ── Where a task came from: a shared task (a Doc) and an email added to Tasks; a shared task neither repeats nor takes subtasks.
    check(`${size}: a shared task says it was assigned in Google Docs, and a task from Gmail says so, with the email`, (await myTasks.getByRole('button', { name: 'Assigned in Google Docs' }).count()) === 1 && (await myTasks.getByRole('button', { name: 'From Gmail: Quarterly numbers' }).count()) === 1);
    await myTasks.getByRole('button', { name: 'Edit Review the draft' }).click();
    const sharedForm = myTasks.getByRole('group', { name: 'Edit Review the draft' });
    await sharedForm.waitFor();
    check(`${size}: a shared task can't repeat nor take subtasks, as in Google Tasks (and says so)`, (await sharedForm.getByRole('combobox', { name: 'Repeat' }).isDisabled()) && (await sharedForm.innerText()).includes("A shared task can't repeat") && (await sharedForm.getByRole('button', { name: 'Add subtask' }).getAttribute('title')) === "A shared task can't have subtasks, as in Google Tasks");
    await shot('tc-30-shared-task');
    await sharedForm.getByRole('button', { name: 'Cancel' }).click();

    // ── Sort by: Deadline and Title, as Google Tasks has them.
    const sortBy = async (name) => {
      await myTasks.getByRole('button', { name: 'List options for My Tasks' }).click();
      await f.getByRole('menu', { name: 'List options for My Tasks' }).getByRole('menuitemradio', { name }).click();
    };
    await sortBy('Deadline');
    const byDeadline = myTasks.getByRole('list', { name: 'My Tasks tasks by deadline' });
    const deadlineText = await byDeadline.innerText();
    check(`${size}: Sort by Deadline: the past one first, then by deadline, then "No deadline"`, deadlineText.indexOf('Past') < deadlineText.indexOf('Review the draft') && deadlineText.indexOf('Review the draft') < deadlineText.indexOf('Send the report') && deadlineText.indexOf('Send the report') < deadlineText.indexOf('No deadline') && deadlineText.indexOf('No deadline') < deadlineText.indexOf('Plan the trip'), deadlineText);
    await shot('tc-31-sort-deadline');
    await sortBy('Title');
    const titles = await myTasks.getByRole('list', { name: 'My Tasks tasks by title' }).getByRole('listitem').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')));
    check(`${size}: Sort by Title: A to Z`, JSON.stringify(titles) === JSON.stringify(['Book the hotel', 'Plan the trip', 'Reply to Ann', 'Review the draft', 'Send the report']), JSON.stringify(titles));
    await sortBy('My order');

    // ── Keyboard shortcuts on the selected task.
    const row = (title) => myTasks.getByRole('list', { name: 'My Tasks tasks' }).getByRole('listitem', { name: title, exact: true });
    await row('Plan the trip').locator('.gt-body-edit').focus();
    await page.keyboard.press('s');
    check(`${size}: s stars the selected task`, await until(async () => Boolean((await state()).googleTasks?.[`${ME}\nt-trip`]?.starredAt), 10_000));
    await page.keyboard.press('Control+Shift+ArrowDown');
    check(`${size}: Ctrl+Shift+Down moves it to the bottom of the list, in Google`, await until(() => order('L1').at(-1) === 't-trip', 10_000), JSON.stringify(order('L1')));
    await sortBy('Starred recently');
    const starredFirst = await myTasks.getByRole('list', { name: 'My Tasks tasks, starred recently' }).getByRole('listitem').evaluateAll((rows) => rows.map((one) => one.getAttribute('aria-label')));
    check(`${size}: Sort by Starred recently puts the starred one first`, starredFirst[0] === 'Plan the trip', JSON.stringify(starredFirst));
    await sortBy('My order');
    await row('Reply to Ann').locator('.gt-body-edit').focus();
    await page.keyboard.press(' ');
    check(`${size}: Space completes the selected task, in Google`, await until(() => googleTask('L1', 't-mailed')?.status === 'completed', 10_000));
    await page.keyboard.press('Control+/');
    const help = f.getByRole('dialog', { name: 'Keyboard shortcuts' });
    // Print prints since round 11 where the host lets the frame open the print dialog (allow-modals); elsewhere it says why.
    const modals = ((await page.locator('.inset-0 > iframe[title="Planner"]').getAttribute('sandbox')) ?? '').split(/\s+/).includes('allow-modals');
    check(`${size}: Ctrl+/ lists Google Tasks' shortcuts with Print; Report spam marked as not here (and why)${modals ? '' : ', and Print as needing oc-forge\'s host'}`, await help.waitFor({ timeout: 5000 }).then(async () => {
      const text = await help.innerText();
      return text.includes('Move to bottom') && text.includes('Print the list') && text.includes("Shared tasks are reported in the Doc") && text.includes("Printing needs OpenChamber with oc-forge's host") === !modals;
    }).catch(() => false));
    await shot('tc-32-shortcuts');
    await page.keyboard.press('Escape');

    // ── Delete, then Undo: the snackbar's, and Ctrl+Z.
    await row('Send the report').hover();
    await row('Send the report').getByRole('button', { name: 'Actions for Send the report' }).click();
    await f.getByRole('menu', { name: 'Actions for Send the report' }).getByRole('menuitem', { name: 'Delete' }).click();
    check(`${size}: Delete takes it out of Google`, await until(() => !googleTask('L1', 't-report'), 10_000));
    const snack = f.locator('.gcal-snack', { hasText: 'Task deleted' });
    await snack.waitFor({ timeout: 5000 });
    await shot('tc-33-deleted-undo');
    await snack.getByRole('button', { name: 'Undo' }).click();
    check(`${size}: Undo gives it back in Google, with its deadline kept in the Planner`, await until(async () => Boolean(googleTask('L1', 't-report')) && (await state()).googleTasks?.[`${ME}\nt-report`]?.deadline === addDays(today, 5), 10_000));
    check(`${size}: and it is back in the list`, await until(async () => (await row('Send the report').count()) === 1, 10_000));
    await row('Plan the trip').hover();
    await row('Plan the trip').getByRole('button', { name: 'Actions for Plan the trip' }).click();
    await f.getByRole('menu', { name: 'Actions for Plan the trip' }).getByRole('menuitem', { name: 'Delete' }).click();
    await until(() => !googleTask('L1', 't-trip'), 10_000);
    await row('Send the report').locator('.gt-body-edit').focus();
    await page.keyboard.press('Control+z');
    check(`${size}: Ctrl+Z undoes a deletion too: the task and its subtask are back in Google, still starred`, await until(async () => Boolean(googleTask('L1', 't-trip')) && Boolean(googleTask('L1', 't-hotel')) && Boolean((await state()).googleTasks?.[`${ME}\nt-trip`]?.starredAt), 10_000));

    // ── Complete, then Undo, as Google Tasks and Google Calendar offer it ("Task completed · Undo", and Ctrl+Z): at 1440
    //    a plain task, by the snackbar's Undo; at 1024 a daily one, by Ctrl+Z, its next task going again.
    const completedSnack = f.locator('.gcal-snack', { hasText: 'Task completed' });
    const saysCompleted = async () => (await completedSnack.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) && (await completedSnack.getByRole('button', { name: 'Undo' }).count()) === 1;
    if (size === '1440') {
      await row('Send the report').getByRole('checkbox', { name: 'Mark Send the report complete' }).click();
      const offered = await saysCompleted();
      check(`${size}: completing a task says "Task completed" with Undo, as Google Tasks and Google Calendar do`, offered && (await until(() => googleTask('L1', 't-report')?.status === 'completed', 10_000)));
      await shot('tc-38-completed-undo');
      await completedSnack.getByRole('button', { name: 'Undo' }).click();
      check(`${size}: the snackbar's Undo opens it again in Google, back in the list with its deadline`, await until(async () => googleTask('L1', 't-report')?.status === 'needsAction' && (await row('Send the report').count()) === 1 && (await state()).googleTasks?.[`${ME}\nt-report`]?.deadline === addDays(today, 5), 10_000));
    } else {
      await myTasks.getByRole('button', { name: 'Add a task' }).click();
      const daily = myTasks.getByRole('group', { name: 'New task' });
      await daily.getByRole('textbox', { name: 'Title' }).fill('Stretch');
      await daily.getByLabel('Date', { exact: true }).fill(today);
      await daily.getByRole('combobox', { name: 'Time', exact: true }).selectOption('540');
      await daily.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
      await daily.getByRole('button', { name: 'Add', exact: true }).click();
      const stretch = await until(() => (fake.tasks.get('L1') ?? []).find((task) => task.title === 'Stretch')?.id, 10_000);
      await until(async () => Boolean((await state()).googleTasks?.[`${ME}\n${stretch}`]?.repeat?.template), 10_000);
      await daily.getByRole('button', { name: 'Cancel' }).click();
      await row('Stretch').getByRole('checkbox', { name: 'Mark Stretch complete' }).click();
      const offered = await saysCompleted();
      const next = await until(() => (fake.tasks.get('L1') ?? []).find((task) => task.title === 'Stretch' && task.id !== stretch && task.status !== 'completed'), 15_000);
      check(`${size}: completing a daily task says "Task completed" with Undo, as Google Tasks and Google Calendar do, and makes tomorrow's`, offered && next?.due === due(1), JSON.stringify({ offered, next }));
      await shot('tc-38-completed-undo');
      await row('Send the report').locator('.gt-body-edit').focus();
      await page.keyboard.press('Control+z');
      const undone = await until(async () => {
        const plan = await state();
        return googleTask('L1', stretch)?.status === 'needsAction' && !googleTask('L1', next?.id) && plan.googleTasks?.[`${ME}\n${stretch}`]?.repeat?.next === null && !plan.googleTasks?.[`${ME}\n${next?.id}`];
      }, 15_000);
      check(`${size}: Ctrl+Z takes the daily task's completion back: open again in Google, tomorrow's task gone again, the series going on from it`, undone && (await until(async () => (await row('Stretch').count()) === 1, 10_000)));
      await shot('tc-38b-completed-undone');
    }

    // ── Lists in the order the user puts them: Alt+Up on Errands.
    const sidebar = f.getByRole('navigation', { name: 'Task lists' });
    await sidebar.getByRole('button', { name: 'Errands' }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    check(`${size}: Alt+Up moves a list up (kept in the Planner: Google's API has no order of lists)`, await until(async () => JSON.stringify((await state()).settings.googleTaskListOrder) === JSON.stringify([`${ME}\nL2`, `${ME}\nL1`]), 10_000));
    const sideOrder = await sidebar.getByRole('list', { name: 'Lists' }).getByRole('listitem').allInnerTexts();
    check(`${size}: the sidebar shows Errands first now`, sideOrder[0]?.includes('Errands') && sideOrder[1]?.includes('My Tasks'), JSON.stringify(sideOrder));
    await shot('tc-34-list-order');

    // ── Starred: sort by Date; a starred task added in the list chosen; then moved to another list.
    await sidebar.getByRole('button', { name: 'Starred' }).click();
    const starredSection = f.getByRole('region', { name: 'Starred' });
    await starredSection.getByRole('button', { name: 'Starred options' }).click();
    await f.getByRole('menu', { name: 'Starred options' }).getByRole('menuitemradio', { name: 'Date' }).click();
    await starredSection.getByRole('button', { name: 'Add a starred task' }).click();
    await starredSection.getByRole('combobox', { name: 'List for the starred task' }).selectOption(`${ME}\nL2`);
    const newStarred = starredSection.getByRole('group', { name: 'New task' });
    await newStarred.getByRole('textbox', { name: 'Title' }).fill('Buy milk');
    await newStarred.getByRole('button', { name: 'Add', exact: true }).click();
    const milk = () => (fake.tasks.get('L2') ?? []).find((task) => task.title === 'Buy milk');
    check(`${size}: Starred's "Add a starred task" adds it to the list chosen, starred`, await until(async () => Boolean(milk()) && Boolean((await state()).googleTasks?.[`${ME}\n${milk()?.id}`]?.starredAt), 10_000));
    await newStarred.getByRole('button', { name: 'Cancel' }).click();
    await starredSection.getByRole('button', { name: 'Edit Buy milk' }).click();
    const milkForm = starredSection.getByRole('group', { name: 'Edit Buy milk' });
    await milkForm.getByRole('combobox', { name: 'List' }).selectOption('L1');
    await milkForm.getByRole('button', { name: 'Done' }).click();
    check(`${size}: a starred task's list is changed from Starred, in Google`, await until(() => (fake.tasks.get('L1') ?? []).some((task) => task.title === 'Buy milk') && !(fake.tasks.get('L2') ?? []).some((task) => task.title === 'Buy milk'), 10_000));
    await shot('tc-35-starred');

    // ── On the calendar: Show completed tasks off hides a done one; Tasks unchecked hides them all (Google Calendar's own).
    await go('Calendar');
    await f.getByRole('radio', { name: 'Calendar' }).click();
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    const doneChip = f.getByRole('button', { name: /^Google task Water the plants, due/ });
    const openChip = f.getByRole('button', { name: /^Google task Send the report, due/ });
    const showAll = async () => {
      const toggle = f.getByRole('button', { name: 'Show all all-day events' });
      if (await toggle.count()) await toggle.first().click();
    };
    await until(async () => (await doneChip.count()) > 0 || (await f.getByRole('button', { name: 'Show all all-day events' }).count()) > 0, 15_000);
    await showAll();
    const viewOption = async (name) => {
      await f.getByRole('button', { name: /^View:/ }).click();
      await f.getByRole('menuitemcheckbox', { name }).click();
    };
    const doneBefore = await until(async () => (await doneChip.count()) > 0, 10_000);
    await viewOption('Show completed tasks');
    check(`${size}: the view's "Show completed tasks" off hides a completed task; open ones stay`, doneBefore && (await until(async () => (await doneChip.count()) === 0, 10_000)) && (await openChip.count()) > 0);
    await viewOption('Show completed tasks');
    await until(async () => (await doneChip.count()) > 0, 10_000);
    const rail = f.getByRole('list', { name: 'My calendars' });
    if (!(await rail.isVisible().catch(() => false))) await f.getByRole('button', { name: 'Main menu' }).click();
    await rail.locator('li', { hasText: /^Tasks$/ }).getByRole('checkbox').uncheck();
    check(`${size}: unchecking Tasks under My calendars hides every task on the calendar`, await until(async () => (await openChip.count()) === 0 && (await doneChip.count()) === 0, 10_000));
    await shot('tc-37-tasks-hidden');
    await rail.locator('li', { hasText: /^Tasks$/ }).getByRole('checkbox').check();
    check(`${size}: checking it shows them again`, await until(async () => (await openChip.count()) > 0, 15_000));

    // ── Gmail's "Add to Tasks".
    await go('Google');
    await f.getByRole('tab', { name: 'Gmail' }).click();
    const mailRow = f.getByRole('listitem', { name: 'Budget review' });
    await mailRow.waitFor({ timeout: 15_000 });
    await mailRow.getByRole('button', { name: 'Add "Budget review" to Google Tasks' }).click();
    const added = () => (fake.tasks.get('L1') ?? []).find((task) => task.title === 'Budget review');
    check(`${size}: Gmail's "Add to Tasks" makes a task in the default list, the email's link in its details`, await until(() => Boolean(added()) && /From Gmail: https:\/\/mail\.google\.com\//.test(added()?.notes ?? ''), 10_000), JSON.stringify(added()));
    await shot('tc-36-gmail-add-to-tasks');
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the inventory journey ran to its end`, false, error?.stack ?? String(error));
    await shot('tc-39-failure').catch(() => {});
  } finally {
    await h.close();
    await fake.close();
  }
};

/**
 * Round 11: printing, as Google Tasks' Print list and Google Calendar's Print.
 * - Tasks: List options → Print list, and Ctrl/⌘+P in the list. Where the host lets the frame open the print dialog
 *   (oc-forge's, with allow-modals), print() runs for the frame: beforeprint finds that list's sheet alone, and the
 *   console has no "Ignored call to 'print()'". Where it can't, Print list is disabled, with the reason, and Ctrl/⌘+P
 *   says it.
 * - In print media the frame shows that list alone and whole (longer than the window): subtasks indented, completed
 *   tasks only while Completed is open, no other list, nothing of the Planner's page; in All tasks, the list with the
 *   focus.
 * - Calendar: Settings → Print opens the "Print preview" of the range shown, with Google's options; Ctrl/⌘+P opens it
 *   too; Day, Week, Month and Schedule each print their range; the printout has its events and tasks, and is what
 *   prints while the preview is open.
 */
const printJourney = async (viewport) => {
  const size = `${viewport.width}`;
  const today = dayOf(Date.now());
  const due = (days) => `${addDays(today, days)}T00:00:00.000Z`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const world = defaultFakeWorld({ account: ME, today, zone: ZONE });
  // My Tasks: 30 tasks, each sixth with two subtasks, each fourth with details, each fifth with a date; 3 completed.
  const open = [];
  for (let n = 1; n <= 30; n++) {
    open.push({ id: `p-${n}`, title: `Print task ${String(n).padStart(2, '0')}`, notes: n % 4 === 0 ? `Details of task ${n}\nand a second line` : '', ...(n % 5 === 0 ? { due: due(n % 3) } : {}), status: 'needsAction', updated: yesterday });
    if (n % 6 === 0) open.push({ id: `p-${n}-a`, title: `Subtask ${n}a`, notes: '', status: 'needsAction', parent: `p-${n}`, updated: yesterday }, { id: `p-${n}-b`, title: `Subtask ${n}b`, notes: '', status: 'needsAction', parent: `p-${n}`, updated: yesterday });
  }
  const completed = [1, 2, 3].map((n) => ({ id: `p-done-${n}`, title: `Done task ${n}`, notes: '', status: 'completed', completed: new Date(Date.now() - n * 3600_000).toISOString(), updated: yesterday }));
  world.tasks.L1 = [...open, ...completed];
  world.tasks.L2 = [{ id: 'e-1', title: 'Errand one', notes: '', status: 'needsAction', updated: yesterday }, { id: 'e-2', title: 'Errand two', notes: '', status: 'needsAction', updated: yesterday }];
  const expected = open.map((task) => task.title);
  const fake = await startFakeGoogle(world);
  const seeded = [
    { type: 'settings.updated', patch: { timezone: ZONE } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'p-2', patch: { starred: true } },
    { type: 'gtask.kept', account: ME, listId: 'L1', taskId: 'p-5', patch: { time: 10 * 60, duration: 30, deadline: addDays(today, 7) } },
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const h = await startHarness({
    out,
    viewport,
    timezoneId: ZONE,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
  });
  const { page } = h;
  const consoleLines = [];
  const plannerErrors = [];
  page.on('console', (message) => {
    consoleLines.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  const shot = (name) => h.shot(`${name}-${size}`);
  const toast = (text) => page.locator('li[data-sonner-toast]', { hasText: text });
  const NEEDS_HOST = "Printing needs OpenChamber with oc-forge's host";
  let f;
  try {
    f = await h.openPlanner();
    const go = async (name) => {
      if (!(await h.nav(name).isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
      await h.nav(name).click();
    };
    const iframe = page.locator('.inset-0 > iframe[title="Planner"]');
    const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
    const modals = sandbox.split(/\s+/).includes('allow-modals');
    console.log(`${size}: the Planner's frame: sandbox="${sandbox}"`);
    const frame = await (await iframe.elementHandle()).contentFrame();
    // Each print() of the frame, as the browser's beforeprint finds the print sheet.
    await frame.evaluate(() => {
      window.__prints = [];
      window.__after = 0;
      addEventListener('beforeprint', () =>
        window.__prints.push({
          heading: document.querySelector('.print-root h1')?.textContent ?? '',
          titles: [...document.querySelectorAll('.print-root .print-task')].map((row) => [row.querySelector('.print-title')?.firstChild?.textContent ?? '', row.classList.contains('depth-1'), row.classList.contains('is-done')]),
          calendar: Boolean(document.querySelector('.print-root .print-calendar')),
        }),
      );
      addEventListener('afterprint', () => (window.__after += 1));
    });
    const prints = () => frame.evaluate(() => ({ prints: window.__prints ?? [], after: window.__after ?? 0 }));
    const ignored = () => consoleLines.filter((line) => line.includes("Ignored call to 'print()'"));
    /** The print sheet in print media, whole: the frame zoomed out to fit it for the picture (only for it). */
    const sheetShot = async (name) => {
      await frame.evaluate(() => {
        const sheet = document.querySelector('.print-root .print-sheet');
        const fit = sheet ? Math.min(1, innerHeight / sheet.getBoundingClientRect().height) : 1;
        document.documentElement.style.zoom = String(fit);
      });
      await iframe.screenshot({ path: join(out, `${name}-${size}.png`) }).catch(() => shot(name));
      await frame.evaluate(() => (document.documentElement.style.zoom = ''));
    };
    /** What print media shows in the frame: the print sheet, and whether the rest is hidden and nothing clipped. */
    const printMedia = () =>
      frame.evaluate(() => {
        const root = document.querySelector('.print-root');
        const sheet = root?.querySelector('.print-sheet');
        const rows = [...(root?.querySelectorAll('.print-task') ?? [])];
        const shown = (node) => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
        return {
          printMedia: matchMedia('print').matches,
          rootShown: shown(root),
          restHidden: [...document.body.children].filter((node) => node !== root).every((node) => getComputedStyle(node).display === 'none'),
          heading: root?.querySelector('h1')?.textContent ?? '',
          titles: rows.map((row) => [row.querySelector('.print-title')?.firstChild?.textContent ?? '', row.classList.contains('depth-1'), row.classList.contains('is-done')]),
          allShown: rows.every(shown),
          indented: rows.filter((row) => row.classList.contains('depth-1')).every((row) => parseFloat(getComputedStyle(row).paddingLeft) > 10),
          breaks: rows.every((row) => getComputedStyle(row).breakInside === 'avoid'),
          sheetHeight: Math.round(sheet?.getBoundingClientRect().height ?? 0),
          docHeight: document.documentElement.scrollHeight,
          viewport: innerHeight,
          overflow: [getComputedStyle(document.documentElement).overflowY, getComputedStyle(document.body).overflowY],
          text: root?.textContent ?? '',
          calendar: Boolean(root?.querySelector('.print-calendar')),
          pages: [...(root?.querySelectorAll('.print-page') ?? [])].map((node) => node.getAttribute('aria-label')),
        };
      });

    await go('Calendar');
    await f.getByRole('radio', { name: 'Tasks' }).click();
    await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'My Tasks', exact: true }).click();
    const myTasks = f.getByRole('region', { name: 'My Tasks' });
    await myTasks.getByRole('listitem', { name: 'Print task 30' }).waitFor({ timeout: 20_000 });
    const tall = await myTasks.evaluate((node) => ({ list: node.scrollHeight, window: innerHeight }));
    check(`${size}: My Tasks (40 open tasks, 10 of them subtasks) is longer than the window`, tall.list > tall.window, JSON.stringify(tall));

    // ── List options → Print list.
    await myTasks.getByRole('button', { name: 'List options for My Tasks' }).click();
    const listMenu = f.getByRole('menu', { name: 'List options for My Tasks' });
    const printItem = listMenu.getByRole('menuitem', { name: 'Print list' });
    await printItem.waitFor();
    await shot('tc-40-list-options-print');
    if (modals) {
      check(`${size}: List options has Print list, enabled (the frame may open the print dialog)`, await printItem.isEnabled());
      await printItem.click();
      const got = (await until(async () => (await prints()).prints.length === 1, 5000)) ? (await prints()).prints[0] : null;
      check(`${size}: Print list prints the frame: beforeprint finds My Tasks alone, its open tasks in order, subtasks indented, no completed one`, got && got.heading === 'My Tasks' && JSON.stringify(got.titles.map(([title]) => title)) === JSON.stringify(expected) && got.titles.filter(([, sub]) => sub).length === 10 && !got.titles.some(([, , done]) => done), JSON.stringify(got).slice(0, 500));
      check(`${size}: afterprint follows, and the console has no "Ignored call to 'print()'"`, (await until(async () => (await prints()).after >= 1, 5000)) && ignored().length === 0, ignored().join(' | '));
    } else {
      check(`${size}: where the host can't print, Print list is in List options, disabled, with the reason`, (await printItem.isDisabled()) && (await listMenu.innerText()).includes(NEEDS_HOST), await listMenu.innerText());
      await myTasks.getByRole('heading', { name: 'My Tasks' }).click();
    }

    // ── Ctrl+P in the list, Completed open: its completed tasks print too.
    await myTasks.getByRole('button', { name: /^Completed \(3\)/ }).click();
    await myTasks.getByRole('listitem', { name: 'Print task 01' }).locator('.gt-body-edit').focus();
    await page.keyboard.press('Control+p');
    if (modals) {
      const got = (await until(async () => (await prints()).prints.length === 2, 5000)) ? (await prints()).prints[1] : null;
      check(`${size}: Ctrl+P in the list prints it, with its 3 completed tasks now that Completed is open`, got && got.titles.length === 43 && got.titles.slice(40).every(([, , done]) => done) && ignored().length === 0, JSON.stringify(got?.titles?.slice(38)));
    } else {
      // The Planner's own notice (its error line), not the browser's print of OpenChamber's page.
      check(`${size}: Ctrl+P in the list says why it can't print`, await until(async () => (await f.getByText(NEEDS_HOST).count()) > 0, 5000));
      check(`${size}: and nothing calls print() where it would be ignored`, ignored().length === 0, ignored().join(' | '));
    }

    // ── Print media: My Tasks alone and whole, its completed tasks with it (Completed is open).
    await page.emulateMedia({ media: 'print' });
    const printed = await printMedia();
    check(`${size}: in print media the frame shows the print sheet alone (the Planner's page hidden)`, printed.printMedia && printed.rootShown && printed.restHidden, JSON.stringify({ ...printed, titles: printed.titles.length, text: '' }));
    check(`${size}: the sheet is My Tasks, whole: its 40 open tasks in order, subtasks indented, then its 3 completed ones; no other list`, printed.heading === 'My Tasks' && JSON.stringify(printed.titles.slice(0, 40).map(([title]) => title)) === JSON.stringify(expected) && printed.titles.slice(40).map(([title]) => title).join() === 'Done task 1,Done task 2,Done task 3' && printed.indented && !printed.text.includes('Errand'), JSON.stringify(printed.titles.map(([title]) => title)));
    check(`${size}: longer than the window, and nothing clipped: every task laid out, the page as tall as the sheet, no scrolling box`, printed.allShown && printed.sheetHeight > printed.viewport && printed.docHeight >= printed.sheetHeight && printed.overflow.every((value) => value === 'visible'), JSON.stringify({ sheet: printed.sheetHeight, doc: printed.docHeight, viewport: printed.viewport, overflow: printed.overflow }));
    check(`${size}: pages break between tasks, not inside one; the star, the time and the deadline print`, printed.breaks && printed.text.includes('★') && printed.text.includes('Deadline '), printed.text.slice(0, 300));
    await sheetShot('tc-41-print-media-list');
    await page.emulateMedia({ media: 'screen' });
    await myTasks.getByRole('button', { name: /^Completed \(3\)/ }).click();
    await page.emulateMedia({ media: 'print' });
    // The sheet follows the list once it has drawn again.
    let closed = await printMedia();
    await until(async () => (closed = await printMedia()).titles.length === 40, 5000);
    check(`${size}: with Completed closed again, it prints the 40 open tasks alone`, closed.titles.length === 40 && !closed.titles.some(([, , done]) => done), String(closed.titles.length));
    await page.emulateMedia({ media: 'screen' });

    // ── All tasks, lists side by side: the list the focus is in prints.
    await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'All tasks' }).click();
    const errands = f.getByRole('region', { name: 'Errands' });
    await errands.getByRole('listitem', { name: 'Errand one' }).locator('.gt-body-edit').focus();
    await page.emulateMedia({ media: 'print' });
    let both = await printMedia();
    await until(async () => (both = await printMedia()).heading === 'Errands', 5000);
    check(`${size}: in All tasks the list with the focus is the one that prints, alone (Errands)`, both.heading === 'Errands' && both.titles.length === 2 && !both.text.includes('Print task'), JSON.stringify({ heading: both.heading, rows: both.titles.length }));
    await page.emulateMedia({ media: 'screen' });
    if (modals) {
      // Print media hid the focused row, and Chrome let go of the focus: back on it, as one would click it.
      await errands.getByRole('listitem', { name: 'Errand one' }).locator('.gt-body-edit').focus();
      await page.keyboard.press('Control+p');
      const got = (await until(async () => (await prints()).prints.length === 3, 5000)) ? (await prints()).prints[2] : null;
      check(`${size}: and Ctrl+P there prints Errands`, got?.heading === 'Errands' && got.titles.length === 2, JSON.stringify(got));
    }

    // ── Google Calendar's Print: Settings → Print, the preview of the week shown.
    await f.getByRole('radio', { name: 'Calendar' }).click();
    await f.getByRole('button', { name: /^View:/ }).waitFor();
    await f.getByRole('button', { name: 'Settings menu' }).click();
    await f.getByRole('menu', { name: 'Settings menu' }).getByRole('menuitem', { name: 'Print' }).click();
    const preview = f.getByRole('dialog', { name: 'Print preview' });
    await preview.waitFor({ timeout: 10_000 });
    const range = async () => [await preview.getByLabel('Print range from').inputValue(), await preview.getByLabel('Print range to').inputValue()];
    const [weekFrom, weekTo] = await range();
    const span = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    check(`${size}: Settings → Print opens the Print preview of the week shown`, span(weekFrom, weekTo) === 6 && weekFrom <= today && today <= weekTo, `${weekFrom} – ${weekTo}`);
    const choices = async (label) => preview.getByRole('combobox', { name: label }).locator('option').allInnerTexts();
    const values = async () => Promise.all(['View', 'Font size', 'Orientation', 'Color & style'].map((label) => preview.getByRole('combobox', { name: label }).locator('option:checked').innerText()));
    check(`${size}: with Google's options: View, Font size, Orientation, Color & style`, JSON.stringify(await choices('View')) === JSON.stringify(['Auto', 'Day', 'Week', 'Month', 'Schedule']) && (await choices('Font size')).length === 7 && JSON.stringify(await choices('Orientation')) === JSON.stringify(['Auto', 'Portrait', 'Landscape']) && JSON.stringify(await choices('Color & style')) === JSON.stringify(['Full color', 'Outline', 'Black and white']), JSON.stringify([await choices('Font size')]));
    check(`${size}: opened as Google's: Auto, Normal, Auto, Outline; Show weekends and Show events you have declined as the calendar shows them`, JSON.stringify(await values()) === JSON.stringify(['Auto', 'Normal', 'Auto', 'Outline']) && (await preview.getByRole('checkbox', { name: 'Show weekends' }).isChecked()) && (await preview.getByRole('checkbox', { name: 'Show events you have declined' }).isChecked()), JSON.stringify(await values()));
    const paper = preview.locator('.pp-paper');
    check(`${size}: its page has the week's events and tasks (Quarter planning; Print task 15, due today)`, await until(async () => (await paper.innerText()).includes('Quarter planning') && (await paper.innerText()).includes('Print task 15'), 15_000), (await paper.innerText()).slice(0, 300));
    await shot('tc-42-calendar-print-preview');
    await page.emulateMedia({ media: 'print' });
    const calendarPrinted = await printMedia();
    check(`${size}: while the preview is open, print media shows the calendar's printout alone: one Week page`, calendarPrinted.calendar && calendarPrinted.restHidden && calendarPrinted.pages.length === 1 && calendarPrinted.text.includes('Quarter planning'), JSON.stringify(calendarPrinted.pages));
    await sheetShot('tc-43-print-media-week');
    await page.emulateMedia({ media: 'screen' });

    // The options change the printout.
    await preview.getByRole('combobox', { name: 'Orientation' }).selectOption('portrait');
    await preview.getByRole('combobox', { name: 'Color & style' }).selectOption('bw');
    await preview.getByRole('combobox', { name: 'Font size' }).selectOption('biggest');
    await preview.getByRole('checkbox', { name: 'Show weekends' }).uncheck();
    const sheetClass = () => paper.locator('.print-sheet').getAttribute('class');
    const dayHeads = () => paper.locator('.pg-day-head').count();
    check(`${size}: Portrait, Black and white, Biggest and no weekends change the page: five days, larger type`, await until(async () => /pc-bw/.test(await sheetClass()) && /is-portrait/.test(await sheetClass()) && (await dayHeads()) === 5 && (await paper.locator('.print-sheet').getAttribute('style'))?.includes('1.5'), 5000), `${await sheetClass()} ${await dayHeads()}`);
    await preview.getByRole('combobox', { name: 'View' }).selectOption('schedule');
    check(`${size}: View Schedule offers Print descriptions and Print your response`, (await preview.getByRole('checkbox', { name: 'Print descriptions' }).count()) === 1 && (await preview.getByRole('checkbox', { name: 'Print your response' }).count()) === 1);
    check(`${size}: Show weekends off leaves Saturdays and Sundays out of the Schedule too`, await until(async () => !/(Saturday|Sunday), /.test(await paper.innerText()), 5000), (await paper.innerText()).slice(0, 300));
    // The response printed is to the invitation (Vendor demo), which is tomorrow: a Saturday the weekends just left
    // out, or past the week's end, on some days. So the weekends come back and the range reaches tomorrow, and the
    // check holds whatever day it runs (on 2026-10-29 at 23:00 PDT, Friday in the zone it picked, it did not).
    await preview.getByRole('checkbox', { name: 'Show weekends' }).check();
    if ((await range())[1] < addDays(today, 1)) await preview.getByLabel('Print range to').fill(addDays(today, 1));
    await preview.getByRole('checkbox', { name: 'Print descriptions' }).check();
    await preview.getByRole('checkbox', { name: 'Print your response' }).check();
    check(`${size}: they print each event's description and my answer (Quarter planning: "Agenda…"; Your response)`, await until(async () => (await paper.innerText()).includes('Agenda') && (await paper.innerText()).includes('Your response:'), 15_000), (await paper.innerText()).slice(0, 400));
    await shot('tc-44-calendar-print-schedule');
    const printButton = preview.getByRole('button', { name: 'Print', exact: true });
    if (modals) {
      const before = (await prints()).prints.length;
      await printButton.click();
      const got = (await until(async () => (await prints()).prints.length === before + 1, 5000)) ? (await prints()).prints[before] : null;
      check(`${size}: Print prints the frame: beforeprint finds the calendar's printout; no "Ignored call to 'print()'"`, got?.calendar === true && ignored().length === 0, JSON.stringify(got));
    } else check(`${size}: where the host can't print, Print is disabled, with the reason`, (await printButton.isDisabled()) && (await preview.innerText()).includes(NEEDS_HOST));
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await preview.waitFor({ state: 'detached', timeout: 5000 });

    // ── Ctrl+P from the calendar opens the preview; Day, Month and Schedule each print their range.
    const pickView = async (name) => {
      await f.getByRole('button', { name: /^View:/ }).click();
      await f.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
    };
    const monthEnd = (key) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);
    for (const [view, from, to] of [['Day', today, today], ['Month', `${today.slice(0, 8)}01`, monthEnd(today)], ['Schedule', today, addDays(today, 29)]]) {
      await pickView(view);
      // The calendar's Today (the Planner's menu has one too).
      await f.locator('.gcal-today').click();
      await f.locator('.gcal-today').focus();
      await page.keyboard.press('Control+p');
      const opened = await preview.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      const [gotFrom, gotTo] = opened ? await range() : ['', ''];
      const pageTitles = opened ? await paper.locator('.print-page').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))) : [];
      check(`${size}: Ctrl+P in ${view} opens the preview of its range (${from} – ${to})`, opened && gotFrom === from && gotTo === to, `${gotFrom} – ${gotTo}`);
      check(`${size}: ${view} prints ${view === 'Day' ? 'that day' : view === 'Month' ? 'the month on one page' : 'one run of days'}`, pageTitles.length === 1, JSON.stringify(pageTitles));
      await shot(`tc-45-calendar-print-${view.toLowerCase()}`);
      await page.keyboard.press('Escape');
      await preview.waitFor({ state: 'detached', timeout: 5000 });
    }
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the printing journey ran to its end`, false, error?.stack ?? String(error));
    await shot('tc-49-print-failure').catch(() => {});
  } finally {
    await page.emulateMedia({ media: 'screen' }).catch(() => {});
    await h.close();
    await fake.close();
  }
};

/**
 * Review 10's declining check (P1-2): three daily Busy series at 9, 10 and 11 declining new and existing meetings make
 * 42 times in the two weeks after today; the invitations at 11 on day 1 and on day 14 are each declined once, with the
 * 11 o'clock series' message, in at most two passes, and no series turned off; a repeated pass declines nothing twice.
 * Then a calendar longer than a pass reads (pages of 2 events, 4 a pass): the passes carry on from where each stopped,
 * and the Planner says so.
 */
const declineJourney = async (viewport) => {
  const size = `${viewport.width}`;
  const today = dayOf(Date.now());
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const world = defaultFakeWorld({ account: ME, today, zone: ZONE });
  world.hostedDomain = 'example.com';
  world.granted = [...DEFAULT_SCOPES];
  const atIso = (key, minutes) => new Date(atZone(key, minutes)).toISOString();
  const invitation = (id, day, minutes) => ({ id, summary: id, created: '2026-01-05T10:00:00.000Z', start: { dateTime: atIso(addDays(today, day), minutes) }, end: { dateTime: atIso(addDays(today, day), minutes + 30) }, organizer: { email: 'lead@example.com' }, attendees: [{ email: 'lead@example.com', organizer: true, responseStatus: 'accepted' }, { email: ME, self: true, responseStatus: 'needsAction' }] });
  world.events.primary = [invitation('meeting-day-1', 1, 11 * 60), invitation('meeting-day-14', 14, 11 * 60)];
  const series = [['daily-9', 9 * 60, 'Deep work at nine'], ['daily-10', 10 * 60, 'Deep work at ten'], ['daily-11', 11 * 60, 'Deep work at eleven']];
  world.tasks.L1 = series.map(([id]) => ({ id, title: id, notes: '', due: `${today}T00:00:00.000Z`, status: 'needsAction', updated: yesterday }));
  world.tasks.L2 = [];
  const fake = await startFakeGoogle(world);
  const seeded = [
    { type: 'settings.updated', patch: { timezone: ZONE } },
    ...series.map(([id, time, message]) => ({
      type: 'gtask.kept',
      account: ME,
      listId: 'L1',
      taskId: id,
      patch: { time, busy: true, decline: { mode: 'all', message }, repeat: { rule: 'RRULE:FREQ=DAILY', seriesId: `s-${id}`, index: 1, next: null, on: today, template: { title: id, notes: '', time, duration: null, deadline: null, start: today, busy: true, decline: { mode: 'all', message, since: yesterday } } } },
    })),
  ].map((body, index) => ({ v: 1, id: `seed${index}`, at: yesterday, ...body }));
  const h = await startHarness({
    out,
    viewport,
    timezoneId: ZONE,
    serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base },
    homeFiles: { 'google-accounts.json': fake.accountsFile(), [`data/events/${yesterday.slice(0, 7)}.jsonl`]: `${seeded.map((event) => JSON.stringify(event)).join('\n')}\n` },
  });
  const { page } = h;
  const plannerErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
  const shot = (name) => h.shot(`${name}-${size}`);
  const toast = (text) => page.locator('li[data-sonner-toast]', { hasText: text });
  const self = (id) => fake.calendars.get('primary').events.get(id)?.attendees?.find((guest) => guest.self);
  /** The decline passes' reads of the account's calendar (their own fields); a pass starts with a page without a token. */
  const reads = () => fake.requests.filter((request) => request.method === 'GET' && request.path === '/calendar/v3/calendars/primary/events' && String(request.query.fields ?? '').startsWith('nextPageToken,items(id,status,summary,start,end,created,eventType'));
  const passes = () => reads().filter((request) => !request.query.pageToken).length;
  const patchesOf = (id) => fake.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith(`/events/${id}`));
  const declinedFor = async (task) => (await h.call('GET', `/google/tasks/declined?account=${encodeURIComponent(ME)}&task=${task}`)).json;
  let f;
  try {
    // The service's first pass comes soon after it starts.
    const both = await until(() => self('meeting-day-1')?.responseStatus === 'declined' && self('meeting-day-14')?.responseStatus === 'declined', 30_000);
    const passesThen = passes();
    check(`${size}: with three daily Busy series (9, 10, 11), the meetings at 11 on day 1 and on day 14 are both declined`, both, JSON.stringify([self('meeting-day-1'), self('meeting-day-14')]));
    check(`${size}: in at most two passes, each reading the calendar once over all the times`, passesThen >= 1 && passesThen <= 2 && reads().length === passesThen, `${passesThen} passes, ${reads().length} reads: ${JSON.stringify(reads().map((request) => [request.query.timeMin, request.query.timeMax]))}`);
    check(`${size}: each with the 11 o'clock series' message, once, the organizer told`, self('meeting-day-1')?.comment === 'Deep work at eleven' && self('meeting-day-14')?.comment === 'Deep work at eleven' && patchesOf('meeting-day-1').length === 1 && patchesOf('meeting-day-14').length === 1 && [...patchesOf('meeting-day-1'), ...patchesOf('meeting-day-14')].every((request) => request.query.sendUpdates === 'all'));
    const again = await h.call('POST', '/google/tasks/decline');
    check(`${size}: a repeated pass declines nothing twice, and has nothing left`, again.status === 200 && again.json.declined.length === 0 && again.json.errors.length === 0 && again.json.more.length === 0 && patchesOf('meeting-day-1').length === 1 && patchesOf('meeting-day-14').length === 1, JSON.stringify(again.json));
    const kept = (await h.call('GET', '/state')).json.state.googleTasks;
    check(`${size}: no series was turned off for it: all three still decline`, series.every(([id]) => kept[`${ME}\n${id}`]?.decline?.mode === 'all' && kept[`${ME}\n${id}`]?.repeat?.rule === 'RRULE:FREQ=DAILY'), JSON.stringify(series.map(([id]) => kept[`${ME}\n${id}`]?.decline)));
    const eleven = await declinedFor('daily-11');
    check(`${size}: the 11 o'clock task's details list both; nothing is still being gone through`, eleven.declined.map((meeting) => meeting.eventId).sort().join() === 'meeting-day-1,meeting-day-14' && eleven.more === null, JSON.stringify(eleven));

    // ── Longer than a pass reads: pages of 2 events, 4 a pass; 24 events of my own and two more invitations.
    fake.world.pageSize.events = 2;
    const events = fake.calendars.get('primary').events;
    for (let day = 1; day <= 12; day++) {
      for (const minutes of [13 * 60, 15 * 60]) events.set(`mine-${day}-${minutes}`, { id: `mine-${day}-${minutes}`, summary: 'My own block', created: '2026-01-05T10:00:00.000Z', start: { dateTime: atIso(addDays(today, day), minutes) }, end: { dateTime: atIso(addDays(today, day), minutes + 60) }, organizer: { email: ME, self: true }, attendees: [{ email: ME, self: true, organizer: true, responseStatus: 'accepted' }] });
    }
    events.set('meeting-late-a', invitation('meeting-late-a', 2, 10 * 60));
    events.set('meeting-late-b', invitation('meeting-late-b', 13, 9 * 60));
    // A change from the Tasks view (the ten o'clock series' message, All tasks) declines at once, and says so.
    f = await h.openPlanner();
    if (!(await h.nav('Calendar').isVisible().catch(() => false))) await f.getByRole('button', { name: 'Planner menu' }).click();
    await h.nav('Calendar').click();
    await f.getByRole('radio', { name: 'Tasks' }).click();
    const myTasks = f.getByRole('region', { name: 'My Tasks' });
    await myTasks.getByRole('button', { name: 'Edit daily-10' }).click({ timeout: 20_000 });
    const form = myTasks.getByRole('group', { name: 'Edit daily-10' });
    if (!(await form.getByRole('textbox', { name: 'Message' }).isVisible().catch(() => false))) await form.getByRole('button', { name: 'Advanced settings' }).click();
    await form.getByRole('textbox', { name: 'Message' }).fill('Deep work at ten, still');
    await form.getByRole('button', { name: 'Done' }).click();
    const question = f.getByRole('alertdialog', { name: 'Edit repeating task' });
    await question.waitFor({ timeout: 10_000 });
    await question.getByRole('radio', { name: 'All tasks' }).check();
    await question.getByRole('button', { name: 'OK' }).click();
    const sawMore = await until(async () => (await declinedFor('daily-10')).more !== null, 20_000);
    check(`${size}: while the passes carry on, the task's details say from where (the service's \`more\`)`, sawMore);
    // The Planner's own notice after the change: what it declined, and that it carries on.
    const carryOn = f.getByText(/still going through your meetings from .* on: it declines the rest in a moment/);
    check(`${size}: the Planner says it is still going through the meetings and declines the rest in a moment`, await until(async () => (await carryOn.count()) > 0, 20_000));
    await shot('tc-46-decline-carries-on');
    const late = await until(() => self('meeting-late-a')?.responseStatus === 'declined' && self('meeting-late-b')?.responseStatus === 'declined', 90_000);
    check(`${size}: the passes carry on from where each stopped until the last meeting is declined: day 2 with ten's new message, day 13 with nine's`, late && self('meeting-late-a')?.comment === 'Deep work at ten, still' && self('meeting-late-b')?.comment === 'Deep work at nine', JSON.stringify([self('meeting-late-a'), self('meeting-late-b')]));
    check(`${size}: read on with Google's page tokens, a pass at a time`, reads().some((request) => request.query.pageToken), String(reads().length));
    check(`${size}: each declined once; my own blocks left alone`, ['meeting-day-1', 'meeting-day-14', 'meeting-late-a', 'meeting-late-b'].every((id) => patchesOf(id).length === 1) && !fake.requests.some((request) => request.method === 'PATCH' && /\/events\/mine-/.test(request.path)));
    check(`${size}: once through, nothing is said to be left`, await until(async () => (await declinedFor('daily-10')).more === null && (await declinedFor('daily-9')).more === null, 20_000));
    check(`${size}: no error from the Planner's page`, plannerErrors.length === 0, plannerErrors.join(' | '));
  } catch (error) {
    check(`${size}: the declining journey ran to its end`, false, error?.stack ?? String(error));
    await shot('tc-47-decline-failure').catch(() => {});
  } finally {
    await h.close();
    await fake.close();
  }
};

/** The instant of a wall-clock time in ZONE (minutes may run past midnight). */
const atZone = (key, minutes) => at(key, minutes);

mkdirSync(out, { recursive: true });
console.log(`zone ${ZONE}, local ${clock(Math.floor(minutesIn(ZONE)))}`);
// TC_PARTS=tasks, advanced, inventory, print or decline runs one journey alone (while it is written); the full run has all five.
const parts = process.env.TC_PARTS ?? 'all';
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  if (parts === 'all' || parts === 'tasks') await journey(viewport);
  if (parts === 'all' || parts === 'advanced') await advancedJourney(viewport);
  if (parts === 'all' || parts === 'inventory') await inventoryJourney(viewport);
  if (parts === 'all' || parts === 'print') await printJourney(viewport);
  if (parts === 'all' || parts === 'decline') await declineJourney(viewport);
}
const failed = results.filter((result) => !result.ok);
writeFileSync(join(out, 'results.json'), JSON.stringify({ zone: ZONE, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
