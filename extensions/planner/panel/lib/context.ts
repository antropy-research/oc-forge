import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { HostClient } from '@openchamber/sdk';
import type { ClientView, PlannerClient } from './client.ts';
import type { LinearStore, LinearView } from './linear.ts';
import type { AgentStore, AgentView } from './agents.ts';
import type { GitHubStore, GitHubView } from './github.ts';
import type { GoogleStore, GoogleView } from './google.ts';

export interface PlannerContextValue {
  client: PlannerClient;
  host: HostClient;
  linear: LinearStore;
  agents: AgentStore;
  github: GitHubStore;
  google: GoogleStore;
}

export const PlannerContext = createContext<PlannerContextValue | null>(null);

export const usePlanner = (): PlannerContextValue => {
  const value = useContext(PlannerContext);
  if (!value) throw new Error('PlannerContext is missing');
  return value;
};

/** Re-render on every client change. */
export const useView = (): ClientView => {
  const { client } = usePlanner();
  const [view, setView] = useState(client.getView());
  useEffect(() => client.subscribe(() => setView(client.getView())), [client]);
  return view;
};

/** Re-render on every Linear change. */
export const useLinear = (): LinearView => {
  const { linear } = usePlanner();
  const [view, setView] = useState(linear.getView());
  useEffect(() => {
    // A change between the first render and this subscription would otherwise be missed.
    setView(linear.getView());
    return linear.subscribe(() => setView(linear.getView()));
  }, [linear]);
  return view;
};

/** Re-render on every agent change. */
export const useAgents = (): AgentView => {
  const { agents } = usePlanner();
  const [view, setView] = useState(agents.getView());
  useEffect(() => agents.subscribe(() => setView(agents.getView())), [agents]);
  return view;
};

/** Re-render on every GitHub change. */
export const useGitHub = (): GitHubView => {
  const { github } = usePlanner();
  const [view, setView] = useState(github.getView());
  useEffect(() => github.subscribe(() => setView(github.getView())), [github]);
  return view;
};

/** Re-render on every Google change. */
export const useGoogle = (): GoogleView => {
  const { google } = usePlanner();
  const [view, setView] = useState(google.getView());
  useEffect(() => google.subscribe(() => setView(google.getView())), [google]);
  return view;
};

/** Drag payload type for task cards. */
export const DRAG_TYPE = 'application/x-planner-task';
/** Drag payload type for a Linear issue (the issue as JSON). */
export const LINEAR_DRAG_TYPE = 'application/x-planner-linear';
/** Drag payload type for a GitHub issue or pull request (the item as JSON). */
export const GITHUB_DRAG_TYPE = 'application/x-planner-github';
/** Drag payload type for a Google task or a Gmail message (a GoogleDrag as JSON). */
export const GOOGLE_DRAG_TYPE = 'application/x-planner-google';
