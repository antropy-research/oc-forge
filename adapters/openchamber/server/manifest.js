// The `ocForge` block of an extension's package.json: oc-forge's additions to
// OpenChamber's manifest. OpenChamber's own parser (`@openchamber/sdk`,
// installed from npm) drops keys it does not know, so a stock host ignores
// the block and the extension keeps working without these features.
//
//   "ocForge": {
//     "apiVersion": 1,
//     "modals": true,                                    // its frames may open the browser's print dialog
//     "globalPanel": true,                               // its panel is the window's, loaded at startup
//     "autostart": true                                  // its service starts with the server
//   }

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `sandbox` directive of the CSP the server sends with a guest's documents: the release's `allow-scripts`, and
 * `allow-modals` for an extension that asks (`ocForge.modals`). The browser applies it and the frame's own sandbox
 * attribute both, so the host widens both.
 */
export const ocForgeDocumentSandbox = (guest) => (guest?.ocForge?.modals === true ? 'sandbox allow-scripts allow-modals' : 'sandbox allow-scripts');

/**
 * The block as the catalog publishes it, or null. `raw` is the package.json
 * text; `manifest` is OpenChamber's parse of the same file. `modals` and
 * `globalPanel` need a panel page, `autostart` a service; only `true` counts.
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
  const panel = Boolean(manifest?.contributes?.panel?.entry);
  const service = Boolean(manifest?.contributes?.service?.entry);
  const read = { apiVersion: 1 };
  if (panel && block.modals === true) read.modals = true;
  if (panel && block.globalPanel === true) read.globalPanel = true;
  if (service && block.autostart === true) read.autostart = true;
  return Object.keys(read).length > 1 ? read : null;
};
