import { Context, Effect, Layer } from "effect"
import type { ActorMethods } from "tardie"
import type { ActorSummary, ActorArtifact } from "tardie/client"
import type { Event, ThreadEventRow } from "tardie/core/log"
import { Ingress } from "tardie/host/communication/ingress"
import { ModelCatalogStore } from "tardie/server/catalog"
import { ServerConfig } from "tardie/server/config"
import { DriverGauge } from "tardie/server/driver-gauge"

export interface DynamicActorThreads {
  readonly methods: ActorMethods
  readonly sqlite: string
  readonly append: (id: string, event: Event) => Effect.Effect<void>
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly eventsPage: (id: string, mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (id: string, mark: number) => Effect.Effect<number>
  readonly list: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
  readonly settled: Effect.Effect<void>
}

export interface DynamicThreadsService {
  readonly methods: DynamicActorThreads["methods"]
  readonly sqlite: string
  readonly actorName?: string
  readonly instances: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly definition: string }>>
  readonly ensure: (id: string) => Effect.Effect<DynamicActorThreads>
  readonly instance: (id: string) => Effect.Effect<DynamicActorThreads | undefined>
  readonly append: (actor: string, thread: string, event: Event) => Effect.Effect<void>
  readonly events: (actor: string, thread: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly list: (actor: string) => DynamicActorThreads["list"]
  readonly settled: (actor: string) => Effect.Effect<void>
  readonly definitions?: Effect.Effect<ReadonlyArray<ActorSummary>>
  readonly definition?: (name: string) => Effect.Effect<DynamicActorThreads | undefined>
  readonly pushDefinition?: (artifact: ActorArtifact) => Effect.Effect<ActorSummary, unknown>
}

// The package publishes TypeScript sources. Statically importing server/host
// makes `tsc` load its optional Bedrock peer modules even when this host has no
// Bedrock provider. A computed import preserves the package's intended runtime
// optionality; the narrow structural cast above is pinned to tardie@0.17.0's
// exported Threads contract and covered by the service tests below.
interface DynamicThreadsIdentifier {
  readonly DynamicThreadsIdentifier: unique symbol
}

const hostModuleName = `tardie/server/${"host"}`
const hostModule = await import(hostModuleName) as {
  readonly Threads: Context.Service<DynamicThreadsIdentifier, DynamicThreadsService>
  readonly layerThreads: (
    options?: Readonly<Record<string, unknown>>
  ) => Layer.Layer<DynamicThreadsIdentifier | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore>
}
const Threads = hostModule.Threads
const layerThreads = hostModule.layerThreads

const installedDefinition = (
  threads: DynamicThreadsService,
  id: string
) => threads.definition?.(id) ?? Effect.succeed(undefined)

/**
 * Adds the missing definition-to-public-instance binding to Tardigrade's
 * standalone registry service.
 *
 * `tardie@0.17.0` already loads pushed definitions into isolated runtimes and
 * exposes them to actor-to-actor routing through `Threads.definition`. Its
 * public HTTP routes, however, resolve `:id` through `ensure` / `instance`,
 * which only know built-in actor instances. This adapter gives an installed
 * definition first refusal when the public actor id exactly equals its name;
 * every other id retains the upstream built-in-instance behavior.
 *
 * The adapter intentionally does not evaluate source from a database, alter
 * ingress, or introduce an HTTP route. Artifact validation, persistence,
 * authentication, reconciliation, and the driver gauge remain owned by the
 * upstream host.
 */
export const bindDynamicDefinitions = (threads: DynamicThreadsService): DynamicThreadsService => ({
  ...threads,
  ensure: (id) =>
    Effect.flatMap(installedDefinition(threads, id), (definition) =>
      definition === undefined ? threads.ensure(id) : Effect.succeed(definition)),
  instance: (id) =>
    Effect.flatMap(installedDefinition(threads, id), (definition) =>
      definition === undefined ? threads.instance(id) : Effect.succeed(definition)),
  instances: Effect.gen(function*() {
    const instances = yield* threads.instances
    if (threads.definitions === undefined || threads.definition === undefined) return instances

    const definitions = yield* threads.definitions
    const installed = yield* Effect.forEach(
      definitions.filter((definition) => !definition.builtIn),
      (definition) => Effect.map(
        threads.definition!(definition.name),
        (runtime) => runtime === undefined
          ? undefined
          : { id: definition.name, definition: definition.name }
      )
    )

    // A built-in instance can predate a push with the same id. The installed
    // definition now owns that exact public address, so it replaces the stale
    // listing as well as taking precedence in ensure / instance.
    const byId = new Map(instances.map((instance) => [instance.id, instance]))
    for (const instance of installed) {
      if (instance !== undefined) byId.set(instance.id, instance)
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  })
})

const layerBinding: Layer.Layer<
  DynamicThreadsIdentifier | Ingress | DriverGauge,
  never,
  DynamicThreadsIdentifier | Ingress | DriverGauge
> = Layer.effectContext(Effect.gen(function*() {
  const context = yield* Effect.context<DynamicThreadsIdentifier | Ingress | DriverGauge>()
  const threads = yield* Threads
  return Context.add(context, Threads, bindDynamicDefinitions(threads))
}))

/**
 * The upstream standalone registry host with only its `Threads` public lookup
 * service rebound. The original `Ingress` and `DriverGauge` values are carried
 * through unchanged from the same scoped `layerThreads` allocation.
 */
export const layerDynamicDefinitionThreads = (
  options: Readonly<Record<string, unknown>> = {}
): Layer.Layer<DynamicThreadsIdentifier | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore> =>
  Layer.provide(layerBinding, layerThreads(options))
