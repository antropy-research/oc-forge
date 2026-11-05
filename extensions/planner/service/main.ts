// Planner local service. The host starts it with the app's Node runtime, binds it
// to 127.0.0.1, and proxies the panel's serviceRequest calls to it. This builds the
// service (context.ts), starts what runs on its own, serves the routes over the
// HTTP layer (http.ts), and shuts down once what is being written is written.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from './context.ts';
import { createServer } from './http.ts';
import { agentsRoute } from './routes/agents.ts';
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

// Each feature's routes; no two answer the same method and path.
const server = createServer(ctx, token, [planRoute, calendarRoute, googleRoute, linearRoute, githubRoute, agentsRoute]);

const shutdown = async (): Promise<void> => {
  server.close();
  await Promise.race([Promise.all([ctx.timeboxes.settled(), ctx.series.settled()]), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await ctx.store.flush();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, '127.0.0.1');
ctx.meetings.start();
