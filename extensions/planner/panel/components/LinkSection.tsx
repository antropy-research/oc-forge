// The task detail's backlink to a page (a `link` source): a URL pasted alone as a new task's title that is no item
// of a connected tool, as Sunsama's "Tasks from URL", or a Google Calendar event planned from its address.
import type { Task } from '../../src/domain/types.ts';
import { usePlanner } from '../lib/context.ts';

export const LinkTaskSection = ({ task }: { task: Task }) => {
  const { client, host } = usePlanner();
  const source = task.source;
  if (source?.kind !== 'link') return null;
  return (
    <section class="detail-section" aria-label="Link">
      <h3>
        Link
        <span class="source-chip" style={{ '--item-color': '#6e7781' }}><span class="dot" aria-hidden="true" />{source.key}</span>
      </h3>
      <p class="hint link-url">{source.url}</p>
      <div class="row">
        <button class="link" onClick={() => void host.openUrl(source.url)}>Open link</button>
        <button class="link danger" onClick={() => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' })}>Unlink</button>
      </div>
    </section>
  );
};
