// Planner panel entry: the same bundle serves the full page and the rail panel.
import { render } from 'preact';
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { PlannerClient } from './lib/client.ts';
import { PlannerContext } from './lib/context.ts';
import { App } from './components/App.tsx';

const host = connectHost();
const client = new PlannerClient(host);
const root = document.getElementById('root') as HTMLElement;
let mounted = false;

host.onReady((ready) => {
  applyHostReady(ready, document.documentElement);
  document.documentElement.dataset.surface = ready.surface;
  if (mounted) return;
  mounted = true;
  render(
    <PlannerContext.Provider value={{ client, host }}>
      <App surface={ready.surface} />
    </PlannerContext.Provider>,
    root,
  );
});
