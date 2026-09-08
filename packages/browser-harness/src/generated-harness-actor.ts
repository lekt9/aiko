import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import {
  actor,
  actorMethod,
  handles,
  type ActorMethodCall,
  type ActorMethodDeclaration,
  type ActorMethods,
  type Component
} from "tardie"
import type { KeyFragment } from "tardie/core/log"
import type { Event } from "tardie/core/log/event"
import { intent, type Transition } from "tardie/core/reconciliation"
import {
  SITE_HARNESS_LIMITS,
  canonicalSiteHarnessArtifact,
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact,
  type HarnessAction,
  type HarnessInputType,
  type HarnessStep,
  type Sha256Digest,
  type SiteHarnessArtifact,
  type ValueProducer
} from "./harness-artifact"
import {
  SITE_INTERFACE_ABI,
  SITE_INTERFACE_SCHEMA_VERSION,
  canonicalSiteInterfaceContract,
  interfaceContractMatchesArtifact,
  siteInterfaceContractDigest,
  siteInterfaceContractOf,
  validateSiteInterfaceContract,
  type SiteInterfaceAction,
  type SiteInterfaceContract,
  type SiteInterfaceInput
} from "./harness-interface"

export const HARNESS_ACTOR_GENERATOR_REVISION = "generated-harness-actor/2" as const
export const GENERATED_HARNESS_EVENT_SCHEMA_VERSION = 2 as const
export const GENERATED_HARNESS_PLAN_SCHEMA_VERSION = 1 as const
/** Absolute reviewed-factory path so an explicitly configured candidate root can live outside runtime/. */
export const GENERATED_HARNESS_FACTORY_IMPORT = fileURLToPath(import.meta.url)
export const MAX_GENERATED_HARNESS_FACTORY_BYTES = 8 * 1024 * 1024

const KEY_PREFIX = "generated-harness1:"
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ACTOR_NAME = /^[a-z][a-z0-9-]{0,62}$/u
const OPAQUE_VALUE_REFERENCE = /^vault:v1:[0-9a-f]{32}$/u

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex")
const digestOf = (value: string): Sha256Digest => `sha256:${sha256Hex(value)}`
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, stableValue(child)])
  )
}
const canonical = (value: unknown): string => JSON.stringify(stableValue(value))

const deepFreeze = <T>(value: T, seen: Set<object> = new Set()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => value.length <= max,
  { title: `at most ${max} characters` }
)))
const matchingString = (pattern: RegExp, title: string) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => pattern.test(value),
  { title }
)))
const boundedArray = <S extends Schema.Top>(schema: S, max: number, min = 0) => Schema.Array(schema).pipe(
  Schema.check(Schema.makeFilter(
    (values: ReadonlyArray<unknown>) => values.length >= min && values.length <= max,
    { title: `between ${min} and ${max} items` }
  ))
)

export const OpaqueValueReferenceSchema = matchingString(
  OPAQUE_VALUE_REFERENCE,
  "opaque vault reference (vault:v1:<32 lowercase hex characters>)"
)
export type OpaqueValueReference = `vault:v1:${string}`

export const OpaqueValueBindingSchema = Schema.Struct({ ref: OpaqueValueReferenceSchema })
export interface OpaqueValueBinding {
  readonly ref: OpaqueValueReference
}

export interface GeneratedHarnessActionMethodInput {
  readonly bindings: Readonly<Record<string, OpaqueValueBinding | undefined>>
}

export type GeneratedHarnessProducerKind = ValueProducer["kind"]

export interface GeneratedHarnessBindingPlan {
  readonly name: string
  readonly producerKinds: ReadonlyArray<GeneratedHarnessProducerKind>
}

export interface GeneratedHarnessStepPlan {
  readonly id: string
  readonly dependsOn: ReadonlyArray<string>
  readonly method: HarnessStep["method"]
  readonly origin: string
  readonly path: string
  readonly pathParameters: ReadonlyArray<GeneratedHarnessBindingPlan>
  readonly query: ReadonlyArray<GeneratedHarnessBindingPlan>
  readonly headers: ReadonlyArray<GeneratedHarnessBindingPlan>
  readonly bodyProducerKinds?: ReadonlyArray<GeneratedHarnessProducerKind>
  readonly expectedStatuses: ReadonlyArray<number>
}

