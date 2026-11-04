// A lock file between processes on one machine: who holds it wrote its pid in it. A lock whose process is gone, or
// that is older than `staleMs` (a holder that hangs), is taken over.
import * as fs from 'node:fs';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Takes the lock if it is free (or stale): a function that releases it, or null. */
export const tryLock = (file: string, staleMs = 10_000): (() => void) | null => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          // Only our own: a lock taken over as stale is someone else's now.
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
        } catch {
          // Gone already.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let stale = false;
    try {
      const holder = Number(fs.readFileSync(file, 'utf8'));
      const age = Date.now() - fs.statSync(file).mtimeMs;
      stale = !Number.isInteger(holder) || holder <= 0 || !alive(holder) || age > staleMs;
    } catch {
      // Released meanwhile: try again.
      stale = true;
    }
    if (!stale) return null;
    try {
      fs.unlinkSync(file);
    } catch {
      // Someone else took it over first.
    }
  }
  return null;
};

/** Runs `work` holding the lock, waiting for it at most `waitMs`; without it after that, runs it anyway. */
export const withLock = async <T>(file: string, work: () => T | Promise<T>, waitMs = 3_000): Promise<T> => {
  const end = Date.now() + waitMs;
  let release = tryLock(file);
  while (!release && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
    release = tryLock(file);
  }
  try {
    return await work();
  } finally {
    release?.();
  }
};
