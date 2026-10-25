import { liveChannels } from '../../src/domain/selectors.ts';
import { useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';

/** Sunsama's channel filter for the board and Today. */
export const ChannelFilter = () => {
  const view = useView();
  const { ui, setUi } = useUi();
  return (
    <select class="filter" aria-label="Filter by channel" value={ui.channelFilter ?? ''} onChange={(event) => setUi({ channelFilter: event.currentTarget.value || null })}>
      <option value="">All channels</option>
      <option value="ctx:work">Work context</option>
      <option value="ctx:personal">Personal context</option>
      {liveChannels(view.state).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
      <option value="none">No channel</option>
    </select>
  );
};