export interface GeneratedHarnessActionPlan {
  readonly schemaVersion: typeof GENERATED_HARNESS_PLAN_SCHEMA_VERSION
  readonly interfaceAbi: typeof SITE_INTERFACE_ABI
  readonly siteId: string
  readonly actionId: string
  readonly methodName: string
  readonly interfaceDigest: Sha256Digest
  readonly artifactDigest: Sha256Digest
  readonly inputs: ReadonlyArray<SiteInterfaceInput>
  readonly steps: ReadonlyArray<GeneratedHarnessStepPlan>
  readonly producerKinds: ReadonlyArray<GeneratedHarnessProducerKind>
}

const IdentifierSchema = matchingString(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
  "lowercase identifier"
).pipe(Schema.check(Schema.makeFilter((value: string) => value.length <= 64, { title: "at most 64 characters" })))
const MethodNameSchema = matchingString(/^[a-z][A-Za-z0-9-]{0,62}$/u, "Tardigrade method name")
const DigestSchema = matchingString(DIGEST, "sha256 digest")
const ProducerKindSchema = Schema.Literals([
  "js",
  "input",
  "clock",
  "uuid",
  "response_header",
  "response_json",
  "constant",
  "object",
  "array",
  "wasm"
])
const ProducerKindsSchema = boundedArray(ProducerKindSchema, 10)
const InterfaceInputSchema = Schema.Struct({
  name: IdentifierSchema,
  type: Schema.Literals(["string", "number", "integer", "boolean", "json"]),
  required: Schema.Boolean
})
const BindingPlanSchema = Schema.Struct({
  name: boundedString(256),
  producerKinds: ProducerKindsSchema
})
const HttpStatusSchema = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value >= 100 && value <= 599,
  { title: "HTTP status" }
)))
const StepPlanSchema = Schema.Struct({
  id: IdentifierSchema,
  dependsOn: boundedArray(IdentifierSchema, SITE_HARNESS_LIMITS.dependenciesPerStep),
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  origin: boundedString(512),
  path: boundedString(1_024),
  pathParameters: boundedArray(BindingPlanSchema, SITE_HARNESS_LIMITS.bindingsPerStep),
  query: boundedArray(BindingPlanSchema, SITE_HARNESS_LIMITS.bindingsPerStep),
  headers: boundedArray(BindingPlanSchema, SITE_HARNESS_LIMITS.bindingsPerStep),
  bodyProducerKinds: Schema.optionalKey(ProducerKindsSchema),
  expectedStatuses: boundedArray(HttpStatusSchema, SITE_HARNESS_LIMITS.expectedStatusesPerStep, 1)
})

export const GeneratedHarnessActionPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(GENERATED_HARNESS_PLAN_SCHEMA_VERSION),
  interfaceAbi: Schema.Literal(SITE_INTERFACE_ABI),
  siteId: IdentifierSchema,
  actionId: IdentifierSchema,
  methodName: MethodNameSchema,
  interfaceDigest: DigestSchema,
  artifactDigest: DigestSchema,
  inputs: boundedArray(InterfaceInputSchema, SITE_HARNESS_LIMITS.inputsPerAction),
  steps: boundedArray(StepPlanSchema, SITE_HARNESS_LIMITS.stepsPerAction, 1),
  producerKinds: ProducerKindsSchema
})

const NonNegativeIntSchema = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value >= 0,
  { title: "non-negative integer" }
)))
const InvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: NonNegativeIntSchema
})
const InvocationContextSchema = Schema.Struct({
  invocation: InvocationSchema,
  parent: Schema.optionalKey(InvocationSchema),
  deadlineAt: Schema.optionalKey(NonNegativeIntSchema)
})
const TransportFields = {
  at: Schema.optionalKey(NonNegativeIntSchema),
  traceparent: Schema.optionalKey(matchingString(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u,
    "W3C traceparent"
  )),
  call: Schema.optionalKey(InvocationContextSchema),
  link: Schema.optionalKey(Schema.Unknown)
}

const isStrict = (schema: Schema.ConstraintDecoder<unknown>, value: unknown): boolean => {
  try {
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
    return true
  } catch {
    return false
  }
}

