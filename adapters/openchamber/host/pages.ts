// An extension page that keeps OpenChamber's bottom zone under it (manifest
// `ocForge.page.keepBottomZone`): a page that is an editor area, with the
// extension's terminal in the bottom zone, as in an IDE. Every other page
// covers the chat column, the bottom zone included, as the release does.
import { useGuestsStore } from '@/lib/guests/store';
import { useUIStore } from '@/stores/useUIStore';

/** The page on screen keeps the bottom zone shown under it. */
export const useOcForgePageKeepsBottomZone = (): boolean => {
  const page = useUIStore((state) => state.openGuestPageId);
  return useGuestsStore((state) => Boolean(page && state.guests.find((guest) => guest.id === page)?.ocForge?.page?.keepBottomZone));
};
