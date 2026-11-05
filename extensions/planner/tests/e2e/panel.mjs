// Where a journey finds the Planner: OpenChamber's right panel, opened from the rail's Planner icon. The Planner has no
// page of its own since 2026-11-05 (its README, "In OpenChamber"). The journeys were written for the wide page, so they
// expand the panel: the Planner then has about the room the page gave it.
export const PLANNER_FRAME = '.inset-0 > iframe[title="Planner"]';
/**
 * How much wider than a journey's named window (1440, 1024) the harness opens it. The page had the window less
 * OpenChamber's sidebar (280 px) and rail (44): 1116 px at 1440, 700 at 1024, the widths the journeys' layout checks
 * were written for. The expanded panel leaves a chat column of at least 320 px and its card's margins, 56 px more:
 * with these 56 px the Planner gets the width the page gave it.
 */
export const PANEL_ROOM = 56;
const RAIL = 'button[data-context-surface="plugin:oc-forge-planner"]';

/** The zone holding the Planner's panel frame (the Work Status card's frame, transparent, is another). */
const plannerZone = (page) => page.locator('aside[data-context-zone]', { has: page.locator('iframe[title="Planner"]:not(.bg-transparent)') }).first();

/**
 * A new Planner frame starts where the Planner was (panel/lib/place.ts, this browser's storage): a journey starts on
 * Home, with nothing open over it, as it always has.
 */
const toHome = async (frame) => {
  for (let round = 0; round < 3 && await frame.getByRole('dialog').first().isVisible().catch(() => false); round += 1) {
    await frame.locator('body').press('Escape');
  }
  if (await frame.getByRole('heading', { name: 'Home' }).isVisible().catch(() => false)) return;
  const menu = frame.getByRole('button', { name: 'Planner menu' });
  if (await menu.isVisible().catch(() => false)) await menu.click();
  await frame.getByRole('navigation', { name: 'Planner' }).getByRole('button', { name: 'Home', exact: true }).click();
};

/**
 * Shows the Planner in `page` (already loaded) and returns its FrameLocator once `.app` is drawn, on Home: the rail
 * icon when the panel is not what its zone shows (the icon toggles, so never when it is), then the zone's expand
 * button. `home: false` leaves it where it starts.
 */
/** What the window shows: the rail icon, each zone (open, frames in it), the Planner's frames, any text in its panel. */
const looks = async (page) => {
  const pressed = await page.locator(RAIL).first().getAttribute('aria-pressed', { timeout: 1000 }).catch(() => 'none');
  const zones = await page.$$eval('aside[data-context-zone]', (asides) => asides.map((aside) => `${aside.dataset.contextZone}:${aside.dataset.contextPanelOpen === 'true' ? 'open' : 'closed'}:${aside.querySelectorAll('iframe').length}`).join(' ')).catch(() => '?');
  const frames = await page.$$eval('iframe[title="Planner"]', (list) => list.map((frame) => (frame.className.includes('bg-transparent') ? 'status' : 'panel')).join(',')).catch(() => '?');
  const said = await page.locator('aside[data-context-zone="right"]').first().innerText({ timeout: 1000 }).then((text) => text.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '');
  return `icon ${pressed}; zones ${zones}; Planner frames [${frames}]; right zone says "${said}"`;
};

/** A step's own name in its error, and what the window showed then: which of the waits below ran out, and why. */
const step = (page, name, promise) => promise.catch(async (error) => {
  // PANEL_SHOTS=<dir>: the window as it was, too.
  if (process.env.PANEL_SHOTS) await page.screenshot({ path: `${process.env.PANEL_SHOTS}/openPlannerPanel-${Date.now()}.png` }).catch(() => {});
  throw new Error(`openPlannerPanel: ${name}: ${String(error?.message ?? error).split('\n')[0]} (${await looks(page)})`);
});

export const openPlannerPanel = async (page, { expand = true, home = true, timeout = 30_000 } = {}) => {
  const frame = page.frameLocator(PLANNER_FRAME);
  const rail = page.locator(RAIL).first();
  await step(page, 'the rail\'s Planner icon', rail.waitFor({ timeout }));
  // Pressed: an open zone shows the Planner (OpenChamber's shownContextModes). Its Work Status section may open it at
  // the same moment as the click (following it from the chat before, in another folder), which the click then closes
  // again: look once it has settled, and click again.
  const pressed = async () => (await rail.getAttribute('aria-pressed')) === 'true';
  for (let attempt = 0; attempt < 3 && !(await pressed()); attempt += 1) {
    if (process.env.PANEL_DEBUG) console.error(`PANEL click ${attempt}: ${await looks(page)}`);
    await rail.click();
    for (const end = Date.now() + 3000; Date.now() < end && !(await pressed()); ) await page.waitForTimeout(150);
    await page.waitForTimeout(400);
  }
  // OpenChamber mounts the frame (a lazy pane) once its folder's panel has the Planner's tab: after the click, the
  // first time in a folder.
  await step(page, 'the panel frame in a zone', page.locator('aside[data-context-zone] iframe[title="Planner"]:not(.bg-transparent)').first().waitFor({ state: 'attached', timeout }));
  if (expand) {
    const button = plannerZone(page).locator('button[aria-label="Expand panel"]').first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  await step(page, 'the Planner drawn', frame.locator('.app').waitFor({ timeout }));
  if (home) await step(page, 'Home', toHome(frame));
  return frame;
};
