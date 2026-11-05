// Where a journey finds the Planner: OpenChamber's right panel, opened from the rail's Planner icon. The Planner has no
// page of its own since 2026-11-05; oc-forge's OpenChamber keeps its panel the window's, loaded at startup and the same
// in every chat (adapters/openchamber README, "global panel"). The journeys were written for the wide page, so they
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
 * Shows the Planner in `page` (already loaded) and returns its FrameLocator once `.app` is drawn: the rail icon when
 * the panel is not what its zone shows (the icon toggles, so never when it is), then the zone's expand button.
 */
export const openPlannerPanel = async (page, { expand = true, timeout = 30_000 } = {}) => {
  const frame = page.frameLocator(PLANNER_FRAME);
  const rail = page.locator(RAIL).first();
  await rail.waitFor({ timeout });
  // Pressed: an open zone shows the Planner (OpenChamber's shownContextModes).
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
  if (expand) {
    const button = plannerZone(page).locator('button[aria-label="Expand panel"]').first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  await frame.locator('.app').waitFor({ timeout });
  return frame;
};
