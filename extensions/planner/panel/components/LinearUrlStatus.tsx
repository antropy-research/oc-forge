// Sunsama's "Updating Linear issue status when adding via URL": a pasted Linear issue shows its status in the add
// field, to change before the task is added (Enter then moves the issue there as it imports it).
import { useEffect, useState } from 'preact/hooks';
import { pastedUrl } from '../../src/domain/pastedUrl.ts';
import type { LinearIssue, LinearState } from '../../src/domain/linear.ts';
import { usePlanner } from '../lib/context.ts';

export interface UrlStatus {
  issue: LinearIssue | null;
  states: LinearState[];
  stateId: string;
  setStateId: (id: string) => void;
  /** The state to move the issue to as it is added, when one other than its own was picked. */
  chosen: string | undefined;
}

export const useLinearUrlStatus = (title: string): UrlStatus => {
  const { linear } = usePlanner();
  const url = pastedUrl(title);
  const key = url?.kind === 'linear' ? `${url.urlKey}/${url.key}` : '';
  const [issue, setIssue] = useState<LinearIssue | null>(null);
  const [states, setStates] = useState<LinearState[]>([]);
  const [stateId, setStateId] = useState('');
  useEffect(() => {
    setIssue(null);
    setStates([]);
    setStateId('');
    if (url?.kind !== 'linear' || !linear.available()) return;
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        const found = await linear.issue(url.key, url.urlKey).catch(() => null);
        if (!live || !found) return;
        setIssue(found);
        setStateId(found.state.id);
        const list = await linear.statesForIssue(found).catch(() => [] as LinearState[]);
        if (live) setStates(list);
      })();
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  return { issue, states, stateId, setStateId, chosen: issue && stateId && stateId !== issue.state.id ? stateId : undefined };
};

export const LinearUrlStatus = ({ status }: { status: UrlStatus }) =>
  status.issue && status.states.length ? (
    <label class="url-status">
      Status in Linear
      <select aria-label="Status in Linear" value={status.stateId} onChange={(event) => status.setStateId(event.currentTarget.value)}>
        {status.states.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
      </select>
    </label>
  ) : null;
