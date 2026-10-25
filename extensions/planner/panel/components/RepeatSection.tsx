import type { EventBody } from '../../src/domain/events.ts';
import type { Task } from '../../src/domain/types.ts';
import { addDays } from '../../src/domain/dates.ts';
import { describeRule, rulePresets } from '../../src/domain/recurrence.ts';
import { newId } from '../../src/domain/ids.ts';
import { usePlanner, useView } from '../lib/context.ts';

/** Make a task repeat, or manage the series it belongs to. */
export const RepeatSection = ({ task }: { task: Task }) => {
  const { client } = usePlanner();
  const view = useView();
  const series = task.recurrence ? view.state.series[task.recurrence.seriesId] : undefined;
  const anchor = task.placement.kind === 'day' ? task.placement.date : view.today;

  if (!series) {
    return (
      <section class="detail-section repeat" aria-label="Repeat">
        <h3>
          Repeat
          <select
            aria-label="Repeat"
            value=""
            onChange={(event) => {
              const preset = rulePresets(anchor).find((item) => item.id === event.currentTarget.value);
              if (!preset) return;
              void client.dispatch([
                {
                  type: 'series.created',
                  series: {
                    id: newId(),
                    rule: preset.rule,
                    startDate: anchor,
                    template: { title: task.title, notes: task.notes, plannedMinutes: task.plannedMinutes, priority: task.priority, channelId: task.channelId, subtasks: task.subtasks.map((subtask) => subtask.title) },
                  },
                  taskId: task.id,
                },
              ]);
            }}
          >
            <option value="">Doesn't repeat</option>
            {rulePresets(anchor).map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </h3>
      </section>
    );
  }

  const upcoming = Object.values(view.state.tasks).filter(
    (other) => other.id !== task.id && other.recurrence?.seriesId === series.id && !other.deletedAt && !other.completedAt && other.recurrence.date >= view.today,
  );
  const applyToUpcoming = () => {
    const patch = { title: task.title, notes: task.notes, plannedMinutes: task.plannedMinutes, priority: task.priority, channelId: task.channelId };
    const bodies: EventBody[] = [
      { type: 'series.updated', seriesId: series.id, patch: { template: { ...patch, subtasks: task.subtasks.map((subtask) => subtask.title) } } },
      ...upcoming.map((other) => ({ type: 'task.updated', taskId: other.id, patch }) as EventBody),
    ];
    void client.dispatch(bodies).then(() => client.notify(`Updated the series and ${upcoming.length} upcoming instance${upcoming.length === 1 ? '' : 's'}`));
  };
  const stop = () => {
    const from = addDays(view.today, 1);
    const later = upcoming.filter((other) => other.recurrence!.date >= from);
    void client.dispatch([{ type: 'series.stopped', seriesId: series.id, from }, ...later.map((other) => ({ type: 'task.deleted', taskId: other.id }) as EventBody)]);
  };
  return (
    <section class="detail-section repeat" aria-label="Repeat">
      <h3>
        Repeat <span class="repeat-rule">⟳ {describeRule(series.rule, series.startDate)}{series.stoppedFrom ? ` · stopped from ${series.stoppedFrom}` : ''}</span>
      </h3>
      {!series.stoppedFrom && (
        <div class="row">
          <button class="link" onClick={applyToUpcoming}>Apply this task's details to upcoming repeats</button>
          <button class="link danger" onClick={stop}>Stop repeating</button>
        </div>
      )}
    </section>
  );
};
