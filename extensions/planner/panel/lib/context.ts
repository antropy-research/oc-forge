import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { HostClient } from '@openchamber/sdk';
import type { ClientView, PlannerClient } from './client.ts';
import type { LinearStore, LinearView } from './linear.ts';
import type { AgentStore, AgentView } from './agents.ts';

export interface PlannerContextValue {
  client: PlannerClient;
  host: HostClient;
  linear: LinearStore;
  agents: AgentStore;
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
  useEffect(() => linear.subscribe(() => setView(linear.getView())), [linear]);
  return view;
};

/** Re-render on every agent change. */
export const useAgents = (): AgentView => {
  const { agents } = usePlanner();
  const [view, setView] = useState(agents.getView());
  useEffect(() => agents.subscribe(() => setView(agents.getView())), [agents]);
  return view;
};

/** Drag payload type for task cards. */
export const DRAG_TYPE = 'application/x-planner-task';
/** Drag payload type for a Linear issue (the issue as JSON). */
export const LINEAR_DRAG_TYPE = 'application/x-planner-linear';
