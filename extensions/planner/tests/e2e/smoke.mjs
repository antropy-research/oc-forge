// The harness end to end: the Planner page in the dev container's OpenChamber, this checkout's
// panel and service, the Linear fixture. Run on the host: node extensions/planner/tests/e2e/smoke.mjs [outDir]
import { startHarness } from './harness.mjs';

const h = await startHarness({ out: process.argv[2] ?? '/tmp/opencode/planner-harness' });
try {
  await h.openPlanner();
  await h.nav('Linear').click();
  await h.frame.locator('li.issue-row').first().waitFor({ timeout: 15_000 });
  await h.shot('smoke-linear');
  const state = await h.call('GET', '/state');
  console.log(`PASS the Planner page opens on this checkout's build (${Object.keys(state.json.state.tasks).length} tasks in the private plan; Linear: ${[...new Set(h.linearCalls.map((c) => c.op))].join(', ')})`);
} finally {
  await h.close();
}
