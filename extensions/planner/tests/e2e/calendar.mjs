// Google Calendar and Google Tasks in the Planner, end to end: the dev
// container's OpenChamber UI with this checkout's panel and service, and the
// service signed in to a fake Google (tests/e2e/fakeGoogle.mjs), so each
// change is checked where Google gets it. Day, Week, Month and Schedule; the
// mini month; drag to create; details; RSVP; move and resize; recurring events
// (This event, This and following, All events); a custom repeat rule; Google
// Tasks lists and tasks (create, rename, delete, subtasks, reorder, complete);
// a Google task planned stays on its due day; a planned task moved to another
// list keeps its link (completion writes there), changes in Google reach the
// Planner and a title changed on both sides takes the newer change; a time, a
// deadline, a weekly repeat and a star kept in the Planner for Google tasks; a
// repeating task's series (This task changes one occurrence, All tasks the
// series, the next one made from it) and its upcoming occurrences on the grid;
// a deadline-only task on its deadline's day; Edit from a task's details over
// the calendar; a repeating task takes no subtasks by any path; an edit Google
// refuses changes nothing and its editor stays open to save again (applied
// once); completing a task on the calendar of a freshly opened Planner
// completes its subtasks, and reopening one reopens it; a timed task's
// deadline on its own day in the all-day section; deleting "This task" while
// Google refuses its next one deletes nothing, and deleting again makes one;
// one upcoming task deleted or edited on its own (This task), the series
// passing over or taking it when it gets there; "This and following tasks"
// from an upcoming one, the earlier ones staying, and "All tasks", the
// completed ones going too; two windows completing one occurrence at once
// make one next task between them; tomorrow's task edited in one window (This
// task or All tasks) while another completes today's and Google is slow to
// make tomorrow's, the one next task carrying the edit; one moved alone onto
// another occurrence's day shown beside it, and completing either leaving the
// other; titles that read in full; the layout at 1440 and 1024 px.
// Run on the host after `bun run build`: node extensions/planner/tests/e2e/calendar.mjs [outDir]
import { startHarness } from './harness.mjs';
import { defaultFakeWorld, startFakeGoogle } from './fakeGoogle.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-calendar';
const ZONE = 'America/Los_Angeles';
const ME = 'harness@example.com';
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const today = dayOf(Date.now());
const addDays = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDay = (key) => `${WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]}, ${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8))}`;
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
    await sleep(150);
  }
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
};

const fake = await startFakeGoogle(defaultFakeWorld({ account: ME, today, zone: ZONE }));
const h = await startHarness({ out, viewport: { width: 1440, height: 900 }, timezoneId: ZONE, serviceEnv: { PLANNER_GOOGLE_API_BASE: fake.base }, homeFiles: { 'google-accounts.json': fake.accountsFile() } });
const { page } = h;
// The host's own requests fail now and then (its source-control binding); only the Planner's errors count here.
const plannerErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(message.text().slice(0, 300));
});
page.on('pageerror', (error) => plannerErrors.push(`pageerror: ${error.message}`));
const requests = (method, path) => fake.requests.filter((request) => request.method === method && (typeof path === 'string' ? request.path === path : path.test(request.path)));
const EVENTS = '/calendar/v3/calendars/primary/events';
const primary = () => fake.calendars.get('primary').events;
const state = async () => (await h.call('GET', '/state')).json.state;

