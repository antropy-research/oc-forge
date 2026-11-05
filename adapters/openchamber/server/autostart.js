// Services that start with OpenChamber (`ocForge.autostart`). The release
// spawns an extension's service on the first request one of its frames sends,
// so a service that does work of its own (imports, syncs, reminders) waits
// until someone opens the extension. For an extension that asks, the server
// sends its service a `GET /health` through the release's own proxy (the same
// grant, enabled and package checks a frame's request meets) once the routes
// are up, and again after every change to the catalog: an install, an update,
// a rebuilt folder, an enable or an approval. A running service just answers.

/** Quiet reasons: paused, not approved, a folder mid-rebuild, the host shutting down. The next change tries again. */
const QUIET_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);

/** The catalog rows whose service starts with the server. */
export const ocForgeAutostartGuests = (guests) => (Array.isArray(guests) ? guests : []).filter((guest) => (
  guest?.ocForge?.autostart === true
  && guest.enabled !== false
  && Boolean(guest.service?.entry)
  && Array.isArray(guest.capabilityGrants)
  && guest.capabilityGrants.includes('service')
));

/**
 * `listGuests` reads the catalog (the release's `listInstalledGuests`), `persistPath` is the extension store's file.
 * `soon()` asks for a pass; passes never overlap, and one asked for during a pass runs after it.
 */
export const createOcForgeAutostart = ({ listGuests, persistPath, request = null, log = console }) => {
  let timer = null;
  let running = false;
  let again = false;
  const warned = new Set();

  // The release's proxy, loaded on first use: the tests pass their own `request`.
  const send = async (params) => (request ?? (await import('../guests/service.js')).proxyGuestServiceRequest)(params);

  const start = async (guest) => {
    try {
      await send({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'GET',
        path: '/health',
      });
      warned.delete(guest.id);
    } catch (error) {
      if (QUIET_CODES.has(error?.code) || warned.has(guest.id)) return;
      warned.add(guest.id);
      log.warn(`oc-forge: could not start the service of ${guest.name ?? guest.id}: ${error?.message ?? error}`);
    }
  };

  const pass = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      for (const guest of ocForgeAutostartGuests(await listGuests())) await start(guest);
    } catch (error) {
      log.warn(`oc-forge: could not list the extensions to start: ${error?.message ?? error}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        soon();
      }
    }
  };

  const soon = (delayMs = 0) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void pass();
    }, delayMs);
    timer.unref?.();
  };

  return { soon, pass };
};
