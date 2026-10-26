// Planner panel entry: the same bundle serves the full page and the rail panel.
import { render } from 'preact';
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { PlannerClient } from './lib/client.ts';
import { LinearStore } from './lib/linear.ts';
import { AgentStore } from './lib/agents.ts';
import { GitHubStore } from './lib/github.ts';
import { registerBackground } from './lib/background.ts';
import { PlannerContext } from './lib/context.ts';
import { App } from './components/App.tsx';

const host = connectHost();
const client = new PlannerClient(host);
// Message actions and slash commands must be answered from the first moment.
registerBackground(host, client);
const root = document.getElementById('root') as HTMLElement;
let mounted = false;

host.onReady((ready) => {
  applyHostReady(ready, document.documentElement);
  document.documentElement.dataset.surface = ready.surface;
  // A background frame only answers actions and commands; it draws nothing.
  if (mounted || ready.surface === 'background') return;
  mounted = true;
  const linear = new LinearStore(host, client, ready.surface);
  const agents = new AgentStore(host, client, ready.surface);
  const github = new GitHubStore(client, ready.surface);
  render(
    <PlannerContext.Provider value={{ client, host, linear, agents, github }}>
      <App surface={ready.surface} />
    </PlannerContext.Provider>,
    root,
  );
});