let f;
try {
  f = await h.openPlanner();
  await h.nav('Calendar').click();
  await f.getByRole('heading', { name: 'Calendar', exact: true }).waitFor();
  const shot = (name) => h.shot(name);
  const lane = (date) => f.locator(`.day-lane[data-date="${date}"]`);
  const rail = f.getByRole('complementary', { name: 'Calendars' });
  const todayButton = f.getByRole('main').getByRole('button', { name: 'Today', exact: true });
  const pickView = async (name) => {
    await f.getByRole('button', { name: /^View:/ }).click();
    await f.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
  };
  /** Bring a day into the week shown, through the mini month as a person would. */
  const goTo = async (date) => {
    if (await lane(date).count()) return;
    const title = async () => (await rail.locator('.mini-title').innerText()).trim();
    for (let step = 0; step < 3 && !(await title()).startsWith(MONTHS[Number(date.slice(5, 7)) - 1]); step++) await rail.getByRole('button', { name: date > today ? 'Next month' : 'Previous month' }).click();
    await rail.getByRole('gridcell', { name: new RegExp(`^${longDay(date)}`) }).first().click();
    await lane(date).waitFor();
  };

  // As in Google Calendar, the account's own calendar shows from the start, with the tasks due.
  const reportChip = f.getByRole('button', { name: /^Google task Send the report, due/ });
  check('a Google task due today shows in the all-day row', await reportChip.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  const planning = f.locator('.grid-item.is-event', { hasText: 'Quarter planning' });
  const ownShown = await planning.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const ownChecked = await rail.getByRole('checkbox', { name: ME }).isChecked({ timeout: 15_000 }).catch(() => false);
  const teamChecked = await rail.getByRole('checkbox', { name: 'Team' }).isChecked().catch(() => true);
  check("the account's own calendar shows from the start, without ticking it; shared ones wait to be ticked", ownShown && ownChecked && !teamChecked, `own event ${ownShown}, own ticked ${ownChecked}, Team ticked ${teamChecked}`);

  // The rail: Create, the mini month, My calendars and Other calendars.
  await rail.getByRole('checkbox', { name: 'Team' }).check();
  const teamRead = await until(() => requests('GET', /^\/calendar\/v3\/calendars\/team@group\.calendar\.google\.com\/events$/).length > 0, 15_000);
  check('ticking a calendar in the rail reads its events from Google', Boolean(teamRead));
  const mine = await f.getByRole('list', { name: 'My calendars' }).innerText();
  const others = await f.getByRole('list', { name: 'Other calendars' }).innerText();
  check('"My calendars" lists the account and Tasks, "Other calendars" the shared ones', mine.includes(ME) && mine.includes('Tasks') && others.includes('Team') && others.includes('Holidays'), `${mine} | ${others}`);
  check('the week is read from Google page by page', requests('GET', EVENTS).some((request) => request.query.pageToken));
  // Google Calendar's red current-time line is drawn over events but never in their way: one it crosses is pressed,
  // dragged or opened as anywhere else (a press on it started a new event instead, so a drag there moved nothing).
  check("the current-time line never takes a press from an item it crosses",
    await f.locator('.now-line').first().evaluate((line) => getComputedStyle(line).pointerEvents === 'none' && getComputedStyle(line, '::before').pointerEvents === 'none').catch(() => false));
  await shot('cal-01-week');

  // Day, Week, Month and Schedule, as Google Calendar switches them.
  await pickView('Day');
  check('Day shows one day', (await f.locator('.day-lane').count()) === 1 && (await f.locator('.gcal-title').innerText()).includes(String(Number(today.slice(8)))));
  await shot('cal-02-day');
  await pickView('Month');
  await f.locator('.month-view').waitFor();
  check('Month shows whole weeks, with all-day bars and timed events', (await f.locator('.month-cell').count()) >= 28 && (await f.locator('.month-chip', { hasText: 'Quarter planning' }).count()) === 1);
  await shot('cal-03-month');
  await pickView('Schedule');
  await f.locator('.schedule-view').waitFor();
  check('Schedule lists the days that have something on them', (await f.locator('.schedule-day').count()) > 3 && (await f.locator('.schedule-item', { hasText: 'Quarter planning' }).count()) === 1);
  await shot('cal-04-schedule');
  await page.keyboard.press('w');
  check('Google Calendar\'s keys switch views (W: week)', (await f.locator('.day-lane').count()) === 7);

  // Search, as in Google Calendar: / opens the search box, Enter lists what matches across the calendars shown.
  await page.keyboard.press('/');
  const searchBox = f.getByRole('searchbox', { name: 'Search events' });
  await searchBox.waitFor({ timeout: 5000 });
  await searchBox.fill('planning');
  await page.keyboard.press('Enter');
  const results = f.getByRole('region', { name: 'Search results for planning' });
  const hit = results.getByRole('button', { name: /^Quarter planning, / });
  const found = await hit.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const askedGoogle = requests('GET', EVENTS).some((request) => request.query.q === 'planning');
  const strays = await results.getByRole('button', { name: /^Standup, / }).count();
  check('/ opens search; Enter lists the matching events, as Google finds them (q), and nothing else', found && askedGoogle && strays === 0, `found ${found}, asked Google ${askedGoogle}, other events ${strays}`);
  await shot('cal-04b-search');
  await hit.click();
  const fromSearch = await f.getByRole('dialog', { name: 'Event: Quarter planning' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  await page.keyboard.press('Escape');
  await f.getByRole('button', { name: 'Back to the calendar' }).click();
  const backToGrid = await f.locator('.day-lane').first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  check('a result opens its details; Back returns to the calendar', fromSearch && backToGrid);

  // Year, as Google Calendar's: Y shows twelve small months; a date opens that day.
  await page.keyboard.press('y');
  const yearView = f.locator('.year-view');
  const months = await yearView.waitFor({ timeout: 5000 }).then(() => yearView.locator('.year-month').count()).catch(() => 0);
  const yearTitle = (await f.locator('.gcal-title').innerText()).trim();
  await shot('cal-04c-year');
  await yearView.getByRole('gridcell', { name: /, today$/ }).click();
  const dayOpened = await until(async () => (await f.locator('.day-lane').count()) === 1 && (await lane(today).count()) === 1, 5000);
  check('Y shows the year as twelve months; a date opens that day', months === 12 && yearTitle === today.slice(0, 4) && Boolean(dayOpened), `${months} months, title ${yearTitle}, day opened ${Boolean(dayOpened)}`);
  await page.keyboard.press('w');
  await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });

  // The mini month moves the calendar; Today comes back.
  const later = `${addDays(`${today.slice(0, 8)}01`, 40).slice(0, 8)}15`;
  await goTo(later);
  check('picking a day in the mini month shows its week', (await lane(later).count()) === 1);
  await todayButton.click();
  check('Today comes back to this week', (await lane(today).count()) === 1);

  // Drag on the grid to make an event; Save sends it to Google Calendar.
  const dayBox = await lane(today).boundingBox();
  const yAt = (box, minutes) => box.y + (minutes * 48) / 60;
  await page.mouse.move(dayBox.x + dayBox.width / 2, yAt(dayBox, 600) + 3);
  await page.mouse.down();
  await page.mouse.move(dayBox.x + dayBox.width / 2, yAt(dayBox, 658), { steps: 8 });
  await page.mouse.up();
  const quick = f.getByRole('dialog', { name: 'New event' });
  await quick.waitFor();
  check('dragging on the grid opens quick create with the time drawn (10–11am)', (await quick.getByRole('combobox', { name: 'Start time' }).inputValue()) === '600' && (await quick.getByRole('combobox', { name: 'End time' }).inputValue()) === '660');
  await shot('cal-05-quick-create');
  await quick.getByRole('textbox', { name: 'Title' }).fill('Harness 1:1');
  await quick.getByRole('button', { name: 'Save' }).click();
  const insert = await until(() => requests('POST', EVENTS).find((request) => request.body?.summary === 'Harness 1:1'));
  check('Save inserts the event in Google Calendar with those times', insert && Date.parse(insert.body.start.dateTime) === at(today, 600) && Date.parse(insert.body.end.dateTime) === at(today, 660) && insert.body.start.timeZone === ZONE, JSON.stringify(insert?.body));
  const created = f.locator('.grid-item.is-event', { hasText: 'Harness 1:1' });
  await created.waitFor();
  const createdId = [...primary().values()].find((event) => event.summary === 'Harness 1:1')?.id;

  // Details, as Google Calendar's popover.
  await created.click();
  const details = f.getByRole('dialog', { name: 'Event: Harness 1:1' });
  check('clicking an event opens its details, with Edit and Delete', await details.waitFor().then(() => true).catch(() => false) && (await details.innerText()).includes('10 – 11am') && (await details.getByRole('button', { name: 'Edit event' }).count()) === 1);
  await details.getByRole('button', { name: 'Close' }).click();
  await planning.click();
  const planningDetails = f.getByRole('dialog', { name: 'Event: Quarter planning' });
  await planningDetails.getByText('3 guests').waitFor();
  const planningText = await planningDetails.innerText();
  check('details show the call, the place, guests and their answers, the description and notifications', ['Join with Google Meet', 'Room 4', 'Ann Lee', '2 yes, 1 awaiting', 'Agenda', 'Goals', '10 minutes before'].every((part) => planningText.includes(part)), planningText);
  await shot('cal-06-details');
  await planningDetails.getByRole('button', { name: 'Close' }).click();

  // RSVP to an invitation.
  await goTo(addDays(today, 1));
  const vendor = f.locator('.grid-item.is-event', { hasText: 'Vendor demo' });
  await vendor.click();
  const invite = f.getByRole('dialog', { name: 'Event: Vendor demo' });
  await invite.getByRole('group', { name: 'Going?' }).getByRole('button', { name: 'Yes' }).click();
  const answered = await until(() => primary().get('invite').attendees.find((guest) => guest.self)?.responseStatus === 'accepted');
  check('answering Yes writes my answer to Google, and the organizer hears it', answered && requests('PATCH', `${EVENTS}/invite`).at(-1)?.query.sendUpdates === 'all');
  await shot('cal-07-rsvp');
  await invite.getByRole('button', { name: 'Close' }).click();
  await todayButton.click();

  // Move and resize, written to Google as patches.
  await created.waitFor();
  let box = await created.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 48, { steps: 8 });
  await page.mouse.up();
  const moved = await until(() => requests('PATCH', `${EVENTS}/${createdId}`).find((request) => Date.parse(request.body?.start?.dateTime) === at(today, 660)));
  check('dragging the event moves it in Google Calendar (11am–12pm)', moved && Date.parse(moved.body.end.dateTime) === at(today, 720), JSON.stringify(moved?.body));
  await until(async () => (await created.innerText()).includes('11am'));
  box = await created.locator('.resize-handle').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
  const resized = await until(() => requests('PATCH', `${EVENTS}/${createdId}`).find((request) => Date.parse(request.body?.end?.dateTime) === at(today, 750)));
  check('dragging its bottom edge resizes it in Google Calendar (to 12:30pm)', resized && Date.parse(resized.body.start.dateTime) === at(today, 660), JSON.stringify(requests('PATCH', `${EVENTS}/${createdId}`).map((request) => request.body)));
  const snack = f.locator('.gcal-snack');
  check('the change says "Event saved", with Undo, as Google Calendar does', (await snack.innerText().catch(() => '')).includes('Event saved') && (await snack.getByRole('button', { name: 'Undo' }).count()) === 1);
  await shot('cal-08-moved');
  // Undo puts it back as it was before the resize.
  await snack.getByRole('button', { name: 'Undo' }).click();
  const undone = await until(() => {
    const patches = requests('PATCH', `${EVENTS}/${createdId}`);
    return patches.slice(patches.indexOf(resized) + 1).find((request) => Date.parse(request.body?.end?.dateTime) === at(today, 720));
  });
  check('Undo puts it back in Google Calendar (11am–12pm)', undone && Date.parse(undone.body.start.dateTime) === at(today, 660) && (await until(async () => (await created.innerText()).includes('12pm'))), JSON.stringify(undone?.body));

  // In Month, an event dragged to another day keeps its clock time.
  await pickView('Month');
  const tomorrowCell = f.locator(`.month-cell[data-date="${addDays(today, 1)}"]`);
  if (await tomorrowCell.count()) {
    await f.locator('.month-chip', { hasText: 'Harness 1:1' }).dragTo(tomorrowCell, { targetPosition: { x: 6, y: 6 } });
    const nextDay = await until(() => requests('PATCH', `${EVENTS}/${createdId}`).find((request) => Date.parse(request.body?.start?.dateTime) === at(addDays(today, 1), 660)));
    check('in Month, dragging an event to another day moves it in Google at the same time', nextDay && Date.parse(nextDay.body.end.dateTime) === at(addDays(today, 1), 720), JSON.stringify(requests('PATCH', `${EVENTS}/${createdId}`).at(-1)?.body));
    await shot('cal-08b-month-moved');
    // And back, for the rest of the journey.
    await until(async () => (await f.locator(`.month-cell[data-date="${addDays(today, 1)}"]`).count()) === 1);
    await page.waitForTimeout(600);
    await f.locator('.month-chip', { hasText: 'Harness 1:1' }).dragTo(f.locator(`.month-cell[data-date="${today}"]`), { targetPosition: { x: 6, y: 6 } });
    await until(() => requests('PATCH', `${EVENTS}/${createdId}`).find((request) => request !== nextDay && Date.parse(request.body?.start?.dateTime) === at(today, 660)));
  } else check('in Month, dragging an event to another day moves it in Google at the same time', true, 'skipped: tomorrow is in the next month');
  await pickView('Week');
  await created.waitFor();

  // A recurring event: This event, All events, This and following.
  const otherDay = (await f.locator('.day-lane').evaluateAll((lanes, day) => lanes.map((element) => element.getAttribute('data-date')).filter((date) => date !== day), today))[0];
  const standupOn = (date) => lane(date).locator('.grid-item.is-event', { hasText: /standup/i });
  box = await standupOn(otherDay).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 4 + 24, { steps: 6 });
  await page.mouse.up();
  const scope = f.getByRole('alertdialog', { name: 'Edit recurring event' });
  await scope.waitFor();
  check('moving a recurring event asks This event, This and following events, All events', (await scope.getByRole('radio').count()) === 3);
  await shot('cal-09-recurring-question');
  await scope.getByRole('radio', { name: 'This event' }).check();
  await scope.getByRole('button', { name: 'OK' }).click();
  const one = await until(() => requests('PATCH', /\/events\/standup_\d{8}T\d{6}Z$/).at(-1));
  check('This event changes that occurrence alone', one && Date.parse(one.body.start.dateTime) === at(otherDay, 9 * 60 + 30), JSON.stringify(one));

  await standupOn(today).click();
  const standupDetails = f.getByRole('dialog', { name: /^Event: Standup/ });
  await standupDetails.getByText('Daily').waitFor();
  check('details say how the series repeats', (await standupDetails.innerText()).includes('Daily'));
  await standupDetails.getByRole('button', { name: 'Edit event' }).click();
  let editor = f.getByRole('dialog', { name: 'Edit event' });
  await editor.getByRole('textbox', { name: 'Title' }).fill('Daily standup');
  await editor.getByRole('button', { name: 'Save' }).click();
  await scope.getByRole('radio', { name: 'All events' }).check();
  await scope.getByRole('button', { name: 'OK' }).click();
  const all = await until(() => requests('PATCH', `${EVENTS}/standup`).find((request) => request.body?.summary === 'Daily standup'));
  check('All events renames the whole series in Google', all && primary().get('standup').summary === 'Daily standup');
  await until(async () => (await f.locator('.grid-item.is-event', { hasText: 'Daily standup' }).count()) > 1);

  await standupOn(today).click();
  await f.getByRole('dialog', { name: /^Event: Daily standup/ }).getByRole('button', { name: 'Edit event' }).click();
  editor = f.getByRole('dialog', { name: 'Edit event' });
  const weekly = `Weekly on ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}`;
  await editor.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: weekly });
  await editor.getByRole('button', { name: 'Save' }).click();
  await scope.waitFor();
  const offered = await scope.getByRole('radio').allInnerTexts().catch(() => []);
  const labels = await scope.locator('label').allInnerTexts();
  check('a new repeat rule is offered for this and following events or all, not this one alone', labels.length === 2 && !labels.some((label) => label.trim() === 'This event'), JSON.stringify({ offered, labels }));
  await scope.getByRole('radio', { name: 'This and following events' }).check();
  await scope.getByRole('button', { name: 'OK' }).click();
  const split = await until(() => requests('POST', EVENTS).find((request) => request.body?.recurrence?.[0]?.startsWith('RRULE:FREQ=WEEKLY')));
  const truncated = await until(() => /UNTIL=\d{8}T\d{6}Z/.test(primary().get('standup').recurrence[0]));
  check('This and following ends the series before today and starts a weekly one from today', split && truncated && split.body.summary === 'Daily standup', JSON.stringify({ split: split?.body?.recurrence, old: primary().get('standup').recurrence }));
  await shot('cal-10-series-split');

  // A custom repeat rule from quick create's More options.
  await page.mouse.move(dayBox.x + dayBox.width / 2, yAt(dayBox, 16 * 60) + 3);
  await page.mouse.down();
  await page.mouse.up();
  await quick.waitFor();
  await quick.getByRole('textbox', { name: 'Title' }).fill('Harness review');
  await quick.getByRole('button', { name: 'More options' }).click();
  editor = f.getByRole('dialog', { name: 'New event' });
  await editor.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Custom…' });
  const custom = editor.getByRole('group', { name: 'Custom recurrence' });
  await custom.getByRole('spinbutton', { name: 'Repeat every' }).fill('2');
  await custom.getByRole('button', { name: 'Repeat on Wednesday' }).click();
  await custom.getByRole('radio', { name: 'After' }).check();
  await custom.getByRole('spinbutton', { name: 'Ends after occurrences' }).fill('5');
  await shot('cal-11-custom-repeat');
  await custom.getByRole('button', { name: 'Done' }).click();
  await editor.getByRole('textbox', { name: 'Location' }).fill('Room 2');
  await editor.getByRole('checkbox', { name: 'Add Google Meet video conferencing' }).check();
  await editor.getByRole('button', { name: 'Save' }).click();
  const review = await until(() => requests('POST', EVENTS).find((request) => request.body?.summary === 'Harness review'));
  const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${today}T00:00:00Z`).getUTCDay()];
  const expectedDays = [...new Set([weekday, 'WE'])].sort((a, b) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(a) - ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(b)).join(',');
  check('a custom rule, a place and a Meet call go to Google as Google Calendar writes them', review && review.body.recurrence?.[0] === `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${expectedDays};COUNT=5` && review.body.location === 'Room 2' && review.query.conferenceDataVersion === '1', JSON.stringify(review?.body));

  // Delete a recurring event: Google Calendar asks which events.
  const reviewId = [...primary().values()].find((event) => event.summary === 'Harness review')?.id;
  const reviewToday = lane(today).locator('.grid-item.is-event', { hasText: 'Harness review' });
  await reviewToday.waitFor();
  await reviewToday.click();
  await f.getByRole('dialog', { name: 'Event: Harness review' }).getByRole('button', { name: 'Delete event' }).click();
  const deleteScope = f.getByRole('alertdialog', { name: 'Delete recurring event' });
  await deleteScope.getByRole('radio', { name: 'All events' }).check();
  await deleteScope.getByRole('button', { name: 'OK' }).click();
  check('deleting a recurring event asks which ones, and All events deletes the series in Google', await until(() => requests('DELETE', `${EVENTS}/${reviewId}`).length === 1 && !primary().has(reviewId)) && (await until(async () => (await reviewToday.count()) === 0)));

  // Duplicate, from the details' Options: the editor opens with a copy to save as a new event.
  await planning.click();
  const original = f.getByRole('dialog', { name: 'Event: Quarter planning' });
  await original.getByText('3 guests').waitFor();
  await original.getByRole('button', { name: 'Options' }).click();
  await shot('cal-11a-event-options');
  await original.getByRole('menuitem', { name: 'Duplicate' }).click();
  const copyEditor = f.getByRole('dialog', { name: 'New event' });
  const copyTitle = copyEditor.getByRole('textbox', { name: 'Title' });
  await until(async () => (await copyTitle.inputValue()) === 'Quarter planning');
  await copyTitle.fill('Quarter planning copy');
  await shot('cal-11b-duplicate');
  await copyEditor.getByRole('button', { name: 'Save' }).click();
  await f.getByRole('alertdialog', { name: /^Send invitation emails/ }).getByRole('button', { name: "Don't send" }).click();
  const copied = await until(() => requests('POST', EVENTS).find((request) => request.body?.summary === 'Quarter planning copy'));
  check(
    'Duplicate saves a new event with the same time, place, guests, description and notifications, and a new Meet call',
    copied && Date.parse(copied.body.start.dateTime) === at(today, 14 * 60) && Date.parse(copied.body.end.dateTime) === at(today, 15 * 60) && copied.body.location === 'Room 4' && copied.body.attendees?.map((guest) => guest.email).join() === 'ann@example.com,bo@example.com' && copied.body.description?.includes('Goals') && copied.body.reminders?.overrides?.[0]?.minutes === 10 && copied.query.sendUpdates === 'none' && copied.query.conferenceDataVersion === '1',
    JSON.stringify({ body: copied?.body, query: copied?.query }),
  );
  // Delete it; "Event deleted · Undo" brings it back, as in Google Calendar. Then away again, for the rest of the journey.
  // Google's copy, not the one shown while saving, can be deleted.
  const copyChip = f.locator('.grid-item.is-event.is-movable', { hasText: 'Quarter planning copy' });
  const deleteCopy = async () => {
    await copyChip.waitFor({ timeout: 15_000 });
    await copyChip.click();
    await f.getByRole('dialog', { name: 'Event: Quarter planning copy' }).getByRole('button', { name: 'Delete event' }).click();
    await f.getByRole('alertdialog', { name: /^Send cancellation emails/ }).getByRole('button', { name: "Don't send" }).click();
    return until(async () => (await f.locator('.grid-item.is-event', { hasText: 'Quarter planning copy' }).count()) === 0);
  };
  await deleteCopy();
  const copies = () => requests('POST', EVENTS).filter((request) => request.body?.summary === 'Quarter planning copy');
  await f.locator('.gcal-snack', { hasText: 'Event deleted' }).getByRole('button', { name: 'Undo' }).click();
  const back = await until(async () => (await copyChip.count()) === 1, 15_000);
  check(
    '"Event deleted · Undo" puts the event back in Google, its guests told as they were of the deletion (not)',
    Boolean(back) && copies().length === 2 && copies()[1].query.sendUpdates === 'none' && copies()[1].body.attendees?.length === 2 && copies()[1].body.location === 'Room 4',
    JSON.stringify(copies().map((request) => ({ query: request.query, attendees: request.body?.attendees?.length }))),
  );
  await shot('cal-11c-undo-delete');
  await deleteCopy();

  // An all-day event dragged to another day keeps its length.
  const offsiteStart = addDays(today, 2);
  if ((await lane(offsiteStart).count()) && (await lane(addDays(offsiteStart, 2)).count())) {
    const offsite = f.locator('.all-day-bar', { hasText: 'Team offsite' });
    await offsite.dragTo(f.locator(`.all-day-cell[data-date="${addDays(offsiteStart, 1)}"]`));
    const shifted = await until(() => requests('PATCH', `${EVENTS}/offsite`).at(-1));
    check('dragging an all-day event to another day moves it there in Google, the same length', shifted?.body?.start?.date === addDays(offsiteStart, 1) && shifted?.body?.end?.date === addDays(offsiteStart, 3), JSON.stringify(shifted?.body));
  } else check('dragging an all-day event to another day moves it there in Google, the same length', true, 'skipped: the offsite crosses into another week');

  // A Google task planned from the calendar stays on its due day.
  await reportChip.click();
  const taskPopover = f.getByRole('dialog', { name: 'Google task: Send the report' });
  check('a Google task opens its details: its day, its star, and planning it', (await taskPopover.innerText()).includes(longDay(today)) && (await taskPopover.getByRole('button', { name: 'Star Send the report' }).count()) === 1);
  await taskPopover.getByRole('button', { name: /^Plan on today/ }).click();
  const plannedState = await until(async () => Object.values((await state()).tasks).find((task) => task.source?.id === 't-report' && task.placement.kind === 'day' && task.placement.date === today));
  const stillThere = await until(async () => (await f.getByRole('button', { name: /^Google task Send the report, due .*planned in the Planner/ }).count()) === 1);
  check('a Google task planned from the calendar stays on its due day, shown as planned', plannedState && stillThere);
  await shot('cal-12-planned-task');

  // Tasks, as the Google Tasks app.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  const myTasks = f.getByRole('region', { name: 'My Tasks' });
  await myTasks.getByText('Plan the trip').waitFor();
  check('Tasks shows each list, subtasks under their task, and completed tasks folded away', (await myTasks.locator('li.gt-row.depth-1', { hasText: 'Book the hotel' }).count()) === 1 && (await myTasks.getByRole('button', { name: 'Completed (1)' }).count()) === 1);
  check('Starred is a view of its own, and says its stars are kept in the Planner', ((await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'Starred' }).getAttribute('title')) ?? '').includes("doesn't let other apps"));
  await shot('cal-13-tasks');

  await f.getByRole('button', { name: 'Create new list' }).click();
  await f.getByRole('textbox', { name: 'New list name' }).fill('Harness groceries');
  await f.getByRole('textbox', { name: 'New list name' }).press('Enter');
  const groceries = f.getByRole('region', { name: 'Harness groceries' });
  await groceries.waitFor();
  check('a new list is made in Google Tasks', fake.lists.some((list) => list.title === 'Harness groceries'));
  await groceries.getByRole('button', { name: 'List options for Harness groceries' }).click();
  await groceries.getByRole('menuitem', { name: 'Rename list' }).click();
  await groceries.getByRole('textbox', { name: 'List name' }).fill('Harness food');
  await groceries.getByRole('textbox', { name: 'List name' }).press('Enter');
  check('renaming a list renames it in Google Tasks', await until(() => fake.lists.some((list) => list.title === 'Harness food')));
  const food = f.getByRole('region', { name: 'Harness food' });
  await food.getByRole('button', { name: 'List options for Harness food' }).click();
  await food.getByRole('menuitem', { name: 'Delete list' }).click();
  check('deleting a list deletes it in Google Tasks', await until(() => !fake.lists.some((list) => list.title === 'Harness food')) && (await f.getByRole('region', { name: 'Harness food' }).count()) === 0);
  await f.getByRole('button', { name: 'All tasks' }).click();

  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const fresh = myTasks.getByRole('group', { name: 'New task' });
  await fresh.getByRole('textbox', { name: 'Title' }).fill('Harness buy milk');
  await fresh.getByRole('textbox', { name: 'Details' }).fill('Oat');
  await fresh.getByRole('button', { name: 'Add', exact: true }).click();
  const milkPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness buy milk'));
  check('Add a task adds it at the top of the list in Google Tasks', milkPost && !milkPost.query.previous && milkPost.body.notes === 'Oat');
  await myTasks.getByRole('button', { name: 'Actions for Plan the trip' }).click();
  await myTasks.getByRole('menuitem', { name: 'Add a subtask' }).click();
  const sub = myTasks.getByRole('group', { name: 'New task' });
  await sub.getByRole('textbox', { name: 'Title' }).fill('Pack the bags');
  await sub.getByRole('button', { name: 'Add', exact: true }).click();
  const subPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Pack the bags'));
  check('a subtask goes under its task, after the subtasks it has', subPost && subPost.query.parent === 't-trip' && subPost.query.previous === 't-hotel', JSON.stringify(subPost?.query));
  await myTasks.locator('li.gt-row.depth-1', { hasText: 'Pack the bags' }).waitFor();

  // Reorder by dragging, as in Google Tasks: the milk below the report.
  const milkRow = myTasks.locator('li.gt-row', { hasText: 'Harness buy milk' });
  await until(async () => (await milkRow.getAttribute('data-task'))?.startsWith('t'));
  const tripRow = myTasks.locator('li.gt-row.depth-0', { hasText: 'Plan the trip' });
  await milkRow.dragTo(tripRow, { targetPosition: { x: 20, y: 4 } });
  const milkId = [...fake.tasks.get('L1')].find((task) => task.title === 'Harness buy milk')?.id;
  const reordered = await until(() => requests('POST', `/tasks/v1/lists/L1/tasks/${milkId}/move`).find((request) => request.query.previous === 't-report'));
  check('dragging a task moves it in Google Tasks (after the report)', reordered && !reordered.query.parent, JSON.stringify(requests('POST', /\/move$/).map((request) => request.query)));
  await myTasks.getByRole('button', { name: 'Actions for Harness buy milk' }).click();
  await myTasks.getByRole('menuitem', { name: 'Indent' }).click();
  const indented = await until(() => requests('POST', `/tasks/v1/lists/L1/tasks/${milkId}/move`).find((request) => request.query.parent === 't-report'));
  check('Indent makes it a subtask of the task above', indented, JSON.stringify({ moves: requests('POST', /\/move$/).map((request) => request.query), rows: await myTasks.locator('li.gt-row').evaluateAll((rows) => rows.map((row) => `${row.className}:${row.getAttribute('aria-label')}`)) }));
  await myTasks.getByRole('button', { name: 'Actions for Harness buy milk' }).click();
  await myTasks.getByRole('menuitem', { name: 'Unindent' }).click();
  check('Unindent makes it a task again, after its parent', await until(() => requests('POST', `/tasks/v1/lists/L1/tasks/${milkId}/move`).find((request) => !request.query.parent && request.query.previous === 't-report')));
  await shot('cal-14-tasks-edited');

  // Edit in place: a date, which the calendar shows on that day.
  await myTasks.getByRole('button', { name: 'Edit Plan the trip' }).click();
  const editing = myTasks.getByRole('group', { name: 'Edit Plan the trip' });
  const noRepeat = editing.getByRole('combobox', { name: 'Repeat' });
  check(
    'editing a task offers a time, a deadline and a star, and says the Planner keeps them; a task with subtasks cannot repeat, and says why',
    (await editing.getByRole('combobox', { name: 'Time' }).count()) === 1 && (await editing.getByLabel('Deadline', { exact: true }).count()) === 1 && (await editing.getByRole('button', { name: 'Star' }).count()) === 1 && (await noRepeat.isDisabled()) && (await noRepeat.getAttribute('title')) === "A task with subtasks can't repeat, as in Google Tasks" && (await editing.innerText()).includes('Kept in the Planner'),
    await editing.innerText(),
  );
  await editing.getByLabel('Date', { exact: true }).fill(addDays(today, 1));
  await editing.getByRole('button', { name: 'Done' }).click();
  check('a new date is written to Google Tasks', await until(() => requests('PATCH', '/tasks/v1/lists/L1/tasks/t-trip').find((request) => request.body?.due === `${addDays(today, 1)}T00:00:00.000Z`)));

  // Complete one: it moves to Completed, with its subtasks.
  await myTasks.getByRole('checkbox', { name: 'Mark Plan the trip complete' }).click();
  const doneTrip = await until(() => fake.tasks.get('L1').find((task) => task.id === 't-trip')?.status === 'completed' && fake.tasks.get('L1').find((task) => task.id === 't-hotel')?.status === 'completed');
  check('completing a task completes it and its subtasks in Google Tasks', doneTrip);
  const completedToggle = myTasks.getByRole('button', { name: /^Completed \(\d+\)$/ });
  await completedToggle.click();
  check('completed tasks move to the Completed section', (await myTasks.getByRole('list', { name: 'My Tasks completed tasks' }).innerText()).includes('Plan the trip'));
  await shot('cal-15-completed');

  // Sort by date, as Google Tasks has it: under each day, then those with no date.
  const listOptions = myTasks.getByRole('button', { name: 'List options for My Tasks' });
  await listOptions.click();
  // The menu opens under its button, as Google Tasks' does (a placement without units was dropped and it sat in a corner).
  const optionsButtonBox = await listOptions.boundingBox();
  const optionsMenuBox = await myTasks.getByRole('menu', { name: 'List options for My Tasks' }).boundingBox();
  check("a list's menu opens under its button, right-aligned with it",
    Boolean(optionsButtonBox && optionsMenuBox) && Math.abs(optionsMenuBox.y - (optionsButtonBox.y + optionsButtonBox.height + 4)) <= 6 && Math.abs(optionsMenuBox.x + optionsMenuBox.width - (optionsButtonBox.x + optionsButtonBox.width)) <= 12,
    JSON.stringify({ button: optionsButtonBox, menu: optionsMenuBox }));
  await myTasks.getByRole('menuitemradio', { name: /Date$/ }).click();
  const byDate = myTasks.getByRole('list', { name: 'My Tasks tasks by date' });
  await byDate.waitFor();
  const dated = (await byDate.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
  const order = ['Today', 'Send the report', 'No date', 'Harness buy milk'].map((line) => dated.indexOf(line));
  check('Sort by date lists the tasks under their day, then the ones with no date', order.every((index, step) => index >= 0 && (step === 0 || index > order[step - 1])), JSON.stringify(dated));
  await shot('cal-15b-by-date');
  await listOptions.click();
  await myTasks.getByRole('menuitemradio', { name: /My order$/ }).click();
  await byDate.waitFor({ state: 'detached' });

  // Drag a task into another list, as in Google Tasks.
  const errands = f.getByRole('region', { name: 'Errands' });
  await myTasks.locator('li.gt-row', { hasText: 'Harness buy milk' }).dragTo(errands.locator('li.gt-row', { hasText: 'Buy stamps' }), { targetPosition: { x: 20, y: 4 } });
  const across = await until(() => requests('POST', `/tasks/v1/lists/L1/tasks/${milkId}/move`).find((request) => request.query.destinationTasklist === 'L2'));
  check('dragging a task into another list moves it there in Google Tasks', across && fake.tasks.get('L2').some((task) => task.id === milkId) && (await until(async () => (await errands.getByText('Harness buy milk').count()) === 1)), JSON.stringify(across?.query));

  // Delete one.
  await errands.getByRole('button', { name: 'Actions for Buy stamps' }).click();
  await errands.getByRole('menuitem', { name: 'Delete' }).click();
  check('deleting a task deletes it in Google Tasks', await until(() => !fake.tasks.get('L2').some((task) => task.id === 't-stamps')) && (await errands.getByText('Buy stamps').count()) === 0);

  // Back on the calendar: the new date shows, the completed task struck through.
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await goTo(addDays(today, 1));
  const moving = f.getByRole('button', { name: /^Google task Plan the trip, due .*completed/ });
  check('the calendar shows a task on its new date, completed', await moving.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false));
  await todayButton.click();

  // "Delete all completed tasks" asks first, then deletes each one, subtasks too.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'List options for My Tasks' }).click();
  await myTasks.getByRole('menuitem', { name: 'Delete all completed tasks' }).click();
  const clearing = myTasks.getByRole('group', { name: 'Delete all completed tasks?' });
  const asked = (await clearing.innerText()).includes('Delete 4 completed tasks?');
  await shot('cal-15c-delete-completed');
  await clearing.getByRole('button', { name: 'Delete' }).click();
  const cleared = await until(() => !fake.tasks.get('L1').some((task) => task.status === 'completed'));
  const deletes = requests('DELETE', /^\/tasks\/v1\/lists\/L1\/tasks\//).map((request) => request.path.split('/').at(-1));
  check(
    'Delete all completed tasks asks, then deletes them in Google Tasks, subtasks before their task',
    asked && cleared && deletes.length === 4 && deletes.indexOf('t-hotel') < deletes.indexOf('t-trip') && (await until(async () => (await myTasks.getByRole('button', { name: /^Completed \(/ }).count()) === 0)),
    JSON.stringify({ asked, deletes }),
  );

  // ── A planned Google task and its Planner task stay in step, whatever moves or changes ──
  /** Reload the Planner and wait until its Google side has read the account again (the sync runs then). */
  const reload = async () => {
    const mark = fake.requests.length;
    await h.openPlanner();
    await until(() => fake.requests.slice(mark).some((request) => request.path === '/tasks/v1/users/@me/lists'), 15_000);
    await page.waitForTimeout(1200);
  };
  const openTasks = async () => {
    await h.nav('Calendar').click();
    await f.getByRole('radio', { name: 'Tasks' }).click();
    await myTasks.waitFor();
  };
  const linkedTo = async (id) => Object.values((await state()).tasks).find((task) => task.source?.id === id && !task.deletedAt);
  const keptOf = async (id) => (await state()).googleTasks?.[`${ME}\n${id}`];

  // 1. Moved to another list in Tasks: the Planner task follows; after a reload, completing it in the Planner writes to that list.
  await myTasks.getByRole('button', { name: 'Actions for Send the report' }).click();
  await myTasks.getByRole('menuitem', { name: 'Move to Errands' }).click();
  const reportMove = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks/t-report/move').find((request) => request.query.destinationTasklist === 'L2'));
  const followed = await until(async () => (await linkedTo('t-report'))?.source?.listId === 'L2');
  check('moving a planned task to another list in Tasks moves it in Google, and its Planner task follows', reportMove && followed, JSON.stringify((await linkedTo('t-report'))?.source));
  await shot('cal-20-planned-task-moved');
  await reload();
  await h.nav('Today').click();
  const reportCard = f.locator('li.task-card', { hasText: 'Send the report' });
  await reportCard.waitFor();
  await reportCard.getByRole('button', { name: 'Mark complete' }).click();
  const completedThere = await until(() => requests('PATCH', '/tasks/v1/lists/L2/tasks/t-report').find((request) => request.body?.status === 'completed'), 15_000);
  await reload();
  const agreed = await until(async () => {
    const task = await linkedTo('t-report');
    return task?.completedAt && task.source?.status?.type === 'completed' ? task : null;
  });
  const stale = requests('PATCH', '/tasks/v1/lists/L1/tasks/t-report').filter((request) => request.at > (reportMove?.at ?? 0));
  check(
    'completing it in the Planner after a reload writes PATCH …/lists/L2/tasks/t-report (completed); both sides agree after another reload',
    completedThere && !stale.length && agreed && fake.tasks.get('L2').find((task) => task.id === 't-report')?.status === 'completed',
    JSON.stringify({ completedThere: completedThere?.path, stale: stale.map((request) => request.path), planner: agreed?.source, google: fake.tasks.get('L2').find((task) => task.id === 't-report')?.status }),
  );
  await shot('cal-21-completed-after-move');

  // 2. Changed in Google: the Planner copy takes the new details and date. Changed on both sides: the newer change wins.
  await openTasks();
  await errands.getByRole('button', { name: 'Actions for Harness buy milk' }).click();
  await errands.getByRole('menuitem', { name: 'Plan today' }).click();
  // Planned today, it is due today in Google too (the setting); edits in Google come after that write.
  await until(async () => (await linkedTo(milkId))?.source?.due === today, 15_000);
  const milk = () => fake.tasks.get('L2').find((task) => task.id === milkId);
  Object.assign(milk(), { notes: 'Oat, two cartons', due: `${addDays(today, 2)}T00:00:00.000Z`, updated: new Date().toISOString() });
  await reload();
  const fromGoogle = await until(async () => {
    const task = await linkedTo(milkId);
    return task?.notes === 'Oat, two cartons' && task.dueDate === addDays(today, 2) ? task : null;
  }, 15_000);
  check('details and a date changed in Google reach the Planner task on a refresh', fromGoogle, JSON.stringify(await linkedTo(milkId)));
  /** Rename the Planner task in its details while Google refuses the write, so both sides change apart. */
  const renameApart = async (title) => {
    fake.failNext('PATCH', `/tasks/${milkId}`, 503, 'Backend Error');
    const before = (await linkedTo(milkId)).title;
    await f.getByRole('button', { name: `Open ${before}` }).first().click();
    const details = f.getByRole('dialog', { name: 'Task details' });
    await details.getByRole('textbox', { name: 'Title' }).fill(title);
    await details.getByRole('textbox', { name: 'Title' }).press('Enter');
    await until(async () => (await linkedTo(milkId))?.title === title);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  };
  await renameApart('Harness milk, mine');
  Object.assign(milk(), { title: 'Harness milk, from Google', updated: new Date(Date.now() + 1000).toISOString() });
  await reload();
  const googleNewer = await until(async () => (await linkedTo(milkId))?.title === 'Harness milk, from Google', 15_000);
  await renameApart('Harness milk, mine again');
  Object.assign(milk(), { title: 'Harness milk, older in Google', updated: new Date(Date.now() - 60_000).toISOString() });
  await reload();
  const plannerNewer = await until(() => requests('PATCH', `/tasks/v1/lists/L2/tasks/${milkId}`).find((request) => request.body?.title === 'Harness milk, mine again'), 15_000);
  check(
    'renamed on both sides: the newer change wins, Google’s when it is newer, the Planner’s (sent to Google) when it is',
    googleNewer && plannerNewer && milk().title === 'Harness milk, mine again' && (await linkedTo(milkId))?.title === 'Harness milk, mine again',
    JSON.stringify({ googleNewer, plannerNewer: plannerNewer?.body, google: milk().title, planner: (await linkedTo(milkId))?.title }),
  );

  // 3. A time on a Google task (kept in the Planner): in the grid at that time after a reload; dragged to another day, Google's date follows.
  await openTasks();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const timedForm = myTasks.getByRole('group', { name: 'New task' });
  await timedForm.getByRole('textbox', { name: 'Title' }).fill('Harness timed task');
  await timedForm.getByLabel('Date', { exact: true }).fill(today);
  await timedForm.getByRole('combobox', { name: 'Time' }).selectOption('840');
  await timedForm.getByRole('combobox', { name: 'End time' }).selectOption('900');
  await shot('cal-22-task-time');
  await timedForm.getByRole('button', { name: 'Add', exact: true }).click();
  await timedForm.getByRole('button', { name: 'Cancel' }).click();
  const timedPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness timed task'));
  const timedId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness timed task')?.id);
  const timedKept = await until(() => keptOf(timedId).then((kept) => (kept?.time === 840 ? kept : null)));
  check('a task with a time: Google gets its date only, the Planner keeps the time (2 – 3pm)', timedPost?.body?.due === `${today}T00:00:00.000Z` && !/T14|2pm|14:00/.test(JSON.stringify(timedPost.body)) && timedKept?.duration === 60, JSON.stringify({ body: timedPost?.body, kept: timedKept }));
  await reload();
  await h.nav('Calendar').click();
  const timedChip = (date) => lane(date).locator('.grid-item.is-task', { hasText: 'Harness timed task' });
  await timedChip(today).waitFor({ timeout: 15_000 });
  const laneTop = (await lane(today).boundingBox()).y;
  let chipBox = await timedChip(today).boundingBox();
  check('after a reload it sits in the week’s grid at 2pm, with its check circle', Math.abs(chipBox.y - laneTop - 840 * 0.8) <= 2 && (await timedChip(today).getByRole('checkbox').count()) === 1, JSON.stringify({ top: chipBox.y - laneTop }));
  await shot('cal-23-timed-task-in-grid');
  const dragDay = (await f.locator('.day-lane').evaluateAll((lanes, day) => lanes.map((element) => element.getAttribute('data-date')).filter((date) => date !== day), today)).find((date) => date > today) ?? (await f.locator('.day-lane').first().getAttribute('data-date'));
  const dragBox = await lane(dragDay).boundingBox();
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width / 2, chipBox.y + 8, { steps: 10 });
  await page.mouse.up();
  const dueMoved = await until(() => requests('PATCH', `/tasks/v1/lists/L1/tasks/${timedId}`).find((request) => request.body?.due === `${dragDay}T00:00:00.000Z`));
  const landed = await timedChip(dragDay).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  chipBox = landed ? await timedChip(dragDay).boundingBox() : null;
  check('dragging it to another day patches Google’s due date; it keeps its time there', dueMoved && landed && (await keptOf(timedId))?.time === 840 && Math.abs(chipBox.y - laneTop - 840 * 0.8) <= 2, JSON.stringify({ dueMoved: dueMoved?.body, landed }));
  // Quick create's Task, as in Google Calendar: one Google task on that day, at the time clicked (kept in the Planner), and nothing else.
  const quickLane = await lane(dragDay).boundingBox();
  await page.mouse.click(quickLane.x + quickLane.width / 2, quickLane.y + 10 * 48 + 3);
  await f.getByRole('dialog', { name: 'New event' }).getByRole('radio', { name: 'Task' }).click();
  const quickTask = f.getByRole('dialog', { name: 'New task' });
  await quickTask.getByRole('textbox', { name: 'Title' }).fill('Harness quick task');
  await shot('cal-23b-quick-create-task');
  await quickTask.getByRole('button', { name: 'Save' }).click();
  const quickPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness quick task'));
  const quickId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness quick task')?.id);
  const quickKept = await until(() => keptOf(quickId).then((kept) => (kept?.time === 600 ? kept : null)));
  const quickChip = await lane(dragDay).locator('.grid-item.is-task', { hasText: 'Harness quick task' }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const plannerCopies = Object.values((await state()).tasks).filter((task) => task.title === 'Harness quick task').length;
  check('quick create’s Task makes one Google task on that day, its 10am kept in the Planner, shown at 10am; no Planner task besides', quickPost?.body?.due === `${dragDay}T00:00:00.000Z` && quickKept?.duration === 60 && quickChip && plannerCopies === 0, JSON.stringify({ body: quickPost?.body, kept: quickKept, quickChip, plannerCopies }));

  // 4. A deadline: on the task in Tasks and on its calendar chip, red once it has passed.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'Edit Harness timed task' }).click();
  const timedEdit = myTasks.getByRole('group', { name: 'Edit Harness timed task' });
  await timedEdit.getByLabel('Deadline', { exact: true }).fill(addDays(today, -1));
  await timedEdit.getByRole('button', { name: 'Done' }).click();
  const rowDeadline = myTasks.locator('li.gt-row', { hasText: 'Harness timed task' }).locator('.gt-deadline');
  const deadlineShown = await rowDeadline.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  const rowText = deadlineShown ? await rowDeadline.innerText() : '';
  const rowOverdue = deadlineShown && ((await rowDeadline.getAttribute('class')) ?? '').includes('is-overdue');
  await shot('cal-24-deadline-tasks');
  await f.getByRole('radio', { name: 'Calendar' }).click();
  const chipDeadline = timedChip(dragDay).locator('.task-deadline');
  const onChip = await chipDeadline.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  check(
    'a deadline shows on the task in Tasks and on its calendar chip, red once passed',
    rowText.includes('Deadline') && rowOverdue && onChip && ((await chipDeadline.getAttribute('class')) ?? '').includes('is-overdue') && ((await timedChip(dragDay).getAttribute('aria-label')) ?? '').includes(`deadline ${longDay(addDays(today, -1))}, overdue`),
    JSON.stringify({ rowText, rowOverdue, onChip, label: await timedChip(dragDay).getAttribute('aria-label').catch(() => null) }),
  );
  await shot('cal-25-deadline-chip');

  // 5. A weekly repeating task: completing it makes the next one a week on in Google; editing All tasks changes the rule.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const weeklyForm = myTasks.getByRole('group', { name: 'New task' });
  await weeklyForm.getByRole('textbox', { name: 'Title' }).fill('Harness weekly review');
  await weeklyForm.getByLabel('Date', { exact: true }).fill(today);
  await weeklyForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: `Weekly on ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}` });
  await shot('cal-26-repeat');
  await weeklyForm.getByRole('button', { name: 'Add', exact: true }).click();
  await weeklyForm.getByRole('button', { name: 'Cancel' }).click();
  const weeklyId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness weekly review')?.id);
  const weeklyRule = await until(() => keptOf(weeklyId).then((kept) => kept?.repeat?.rule ?? null));
  await myTasks.getByRole('checkbox', { name: 'Mark Harness weekly review complete' }).click();
  const nextWeek = addDays(today, 7);
  const nextPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness weekly review' && request.body?.due === `${nextWeek}T00:00:00.000Z`), 15_000);
  await page.waitForTimeout(1500);
  const weeklyPosts = requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === 'Harness weekly review');
  check(
    'completing a weekly task inserts the next one in Google Tasks, a week on, once',
    weeklyRule === `RRULE:FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${today}T00:00:00Z`).getUTCDay()]}` && nextPost && weeklyPosts.length === 2,
    JSON.stringify({ weeklyRule, posts: weeklyPosts.map((request) => request.body?.due) }),
  );
  const nextId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness weekly review' && task.status !== 'completed')?.id);
  await myTasks.getByRole('button', { name: 'Edit Harness weekly review' }).click();
  const seriesEdit = myTasks.getByRole('group', { name: 'Edit Harness weekly review' });
  await seriesEdit.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
  await seriesEdit.getByRole('button', { name: 'Done' }).click();
  const seriesQuestion = f.getByRole('alertdialog', { name: 'Edit repeating task' });
  await seriesQuestion.waitFor();
  await shot('cal-27-edit-all-tasks');
  await seriesQuestion.getByRole('radio', { name: 'All tasks' }).check();
  await seriesQuestion.getByRole('button', { name: 'OK' }).click();
  const daily = await until(() => keptOf(nextId).then((kept) => kept?.repeat?.rule === 'RRULE:FREQ=DAILY'));
  check('editing All tasks changes the series’ rule', daily, JSON.stringify(await keptOf(nextId)));

  // 6. A star: the task shows in Starred, then leaves it, and stays so after a reload.
  const starredView = f.getByRole('region', { name: 'Starred' });
  const starredRow = starredView.locator('li.gt-row', { hasText: 'Harness timed task' });
  await myTasks.getByRole('button', { name: 'Star Harness timed task' }).click();
  await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'Starred' }).click();
  const starredIn = await starredRow.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  await shot('cal-28-starred');
  await reload();
  await openTasks();
  await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'Starred' }).click();
  const starredKept = await starredRow.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  await starredView.getByRole('button', { name: 'Star Harness timed task' }).click();
  // Gone from the view, and kept so by the service, before the page goes away.
  const starredOut = (await until(async () => (await starredRow.count()) === 0)) && (await until(async () => !(await keptOf(timedId))?.starredAt));
  await reload();
  await openTasks();
  await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'Starred' }).click();
  await starredView.waitFor();
  await page.waitForTimeout(1500);
  check('starring a task shows it in Starred, unstarring takes it out, and both last through a reload', starredIn && starredKept && starredOut && (await starredRow.count()) === 0, JSON.stringify({ starredIn, starredKept, starredOut }));
  await f.getByRole('navigation', { name: 'Task lists' }).getByRole('button', { name: 'All tasks' }).click();
  await f.getByRole('radio', { name: 'Calendar' }).click();


  // ── 8. A repeating task's series (review 3): This task changes one occurrence, All tasks the series; the next one is made from it ──
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const due = (date) => `${date}T00:00:00.000Z`;
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const dailyForm = myTasks.getByRole('group', { name: 'New task' });
  await dailyForm.getByRole('textbox', { name: 'Title' }).fill('Harness daily');
  await dailyForm.getByRole('textbox', { name: 'Details' }).fill('Series notes');
  await dailyForm.getByLabel('Date', { exact: true }).fill(today);
  await dailyForm.getByRole('combobox', { name: 'Time' }).selectOption('600');
  await dailyForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
  await dailyForm.getByRole('button', { name: 'Add', exact: true }).click();
  await dailyForm.getByRole('button', { name: 'Cancel' }).click();
  const dailyId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness daily')?.id);
  const dailyKept = await until(() => keptOf(dailyId).then((kept) => (kept?.repeat?.template ? kept : null)));
  check('a new daily task keeps its series: the template (title, details, 10am) and the date its schedule starts', dailyKept?.repeat?.template?.title === 'Harness daily' && dailyKept.repeat.template.notes === 'Series notes' && dailyKept.repeat.template.time === 600 && dailyKept.repeat.on === today, JSON.stringify(dailyKept));
  const seriesPosts = () => requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => ['Harness daily', 'Harness one-off', 'Harness standup'].includes(request.body?.title));

  // Before it is completed, its upcoming occurrences show on the week grid, at 10am, drawn as the series'.
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await goTo(tomorrow);
  const upcomingOn = (date, title = 'Harness daily') => lane(date).locator('.grid-item.is-upcoming', { hasText: title });
  const itemsOn = (date, title) => lane(date).locator('.grid-item', { hasText: title });
  await upcomingOn(tomorrow).waitFor({ timeout: 15_000 }).catch(() => {});
  const upcomingBox = await upcomingOn(tomorrow).boundingBox().catch(() => null);
  const tomorrowTop = (await lane(tomorrow).boundingBox())?.y ?? 0;
  const laterDays = await f.locator('.day-lane').evaluateAll((lanes, day) => lanes.map((element) => element.getAttribute('data-date')).filter((date) => date > day), today);
  const upcomingCounts = await Promise.all(laterDays.map((date) => upcomingOn(date).count()));
  check(
    'before it is completed, a daily task shows its upcoming occurrences on the week grid, one a day at 10am, marked as upcoming',
    upcomingBox && Math.abs(upcomingBox.y - tomorrowTop - 600 * 0.8) <= 2 && upcomingCounts.every((count) => count === 1) && ((await upcomingOn(tomorrow).getAttribute('aria-label')) ?? '').startsWith('Google task Harness daily, upcoming') && ((await lane(today).count()) === 0 || (await itemsOn(today, 'Harness daily').count()) === 1),
    JSON.stringify({ top: upcomingBox ? upcomingBox.y - tomorrowTop : null, laterDays, upcomingCounts, label: await upcomingOn(tomorrow).getAttribute('aria-label').catch(() => null) }),
  );
  await shot('cal-31-upcoming-occurrences-1440');
  await upcomingOn(tomorrow).click();
  const seriesPopover = f.getByRole('dialog', { name: 'Repeating Google task: Harness daily' });
  const seriesText = await seriesPopover.innerText().catch(() => '');
  check(
    'an upcoming occurrence opens its details: title, when, how its series repeats, with Edit and Delete (each asks This task or the series)',
    seriesText.includes('Harness daily') && seriesText.includes('Daily') && seriesText.includes(`${longDay(tomorrow)} ⋅ 10am`) && (await seriesPopover.getByRole('button', { name: 'Edit task' }).count()) === 1 && (await seriesPopover.getByRole('button', { name: 'Delete task' }).count()) === 1,
    seriesText,
  );
  await shot('cal-32-series-popover-1440');
  await seriesPopover.getByRole('button', { name: 'Close' }).click();

  // This task: a one-off title, details and time; completing it makes tomorrow's from the series, once.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'Edit Harness daily' }).click();
  const oneOff = myTasks.getByRole('group', { name: 'Edit Harness daily' });
  await oneOff.getByRole('textbox', { name: 'Title' }).fill('Harness one-off');
  await oneOff.getByRole('textbox', { name: 'Details' }).fill('Only today');
  await oneOff.getByRole('combobox', { name: 'Time' }).selectOption('720');
  await oneOff.getByRole('button', { name: 'Done' }).click();
  const repeatQuestion = f.getByRole('alertdialog', { name: 'Edit repeating task' });
  await repeatQuestion.getByRole('radio', { name: 'This task' }).check();
  await shot('cal-33-this-task');
  await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  const oneOffDone = await until(async () => fake.tasks.get('L1').find((task) => task.id === dailyId)?.title === 'Harness one-off' && (await keptOf(dailyId))?.time === 720);
  const keptAfterOne = await keptOf(dailyId);
  check('This task changes this occurrence alone: Google has its title and details, the Planner its 12pm; the series keeps its own', oneOffDone && fake.tasks.get('L1').find((task) => task.id === dailyId)?.notes === 'Only today' && keptAfterOne?.repeat?.template?.title === 'Harness daily' && keptAfterOne.repeat.template.time === 600 && keptAfterOne.repeat.on === today, JSON.stringify(keptAfterOne));
  const postsBefore = seriesPosts().length;
  await myTasks.getByRole('checkbox', { name: 'Mark Harness one-off complete' }).click();
  await until(() => seriesPosts().length > postsBefore, 15_000);
  await page.waitForTimeout(1500);
  await reload();
  const second = fake.tasks.get('L1').find((task) => task.title === 'Harness daily' && task.status !== 'completed');
  const secondKept = second ? await keptOf(second.id) : null;
  const madeOnce = seriesPosts().length === postsBefore + 1 && fake.tasks.get('L1').filter((task) => task.status !== 'completed' && ['Harness daily', 'Harness one-off'].includes(task.title)).length === 1;
  check(
    'completing it makes tomorrow’s occurrence once, from the series: its title and details in Google, 10am in the Planner, after a reload',
    second?.due === due(tomorrow) && second.notes === 'Series notes' && secondKept?.time === 600 && secondKept.repeat?.index === 2 && secondKept.repeat.on === tomorrow && madeOnce,
    JSON.stringify({ second, secondKept, posts: seriesPosts().map((request) => request.body) }),
  );
  // After completing today's, tomorrow shows one item: the real occurrence, not a projection beside it.
  await h.nav('Calendar').click();
  await goTo(tomorrow);
  await until(async () => (await lane(tomorrow).locator('.grid-item.is-task:not(.is-upcoming)', { hasText: 'Harness daily' }).count()) === 1, 15_000);
  check(
    'after today’s is completed, tomorrow shows one item for the series (Google’s, at 10am), and the days after it their upcoming ones',
    (await itemsOn(tomorrow, 'Harness daily').count()) === 1 && (await upcomingOn(tomorrow).count()) === 0 && (laterDays.length < 2 || (await upcomingOn(laterDays[1]).count()) === 1),
    JSON.stringify({ tomorrow: await itemsOn(tomorrow, 'Harness daily').evaluateAll((items) => items.map((item) => item.className)) }),
  );
  await shot('cal-34-next-occurrence-1440');

  // All tasks: the series changes; the following occurrence has the new values.
  await openTasks();
  await myTasks.getByRole('button', { name: 'Edit Harness daily' }).click();
  const allEdit = myTasks.getByRole('group', { name: 'Edit Harness daily' });
  await allEdit.getByRole('textbox', { name: 'Title' }).fill('Harness standup');
  await allEdit.getByRole('textbox', { name: 'Details' }).fill('Standup notes');
  await allEdit.getByRole('combobox', { name: 'Time' }).selectOption('540');
  await allEdit.getByRole('button', { name: 'Done' }).click();
  await repeatQuestion.getByRole('radio', { name: 'All tasks' }).check();
  await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  const allDone = await until(async () => fake.tasks.get('L1').find((task) => task.id === second?.id)?.title === 'Harness standup' && (await keptOf(second.id))?.repeat?.template?.title === 'Harness standup');
  const postsBeforeThird = seriesPosts().length;
  await myTasks.getByRole('checkbox', { name: 'Mark Harness standup complete' }).click();
  const third = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness standup' && task.status !== 'completed' && task.id !== second?.id), 15_000);
  const thirdKept = third ? await until(() => keptOf(third.id).then((kept) => (kept?.repeat ? kept : null))) : null;
  check(
    'All tasks changes the series: this one takes the new title, details and 9am, and the following one is made with them',
    allDone && third?.due === due(dayAfter) && third.notes === 'Standup notes' && thirdKept?.time === 540 && seriesPosts().length === postsBeforeThird + 1,
    JSON.stringify({ third, thirdKept }),
  );
  const standupId = third?.id;

  // ── 9. A task with only a deadline: on that day's all-day row, as Google Calendar's flag, in Week, Month and Day ──
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await todayButton.click();
  const weekDays = await f.locator('.day-lane').evaluateAll((lanes) => lanes.map((element) => element.getAttribute('data-date')));
  const deadlineDay = weekDays.find((date) => date > today) ?? weekDays.find((date) => date < today);
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const deadlineForm = myTasks.getByRole('group', { name: 'New task' });
  await deadlineForm.getByRole('textbox', { name: 'Title' }).fill('Harness deadline only');
  await deadlineForm.getByLabel('Deadline', { exact: true }).fill(deadlineDay);
  await deadlineForm.getByRole('button', { name: 'Add', exact: true }).click();
  await deadlineForm.getByRole('button', { name: 'Cancel' }).click();
  const deadlineId = await until(() => fake.tasks.get('L1').find((task) => task.title === 'Harness deadline only')?.id);
  await until(() => keptOf(deadlineId).then((kept) => kept?.deadline === deadlineDay));
  const deadlinePost = requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness deadline only');
  await reload();
  await h.nav('Calendar').click();
  const deadlineBar = f.locator('.all-day-bar.is-deadline', { hasText: 'Harness deadline only' });
  /** Whether an item's middle is over a day's cell. */
  const over = async (item, cell) => {
    const [a, b] = [await item.boundingBox(), await cell.boundingBox()];
    return Boolean(a && b && a.x + a.width / 2 > b.x && a.x + a.width / 2 < b.x + b.width);
  };
  const deadlineViews = async (size) => {
    await pickView('Week');
    await f.locator('.day-lane').nth(weekDays.length - 1).waitFor({ timeout: 5000 });
    const week = (await deadlineBar.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) && (await over(deadlineBar, f.locator(`.all-day-cell[data-date="${deadlineDay}"]`)));
    const label = (await deadlineBar.getAttribute('aria-label').catch(() => '')) ?? '';
    await shot(`cal-35-deadline-week-${size}`);
    await pickView('Month');
    const chip = f.locator('.month-chip.is-deadline', { hasText: 'Harness deadline only' });
    const month = (await chip.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)) && (await over(chip, f.locator(`.month-cell[data-date="${deadlineDay}"]`)));
    await shot(`cal-36-deadline-month-${size}`);
    await pickView('Schedule');
    const agenda = f.getByRole('region', { name: longDay(deadlineDay) }).locator('.schedule-item.is-deadline', { hasText: 'Harness deadline only' });
    const schedule = await agenda.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    const upcomingListed = await f.locator('.schedule-item.is-upcoming').count();
    await shot(`cal-36b-deadline-schedule-${size}`);
    await pickView('Week');
    await f.getByRole('button', { name: `${longDay(deadlineDay)}: show this day` }).click();
    const day = (await f.locator('.day-lane').count()) === 1 && (await lane(deadlineDay).count()) === 1 && (await deadlineBar.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
    await shot(`cal-37-deadline-day-${size}`);
    await pickView('Week');
    await f.locator('.day-lane').nth(weekDays.length - 1).waitFor({ timeout: 5000 });
    return { week, month, schedule, upcomingListed, day, label };
  };
  const wideDeadline = await deadlineViews(1440);
  check(
    'a task with only a deadline shows on that day in Week, Month, Day (the all-day row) and Schedule, as a deadline, after a reload (1440 px); Schedule lists upcoming occurrences too',
    !deadlinePost?.body?.due && wideDeadline.week && wideDeadline.month && wideDeadline.day && wideDeadline.schedule && wideDeadline.upcomingListed > 0 && wideDeadline.label.startsWith(`Google task Harness deadline only, deadline ${longDay(deadlineDay)}`) && wideDeadline.label.includes('no date'),
    JSON.stringify({ wideDeadline, body: deadlinePost?.body }),
  );
  await deadlineBar.click();
  const deadlinePopover = f.getByRole('dialog', { name: 'Google task: Harness deadline only' });
  const deadlinePopText = await deadlinePopover.innerText().catch(() => '');
  check('its details say it has no date, and its deadline', deadlinePopText.includes('No date') && deadlinePopText.includes(`Deadline: ${longDay(deadlineDay)}`), deadlinePopText);
  await deadlinePopover.getByRole('button', { name: 'Close' }).click();

  // ── 10. Edit from a Google task's details on the calendar: the Tasks view's form over the calendar, which stays on its week ──
  const reviewDay = addDays(today, 7);
  await goTo(reviewDay);
  const reviewChip = f.getByRole('button', { name: /^Google task Harness weekly review, due / });
  await reviewChip.waitFor({ timeout: 15_000 });
  const weekTitle = (await f.locator('.gcal-title').innerText()).trim();
  await reviewChip.click();
  const reviewPopover = f.getByRole('dialog', { name: 'Google task: Harness weekly review' });
  await reviewPopover.getByRole('button', { name: 'Edit task' }).waitFor();
  await shot('cal-38-task-popover-edit-1440');
  await reviewPopover.getByRole('button', { name: 'Edit task' }).click();
  const taskEditor = f.getByRole('dialog', { name: 'Edit task: Harness weekly review' });
  await taskEditor.waitFor();
  const editorForm = taskEditor.getByRole('group', { name: 'Edit Harness weekly review' });
  const editorOffers = (await editorForm.getByRole('combobox', { name: 'Repeat' }).isEnabled()) && (await editorForm.getByRole('combobox', { name: 'List' }).isDisabled()) && (await editorForm.getByRole('textbox', { name: 'Details' }).count()) === 1 && (await editorForm.getByRole('button', { name: 'Star' }).count()) === 1;
  await editorForm.getByRole('textbox', { name: 'Title' }).fill('Harness weekly review, edited');
  await editorForm.getByRole('combobox', { name: 'Time' }).selectOption('660');
  await editorForm.getByLabel('Deadline', { exact: true }).fill(addDays(reviewDay, 1));
  await shot('cal-39-task-editor-1440');
  await editorForm.getByRole('button', { name: 'Done' }).click();
  await repeatQuestion.getByRole('radio', { name: 'This task' }).check();
  await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  const reviewTask = () => fake.tasks.get('L1').find((task) => task.id === nextId);
  const edited = await until(async () => reviewTask()?.title === 'Harness weekly review, edited' && (await keptOf(nextId))?.time === 660);
  const stayed = (await taskEditor.count()) === 0 && (await f.locator('.gcal-title').innerText()).trim() === weekTitle && (await lane(reviewDay).count()) === 1;
  check(
    'Edit in a task’s details opens the Tasks view’s form over the calendar (repeat; list kept, as it repeats); its title, time and deadline are saved, and the calendar stays on that week',
    editorOffers && edited && (await keptOf(nextId))?.deadline === addDays(reviewDay, 1) && stayed,
    JSON.stringify({ editorOffers, edited, stayed, kept: await keptOf(nextId), title: reviewTask()?.title }),
  );
  await reload();
  await h.nav('Calendar').click();
  await goTo(reviewDay);
  const editedChip = lane(reviewDay).locator('.grid-item.is-task:not(.is-upcoming)', { hasText: 'Harness weekly review, edited' });
  const editedShown = await editedChip.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const editedBox = editedShown ? await editedChip.boundingBox() : null;
  const reviewTop = (await lane(reviewDay).boundingBox())?.y ?? 0;
  check(
    'after a reload, the edited task is at 11am on its day with its new title and deadline',
    editedShown && Math.abs((editedBox?.y ?? 0) - reviewTop - 660 * 0.8) <= 2 && ((await editedChip.getAttribute('aria-label')) ?? '').includes(`deadline ${longDay(addDays(reviewDay, 1))}`),
    JSON.stringify({ editedShown, top: editedBox ? editedBox.y - reviewTop : null, label: await editedChip.getAttribute('aria-label').catch(() => null) }),
  );
  await shot('cal-40-edited-after-reload-1440');
  await todayButton.click();

  // ── 11. A repeating task takes no subtasks, by any path, as in Google Tasks ──
  await openTasks();
  const standupRow = myTasks.locator(`li.gt-row[data-task="${standupId}"]`);
  await standupRow.waitFor();
  await myTasks.getByRole('button', { name: 'Actions for Harness standup' }).click();
  const addSubtask = myTasks.getByRole('menuitem', { name: 'Add a subtask' });
  const addBlocked = (await addSubtask.getAttribute('aria-disabled')) === 'true' && (await addSubtask.getAttribute('title')) === "A repeating task can't have subtasks, as in Google Tasks";
  await shot('cal-41-no-subtask-menu');
  await addSubtask.click({ force: true });
  const noForm = (await myTasks.getByRole('group', { name: 'New task' }).count()) === 0;
  await myTasks.click({ position: { x: 4, y: 4 } });
  // A task moved right below the repeating one (at the top level) cannot go under it: Indent is unavailable, with why.
  const rowsNow = () => myTasks.locator('ul[aria-label="My Tasks tasks"] > li.gt-row').evaluateAll((rows) => rows.map((row) => ({ id: row.getAttribute('data-task'), title: row.getAttribute('aria-label') })));
  const deadlineRow = myTasks.locator(`li.gt-row[data-task="${deadlineId}"]`);
  const standupHeight = (await standupRow.boundingBox()).height;
  await deadlineRow.dragTo(standupRow, { targetPosition: { x: 20, y: standupHeight - 4 } });
  await until(() => requests('POST', `/tasks/v1/lists/L1/tasks/${deadlineId}/move`).find((request) => request.query.previous === standupId && !request.query.parent));
  const belowStandup = await until(async () => {
    const rows = await rowsNow();
    return rows[rows.findIndex((row) => row.id === standupId) + 1]?.id === deadlineId ? rows : null;
  });
  const menuItem = async (title, name) => {
    await myTasks.getByRole('button', { name: `Actions for ${title}` }).first().click();
    const entry = myTasks.getByRole('menuitem', { name });
    const said = `${await entry.getAttribute('aria-disabled')}|${await entry.getAttribute('title')}`;
    await entry.click({ force: true });
    await myTasks.click({ position: { x: 4, y: 4 } });
    return said;
  };
  const indentBelow = await menuItem('Harness deadline only', 'Indent');
  // A repeating task with a task above it cannot go under that one either.
  const repeatingIds = Object.values((await state()).googleTasks ?? {}).filter((kept) => kept.repeat).map((kept) => kept.taskId);
  const rows = belowStandup ?? (await rowsNow());
  const repeatingBelow = rows.find((row, index) => index > 0 && repeatingIds.includes(row.id));
  const indentSelf = repeatingBelow ? await menuItem(repeatingBelow.title, 'Indent') : 'none below another task';
  check(
    'on a repeating task, "Add a subtask" and Indent are unavailable, with the reason',
    addBlocked && noForm && Boolean(belowStandup) && indentBelow === "true|A repeating task can't have subtasks, as in Google Tasks" && (!repeatingBelow || indentSelf === "true|A repeating task can't be a subtask, as in Google Tasks"),
    JSON.stringify({ addBlocked, noForm, indentBelow, indentSelf, rows: rows.map((row) => row.title) }),
  );
  // Dragged to the right just under the repeating task, it stays at the top level.
  const mark = fake.requests.length;
  await deadlineRow.dragTo(standupRow, { targetPosition: { x: 120, y: standupHeight - 4 } });
  await page.waitForTimeout(1500);
  const nested = fake.requests.filter((request) => request.method === 'POST' && repeatingIds.includes(request.query.parent));
  const childrenOfRepeating = [...fake.tasks.values()].flat().filter((task) => repeatingIds.includes(task.parent));
  check(
    'a task dragged under a repeating task does not nest; the fake Google got no request that would give a repeating task a subtask',
    nested.length === 0 && childrenOfRepeating.length === 0 && fake.requests.slice(mark).every((request) => !request.query.parent),
    JSON.stringify({ nested, childrenOfRepeating: childrenOfRepeating.map((task) => task.title), after: fake.requests.slice(mark).map((request) => `${request.method} ${request.path} ${JSON.stringify(request.query)}`) }),
  );
  await shot('cal-42-drag-not-nested');
  await f.getByRole('radio', { name: 'Calendar' }).click();

  // ── 12. An upcoming occurrence's series: Edit → All tasks (asked once, before the editor), then Delete → All tasks ──
  await goTo(addDays(dayAfter, 1));
  const standupUpcoming = () => f.locator('.grid-item.is-upcoming', { hasText: 'Harness standup' }).first();
  await standupUpcoming().click();
  const standupSeries = f.getByRole('dialog', { name: 'Repeating Google task: Harness standup' });
  await standupSeries.getByRole('button', { name: 'Edit task' }).click();
  await repeatQuestion.getByRole('radio', { name: 'All tasks' }).check();
  await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  const seriesEditor = f.getByRole('dialog', { name: 'Edit all tasks: Harness standup' });
  const seriesForm = seriesEditor.getByRole('group', { name: 'Edit Harness standup' });
  await seriesForm.getByRole('combobox', { name: 'Time' }).selectOption('480');
  await shot('cal-46-edit-all-tasks-editor');
  await seriesForm.getByRole('button', { name: 'Done' }).click();
  const seriesAsked = await repeatQuestion.waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
  const seriesMoved = await until(() => keptOf(standupId).then((kept) => kept?.time === 480 && kept.repeat?.template?.time === 480));
  const upcomingLane = await standupUpcoming().evaluate((element) => element.closest('.day-lane')?.getAttribute('data-date')).catch(() => null);
  const upcomingAt = upcomingLane ? (await standupUpcoming().boundingBox()).y - (await lane(upcomingLane).boundingBox()).y : null;
  check(
    'Edit → All tasks from an upcoming occurrence changes the series, asking nothing more: the open task and its upcoming ones go to 8am',
    !seriesAsked && seriesMoved && upcomingAt !== null && Math.abs(upcomingAt - 480 * 0.8) <= 2,
    JSON.stringify({ seriesAsked, seriesMoved, upcomingAt, kept: await keptOf(standupId) }),
  );
  await shot('cal-47-series-at-8am');
  await standupUpcoming().click();
  await standupSeries.getByRole('button', { name: 'Delete task' }).click();
  const deleteSeries = f.getByRole('alertdialog', { name: 'Delete repeating task' });
  await deleteSeries.getByRole('radio', { name: 'All tasks' }).check();
  await shot('cal-48-delete-series-question');
  await deleteSeries.getByRole('button', { name: 'OK' }).click();
  const seriesGone = await until(async () => requests('DELETE', `/tasks/v1/lists/L1/tasks/${standupId}`).length === 1 && !(await keptOf(standupId)) && (await f.locator('.grid-item.is-upcoming', { hasText: 'Harness standup' }).count()) === 0);
  // Its completed tasks too (the one-off first, then the 9am one), as Google Calendar's All tasks deletes them.
  const historyGone = await until(() => [dailyId, second?.id].every((id) => id && !fake.tasks.get('L1').some((task) => task.id === id)));
  check('Delete → All tasks from an upcoming occurrence deletes the whole series in Google, its open task and its completed ones, and no upcoming one is left', Boolean(seriesGone) && Boolean(historyGone), JSON.stringify({ deletes: requests('DELETE', /\/tasks\//).map((request) => request.path), upcoming: await f.locator('.grid-item.is-upcoming', { hasText: 'Harness standup' }).count() }));
  await todayButton.click();

  // ── 13. An edit Google refuses is all or nothing (review 4): a daily task at 1pm, All tasks to a new title at 4pm, refused with a 503 ──
  const atomicTitle = 'Harness atomic';
  const atomicNew = 'Harness atomic at four';
  await openTasks();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const atomicForm = myTasks.getByRole('group', { name: 'New task' });
  await atomicForm.getByRole('textbox', { name: 'Title' }).fill(atomicTitle);
  await atomicForm.getByLabel('Date', { exact: true }).fill(today);
  await atomicForm.getByRole('combobox', { name: 'Time' }).selectOption('780');
  await atomicForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
  await atomicForm.getByRole('button', { name: 'Add', exact: true }).click();
  const atomicId = await until(() => fake.tasks.get('L1').find((task) => task.title === atomicTitle)?.id);
  await until(() => keptOf(atomicId).then((kept) => Boolean(kept?.repeat?.template)));
  await atomicForm.getByRole('button', { name: 'Cancel' }).click();
  const atomicGoogle = () => fake.tasks.get('L1').find((task) => task.id === atomicId);
  const atomicPatches = () => requests('PATCH', `/tasks/v1/lists/L1/tasks/${atomicId}`);
  const atomicEditor = myTasks.getByRole('group', { name: `Edit ${atomicTitle}` });
  /** Edit it as the review did: a new title and 4pm, Done, All tasks; the fake answers 503 when asked to. */
  const editAtomic = async (refuse) => {
    await myTasks.getByRole('button', { name: `Edit ${atomicTitle}` }).click();
    await atomicEditor.getByRole('textbox', { name: 'Title' }).fill(atomicNew);
    await atomicEditor.getByRole('combobox', { name: 'Time' }).selectOption('960');
    if (refuse) fake.failNext('PATCH', `/tasks/${atomicId}`, 503, 'Backend Error');
    await atomicEditor.getByRole('button', { name: 'Done' }).click();
    await repeatQuestion.getByRole('radio', { name: 'All tasks' }).check();
    await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  };
  const refusedFrom = atomicPatches().length;
  await editAtomic(true);
  const refusedSaid = await atomicEditor.getByRole('alert').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const refusedText = refusedSaid ? await atomicEditor.getByRole('alert').innerText() : '';
  const editKept = refusedSaid && (await atomicEditor.getByRole('textbox', { name: 'Title' }).inputValue()) === atomicNew && (await atomicEditor.getByRole('combobox', { name: 'Time' }).inputValue()) === '960';
  await page.waitForTimeout(800);
  const keptRefused = await keptOf(atomicId);
  check(
    'an edit Google refuses (503; All tasks: a new title and 4pm) keeps its editor open with the error and the edit; Google, the kept 1pm and the series stay as they were',
    refusedSaid && refusedText.includes('Google Tasks did not take it') && editKept && atomicPatches().length === refusedFrom + 1 && atomicPatches().at(-1)?.body?.title === atomicNew && atomicGoogle()?.title === atomicTitle && keptRefused?.time === 780 && keptRefused?.repeat?.template?.title === atomicTitle && keptRefused.repeat.template.time === 780,
    JSON.stringify({ refusedSaid, refusedText, editKept, google: atomicGoogle()?.title, kept: keptRefused }),
  );
  await shot('cal-50-refused-edit-stays-open-1440');
  await reload();
  await openTasks();
  const atomicRow = myTasks.locator(`li.gt-row[data-task="${atomicId}"]`);
  await atomicRow.waitFor({ timeout: 15_000 });
  const atomicRowText = await atomicRow.innerText();
  const keptReloaded = await keptOf(atomicId);
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await goTo(tomorrow);
  const atomicUpcoming = upcomingOn(tomorrow, atomicTitle);
  const projected = await atomicUpcoming.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const projectedTop = projected ? (await atomicUpcoming.boundingBox()).y - (await lane(tomorrow).boundingBox()).y : null;
  const rejectedShown = await f.locator('.grid-item, .all-day-bar', { hasText: atomicNew }).count();
  check(
    'after a reload, Google, the Tasks view, the upcoming occurrences and the kept time still have the old title at 1pm',
    atomicGoogle()?.title === atomicTitle && atomicRowText.includes(atomicTitle) && atomicRowText.includes('Today, 1pm') && keptReloaded?.time === 780 && keptReloaded?.repeat?.template?.title === atomicTitle && keptReloaded.repeat.template.time === 780 && projected && Math.abs(projectedTop - 780 * 0.8) <= 2 && rejectedShown === 0,
    JSON.stringify({ google: atomicGoogle()?.title, row: atomicRowText, kept: keptReloaded, projectedTop, rejectedShown }),
  );
  await shot('cal-51-refused-after-reload-1440');
  await todayButton.click();
  // Refused again, then Save again in the same editor once the fake answers: applied once.
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await editAtomic(true);
  const refusedAgain = await atomicEditor.getByRole('alert').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const retryFrom = atomicPatches().length;
  await atomicEditor.getByRole('button', { name: 'Done' }).click();
  await repeatQuestion.getByRole('radio', { name: 'All tasks' }).check();
  await repeatQuestion.getByRole('button', { name: 'OK' }).click();
  const applied = await until(async () => atomicGoogle()?.title === atomicNew && (await keptOf(atomicId))?.time === 960, 15_000);
  const editorClosed = await until(async () => (await myTasks.getByRole('group', { name: /^Edit Harness atomic/ }).count()) === 0);
  await page.waitForTimeout(1000);
  const keptApplied = await keptOf(atomicId);
  check(
    'Save again, once Google takes it: the edit applies once (one more write; the series has the new title and 4pm, its schedule where it was) and the editor closes',
    refusedAgain && applied && editorClosed && atomicPatches().length === retryFrom + 1 && keptApplied?.repeat?.template?.title === atomicNew && keptApplied.repeat.template.time === 960 && keptApplied.repeat.template.start === today && keptApplied.repeat.on === today && keptApplied.repeat.index === 1,
    JSON.stringify({ refusedAgain, applied, editorClosed, writes: atomicPatches().slice(retryFrom).map((request) => request.body), kept: keptApplied }),
  );
  await shot('cal-52-saved-again-1440');
  const atomicPosts = () => requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => [atomicTitle, atomicNew].includes(request.body?.title));
  const postsBeforeDone = atomicPosts().length;
  await myTasks.getByRole('checkbox', { name: `Mark ${atomicNew} complete` }).click();
  const nextAtomic = await until(() => fake.tasks.get('L1').find((task) => task.title === atomicNew && task.status !== 'completed' && task.id !== atomicId), 15_000);
  const nextAtomicKept = nextAtomic ? await until(() => keptOf(nextAtomic.id).then((kept) => (kept?.repeat ? kept : null))) : null;
  await page.waitForTimeout(1000);
  check(
    'completing it then makes the next one once, with the new values: its new title in Google tomorrow, 4pm in the Planner',
    nextAtomic?.due === due(tomorrow) && nextAtomicKept?.time === 960 && nextAtomicKept.repeat?.index === 2 && atomicPosts().length === postsBeforeDone + 1 && atomicPosts().at(-1)?.body?.title === atomicNew,
    JSON.stringify({ nextAtomic, nextAtomicKept, posts: atomicPosts().map((request) => request.body) }),
  );
  // Out of the way of the layout checks below (their events at 4pm): the series goes, in Google and in the Planner.
  const atomicIds = [atomicId, nextAtomic?.id].filter(Boolean);
  // In the Planner first: a list read in between would take the series' open task gone from Google as deleted there.
  await h.call('POST', '/commands', { commands: atomicIds.map((id, index) => ({ cmd: `harness-atomic-gone-${index}`, type: 'gtask.dropped', account: ME, taskId: id })) });
  for (const id of atomicIds) await fetch(`${fake.base}tasks/v1/lists/L1/tasks/${id}`, { method: 'DELETE' });
  // A new task Google refuses: its form keeps what was typed and says why; Add again adds it once.
  const refusedNew = 'Harness refused at first';
  const countNew = () => fake.tasks.get('L1').filter((task) => task.title === refusedNew).length;
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const newForm = myTasks.getByRole('group', { name: 'New task' });
  await newForm.getByRole('textbox', { name: 'Title' }).fill(refusedNew);
  await newForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('600');
  fake.failNext('POST', '/tasks/v1/lists/L1/tasks', 503, 'Backend Error');
  await newForm.getByRole('button', { name: 'Add', exact: true }).click();
  const newRefused = await newForm.getByRole('alert').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const newTyped = newRefused && (await newForm.getByRole('textbox', { name: 'Title' }).inputValue()) === refusedNew && (await newForm.getByRole('combobox', { name: 'Time', exact: true }).inputValue()) === '600';
  const newNone = countNew() === 0;
  await shot('cal-52b-new-task-refused-1440');
  await newForm.getByRole('button', { name: 'Add', exact: true }).click();
  const newAdded = await until(async () => countNew() === 1 && (await newForm.getByRole('textbox', { name: 'Title' }).inputValue()) === '');
  const newId = fake.tasks.get('L1').find((task) => task.title === refusedNew)?.id;
  const newKept = newId ? await until(() => keptOf(newId).then((kept) => (kept?.time === 600 ? kept : null))) : null;
  await newForm.getByRole('button', { name: 'Cancel' }).click();
  check(
    "a new task Google refuses keeps its form open with the error and what was typed; Add again adds it once, its time kept, and the form empties for the next",
    newRefused && newTyped && newNone && newAdded && countNew() === 1 && Boolean(newKept),
    JSON.stringify({ newRefused, newTyped, newNone, newAdded, count: countNew(), newKept }),
  );
  if (newId) await fetch(`${fake.base}tasks/v1/lists/L1/tasks/${newId}`, { method: 'DELETE' });
  // The calendar's editor: a refusal leaves the dialog open with the error and the edit; nothing changes.
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await todayButton.click();
  const quickTitle = 'Harness quick task';
  await lane(dragDay).locator('.grid-item.is-task', { hasText: quickTitle }).click();
  await f.getByRole('dialog', { name: `Google task: ${quickTitle}` }).getByRole('button', { name: 'Edit task' }).click();
  const quickEditor = f.getByRole('dialog', { name: `Edit task: ${quickTitle}` });
  await quickEditor.getByRole('textbox', { name: 'Title' }).fill(`${quickTitle}, refused`);
  await quickEditor.getByRole('combobox', { name: 'Time', exact: true }).selectOption('660');
  fake.failNext('PATCH', `/tasks/${quickId}`, 503, 'Backend Error');
  await quickEditor.getByRole('button', { name: 'Done' }).click();
  const editorRefused = await quickEditor.getByRole('alert').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const editorTyped = editorRefused && (await quickEditor.getByRole('textbox', { name: 'Title' }).inputValue()) === `${quickTitle}, refused` && (await quickEditor.getByRole('combobox', { name: 'Time', exact: true }).inputValue()) === '660';
  await shot('cal-52c-calendar-editor-refused-1440');
  const quickNow = fake.tasks.get('L1').find((task) => task.id === quickId);
  check(
    "on the calendar, a task's editor Google refuses stays open with the error and the edit; Google and its kept 10am stay as they were",
    editorRefused && editorTyped && quickNow?.title === quickTitle && (await keptOf(quickId))?.time === 600,
    JSON.stringify({ editorRefused, editorTyped, google: quickNow?.title, kept: await keptOf(quickId) }),
  );
  await quickEditor.getByRole('button', { name: 'Close' }).click();

  // ── 14. Completing a task on the calendar of a freshly opened Planner (Tasks never opened) completes its subtasks; reopening one reopens it (review 4) ──
  /** A task made in Google (the fake's own API), under `parent` when given. */
  const madeInGoogle = async (title, parent = null, dueDate = null) => {
    const response = await fetch(`${fake.base}tasks/v1/lists/L1/tasks${parent ? `?parent=${parent}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, ...(dueDate ? { due: due(dueDate) } : {}) }) });
    return (await response.json()).id;
  };
  const statusOf = (id) => fake.tasks.get('L1').find((task) => task.id === id)?.status;
  /** Reads of a whole list (the Tasks view's, or a task's subtasks), not the calendar's reads of tasks due or by id. */
  const listReads = (from) => fake.requests.slice(from).filter((request) => request.method === 'GET' && request.path === '/tasks/v1/lists/L1/tasks' && request.query.showHidden === 'true' && !request.query.dueMin);
  const writesTo = (from, ids) => fake.requests.slice(from).filter((request) => request.method === 'PATCH' && ids.includes(request.path.split('/').at(-1))).map((request) => `${request.path.split('/').at(-1)}:${request.body?.status}`);
  /** The Planner's own menu, folded behind its button on a narrow page. */
  const navTo = async (name) => {
    const menu = f.getByRole('button', { name: 'Planner menu' });
    if (await menu.isVisible().catch(() => false)) await menu.click();
    await h.nav(name).click();
  };
  /** A freshly opened Planner, straight to Calendar (this week), every all-day item shown. */
  const freshCalendar = async () => {
    await reload();
    await navTo('Calendar');
    await f.locator('.day-lane').first().waitFor({ timeout: 15_000 });
    await todayButton.click();
    // This week read (its events and tasks come together), then every all-day item shown.
    await planning.waitFor({ timeout: 15_000 }).catch(() => {});
    const allDayToggle = f.getByRole('button', { name: 'Show all all-day events' });
    if (await allDayToggle.count()) await allDayToggle.click();
  };
  const coldParent = async (size, viewport) => {
    await page.setViewportSize(viewport);
    await todayButton.click();
    const thisWeek = await f.locator('.day-lane').evaluateAll((lanes) => lanes.map((element) => element.getAttribute('data-date')));
    const trip = await madeInGoogle(`Harness trip ${size}`, null, today);
    const hotel = await madeInGoogle(`Harness hotel ${size}`, trip, today);
    const bags = await madeInGoogle(`Harness bags ${size}`, trip);
    const ids = [trip, hotel, bags];
    // Made in Google: the service's copy of this week's tasks (kept a minute and a half) is read again.
    await h.call('GET', `/calendar?from=${thisWeek[0]}&to=${thisWeek.at(-1)}&refresh=1`);

    // From its details ("Mark completed").
    await freshCalendar();
    const tripChip = f.getByRole('button', { name: new RegExp(`^Google task Harness trip ${size}, due`) });
    await tripChip.waitFor({ timeout: 15_000 });
    let at = fake.requests.length;
    await tripChip.click();
    const tripPopover = f.getByRole('dialog', { name: `Google task: Harness trip ${size}` });
    await tripPopover.getByRole('button', { name: 'Mark completed' }).waitFor();
    await shot(`cal-53-cold-parent-details-${size}`);
    await tripPopover.getByRole('button', { name: 'Mark completed' }).click();
    const allDone = await until(() => ids.every((id) => statusOf(id) === 'completed'), 15_000);
    const order = writesTo(at, ids);
    check(
      `${size} px: in a freshly opened Planner, on Calendar (Tasks never opened), "Mark completed" on a task completes it and every subtask in Google (read from Google), the subtasks first`,
      allDone && listReads(at).length >= 1 && order.at(-1) === `${trip}:completed` && order.includes(`${hotel}:completed`) && order.includes(`${bags}:completed`),
      JSON.stringify({ status: ids.map(statusOf), order, reads: listReads(at).length }),
    );
    await shot(`cal-54-cold-parent-completed-${size}`);

    // Reopening a subtask from its details: the task it is under reopens first.
    await freshCalendar();
    const hotelChip = f.getByRole('button', { name: new RegExp(`^Google task Harness hotel ${size}, due .*completed`) });
    await hotelChip.waitFor({ timeout: 15_000 });
    at = fake.requests.length;
    await hotelChip.click();
    await f.getByRole('dialog', { name: `Google task: Harness hotel ${size}` }).getByRole('button', { name: 'Mark uncompleted' }).click();
    const reopened = await until(() => statusOf(hotel) === 'needsAction' && statusOf(trip) === 'needsAction', 15_000);
    const reopenOrder = writesTo(at, ids);
    check(
      `${size} px: reopening a subtask on the calendar of a freshly opened Planner reopens the task it is under in Google, first`,
      reopened && statusOf(bags) === 'completed' && reopenOrder[0] === `${trip}:needsAction` && reopenOrder.includes(`${hotel}:needsAction`),
      JSON.stringify({ status: ids.map(statusOf), reopenOrder }),
    );
    await shot(`cal-55-cold-subtask-reopened-${size}`);

    // A time kept in the Planner puts it on the grid with its check circle, which does the same.
    await h.call('POST', '/commands', { commands: [{ cmd: `harness-trip-time-${size}`, type: 'gtask.kept', account: ME, listId: 'L1', taskId: trip, patch: { time: 11 * 60 } }] });
    await freshCalendar();
    const tripCheck = lane(today).locator('.grid-item.is-task', { hasText: `Harness trip ${size}` }).getByRole('checkbox', { name: `Mark Harness trip ${size} complete` });
    await tripCheck.waitFor({ timeout: 15_000 });
    await shot(`cal-56-cold-parent-chip-${size}`);
    at = fake.requests.length;
    await tripCheck.click();
    const circleDone = await until(() => ids.every((id) => statusOf(id) === 'completed'), 15_000);
    const circleOrder = writesTo(at, ids);
    check(
      `${size} px: its calendar chip's check circle (a freshly opened Planner) completes the task and every open subtask in Google (read from Google), the subtasks first`,
      circleDone && listReads(at).length >= 1 && circleOrder.at(-1) === `${trip}:completed` && circleOrder.includes(`${hotel}:completed`),
      JSON.stringify({ status: ids.map(statusOf), circleOrder }),
    );
    await shot(`cal-57-cold-parent-chip-completed-${size}`);
    // Out of the way of what follows.
    await fetch(`${fake.base}tasks/v1/lists/L1/tasks/${trip}`, { method: 'DELETE' });
  };
  await coldParent(1440, { width: 1440, height: 900 });
  await coldParent(1024, { width: 1024, height: 768 });

  // ── 15. A timed task's deadline on its own day (review 4): its block at 1pm and its deadline in the all-day section, in Day and Week, at both sizes ──
  /** Back to 1440 px: the host leaves an extension's page when its window widens again, so the Planner is opened again. */
  const wideAgain = async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await reload();
  };
  await wideAgain();
  const sameTitle = 'Harness same-day deadline';
  await openTasks();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const sameForm = myTasks.getByRole('group', { name: 'New task' });
  await sameForm.getByRole('textbox', { name: 'Title' }).fill(sameTitle);
  await sameForm.getByLabel('Date', { exact: true }).fill(today);
  await sameForm.getByRole('combobox', { name: 'Time' }).selectOption('780');
  await sameForm.getByLabel('Deadline', { exact: true }).fill(today);
  await sameForm.getByRole('button', { name: 'Add', exact: true }).click();
  const sameId = await until(() => fake.tasks.get('L1').find((task) => task.title === sameTitle)?.id);
  await until(() => keptOf(sameId).then((kept) => kept?.time === 780 && kept.deadline === today));
  await sameForm.getByRole('button', { name: 'Cancel' }).click();
  await f.getByRole('radio', { name: 'Calendar' }).click();
  const sameBlock = (date) => lane(date).locator('.grid-item.is-task', { hasText: sameTitle });
  const sameEntry = f.locator('.all-day-bar.is-deadline', { hasText: sameTitle });
  /** On `date` in the view shown: its timed block, and its deadline entry over that day's all-day cell. */
  const sameOn = async (date) => {
    const allDayToggle = f.getByRole('button', { name: 'Show all all-day events' });
    if (await allDayToggle.count()) await allDayToggle.click();
    await page.waitForTimeout(300);
    const entries = await sameEntry.count();
    return { block: await sameBlock(date).count(), entries, entry: entries === 1 && (await over(sameEntry, f.locator(`.all-day-cell[data-date="${date}"]`))) };
  };
  /** Week, then Day, for `date`. */
  const weekAndDay = async (date, shotName) => {
    await todayButton.click();
    await pickView('Week');
    await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });
    if (!(await lane(date).count())) await f.getByRole('button', { name: 'Next week' }).click();
    await sameBlock(today).or(sameEntry).first().waitFor({ timeout: 15_000 }).catch(() => {});
    const week = await sameOn(date);
    await shot(`${shotName}-week`);
    await f.getByRole('button', { name: new RegExp(`^${longDay(date)}(, today)?: show this day$`) }).click();
    await lane(date).waitFor();
    await sameBlock(date).or(sameEntry).first().waitFor({ timeout: 15_000 }).catch(() => {});
    const day = await sameOn(date);
    await shot(`${shotName}-day`);
    await pickView('Week');
    return { week, day };
  };
  const both = (seen) => seen.block === 1 && seen.entry;
  const sameWide = await weekAndDay(today, 'cal-58-same-day-deadline-1440');
  await reload();
  await navTo('Calendar');
  const sameReloaded = await weekAndDay(today, 'cal-59-same-day-deadline-reloaded-1440');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(800);
  const sameNarrow = await weekAndDay(today, 'cal-60-same-day-deadline-1024');
  check(
    'a task at 1pm with its deadline the same day shows its timed block and its deadline in the all-day section, in Week and Day, at 1440 and 1024 px and after a reload',
    [sameWide, sameReloaded, sameNarrow].every((seen) => both(seen.week) && both(seen.day)),
    JSON.stringify({ sameWide, sameReloaded, sameNarrow }),
  );
  // The deadline moved to tomorrow: the entry follows it, the block stays at 1pm today; also after a reload, at both sizes.
  await wideAgain();
  await openTasks();
  await myTasks.getByRole('button', { name: `Edit ${sameTitle}` }).click();
  const sameEdit = myTasks.getByRole('group', { name: `Edit ${sameTitle}` });
  await sameEdit.getByLabel('Deadline', { exact: true }).fill(tomorrow);
  await sameEdit.getByRole('button', { name: 'Done' }).click();
  await until(() => keptOf(sameId).then((kept) => kept?.deadline === tomorrow));
  await f.getByRole('radio', { name: 'Calendar' }).click();
  const movedSeen = async (size) => {
    const onToday = await weekAndDay(today, `cal-61-deadline-moved-today-${size}`);
    const onTomorrow = await weekAndDay(tomorrow, `cal-62-deadline-moved-tomorrow-${size}`);
    // In Day: the block alone today, the deadline alone tomorrow.
    return { onToday, onTomorrow, ok: onToday.day.block === 1 && onToday.day.entries === 0 && onTomorrow.day.block === 0 && onTomorrow.day.entry && onTomorrow.week.entry };
  };
  const movedWide = await movedSeen(1440);
  await reload();
  await navTo('Calendar');
  const movedReloaded = await movedSeen('1440-reloaded');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(800);
  const movedNarrow = await movedSeen(1024);
  check(
    'moved to tomorrow, its deadline entry follows it while its block stays at 1pm today, after a reload too, at both sizes',
    movedWide.ok && movedReloaded.ok && movedNarrow.ok,
    JSON.stringify({ movedWide, movedReloaded, movedNarrow }),
  );
  await wideAgain();
  await h.nav('Calendar').click();
  await f.locator('.day-lane').nth(6).waitFor({ timeout: 15_000 });
  await todayButton.click();

  // ── 16. A series never takes an unrelated task with its title for its next occurrence; deleting a list takes its
  //    tasks' upcoming occurrences off the calendar at once (review 5) ──
  const twinTitle = 'Harness twin';
  await openTasks();
  await myTasks.getByRole('button', { name: 'Add a task' }).click();
  const twinForm = myTasks.getByRole('group', { name: 'New task' });
  await twinForm.getByRole('textbox', { name: 'Title' }).fill(twinTitle);
  await twinForm.getByRole('textbox', { name: 'Details' }).fill('daily series');
  await twinForm.getByLabel('Date', { exact: true }).fill(today);
  await twinForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('540');
  await twinForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
  await twinForm.getByRole('button', { name: 'Add', exact: true }).click();
  const twinSeries = await until(() => fake.tasks.get('L1').find((task) => task.title === twinTitle)?.id);
  await until(() => keptOf(twinSeries).then((kept) => Boolean(kept?.repeat?.template)));
  // The other one: the same title, tomorrow at 4pm, its own details, no repeat.
  await twinForm.getByRole('textbox', { name: 'Title' }).fill(twinTitle);
  await twinForm.getByRole('textbox', { name: 'Details' }).fill('independent appointment');
  await twinForm.getByLabel('Date', { exact: true }).fill(tomorrow);
  await twinForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('960');
  await twinForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Does not repeat' });
  await twinForm.getByRole('button', { name: 'Add', exact: true }).click();
  const twinOther = await until(() => fake.tasks.get('L1').find((task) => task.title === twinTitle && task.id !== twinSeries)?.id);
  await until(() => keptOf(twinOther).then((kept) => kept?.time === 960));
  await twinForm.getByRole('button', { name: 'Cancel' }).click();
  // Before it is completed, tomorrow shows the series' 9am occurrence (upcoming, once) beside the other task at 4pm,
  // in Week, Day and Month, after a reload too, at both sizes (review 6: a task with the series' title hid it).
  const twinUpcoming = f.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, upcoming ${longDay(tomorrow)} at 9am, repeats daily`) });
  const twinReal = f.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, due ${longDay(tomorrow)} at 9am.*, repeats$`) });
  const twinApart = f.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, due ${longDay(tomorrow)} at 4pm`) });
  const twinSeen = async () => {
    // The series' item (its projection, or the real one once made) and the other task, then how many of each.
    await twinUpcoming.or(twinReal).first().waitFor({ timeout: 10_000 }).catch(() => {});
    await twinApart.first().waitFor({ timeout: 10_000 }).catch(() => {});
    return { upcoming: await twinUpcoming.count(), real: await twinReal.count(), apart: await twinApart.count() };
  };
  /** Tomorrow in Week, Day and Month (a full month cell lists the rest under its "N more"). */
  const twinViews = async (size, shotName = 'cal-65-twin') => {
    await f.getByRole('radio', { name: 'Calendar' }).click();
    await todayButton.click();
    await pickView('Week');
    await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });
    if (!(await lane(tomorrow).count())) await f.getByRole('button', { name: 'Next week' }).click();
    const week = await twinSeen();
    await shot(`${shotName}-week-${size}`);
    await f.getByRole('button', { name: new RegExp(`^${longDay(tomorrow)}: show this day$`) }).click();
    await lane(tomorrow).waitFor();
    const day = await twinSeen();
    await shot(`${shotName}-day-${size}`);
    await pickView('Month');
    await f.locator(`.month-cell[data-date="${tomorrow}"]`).waitFor({ timeout: 10_000 });
    let month = await twinSeen();
    if (!month.upcoming || !month.apart) {
      const cell = await f.locator(`.month-cell[data-date="${tomorrow}"]`).boundingBox();
      for (const more of await f.locator('.month-more').all()) {
        const box = await more.boundingBox();
        if (!cell || !box || box.x + box.width / 2 < cell.x || box.x + box.width / 2 > cell.x + cell.width || box.y + box.height / 2 < cell.y || box.y + box.height / 2 > cell.y + cell.height) continue;
        await more.click();
        const list = f.getByRole('dialog', { name: `Everything on ${longDay(tomorrow)}` });
        await list.waitFor({ timeout: 5000 });
        month = { upcoming: await list.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, upcoming `) }).count(), real: await list.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, due .* at 9am`) }).count(), apart: await list.getByRole('button', { name: new RegExp(`^Google task ${twinTitle}, due .* at 4pm`) }).count(), more: true };
        await shot(`${shotName}-month-more-${size}`);
        await list.getByRole('button', { name: 'Close' }).click();
        break;
      }
    }
    await shot(`${shotName}-month-${size}`);
    await pickView('Week');
    return { week, day, month };
  };
  const twinWide = await twinViews(1440);
  await reload();
  await navTo('Calendar');
  const twinReloadedViews = await twinViews('1440-reloaded');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(800);
  const twinNarrow = await twinViews(1024);
  check(
    "before it is completed, tomorrow shows the daily series' 9am occurrence once, beside a separate task with its title at 4pm, in Week, Day and Month, after a reload, at 1440 and 1024 px",
    [twinWide, twinReloadedViews, twinNarrow].every((seen) => [seen.week, seen.day, seen.month].every((one) => one.upcoming === 1 && one.real === 0 && one.apart === 1)),
    JSON.stringify({ twinWide, twinReloadedViews, twinNarrow }),
  );
  await wideAgain();
  await openTasks();
  const twinPostsBefore = requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === twinTitle).length;
  await myTasks.locator('li.gt-row', { hasText: 'daily series' }).getByRole('checkbox').first().click();
  const twinNext = await until(() => fake.tasks.get('L1').find((task) => task.title === twinTitle && task.id !== twinSeries && task.id !== twinOther)?.id, 15_000);
  await page.waitForTimeout(1500);
  const twinAfter = { series: await keptOf(twinSeries), other: await keptOf(twinOther), next: twinNext ? await keptOf(twinNext) : null };
  await reload();
  const twinReloaded = await keptOf(twinOther);
  const otherGoogle = fake.tasks.get('L1').find((task) => task.id === twinOther);
  check(
    'completing a daily task makes its own next occurrence; a separate task with its title, due on the next date, keeps its 4pm, its details and no repeat, after a reload too',
    Boolean(twinNext) && requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === twinTitle).length === twinPostsBefore + 1
      && twinAfter.series?.repeat?.next === twinNext && twinAfter.next?.time === 540 && twinAfter.next?.repeat?.seriesId === twinAfter.series?.repeat?.seriesId
      && twinAfter.other?.time === 960 && !twinAfter.other?.repeat && twinReloaded?.time === 960 && !twinReloaded?.repeat && otherGoogle?.notes === 'independent appointment',
    JSON.stringify({ twinNext, series: twinAfter.series?.repeat, other: twinAfter.other, next: twinAfter.next?.repeat }),
  );
  await shot('cal-63-twin-kept-apart');
  // Completed: tomorrow has the series' own new occurrence at 9am in place of its projection, and the other task at 4pm.
  await navTo('Calendar');
  const twinDone = await twinViews(1440, 'cal-63b-twin-completed');
  check(
    "once completed, tomorrow shows the series' new occurrence (no projection there any more) and the other task, each once",
    [twinDone.week, twinDone.day, twinDone.month].every((one) => one.upcoming === 0 && one.real === 1 && one.apart === 1),
    JSON.stringify(twinDone),
  );

  // A list holding a daily task: its upcoming occurrences show; deleted, they go without a reload.
  await openTasks();
  await f.getByRole('button', { name: 'Create new list' }).click();
  await f.getByRole('textbox', { name: 'New list name' }).fill('Harness plants');
  await f.getByRole('textbox', { name: 'New list name' }).press('Enter');
  const plants = f.getByRole('region', { name: 'Harness plants' });
  await plants.waitFor();
  const plantsId = await until(() => fake.lists.find((list) => list.title === 'Harness plants')?.id);
  await plants.getByRole('button', { name: 'Add a task' }).click();
  const plantForm = plants.getByRole('group', { name: 'New task' });
  await plantForm.getByRole('textbox', { name: 'Title' }).fill('Harness water plants');
  await plantForm.getByLabel('Date', { exact: true }).fill(today);
  await plantForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('480');
  await plantForm.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
  await plantForm.getByRole('button', { name: 'Add', exact: true }).click();
  const plantId = await until(() => (fake.tasks.get(plantsId) ?? []).find((task) => task.title === 'Harness water plants')?.id);
  await until(() => keptOf(plantId).then((kept) => Boolean(kept?.repeat?.template)));
  await plantForm.getByRole('button', { name: 'Cancel' }).click();
  const plantsUpcoming = () => f.locator('.grid-item.is-upcoming', { hasText: 'Harness water plants' }).count();
  await f.getByRole('radio', { name: 'Calendar' }).click();
  const before = await until(async () => (await plantsUpcoming()) || null, 15_000);
  await f.getByRole('radio', { name: 'Tasks' }).click();
  await plants.getByRole('button', { name: 'List options for Harness plants' }).click();
  await plants.getByRole('menuitem', { name: 'Delete list' }).click();
  await until(() => !fake.lists.some((list) => list.title === 'Harness plants'));
  await f.getByRole('radio', { name: 'Calendar' }).click();
  await page.waitForTimeout(1200);
  const afterDelete = await plantsUpcoming();
  const keptLeft = await keptOf(plantId);
  await shot('cal-64-list-deleted-no-occurrences');
  check(
    "deleting a list takes its daily task's upcoming occurrences off the calendar at once, and what was kept for it goes",
    (before ?? 0) > 0 && afterDelete === 0 && !keptLeft,
    JSON.stringify({ before, afterDelete, keptLeft: Boolean(keptLeft) }),
  );

  // ── 17. Review 7, at 1440 and 1024 px: deleting "This task" never loses its series when Google refuses its next one;
  //    one upcoming task is deleted or edited on its own (This task), as in Google Calendar, after a reload too and when
  //    the series makes it; All tasks and Delete all future tasks from an upcoming one still act on the series ──
  const deleteQuestion = f.getByRole('alertdialog', { name: 'Delete repeating task' });
  /** The calendar's Calendar or Tasks page, through the Planner's menu when the calendar is not open. */
  const toPage = async (name) => {
    const toggle = f.getByRole('radio', { name, exact: true });
    if (!(await toggle.isVisible().catch(() => false))) await navTo('Calendar');
    await toggle.click();
  };
  /** The week with `date` in it, unless it shows already. */
  const weekOf = async (date) => {
    await toPage('Calendar');
    if (await lane(date).count()) return;
    await todayButton.click();
    await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });
    for (let step = 0; step < 3 && !(await lane(date).count()); step++) await f.getByRole('button', { name: date > today ? 'Next week' : 'Previous week' }).click();
    await lane(date).waitFor({ timeout: 5000 });
  };
  const realOn = (date, title) => lane(date).locator('.grid-item.is-task:not(.is-upcoming)', { hasText: title });
  /** A real task's details, by its chip's key: a click on a narrow chip (beside another block) lands on its check circle. */
  const openReal = (date, title) => realOn(date, title).press('Enter');
  /** What `date` shows of a task titled `title`: upcoming items, real ones, and the minute the first upcoming one starts at. */
  const countsOn = async (date, title) => {
    await weekOf(date);
    const upcoming = upcomingOn(date, title);
    const count = await upcoming.count();
    const box = count ? await upcoming.first().boundingBox() : null;
    const top = (await lane(date).boundingBox())?.y ?? 0;
    return { upcoming: count, real: await realOn(date, title).count(), at: box ? Math.round((box.y - top) / 0.8) : null };
  };
  /** Ask again until `ok`, or for a while: the last answer. */
  const settle = async (probe, ok, timeout = 10_000) => {
    const end = Date.now() + timeout;
    let last = await probe();
    while (!ok(last) && Date.now() < end) {
      await sleep(250);
      last = await probe();
    }
    return last;
  };
  /** A daily task today at `time` (minutes), made in My Tasks; its id once Google has it and the Planner keeps its series. */
  const dailyTask = async (title, time) => {
    await toPage('Tasks');
    await myTasks.getByRole('button', { name: 'Add a task' }).click();
    const form = myTasks.getByRole('group', { name: 'New task' });
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('textbox', { name: 'Details' }).fill('Series notes');
    await form.getByLabel('Date', { exact: true }).fill(today);
    await form.getByRole('combobox', { name: 'Time', exact: true }).selectOption(String(time));
    await form.getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Daily' });
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const id = await until(() => fake.tasks.get('L1').find((task) => task.title === title)?.id);
    await until(() => keptOf(id).then((kept) => Boolean(kept?.repeat?.template)));
    await form.getByRole('button', { name: 'Cancel' }).click();
    return id;
  };
  /**
   * Out of the way of what follows: these tasks go, in the Planner and then in Google (a list read in between would
   * take a series' open task gone from Google as deleted there, and make its next one).
   */
  const removeTasks = async (ids, tag) => {
    await h.call('POST', '/commands', { commands: ids.map((id, index) => ({ cmd: `harness-${tag}-gone-${index}`, type: 'gtask.dropped', account: ME, taskId: id })) });
    for (const id of ids) await fetch(`${fake.base}tasks/v1/lists/L1/tasks/${id}`, { method: 'DELETE' });
  };
  const openOf = (title, except = []) => fake.tasks.get('L1').filter((task) => task.title === title && task.status !== 'completed' && !except.includes(task.id));
  const keptWith = (id) => until(() => keptOf(id).then((kept) => (kept?.repeat ? kept : null)));
  /**
   * Review 8: two windows (two tabs of one OpenChamber) on the same Tasks list complete the same occurrence at once,
   * their requests for its next one held until both are on their way, and Google slow to make it. One next task
   * between them, linked, in Google, in the plan and in both windows, after reloading both too; then both complete
   * that one at once with Google refusing the first try: again exactly one, and never a second head of the series.
   */
  const twoWindows = async (size) => {
    const d = (days) => addDays(today, days);
    const twin = `Harness twin ${size}`;
    const twinId = await dailyTask(twin, 540);
    const seriesId = (await keptWith(twinId)).repeat.seriesId;
    const other = await h.context.newPage();
    await other.setViewportSize(page.viewportSize());
    other.setDefaultTimeout(15_000);
    await other.addLocatorHandler(other.getByText('OpenCode update'), async () => {
      await other.locator('li.toast', { hasText: 'OpenCode update' }).getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2000 }).catch(() => {});
    });
    other.on('pageerror', (error) => plannerErrors.push(`second window pageerror: ${error.message}`));
    other.on('console', (message) => {
      if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(`second window: ${message.text().slice(0, 300)}`);
    });
    const g = other.frameLocator('.inset-0 > iframe[title="Planner"]');
    /** The second window on the Tasks view, opened as the harness opens the first. */
    const openOther = async () => {
      await other.goto(`${new URL(page.url()).origin}/`, { waitUntil: 'load' });
      const home = g.getByRole('heading', { name: 'Home' });
      if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
        const button = other.locator('button[aria-label="Planner"]:not([data-context-surface])').first();
        if (await button.isVisible().catch(() => false)) await button.click();
        else {
          await other.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
          await other.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
        }
        await home.waitFor({ timeout: 30_000 });
      }
      const menu = g.getByRole('button', { name: 'Planner menu' });
      if (await menu.isVisible().catch(() => false)) await menu.click();
      await g.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Calendar', exact: true }).click();
      await g.getByRole('radio', { name: 'Tasks', exact: true }).click();
      await g.getByRole('region', { name: 'My Tasks' }).locator('li.gt-row', { hasText: twin }).first().waitFor({ timeout: 15_000 });
    };
    // Each window's request for the next one is held until the other's is on its way too (or 8 s), then both go on.
    const matcher = (url) => new URL(url).pathname === '/api/guests/oc-forge-planner/service/request';
    let held = [];
    let asked = 0;
    let holding = false;
    let timer = null;
    const letGo = () => {
      holding = false;
      clearTimeout(timer);
      for (const route of held.splice(0)) route.fallback().catch(() => {});
    };
    const hold = (route) => {
      if (!holding || route.request().postDataJSON()?.path !== '/google/tasks/next') return route.fallback();
      asked += 1;
      held.push(route);
      if (held.length >= 2) letGo();
      else timer = setTimeout(letGo, 8000);
    };
    await page.route(matcher, hold);
    await other.route(matcher, hold);
    const rows = (frame) => frame.getByRole('region', { name: 'My Tasks' }).locator('ul[aria-label="My Tasks tasks"] > li.gt-row', { hasText: twin }).evaluateAll((items) => items.map((item) => item.getAttribute('data-task')));
    const box = (frame) => frame.getByRole('region', { name: 'My Tasks' }).getByRole('checkbox', { name: `Mark ${twin} complete`, exact: true });
    const posts = () => requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === twin).map((request) => request.body?.due);
    const plan = async () => {
      const series = Object.values((await state()).googleTasks ?? {}).filter((kept) => kept.repeat?.seriesId === seriesId);
      return { heads: series.filter((kept) => !kept.repeat.next).map((kept) => kept.taskId), indexes: series.map((kept) => kept.repeat.index).sort(), links: Object.fromEntries(series.map((kept) => [kept.taskId, kept.repeat.next])) };
    };
    /** Both windows complete the one open task at once; the task each window's list shows open afterwards. */
    const completeInBoth = async () => {
      held = [];
      asked = 0;
      holding = true;
      fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 1500);
      await Promise.all([box(f).click(), box(g).click()]);
      await until(() => asked >= 2 && !holding, 15_000);
      await until(() => openOf(twin).length >= 1, 20_000);
      // Time for a second next task, were one on its way.
      await page.waitForTimeout(2500);
      return { asked, open: openOf(twin).map((task) => ({ id: task.id, due: task.due })), windows: [await settle(() => rows(f), (ids) => ids.length === 1), await settle(() => rows(g), (ids) => ids.length === 1)] };
    };
    try {
      await toPage('Tasks');
      await openOther();
      const first = await completeInBoth();
      const second = first.open[0]?.id;
      const firstPlan = await plan();
      await h.shot(`cal-89-two-windows-first-${size}`);
      await other.screenshot({ path: `${out}/cal-89-two-windows-second-${size}.png` });
      const onlyOne = (seen, plan, id, date, made) => seen.asked === 2 && seen.open.length === 1 && seen.open[0].id === id && seen.open[0].due === due(date) && seen.windows.every((ids) => ids.length === 1 && ids[0] === id) && plan.heads.length === 1 && plan.heads[0] === id && posts().length === made;
      // Reloaded, both: the same one, nothing more.
      await reload();
      await toPage('Tasks');
      await openOther();
      const reloaded = { asked: 2, open: openOf(twin).map((task) => ({ id: task.id, due: task.due })), windows: [await settle(() => rows(f), (ids) => ids.length === 1), await settle(() => rows(g), (ids) => ids.length === 1)] };
      const reloadedPlan = await plan();
      check(
        `${size} px: two windows complete the same occurrence at once (their requests held until both are on their way, Google slow): Google gets one next task, tomorrow, linked to it, the only head of its series; both windows list that one, after reloading both too`,
        Boolean(second) && onlyOne(first, firstPlan, second, d(1), 2) && firstPlan.links[twinId] === second && firstPlan.indexes.join() === '1,2' && onlyOne(reloaded, reloadedPlan, second, d(1), 2) && reloadedPlan.links[twinId] === second,
        JSON.stringify({ first, firstPlan, reloaded, reloadedPlan, posts: posts() }),
      );
      // Again with that one, Google refusing the first try: the other window's makes it, once.
      fake.failNext('POST', '/tasks/v1/lists/L1/tasks', 503, 'Backend Error');
      const refusal = (frame) => frame.locator('.toast[role="alert"]', { hasText: `Google Tasks did not take the next "${twin}"` }).waitFor({ timeout: 20_000 });
      const saying = Promise.any([refusal(f), refusal(g)]).then(() => true, () => false);
      const retried = await completeInBoth();
      const third = retried.open[0]?.id;
      const said = await saying;
      await h.shot(`cal-90-two-windows-retried-first-${size}`);
      await other.screenshot({ path: `${out}/cal-90-two-windows-retried-second-${size}.png` });
      const retriedPlan = await plan();
      await reload();
      await toPage('Tasks');
      await openOther();
      const again = { asked: 2, open: openOf(twin).map((task) => ({ id: task.id, due: task.due })), windows: [await settle(() => rows(f), (ids) => ids.length === 1), await settle(() => rows(g), (ids) => ids.length === 1)] };
      const againPlan = await plan();
      check(
        `${size} px: after the reload, both complete the next one at once with Google refusing the first try: one window says so, the other's makes the one after it (the day after tomorrow), linked, once; reloaded again, no other task or head appears`,
        Boolean(third) && Boolean(said) && onlyOne(retried, retriedPlan, third, d(2), 4) && retriedPlan.links[second] === third && retriedPlan.indexes.join() === '1,2,3' && onlyOne(again, againPlan, third, d(2), 4) && posts().join('|') === [today, d(1), d(2), d(2)].map(due).join('|'),
        JSON.stringify({ retried, retriedPlan, said, again, againPlan, posts: posts() }),
      );
      await h.shot(`cal-91-two-windows-reloaded-${size}`);
      await removeTasks([twinId, second, third].filter(Boolean), `twin-${size}`);
    } finally {
      letGo();
      await page.unroute(matcher, hold).catch(() => {});
      await other.close().catch(() => {});
    }
  };
  /**
   * Review 9. P0: a second window saves an edit of tomorrow's task (Edit → This task, then Edit → All tasks: a new
   * title and 3pm) while the first completes today's and Google takes 9 s to make tomorrow's. The edit is kept and the
   * one next task carries it, in Google, in the plan and on both windows' calendars, after reloading both. P1: today's
   * moved alone to tomorrow at 1pm leaves tomorrow its own 9am task, in Week, Day and Month, after a reload too;
   * completing the one, then the other, leaves each as it is.
   */
  const review9 = async (size) => {
    const d = (days) => addDays(today, days);
    const posts = (title) => requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === title);
    /** The minute a real task's block starts at on `date` (Week). */
    const realAt = async (date, title) => {
      await weekOf(date);
      const box = await realOn(date, title).first().boundingBox().catch(() => null);
      const top = (await lane(date).boundingBox())?.y ?? 0;
      return box ? Math.round((box.y - top) / 0.8) : null;
    };
    /** `date` in Week, Day and Month: how many items of each label pattern show (a full month cell's "N more" list read). */
    const dayViews = async (date, patterns, ok, shotName) => {
      const count = async (within = f) => Object.fromEntries(await Promise.all(Object.entries(patterns).map(async ([key, pattern]) => [key, await within.getByRole('button', { name: pattern }).count()])));
      await toPage('Calendar');
      await pickView('Week');
      await weekOf(date);
      const week = await settle(() => count(), ok);
      await shot(`${shotName}-week-${size}`);
      await f.getByRole('button', { name: new RegExp(`^${longDay(date)}: show this day$`) }).click();
      await lane(date).waitFor();
      const day = await settle(() => count(), ok);
      await shot(`${shotName}-day-${size}`);
      await pickView('Month');
      await f.locator(`.month-cell[data-date="${date}"]`).waitFor({ timeout: 10_000 });
      let month = await settle(() => count(), ok, 4000);
      if (!ok(month)) {
        const cell = await f.locator(`.month-cell[data-date="${date}"]`).boundingBox();
        for (const more of await f.locator('.month-more').all()) {
          const box = await more.boundingBox();
          if (!cell || !box || box.x + box.width / 2 < cell.x || box.x + box.width / 2 > cell.x + cell.width || box.y + box.height / 2 < cell.y || box.y + box.height / 2 > cell.y + cell.height) continue;
          await more.click();
          const list = f.getByRole('dialog', { name: `Everything on ${longDay(date)}` });
          await list.waitFor({ timeout: 5000 });
          month = { ...(await count(list)), more: true };
          await shot(`${shotName}-month-more-${size}`);
          await list.getByRole('button', { name: 'Close' }).click();
          break;
        }
      }
      await shot(`${shotName}-month-${size}`);
      await pickView('Week');
      return { week, day, month };
    };
    const headsOf = async (seriesId) => Object.values((await state()).googleTasks ?? {}).filter((kept) => kept.repeat?.seriesId === seriesId && !kept.repeat.next).map((kept) => kept.taskId);

    // A second window (another tab of this OpenChamber) on the Planner's calendar.
    const other = await h.context.newPage();
    await other.setViewportSize(page.viewportSize());
    other.setDefaultTimeout(15_000);
    await other.addLocatorHandler(other.getByText('OpenCode update'), async () => {
      await other.locator('li.toast', { hasText: 'OpenCode update' }).getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2000 }).catch(() => {});
    });
    other.on('pageerror', (error) => plannerErrors.push(`second window pageerror: ${error.message}`));
    other.on('console', (message) => {
      if (message.type() === 'error' && /guest-files\/[^/]+\/panel\//.test(message.location().url ?? '')) plannerErrors.push(`second window: ${message.text().slice(0, 300)}`);
    });
    const g = other.frameLocator('.inset-0 > iframe[title="Planner"]');
    const gLane = (date) => g.locator(`.day-lane[data-date="${date}"]`);
    const gWeekOf = async (date) => {
      if (await gLane(date).count()) return;
      await g.getByRole('main').getByRole('button', { name: 'Today', exact: true }).click();
      for (let step = 0; step < 3 && !(await gLane(date).count()); step++) await g.getByRole('button', { name: date > today ? 'Next week' : 'Previous week' }).click();
      await gLane(date).waitFor({ timeout: 5000 });
    };
    /** How many items titled `title` the second window shows on `date` (`selector`: real or upcoming ones). */
    const gCount = async (date, selector, title) => {
      await gWeekOf(date);
      return gLane(date).locator(selector, { hasText: title }).count();
    };
    /** The second window opened (or reloaded) as the harness opens the first, on the week with tomorrow in it. */
    const openOther = async () => {
      await other.goto(`${new URL(page.url()).origin}/`, { waitUntil: 'load' });
      const home = g.getByRole('heading', { name: 'Home' });
      if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
        const button = other.locator('button[aria-label="Planner"]:not([data-context-surface])').first();
        if (await button.isVisible().catch(() => false)) await button.click();
        else {
          await other.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
          await other.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
        }
        await home.waitFor({ timeout: 30_000 });
      }
      const menu = g.getByRole('button', { name: 'Planner menu' });
      if (await menu.isVisible().catch(() => false)) await menu.click();
      await g.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Calendar', exact: true }).click();
      await g.getByRole('radio', { name: 'Calendar', exact: true }).click();
      await g.getByRole('button', { name: /^View:/ }).click();
      await g.getByRole('menuitemradio', { name: /^Week/ }).click();
      await gWeekOf(d(1));
    };
    const gQuestion = g.getByRole('alertdialog', { name: 'Edit repeating task' });
    /** In the second window: tomorrow's upcoming task's editor (This task or All tasks), a new title and 3pm typed, not saved. */
    const editInOther = async (title, scope, newTitle) => {
      const upcoming = gLane(d(1)).locator('.grid-item.is-upcoming', { hasText: title }).first();
      await upcoming.waitFor({ timeout: 15_000 });
      await upcoming.click();
      await g.getByRole('dialog', { name: `Repeating Google task: ${title}` }).getByRole('button', { name: 'Edit task' }).click();
      await gQuestion.getByRole('radio', { name: scope }).check();
      await gQuestion.getByRole('button', { name: 'OK' }).click();
      const editor = g.getByRole('dialog', { name: `${scope === 'This task' ? 'Edit task' : 'Edit all tasks'}: ${title}` });
      const form = editor.getByRole('group', { name: `Edit ${title}` });
      await form.getByRole('textbox', { name: 'Title' }).fill(newTitle);
      await form.getByRole('combobox', { name: 'Time', exact: true }).selectOption('900');
      return { editor, form };
    };
    /** In the first window: today's completed from its details, Google taking 9 s to make the next; true once that insert is on its way. */
    const completeSlowly = async (title) => {
      const before = posts(title).length;
      fake.delayNext('POST', '/tasks/v1/lists/L1/tasks', 9000);
      await weekOf(today);
      await openReal(today, title);
      await f.getByRole('dialog', { name: `Google task: ${title}` }).getByRole('button', { name: 'Mark completed' }).click();
      return Boolean(await until(() => posts(title).length > before, 10_000));
    };
    /** The second window's Done during that insert: whether its editor closed (the edit kept), after how long, and what it said if not. */
    const saveDuring = async ({ editor, form }) => {
      const at = Date.now();
      await form.getByRole('button', { name: 'Done' }).click();
      const closed = await editor.waitFor({ state: 'detached', timeout: 25_000 }).then(() => true).catch(() => false);
      return { closed, ms: Date.now() - at, said: closed ? [] : await editor.locator('[role="alert"]').allInnerTexts().catch(() => []) };
    };
    const shotBoth = async (name) => {
      await weekOf(d(1));
      await h.shot(`${name}-first-${size}`);
      await gWeekOf(d(1));
      await other.screenshot({ path: `${out}/${name}-second-${size}.png` });
    };
    const made = [];
    try {
      // P0, This task: tomorrow's task gets a title and 3pm of its own in the second window while the first completes today's.
      const race = `Harness race ${size}`;
      const pair = `Harness pair ${size}`;
      const raceId = await dailyTask(race, 660);
      made.push(raceId);
      const raceSeries = (await keptWith(raceId)).repeat.seriesId;
      await openOther();
      const thisEdit = await editInOther(race, 'This task', pair);
      await other.screenshot({ path: `${out}/cal-92-race-this-editor-second-${size}.png` });
      const thisInFlight = await completeSlowly(race);
      const thisSaved = await saveDuring(thisEdit);
      const next = await until(() => openOf(pair)[0], 15_000);
      if (next) made.push(next.id);
      const nextKept = next ? await until(() => keptOf(next.id).then((kept) => (kept?.time === 900 ? kept : null)), 10_000) : null;
      const raceFirst = await keptOf(raceId);
      const raceHeads = await headsOf(raceSeries);
      /** Tomorrow: the edited task at 3pm in both windows, no 11am one beside it; the day after: the series' 11am. */
      const thisShown = async () => {
        // Each window looked at in turn, as a person would (one in the background follows the plan once in front).
        await page.bringToFront();
        const first = { edited: await settle(() => countsOn(d(1), pair), (seen) => seen.real === 1), at: await settle(() => realAt(d(1), pair), (at) => at === 900), series: await countsOn(d(1), race), dayAfter: await settle(() => countsOn(d(2), race), (seen) => seen.upcoming === 1) };
        await other.bringToFront();
        const second = await settle(async () => ({ edited: await gCount(d(1), '.grid-item.is-task:not(.is-upcoming)', pair), series: await gCount(d(1), '.grid-item', race), dayAfter: await gCount(d(2), '.grid-item.is-upcoming', race) }), (seen) => seen.edited === 1 && seen.series === 0 && seen.dayAfter === 1);
        await page.bringToFront();
        return { first, second };
      };
      const thisOk = (seen) => seen.first.edited.real === 1 && seen.first.edited.upcoming === 0 && seen.first.at === 900 && seen.first.series.upcoming + seen.first.series.real === 0 && seen.first.dayAfter.upcoming === 1 && seen.first.dayAfter.at === 660
        && seen.second.edited === 1 && seen.second.series === 0 && seen.second.dayAfter === 1;
      const thisNow = await thisShown();
      await shotBoth('cal-93-race-this');
      await reload();
      await openOther();
      const thisReloaded = await thisShown();
      await shotBoth('cal-94-race-this-reloaded');
      check(
        `${size} px: a second window saves tomorrow's task (Edit → This task: a new title and 3pm) while the first completes today's and Google takes 9 s to make tomorrow's: the edit is kept and the one next task carries it (its title in Google, 3pm in the plan), linked, the series' only open task; tomorrow shows it at 3pm in both windows and no 11am task beside it, the day after the series' 11am, after reloading both`,
        thisInFlight && thisSaved.closed && Boolean(next) && next.due === due(d(1)) && openOf(pair).length === 1 && openOf(race).length === 0 && posts(race).length === 2 && posts(pair).length === 0
          && nextKept?.repeat?.on === d(1) && nextKept.repeat.index === 2 && nextKept.repeat.template?.title === race && nextKept.repeat.template.time === 660 && raceFirst?.repeat?.next === next.id && raceHeads.join() === next.id && thisOk(thisNow) && thisOk(thisReloaded),
        JSON.stringify({ thisInFlight, thisSaved, next, nextKept, link: raceFirst?.repeat?.next, raceHeads, thisNow, thisReloaded, posts: posts(race).map((request) => request.body?.due) }),
      );

      // P0, All tasks: the series gets a new title and 3pm in the second window while the first completes today's.
      const series = `Harness series ${size}`;
      const renamed = `Harness renamed ${size}`;
      const seriesFirst = await dailyTask(series, 660);
      made.push(seriesFirst);
      const seriesKey = (await keptWith(seriesFirst)).repeat.seriesId;
      await openOther();
      const allEdit = await editInOther(series, 'All tasks', renamed);
      await other.screenshot({ path: `${out}/cal-95-race-all-editor-second-${size}.png` });
      const allInFlight = await completeSlowly(series);
      const allSaved = await saveDuring(allEdit);
      const successor = await until(() => openOf(renamed)[0], 15_000);
      if (successor) made.push(successor.id);
      const successorKept = successor ? await until(() => keptOf(successor.id).then((kept) => (kept?.repeat?.template?.title === renamed ? kept : null)), 10_000) : null;
      const seriesLink = (await keptOf(seriesFirst))?.repeat?.next;
      const seriesHeads = await headsOf(seriesKey);
      // Inserts so far: today's, and tomorrow's made once (with the title it had then, renamed after).
      const allPosts = { series: posts(series).map((request) => request.body?.due), renamed: posts(renamed).length };
      /** Tomorrow: the next task, renamed, at 3pm; the day after: the series' upcoming one, renamed, at 3pm; the old title nowhere. */
      const allShown = async () => {
        await page.bringToFront();
        const first = { tomorrow: await settle(() => countsOn(d(1), renamed), (seen) => seen.real === 1), at: await settle(() => realAt(d(1), renamed), (at) => at === 900), dayAfter: await settle(() => countsOn(d(2), renamed), (seen) => seen.upcoming === 1 && seen.at === 900), old: (await countsOn(d(1), series)).upcoming + (await countsOn(d(2), series)).upcoming };
        await other.bringToFront();
        const second = await settle(async () => ({ tomorrow: await gCount(d(1), '.grid-item.is-task:not(.is-upcoming)', renamed), dayAfter: await gCount(d(2), '.grid-item.is-upcoming', renamed), old: (await gCount(d(1), '.grid-item', series)) + (await gCount(d(2), '.grid-item', series)) }), (seen) => seen.tomorrow === 1 && seen.dayAfter === 1 && seen.old === 0);
        await page.bringToFront();
        return { first, second };
      };
      const allOk = (seen) => seen.first.tomorrow.real === 1 && seen.first.at === 900 && seen.first.dayAfter.upcoming === 1 && seen.first.dayAfter.at === 900 && seen.first.old === 0 && seen.second.tomorrow === 1 && seen.second.dayAfter === 1 && seen.second.old === 0;
      const allNow = await allShown();
      await shotBoth('cal-96-race-all');
      await reload();
      await openOther();
      const allReloaded = await allShown();
      await shotBoth('cal-97-race-all-reloaded');
      // The one after it, made from the series as edited.
      await toPage('Tasks');
      await myTasks.getByRole('checkbox', { name: `Mark ${renamed} complete`, exact: true }).click();
      const after = await until(() => openOf(renamed, [successor?.id])[0], 15_000);
      if (after) made.push(after.id);
      const afterKept = after ? await keptWith(after.id) : null;
      check(
        `${size} px: a second window saves Edit → All tasks (a new title and 3pm) from tomorrow's task while the first completes today's and Google takes 9 s to make tomorrow's: the one next task takes the new title (in Google) and 3pm, the series keeps them, linked, after reloading both; both windows show it tomorrow at 3pm and the day after's upcoming one with them; the task after it is made with them too`,
        allInFlight && allSaved.closed && Boolean(successor) && successor.due === due(d(1)) && openOf(series).length === 0 && allPosts.series.join('|') === [due(today), due(d(1))].join('|') && allPosts.renamed === 0
          && successorKept?.time === 900 && successorKept.repeat?.on === d(1) && successorKept.repeat.template?.time === 900 && seriesLink === successor.id && seriesHeads.join() === successor.id && allOk(allNow) && allOk(allReloaded)
          && after?.due === due(d(2)) && afterKept?.time === 900 && afterKept.repeat?.template?.title === renamed && posts(renamed).length === 1,
        JSON.stringify({ allInFlight, allSaved, allPosts, after: after && { id: after.id, title: after.title, due: after.due }, afterKept: afterKept && { time: afterKept.time, template: afterKept.repeat?.template }, successor: successor && { id: successor.id, due: successor.due }, successorKept: successorKept && { time: successorKept.time, repeat: successorKept.repeat }, seriesLink, seriesHeads, allNow, allReloaded }),
      );
    } finally {
      await other.close().catch(() => {});
    }

    // P1: today's daily 9am task moved alone (Edit → This task) to tomorrow at 1pm.
    const moved = `Harness moved ${size}`;
    const label = (date, rest) => new RegExp(`^Google task ${moved}, ${rest.replace('DAY', longDay(date))}$`);
    const movedId = await dailyTask(moved, 540);
    made.push(movedId);
    await weekOf(today);
    await openReal(today, moved);
    await f.getByRole('dialog', { name: `Google task: ${moved}` }).getByRole('button', { name: 'Edit task' }).click();
    const movedForm = f.getByRole('dialog', { name: `Edit task: ${moved}` }).getByRole('group', { name: `Edit ${moved}` });
    await movedForm.getByLabel('Date', { exact: true }).fill(d(1));
    await movedForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('780');
    await movedForm.getByRole('button', { name: 'Done' }).click();
    await repeatQuestion.getByRole('radio', { name: 'This task' }).check();
    await repeatQuestion.getByRole('button', { name: 'OK' }).click();
    const movedKept = await until(async () => {
      const kept = await keptOf(movedId);
      return fake.tasks.get('L1').find((task) => task.id === movedId)?.due === due(d(1)) && kept?.time === 780 ? kept : null;
    });
    const beside = { own: label(d(1), 'upcoming DAY at 9am, repeats daily'), moved: label(d(1), 'due DAY at 1pm, repeats') };
    const both = (seen) => seen.own === 1 && seen.moved === 1;
    const besideSeen = async (shotName) => ({ ...(await dayViews(d(1), beside, both, shotName)), today: await countsOn(today, moved), dayAfter: await settle(() => countsOn(d(2), moved), (seen) => seen.upcoming === 1) });
    const besideOk = (seen) => [seen.week, seen.day, seen.month].every(both) && seen.today.upcoming + seen.today.real === 0 && seen.dayAfter.upcoming === 1 && seen.dayAfter.at === 540;
    /** Tomorrow's two tasks of the moved series once both are completed, and any upcoming one, in Week. */
    const bothDone = async (date) => {
      await weekOf(date);
      const count = (pattern) => f.getByRole('button', { name: pattern }).count();
      return { moved: await count(label(date, 'due DAY at 1pm, completed, repeats')), own: await count(label(date, 'due DAY at 9am, completed, repeats')), upcoming: await count(label(date, 'upcoming DAY at 9am, repeats daily')) };
    };
    const movedNow = await besideSeen('cal-98-moved-beside');
    await reload();
    const movedReloaded = await besideSeen('cal-100-moved-beside-reloaded');
    check(
      `${size} px: today's daily 9am task moved alone (This task) to tomorrow at 1pm: the series still puts it on today; tomorrow shows it and tomorrow's own 9am task, each once, in Week, Day and Month, after a reload too; today shows no task of the series, the day after its 9am one`,
      Boolean(movedKept) && movedKept.repeat?.on === today && movedKept.repeat.template?.time === 540 && besideOk(movedNow) && besideOk(movedReloaded),
      JSON.stringify({ movedKept: movedKept && { time: movedKept.time, repeat: movedKept.repeat }, movedNow, movedReloaded }),
    );
    // The moved one completed: tomorrow's own is made at 9am, beside it.
    await weekOf(d(1));
    await openReal(d(1), moved);
    await f.getByRole('dialog', { name: `Google task: ${moved}` }).getByRole('button', { name: 'Mark completed' }).click();
    const own = await until(() => openOf(moved, [movedId])[0], 15_000);
    if (own) made.push(own.id);
    const ownKept = own ? await keptWith(own.id) : null;
    const madeBeside = { own: label(d(1), 'due DAY at 9am, repeats'), moved: label(d(1), 'due DAY at 1pm, completed, repeats'), upcoming: label(d(1), 'upcoming DAY at 9am, repeats daily') };
    const besideMade = (seen) => seen.own === 1 && seen.moved === 1 && seen.upcoming === 0;
    const ownSeen = await dayViews(d(1), madeBeside, besideMade, 'cal-101-moved-completed');
    const ownDayAfter = await settle(() => countsOn(d(2), moved), (seen) => seen.upcoming === 1);
    check(
      `${size} px: the moved task completed (tomorrow, 1pm): tomorrow's own task is made once, at 9am, beside it, in Week, Day and Month; the moved one keeps its date and 1pm; the day after still shows its 9am one`,
      own?.due === due(d(1)) && ownKept?.time === 540 && ownKept.repeat?.on === d(1) && ownKept.repeat.index === 2 && posts(moved).length === 2 && [ownSeen.week, ownSeen.day, ownSeen.month].every(besideMade)
        && ownDayAfter.upcoming === 1 && ownDayAfter.at === 540 && (await keptOf(movedId))?.time === 780 && fake.tasks.get('L1').find((task) => task.id === movedId)?.due === due(d(1)),
      JSON.stringify({ own, ownKept: ownKept && { time: ownKept.time, repeat: ownKept.repeat }, ownSeen, ownDayAfter, posts: posts(moved).map((request) => request.body?.due) }),
    );
    // Then tomorrow's own completed: the day after's is made; the moved one stays as it is.
    await toPage('Tasks');
    await myTasks.getByRole('checkbox', { name: `Mark ${moved} complete`, exact: true }).click();
    const third = await until(() => openOf(moved, [movedId, own?.id])[0], 15_000);
    if (third) made.push(third.id);
    const thirdKept = third ? await keptWith(third.id) : null;
    await reload();
    const finalSeen = {
      tomorrow: await settle(() => bothDone(d(1)), (seen) => seen.moved === 1 && seen.own === 1 && seen.upcoming === 0),
      dayAfter: await settle(() => countsOn(d(2), moved), (seen) => seen.real === 1 && seen.upcoming === 0),
    };
    await weekOf(d(1));
    await shot(`cal-102-moved-own-completed-${size}`);
    const movedGoogle = fake.tasks.get('L1').find((task) => task.id === movedId);
    const movedHeads = await headsOf(movedKept?.repeat?.seriesId);
    check(
      `${size} px: then tomorrow's own completed: the day after's is made once, at 9am; the moved task stays completed tomorrow at 1pm, and tomorrow shows both, completed, after a reload`,
      third?.due === due(d(2)) && thirdKept?.time === 540 && thirdKept.repeat?.on === d(2) && movedGoogle?.status === 'completed' && movedGoogle.due === due(d(1)) && (await keptOf(movedId))?.time === 780 && posts(moved).length === 3 && movedHeads.join() === third.id
        && finalSeen.tomorrow.moved === 1 && finalSeen.tomorrow.own === 1 && finalSeen.dayAfter.real === 1,
      JSON.stringify({ third, thirdKept: thirdKept && { time: thirdKept.time, repeat: thirdKept.repeat }, movedGoogle, movedHeads, finalSeen, posts: posts(moved).map((request) => request.body?.due) }),
    );
    await removeTasks(made, `review9-${size}`);
  };
  const occurrences = async (size) => {
    const d = (days) => addDays(today, days);
    await toPage('Calendar');
    await pickView('Week');

    // 1. "This task" deleted while Google refuses its next one (503): nothing is deleted; deleting again makes exactly one.
    const once = `Harness once ${size}`;
    const onceId = await dailyTask(once, 660);
    const onceGoogle = () => fake.tasks.get('L1').find((task) => task.id === onceId);
    const seriesOf = async (title) => ({
      today: await settle(() => countsOn(today, title), (seen) => seen.real === 1),
      tomorrow: await settle(() => countsOn(d(1), title), (seen) => seen.upcoming === 1),
      dayAfter: await settle(() => countsOn(d(2), title), (seen) => seen.upcoming === 1),
    });
    const whole = (seen) => seen.today.real === 1 && seen.tomorrow.upcoming === 1 && seen.dayAfter.upcoming === 1 && seen.tomorrow.at === 660;
    const onceBefore = await seriesOf(once);
    await weekOf(today);
    await shot(`cal-70-delete-once-before-${size}`);
    const deleteThis = async (refuse) => {
      await weekOf(today);
      await openReal(today, once);
      const details = f.getByRole('dialog', { name: `Google task: ${once}` });
      await details.getByRole('button', { name: 'Delete task' }).click();
      await deleteQuestion.getByRole('radio', { name: 'This task' }).check();
      if (refuse) fake.failNext('POST', '/tasks/v1/lists/L1/tasks', 503, 'Backend Error');
      await deleteQuestion.getByRole('button', { name: 'OK' }).click();
      return details;
    };
    const refusedDetails = await deleteThis(true);
    const said = f.locator('.toast[role="alert"]', { hasText: `the next "${once}" couldn't be made, so this one stays` });
    const refusedSaid = await said.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    await shot(`cal-71-delete-once-refused-${size}`);
    await refusedDetails.getByRole('button', { name: 'Close' }).click().catch(() => {});
    const refusedState = async () => {
      const kept = await keptOf(onceId);
      await toPage('Tasks');
      const row = await myTasks.locator(`li.gt-row[data-task="${onceId}"]`).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
      return { google: onceGoogle()?.status ?? 'gone', deletes: requests('DELETE', `/tasks/v1/lists/L1/tasks/${onceId}`).length, kept: { on: kept?.repeat?.on, next: kept?.repeat?.next, template: kept?.repeat?.template?.title, time: kept?.time }, row, calendar: await seriesOf(once) };
    };
    const keptAsBefore = (seen) => seen.google === 'needsAction' && seen.deletes === 0 && seen.kept.on === today && seen.kept.next === null && seen.kept.template === once && seen.kept.time === 660 && seen.row && whole(seen.calendar);
    const refused = await refusedState();
    await weekOf(d(1));
    await shot(`cal-72-delete-once-refused-week-${size}`);
    await reload();
    const refusedReloaded = await refusedState();
    check(
      `${size} px: deleting "This task" while Google refuses its next task (503) deletes nothing and says so; the task stays in Google and the Tasks view with its series and upcoming tasks, after a reload too`,
      whole(onceBefore) && refusedSaid && keptAsBefore(refused) && keptAsBefore(refusedReloaded) && openOf(once).length === 1,
      JSON.stringify({ onceBefore, refusedSaid, refused, refusedReloaded, open: openOf(once).length }),
    );
    await weekOf(today);
    await shot(`cal-73-delete-once-refused-reloaded-${size}`);
    await deleteThis(false);
    const made = await until(() => (!onceGoogle() && openOf(once).length === 1 ? openOf(once)[0] : null), 15_000);
    const madeKept = made ? await keptWith(made.id) : null;
    const madePosts = requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === once);
    const retried = { tomorrow: await settle(() => countsOn(d(1), once), (seen) => seen.real === 1 && seen.upcoming === 0), dayAfter: await settle(() => countsOn(d(2), once), (seen) => seen.upcoming === 1) };
    check(
      `${size} px: with Google answering, Delete → This task again deletes it and makes exactly one next task, tomorrow, with the series' title, details and 11am`,
      Boolean(made) && made.due === due(d(1)) && made.notes === 'Series notes' && madeKept?.time === 660 && madeKept.repeat?.index === 2 && madeKept.repeat.on === d(1) && madeKept.repeat.template?.title === once
        && madePosts.length === 3 && fake.tasks.get('L1').filter((task) => task.title === once).length === 1 && !(await keptOf(onceId)) && retried.tomorrow.real === 1 && retried.tomorrow.upcoming === 0 && retried.dayAfter.upcoming === 1,
      JSON.stringify({ made, madeKept, posts: madePosts.map((request) => request.body?.due), retried }),
    );
    await weekOf(d(1));
    await shot(`cal-74-delete-once-retried-${size}`);
    if (made) await removeTasks([made.id], `once-${size}`);

    // 2. Before today's is completed: tomorrow's upcoming task deleted alone, another edited alone; then the series reaches them.
    const skip = `Harness skip ${size}`;
    const special = `Harness special ${size}`;
    const skipId = await dailyTask(skip, 660);
    const upcomingDetails = f.getByRole('dialog', { name: `Repeating Google task: ${skip}` });
    await settle(() => countsOn(d(1), skip), (seen) => seen.upcoming === 1);
    await upcomingOn(d(1), skip).click();
    await upcomingDetails.waitFor();
    const offered = await upcomingDetails.locator('.pop-tools button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    await shot(`cal-75-upcoming-details-${size}`);
    await upcomingDetails.getByRole('button', { name: 'Delete task' }).click();
    const deleteChoices = await deleteQuestion.locator('label').allInnerTexts();
    await shot(`cal-76-delete-this-question-${size}`);
    await deleteQuestion.getByRole('radio', { name: 'This task' }).check();
    await deleteQuestion.getByRole('button', { name: 'OK' }).click();
    const skipKept = await until(() => keptOf(skipId).then((kept) => (kept?.repeat?.exceptions?.[d(1)]?.skip ? kept : null)));
    const snack = await f.locator('.gcal-snack', { hasText: 'Task deleted' }).isVisible().catch(() => false);
    const skipped = { tomorrow: await settle(() => countsOn(d(1), skip), (seen) => seen.upcoming === 0 && seen.real === 0), dayAfter: await settle(() => countsOn(d(2), skip), (seen) => seen.upcoming === 1) };
    check(
      `${size} px: an upcoming task offers Edit and Delete; Delete asks This task, This and following tasks or All tasks, as Google Calendar does, and This task leaves tomorrow empty while the day after still shows its task; the series, its open task and Google stay as they were`,
      offered.includes('Edit task') && offered.includes('Delete task') && deleteChoices.map((text) => text.trim()).join('|') === 'This task|This and following tasks|All tasks' && snack && Boolean(skipKept) && skipKept.repeat.on === today && skipKept.repeat.template?.title === skip
        && skipped.tomorrow.upcoming === 0 && skipped.tomorrow.real === 0 && skipped.dayAfter.upcoming === 1 && openOf(skip).length === 1 && openOf(skip)[0].due === due(today),
      JSON.stringify({ offered, deleteChoices, snack, exceptions: skipKept?.repeat?.exceptions, skipped }),
    );
    await weekOf(d(1));
    await shot(`cal-77-tomorrow-deleted-${size}`);

    // Another one (in three days) edited alone: a title and 3pm of its own.
    await settle(() => countsOn(d(3), skip), (seen) => seen.upcoming === 1);
    await upcomingOn(d(3), skip).click();
    await upcomingDetails.getByRole('button', { name: 'Edit task' }).click();
    const editChoices = await repeatQuestion.locator('label').allInnerTexts();
    await repeatQuestion.getByRole('radio', { name: 'This task' }).check();
    await repeatQuestion.getByRole('button', { name: 'OK' }).click();
    const oneEditor = f.getByRole('dialog', { name: `Edit task: ${skip}` });
    const oneForm = oneEditor.getByRole('group', { name: `Edit ${skip}` });
    await oneForm.waitFor();
    const editorShows = {
      date: await oneForm.getByLabel('Date', { exact: true }).inputValue(),
      time: await oneForm.getByRole('combobox', { name: 'Time', exact: true }).inputValue(),
      repeatLocked: await oneForm.getByRole('combobox', { name: 'Repeat' }).isDisabled(),
      repeat: (await oneForm.getByRole('combobox', { name: 'Repeat' }).innerText()).trim(),
      star: await oneForm.getByRole('button', { name: 'Star' }).count(),
    };
    await oneForm.getByRole('textbox', { name: 'Title' }).fill(special);
    await oneForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('900');
    await shot(`cal-78-edit-this-editor-${size}`);
    await oneForm.getByRole('button', { name: 'Done' }).click();
    const askedAgain = await repeatQuestion.waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
    const editKept = await until(() => keptOf(skipId).then((kept) => (kept?.repeat?.exceptions?.[d(3)]?.title === special ? kept : null)));
    const editedOnly = async () => ({
      tomorrow: await settle(() => countsOn(d(1), skip), (seen) => seen.upcoming === 0 && seen.real === 0),
      dayAfter: await settle(() => countsOn(d(2), skip), (seen) => seen.upcoming === 1 && seen.at === 660),
      edited: await settle(() => countsOn(d(3), special), (seen) => seen.upcoming === 1 && seen.at === 900),
      label: await upcomingOn(d(3), special).first().getAttribute('aria-label').catch(() => null),
      editedAsSeries: await countsOn(d(3), skip),
      after: await settle(() => countsOn(d(4), skip), (seen) => seen.upcoming === 1 && seen.at === 660),
    });
    const onlyThat = (seen) => seen.tomorrow.upcoming === 0 && seen.tomorrow.real === 0 && seen.dayAfter.at === 660 && seen.edited.upcoming === 1 && seen.edited.at === 900 && (seen.label ?? '').includes(`upcoming ${longDay(d(3))} at 3pm, repeats daily, changed for this task`) && seen.editedAsSeries.upcoming === 0 && seen.after.upcoming === 1 && seen.after.at === 660;
    const edited = await editedOnly();
    await weekOf(d(3));
    await shot(`cal-79-edited-one-${size}`);
    await reload();
    const editedReloaded = await editedOnly();
    check(
      `${size} px: Edit asks This task or All tasks; This task opens the calendar's task editor on that day's task as it is (its date, 11am, the series' repeat locked, no star); its new title and 3pm show on that date only, after a reload too`,
      editChoices.map((text) => text.trim()).join('|') === 'This task|All tasks' && editorShows.date === d(3) && editorShows.time === '660' && editorShows.repeatLocked && editorShows.repeat === 'Daily' && editorShows.star === 0
        && !askedAgain && Boolean(editKept) && editKept.repeat.template?.title === skip && editKept.repeat.template.time === 660 && editKept.time === 660 && onlyThat(edited) && onlyThat(editedReloaded),
      JSON.stringify({ editChoices, editorShows, askedAgain, exceptions: editKept?.repeat?.exceptions, edited, editedReloaded }),
    );
    await weekOf(d(3));
    await shot(`cal-80-edited-one-reloaded-${size}`);

    // Today's completed: the next one is made the day after tomorrow (tomorrow was deleted), from the series.
    await settle(() => countsOn(today, skip), (seen) => seen.real === 1);
    await openReal(today, skip);
    await f.getByRole('dialog', { name: `Google task: ${skip}` }).getByRole('button', { name: 'Mark completed' }).click();
    const second = await until(() => openOf(skip, [skipId])[0], 15_000);
    const secondKept = second ? await keptWith(second.id) : null;
    const afterToday = { tomorrow: await settle(() => countsOn(d(1), skip), (seen) => seen.upcoming === 0 && seen.real === 0), dayAfter: await settle(() => countsOn(d(2), skip), (seen) => seen.real === 1 && seen.upcoming === 0) };
    check(
      `${size} px: completing today's task makes the next real one the day after tomorrow, not tomorrow, with the series' title, details and 11am; tomorrow still shows nothing`,
      second?.due === due(d(2)) && second.notes === 'Series notes' && secondKept?.time === 660 && secondKept.repeat?.on === d(2) && secondKept.repeat.index === 3 && !secondKept.repeat.exceptions?.[d(1)] && secondKept.repeat.exceptions?.[d(3)]?.title === special
        && afterToday.tomorrow.upcoming === 0 && afterToday.tomorrow.real === 0 && afterToday.dayAfter.real === 1,
      JSON.stringify({ second, secondKept, afterToday }),
    );
    await weekOf(d(2));
    await shot(`cal-81-next-past-deleted-${size}`);
    // The series reaches the edited date: its real task has the title and 3pm given to it; the one after it the series' own.
    await toPage('Tasks');
    await myTasks.getByRole('checkbox', { name: `Mark ${skip} complete`, exact: true }).click();
    const third = await until(() => openOf(special)[0], 15_000);
    const thirdKept = third ? await keptWith(third.id) : null;
    await toPage('Tasks');
    await myTasks.getByRole('checkbox', { name: `Mark ${special} complete`, exact: true }).click();
    const fourth = await until(() => openOf(skip, [skipId, second?.id])[0], 15_000);
    const fourthKept = fourth ? await keptWith(fourth.id) : null;
    const reached = { edited: await settle(() => countsOn(d(3), special), (seen) => seen.real === 1), after: await settle(() => countsOn(d(4), skip), (seen) => seen.real === 1 && seen.upcoming === 0) };
    check(
      `${size} px: when the series reaches the edited date, its real task there has the title and 3pm given to it; the next one has the series' title, details and 11am`,
      third?.due === due(d(3)) && thirdKept?.time === 900 && thirdKept.repeat?.on === d(3) && thirdKept.repeat.template?.title === skip
        && fourth?.due === due(d(4)) && fourth.notes === 'Series notes' && fourthKept?.time === 660 && fourthKept.repeat?.on === d(4) && fourthKept.repeat.template?.title === skip && !fourthKept.repeat.exceptions && reached.edited.real === 1 && reached.after.real === 1,
      JSON.stringify({ third, thirdKept, fourth, fourthKept, reached }),
    );
    await weekOf(d(4));
    await shot(`cal-82-edited-date-reached-${size}`);

    // 3. From an upcoming task, Edit → All tasks still changes the series, and Delete → All tasks deletes it whole.
    await settle(() => countsOn(d(5), skip), (seen) => seen.upcoming === 1);
    await upcomingOn(d(5), skip).click();
    await upcomingDetails.getByRole('button', { name: 'Edit task' }).click();
    await repeatQuestion.getByRole('radio', { name: 'All tasks' }).check();
    await repeatQuestion.getByRole('button', { name: 'OK' }).click();
    const allForm = f.getByRole('dialog', { name: `Edit all tasks: ${skip}` }).getByRole('group', { name: `Edit ${skip}` });
    await allForm.getByRole('combobox', { name: 'Time', exact: true }).selectOption('480');
    await allForm.getByRole('button', { name: 'Done' }).click();
    const allAsked = await repeatQuestion.waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
    const allKept = fourth ? await until(() => keptOf(fourth.id).then((kept) => (kept?.time === 480 && kept.repeat?.template?.time === 480 ? kept : null))) : null;
    const allSeen = await settle(() => countsOn(d(5), skip), (seen) => seen.upcoming === 1 && seen.at === 480);
    check(
      `${size} px: Edit → All tasks from an upcoming task still changes the series, asking nothing more: its open task and upcoming ones at 8am`,
      !allAsked && Boolean(allKept) && allSeen.at === 480,
      JSON.stringify({ allAsked, allKept, allSeen }),
    );
    await shot(`cal-83-all-tasks-${size}`);
    await upcomingOn(d(5), skip).click();
    await upcomingDetails.getByRole('button', { name: 'Delete task' }).click();
    await deleteQuestion.getByRole('radio', { name: 'All tasks' }).check();
    await deleteQuestion.getByRole('button', { name: 'OK' }).click();
    const done = [skipId, second?.id, third?.id].filter(Boolean);
    const ended = fourth ? await until(async () => requests('DELETE', `/tasks/v1/lists/L1/tasks/${fourth.id}`).length === 1 && !(await keptOf(fourth.id)), 15_000) : false;
    const historyGone = await until(() => done.every((id) => !fake.tasks.get('L1').some((task) => task.id === id)), 15_000);
    const endedSeen = await settle(async () => f.locator('.grid-item.is-upcoming', { hasText: skip }).count(), (count) => count === 0);
    const keptLeft = Object.values((await state()).googleTasks ?? {}).filter((kept) => kept.repeat?.template?.title === skip).length;
    check(
      `${size} px: Delete → All tasks from an upcoming task deletes the whole series: its open task and its completed ones in Google, nothing kept for it, no upcoming task left`,
      Boolean(ended) && Boolean(historyGone) && endedSeen === 0 && keptLeft === 0 && openOf(skip).length === 0,
      JSON.stringify({ ended, historyGone, endedSeen, keptLeft, open: openOf(skip).map((task) => task.id), left: fake.tasks.get('L1').filter((task) => done.includes(task.id)).map((task) => task.id) }),
    );
    await shot(`cal-84-series-ended-${size}`);
    await removeTasks(done, `skip-${size}`);

    // 4. This and following tasks (review 8): the series ends the day before the chosen upcoming task, two days ahead.
    const cut = `Harness cut ${size}`;
    const cutId = await dailyTask(cut, 600);
    const cutDetails = f.getByRole('dialog', { name: `Repeating Google task: ${cut}` });
    const cutBefore = await keptWith(cutId);
    await settle(() => countsOn(d(2), cut), (seen) => seen.upcoming === 1);
    await upcomingOn(d(2), cut).click();
    await cutDetails.getByRole('button', { name: 'Delete task' }).click();
    const cutChoices = await deleteQuestion.locator('label').allInnerTexts();
    await deleteQuestion.getByRole('radio', { name: 'This and following tasks' }).check();
    await shot(`cal-85-following-question-${size}`);
    await deleteQuestion.getByRole('button', { name: 'OK' }).click();
    const until1 = d(1).replace(/-/g, '');
    const cutKept = await until(() => keptOf(cutId).then((kept) => (kept?.repeat?.rule === `RRULE:FREQ=DAILY;UNTIL=${until1}` ? kept : null)), 15_000);
    /** Today's real task, tomorrow's upcoming one at 10am, nothing from the chosen day on. */
    const cutSeen = async () => ({
      today: await settle(() => countsOn(today, cut), (seen) => seen.real === 1),
      tomorrow: await settle(() => countsOn(d(1), cut), (seen) => seen.upcoming === 1 && seen.at === 600),
      chosen: await settle(() => countsOn(d(2), cut), (seen) => seen.upcoming === 0 && seen.real === 0),
      after: await settle(() => countsOn(d(3), cut), (seen) => seen.upcoming === 0 && seen.real === 0),
      later: await countsOn(d(6), cut),
    });
    const earlierKept = (seen) => seen.today.real === 1 && seen.tomorrow.upcoming === 1 && seen.tomorrow.at === 600 && seen.chosen.upcoming + seen.chosen.real === 0 && seen.after.upcoming + seen.after.real === 0 && seen.later.upcoming + seen.later.real === 0;
    const cutShown = await cutSeen();
    await weekOf(d(2));
    await shot(`cal-86-following-deleted-${size}`);
    const cutGoogle = () => fake.tasks.get('L1').find((task) => task.id === cutId);
    const asBefore = cutGoogle()?.status === 'needsAction' && cutGoogle()?.due === due(today) && requests('DELETE', `/tasks/v1/lists/L1/tasks/${cutId}`).length === 0;
    await reload();
    const cutReloaded = await cutSeen();
    check(
      `${size} px: Delete on the upcoming task two days ahead asks This task, This and following tasks or All tasks; This and following tasks keeps today's open task (Google unchanged, the series ending tomorrow: "until ${until1}") and tomorrow's upcoming one at 10am, and nothing shows from that day on, after a reload too`,
      cutChoices.map((text) => text.trim()).join('|') === 'This task|This and following tasks|All tasks' && asBefore && Boolean(cutKept) && cutKept.repeat.on === today && JSON.stringify(cutKept.repeat.template) === JSON.stringify(cutBefore.repeat.template) && cutKept.time === 600
        && earlierKept(cutShown) && earlierKept(cutReloaded),
      JSON.stringify({ cutChoices, asBefore, cutKept, cutShown, cutReloaded }),
    );
    await weekOf(today);
    await shot(`cal-87-following-reloaded-${size}`);
    // The earlier ones done: tomorrow's is made from the series, and nothing after it, the chosen day included.
    await openReal(today, cut);
    await f.getByRole('dialog', { name: `Google task: ${cut}` }).getByRole('button', { name: 'Mark completed' }).click();
    const cutNext = await until(() => openOf(cut, [cutId])[0], 15_000);
    const cutNextKept = cutNext ? await keptWith(cutNext.id) : null;
    await toPage('Tasks');
    await myTasks.getByRole('checkbox', { name: `Mark ${cut} complete`, exact: true }).click();
    await until(() => cutNext && fake.tasks.get('L1').find((task) => task.id === cutNext.id)?.status === 'completed', 15_000);
    await page.waitForTimeout(1500);
    const cutEnded = { open: openOf(cut).length, chosen: await settle(() => countsOn(d(2), cut), (seen) => seen.upcoming === 0 && seen.real === 0), posts: requests('POST', '/tasks/v1/lists/L1/tasks').filter((request) => request.body?.title === cut).map((request) => request.body?.due) };
    check(
      `${size} px: once today's and tomorrow's are completed, the series has made only tomorrow's (10am, from its template) and nothing from the chosen day on`,
      cutNext?.due === due(d(1)) && cutNextKept?.time === 600 && cutNextKept.repeat?.on === d(1) && cutEnded.open === 0 && cutEnded.chosen.upcoming === 0 && cutEnded.chosen.real === 0 && cutEnded.posts.join('|') === [due(today), due(d(1))].join('|'),
      JSON.stringify({ cutNext, cutNextKept, cutEnded }),
    );
    await weekOf(d(2));
    await shot(`cal-88-following-earlier-done-${size}`);
    await removeTasks([cutId, cutNext?.id].filter(Boolean), `cut-${size}`);

    // 5. Two windows complete the same occurrence at once (review 8): one next task between them, linked, after a reload too.
    await twoWindows(size);

    // 6. Review 9: tomorrow's task edited in a second window while the first completes today's (This task, All tasks);
    //    today's moved alone onto tomorrow, beside tomorrow's own.
    await review9(size);
  };
  await occurrences(1440);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(800);
  await occurrences(1024);
  await wideAgain();
  await navTo('Calendar');
  await f.locator('.day-lane').nth(6).waitFor({ timeout: 15_000 });
  await todayButton.click();

  // 7. (below, with the layout) Titles of two and three words read in full in blocks of an hour or more.
  primary().set('budget', { id: 'budget', summary: 'Budget review meeting', start: { dateTime: new Date(at(today, 16 * 60)).toISOString() }, end: { dateTime: new Date(at(today, 17 * 60)).toISOString() }, organizer: { email: ME, self: true } });
  // Made in Google, so the service's copy of this week (it keeps one for a minute and a half) is read again.
  const week = await f.locator('.day-lane').evaluateAll((lanes) => lanes.map((element) => element.getAttribute('data-date')));
  await h.call('GET', `/calendar?from=${week[0]}&to=${week.at(-1)}&refresh=1`);
  await reload();
  await h.nav('Calendar').click();
  await f.locator('.grid-item.is-event', { hasText: 'Budget review meeting' }).waitFor({ timeout: 15_000 });
  /** Each title of an hour or more shows whole: not cut by its block, no word broken across lines. */
  const titlesWhole = async () =>
    f.locator('.gcal-grid .grid-item.is-event').evaluateAll((items) =>
      items
        .filter((item) => item.getBoundingClientRect().height >= 44)
        .map((item) => {
          const title = item.querySelector('.item-title');
          const text = item.querySelector('.item-text');
          const words = [];
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.classList.contains('item-time')) continue;
            for (const match of node.data.matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              words.push(range.getClientRects().length);
            }
          }
          const whole = title.scrollHeight <= title.clientHeight + 1 && words.every((count) => count === 1);
          return { title: title.textContent.trim(), whole, width: Math.round(item.getBoundingClientRect().width), lines: Number(getComputedStyle(text).getPropertyValue('--lines')) };
        }),
    );

  // Layout at 1440: the rail and the week fit; the task panel opens on request.
  const laneWidth = async () => (await lane(today).boundingBox())?.width ?? 0;
  check('at 1440 px, the rail is open and each day is wide enough to read (≥ 80 px)', (await rail.count()) === 1 && (await laneWidth()) >= 80, `${await laneWidth()}`);
  const wideTitles = await titlesWhole();
  check('at 1440 px, two- and three-word titles read in full in blocks of an hour or more (Week)', wideTitles.length >= 3 && wideTitles.every((item) => item.whole) && wideTitles.some((item) => item.title.startsWith('Budget review meeting')), JSON.stringify(wideTitles));
  await shot('cal-29-week-titles-1440');
  await pickView('Day');
  await shot('cal-29b-day-1440');
  await pickView('Month');
  await shot('cal-29c-month-1440');
  await pickView('Week');
  await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });
  await f.getByRole('button', { name: 'Show the task panel' }).click();
  const side = f.getByRole('complementary', { name: 'Unscheduled work' });
  check('opening the task panel folds the rail so the week stays readable', (await side.count()) === 1 && (await rail.count()) === 0 && (await laneWidth()) >= 80, `${await laneWidth()}`);
  await shot('cal-16-side-panel-1440');
  await f.getByRole('button', { name: 'Hide the task panel' }).click();

  // Layout at 1024.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(800);
  const narrow = await laneWidth();
  check('at 1024 px, the rail and task panel fold away and each day stays readable (≥ 56 px)', (await rail.count()) === 0 && narrow >= 56, `${narrow}`);
  const narrowTitles = await titlesWhole();
  check('at 1024 px (OpenChamber’s sidebar open), two- and three-word titles read in full in blocks of an hour or more (Week)', narrowTitles.length >= 3 && narrowTitles.every((item) => item.whole), JSON.stringify({ frame: (await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox())?.width, narrowTitles }));
  await shot('cal-30-week-titles-1024');
  await pickView('Day');
  await shot('cal-30b-day-1024');
  await pickView('Week');
  await f.locator('.day-lane').nth(6).waitFor({ timeout: 5000 });
  await planning.click();
  const small = f.getByRole('dialog', { name: 'Event: Quarter planning' });
  const popBox = await small.boundingBox();
  const frameBox = await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  check('at 1024 px, details still open by a click, inside the window', popBox && frameBox && popBox.x >= frameBox.x && popBox.x + popBox.width <= frameBox.x + frameBox.width + 1, JSON.stringify({ popBox, frameBox }));
  await shot('cal-17-week-1024');
  await small.getByRole('button', { name: 'Close' }).click();
  const narrowDeadline = await deadlineViews(1024);
  check('at 1024 px, the deadline-only task shows on its day in Week, Month, Day and Schedule', narrowDeadline.week && narrowDeadline.month && narrowDeadline.day && narrowDeadline.schedule, JSON.stringify(narrowDeadline));
  await reportChip.click();
  const narrowTask = f.getByRole('dialog', { name: 'Google task: Send the report' });
  const narrowEdit = await narrowTask.getByRole('button', { name: 'Edit task' }).isVisible().catch(() => false);
  await shot('cal-43-task-popover-edit-1024');
  await narrowTask.getByRole('button', { name: 'Edit task' }).click();
  const narrowEditor = f.getByRole('dialog', { name: 'Edit task: Send the report' });
  const editorBox = await narrowEditor.boundingBox().catch(() => null);
  await shot('cal-44-task-editor-1024');
  check('at 1024 px, a task’s details offer Edit, and the editor fits in the window', narrowEdit && editorBox && editorBox.x >= frameBox.x && editorBox.x + editorBox.width <= frameBox.x + frameBox.width + 1, JSON.stringify({ narrowEdit, editorBox, frameBox }));
  await narrowEditor.getByRole('button', { name: 'Close' }).click();
  await goTo(addDays(today, 1)).catch(() => {});
  await shot('cal-45-upcoming-1024');
  await f.getByRole('button', { name: 'Main menu' }).click();
  check('at 1024 px, the main menu opens the rail', (await rail.count()) === 1);
  await shot('cal-18-rail-1024');
  await f.getByRole('button', { name: 'Main menu' }).click();
  await pickView('Month');
  await shot('cal-19-month-1024');
} catch (error) {
  check('journey completed', false, error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ') : String(error));
  await h.shot('cal-99-failure').catch(() => {});
} finally {
  check('no errors from the Planner', plannerErrors.length === 0, plannerErrors.slice(0, 3).join(' | '));
  await h.close();
  await fake.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
