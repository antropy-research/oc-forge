// Packs the bridge (extension.js, package.json) as a .vsix, for a VS Code Server's `--install-extension` (spike).
//   node extensions/vscode/bridge/pack.mjs [out.vsix]     # default: $TMPDIR/openchamber-bridge.vsix
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const out = resolve(process.argv[2] ?? join(tmpdir(), `${manifest.name}.vsix`));
const dir = mkdtempSync(join(tmpdir(), 'openchamber-bridge-'));
try {
  mkdirSync(join(dir, 'extension'));
  for (const file of ['package.json', 'extension.js']) copyFileSync(join(here, file), join(dir, 'extension', file));
  writeFileSync(join(dir, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}" /><DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${manifest.extensionKind.join(',')}" /></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`);
  writeFileSync(join(dir, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>');
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dir });
  console.log(out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
