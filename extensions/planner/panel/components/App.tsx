import { useEffect, useRef, useState } from 'preact/hooks';
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
import { Nav, NavRail, ServiceGate, Toasts, useNarrow, type Route } from './Shell.tsx';
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
import { parseRoute, routeOf } from '../lib/deepLink.ts';
import { openInNewTab, placeUrl, plannerKeeps, useForge, watchNewTabClicks } from '../lib/forge.ts';

export const App = ({ surface }: { surface: string }) => {
  const { client, host, linear, agents, github, google } = usePlanner();
  const view = useView();
  const [route, setRoute] = useState<Route>('home');
  // A narrow page folds the menu into a rail; it opens over the page and closes on a pick.
  const narrow = useNarrow();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (navOpen) (document.querySelector<HTMLElement>('#planner-nav .nav-item.is-active') ?? document.querySelector<HTMLElement>('#planner-nav .nav-item'))?.focus();
  }, [navOpen]);
  const closeNav = () => {
    setNavOpen(false);
    document.querySelector<HTMLElement>('.nav-rail-button[aria-controls="planner-nav"]')?.focus();
  };
  // oc-forge's host APIs (null on a stock OpenChamber): a Cmd/Ctrl+click or a middle click on a page, a task or an
  // issue opens it on the Planner's page in a new browser tab, as on a link; a plain click goes there here.
  const forge = useForge();
  const go = (next: Route) => {
    if (openInNewTab(placeUrl({ page: next }), (url) => host.openUrl(url))) return;
    setRoute(next);
    setNavOpen(false);
  };
  const [ui, setUiState] = useState<UiState>({ openTaskId: null, channelFilter: null, focusTaskId: null, folderFilter: null, playlist: false, openIssue: null, agentForm: null });
  const setUi = (patch: Partial<UiState>) => {
    if (patch.openIssue || patch.openTaskId) {
      // From the rail panel's Today, a task opens on the page's Today.
      const page = surface === 'page' ? route : 'today';
      const place = patch.openIssue ? { page, openIssue: patch.openIssue } : { page, openTaskId: patch.openTaskId };
      if (openInNewTab(placeUrl(place), (url) => host.openUrl(url))) return;
    }
    setUiState((current) => ({ ...current, ...patch }));
  };
  useEffect(() => watchNewTabClicks(), []);
  // A deep link (or back and forward) puts the page on its place; then the address bar follows the page.
  const [linkApplied, setLinkApplied] = useState(false);
  useEffect(() => {
    if (!forge || surface !== 'page') return;
    const apply = (value: string | null) => {
      const place = parseRoute(value);
      if (place) {
        setRoute(place.page);
        setUiState((current) => ({ ...current, openTaskId: place.openTaskId ?? null, openIssue: place.openIssue ?? null }));
      }
      setLinkApplied(true);
    };
    apply(forge.links.route());
    return forge.links.onRoute(apply);
  }, [forge, surface]);
  useEffect(() => {
    if (!forge || surface !== 'page' || !linkApplied) return;
    void forge.links.setRoute(routeOf({ page: route, openTaskId: ui.openTaskId, openIssue: ui.openIssue })).catch(() => {});
  }, [forge, surface, linkApplied, route, ui.openTaskId, ui.openIssue?.id, ui.openIssue?.workspaceId]);
  // OpenChamber's own navigation keys (tabs, surfaces, chats, sidebar, its palette) go to OpenChamber while the
  // Planner has focus, not to Chrome; the Planner keeps what it uses itself (plannerKeeps).
  const routeNow = useRef(route);
  routeNow.current = route;
  useEffect(() => {
    if (!forge) return;
    return forge.keys.forwardHostShortcuts({ except: (_action, event) => plannerKeeps(event, { surface, page: routeNow.current }) });
  }, [forge, surface]);
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
        <div class={`app${narrow ? ' is-narrow' : ''}${navOpen ? ' is-nav-open' : ''}`}>
          {narrow && <NavRail open={navOpen} onToggle={() => (navOpen ? closeNav() : setNavOpen(true))} onSearch={() => setOverlay('palette')} />}
          {(!narrow || navOpen) && (
            <Nav
              route={route}
              onRoute={go}
              onSearch={() => { setNavOpen(false); setOverlay('palette'); }}
              onAsk={() => { setNavOpen(false); setAskText(''); setOverlay('ask'); }}
              onClose={narrow ? closeNav : undefined}
            />
          )}
          {narrow && navOpen && <div class="nav-scrim" aria-hidden="true" onClick={closeNav} />}
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