const producerKindsOf = (producer: ValueProducer, kinds: Set<GeneratedHarnessProducerKind>): void => {
  kinds.add(producer.kind)
  if (producer.kind === "object") {
    for (const nested of Object.values(producer.fields)) producerKindsOf(nested, kinds)
  } else if (producer.kind === "array") {
    for (const nested of producer.items) producerKindsOf(nested, kinds)
  } else if (producer.kind === "wasm") {
    for (const nested of producer.args) producerKindsOf(nested, kinds)
  } else if (producer.kind === "js") {
    for (const nested of producer.args) producerKindsOf(nested, kinds)
  }
}

const kindsFor = (producer: ValueProducer): ReadonlyArray<GeneratedHarnessProducerKind> => {
  const kinds = new Set<GeneratedHarnessProducerKind>()
  producerKindsOf(producer, kinds)
  return [...kinds].sort(compareText)
}

const bindingPlansOf = (
  bindings: Readonly<Record<string, ValueProducer>>
): ReadonlyArray<GeneratedHarnessBindingPlan> => Object.keys(bindings).sort(compareText).map((name) => ({
  name,
  producerKinds: kindsFor(bindings[name]!)
}))

const stepPlanOf = (step: HarnessStep): GeneratedHarnessStepPlan => ({
  id: step.id,
  dependsOn: [...step.dependsOn].sort(compareText),
  method: step.method,
  origin: step.origin,
  path: step.path,
  pathParameters: bindingPlansOf(step.pathParameters),
  query: bindingPlansOf(step.query),
  headers: bindingPlansOf(step.headers),
  ...(step.body === undefined ? {} : { bodyProducerKinds: kindsFor(step.body) }),
  expectedStatuses: [...step.expectedStatuses].sort((left, right) => left - right)
})

export const generatedHarnessActionPlanOf = (
  artifactValue: unknown,
  contractValue: unknown,
  actionId: string
): GeneratedHarnessActionPlan => {
  const artifact = validateSiteHarnessArtifact(artifactValue)
  const contract = validateSiteInterfaceContract(contractValue)
  if (!interfaceContractMatchesArtifact(artifact, contract)) {
    throw new Error("site interface contract does not match the artifact's derived interface")
  }
  const action = artifact.actions.find((candidate) => candidate.id === actionId)
  const actionContract = contract.actions.find((candidate) => candidate.id === actionId)
  if (action === undefined || actionContract === undefined) throw new Error(`unknown interface action ${JSON.stringify(actionId)}`)
  const allKinds = new Set<GeneratedHarnessProducerKind>()
  for (const step of action.steps) {
    for (const producer of Object.values(step.pathParameters)) producerKindsOf(producer, allKinds)
    for (const producer of Object.values(step.query)) producerKindsOf(producer, allKinds)
    for (const producer of Object.values(step.headers)) producerKindsOf(producer, allKinds)
    if (step.body !== undefined) producerKindsOf(step.body, allKinds)
  }
  const plan: GeneratedHarnessActionPlan = {
    schemaVersion: GENERATED_HARNESS_PLAN_SCHEMA_VERSION,
    interfaceAbi: SITE_INTERFACE_ABI,
    siteId: artifact.siteId,
    actionId: action.id,
    methodName: actionContract.methodName,
    interfaceDigest: siteInterfaceContractDigest(contract),
    artifactDigest: siteHarnessArtifactDigest(artifact),
    inputs: actionContract.inputs.map((input) => ({ ...input })),
    steps: action.steps.map(stepPlanOf),
    producerKinds: [...allKinds].sort(compareText)
  }
  if (!isStrict(GeneratedHarnessActionPlanSchema, plan)) throw new Error("generated action plan failed its schema")
  return deepFreeze(plan)
}

export interface GeneratedHarnessActorIdentity {
  readonly actorName: string
  readonly artifactDigest: Sha256Digest
  readonly interfaceContract: SiteInterfaceContract
  readonly interfaceDigest: Sha256Digest
  readonly generatorRevision: typeof HARNESS_ACTOR_GENERATOR_REVISION
  readonly source: string
  readonly sourceDigest: Sha256Digest
}

export interface GeneratedHarnessActorIdentityInput {
  readonly artifact: unknown
  readonly interfaceContract?: unknown
}

const identityInputOf = (value: unknown): GeneratedHarnessActorIdentityInput => {
  if (
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.hasOwn(value, "artifact")
  ) {
    const record = value as Readonly<Record<string, unknown>>
    return {
      artifact: record.artifact,
      ...(Object.hasOwn(record, "interfaceContract") ? { interfaceContract: record.interfaceContract } : {})
    }
  }
  return { artifact: value }
}

