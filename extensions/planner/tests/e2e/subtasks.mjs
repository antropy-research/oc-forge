// A task's subtasks changed in two windows at once (review 12's P0), at 1440×900 and at 1024×768, in the dev
// container's OpenChamber with this checkout's panel and a private copy of its service (harness.mjs; nothing else is
// written anywhere). Window A's subtask commands are held on their way (a page route, after any read it makes first)
// while window B's change is accepted, then sent unchanged, as the reviewer held them. Each change is a command by
// identity, so: A ticks one while B adds one, or ticks another, and both are kept (the new one's id and text too), in
// the service and in both windows reloaded; A deletes one B renamed meanwhile, or renames one B deleted: nothing of A's
// is written, and A's Subtasks asks (Keep theirs / Save mine), never an error. The same in Focus, which shows the task's
// subtasks with the same controls.
// Run on the host after `bun run build`: node extensions/planner/tests/e2e/subtasks.mjs [outDir]
import { startHarness } from './harness.mjs';

const out = process.argv[2] ?? '/tmp/opencode/planner-subtasks-journey';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const h = await startHarness({ out, viewport: { width: 1440, height: 900 } });
const { page, frame } = h;
let other = null;
let release = () => {};
try {
  await h.openPlanner();
  const state = async () => (await h.call('GET', '/state')).json;
  const plan = async () => (await state()).state;
  let seq = 0;
  const commands = async (...bodies) => {
    const answer = await h.call('POST', '/commands', { commands: bodies.map((body) => ({ cmd: `harness-subtasks-${Date.now().toString(36)}-${++seq}`, ...body })) });
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

  // Window A's subtask commands, held on their way while `hold` is on: sent once released, unchanged, in order. (A
  // build from before subtask commands sends the whole list, `task.updated` with `subtasks`: held too, the negative
  // control.)
  let gate = null;
  const held = [];
  await page.route((url) => new URL(url).pathname === '/api/guests/oc-forge-planner/service/request', async (route) => {
    const outer = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
    if (gate && outer?.method === 'POST' && outer.path === '/commands' && /subtask\.|"subtasks"/.test(outer.body ?? '')) {
      held.push(JSON.parse(outer.body).commands.map((command) => command.type).join(','));
      await gate.promise;
    }
    await route.fallback();
  });
  const hold = () => {
    let open = () => {};
    const promise = new Promise((resolve) => (open = resolve));
    gate = { promise, open };
    held.length = 0;
  };
  release = () => {
    gate?.open();
    gate = null;
  };

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

  const A = { page, frame, name: 'A' };
  const B = { page: other, frame: second, name: 'B' };
  const front = async (window) => window.page.bringToFront();
  const cardIn = (where, title) => where.locator('section.day-column.is-today li.task-card', { hasText: title });
  /** The task's details in a window, opened from its card on today. */
  const details = async (window, title) => {
    await front(window);
    const dialog = window.frame.getByRole('dialog', { name: 'Task details' });
    if (!(await dialog.isVisible().catch(() => false))) await cardIn(window.frame, title).getByRole('button', { name: `Open ${title}` }).click();
    await dialog.waitFor();
    return dialog.locator('section[aria-label="Subtasks"]');
  };
  /** Each window reloaded, the task's details opened again. */
  const reloadBoth = async (title) => {
    await front(A);
    await h.openPlanner();
    await openSecond();
    await cardIn(A.frame, title).waitFor({ timeout: 15_000 });
    await cardIn(B.frame, title).waitFor({ timeout: 15_000 });
    return { a: await details(A, title), b: await details(B, title) };
  };
  const rowsOf = (section) => section.locator('ul.subtasks > li').evaluateAll((items) => items.map((li) => `${li.querySelector('input.subtask-title')?.value ?? ''}${li.querySelector('input[type=checkbox]')?.checked ? ' ✓' : ''}`));
  const row = (section, name) => section.locator(`ul.subtasks > li:has(input[aria-label="Complete ${name}"])`);
  const tick = (section, name) => section.getByRole('checkbox', { name: `Complete ${name}`, exact: true }).click();
  const add = async (section, title) => {
    await section.getByRole('textbox', { name: 'Add subtask' }).fill(title);
    await section.getByRole('textbox', { name: 'Add subtask' }).press('Enter');
  };
  const rename = async (section, name, title) => {
    const input = row(section, name).locator('input.subtask-title');
    await input.click();
    await input.fill(title);
    await input.press('Enter');
  };
  const remove = (section, name) => section.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  const serviceRows = (task) => task.subtasks.map((subtask) => `${subtask.title}${subtask.done ? ' ✓' : ''}`);
  const errorToasts = async () => (await A.frame.locator('div.toast[role="alert"]').count()) + (await B.frame.locator('div.toast[role="alert"]').count());
  const bannerIn = (section) => section.locator('.edit-conflict');

  /**
   * One race: A's change (held on its way), then B's (accepted), then A's sent as it was; the plan once both have
   * settled (`settled` says when), and what both windows show reloaded.
   */
  const race = async (taskId, title, sections, mine, theirs, settled) => {
    await front(A);
    hold();
    await mine(sections.a);
    const heldOne = Boolean(await until(() => held.length > 0, 8000));
    const version = (await plan()).version;
    await front(B);
    await theirs(sections.b);
    const accepted = await until(async () => ((await plan()).version > version ? (await plan()).tasks[taskId] : null), 8000);
    await front(A);
    release();
    const after = await until(async () => {
      const task = (await plan()).tasks[taskId];
      return settled(task) ? task : null;
    }, 10_000);
    return { heldOne, accepted, after: after ?? (await plan()).tasks[taskId], held: [...held] };
  };

  const go = async (where, name) => {
    const nav = where.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name, exact: true });
    if (!(await nav.isVisible().catch(() => false))) await where.getByRole('button', { name: 'Planner menu' }).click();
    await nav.click();
  };

  for (const size of [1440, 1024]) {
    const viewport = size === 1440 ? { width: 1440, height: 900 } : { width: 1024, height: 768 };
    await page.setViewportSize(viewport);
    await other.setViewportSize(viewport);
    const taskId = `harness-subtasks-${size}`;
    const title = `Harness subtasks ${size}`;
    const names = ['one', 'two', 'three', 'four', 'five', 'six'].map((word) => `${word} ${size}`);
    const ids = names.map((_, index) => `harness-sub-${size}-${index}`);
    await commands({ type: 'task.created', task: { id: taskId, title, placement: { kind: 'day', date: today }, position: 1, subtasks: names.map((name, index) => ({ id: ids[index], title: name, done: false })) } });
    let sections = await reloadBoth(title);

    // 1. The reviewer's case: A ticks child one while B adds a subtask (Add subtask → Enter).
    const added = `harness newly accepted ${size}`;
    const one = await race(taskId, title, sections, (s) => tick(s, names[0]), (s) => add(s, added), (task) => task?.subtasks.find((subtask) => subtask.id === ids[0])?.done && task.subtasks.some((subtask) => subtask.title === added));
    const addedId = one.after?.subtasks.find((subtask) => subtask.title === added)?.id ?? null;
    sections = await reloadBoth(title);
    const expectedOne = [`${names[0]} ✓`, ...names.slice(1), added];
    const shownOne = { a: await rowsOf(sections.a), b: await rowsOf(sections.b) };
    await h.shot(`sub-01-add-vs-tick-a-${size}`);
    await other.screenshot({ path: `${out}/sub-01-add-vs-tick-b-${size}.png` });
    check(
      `${size} px: A ticks a subtask (its command held) while B adds one with Add subtask → Enter: both kept, the new one's id and text too, in the service and in both windows reloaded; no error`,
      one.heldOne && one.accepted?.subtasks.length === names.length + 1 && JSON.stringify(serviceRows(one.after)) === JSON.stringify(expectedOne) && Boolean(addedId) &&
        JSON.stringify(shownOne.a) === JSON.stringify(expectedOne) && JSON.stringify(shownOne.b) === JSON.stringify(expectedOne) && (await errorToasts()) === 0,
      JSON.stringify({ held: one.held, accepted: one.accepted?.subtasks.length, service: serviceRows(one.after ?? { subtasks: [] }), addedId, shownOne }),
    );

    // 2. Tick vs tick of different children: A ticks two while B ticks three.
    const two = await race(taskId, title, sections, (s) => tick(s, names[1]), (s) => tick(s, names[2]), (task) => task?.subtasks.find((subtask) => subtask.id === ids[1])?.done && task.subtasks.find((subtask) => subtask.id === ids[2])?.done);
    sections = await reloadBoth(title);
    const expectedTwo = [`${names[0]} ✓`, `${names[1]} ✓`, `${names[2]} ✓`, ...names.slice(3), added];
    const shownTwo = { a: await rowsOf(sections.a), b: await rowsOf(sections.b) };
    check(
      `${size} px: A ticks one subtask (held) while B ticks another: both stay ticked, in the service and in both windows reloaded`,
      two.heldOne && JSON.stringify(serviceRows(two.after)) === JSON.stringify(expectedTwo) && JSON.stringify(shownTwo.a) === JSON.stringify(expectedTwo) && JSON.stringify(shownTwo.b) === JSON.stringify(expectedTwo) && (await errorToasts()) === 0,
      JSON.stringify({ held: two.held, service: serviceRows(two.after ?? { subtasks: [] }), shownTwo }),
    );

    // 3. Rename vs delete of the same child, the conflict. A deletes four (held) while B renames it: A's delete is
    //    refused, nothing of it written; A's Subtasks asks. Keep theirs keeps their title.
    const renamedB = `${names[3]} renamed in B`;
    const three = await race(taskId, title, sections, (s) => remove(s, names[3]), (s) => rename(s, names[3], renamedB), (task) => task?.subtasks.some((subtask) => subtask.title === renamedB));
    const conflictText = await bannerIn(sections.a).innerText({ timeout: 10_000 }).catch(() => '');
    const versionThree = (await plan()).version;
    await h.shot(`sub-02-rename-vs-delete-${size}`);
    const theirsShown = await row(sections.a, renamedB).count();
    await bannerIn(sections.a).getByRole('button', { name: 'Keep theirs' }).click().catch(() => {});
    const bannerGone = await bannerIn(sections.a).waitFor({ state: 'detached', timeout: 5000 }).then(() => true).catch(() => false);
    const keptTheirs = (await plan()).tasks[taskId].subtasks.find((subtask) => subtask.id === ids[3]);
    check(
      `${size} px: A deletes a subtask (held) that B renames meanwhile: A's delete is refused (nothing written), A's Subtasks says "renamed … elsewhere (yours: deleted)" with Keep theirs / Save mine, not an error; Keep theirs keeps their title`,
      three.heldOne && conflictText.includes(`“${names[3]}” was renamed “${renamedB}” elsewhere (yours: deleted)`) && /Keep theirs/.test(conflictText) && /Save mine/.test(conflictText) &&
        keptTheirs?.title === renamedB && (await plan()).version === versionThree && theirsShown === 1 && bannerGone && (await errorToasts()) === 0,
      JSON.stringify({ held: three.held, conflictText, keptTheirs: keptTheirs?.title, written: (await plan()).version - versionThree, theirsShown, bannerGone }),
    );
    // …and Save mine deletes it, as it is now: A deletes again (held) while B renames it again.
    const renamedAgain = `${names[3]} renamed again in B`;
    await race(taskId, title, sections, (s) => remove(s, renamedB), (s) => rename(s, renamedB, renamedAgain), (task) => task?.subtasks.some((subtask) => subtask.title === renamedAgain));
    const againText = await bannerIn(sections.a).innerText({ timeout: 10_000 }).catch(() => '');
    await bannerIn(sections.a).getByRole('button', { name: 'Save mine' }).click().catch(() => {});
    const deletedMine = Boolean(await until(async () => !(await plan()).tasks[taskId].subtasks.some((subtask) => subtask.id === ids[3])));
    check(
      `${size} px: asked again, Save mine deletes it as it is now`,
      againText.includes(`“${renamedB}” was renamed “${renamedAgain}” elsewhere (yours: deleted)`) && deletedMine,
      JSON.stringify({ againText, deletedMine }),
    );

    // 4. The other way: A renames five (its read first, then its command held) while B deletes it. A's rename is
    //    refused; A's Subtasks says it was deleted elsewhere; Save mine puts it back where it was, with A's title.
    const renamedA = `${names[4]} renamed in A`;
    const four = await race(taskId, title, sections, (s) => rename(s, names[4], renamedA), (s) => remove(s, names[4]), (task) => task && !task.subtasks.some((subtask) => subtask.id === ids[4]));
    const goneText = await bannerIn(sections.a).innerText({ timeout: 10_000 }).catch(() => '');
    await h.shot(`sub-03-delete-vs-rename-${size}`);
    const notWritten = !(await plan()).tasks[taskId].subtasks.some((subtask) => subtask.title === renamedA);
    await bannerIn(sections.a).getByRole('button', { name: 'Save mine' }).click().catch(() => {});
    const back = await until(async () => (await plan()).tasks[taskId].subtasks.find((subtask) => subtask.title === renamedA));
    sections = await reloadBoth(title);
    const expectedFour = [`${names[0]} ✓`, `${names[1]} ✓`, `${names[2]} ✓`, renamedA, names[5], added];
    const shownFour = { a: await rowsOf(sections.a), b: await rowsOf(sections.b) };
    check(
      `${size} px: A renames a subtask (its read first, its command held) that B deletes meanwhile: refused, nothing written; A's Subtasks says "deleted elsewhere (yours: renamed …)"; Save mine puts it back where it was with A's title, in both windows reloaded`,
      four.heldOne && goneText.includes(`“${names[4]}” was deleted elsewhere (yours: renamed “${renamedA}”)`) && notWritten && back?.id === ids[4] &&
        JSON.stringify(serviceRows((await plan()).tasks[taskId])) === JSON.stringify(expectedFour) && JSON.stringify(shownFour.a) === JSON.stringify(expectedFour) && JSON.stringify(shownFour.b) === JSON.stringify(expectedFour),
      JSON.stringify({ held: four.held, goneText, notWritten, back: back?.id, shownFour }),
    );

    // 5. Focus's controls (its Subtasks are the task detail's): A in Focus ticks six (held) while B adds one in the
    //    task's details; then A deletes that one in Focus (held) while B renames it: asked in Focus, Keep theirs.
    await front(A);
    await A.frame.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click();
    await go(A.frame, 'Focus');
    await A.frame.locator('aside[aria-label="Up next"]').getByRole('button', { name: title }).click();
    const focus = A.frame.locator('article.focus-card section[aria-label="Subtasks"]');
    await focus.waitFor();
    const focusAdded = `harness focus newly accepted ${size}`;
    const five = await race(taskId, title, { a: focus, b: sections.b }, (s) => tick(s, names[5]), (s) => add(s, focusAdded), (task) => task?.subtasks.find((subtask) => subtask.id === ids[5])?.done && task.subtasks.some((subtask) => subtask.title === focusAdded));
    const expectedFive = [...expectedFour.slice(0, 4), `${names[5]} ✓`, added, focusAdded];
    const focusRows = await until(async () => {
      const rows = await rowsOf(focus);
      return JSON.stringify(rows) === JSON.stringify(expectedFive) ? rows : null;
    }, 8000) ?? (await rowsOf(focus));
    await h.shot(`sub-04-focus-add-vs-tick-${size}`);
    const focusRenamed = `${focusAdded} renamed in B`;
    const six = await race(taskId, title, { a: focus, b: sections.b }, (s) => remove(s, focusAdded), (s) => rename(s, focusAdded, focusRenamed), (task) => task?.subtasks.some((subtask) => subtask.title === focusRenamed));
    const focusConflict = await bannerIn(focus).innerText({ timeout: 10_000 }).catch(() => '');
    await h.shot(`sub-05-focus-conflict-${size}`);
    await bannerIn(focus).getByRole('button', { name: 'Keep theirs' }).click().catch(() => {});
    const focusKept = (await plan()).tasks[taskId].subtasks.some((subtask) => subtask.title === focusRenamed);
    sections = await reloadBoth(title);
    const expectedSix = [...expectedFive.slice(0, 6), focusRenamed];
    const shownSix = { a: await rowsOf(sections.a), b: await rowsOf(sections.b) };
    check(
      `${size} px: in Focus, A ticks a subtask (held) while B adds one in the task's details: both kept, Focus shows both; A deletes that one in Focus (held) while B renames it: Focus asks, Keep theirs keeps it; both windows reloaded agree`,
      five.heldOne && JSON.stringify(serviceRows(five.after)) === JSON.stringify(expectedFive) && JSON.stringify(focusRows) === JSON.stringify(expectedFive) &&
        six.heldOne && focusConflict.includes(`“${focusAdded}” was renamed “${focusRenamed}” elsewhere (yours: deleted)`) && focusKept &&
        JSON.stringify(shownSix.a) === JSON.stringify(expectedSix) && JSON.stringify(shownSix.b) === JSON.stringify(expectedSix) && (await errorToasts()) === 0,
      JSON.stringify({ held: [five.held, six.held], service: serviceRows(five.after ?? { subtasks: [] }), focusRows, focusConflict, focusKept, shownSix }),
    );
    await front(A);
    await A.frame.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click().catch(() => {});
    await front(B);
    await B.frame.getByRole('dialog', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click().catch(() => {});
    await commands({ type: 'task.deleted', taskId });
  }
  check('no page errors in either window', h.problems.filter((problem) => problem.includes('pageerror')).length === 0, h.problems.filter((problem) => problem.includes('pageerror')).join(' | '));
} catch (error) {
  check('journey ran to the end', false, String(error).split('\n')[0]);
  await h.shot('99-subtasks-error').catch(() => {});
} finally {
  release();
  await other?.close().catch(() => {});
  await h.close();
}
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} passed; screenshots in ${out}`);
process.exit(passed === results.length ? 0 : 1);
