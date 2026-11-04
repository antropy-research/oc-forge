// The bridge extension (`bridge/`) as a .vsix, for a frame to install on the VS Code Server it is connected to: its
// manifest and its bundle, with the bundle's hash in the manifest (`openchamberBuild`), so that a frame can tell the
// bridge running from the one it carries. Stored (uncompressed) entries with a fixed date: the same bytes each time.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A zip archive of stored entries (1980-01-01 00:00). */
export const zip = (entries: readonly { name: string; data: Uint8Array }[]): Buffer => {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, Buffer.from(entry.data));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

export interface BridgePackage {
  /** `publisher.name`, lower case, as VS Code identifies it. */
  id: string;
  version: string;
  /** The bundle's and the manifest's hash. */
  build: string;
}

export class BridgeBuilder {
  private cache: { stamp: string; meta: BridgePackage; vsix: Buffer } | null = null;

  constructor(private readonly root: string) {}

  private files(): { manifest: string; bundle: string } {
    return { manifest: join(this.root, 'bridge', 'package.json'), bundle: join(this.root, 'bridge', 'main.js') };
  }

  private build(): { meta: BridgePackage; vsix: Buffer } {
    const { manifest, bundle } = this.files();
    const stamp = [manifest, bundle].map((file) => `${statSync(file).mtimeMs}:${statSync(file).size}`).join('|');
    if (this.cache?.stamp === stamp) return this.cache;
    const manifestText = readFileSync(manifest, 'utf8');
    const bundleData = readFileSync(bundle);
    const build = createHash('sha256').update(manifestText).update(bundleData).digest('hex').slice(0, 16);
    const pkg = JSON.parse(manifestText) as { name: string; publisher: string; version: string; displayName: string; description: string; engines: { vscode: string }; extensionKind: string[] };
    const stamped = Buffer.from(`${JSON.stringify({ ...pkg, openchamberBuild: build }, null, 2)}\n`, 'utf8');
    const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher)}" /><DisplayName>${escapeXml(pkg.displayName)}</DisplayName><Description xml:space="preserve">${escapeXml(pkg.description)}</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${escapeXml(pkg.extensionKind.join(','))}" /></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`;
    const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>';
    const vsix = zip([
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
      { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest, 'utf8') },
      { name: 'extension/package.json', data: stamped },
      { name: 'extension/main.js', data: bundleData },
    ]);
    const meta = { id: `${pkg.publisher}.${pkg.name}`.toLowerCase(), version: pkg.version, build };
    this.cache = { stamp, meta, vsix };
    return this.cache;
  }

  meta(): BridgePackage {
    return this.build().meta;
  }

  package(): BridgePackage & { vsix: string } {
    const { meta, vsix } = this.build();
    return { ...meta, vsix: vsix.toString('base64') };
  }
}

/** One claim per key at a time (one frame installs, one shows the notice), each for `ms`. */
export class Claims {
  private readonly claimed = new Map<string, number>();

  constructor(private readonly ms = 60_000, private readonly now = () => Date.now()) {}

  claim(key: string): boolean {
    const at = this.claimed.get(key);
    if (at !== undefined && this.now() - at < this.ms) return false;
    this.claimed.set(key, this.now());
    if (this.claimed.size > 1_000) for (const [old, when] of this.claimed) if (this.now() - when >= this.ms) this.claimed.delete(old);
    return true;
  }
}
