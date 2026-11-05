// The `ocForge` block of an extension's package.json: oc-forge's additions to
// OpenChamber's manifest. OpenChamber's own parser (`@openchamber/sdk`,
// installed from npm) drops keys it does not know, so a stock host ignores
// the block and the extension keeps working without these features.
//
//   "ocForge": {
//     "apiVersion": 1,
//     "modals": true                                     // its frames may open the browser's print dialog
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
 * text; `manifest` is OpenChamber's parse of the same file. It needs a panel page.
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
  if (!manifest?.contributes?.panel?.entry) return null;
  return block.modals === true ? { apiVersion: 1, modals: true } : null;
};
