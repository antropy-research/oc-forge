import { useEffect, useState } from 'preact/hooks';

/** The current time, re-rendering every `intervalMs` while `active`. */
export const useNow = (active: boolean, intervalMs = 1000): number => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return active ? now : Date.now();
};

/** `12:05` under an hour, `1:02:05` above; for a running clock. */
export const formatClock = (minutes: number): string => {
  const total = Math.max(0, Math.floor(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};
