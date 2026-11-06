// Planner local service. The host starts it with the app's Node runtime, binds it
// to 127.0.0.1, and proxies the panel's serviceRequest calls to it. This builds the
// service (context.ts), starts what runs on its own, serves the routes over the
// HTTP layer (http.ts), and shuts down once what is being written is written.
// Ask Planner's agent reaches it too, with its own key, through the Planner's
// command line (assistant/cli.ts), whose launcher it writes once it listens.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from './context.ts';
import { createServer } from './http.ts';
import { agentsRoute } from './routes/agents.ts';
import { agentRoute, askRoute } from './routes/assistant.ts';
import { calendarRoute } from './routes/calendar.ts';
import { githubRoute } from './routes/github.ts';
import { googleRoute } from './routes/google.ts';
import { linearRoute } from './routes/linear.ts';
import { planRoute } from './routes/plan.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const dir = process.env.PLANNER_DATA_DIR || join(homedir(), '.local', 'share', 'openchamber-planner', 'data');
const log = (message: string): void => console.error(`[planner] ${message}`);
const ctx = await buildContext(dir, log);
ctx.decliner.start(ctx.planner);
ctx.syncAgentCommands();
ctx.agentCommands.retireLeftovers();

// Each feature's routes; no two answer the same method and path. OpenChamber's token opens them; the agent's key only
// its own.
const server = createServer(ctx, [
  { token, routes: [planRoute, calendarRoute, googleRoute, linearRoute, githubRoute, agentsRoute, askRoute] },
  { token: ctx.asks.key, routes: [agentRoute], noBrowser: true },
]);

const shutdown = async (): Promise<void> => {
  server.close();
  await Promise.race([Promise.all([ctx.timeboxes.settled(), ctx.series.settled()]), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await ctx.store.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// The command line beside this file: the built one beside the built service, the source beside the source (tests).
const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './assistant/cli.ts' : './cli.js', import.meta.url));
server.listen(port, '127.0.0.1', () => ctx.asks.prepare(port, process.execPath, cli));
ctx.meetings.start();
