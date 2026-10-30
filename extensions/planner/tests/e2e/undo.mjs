// The Planner's own Undo in two windows, at 1440×900 and at 1024×768, in the dev container's OpenChamber with this
// checkout's panel and a private copy of its service (harness.mjs; nothing else is written anywhere).
// A task moved with its card's menu offers "Task moved · Undo", which puts it back while nothing it would put back
// was changed since: renamed in the other window meanwhile, it is moved back and keeps their title. Moved again in
// the other window first, the Undo leaves it where the other window put it, writes nothing and says "Changed in
// another window since; not undone".
// Run on the host after `bun run build`: node extensions/planner/tests/e2e/undo.mjs [outDir]
import { startHarness } from './harness.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-undo-journey';
const CHANGED = 'Changed in another window since; not undone';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const h = await startHarness({ out, viewport: { width: 1440, height: 900 } });
const { page, frame } = h;
let other = null;
try {
  await h.openPlanner();
  const state = async () => (await h.call('GET', '/state')).json;
  const plan = async () => (await state()).state;
  let seq = 0;
  const commands = async (...bodies) => {
    const answer = await h.call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `harness-undo-${Date.now().toString(36)}-${++seq}`, ...body })) });
    if (answer.status !== 200) throw new Error(`commands: ${answer.text}`);
  };
  const until = async (test, timeout = 10_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await test();
      if (value || Date.now() > end) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const today = (await state()).today;

  // The second window, on the same Planner.
  other = await h.context.newPage();
  other.setDefaultTimeout(15_000);
  await other.addLocatorHandler(other.getByText('OpenCode update'), async () => {
    await other.locator('li.toast', { hasText: 'OpenCode update' }).getByRole('button', { name: 'Close', exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  });
  other.on('pageerror', (error) => h.problems.push(`second window pageerror: ${error.message}`));
  const second = other.frameLocator('.inset-0 > iframe[title="Planner"]');
  const openSecond = async () => {
    await other.goto(`${new URL(page.url()).origin}/`, { waitUntil: 'load' });
    const home = second.getByRole('heading', { name: 'Home' });
    if (!(await home.waitFor({ timeout: 6000 }).then(() => true).catch(() => false))) {
      const button = other.locator('button[aria-label="Planner"]:not([data-context-surface])').first();
      if (await button.isVisible().catch(() => false)) await button.click();
      else {
        await other.locator('button[aria-label="Extension pages"]').first().click({ timeout: 20_000 });
        await other.getByRole('menuitem', { name: 'Planner' }).click({ timeout: 10_000 });
      }
      await home.waitFor({ timeout: 30_000 });
    }
  };

  const todayIn = (where) => where.locator('section.day-column.is-today');
  const cardIn = (where, title) => todayIn(where).locator('li.task-card', { hasText: title });
  const tomorrowCard = (where, title) => where.locator('section.day-column[aria-label^="Tomorrow"] li.task-card', { hasText: title });
  /** Wherever the window shows it (the other window may not have seen a move yet, or may have). */
  const cardAnywhere = (where, title) => where.locator('li.task-card', { hasText: title }).first();
  /** A card's menu, then one of its items. */
  const fromMenu = async (where, title, item) => {
    const card = cardAnywhere(where, title);
    await card.hover();
    await card.getByRole('button', { name: 'Task actions' }).click();
    await card.getByRole('menuitem', { name: item }).click();
  };
  const toastOf = (where, text) => where.getByRole('status').filter({ hasText: text });

  for (const size of [1440, 1024]) {
    const viewport = size === 1440 ? { width: 1440, height: 900 } : { width: 1024, height: 768 };
    await page.setViewportSize(viewport);
    await other.setViewportSize(viewport);
    const kept = `Harness undo kept ${size}`;
    const theirs = `Harness undo theirs ${size}`;
    const ids = { kept: `harness-undo-kept-${size}`, theirs: `harness-undo-theirs-${size}` };
    await commands(
      { type: 'task.created', task: { id: ids.kept, title: kept, placement: { kind: 'day', date: today }, position: 100 } },
      { type: 'task.created', task: { id: ids.theirs, title: theirs, placement: { kind: 'day', date: today }, position: 200 } },
    );
    // Both windows show them on today (a reload each, rather than waiting for their polls).
    await h.openPlanner();
    await openSecond();
    await cardIn(frame, theirs).waitFor({ timeout: 15_000 });
    await cardIn(second, theirs).waitFor({ timeout: 15_000 });

    // 1. A move undone: the first window moves the task to tomorrow with its menu; the other window renames it meanwhile
    //    (its details' title); the first window's Undo puts it back on today, and their title stays.
    const renamed = `${kept}, renamed in the other window`;
    await fromMenu(frame, kept, 'Move to tomorrow');
    const offered = await toastOf(frame, 'Task moved').waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    const movedTo = (await until(async () => {
      const placement = (await plan()).tasks[ids.kept]?.placement;
      return placement?.date !== today ? placement : null;
    })) ?? null;
    await h.shot(`undo-01-moved-${size}`);
    await other.bringToFront();
    await cardAnywhere(second, kept).getByRole('button', { name: `Open ${kept}` }).click();
    const details = second.getByRole('dialog', { name: 'Task details' });
    await details.getByRole('textbox', { name: 'Title' }).fill(renamed);
    await details.getByRole('textbox', { name: 'Title' }).press('Enter');
    const titled = Boolean(await until(async () => (await plan()).tasks[ids.kept]?.title === renamed));
    await other.keyboard.press('Escape');
    await page.bringToFront();
    const undoMove = toastOf(frame, 'Task moved').getByRole('button', { name: 'Undo' });
    const stillThere = await undoMove.isVisible().catch(() => false);
    if (stillThere) await undoMove.click();
    const back = Boolean(await until(async () => (await plan()).tasks[ids.kept]?.placement.date === today));
    const final = (await plan()).tasks[ids.kept];
    const shownBack = await cardIn(frame, kept).waitFor({ timeout: 10_000 }).then(async () => (await cardIn(frame, kept).innerText()).includes(renamed)).catch(() => false);
    const refusedFirst = (await frame.getByRole('alert').filter({ hasText: CHANGED }).count()) > 0;
    // The other window follows on its next look (every five seconds).
    const otherBack = await cardIn(second, renamed).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    await h.shot(`undo-02-undone-${size}`);
    check(
      `${size} px: "Move to tomorrow" from a task's menu offers "Task moved · Undo"; renamed in the other window meanwhile, Undo still puts it back on today, with their title, in the service and in both windows`,
      offered && movedTo?.date !== today && titled && stillThere && back && final?.title === renamed && shownBack && !refusedFirst && otherBack,
      JSON.stringify({ offered, movedTo, titled, stillThere, back, title: final?.title, shownBack, refusedFirst, otherBack }),
    );

    // 2. Changed in the other window since: the first window moves it to tomorrow; before its Undo, the second window
    //    (which still shows it on today) moves it to the backlog. The Undo leaves theirs, writes nothing, and says so.
    await fromMenu(frame, theirs, 'Move to tomorrow');
    const offeredAgain = await toastOf(frame, 'Task moved').waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    await until(async () => (await plan()).tasks[ids.theirs]?.placement.date !== today);
    const onTomorrow = (await tomorrowCard(frame, theirs).count()) === 1;
    await other.bringToFront();
    await fromMenu(second, theirs, 'Move to backlog');
    const inBacklog = Boolean(await until(async () => (await plan()).tasks[ids.theirs]?.placement.kind === 'backlog'));
    const version = (await plan()).version;
    await page.bringToFront();
    const undoButton = toastOf(frame, 'Task moved').getByRole('button', { name: 'Undo' });
    const stillOffered = await undoButton.isVisible().catch(() => false);
    if (stillOffered) await undoButton.click();
    const said = frame.getByRole('alert').filter({ hasText: CHANGED });
    const told = await said.waitFor({ timeout: 10_000 }).then(() => said.innerText()).catch(() => '');
    await h.shot(`undo-03-refused-${size}`);
    await page.waitForTimeout(500);
    const after = await plan();
    const leftInPlace = after.tasks[ids.theirs]?.placement;
    // The first window showed it on tomorrow (its own move); now it shows the plan as it is (theirs): on neither day.
    const offDays = (await tomorrowCard(frame, theirs).count()) === 0 && (await cardIn(frame, theirs).count()) === 0;
    await other.screenshot({ path: `${out}/undo-04-other-window-${size}.png` });
    check(
      `${size} px: moved to the backlog in the other window before the first window's Undo: the Undo leaves it in the backlog, writes nothing, says "${CHANGED}", and the first window shows theirs`,
      offeredAgain && onTomorrow && inBacklog && stillOffered && told.includes(CHANGED) && leftInPlace?.kind === 'backlog' && after.version === version && offDays,
      JSON.stringify({ offeredAgain, onTomorrow, inBacklog, stillOffered, told, leftInPlace, written: after.version - version, offDays }),
    );
    await commands({ type: 'task.deleted', taskId: ids.kept }, { type: 'task.deleted', taskId: ids.theirs });
  }
  check('no page errors in either window', h.problems.filter((problem) => problem.includes('pageerror')).length === 0, h.problems.filter((problem) => problem.includes('pageerror')).join(' | '));
} catch (error) {
  check('journey ran to the end', false, String(error).split('\n')[0]);
  await h.shot('99-undo-error').catch(() => {});
} finally {
  await other?.close().catch(() => {});
  await h.close();
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
