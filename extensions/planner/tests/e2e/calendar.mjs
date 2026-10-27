// Google Calendar and Google Tasks in the Planner, end to end: the dev
// container's OpenChamber UI with this checkout's panel and service, and the
// service signed in to a fake Google (tests/e2e/fakeGoogle.mjs), so each
// change is checked where Google gets it. Day, Week, Month and Schedule; the
// mini month; drag to create; details; RSVP; move and resize; recurring events
// (This event, This and following, All events); a custom repeat rule; Google
// Tasks lists and tasks (create, rename, delete, subtasks, reorder, complete);
// a Google task planned stays on its due day; the layout at 1440 and 1024 px.
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
  check('a Google task opens its details: date only, as Google Tasks has no time', (await taskPopover.innerText()).includes('Date only'));
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
  check('Starred says why it is not there', ((await f.getByRole('button', { name: /Starred/ }).getAttribute('title')) ?? '').includes('does not let other apps'));
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
  await fresh.getByRole('button', { name: 'Add' }).click();
  const milkPost = await until(() => requests('POST', '/tasks/v1/lists/L1/tasks').find((request) => request.body?.title === 'Harness buy milk'));
  check('Add a task adds it at the top of the list in Google Tasks', milkPost && !milkPost.query.previous && milkPost.body.notes === 'Oat');
  await myTasks.getByRole('button', { name: 'Actions for Plan the trip' }).click();
  await myTasks.getByRole('menuitem', { name: 'Add a subtask' }).click();
  const sub = myTasks.getByRole('group', { name: 'New task' });
  await sub.getByRole('textbox', { name: 'Title' }).fill('Pack the bags');
  await sub.getByRole('button', { name: 'Add' }).click();
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
  check('editing a task says Google keeps only its date', (await editing.innerText()).includes('No time'));
  await editing.locator('input[type="date"]').fill(addDays(today, 1));
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
  await f.getByRole('radio', { name: 'Calendar' }).click();

  // Layout at 1440: the rail and the week fit; the task panel opens on request.
  const laneWidth = async () => (await lane(today).boundingBox())?.width ?? 0;
  check('at 1440 px, the rail is open and each day is wide enough to read (≥ 80 px)', (await rail.count()) === 1 && (await laneWidth()) >= 80, `${await laneWidth()}`);
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
  await planning.click();
  const small = f.getByRole('dialog', { name: 'Event: Quarter planning' });
  const popBox = await small.boundingBox();
  const frameBox = await page.locator('.inset-0 > iframe[title="Planner"]').boundingBox();
  check('at 1024 px, details still open by a click, inside the window', popBox && frameBox && popBox.x >= frameBox.x && popBox.x + popBox.width <= frameBox.x + frameBox.width + 1, JSON.stringify({ popBox, frameBox }));
  await shot('cal-17-week-1024');
  await small.getByRole('button', { name: 'Close' }).click();
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
