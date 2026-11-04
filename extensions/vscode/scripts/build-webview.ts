#!/usr/bin/env bun
// Builds webview/host.js: the webview host page's script, with the agent that
// runs in each webview's content carried inside it as text (the host puts it
// inline in the content document; a sandboxed srcdoc frame loads no files).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const fail = (what: string, logs: { message: string }[]): never => {
  console.error(`${what} did not build:\n${logs.map((log) => log.message).join('\n')}`);
  process.exit(1);
};

const agent = await Bun.build({ entrypoints: [join(root, 'webview/agent.ts')], format: 'iife', target: 'browser', minify: true });
if (!agent.success) fail('The webview agent', agent.logs);
const agentSource = await agent.outputs[0]!.text();

const host = await Bun.build({
  entrypoints: [join(root, 'webview/host.ts')],
  format: 'iife',
  target: 'browser',
  minify: true,
  define: { __OC_WEBVIEW_AGENT__: JSON.stringify(agentSource) },
});
if (!host.success) fail('The webview host', host.logs);
writeFileSync(join(root, 'webview/host.js'), await host.outputs[0]!.text());
console.log(`webview/host.js (agent ${(agentSource.length / 1e3).toFixed(1)} kB)`);
