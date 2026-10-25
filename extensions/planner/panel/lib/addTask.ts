// Add Task submit shared by the inline form and the A window.
import type { QuickAdd } from '../../src/domain/quickAdd.ts';
import { parseLinearUrl } from '../../src/domain/linear.ts';
import type { DateKey, Placement } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';
import type { LinearStore } from './linear.ts';
import { createTaskCommands } from './commands.ts';

/** Add a parsed line; a pasted Linear issue URL becomes a task linked to that issue, as in Sunsama. */
export const addParsedTask = async (client: PlannerClient, linear: LinearStore, parsed: QuickAdd, fallback: Placement, edge: 'top' | 'bottom', today: DateKey): Promise<void> => {
  const key = parseLinearUrl(parsed.title);
  if (key && linear.getView().connected !== false) {
    try {
      const issue = await linear.issue(key);
      if (issue) {
        const { bodies, taskId } = linear.importCommands(issue, parsed.placement ?? fallback);
        if (parsed.plannedMinutes) bodies.push({ type: 'task.updated', taskId, patch: { plannedMinutes: parsed.plannedMinutes } });
        await client.dispatch(bodies, { undo: `Planned ${issue.identifier}` });
        return;
      }
      client.notify(`${key} was not found in Linear; added the link as a task`);
    } catch {
      client.notify(`Couldn't look up ${key} in Linear; added the link as a task`);
    }
  }
  await client.dispatch(createTaskCommands(client.getView().state, parsed, fallback, edge, today));
};