const actorNameOf = (
  artifact: SiteHarnessArtifact,
  artifactDigest: Sha256Digest,
  interfaceDigest: Sha256Digest
): string => {
  const site = artifact.siteId.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24)
  const implementationDigest = digestOf(canonical({
    schemaVersion: 1,
    artifactDigest,
    generatorRevision: HARNESS_ACTOR_GENERATOR_REVISION
  }))
  const actorName = `site-${site}-${interfaceDigest.slice(7, 23)}-${implementationDigest.slice(7, 23)}`
  if (!ACTOR_NAME.test(actorName)) throw new Error("generated actor name is invalid")
  return actorName
}

export const generatedHarnessActorSource = (options: {
  readonly actorName: string
  readonly artifact: unknown
  readonly interfaceContract: unknown
  readonly factoryImport?: string
}): string => {
  if (!ACTOR_NAME.test(options.actorName)) throw new Error("generated actor name is invalid")
  const artifact = validateSiteHarnessArtifact(options.artifact)
  const contract = validateSiteInterfaceContract(options.interfaceContract)
  if (!interfaceContractMatchesArtifact(artifact, contract)) {
    throw new Error("site interface contract does not match the artifact's derived interface")
  }
  return [
    `import { createGeneratedHarnessActor } from ${JSON.stringify(options.factoryImport ?? GENERATED_HARNESS_FACTORY_IMPORT)}`,
    "",
    `const artifact = ${canonicalSiteHarnessArtifact(artifact)}`,
    `const interfaceContract = ${canonicalSiteInterfaceContract(contract)}`,
    "",
    "export default createGeneratedHarnessActor({",
    `  actorName: ${JSON.stringify(options.actorName)},`,
    "  artifact,",
    "  interfaceContract",
    "})",
    ""
  ].join("\n")
}

export interface GeneratedHarnessActorFactoryBundle {
  readonly source: string
  readonly digest: Sha256Digest
}

/**
 * Snapshots the reviewed generator closure, including its Tardigrade and
 * Effect dependencies, into candidate-local immutable bytes. Generated actor
 * builds import this snapshot rather than mutable repository source.
 */
export const generatedHarnessActorFactoryBundle = async (): Promise<GeneratedHarnessActorFactoryBundle> => {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.url)],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none"
  })
  if (!result.success || result.outputs.length !== 1) {
    const detail = result.logs.map((log) => log.message).join("; ")
    throw new Error(`could not snapshot the generated actor factory${detail.length === 0 ? "" : `: ${detail}`}`)
  }
  const output = result.outputs[0]!
  if (output.size <= 0 || output.size > MAX_GENERATED_HARNESS_FACTORY_BYTES) {
    throw new Error("generated actor factory snapshot exceeds its byte limit")
  }
  const source = await output.text()
  return deepFreeze({ source, digest: digestOf(source) })
}

export const generatedHarnessActorIdentity = (value: unknown): GeneratedHarnessActorIdentity => {
  const input = identityInputOf(value)
  const artifact = validateSiteHarnessArtifact(input.artifact)
  const derivedContract = siteInterfaceContractOf(artifact)
  const interfaceContract = input.interfaceContract === undefined
    ? derivedContract
    : validateSiteInterfaceContract(input.interfaceContract)
  if (!interfaceContractMatchesArtifact(artifact, interfaceContract)) {
    throw new Error("site interface contract does not match the artifact's derived interface")
  }
  const artifactDigest = siteHarnessArtifactDigest(artifact)
  const interfaceDigest = siteInterfaceContractDigest(interfaceContract)
  const actorName = actorNameOf(artifact, artifactDigest, interfaceDigest)
  const source = generatedHarnessActorSource({ actorName, artifact, interfaceContract })
  return deepFreeze({
    actorName,
    artifactDigest,
    interfaceContract,
    interfaceDigest,
    generatorRevision: HARNESS_ACTOR_GENERATOR_REVISION,
    source,
    sourceDigest: digestOf(source)
  })
}

interface GeneratedRuntimeAction {
  readonly artifact: HarnessAction
  readonly contract: SiteInterfaceAction
  readonly plan: GeneratedHarnessActionPlan
  readonly planCanonical: string
  readonly planDigest: Sha256Digest
  readonly inputSchema: Schema.ConstraintDecoder<unknown>
  readonly requestSchema: Schema.ConstraintDecoder<unknown>
  readonly plannedSchema: Schema.ConstraintDecoder<unknown>
}

