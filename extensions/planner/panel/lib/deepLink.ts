// The Planner's place as a route string, for deep links into its page (Cmd+click
// opens it in a new browser tab) and for the address bar while the page shows:
// a page, then the task or Linear issue open over it.
//
//   /calendar                          the Calendar page
//   /today?task=<task id>              Today, with that task's details open
//   /linear?issue=<id>&workspace=<id>  Linear, with that issue in the editor
import type { Route } from '../components/Shell.tsx';

export const ROUTES: readonly Route[] = [
  'home',
  'today',
  'calendar',
  'focus',
  'planning',
  'shutdown',
  'highlights',
  'weeklyPlanning',
  'weeklyReview',
  'backlog',
  'linear',
  'github',
  'google',
  'agents',
  'archive',
  'stats',
  'settings',
];

export interface PlannerPlace {
  page: Route;
  openTaskId?: string | null;
  openIssue?: { id: string; workspaceId: string | null } | null;
}

/** Ids are opaque strings; anything longer or stranger than this is not one of ours. */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

export const routeOf = (place: PlannerPlace): string => {
  const query = new URLSearchParams();
  if (place.openIssue) {
    query.set('issue', place.openIssue.id);
    if (place.openIssue.workspaceId) query.set('workspace', place.openIssue.workspaceId);
  } else if (place.openTaskId) {
    query.set('task', place.openTaskId);
  }
  const search = query.toString();
  return `/${place.page}${search ? `?${search}` : ''}`;
};

/** The place a route names, or null for one that names nothing the Planner has (left as it is). */
export const parseRoute = (route: string | null | undefined): PlannerPlace | null => {
  if (!route) return null;
  const match = /^\/([A-Za-z]+)(?:\?(.*))?$/.exec(route.trim());
  if (!match) return null;
  const page = ROUTES.find((item) => item === match[1]);
  if (!page) return null;
  const query = new URLSearchParams(match[2] ?? '');
  const issue = query.get('issue');
  const workspace = query.get('workspace');
  const task = query.get('task');
  if (issue && ID.test(issue)) return { page, openTaskId: null, openIssue: { id: issue, workspaceId: workspace && ID.test(workspace) ? workspace : null } };
  if (task && ID.test(task)) return { page, openTaskId: task, openIssue: null };
  return { page, openTaskId: null, openIssue: null };
};

/**
 * A click the browser would open in a new tab on a link: Cmd (macOS) or Ctrl
 * held, or the middle button. Shift (a new window) is left to the browser too.
 */
export const isNewTabClick = (event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): boolean =>
  event.button === 1 || ((event.button === 0 || event.button === undefined) && (event.metaKey || event.ctrlKey || event.shiftKey));
