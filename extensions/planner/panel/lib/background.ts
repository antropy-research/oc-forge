// Chat entry points. OpenChamber runs these in a hidden frame of this bundle:
// message and session actions, and the /task and /today commands.
import { isGuestMessageItem, isGuestSessionItem, type AttachIssueRequest, type HostClient } from '@openchamber/sdk';
import { formatMinutes, monthDay, weekdayName } from '../../src/domain/dates.ts';
import type { EventBody } from '../../src/domain/events.ts';
import { newId } from '../../src/domain/ids.ts';
import { parseQuickAdd } from '../../src/domain/quickAdd.ts';
import { edgePosition, tasksForDay } from '../../src/domain/selectors.ts';
import type { Task } from '../../src/domain/types.ts';
import type { ClientView, PlannerClient } from './client.ts';
import { createTaskCommands } from './commands.ts';
import { PANEL_ID } from './agents.ts';

const NOTES_MAX = 40_000;
const TITLE_MAX = 120;

/** A task title from a message: its first meaningful line, without Markdown markers. */
export const titleFromMessage = (text: string): string => {
  const line = text
    .split('\n')
    .map((part) => part.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/[*_`]+/g, '').trim())
    .find(Boolean);
  if (!line) return 'Follow up on a chat message';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

export const registerBackground = (host: HostClient, client: PlannerClient): void => {
  let session: { id: string; title: string } | null = null;
  let directory: string | null = null;
  host.onSession((snapshot) => {
    session = snapshot ? { id: snapshot.id, title: snapshot.title || snapshot.id } : null;
  });
  host.onDirectory((value) => {
    directory = value;
  });

  const loaded = async (): Promise<ClientView> => {
    if (!client.getView().loaded) await client.load();
    const view = client.getView();
    if (!view.loaded) throw new Error(view.error ?? 'The Planner service is not available.');
    return view;
  };

  const today = (view: ClientView) => ({ kind: 'day' as const, date: view.today });

  host.onAction(async (item) => {
    const view = await loaded();
    const sessionRef: Task['sessionRef'] = { sessionId: item.sessionId, title: item.sessionTitle.slice(0, 500), directory: item.directory };
    if (isGuestMessageItem(item)) {
      const title = titleFromMessage(item.text);
      const notes = `From "${item.sessionTitle}" (${item.role === 'assistant' ? 'agent' : 'you'}):\n\n${item.text}`.slice(0, NOTES_MAX);
      await client.dispatch([{ type: 'task.created', task: { id: newId(), title, notes, placement: today(view), position: edgePosition(view.state, today(view), 'bottom'), sessionRef } }]);
      if (client.getView().error) throw new Error(client.getView().error!);
      await host.toast({ kind: 'success', message: `Added to today in Planner: ${title}` });
      return;
    }
    if (isGuestSessionItem(item)) {
      const taskId = newId();
      const title = (item.sessionTitle || 'Follow up on a chat').slice(0, 200);
      await client.dispatch([
        { type: 'task.created', task: { id: taskId, title, placement: today(view), position: edgePosition(view.state, today(view), 'bottom'), sessionRef } },
        { type: 'run.started', run: { id: newId(), taskId, sessionId: item.sessionId, projectId: null, directory: item.directory, worktree: null, title } },
      ]);
      if (client.getView().error) throw new Error(client.getView().error!);
      await host.toast({ kind: 'success', message: `Tracking "${title}" in Planner today` });
    }
  });

  host.onResolve(async ({ command, args }): Promise<AttachIssueRequest | null> => {
    const view = await loaded();
    if (command === 'task') {
      const parsed = parseQuickAdd(args, view.today, view.state.settings.weekStartsOn);
      if (!parsed.title.trim()) throw new Error('Write the task after /task, e.g. /task Review the PR ~30m @tomorrow');
      const bodies: EventBody[] = createTaskCommands(view.state, parsed, today(view), 'bottom', view.today).map((body) =>
        body.type === 'task.created' && session ? { ...body, task: { ...body.task, sessionRef: { sessionId: session.id, title: session.title.slice(0, 500), directory } } } : body,
      );
      await client.dispatch(bodies);
      if (client.getView().error) throw new Error(client.getView().error!);
      await host.toast({ kind: 'success', message: `Added to Planner: ${parsed.title}` });
      return null;
    }
    if (command === 'today') {
      const tasks = tasksForDay(view.state, view.today);
      const lines = tasks.map((task) => `- [${task.completedAt ? 'x' : ' '}] ${task.title}${task.plannedMinutes ? ` (${formatMinutes(task.plannedMinutes)})` : ''}`);
      const text = [`My plan for ${weekdayName(view.today)}, ${monthDay(view.today)}:`, ...(lines.length ? lines : ['(nothing planned yet)'])].join('\n');
      return { providerId: PANEL_ID, id: `today-${view.today}`, title: `Today's plan · ${monthDay(view.today)}`, url: 'https://planner.invalid/today', text: text.slice(0, 16_000), data: { kind: 'today', date: view.today } };
    }
    return null;
  });
};
