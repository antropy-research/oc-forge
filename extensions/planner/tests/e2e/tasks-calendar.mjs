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
// The zone is one where it is between 10 AM and 10 PM now, so 9 AM has passed and today lasts the journey.
// Run on the host after `bun run build`, in the netns: node extensions/planner/tests/e2e/tasks-calendar.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness } from './harness.mjs';
import { defaultFakeWorld, startFakeGoogle } from './fakeGoogle.mjs';

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

mkdirSync(out, { recursive: true });
console.log(`zone ${ZONE}, local ${clock(Math.floor(minutesIn(ZONE)))}`);
await journey({ width: 1440, height: 900 });
await journey({ width: 1024, height: 768 });
const failed = results.filter((result) => !result.ok);
writeFileSync(join(out, 'results.json'), JSON.stringify({ zone: ZONE, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
