// Builds the scratch test extensions into <out>/ocforge-test and
// <out>/ocforge-test-zone: their manifests, the service, and one panel page
// bundled with @openchamber/sdk (from <sdk>, an installed npm package) and
// oc-forge's client module.
//   bun tests/e2e/openchamber-adapters/build-fixture.ts <out> <sdk package dir>
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const [out, sdk] = process.argv.slice(2)
if (!out || !sdk) throw new Error("usage: build-fixture.ts <out> <sdk package dir>")
const here = import.meta.dir

const bundle = await Bun.build({
  entrypoints: [join(here, "extension/panel/main.ts")],
  target: "browser",
  format: "iife",
  plugins: [
    {
      name: "openchamber-sdk",
      setup(build) {
        build.onResolve({ filter: /^@openchamber\/sdk$/ }, () => ({ path: join(sdk, "dist/index.js") }))
      },
    },
  ],
})
if (!bundle.success) throw new AggregateError(bundle.logs, "panel bundle failed")

for (const [name, from] of [["ocforge-test", "extension"], ["ocforge-test-zone", "zone-extension"]]) {
  const target = join(out, name)
  rmSync(target, { recursive: true, force: true })
  cpSync(join(here, from), target, { recursive: true })
  mkdirSync(join(target, "panel"), { recursive: true })
  cpSync(join(here, "extension/panel/index.html"), join(target, "panel/index.html"))
  rmSync(join(target, "panel/main.ts"), { force: true })
  await Bun.write(join(target, "panel/main.js"), bundle.outputs[0])
}
console.log(`built ocforge-test and ocforge-test-zone into ${out}`)
