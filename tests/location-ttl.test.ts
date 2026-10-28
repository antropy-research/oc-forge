// Exercises the real upstream LocationActivity, loaded through our adapter, with
// a virtual clock. Run via `mise run test:adapters`, which uses upstream's
// isolated test environment (in-memory database, temporary HOME).
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap, RcMap } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "../vendors/opencode/packages/core/src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../vendors/opencode/packages/core/src/bus"
import { Config } from "../vendors/opencode/packages/core/src/config"
import { Database } from "../vendors/opencode/packages/core/src/database/database"
import { Location } from "../vendors/opencode/packages/core/src/location"
import { LocationActivity } from "../vendors/opencode/packages/core/src/location-activity"
import { LocationServiceMap, type LocationServices } from "../vendors/opencode/packages/core/src/location-services"
import { Project } from "../vendors/opencode/packages/core/src/project"
import { AbsolutePath } from "../vendors/opencode/packages/core/src/schema"
import { locationTtl } from "../adapters/opencode/location-ttl"
import { testEffect } from "../vendors/opencode/packages/core/test/lib/effect"

const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    (ref) =>
      // LocationActivity reads each location's Config for an
      // experimental.location_idle_timeout override; none here, so the default applies.
      Layer.mergeAll(
        Config.testLayer(),
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: ref.directory,
            workspaceID: ref.workspaceID,
            project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
          }),
        ),
      ) as unknown as Layer.Layer<LocationServices>,
    { idleTimeToLive: Duration.infinity },
  ),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, LocationActivity.node]), [
    LocationServiceMap.node.replace(locations),
  ]),
)

describe("location-ttl adapter", () => {
  it.effect("keeps a silent location for 24 hours instead of 60 minutes", () =>
    Effect.gen(function* () {
      const map = yield* LocationServiceMap.Service
      const ref = Location.Ref.make({ directory: AbsolutePath.make("/project") })
      yield* Location.Service.pipe(Effect.provide(map.get(ref)), Effect.scoped)

      yield* TestClock.adjust("23 hours")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])

      yield* TestClock.adjust("2 hours")
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
    }),
  )

  it.effect("rejects upstream source that no longer matches", () =>
    Effect.sync(() => {
      expect(() => locationTtl.transform('options.timeToLive ?? "30 minutes"')).toThrow("found 0")
    }),
  )
})
