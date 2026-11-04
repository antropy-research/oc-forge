// A clean shutdown for the journeys that do not use harness.mjs (run.mjs, agentpr.mjs, forge.mjs), as the harness's
// close() has had since 9ed53cf: a Planner request the page sent just before the end may still be on its way, one a
// route takes paused for it; closed under it, Chromium lets it through to the real service. So close() waits until no
// Planner request is in flight (each answered, by its route or the service, or failed) and none was sent for a moment,
// at most 15 s; then closes the pages while the routes still answer, takes the routes off, and closes the browser.
// Attach it right after newContext, before the first route and page.

const PLANNER = '/api/guests/oc-forge-planner/';

export const watchPlannerRequests = (context) => {
  const inFlight = new Set();
  let lastSent = Date.now();
  const planner = (request) => {
    try {
      return new URL(request.url()).pathname.startsWith(PLANNER);
    } catch {
      return false;
    }
  };
  context.on('request', (request) => {
    if (!planner(request)) return;
    inFlight.add(request);
    lastSent = Date.now();
  });
  context.on('requestfinished', (request) => inFlight.delete(request));
  context.on('requestfailed', (request) => inFlight.delete(request));
  return {
    /** The Planner requests sent and not answered yet. */
    pending: () => [...inFlight],
    async close(browser, { quietMs = 1500, maxMs = 15_000, label = 'journey' } = {}) {
      for (const end = Date.now() + maxMs; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
        if (inFlight.size === 0 && Date.now() - lastSent > quietMs) break;
      }
      if (inFlight.size > 0) console.error(`${label}: closing with ${inFlight.size} Planner request(s) unanswered: ${[...inFlight].map((request) => new URL(request.url()).pathname).slice(0, 3).join(', ')}`);
      for (const open of context.pages()) await open.close({ runBeforeUnload: false }).catch(() => {});
      // A route callback still forwarding a request (route.fetch) fails once its page is gone: not the journey's end.
      await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await browser.close().catch(() => {});
    },
  };
};
