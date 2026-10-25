// Add Task submit shared by the inline form and the A window.
import type { QuickAdd } from '../../src/domain/quickAdd.ts';
import { parseLinearUrl } from '../../src/domain/linear.ts';
import type { DateKey, Placement } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';
import type { LinearStore } from './linear.ts';
import { createTaskCommands } from './commands.ts';

/** Add a parsed line; a pasted Linear issue URL becomes a task linked to that issue, as in Sunsama. */
export const addParsedTask = async (client: PlannerClient, linear: LinearStore, parsed: QuickAdd, fallback: Placement, edge: 'top' | 'bottom', today: DateKey, folderId: string | null = null): Promise<void> => {
  const url = parseLinearUrl(parsed.title);
  if (url && linear.available()) {
    try {
      // The URL names its workspace, so the issue is looked up there and nowhere else.
      const issue = await linear.issue(url.key, url.urlKey);
      if (issue) {
        const { bodies, taskId } = linear.importCommands(issue, parsed.placement ?? fallback);
        if (parsed.plannedMinutes) bodies.push({ type: 'task.updated', taskId, patch: { plannedMinutes: parsed.plannedMinutes } });
        await client.dispatch(bodies, { undo: `Planned ${issue.identifier}` });
        return;
      }
      client.notify(`${url.key} was not found in your connected Linear workspaces; added the link as a task`);
    } catch {
      client.notify(`Couldn't look up ${url.key} in Linear; added the link as a task`);
    }
  }
  await client.dispatch(createTaskCommands(client.getView().state, parsed, fallback, edge, today, folderId));
};
