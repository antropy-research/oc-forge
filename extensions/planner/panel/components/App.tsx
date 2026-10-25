import { useEffect, useState } from 'preact/hooks';
import { usePlanner, useView } from '../lib/context.ts';
import { Backlog } from './Backlog.tsx';
import { Board } from './Board.tsx';
import { Settings } from './Settings.tsx';
import { ErrorToast, Nav, ServiceGate, type Route } from './Shell.tsx';
import { CompactToday, TodayView } from './TodayView.tsx';

export const App = ({ surface }: { surface: string }) => {
  const { client } = usePlanner();
  const view = useView();
  const [route, setRoute] = useState<Route>('home');

  useEffect(() => {
    void client.load();
  }, [client]);

  if (!view.loaded) return <ServiceGate />;
  if (surface === 'panel') {
    return (
      <>
        <CompactToday />
        <ErrorToast />
      </>
    );
  }
  return (
    <div class="app">
      <Nav route={route} onRoute={setRoute} />
      <main class="main">
        {route === 'home' && <Board />}
        {route === 'today' && <TodayView />}
        {route === 'backlog' && <Backlog />}
        {route === 'settings' && <Settings />}
      </main>
      <ErrorToast />
    </div>
  );
};