const inputSchemaOf = (action: SiteInterfaceAction): Schema.ConstraintDecoder<unknown> => {
  const fields: Record<string, Schema.Constraint> = Object.create(null) as Record<string, Schema.Constraint>
  for (const input of action.inputs) {
    fields[input.name] = input.required
      ? OpaqueValueBindingSchema
      : Schema.optionalKey(OpaqueValueBindingSchema)
  }
  return Schema.Struct({ bindings: Schema.Struct(fields) }) as unknown as Schema.ConstraintDecoder<unknown>
}

const requestSchemaOf = (
  actorName: string,
  artifactDigest: Sha256Digest,
  interfaceDigest: Sha256Digest,
  action: SiteInterfaceAction,
  inputSchema: Schema.ConstraintDecoder<unknown>
): Schema.ConstraintDecoder<unknown> => Schema.Struct({
  type: Schema.Literal("GeneratedHarnessActionRequested"),
  schemaVersion: Schema.Literal(GENERATED_HARNESS_EVENT_SCHEMA_VERSION),
  actorName: Schema.Literal(actorName),
  artifactDigest: Schema.Literal(artifactDigest),
  interfaceDigest: Schema.Literal(interfaceDigest),
  actionId: Schema.Literal(action.id),
  methodName: Schema.Literal(action.methodName),
  id: Schema.String,
  invocationEpoch: NonNegativeIntSchema,
  requestDigest: DigestSchema,
  input: inputSchema,
  ...TransportFields
})

const plannedSchemaOf = (
  actorName: string,
  artifactDigest: Sha256Digest,
  interfaceDigest: Sha256Digest,
  action: SiteInterfaceAction
): Schema.ConstraintDecoder<unknown> => Schema.Struct({
  type: Schema.Literal("GeneratedHarnessActionPlanned"),
  schemaVersion: Schema.Literal(GENERATED_HARNESS_EVENT_SCHEMA_VERSION),
  actorName: Schema.Literal(actorName),
  artifactDigest: Schema.Literal(artifactDigest),
  interfaceDigest: Schema.Literal(interfaceDigest),
  actionId: Schema.Literal(action.id),
  methodName: Schema.Literal(action.methodName),
  id: Schema.String,
  invocationEpoch: NonNegativeIntSchema,
  requestDigest: DigestSchema,
  output: GeneratedHarnessActionPlanSchema,
  outputDigest: DigestSchema,
  ...TransportFields
})

const callContextMatches = (
  event: Readonly<Record<string, unknown>>,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): boolean => {
  const call = event.call
  if (call === undefined) return true
  if (typeof call !== "object" || call === null) return false
  const nested = (call as Readonly<Record<string, unknown>>).invocation
  if (typeof nested !== "object" || nested === null) return false
  const context = nested as Readonly<Record<string, unknown>>
  return context.method === invocation.method && context.id === invocation.id && context.epoch === invocation.epoch
}

const requestDigestOf = (event: Readonly<Record<string, unknown>>): Sha256Digest => digestOf(canonical({
  schemaVersion: GENERATED_HARNESS_EVENT_SCHEMA_VERSION,
  actorName: event.actorName,
  artifactDigest: event.artifactDigest,
  interfaceDigest: event.interfaceDigest,
  actionId: event.actionId,
  methodName: event.methodName,
  id: event.id,
  invocationEpoch: event.invocationEpoch,
  input: event.input
}))

const isExactRequest = (runtime: GeneratedRuntimeAction, event: Event): boolean =>
  isStrict(runtime.requestSchema, event) && event.requestDigest === requestDigestOf(event)

const isExactTerminal = (runtime: GeneratedRuntimeAction, event: Event): boolean =>
  isStrict(runtime.plannedSchema, event) &&
  event.outputDigest === runtime.planDigest &&
  canonical(event.output) === runtime.planCanonical

const requestForInvocation = (
  log: ReadonlyArray<Event>,
  runtime: GeneratedRuntimeAction,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): Event | undefined => log.find((event) =>
  isExactRequest(runtime, event) &&
  event.id === invocation.id && event.methodName === invocation.method &&
  event.invocationEpoch === invocation.epoch &&
  callContextMatches(event, invocation))

