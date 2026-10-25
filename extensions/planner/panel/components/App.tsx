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

export const App = ({ surface }: { surface: string }) => {
  const { client, host } = usePlanner();
  const view = useView();
  const [route, setRoute] = useState<Route>('home');
  const [ui, setUiState] = useState<UiState>({ openTaskId: null, channelFilter: null, focusTaskId: null });
  const setUi = (patch: Partial<UiState>) => setUiState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    void client.load();
  }, [client]);

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
          <Nav route={route} onRoute={setRoute} />
          <main class="main">
            {route === 'home' && <Board />}
            {route === 'today' && <TodayView />}
            {route === 'calendar' && <CalendarView />}
            {route === 'focus' && <FocusView onExit={() => setRoute('today')} />}
            {route === 'planning' && <DailyPlanning onDone={() => setRoute('today')} />}
            {route === 'shutdown' && <DailyShutdown onDone={() => setRoute('highlights')} />}
            {route === 'highlights' && <Highlights />}
            {route === 'weeklyPlanning' && <WeeklyPlanning onDone={() => setRoute('home')} />}
            {route === 'weeklyReview' && <WeeklyReview />}
            {route === 'backlog' && <Backlog />}
            {route === 'archive' && <ArchiveView />}
            {route === 'settings' && <Settings />}
          </main>
        </div>
      )}
      {ui.openTaskId && <TaskDetail key={ui.openTaskId} taskId={ui.openTaskId} />}
      <Toasts />
    </UiContext.Provider>
  );
};
