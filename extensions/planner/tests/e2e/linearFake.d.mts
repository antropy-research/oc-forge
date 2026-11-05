// Types for linearFake.mjs, so the TypeScript tests can use it.
/** The fake Linear's world (defaultLinearWorld): its organization, viewer, teams, states, issues, views and more. */
export type LinearWorld = Record<string, any> & {
  org: { id: string; name: string; urlKey: string };
  viewer: { id: string; name: string };
  issues: any[];
  views: any[];
};
/** A small Linear world: one workspace, four states, a team, issues, saved views, projects, members, labels. */
export function defaultLinearWorld(): LinearWorld;
/** Linear's answer (the `data`) to one of the Planner's documents, by operation name; null when unknown. */
export function answerLinear(world: LinearWorld, op: string | undefined, variables?: Record<string, unknown>): any;
export function compare(value: unknown, comparator: Record<string, unknown>): boolean;
export function makeFilters(options: { viewerId: string; cycleFlags?: (id: string) => Record<string, unknown>; childrenOf?: (id: string) => unknown[] }): any;
export function page<T>(nodes: T[], first?: number, after?: string | null): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
