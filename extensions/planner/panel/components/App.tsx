import { useEffect, useState } from 'preact/hooks';
import { usePlanner, useView } from '../lib/context.ts';
import { UiContext, type UiState } from '../lib/ui.ts';
import { ArchiveView } from './ArchiveView.tsx';
import { Backlog } from './Backlog.tsx';
import { Board } from './Board.tsx';
import { Settings } from './Settings.tsx';
import { Nav, ServiceGate, Toasts, type Route } from './Shell.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { CompactToday, TodayView } from './TodayView.tsx';

export const App = ({ surface }: { surface: string }) => {
  const { client } = usePlanner();
  const view = useView();
  const [route, setRoute] = useState<Route>('home');
  const [ui, setUiState] = useState<UiState>({ openTaskId: null, channelFilter: null });
  const setUi = (patch: Partial<UiState>) => setUiState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    void client.load();
  }, [client]);

  if (!view.loaded) return <ServiceGate />;
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
