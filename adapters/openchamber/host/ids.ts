// Which extension a `plugin:` surface belongs to. A rail entry with its own
// panel is the surface `plugin:<extension>--<entry>`; everything else that
// reads a plugin mode (the pane, badges, labels) must still find the
// extension. Imported by lib/surfaces/modes.ts, so it imports nothing: the
// host registers how to read the catalog once it starts.

type CatalogGuest = { id: string; ocForge?: { rail?: unknown } };

let readCatalog: () => readonly CatalogGuest[] = () => [];

export const setOcForgeCatalogReader = (reader: () => readonly CatalogGuest[]): void => {
  readCatalog = reader;
};

const ENTRY_SEPARATOR = '--';

/**
 * `<extension>--<entry>` when the extension polls rail entries and no
 * extension has that whole id; the separator is the last `--`. Null otherwise.
 */
export const ocForgeEntrySurfaceOf = (surfaceId: string): { guestId: string; entry: string } | null => {
  const split = surfaceId.lastIndexOf(ENTRY_SEPARATOR);
  if (split <= 0) return null;
  const guests = readCatalog();
  if (guests.some((guest) => guest.id === surfaceId)) return null;
  const guestId = surfaceId.slice(0, split);
  const entry = surfaceId.slice(split + ENTRY_SEPARATOR.length);
  if (!entry) return null;
  return guests.some((guest) => guest.id === guestId && guest.ocForge?.rail) ? { guestId, entry } : null;
};

/** The extension id behind a plugin surface id (what follows `plugin:`). */
export const ocForgeGuestIdOf = (surfaceId: string): string => ocForgeEntrySurfaceOf(surfaceId)?.guestId ?? surfaceId;

export const ocForgeEntrySurfaceId = (guestId: string, entry: string): string => `${guestId}${ENTRY_SEPARATOR}${entry}`;
