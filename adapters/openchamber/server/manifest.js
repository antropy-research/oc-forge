// The `ocForge` block of an extension's package.json: oc-forge's additions to
// OpenChamber's manifest. OpenChamber's own parser (`@openchamber/sdk`,
// installed from npm) drops keys it does not know, so a stock host ignores
// the block and the extension keeps working without these features.
//
//   "ocForge": {
//     "apiVersion": 1,
//     "zone": "bottom",                                  // the panel's zone until the user moves it
//     "rail": { "path": "/rail", "interval": 3000 }      // the service path polled for rail entries
//   }

const ZONES = new Set(['left', 'right', 'bottom']);
const INTERVAL_DEFAULT = 3000;
const INTERVAL_MIN = 1000;
const INTERVAL_MAX = 60000;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isRequestPath = (value) => (
  typeof value === 'string' && value.startsWith('/') && value.length <= 512 && !value.includes('\0')
  && !value.includes('\\') && !value.includes('://') && !value.split('/').some((segment) => segment === '.' || segment === '..')
);

/**
 * The block as the catalog publishes it, or null. `raw` is the package.json
 * text; `manifest` is OpenChamber's parse of the same file. A zone needs a
 * panel page, a rail source needs the page and a service to poll.
 */
export const parseOcForgeManifest = (raw, manifest) => {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  const block = isObject(document) ? document.ocForge : null;
  if (!isObject(block) || block.apiVersion !== 1) return null;
  const contributes = manifest?.contributes ?? {};
  if (!contributes.panel?.entry) return null;
  const result = { apiVersion: 1 };
  if (ZONES.has(block.zone)) result.zone = block.zone;
  if (contributes.service && isObject(block.rail) && isRequestPath(block.rail.path)) {
    const interval = Number.isInteger(block.rail.interval)
      ? Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, block.rail.interval))
      : INTERVAL_DEFAULT;
    result.rail = { path: block.rail.path, interval };
  }
  return result.zone || result.rail ? result : null;
};
