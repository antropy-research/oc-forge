// Pieces the Linear page and the side panels share.
import { usePlanner } from '../../lib/context.ts';
import type { LinearView } from '../../lib/linear.ts';

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Nothing to read: OpenChamber is not connected and no workspace was added with a key. */
export const needsConnect = (lv: LinearView): boolean => lv.connected === false && lv.workspaces.length === 0;

/** A workspace's name, shown only while more than one is connected. */
export const workspaceLabel = (lv: LinearView, id: string | null | undefined): string | null =>
  lv.workspaces.length > 1 ? lv.workspaces.find((workspace) => workspace.id === id)?.name ?? null : null;

export const workspaceNames = (lv: LinearView): Map<string, string> => new Map(lv.workspaces.map((workspace) => [workspace.id, workspace.name]));

export const excerpt = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export const ConnectLinear = () => {
  const { linear, client } = usePlanner();
  return (
    <div class="connect-linear">
      <p>Connect Linear to plan your issues here. Planner uses OpenChamber's own Linear connection; more workspaces can be added with an API key in Settings.</p>
      <button class="primary" onClick={() => void linear.connect().catch((error) => client.notify(`Could not start the Linear connection: ${messageOf(error)}`))}>Connect Linear</button>
    </div>
  );
};

/**
 * What failed for a list: per workspace while several are connected (the
 * others still answer), else the one error.
 */
export const LinearErrors = ({ error, workspaceIds }: { error: string | null; workspaceIds: readonly string[] }) => {
  const { linear } = usePlanner();
  const lv = linear.getView();
  if (lv.workspaces.length < 2) return error ? <p class="feed-errors" role="alert">{error}</p> : null;
  const failed = lv.workspaces.filter((workspace) => workspace.error && workspaceIds.includes(workspace.id));
  return failed.length ? <p class="feed-errors" role="alert">{failed.map((workspace) => `${workspace.name}: ${workspace.error}`).join(' · ')}</p> : null;
};
