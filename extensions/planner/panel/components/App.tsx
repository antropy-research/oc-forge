import { useEffect, useRef, useState } from 'preact/hooks';
import { openSource } from '../lib/sourcePanel.ts';
import { sourceUrl } from '../../src/domain/gmail.ts';
import { usePlanner, useView } from '../lib/context.ts';
import { isFullSurface, UiContext, type UiState } from '../lib/ui.ts';
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
import { TodayView } from './TodayView.tsx';
import { StatsView } from './StatsView.tsx';
import { LinearPage, LinearPromptBar } from './LinearPanel.tsx';
import { GmailPromptBar } from './GmailPanel.tsx';
import { IssueEditor } from './IssueEditor.tsx';
import { AgentsView } from './Agents.tsx';
import { GitHubPage } from './GitHubPanel.tsx';
import { GooglePage, GooglePromptBar } from './GooglePanel.tsx';
import { isGuestAttachItem } from '@openchamber/sdk';
import { CommandPalette, QuickAddModal } from './CommandPalette.tsx';
import { AssistantModal } from './Assistant.tsx';
import { hoveredSource, hoveredTask } from '../lib/hover.ts';
import { moveTo } from '../lib/commands.ts';
import { autoTimebox } from '../lib/autoSchedule.ts';
import { startTaskNotifications } from '../lib/notifications.ts';
import { parseRoute } from '../lib/deepLink.ts';
import { openInNewTab, placeUrl, plannerKeeps, useForge, watchNewTabClicks } from '../lib/forge.ts';
import { followPanel, trackPanelShown } from '../lib/follow.ts';
import { readPlace, savePlace } from '../lib/place.ts';

export const App = ({ surface }: { surface: string }) => {
  const { client, host, linear, agents, github, google } = usePlanner();
  // The rail panel draws the whole Planner, as a page does.
  const full = isFullSurface(surface);
  // A new frame starts on the page the Planner was on (this browser's storage), unless a deep link names a place.
  const [placeRead, setPlaceRead] = useState(!full);
  const linked = useRef(false);
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
  // The chat on screen: a new tab opens on it, the Planner beside it.
  const session = useRef<string | null>(null);
  useEffect(() => host.onSession((snapshot) => {
    session.current = snapshot?.id ?? null;
  }), [host]);
  const go = (next: Route) => {
    if (openInNewTab(placeUrl({ page: next }, session.current), (url) => host.openUrl(url))) return;
    setRoute(next);
    setNavOpen(false);
  };
  const [ui, setUiState] = useState<UiState>({ openTaskId: null, channelFilter: null, focusTaskId: null, folderFilter: null, playlist: false, openIssue: null, agentForm: null });
  const setUi = (patch: Partial<UiState>) => {
    if (patch.openIssue || patch.openTaskId) {
      // From the Work Status section's Today, a task opens on the Planner's Today.
      const page = full ? route : 'today';
      const place = patch.openIssue ? { page, openIssue: patch.openIssue } : { page, openTaskId: patch.openTaskId };
      if (openInNewTab(placeUrl(place, session.current), (url) => host.openUrl(url))) return;
    }
    setUiState((current) => ({ ...current, ...patch }));
  };
  useEffect(() => watchNewTabClicks(), []);
  // A deep link (or back and forward) puts the Planner on its place.
  useEffect(() => {
    if (!forge || !full) return;
    const apply = (value: string | null) => {
      const place = parseRoute(value);
      if (place) {
        linked.current = true;
        setRoute(place.page);
        setUiState((current) => ({ ...current, openTaskId: place.openTaskId ?? null, openIssue: place.openIssue ?? null }));
      }
    };
    apply(forge.links.route());
    return forge.links.onRoute(apply);
  }, [forge, full]);
  useEffect(() => {
    if (!full) return;
    let live = true;
    void readPlace(host).then((place) => {
      if (!live) return;
      if (place && !linked.current) setRoute(place.page);
      setPlaceRead(true);
    });
    return () => {
      live = false;
    };
  }, [host, full]);
  useEffect(() => {
    if (!full || !placeRead) return;
    const timer = setTimeout(() => savePlace(host, { page: route }), 300);
    return () => clearTimeout(timer);
  }, [host, full, placeRead, route]);
  // One Planner for the window: the rail panel says when it is on screen, and the Work Status section, which stays
  // through chat switches, shows the panel in the folder of the next chat (lib/follow.ts).
  useEffect(() => (surface === 'panel' ? trackPanelShown(host) : surface === 'status' ? followPanel(host) : undefined), [host, surface]);
  // OpenChamber's own navigation keys (tabs, surfaces, chats, sidebar, its palette) go to OpenChamber while the
  // Planner has focus, not to Chrome; the Planner keeps what it uses itself (plannerKeeps).
  const routeNow = useRef(route);
  routeNow.current = route;
  useEffect(() => {
    if (!forge) return;
    return forge.keys.forwardHostShortcuts({ except: (_action, event) => plannerKeeps(event, { surface, page: routeNow.current, mac: forge.keys.shortcuts().mac }) });
  }, [forge, surface]);
  const [overlay, setOverlay] = useState<'palette' | 'quickadd' | 'ask' | null>(null);
  const [askText, setAskText] = useState('');

  useEffect(() => {
    // Linear starts after the first snapshot, so its first sync sees the real tasks.
    let live = true;
    let stopNotifications = () => {};
    void client.load().then(() => {
      client.startPolling();
      linear.start();
      void agents.start();
      void github.start();
      void google.start();
      // Google Calendar's task notifications, which the Planner gives while one of its surfaces is open.
      if (live) stopNotifications = startTaskNotifications(host, client, surface);
    });
    return () => {
      live = false;
      stopNotifications();
    };
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

  // Sunsama's keyboard shortcuts, wherever the whole Planner shows and never while typing.
  useEffect(() => {
    if (!full) return;
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
          // Shift C: the calendar in the right-hand panel (Sunsama's).
          if (event.shiftKey) {
            if (route !== 'home' && route !== 'today') setRoute('home');
            openSource('calendar');
            break;
          }
          if (route === 'focus' || !task) return;
          void client.dispatch([task.completedAt ? { type: 'task.reopened', taskId: task.id } : { type: 'task.completed', taskId: task.id, on: client.getView().today }]);
          break;
        case 'z':
          if (!task || task.placement.kind === 'backlog') return;
          void client.dispatch([moveTo(state, task.id, { kind: 'backlog', bucket: 'next-weeks' }, 'top')], { undo: 'Moved to backlog' });
          break;
        case 'g':
          // Shift G: Gmail in the right-hand panel; G: the hovered task's item in its tool (Sunsama's shortcuts).
          if (event.shiftKey) {
            if (route !== 'home' && route !== 'today') setRoute('home');
            openSource('mail');
            break;
          }
          {
            const item = hoveredSource() ?? task?.source;
            if (!item) return;
            void host.openUrl(sourceUrl(item, state.settings));
          }
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

  if (!view.loaded || !placeRead) return surface === 'status' ? null : <ServiceGate />;
  if (surface === 'status') {
    return (
      <UiContext.Provider value={{ ui, setUi }}>
        <StatusSection host={host} />
      </UiContext.Provider>
    );
  }
  return (
    <UiContext.Provider value={{ ui, setUi }}>
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
      <GmailPromptBar />
      <Toasts />
    </UiContext.Provider>
  );
};
