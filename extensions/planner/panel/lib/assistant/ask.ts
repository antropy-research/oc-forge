// Ask Planner, the panel's side. A request becomes a chat with the agent the chat composer has selected: OpenChamber
// starts it beside the Planner and sends the request as its first message, with where the plan is and the command the
// agent works on it with (service/assistant/cli.ts). The service keeps what each chat changed; the Planner lists it and
// takes it back.
import type { HostClient } from '@openchamber/sdk';
import type { PlannerClient, Snapshot } from '../core/client.ts';
import { PANEL_ID } from '../agents/store.ts';

export interface AskChangeView {
  id: string;
  label: string;
  at: string;
  undone?: 'undone' | 'kept';
  /** Whether it can still be taken back (the service keeps that a day, until it restarts). */
  undoable: boolean;
}

export interface AskRunView {
  id: string;
  /** What was asked; null for a chat the Planner did not start, whose agent changed the plan. */
  request: string | null;
  at: string;
  sessionId: string | null;
  directory: string | null;
  changes: AskChangeView[];
}

/** The chat's first message: the request, then that it is about the plan and the command to work on it with. */
export const askMessage = (request: string, launcher: string): string =>
  `${request}\n\n(Ask Planner: this is about my plan in the Planner, OpenChamber's right panel, not about the files here. Read and change it only with the Planner's command line: start with \`${launcher} help\`.)`;

/**
 * Start a chat for a request, opened beside the Planner: the run first (the service answers with the command's path),
 * then the chat, then which chat it is. What OpenChamber said of the first message comes back (`no-model`: nothing
 * answers it until a model is picked in the chat).
 */
export const startAsk = async (host: HostClient, client: PlannerClient, request: string): Promise<{ sessionId: string; sent: string }> => {
  const { run, launcher } = await client.call<{ run: AskRunView; launcher: string }>('POST', '/ask/runs', { request });
  const result = await host.startSession({
    providerId: PANEL_ID,
    id: 'Ask',
    title: request.replace(/\s+/g, ' ').slice(0, 200),
    url: 'https://planner.invalid/ask',
    text: askMessage(request, launcher),
    data: { ask: run.id },
    navigation: 'open',
  });
  if (!result?.sessionId) throw new Error('OpenChamber did not start the chat');
  await client.call('PUT', `/ask/runs/${run.id}`, { sessionId: result.sessionId, directory: result.directory ?? null });
  return { sessionId: result.sessionId, sent: result.sent };
};

/** The recent asks, newest first, and why the command line is not there when it is not. */
export const askRuns = (client: PlannerClient): Promise<{ runs: AskRunView[]; problem: string | null }> => client.call('GET', '/ask/runs');

/** Take a run's changes back, newest first; the ones changed since stay, and say so. */
export const undoAsk = async (client: PlannerClient, runId: string): Promise<{ undone: number; kept: { label: string; why: string }[]; run: AskRunView }> => {
  const answer = await client.call<Snapshot & { undone: number; kept: { label: string; why: string }[]; run: AskRunView }>('POST', `/ask/runs/${runId}/undo`);
  await client.adopt(answer);
  return answer;
};