const exactPlanTerminal = (
  log: ReadonlyArray<Event>,
  runtime: GeneratedRuntimeAction,
  request: Event
): Event | undefined => {
  const requestIndex = log.indexOf(request)
  if (requestIndex < 0) return undefined
  return log.slice(requestIndex + 1).find((event) =>
    isExactTerminal(runtime, event) &&
    event.id === request.id &&
    event.invocationEpoch === request.invocationEpoch &&
    event.requestDigest === request.requestDigest)
}

const requestKeyOf = (runtime: GeneratedRuntimeAction, request: Event): string =>
  `${KEY_PREFIX}${sha256Hex(runtime.contract.id)}:${String(request.requestDigest)}:request`
const plannedKeyOf = (runtime: GeneratedRuntimeAction, terminal: Event): string =>
  `${KEY_PREFIX}${sha256Hex(runtime.contract.id)}:${String(terminal.requestDigest)}:planned:${runtime.planDigest}`

export interface GeneratedHarnessView {
  readonly requested: number
  readonly planned: number
  readonly actions: ReadonlyArray<{
    readonly id: string
    readonly methodName: string
    readonly calls: number
    readonly settled: number
  }>
}

export interface CreateGeneratedHarnessActorOptions {
  readonly actorName: string
  readonly artifact: unknown
  readonly interfaceContract: unknown
}

