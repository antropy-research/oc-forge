import { useState } from 'preact/hooks';
import { HostRequestError } from '@openchamber/sdk';
import type { DateKey, Highlight, RitualRecord } from '../../../src/domain/types.ts';
import { addDays, clockLabel, formatMinutes, instantAt, monthDay, weekdayName, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { actualMinutes, tasksForDay } from '../../../src/domain/selectors.ts';
import { completedOnDay, highlightItems, ritualRecord } from '../../../src/domain/rituals.ts';
import { ACTIVITY_SECTIONS, ACTIVITY_SOURCE_NOUNS, activityGroups, activityLabel, activityMoreUrl, activityText, type ActivityGroup } from '../../../src/domain/githubActivity.ts';
import { newId } from '../../../src/domain/ids.ts';
import { useGitHub, usePlanner, useView } from '../../lib/context.ts';
import { useGitHubActivity } from '../../lib/githubActivity.ts';
import { GitHubSignIn } from '../GitHubPanel.tsx';
import { ExternalLink } from '../ExternalLink.tsx';
import { ChannelBreakdown, TimeSummary } from './DailyShutdown.tsx';

/** A highlight included from GitHub's activity names it by this, so the activity shows as included. */
const githubRef = (group: ActivityGroup): string => `github:${group.key}`;

/**
 * The day's GitHub work in Other activities, as Sunsama's GitHub integration surfaces it in the end-of-day review:
 * pull requests opened, reviewed and merged, comments, discussions; each opens on GitHub, and Include adds it to the
 * highlights. Not connected: how to connect, as the GitHub source says it.
 */
const GitHubActivity = ({ date, included, onInclude }: { date: DateKey; included: (ref: string) => boolean; onInclude: (group: ActivityGroup) => void }) => {
  const { client } = usePlanner();
  const view = useView();
  const gv = useGitHub();
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = Boolean(gv.status?.available);
  const activity = useGitHubActivity(client, date, zone, available);
  const groups = activity.read ? activityGroups(activity.read.items) : [];
  const login = activity.read?.login || gv.status?.login || '';
  return (
    <section class="activity-source" aria-label="GitHub activity">
      <h3>
        GitHub {login && <span class="muted">@{login}</span>}
        {available && <button class="icon-button" aria-label="Refresh GitHub activity" title="Read the day from GitHub again" disabled={activity.loading} onClick={activity.refresh}>↻</button>}
      </h3>
      {!gv.status && <p class="hint">Checking GitHub…</p>}
      {gv.status && !available && <GitHubSignIn />}
      {available && activity.loading && !activity.read && <p class="hint">Reading your GitHub activity…</p>}
      {available && activity.error && (
        <p class="feed-errors" role="alert">
          {activity.error} <button class="link" onClick={activity.refresh}>Try again</button>
        </p>
      )}
      {available && activity.read && groups.length === 0 && <p class="hint">No GitHub activity on this day.</p>}
      {ACTIVITY_SECTIONS.map((section) => {
        const rows = groups.filter((group) => section.kinds.includes(group.kind));
        if (!rows.length) return null;
        return (
          <div key={section.title} class="activity-group" role="group" aria-label={section.title}>
            <h4>{section.title}</h4>
            <ul class="activity-list">
              {rows.map((group) => (
                <li key={group.key} class="activity-row">
                  <span class={`activity-kind is-${group.kind}`}>{activityLabel(group)}</span>
                  <ExternalLink className="activity-title" href={group.url} label={`${activityText(group)} on GitHub`}>
                    <span class="activity-ref">{group.target.repo}#{group.target.number}</span> {group.target.title}
                  </ExternalLink>
                  <span class="muted activity-time">{clockLabel(zonedDateMinutes(group.at, zone).minutes)}</span>
                  {included(githubRef(group)) ? (
                    <span class="muted activity-included">Included</span>
                  ) : (
                    <button class="link activity-include" aria-label={`Include ${activityText(group)}`} onClick={() => onInclude(group)}>Include</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {activity.read?.cut.map((source) => (
        <p key={source} class="hint" role="note">
          GitHub has more {ACTIVITY_SOURCE_NOUNS[source]} than the Planner read{activity.read?.totals[source] !== undefined ? ` (${activity.read.totals[source]} in all)` : ''}:{' '}
          <ExternalLink href={activityMoreUrl(source, login, instantAt(date, 0, zone), instantAt(addDays(date, 1), 0, zone))}>see the rest on GitHub</ExternalLink>
        </p>
      ))}
    </section>
  );
};

/** Sunsama's Daily Highlights: what you got done, starred and summarized, then published. */
export const Highlights = () => {
  const { client, host } = usePlanner();
  const view = useView();
  const [date, setDate] = useState<DateKey>(view.today);
  const [summarizing, setSummarizing] = useState(false);
  const [draft, setDraft] = useState('');
  const record = ritualRecord(view.state, 'highlights', date);
  const done = completedOnDay(view.state, date);
  // Saved items plus anything completed since; hidden ones are kept but not shown.
  const all: Highlight[] = highlightItems(view.state, date);
  const items = all.filter((item) => !item.hidden);
  const save = (fields: RitualRecord) => void client.dispatch([{ type: 'ritual.saved', ritual: 'highlights', date, fields }]);
  const setItems = (next: Highlight[]) => save({ items: next });
  const replace = (id: string, change: (item: Highlight) => Highlight | null) =>
    setItems(all.flatMap((item) => {
      if (item.id !== id) return [item];
      const next = change(item);
      return next ? [next] : [];
    }));
  // Swap with the nearest visible neighbour, so hidden items never block a move.
  const move = (id: string, delta: number) => {
    const visibleIndex = items.findIndex((item) => item.id === id);
    const neighbour = items[visibleIndex + delta];
    if (!neighbour) return;
    const next = [...all];
    const a = next.findIndex((item) => item.id === id);
    const b = next.findIndex((item) => item.id === neighbour.id);
    [next[a], next[b]] = [next[b]!, next[a]!];
    setItems(next);
  };
  const ordered = [...items.filter((item) => item.starred), ...items.filter((item) => !item.starred)];
  const asText = [`Highlights for ${weekdayName(date)}, ${monthDay(date)}`, ...ordered.map((item) => `${item.starred ? '★' : '-'} ${item.text}${item.url ? ` (${item.url})` : ''}`), record.summary ? `\n${record.summary}` : '', record.reflection ? `\nReflection: ${record.reflection}` : ''].join('\n').trim();
  // Other activities, as Sunsama's: the day's tasks not among the highlights (completed ones removed from them, and
  // the day's open ones), and the day's GitHub work; Include adds one to the highlights.
  const removed = all.filter((item) => item.hidden && item.taskId);
  const open = tasksForDay(view.state, date).filter((task) => !task.completedAt && !all.some((item) => item.taskId === task.id));
  const included = (ref: string) => all.some((item) => item.ref === ref && !item.hidden);
  const includeGitHub = (group: ActivityGroup) => {
    if (included(githubRef(group))) return;
    setItems([...all, { id: newId(), text: activityText(group).slice(0, 1000), taskId: null, starred: false, url: group.url, ref: githubRef(group) }]);
  };

  const summarize = async () => {
    setSummarizing(true);
    try {
      const minutes = done.reduce((sum, task) => sum + actualMinutes(view.state, task), 0);
      const { text } = await host.generate({
        system: 'You write a short, plain summary of one person\'s workday from their list of accomplishments. Two or three sentences, first person, no headings, no bullet points, no filler.',
        prompt: `Accomplishments on ${monthDay(date)} (${formatMinutes(minutes)} of tracked work):\n${items.map((item) => `- ${item.text}${item.starred ? ' (highlight)' : ''}`).join('\n')}${record.reflection ? `\nTheir reflection: ${record.reflection}` : ''}`,
        maxOutputTokens: 300,
      });
      save({ summary: text.trim() });
    } catch (error) {
      const code = error instanceof HostRequestError ? error.code : '';
      client.notify(
        code === 'MODEL_FAILED' || code === 'NO_MODEL'
          ? 'No model can write summaries yet. Add a provider key, or choose a Small Model in OpenChamber settings.'
          : `Summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <section class="view ritual">
      <header class="view-header">
        <h1>Daily highlights</h1>
        <span class="view-sub">{weekdayName(date)}, {monthDay(date)}{record.publishedAt ? ' · published' : ''}</span>
        <div class="date-nav">
          <button aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <button onClick={() => setDate(view.today)} disabled={date === view.today}>Today</button>
          <button aria-label="Next day" onClick={() => setDate(addDays(date, 1))} disabled={date >= view.today}>›</button>
        </div>
      </header>
      <div class="ritual-layout has-aside">
        <div class="ritual-body">
          <div class="ritual-section">
            <h2>Highlights</h2>
            <p class="hint">Star what mattered most; remove the noise; add work that never was a task.</p>
            <ul class="highlights">
              {items.map((item, index) => (
                <li key={item.id} class={item.starred ? 'is-starred' : ''}>
                  <button class="star" aria-label={item.starred ? `Unstar ${item.text}` : `Star ${item.text}`} aria-pressed={item.starred} onClick={() => replace(item.id, (other) => ({ ...other, starred: !other.starred }))}>
                    {item.starred ? '★' : '☆'}
                  </button>
                  <input
                    class="highlight-text"
                    aria-label="Highlight"
                    key={`${item.id}-${item.text}`}
                    defaultValue={item.text}
                    onBlur={(event) => {
                      const text = event.currentTarget.value.trim();
                      if (text && text !== item.text) replace(item.id, (other) => ({ ...other, text }));
                    }}
                  />
                  <span class="highlight-actions">
                    {item.url && <ExternalLink className="highlight-open" href={item.url} label={`Open ${item.text}`}>↗</ExternalLink>}
                    <button aria-label="Move up" disabled={index === 0} onClick={() => move(item.id, -1)}>↑</button>
                    <button aria-label="Move down" disabled={index === items.length - 1} onClick={() => move(item.id, 1)}>↓</button>
                    <button aria-label={`Remove ${item.text}`} class="danger" onClick={() => replace(item.id, (other) => (other.taskId ? { ...other, hidden: true } : null))}>×</button>
                  </span>
                </li>
              ))}
              {items.length === 0 && <li class="empty">Nothing completed on this day.</li>}
            </ul>
            <input
              class="subtask-add"
              value={draft}
              placeholder="Add another accomplishment"
              aria-label="Add highlight"
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !draft.trim()) return;
                setItems([...all, { id: newId(), text: draft.trim(), taskId: null, starred: false }]);
                setDraft('');
              }}
            />
          </div>
          <div class="ritual-section other-activities" role="region" aria-label="Other activities">
            <h2>Other activities</h2>
            <p class="hint">Only you see these. Include one to add it to your highlights.</p>
            <section class="activity-source" aria-label="Tasks">
              <h3>Tasks</h3>
              <ul class="activity-list">
                {removed.map((item) => (
                  <li key={item.id} class="activity-row">
                    <span class="activity-kind is-done">Done</span>
                    <span class="activity-title">{item.text}</span>
                    <button class="link activity-include" aria-label={`Include ${item.text}`} onClick={() => replace(item.id, (other) => ({ ...other, hidden: false }))}>Include</button>
                  </li>
                ))}
                {open.map((task) => (
                  <li key={task.id} class="activity-row">
                    <span class="activity-kind is-open">Not done</span>
                    <span class="activity-title">{task.title}</span>
                    <button class="link activity-include" aria-label={`Include ${task.title}`} onClick={() => setItems([...all, { id: newId(), text: task.title, taskId: task.id, starred: false }])}>Include</button>
                  </li>
                ))}
                {removed.length === 0 && open.length === 0 && <li class="empty">Every task of the day is in your highlights.</li>}
              </ul>
            </section>
            <GitHubActivity date={date} included={included} onInclude={includeGitHub} />
          </div>
          <div class="ritual-section">
            <h2>Summary <button class="link" disabled={summarizing || items.length === 0} onClick={() => void summarize()}>{summarizing ? 'Summarizing…' : record.summary ? 'Summarize again' : 'Summarize with AI'}</button></h2>
            <textarea rows={3} aria-label="Summary" key={`summary-${date}-${record.summary ?? ''}`} defaultValue={record.summary ?? ''} placeholder="Optional: a few sentences about the day" onBlur={(event) => event.currentTarget.value !== (record.summary ?? '') && save({ summary: event.currentTarget.value })} />
          </div>
          <div class="ritual-section">
            <h2>Personal reflection</h2>
            <textarea rows={4} aria-label="Personal reflection" key={`reflection-${date}`} defaultValue={record.reflection ?? ''} onBlur={(event) => event.currentTarget.value !== (record.reflection ?? '') && save({ reflection: event.currentTarget.value })} />
          </div>
          <div class="row">
            <button class="primary" onClick={() => save({ items: all, publishedAt: new Date().toISOString(), completedAt: new Date().toISOString() })}>{record.publishedAt ? 'Publish again' : 'Publish'}</button>
            <button onClick={() => void host.writeClipboard(asText).then(() => client.notify('Highlights copied')).catch(() => client.notify('Could not copy'))}>Copy as text</button>
            {record.publishedAt && <button class="link" onClick={() => save({ publishedAt: null })}>Unpublish</button>}
          </div>
        </div>
        <aside class="side-panel ritual-aside">
          <h2>Time</h2>
          <TimeSummary tasks={done} />
          <ChannelBreakdown tasks={done} />
        </aside>
      </div>
    </section>
  );
};
