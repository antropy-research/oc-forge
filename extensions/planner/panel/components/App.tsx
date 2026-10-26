import { useEffect, useState } from 'preact/hooks';
import { usePlanner, useView } from '../lib/context.ts';
import { UiContext, type UiState } from '../lib/ui.ts';
import { ArchiveView } from './ArchiveView.tsx';
import { Backlog } from './Backlog.tsx';
import { Board } from './Board.tsx';
import { CalendarView } from './CalendarView.tsx';
import { DailyPlanning } from './rituals/DailyPlanning.tsx';
import { DailyShutdown } from './rituals/DailyShutdown.tsx';
import { Highlights } from './rituals/Highlights.tsx';
import { WeeklyPlanning, WeeklyReview } from './rituals/Weekly.tsx';
import { FocusView } from './FocusView.tsx';
import { Settings } from './Settings.tsx';
import { Nav, ServiceGate, Toasts, type Route } from './Shell.tsx';
import { StatusSection } from './StatusSection.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { CompactToday, TodayView } from './TodayView.tsx';
import { StatsView } from './StatsView.tsx';
import { LinearPage, LinearPromptBar } from './LinearPanel.tsx';
import { IssueEditor } from './IssueEditor.tsx';
import { AgentsView } from './Agents.tsx';
import { GitHubPage } from './GitHubPanel.tsx';
import { GooglePage, GooglePromptBar } from './GooglePanel.tsx';
import { isGuestAttachItem } from '@openchamber/sdk';
import { CommandPalette, QuickAddModal } from './CommandPalette.tsx';
import { AssistantModal } from './Assistant.tsx';
import { hoveredTask } from '../lib/hover.ts';
import { moveTo } from '../lib/commands.ts';
import { autoTimebox } from '../lib/autoSchedule.ts';

export const App = ({ surface }: { surface: string }) => {
  const { client, host, linear, agents, github, google } = usePlanner();
  const view = useView();
  const [route, setRoute] = useState<Route>('home');
  const [ui, setUiState] = useState<UiState>({ openTaskId: null, channelFilter: null, focusTaskId: null, folderFilter: null, playlist: false, openIssue: null, agentForm: null });
  const setUi = (patch: Partial<UiState>) => setUiState((current) => ({ ...current, ...patch }));
  const [overlay, setOverlay] = useState<'palette' | 'quickadd' | 'ask' | null>(null);
  const [askText, setAskText] = useState('');

  useEffect(() => {
    // Linear starts after the first snapshot, so its first sync sees the real tasks.
    void client.load().then(() => {
      client.startPolling();
      linear.start();
      void agents.start();
      void github.start();
      void google.start();
    });
  }, [client, linear, agents, github, google]);

  // Clicking a task's chip in a chat opens that task here.
  useEffect(
    () =>
      host.onItem((item) => {
        if (!item || !isGuestAttachItem(item)) return;
        const data = item.data as { taskId?: unknown } | undefined;
        const taskId = typeof data?.taskId === 'string' ? data.taskId : item.id;
        if (client.getView().state.tasks[taskId]) setUi({ openTaskId: taskId });
      }),
    [host, client],
  );

  // Sunsama's keyboard shortcuts, on the full page only and never while typing.
  useEffect(() => {
    if (surface !== 'page') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay('palette');
        return;
      }
      // A page that took the key for itself (the Linear page's F, G then P…) has the last word.
      if (event.defaultPrevented || typing || overlay || ui.openTaskId || ui.openIssue || event.metaKey || event.ctrlKey || event.altKey) return;
      const state = client.getView().state;
      const hovered = hoveredTask();
      const task = hovered ? state.tasks[hovered] : undefined;
      switch (event.key.toLowerCase()) {
        case 'a': setOverlay('quickadd'); break;
        case 't': setRoute('today'); break;
        case 'f': setRoute('focus'); break;
        case 'p': setRoute('planning'); break;
        case 'o': setRoute('shutdown'); break;
        case 'c':
          if (route === 'focus' || !task) return;
          void client.dispatch([task.completedAt ? { type: 'task.reopened', taskId: task.id } : { type: 'task.completed', taskId: task.id, on: client.getView().today }]);
          break;
        case 'z':
          if (!task || task.placement.kind === 'backlog') return;
          void client.dispatch([moveTo(state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')], { undo: 'Moved to backlog' });
          break;
        case 'x':
          if (!task || task.completedAt) return;
          void autoTimebox(client, state, client.getView().today, task, task.placement.kind === 'day' ? task.placement.date : client.getView().today).then((problem) => problem && client.notify(problem));
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!view.loaded) return surface === 'status' ? null : <ServiceGate />;
  if (surface === 'status') {
    return (
      <UiContext.Provider value={{ ui, setUi }}>
        <StatusSection host={host} />
      </UiContext.Provider>
    );
  }
  return (
    <UiContext.Provider value={{ ui, setUi }}>
      {surface === 'panel' ? (
        <CompactToday />
      ) : (
        <div class="app">
          <Nav route={route} onRoute={setRoute} onSearch={() => setOverlay('palette')} onAsk={() => { setAskText(''); setOverlay('ask'); }} />
          <main class="main">
            {route === 'home' && <Board />}
            {route === 'today' && <TodayView onShutdown={() => setRoute('shutdown')} />}
            {route === 'calendar' && <CalendarView />}
            {route === 'focus' && <FocusView onExit={() => setRoute('today')} />}
            {route === 'planning' && <DailyPlanning onDone={() => setRoute('today')} />}
            {route === 'shutdown' && <DailyShutdown onDone={() => setRoute('highlights')} />}
            {route === 'highlights' && <Highlights />}
            {route === 'weeklyPlanning' && <WeeklyPlanning onDone={() => setRoute('home')} />}
            {route === 'weeklyReview' && <WeeklyReview />}
            {route === 'backlog' && <Backlog />}
            {route === 'linear' && <LinearPage />}
            {route === 'agents' && <AgentsView />}
            {route === 'github' && <GitHubPage />}
            {route === 'google' && <GooglePage />}
            {route === 'archive' && <ArchiveView />}
            {route === 'stats' && <StatsView />}
            {route === 'settings' && <Settings />}
          </main>
        </div>
      )}
      {ui.openTaskId && <TaskDetail key={ui.openTaskId} taskId={ui.openTaskId} />}
      {ui.openIssue && <IssueEditor key={`${ui.openIssue.workspaceId}:${ui.openIssue.id}`} issueRef={ui.openIssue} />}
      {overlay === 'palette' && (
        <CommandPalette
          onClose={() => setOverlay(null)}
          onRoute={setRoute}
          onAddTask={() => setOverlay('quickadd')}
          onAsk={(query) => {
            setAskText(query);
            setOverlay('ask');
          }}
        />
      )}
      {overlay === 'ask' && <AssistantModal initial={askText} onClose={() => setOverlay(null)} />}

      {overlay === 'quickadd' && <QuickAddModal onClose={() => setOverlay(null)} />}
      <LinearPromptBar />
      <GooglePromptBar />
      <Toasts />
    </UiContext.Provider>
  );
};