export const createGeneratedHarnessActor = (options: CreateGeneratedHarnessActorOptions) => {
  const artifact = validateSiteHarnessArtifact(options.artifact)
  const contract = validateSiteInterfaceContract(options.interfaceContract)
  if (!interfaceContractMatchesArtifact(artifact, contract)) {
    throw new Error("site interface contract does not match the artifact's derived interface")
  }
  const artifactDigest = siteHarnessArtifactDigest(artifact)
  const interfaceDigest = siteInterfaceContractDigest(contract)
  const expectedActorName = actorNameOf(artifact, artifactDigest, interfaceDigest)
  if (options.actorName !== expectedActorName) {
    throw new Error(`generated actor name must equal ${JSON.stringify(expectedActorName)}`)
  }

  const artifactActions = new Map(artifact.actions.map((action) => [action.id, action]))
  const runtimes = contract.actions.map((action): GeneratedRuntimeAction => {
    const implementation = artifactActions.get(action.id)
    if (implementation === undefined) throw new Error(`interface action ${JSON.stringify(action.id)} has no implementation`)
    const plan = generatedHarnessActionPlanOf(artifact, contract, action.id)
    const planCanonical = canonical(plan)
    const inputSchema = inputSchemaOf(action)
    return {
      artifact: implementation,
      contract: action,
      plan,
      planCanonical,
      planDigest: digestOf(planCanonical),
      inputSchema,
      requestSchema: requestSchemaOf(options.actorName, artifactDigest, interfaceDigest, action, inputSchema),
      plannedSchema: plannedSchemaOf(options.actorName, artifactDigest, interfaceDigest, action)
    }
  })

  const runtimeByMethod = new Map(runtimes.map((runtime) => [runtime.contract.methodName, runtime]))
  const methods: Record<string, ActorMethodDeclaration> = Object.create(null) as Record<string, ActorMethodDeclaration>
  for (const runtime of runtimes) {
    const declaration = actorMethod({
      input: runtime.inputSchema,
      output: GeneratedHarnessActionPlanSchema,
      event: ({ invocation, input, at }): Event => {
        const request = {
          type: "GeneratedHarnessActionRequested" as const,
          schemaVersion: GENERATED_HARNESS_EVENT_SCHEMA_VERSION,
          actorName: options.actorName,
          artifactDigest,
          interfaceDigest,
          actionId: runtime.contract.id,
          methodName: runtime.contract.methodName,
          id: invocation.id,
          invocationEpoch: invocation.epoch,
          input
        }
        return { ...request, requestDigest: requestDigestOf(request), at }
      },
      state: (log, invocation) => {
        const request = requestForInvocation(log, runtime, invocation)
        if (request === undefined) return undefined
        return exactPlanTerminal(log, runtime, request) === undefined
          ? { status: "pending" as const }
          : { status: "completed" as const, output: runtime.plan }
      }
    })
    const eventOf = declaration.eventOf
    methods[runtime.contract.methodName] = {
      ...declaration,
      eventOf: (call: ActorMethodCall<unknown>): Event => {
        const strictInput = Schema.decodeUnknownSync(runtime.inputSchema, { onExcessProperty: "error" })(call.input)
        return eventOf({ ...call, input: strictInput })
      }
    }
  }

  const keys: KeyFragment = {
    prefixes: [KEY_PREFIX],
    keyOf: (event) => {
      const methodName = typeof event.methodName === "string" ? event.methodName : undefined
      const runtime = methodName === undefined ? undefined : runtimeByMethod.get(methodName)
      if (runtime === undefined) return undefined
      if (isExactRequest(runtime, event)) return requestKeyOf(runtime, event)
      if (isExactTerminal(runtime, event)) return plannedKeyOf(runtime, event)
      return undefined
    }
  }

  const component: Component<GeneratedHarnessView> = {
    name: "generated-site-harness",
    keys,
    derive: (log) => {
      const indexed = new Map<GeneratedRuntimeAction, {
        readonly requests: Array<{ readonly event: Event; readonly index: number }>
        readonly terminalIndexes: Map<string, number>
        planned: number
      }>(runtimes.map((runtime) => [runtime, { requests: [], terminalIndexes: new Map(), planned: 0 }]))
      for (const [index, event] of log.entries()) {
        const methodName = typeof event.methodName === "string" ? event.methodName : undefined
        const runtime = methodName === undefined ? undefined : runtimeByMethod.get(methodName)
        if (runtime === undefined) continue
        const bucket = indexed.get(runtime)!
        if (event.type === "GeneratedHarnessActionRequested" && isExactRequest(runtime, event)) {
          bucket.requests.push({ event, index })
          continue
        }
        if (event.type === "GeneratedHarnessActionPlanned" && isExactTerminal(runtime, event)) {
          bucket.terminalIndexes.set(String(event.requestDigest), index)
          bucket.planned += 1
        }
      }

      const transitions = runtimes.flatMap((runtime): ReadonlyArray<Transition<never, never>> =>
        indexed.get(runtime)!.requests.flatMap(({ event: request, index: requestIndex }) => {
          const terminalIndex = indexed.get(runtime)!.terminalIndexes.get(String(request.requestDigest))
          if (terminalIndex !== undefined && terminalIndex > requestIndex) return []
          return [intent({
            key: `${KEY_PREFIX}${sha256Hex(runtime.contract.id)}:${String(request.requestDigest)}:planned:${runtime.planDigest}`,
            ...(
              typeof request.call === "object" && request.call !== null &&
              typeof (request.call as Readonly<Record<string, unknown>>).invocation === "object"
                ? { invocation: (request.call as { readonly invocation: { readonly method: string; readonly id: string; readonly epoch: number } }).invocation }
                : {}
            ),
            input: {
              id: String(request.id),
              invocationEpoch: Number(request.invocationEpoch),
              requestDigest: String(request.requestDigest),
              runtime
            },
            events: (input, at): ReadonlyArray<Event> => [{
              type: "GeneratedHarnessActionPlanned",
              schemaVersion: GENERATED_HARNESS_EVENT_SCHEMA_VERSION,
              actorName: options.actorName,
              artifactDigest,
              interfaceDigest,
              actionId: input.runtime.contract.id,
              methodName: input.runtime.contract.methodName,
              id: input.id,
              invocationEpoch: input.invocationEpoch,
              requestDigest: input.requestDigest,
              output: input.runtime.plan,
              outputDigest: input.runtime.planDigest,
              at
            }]
          })]
        }))
      return {
        view: {
          requested: runtimes.reduce((count, runtime) => count + indexed.get(runtime)!.requests.length, 0),
          planned: runtimes.reduce((count, runtime) => count + indexed.get(runtime)!.planned, 0),
          actions: runtimes.map((runtime) => {
            const bucket = indexed.get(runtime)!
            return {
              id: runtime.contract.id,
              methodName: runtime.contract.methodName,
              calls: bucket.requests.length,
              settled: bucket.requests.filter(({ event: request, index: requestIndex }) => {
                const terminalIndex = bucket.terminalIndexes.get(String(request.requestDigest))
                return terminalIndex !== undefined && terminalIndex > requestIndex
              }).length
            }
          })
        },
        transitions
      }
    }
  }

  let handled: Component<GeneratedHarnessView> = component
  for (const method of Object.values(methods)) handled = handles(method, handled)
  return actor({
    name: options.actorName,
    methods: methods as ActorMethods,
    components: [handled]
  })
}
