import { Effect, Schema } from "effect"
import { actorMethod, type Component } from "tardie"
import type { KeyFragment } from "tardie/core/log"
import type { Event } from "tardie/core/log/event"
import { effect, intent, type Transition } from "tardie/core/reconciliation"
import {
  SITE_HARNESS_LIMITS,
  canonicalSiteHarnessArtifact,
  siteHarnessArtifactDigest,
  validateSiteHarnessArtifact,
  type HarnessAction,
  type HarnessInput,
  type HarnessStep,
  type SiteHarnessArtifact,
  type ValueProducer
} from "./harness-artifact"
import { openHarnessRegistry } from "./harness-registry"
import { canonicalStringify, compareText, sha256 } from "./har"
import { CaptureIdSchema, validatedHarCaptureFactsOf } from "./har-component"
import {
  HarnessDraftBuildError,
  buildSiteHarnessDraftFromLog,
  buildObservedReadHarnessDraft,
  type BuildObservedReadHarnessDraftOptions,
  type LogSiteHarnessDraft,
  type HarnessDraftBuildFailureCode
} from "./harness-builder"
import {
  HarnessActorCatalog,
  type RoutableHarnessActor
} from "./harness-actor-catalog"
import {
  SITE_INTERFACE_ABI,
  SITE_INTERFACE_SCHEMA_VERSION,
  canonicalSiteInterfaceContract,
  harnessLifecycleEventId,
  siteInterfaceContractDigest
} from "./harness-interface"

export const HARNESS_EVENT_SCHEMA_VERSION = 1 as const

const KEY_PREFIX = "harness1:"
const DRAFT_KEY_PREFIX = "harnessdraft1:"
const COMPOSITION_KEY_PREFIX = "harnesscomposition1:"
const ACTOR_ROUTE_KEY_PREFIX = "harnessroute1:"
const LIFECYCLE_KEY_PREFIX = "harnesslifecycle1:"
const MAX_DRAFT_OUTPUT_BYTES = 1024 * 1024
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ACTOR_NAME = /^[a-z][a-z0-9-]{0,62}$/u
const METHOD_NAME = /^[a-z][A-Za-z0-9-]{0,62}$/u
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u

const boundedString = (max: number) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => value.length <= max,
  { title: `at most ${max} characters` }
)))
const matchingString = (pattern: RegExp, title: string) => Schema.String.pipe(Schema.check(Schema.makeFilter(
  (value: string) => pattern.test(value),
  { title }
)))
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value >= 0,
  { title: "non-negative" }
)))
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value > 0,
  { title: "positive" }
)))
const HttpStatus = Schema.Int.pipe(Schema.check(Schema.makeFilter(
  (value: number) => value >= 100 && value <= 599,
  { title: "HTTP status" }
)))

export const HarnessIdentifierSchema = matchingString(IDENTIFIER, "lowercase harness identifier").pipe(
  Schema.check(Schema.makeFilter((value: string) => value.length <= 64, { title: "at most 64 characters" }))
)
const DigestSchema = matchingString(DIGEST, "sha256 digest")

const InvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: NonNegativeInt
})
const InvocationContextSchema = Schema.Struct({
  invocation: InvocationSchema,
  parent: Schema.optionalKey(InvocationSchema),
  deadlineAt: Schema.optionalKey(NonNegativeInt)
})
const TransportFields = {
  at: Schema.optionalKey(NonNegativeInt),
  traceparent: Schema.optionalKey(matchingString(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u,
    "W3C traceparent"
  )),
  call: Schema.optionalKey(InvocationContextSchema),
  link: Schema.optionalKey(Schema.Unknown)
}

export const ProducerKindSchema = Schema.Literals([
  "input",
  "clock",
  "uuid",
  "response_header",
  "response_json",
  "constant",
  "object",
  "array",
  "wasm",
  "js"
])
export type ProducerKind = typeof ProducerKindSchema.Type

const ProducerKindsSchema = Schema.Array(ProducerKindSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<ProducerKind>) => values.length <= 10 && values.every((value, index) =>
    index === 0 || compareText(values[index - 1]!, value) < 0),
  { title: "at most nine unique sorted producer kinds" }
)))
const InputSchema = Schema.Struct({
  name: HarnessIdentifierSchema,
  type: Schema.Literals(["string", "number", "integer", "boolean", "json"]),
  required: Schema.Boolean
})
const InputsSchema = Schema.Array(InputSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.inputsPerAction,
  { title: "bounded action inputs" }
)))
const BindingSchema = Schema.Struct({
  name: boundedString(256),
  producerKinds: ProducerKindsSchema
})
const BindingsSchema = Schema.Array(BindingSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.bindingsPerStep,
  { title: "bounded step bindings" }
)))
const DependenciesSchema = Schema.Array(HarnessIdentifierSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.dependenciesPerStep,
  { title: "bounded step dependencies" }
)))
const StatusesSchema = Schema.Array(HttpStatus).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length > 0 && values.length <= SITE_HARNESS_LIMITS.expectedStatusesPerStep,
  { title: "bounded expected statuses" }
)))
const StepPlanSchema = Schema.Struct({
  id: HarnessIdentifierSchema,
  dependsOn: DependenciesSchema,
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  origin: boundedString(512),
  path: boundedString(1_024),
  pathParameters: BindingsSchema,
  query: BindingsSchema,
  headers: BindingsSchema,
  bodyProducerKinds: Schema.optionalKey(ProducerKindsSchema),
  expectedStatuses: StatusesSchema
})
const StepsSchema = Schema.Array(StepPlanSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length > 0 && values.length <= SITE_HARNESS_LIMITS.stepsPerAction,
  { title: "bounded action steps" }
)))

export const SiteActionPlanSchema = Schema.Struct({
  siteId: HarnessIdentifierSchema,
  environment: HarnessIdentifierSchema,
  action: HarnessIdentifierSchema,
  generation: PositiveInt,
  artifactDigest: DigestSchema,
  artifactVersion: boundedString(64),
  sourceCaptureDigest: DigestSchema,
  inputs: InputsSchema,
  steps: StepsSchema,
  producerKinds: ProducerKindsSchema
})
export type SiteActionPlan = typeof SiteActionPlanSchema.Type

export const HarnessTargetIdSchema = matchingString(TARGET_ID, "bounded harness target identifier")
const ActorNameSchema = matchingString(ACTOR_NAME, "Tardigrade actor name")
const MethodNameSchema = matchingString(METHOD_NAME, "Tardigrade method name")
const RoutedActionSchema = Schema.Struct({
  id: HarnessIdentifierSchema,
  methodName: MethodNameSchema,
  inputs: InputsSchema
})
const RoutedActionsSchema = Schema.Array(RoutedActionSchema).pipe(Schema.check(Schema.makeFilter(
  (actions) => actions.length > 0 && actions.length <= SITE_HARNESS_LIMITS.actions &&
    actions.every((action, index) => index === 0 || compareText(actions[index - 1]!.id, action.id) < 0) &&
    new Set(actions.map((action) => action.methodName)).size === actions.length &&
    actions.every((action) => action.inputs.every((input, index) =>
      index === 0 || compareText(action.inputs[index - 1]!.name, input.name) < 0)),
  { title: "bounded, uniquely sorted site actor actions" }
)))

export const SiteActorRouteSchema = Schema.Struct({
  siteId: HarnessIdentifierSchema,
  environment: HarnessIdentifierSchema,
  targetId: HarnessTargetIdSchema,
  generation: PositiveInt,
  actorName: ActorNameSchema,
  artifactDigest: DigestSchema,
  interfaceDigest: DigestSchema,
  sourceDigest: DigestSchema,
  buildDigest: DigestSchema,
  definitionDigest: DigestSchema,
  actions: RoutedActionsSchema
})
export type SiteActorRoute = typeof SiteActorRouteSchema.Type

const IdentityFields = {
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  siteId: HarnessIdentifierSchema,
  environment: HarnessIdentifierSchema,
  action: HarnessIdentifierSchema
}
const SiteActionPlanRequestedSchema = Schema.Struct({
  type: Schema.Literal("SiteActionPlanRequested"),
  ...IdentityFields,
  ...TransportFields
})
const HarnessResolvedSchema = Schema.Struct({
  type: Schema.Literal("HarnessResolved"),
  ...IdentityFields,
  generation: PositiveInt,
  artifactDigest: DigestSchema,
  artifact: Schema.Unknown,
  ...TransportFields
})
const HarnessResolutionFailedSchema = Schema.Struct({
  type: Schema.Literal("HarnessResolutionFailed"),
  ...IdentityFields,
  code: Schema.Literals(["registry_not_configured", "harness_not_found", "registry_unavailable", "artifact_invalid"]),
  error: boundedString(256),
  ...TransportFields
})
const ActionPlanPreparedSchema = Schema.Struct({
  type: Schema.Literal("ActionPlanPrepared"),
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  output: SiteActionPlanSchema,
  outputDigest: DigestSchema,
  ...TransportFields
})
const ActionPlanFailedSchema = Schema.Struct({
  type: Schema.Literal("ActionPlanFailed"),
  ...IdentityFields,
  code: Schema.Literals(["action_not_found", "artifact_invalid"]),
  error: boundedString(256),
  ...TransportFields
})

const ActionCandidateIdSchema = matchingString(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  "action candidate identifier"
)
const UsedDependencyRefSchema = Schema.Struct({
  from: boundedString(128),
  to: boundedString(128),
  reason: Schema.Literals(["redirect", "initiator", "referer", "cookie", "value-flow"]),
  evidence: boundedString(256)
})
const UsedDependencyRefsSchema = Schema.Array(UsedDependencyRefSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.producerNodes,
  { title: "bounded structural dependency references" }
)))
const DraftIssueCodeSchema = Schema.Literals([
  "ambiguous_dependency",
  "array_selection_required",
  "dynamic_value_missing",
  "session_adapter_required",
  "site_control_dependency",
  "status_unknown"
])
const DraftIssueRefSchema = Schema.Struct({
  stepId: HarnessIdentifierSchema,
  location: boundedString(512),
  code: DraftIssueCodeSchema
})
const DraftIssueRefsSchema = Schema.Array(DraftIssueRefSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.producerNodes,
  { title: "bounded unresolved structural locations" }
)))

export interface SiteHarnessDraftOutput {
  readonly captureId: string
  readonly importDigest: string
  readonly actionId: string
  readonly artifactDigest: string
  readonly artifact: SiteHarnessArtifact
  readonly usedDependencies: ReadonlyArray<{
    readonly from: string
    readonly to: string
    readonly reason: "redirect" | "initiator" | "referer" | "cookie" | "value-flow"
    readonly evidence: string
  }>
  readonly unresolved: ReadonlyArray<{
    readonly stepId: string
    readonly location: string
    readonly code: typeof DraftIssueCodeSchema.Type
  }>
}

export const SiteHarnessDraftOutputSchema = Schema.Struct({
  captureId: CaptureIdSchema,
  importDigest: DigestSchema,
  actionId: ActionCandidateIdSchema,
  artifactDigest: DigestSchema,
  artifact: Schema.Unknown,
  usedDependencies: UsedDependencyRefsSchema,
  unresolved: DraftIssueRefsSchema
})

const CompositionFindingRefSchema = Schema.Struct({
  actionId: HarnessIdentifierSchema,
  stepId: HarnessIdentifierSchema,
  location: boundedString(512),
  code: DraftIssueCodeSchema
})
const CompositionFindingRefsSchema = Schema.Array(CompositionFindingRefSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.producerNodes,
  { title: "bounded composition findings" }
)))
const safeSemanticText = (value: string): boolean =>
  value.trim() === value && value.length > 0 &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  !/(?:https?:\/\/|vault:v1:|sha256:|(?:^|\s)\/[A-Za-z0-9])/iu.test(value)
const SemanticNameSchema = boundedString(80).pipe(Schema.check(Schema.makeFilter(
  safeSemanticText,
  { title: "non-empty value-free single-line semantic name" }
)))
const SemanticDescriptionSchema = boundedString(280).pipe(Schema.check(Schema.makeFilter(
  safeSemanticText,
  { title: "non-empty value-free single-line semantic description" }
)))
const CompositionDependencySemanticSchema = Schema.Struct({
  id: boundedString(128),
  fromStepId: HarnessIdentifierSchema,
  toStepId: HarnessIdentifierSchema,
  reason: Schema.Literals(["redirect", "initiator", "referer", "cookie", "value-flow"]),
  evidence: boundedString(512),
  name: SemanticNameSchema,
  description: SemanticDescriptionSchema,
  labelSource: Schema.Literals(["model", "structural"])
})
const CompositionInterfaceSemanticSchema = Schema.Struct({
  id: HarnessIdentifierSchema,
  name: SemanticNameSchema,
  description: SemanticDescriptionSchema,
  labelSource: Schema.Literals(["model", "structural"]),
  dependencies: Schema.Array(CompositionDependencySemanticSchema).pipe(Schema.check(Schema.makeFilter(
    (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.producerNodes,
    { title: "bounded semantic dependencies" }
  )))
})
const CompositionInterfaceSemanticsSchema = Schema.Array(CompositionInterfaceSemanticSchema).pipe(Schema.check(Schema.makeFilter(
  (values: ReadonlyArray<unknown>) => values.length <= SITE_HARNESS_LIMITS.actions,
  { title: "bounded semantic interfaces" }
)))

export interface HarnessCompositionDependencySemantic {
  readonly id: string
  readonly fromStepId: string
  readonly toStepId: string
  readonly reason: "redirect" | "initiator" | "referer" | "cookie" | "value-flow"
  readonly evidence: string
  readonly name: string
  readonly description: string
  readonly labelSource: "model" | "structural"
}

export interface HarnessCompositionInterfaceSemantic {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly labelSource: "model" | "structural"
  readonly dependencies: ReadonlyArray<HarnessCompositionDependencySemantic>
}

export interface HarnessCompositionOutput {
  readonly captureId: string
  readonly importDigest: string
  readonly artifactDigest: string
  readonly artifact: SiteHarnessArtifact
  readonly authorActor: string
  readonly authorRevision: string
  readonly proposalDigest: string
  readonly selectedReadInterfaces: number
  readonly callerInputRepairs: number
  readonly externalSessionRequirements: number
  /** Optional only for compatibility with composition events written before author revision 4. */
  readonly interfaceSemantics?: ReadonlyArray<HarnessCompositionInterfaceSemantic>
  readonly usedDependencies: SiteHarnessDraftOutput["usedDependencies"]
  readonly unresolved: ReadonlyArray<{
    readonly actionId: string
    readonly stepId: string
    readonly location: string
    readonly code: typeof DraftIssueCodeSchema.Type
  }>
  readonly syntheticEvidenceDigest: string
  readonly syntheticCases: number
  readonly syntheticGates: number
  readonly syntheticGatesPassed: number
}

export const HarnessCompositionOutputSchema = Schema.Struct({
  captureId: CaptureIdSchema,
  importDigest: DigestSchema,
  artifactDigest: DigestSchema,
  artifact: Schema.Unknown,
  authorActor: ActorNameSchema,
  authorRevision: boundedString(128),
  proposalDigest: DigestSchema,
  selectedReadInterfaces: NonNegativeInt,
  callerInputRepairs: NonNegativeInt,
  externalSessionRequirements: NonNegativeInt,
  interfaceSemantics: Schema.optionalKey(CompositionInterfaceSemanticsSchema),
  usedDependencies: UsedDependencyRefsSchema,
  unresolved: CompositionFindingRefsSchema,
  syntheticEvidenceDigest: DigestSchema,
  syntheticCases: NonNegativeInt,
  syntheticGates: NonNegativeInt,
  syntheticGatesPassed: NonNegativeInt
})

const HarnessCompositionPreparedSchema = Schema.Struct({
  type: Schema.Literal("HarnessCompositionPrepared"),
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  output: HarnessCompositionOutputSchema,
  outputDigest: DigestSchema,
  ...TransportFields
})

const DraftIdentityFields = {
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  captureId: CaptureIdSchema,
  actionId: Schema.optionalKey(ActionCandidateIdSchema)
}
const SiteHarnessDraftRequestedSchema = Schema.Struct({
  type: Schema.Literal("SiteHarnessDraftRequested"),
  ...DraftIdentityFields,
  ...TransportFields
})
const SiteHarnessDraftPreparedSchema = Schema.Struct({
  type: Schema.Literal("SiteHarnessDraftPrepared"),
  ...DraftIdentityFields,
  output: SiteHarnessDraftOutputSchema,
  outputDigest: DigestSchema,
  ...TransportFields
})
const SiteHarnessDraftFailedSchema = Schema.Struct({
  type: Schema.Literal("SiteHarnessDraftFailed"),
  ...DraftIdentityFields,
  code: Schema.Literals([
    "capture_not_found",
    "capture_incomplete",
    "capture_invalid",
    "action_not_found",
    "draft_invalid"
  ]),
  error: boundedString(256),
  ...TransportFields
})

const ActorRouteIdentityFields = {
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  id: Schema.String,
  invocationEpoch: NonNegativeInt,
  requestDigest: DigestSchema,
  siteId: HarnessIdentifierSchema,
  environment: HarnessIdentifierSchema,
  targetId: HarnessTargetIdSchema
}
const SiteActorResolutionRequestedSchema = Schema.Struct({
  type: Schema.Literal("SiteActorResolutionRequested"),
  ...ActorRouteIdentityFields,
  ...TransportFields
})
const SiteActorResolvedSchema = Schema.Struct({
  type: Schema.Literal("SiteActorResolved"),
  ...ActorRouteIdentityFields,
  output: SiteActorRouteSchema,
  outputDigest: DigestSchema,
  ...TransportFields
})
const SiteActorResolutionFailedSchema = Schema.Struct({
  type: Schema.Literal("SiteActorResolutionFailed"),
  ...ActorRouteIdentityFields,
  code: Schema.Literals(["not_found", "not_routable"]),
  ...TransportFields
})

const LifecycleTransportFields = {
  at: Schema.optionalKey(NonNegativeInt),
  traceparent: Schema.optionalKey(matchingString(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u,
    "W3C traceparent"
  ))
}
const LifecycleEventIdSchema = matchingString(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,511}$/u,
  "bounded opaque lifecycle event identifier"
)
const LifecycleLoadIdSchema = matchingString(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u,
  "bounded opaque lifecycle load identifier"
)
const LifecycleCodeSchema = matchingString(
  /^[a-z][a-z0-9_]{0,63}$/u,
  "safe lifecycle result code"
)
const LifecycleIdentityFields = {
  schemaVersion: Schema.Literal(HARNESS_EVENT_SCHEMA_VERSION),
  eventId: LifecycleEventIdSchema,
  harnessId: DigestSchema,
  siteId: HarnessIdentifierSchema,
  environment: HarnessIdentifierSchema,
  generation: PositiveInt,
  artifactDigest: DigestSchema,
  interfaceDigest: DigestSchema,
  sourceDigest: DigestSchema,
  buildDigest: DigestSchema,
  definitionDigest: DigestSchema,
  actorName: ActorNameSchema,
  generatorRevision: boundedString(128),
  actions: RoutedActionsSchema
}
const LifecycleDeploymentFields = {
  targetId: HarnessTargetIdSchema,
  targetOriginDigest: DigestSchema,
  definitionApprovalDigest: DigestSchema,
  loadId: LifecycleLoadIdSchema
}
const HarnessActivationObservedSchema = Schema.Struct({
  type: Schema.Literal("HarnessActivationObserved"),
  ...LifecycleIdentityFields,
  ...LifecycleTransportFields
})
const HarnessActorGeneratedSchema = Schema.Struct({
  type: Schema.Literal("HarnessActorGenerated"),
  ...LifecycleIdentityFields,
  ...LifecycleTransportFields
})
const HarnessDefinitionApprovalObservedSchema = Schema.Struct({
  type: Schema.Literal("HarnessDefinitionApprovalObserved"),
  ...LifecycleIdentityFields,
  ...LifecycleDeploymentFields,
  ...LifecycleTransportFields
})
const HarnessDefinitionInstalledSchema = Schema.Struct({
  type: Schema.Literal("HarnessDefinitionInstalled"),
  ...LifecycleIdentityFields,
  ...LifecycleDeploymentFields,
  ...LifecycleTransportFields
})
const HarnessDefinitionLoadFailedSchema = Schema.Struct({
  type: Schema.Literal("HarnessDefinitionLoadFailed"),
  ...LifecycleIdentityFields,
  ...LifecycleDeploymentFields,
  code: LifecycleCodeSchema,
  ...LifecycleTransportFields
})
const HarnessPublicRouteVerifiedSchema = Schema.Struct({
  type: Schema.Literal("HarnessPublicRouteVerified"),
  ...LifecycleIdentityFields,
  ...LifecycleDeploymentFields,
  code: LifecycleCodeSchema,
  ...LifecycleTransportFields
})
const HarnessPublicRouteUnavailableSchema = Schema.Struct({
  type: Schema.Literal("HarnessPublicRouteUnavailable"),
  ...LifecycleIdentityFields,
  ...LifecycleDeploymentFields,
  code: LifecycleCodeSchema,
  ...LifecycleTransportFields
})

type RequestedEvent = typeof SiteActionPlanRequestedSchema.Type
type ResolvedEvent = typeof HarnessResolvedSchema.Type
type ResolutionFailedEvent = typeof HarnessResolutionFailedSchema.Type
type PreparedEvent = typeof ActionPlanPreparedSchema.Type
type PlanFailedEvent = typeof ActionPlanFailedSchema.Type
type DraftRequestedEvent = typeof SiteHarnessDraftRequestedSchema.Type
type DraftPreparedEvent = typeof SiteHarnessDraftPreparedSchema.Type
type DraftFailedEvent = typeof SiteHarnessDraftFailedSchema.Type
type CompositionPreparedEvent = typeof HarnessCompositionPreparedSchema.Type
type ActorRouteRequestedEvent = typeof SiteActorResolutionRequestedSchema.Type
type ActorRouteResolvedEvent = typeof SiteActorResolvedSchema.Type
type ActorRouteFailedEvent = typeof SiteActorResolutionFailedSchema.Type
type LifecycleEvent =
  | typeof HarnessActivationObservedSchema.Type
  | typeof HarnessActorGeneratedSchema.Type
  | typeof HarnessDefinitionApprovalObservedSchema.Type
  | typeof HarnessDefinitionInstalledSchema.Type
  | typeof HarnessDefinitionLoadFailedSchema.Type
  | typeof HarnessPublicRouteVerifiedSchema.Type
  | typeof HarnessPublicRouteUnavailableSchema.Type

interface RequestScope {
  readonly id: string
  readonly siteId: string
  readonly environment: string
  readonly action: string
}

const is = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): value is S["Type"] => {
  return Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)._tag === "Some"
}

const scopeOf = (event: RequestScope): RequestScope => ({
  id: event.id,
  siteId: event.siteId,
  environment: event.environment,
  action: event.action
})
const sameScope = (left: RequestScope, right: RequestScope): boolean =>
  left.id === right.id && left.siteId === right.siteId && left.environment === right.environment && left.action === right.action
const scopeHashOf = (scope: RequestScope): string => sha256(canonicalStringify({
  siteId: scope.siteId,
  environment: scope.environment,
  action: scope.action
}))
const callHashOf = (scope: RequestScope): string => sha256(scope.id)
const keyBaseOf = (scope: RequestScope): string =>
  `${KEY_PREFIX}${scopeHashOf(scope)}:${callHashOf(scope)}`
const requestKeyOf = (scope: RequestScope): string => `${keyBaseOf(scope)}:request`
const resolutionKeyOf = (scope: RequestScope): string => `${keyBaseOf(scope)}:resolve`
const planFailureKeyOf = (scope: RequestScope, code: string): string => `${keyBaseOf(scope)}:failed:${code}`
const preparedKeyOf = (scope: RequestScope, outputDigest: string): string =>
  `${keyBaseOf(scope)}:prepared:${outputDigest}`

interface DraftRequestScope {
  readonly id: string
  readonly captureId: string
  readonly actionId?: string
}

const draftScopeOf = (event: DraftRequestScope): DraftRequestScope => ({
  id: event.id,
  captureId: event.captureId,
  ...(event.actionId === undefined ? {} : { actionId: event.actionId })
})
const sameDraftScope = (left: DraftRequestScope, right: DraftRequestScope): boolean =>
  left.id === right.id && left.captureId === right.captureId && left.actionId === right.actionId
const draftScopeHashOf = (scope: DraftRequestScope): string => sha256(canonicalStringify({
  captureId: scope.captureId,
  actionId: scope.actionId ?? null
}))
const draftKeyBaseOf = (scope: DraftRequestScope): string =>
  `${DRAFT_KEY_PREFIX}${draftScopeHashOf(scope)}:${sha256(scope.id)}`
const draftRequestKeyOf = (scope: DraftRequestScope): string => `${draftKeyBaseOf(scope)}:request`
const draftPreparedKeyOf = (scope: DraftRequestScope, outputDigest: string): string =>
  `${draftKeyBaseOf(scope)}:prepared:${outputDigest}`
const compositionPreparedKeyOf = (event: CompositionPreparedEvent): string =>
  `${COMPOSITION_KEY_PREFIX}${sha256(event.id)}:${event.outputDigest}`
const draftFailedKeyOf = (
  scope: DraftRequestScope,
  code: HarnessDraftBuildFailureCode,
  error: string
): string => `${draftKeyBaseOf(scope)}:failed:${code}:${sha256(error)}`

interface ActorRouteScope {
  readonly id: string
  readonly invocationEpoch: number
  readonly siteId: string
  readonly environment: string
  readonly targetId: string
  readonly requestDigest: string
}

const actorRouteRequestDigestOf = (scope: Omit<ActorRouteScope, "requestDigest">): string =>
  `sha256:${sha256(canonicalStringify({
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    method: "resolveSiteActor",
    ...scope
  }))}`
const actorRouteScopeOf = (event: ActorRouteScope): ActorRouteScope => ({
  id: event.id,
  invocationEpoch: event.invocationEpoch,
  siteId: event.siteId,
  environment: event.environment,
  targetId: event.targetId,
  requestDigest: event.requestDigest
})
const actorRouteScopeMatches = (left: ActorRouteScope, right: ActorRouteScope): boolean =>
  left.id === right.id && left.invocationEpoch === right.invocationEpoch &&
  left.siteId === right.siteId && left.environment === right.environment &&
  left.targetId === right.targetId && left.requestDigest === right.requestDigest
const actorRouteKeyBaseOf = (scope: ActorRouteScope): string =>
  `${ACTOR_ROUTE_KEY_PREFIX}${scope.requestDigest}`
const actorRouteRequestKeyOf = (scope: ActorRouteScope): string => `${actorRouteKeyBaseOf(scope)}:request`
const actorRouteResolutionKeyOf = (scope: ActorRouteScope): string => `${actorRouteKeyBaseOf(scope)}:catalog`

const isValidSiteActorRoute = (value: unknown): value is SiteActorRoute => {
  if (!is(SiteActorRouteSchema, value) || value.definitionDigest !== value.buildDigest) return false
  try {
    const contract = {
      schemaVersion: SITE_INTERFACE_SCHEMA_VERSION,
      interfaceAbi: SITE_INTERFACE_ABI,
      siteId: value.siteId,
      actions: value.actions
    }
    canonicalSiteInterfaceContract(contract)
    return siteInterfaceContractDigest(contract) === value.interfaceDigest
  } catch {
    return false
  }
}

const siteActorRouteOf = (value: RoutableHarnessActor): SiteActorRoute | undefined => {
  const output: SiteActorRoute = {
    siteId: value.siteId,
    environment: value.environment,
    targetId: value.targetId,
    generation: value.generation,
    actorName: value.actorName,
    artifactDigest: value.artifactDigest,
    interfaceDigest: value.interfaceDigest,
    sourceDigest: value.sourceDigest,
    buildDigest: value.buildDigest,
    definitionDigest: value.definitionDigest,
    actions: value.actions.map((action) => ({
      id: action.id,
      methodName: action.methodName,
      inputs: action.inputs.map((input) => ({ ...input }))
    }))
  }
  return isValidSiteActorRoute(output) ? output : undefined
}

const actorRouteOutputDigestOf = (scope: ActorRouteScope, output: SiteActorRoute): string =>
  `sha256:${sha256(canonicalStringify({ requestDigest: scope.requestDigest, output }))}`

const planDigestOf = (output: SiteActionPlan): string => `sha256:${sha256(canonicalStringify(output))}`

const artifactOf = (event: ResolvedEvent): SiteHarnessArtifact | undefined => {
  try {
    const artifact = validateSiteHarnessArtifact(event.artifact)
    const canonicalJson = canonicalSiteHarnessArtifact(artifact)
    if (new TextEncoder().encode(canonicalJson).byteLength > SITE_HARNESS_LIMITS.artifactBytes) return undefined
    if (artifact.siteId !== event.siteId || siteHarnessArtifactDigest(artifact) !== event.artifactDigest) return undefined
    return artifact
  } catch {
    return undefined
  }
}

const isResolvedEvent = (value: unknown): value is ResolvedEvent =>
  is(HarnessResolvedSchema, value) && artifactOf(value) !== undefined
const isPreparedEvent = (value: unknown): value is PreparedEvent =>
  is(ActionPlanPreparedSchema, value) && planDigestOf(value.output) === value.outputDigest

const draftOutputDigestOf = (output: SiteHarnessDraftOutput): string =>
  `sha256:${sha256(canonicalStringify(output))}`

const validatedDraftOutput = (value: unknown): SiteHarnessDraftOutput | undefined => {
  if (!is(SiteHarnessDraftOutputSchema, value)) return undefined
  try {
    const artifact = validateSiteHarnessArtifact(value.artifact)
    const canonicalJson = canonicalSiteHarnessArtifact(artifact)
    if (
      new TextEncoder().encode(canonicalJson).byteLength > SITE_HARNESS_LIMITS.artifactBytes ||
      new TextEncoder().encode(canonicalStringify({ ...value, artifact })).byteLength > MAX_DRAFT_OUTPUT_BYTES ||
      artifact.sourceCaptureDigest !== value.importDigest ||
      siteHarnessArtifactDigest(artifact) !== value.artifactDigest
    ) return undefined
    return { ...value, artifact }
  } catch {
    return undefined
  }
}

const isDraftPreparedEvent = (value: unknown): value is DraftPreparedEvent => {
  if (!is(SiteHarnessDraftPreparedSchema, value)) return false
  const output = validatedDraftOutput(value.output)
  return output !== undefined && draftOutputDigestOf(output) === value.outputDigest
}

const compositionOutputDigestOf = (output: HarnessCompositionOutput): string =>
  `sha256:${sha256(canonicalStringify(output))}`

const validatedCompositionOutput = (value: unknown): HarnessCompositionOutput | undefined => {
  if (!is(HarnessCompositionOutputSchema, value)) return undefined
  try {
    const artifact = validateSiteHarnessArtifact(value.artifact)
    const canonicalOutput = { ...value, artifact }
    const actionSteps = new Map(artifact.actions.map((action) => [
      action.id,
      new Set(action.steps.map((step) => step.id))
    ] as const))
    const dependencyKey = (dependency: { readonly from: string; readonly to: string; readonly reason: string; readonly evidence: string }): string =>
      `${dependency.from}\u0000${dependency.to}\u0000${dependency.reason}\u0000${dependency.evidence}`
    const semanticsValid = value.interfaceSemantics === undefined || (() => {
      const semanticIds = value.interfaceSemantics.map((item) => item.id)
      const artifactIds = artifact.actions.map((action) => action.id).sort(compareText)
      if (
        new Set(semanticIds).size !== semanticIds.length ||
        canonicalStringify([...semanticIds].sort(compareText)) !== canonicalStringify(artifactIds)
      ) return false
      return value.interfaceSemantics.every((semantic) => {
        const stepIds = actionSteps.get(semantic.id)
        if (stepIds === undefined || new Set(semantic.dependencies.map((dependency) => dependency.id)).size !== semantic.dependencies.length) {
          return false
        }
        const expected = value.usedDependencies.filter((dependency) =>
          stepIds.has(dependency.from) && stepIds.has(dependency.to)
        ).map(dependencyKey).sort(compareText)
        const actual = semantic.dependencies.map((dependency) => dependencyKey({
          from: dependency.fromStepId,
          to: dependency.toStepId,
          reason: dependency.reason,
          evidence: dependency.evidence
        })).sort(compareText)
        return canonicalStringify(actual) === canonicalStringify(expected)
      })
    })()
    if (
      new TextEncoder().encode(canonicalStringify(canonicalOutput)).byteLength > MAX_DRAFT_OUTPUT_BYTES ||
      artifact.sourceCaptureDigest !== value.importDigest ||
      siteHarnessArtifactDigest(artifact) !== value.artifactDigest ||
      value.selectedReadInterfaces > artifact.actions.length ||
      value.syntheticCases !== artifact.actions.length * 3 ||
      value.syntheticGatesPassed > value.syntheticGates ||
      !semanticsValid ||
      value.unresolved.some((finding) => !actionSteps.get(finding.actionId)?.has(finding.stepId))
    ) return undefined
    return canonicalOutput as HarnessCompositionOutput
  } catch {
    return undefined
  }
}

const isCompositionPreparedEvent = (value: unknown): value is CompositionPreparedEvent => {
  if (!is(HarnessCompositionPreparedSchema, value)) return false
  const output = validatedCompositionOutput(value.output)
  return output !== undefined && compositionOutputDigestOf(output) === value.outputDigest
}

const hasValidActorRouteRequestDigest = (event: ActorRouteScope): boolean =>
  event.requestDigest === actorRouteRequestDigestOf({
    id: event.id,
    invocationEpoch: event.invocationEpoch,
    siteId: event.siteId,
    environment: event.environment,
    targetId: event.targetId
  })
const isActorRouteRequestedEvent = (value: unknown): value is ActorRouteRequestedEvent =>
  is(SiteActorResolutionRequestedSchema, value) && hasValidActorRouteRequestDigest(value)
const isActorRouteResolvedEvent = (value: unknown): value is ActorRouteResolvedEvent => {
  if (!is(SiteActorResolvedSchema, value) || !hasValidActorRouteRequestDigest(value) ||
    !isValidSiteActorRoute(value.output)) return false
  if (
    value.output.siteId !== value.siteId || value.output.environment !== value.environment ||
    value.output.targetId !== value.targetId
  ) return false
  return value.outputDigest === actorRouteOutputDigestOf(value, value.output)
}
const isActorRouteFailedEvent = (value: unknown): value is ActorRouteFailedEvent =>
  is(SiteActorResolutionFailedSchema, value) && hasValidActorRouteRequestDigest(value)

const lifecycleSchemaOf = (value: unknown): LifecycleEvent | undefined => {
  if (is(HarnessActivationObservedSchema, value)) return value
  if (is(HarnessActorGeneratedSchema, value)) return value
  if (is(HarnessDefinitionApprovalObservedSchema, value)) return value
  if (is(HarnessDefinitionInstalledSchema, value)) return value
  if (is(HarnessDefinitionLoadFailedSchema, value)) return value
  if (is(HarnessPublicRouteVerifiedSchema, value)) return value
  if (is(HarnessPublicRouteUnavailableSchema, value)) return value
  return undefined
}

const isLifecycleEvent = (value: unknown): value is LifecycleEvent => {
  const event = lifecycleSchemaOf(value)
  if (event === undefined || event.definitionDigest !== event.buildDigest) return false
  try {
    const contract = {
      schemaVersion: SITE_INTERFACE_SCHEMA_VERSION,
      interfaceAbi: SITE_INTERFACE_ABI,
      siteId: event.siteId,
      actions: event.actions
    }
    if (siteInterfaceContractDigest(contract) !== event.interfaceDigest) return false
  } catch {
    return false
  }
  switch (event.type) {
    case "HarnessActivationObserved":
      return event.eventId === harnessLifecycleEventId({ harnessId: event.harnessId, phase: "activation" })
    case "HarnessActorGenerated":
      return event.eventId === harnessLifecycleEventId({ harnessId: event.harnessId, phase: "generated" })
    case "HarnessDefinitionApprovalObserved":
      return event.eventId === harnessLifecycleEventId({
        harnessId: event.harnessId,
        phase: "definition-approved",
        targetId: event.targetId,
        loadId: event.loadId
      })
    case "HarnessDefinitionInstalled":
      return event.eventId === harnessLifecycleEventId({
        harnessId: event.harnessId,
        phase: "installed",
        targetId: event.targetId,
        loadId: event.loadId
      })
    case "HarnessDefinitionLoadFailed":
      return event.eventId === harnessLifecycleEventId({
        harnessId: event.harnessId,
        phase: "load-failed",
        targetId: event.targetId,
        loadId: event.loadId
      })
    case "HarnessPublicRouteVerified":
    case "HarnessPublicRouteUnavailable":
      return event.eventId === harnessLifecycleEventId({
        harnessId: event.harnessId,
        phase: "route",
        targetId: event.targetId,
        loadId: event.loadId
      })
  }
}

const producerKindsOf = (producer: ValueProducer, target: Set<ProducerKind> = new Set()): ReadonlyArray<ProducerKind> => {
  target.add(producer.kind)
  switch (producer.kind) {
    case "object":
      Object.values(producer.fields).forEach((field) => producerKindsOf(field, target))
      break
    case "array":
      producer.items.forEach((item) => producerKindsOf(item, target))
      break
    case "wasm":
    case "js":
      producer.args.forEach((argument) => producerKindsOf(argument, target))
      break
  }
  return [...target].sort(compareText)
}

interface BindingPlan {
  readonly name: string
  readonly producerKinds: ReadonlyArray<ProducerKind>
}
interface StepPlan {
  readonly id: string
  readonly dependsOn: ReadonlyArray<string>
  readonly method: HarnessStep["method"]
  readonly origin: string
  readonly path: string
  readonly pathParameters: ReadonlyArray<BindingPlan>
  readonly query: ReadonlyArray<BindingPlan>
  readonly headers: ReadonlyArray<BindingPlan>
  readonly bodyProducerKinds?: ReadonlyArray<ProducerKind>
  readonly expectedStatuses: ReadonlyArray<number>
}

const bindingPlansOf = (bindings: Readonly<Record<string, ValueProducer>>): ReadonlyArray<BindingPlan> =>
  Object.entries(bindings)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, producer]) => ({ name, producerKinds: producerKindsOf(producer) }))

const stepPlanOf = (step: HarnessStep): StepPlan => ({
  id: step.id,
  dependsOn: step.dependsOn,
  method: step.method,
  origin: step.origin,
  path: step.path,
  pathParameters: bindingPlansOf(step.pathParameters),
  query: bindingPlansOf(step.query),
  headers: bindingPlansOf(step.headers),
  ...(step.body === undefined ? {} : { bodyProducerKinds: producerKindsOf(step.body) }),
  expectedStatuses: step.expectedStatuses
})

const actionProducerKindsOf = (action: HarnessAction): ReadonlyArray<ProducerKind> => {
  const kinds = new Set<ProducerKind>()
  for (const step of action.steps) {
    Object.values(step.pathParameters).forEach((producer) => producerKindsOf(producer, kinds))
    Object.values(step.query).forEach((producer) => producerKindsOf(producer, kinds))
    Object.values(step.headers).forEach((producer) => producerKindsOf(producer, kinds))
    if (step.body !== undefined) producerKindsOf(step.body, kinds)
  }
  return [...kinds].sort(compareText)
}

type PreparedPlan =
  | { readonly status: "prepared"; readonly output: SiteActionPlan; readonly outputDigest: string }
  | { readonly status: "failed"; readonly code: "action_not_found" | "artifact_invalid"; readonly error: string }

const preparedPlanOf = (resolved: ResolvedEvent): PreparedPlan => {
  const artifact = artifactOf(resolved)
  if (artifact === undefined) {
    return { status: "failed", code: "artifact_invalid", error: "The resolved harness snapshot failed integrity validation." }
  }
  const action = artifact.actions.find((candidate) => candidate.id === resolved.action)
  if (action === undefined) {
    return { status: "failed", code: "action_not_found", error: "The approved harness does not declare the requested action." }
  }
  const output: SiteActionPlan = {
    siteId: resolved.siteId,
    environment: resolved.environment,
    action: resolved.action,
    generation: resolved.generation,
    artifactDigest: resolved.artifactDigest,
    artifactVersion: artifact.version,
    sourceCaptureDigest: artifact.sourceCaptureDigest,
    inputs: action.inputs.map((input: HarnessInput) => ({ ...input })),
    steps: action.steps.map(stepPlanOf),
    producerKinds: actionProducerKindsOf(action)
  }
  if (!is(SiteActionPlanSchema, output)) {
    return { status: "failed", code: "artifact_invalid", error: "The resolved harness could not produce a bounded structural plan." }
  }
  return { status: "prepared", output, outputDigest: planDigestOf(output) }
}

type PreparedDraft =
  | { readonly status: "prepared"; readonly output: SiteHarnessDraftOutput; readonly outputDigest: string }
  | {
      readonly status: "failed"
      readonly code: HarnessDraftBuildFailureCode
      readonly error: string
    }

const preparedDraftOutputOf = (draft: LogSiteHarnessDraft): PreparedDraft => {
  try {
    const canonicalArtifact = canonicalSiteHarnessArtifact(draft.artifact)
    const output: SiteHarnessDraftOutput = {
      captureId: draft.captureId,
      importDigest: draft.importDigest,
      actionId: draft.actionCandidate.id,
      artifactDigest: siteHarnessArtifactDigest(draft.artifact),
      artifact: JSON.parse(canonicalArtifact) as SiteHarnessArtifact,
      usedDependencies: draft.usedDependencies.map((dependency) => ({
        from: dependency.from,
        to: dependency.to,
        reason: dependency.reason,
        evidence: dependency.evidence
      })),
      unresolved: draft.unresolved.map((issue) => ({
        stepId: issue.stepId,
        location: issue.location,
        code: issue.code
      }))
    }
    const validated = validatedDraftOutput(output)
    if (validated === undefined) {
      return {
        status: "failed",
        code: "draft_invalid",
        error: "The sanitized capture could not produce a valid bounded artifact snapshot."
      }
    }
    return { status: "prepared", output: validated, outputDigest: draftOutputDigestOf(validated) }
  } catch (cause) {
    if (cause instanceof HarnessDraftBuildError) {
      return { status: "failed", code: cause.code, error: cause.message }
    }
    return {
      status: "failed",
      code: "draft_invalid",
      error: "The sanitized capture could not produce a valid bounded artifact snapshot."
    }
  }
}

const preparedDraftOf = (log: ReadonlyArray<Event>, request: DraftRequestedEvent): PreparedDraft => {
  try {
    return preparedDraftOutputOf(buildSiteHarnessDraftFromLog(log, request.captureId, {
      ...(request.actionId === undefined ? {} : { actionId: request.actionId })
    }))
  } catch (cause) {
    return { status: "failed", code: cause instanceof HarnessDraftBuildError ? cause.code : "draft_invalid",
      error: cause instanceof HarnessDraftBuildError ? cause.message : "The capture could not produce a draft." }
  }
}

/** Trusted controller constructor, not a model/remote append surface. A draft
 * with unresolved findings is useful inspection evidence, never replay authority. */
export const observedReadDraftPreparedEventOf = (
  log: ReadonlyArray<Event>, captureId: string, options: BuildObservedReadHarnessDraftOptions
): Event => {
  const facts = validatedHarCaptureFactsOf(log, captureId)
  if (facts.status !== "completed") throw new HarnessDraftBuildError("capture_invalid", "The persisted capture is incomplete or invalid.")
  const prepared = preparedDraftOutputOf(buildObservedReadHarnessDraft(facts.capture, options))
  if (prepared.status !== "prepared") throw new HarnessDraftBuildError(prepared.code, prepared.error)
  const event = { type: "SiteHarnessDraftPrepared", schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    id: `browser-read-${sha256(prepared.outputDigest).slice(0, 40)}`, captureId,
    actionId: prepared.output.actionId, output: prepared.output, outputDigest: prepared.outputDigest }
  if (!isDraftPreparedEvent(event)) throw new HarnessDraftBuildError("draft_invalid", "The structural draft event was invalid.")
  return event
}

const resolutionFailureOf = (
  scope: RequestScope,
  code: ResolutionFailedEvent["code"],
  error: string
): ResolutionFailedEvent => ({
  type: "HarnessResolutionFailed",
  schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
  ...scope,
  code,
  error
})

const resolveHarnessEvent = (scope: RequestScope): Event => {
  const database = process.env.HARNESS_REGISTRY_DB?.trim()
  if (database === undefined || database.length === 0) {
    return resolutionFailureOf(scope, "registry_not_configured", "HARNESS_REGISTRY_DB is not configured.")
  }

  let registry: ReturnType<typeof openHarnessRegistry> | undefined
  try {
    registry = openHarnessRegistry({ database })
    const approved = registry.resolveApproved(scope.siteId, scope.environment)
    if (approved === undefined) {
      return resolutionFailureOf(
        scope,
        "harness_not_found",
        "No approved harness is active for the requested site and environment."
      )
    }
    try {
      if (
        approved.siteId !== scope.siteId ||
        approved.environment !== scope.environment ||
        !Number.isSafeInteger(approved.generation) ||
        approved.generation < 1 ||
        new TextEncoder().encode(approved.canonicalJson).byteLength > SITE_HARNESS_LIMITS.artifactBytes
      ) {
        throw new Error("invalid resolved harness metadata")
      }
      const snapshot = validateSiteHarnessArtifact(JSON.parse(approved.canonicalJson))
      const canonicalJson = canonicalSiteHarnessArtifact(snapshot)
      if (
        canonicalJson !== approved.canonicalJson ||
        canonicalSiteHarnessArtifact(approved.artifact) !== canonicalJson ||
        siteHarnessArtifactDigest(snapshot) !== approved.artifactDigest ||
        snapshot.siteId !== scope.siteId
      ) {
        throw new Error("resolved harness integrity mismatch")
      }
      const event: ResolvedEvent = {
        type: "HarnessResolved",
        schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
        ...scope,
        generation: approved.generation,
        artifactDigest: approved.artifactDigest,
        artifact: JSON.parse(canonicalJson) as unknown
      }
      if (!isResolvedEvent(event)) throw new Error("resolved harness event is invalid")
      return event
    } catch {
      return resolutionFailureOf(scope, "artifact_invalid", "The approved harness snapshot failed integrity validation.")
    }
  } catch {
    return resolutionFailureOf(scope, "registry_unavailable", "The harness registry could not be read.")
  } finally {
    try {
      registry?.close()
    } catch {
      // Closing a completed read does not change the committed resolution result.
    }
  }
}

const actorRouteFailureOf = (
  scope: ActorRouteScope,
  code: ActorRouteFailedEvent["code"]
): ActorRouteFailedEvent => ({
  type: "SiteActorResolutionFailed",
  schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
  ...scope,
  code
})

const resolveSiteActorEvent = (scope: ActorRouteScope): Event => {
  const database = process.env.HARNESS_REGISTRY_DB?.trim()
  if (database === undefined || database.length === 0) {
    return actorRouteFailureOf(scope, "not_routable")
  }

  let catalog: HarnessActorCatalog | undefined
  try {
    catalog = new HarnessActorCatalog({ database })
    const resolution = catalog.resolveRoutable(scope.siteId, scope.environment, scope.targetId)
    if (resolution.status !== "resolved") return actorRouteFailureOf(scope, resolution.status)
    const output = siteActorRouteOf(resolution.actor)
    if (output === undefined) return actorRouteFailureOf(scope, "not_routable")
    const event: ActorRouteResolvedEvent = {
      type: "SiteActorResolved",
      schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
      ...scope,
      output,
      outputDigest: actorRouteOutputDigestOf(scope, output)
    }
    return isActorRouteResolvedEvent(event) ? event : actorRouteFailureOf(scope, "not_routable")
  } catch {
    return actorRouteFailureOf(scope, "not_routable")
  } finally {
    try {
      catalog?.close()
    } catch {
      // Closing a completed read does not change its value-minimized evidence.
    }
  }
}

const requestedForInvocation = (
  log: ReadonlyArray<Event>,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): RequestedEvent | undefined => log.find((event): event is RequestedEvent => {
  if (!is(SiteActionPlanRequestedSchema, event) || event.id !== invocation.id) return false
  const context = event.call?.invocation
  return context === undefined || (
    context.method === invocation.method && context.id === invocation.id && context.epoch === invocation.epoch
  )
})

const resolvedFor = (log: ReadonlyArray<Event>, request: RequestedEvent): ResolvedEvent | undefined =>
  log.find((event): event is ResolvedEvent => isResolvedEvent(event) && sameScope(event, request))
const resolutionFailureFor = (log: ReadonlyArray<Event>, request: RequestedEvent): ResolutionFailedEvent | undefined =>
  log.find((event): event is ResolutionFailedEvent => is(HarnessResolutionFailedSchema, event) && sameScope(event, request))
const planFailureFor = (
  log: ReadonlyArray<Event>,
  request: RequestedEvent,
  expected: PreparedPlan
): PlanFailedEvent | undefined => expected.status === "prepared" ? undefined :
  log.find((event): event is PlanFailedEvent =>
    is(ActionPlanFailedSchema, event) && sameScope(event, request) && event.code === expected.code)
const preparedFor = (
  log: ReadonlyArray<Event>,
  request: RequestedEvent,
  expected: Extract<PreparedPlan, { readonly status: "prepared" }>
): PreparedEvent | undefined => log.find((event): event is PreparedEvent =>
  isPreparedEvent(event) && event.id === request.id &&
  event.output.siteId === request.siteId && event.output.environment === request.environment &&
  event.output.action === request.action && event.outputDigest === expected.outputDigest &&
  canonicalStringify(event.output) === canonicalStringify(expected.output))

const draftRequestedForInvocation = (
  log: ReadonlyArray<Event>,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): DraftRequestedEvent | undefined => log.find((event): event is DraftRequestedEvent => {
  if (!is(SiteHarnessDraftRequestedSchema, event) || event.id !== invocation.id) return false
  const context = event.call?.invocation
  return context === undefined || (
    context.method === invocation.method && context.id === invocation.id && context.epoch === invocation.epoch
  )
})

const draftFailureFor = (
  log: ReadonlyArray<Event>,
  request: DraftRequestedEvent,
  expected: Extract<PreparedDraft, { readonly status: "failed" }>
): DraftFailedEvent | undefined => log.find((event): event is DraftFailedEvent =>
  is(SiteHarnessDraftFailedSchema, event) && sameDraftScope(event, request) &&
  event.code === expected.code && event.error === expected.error)

const draftPreparedFor = (
  log: ReadonlyArray<Event>,
  request: DraftRequestedEvent,
  expected: Extract<PreparedDraft, { readonly status: "prepared" }>
): DraftPreparedEvent | undefined => log.find((event): event is DraftPreparedEvent =>
  isDraftPreparedEvent(event) && sameDraftScope(event, request) &&
  event.output.captureId === request.captureId && event.outputDigest === expected.outputDigest &&
  canonicalStringify(event.output) === canonicalStringify(expected.output))

const compositionPreparedForInvocation = (
  log: ReadonlyArray<Event>,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): CompositionPreparedEvent | undefined => log.find((event): event is CompositionPreparedEvent => {
  if (!isCompositionPreparedEvent(event) || event.id !== invocation.id) return false
  const context = event.call?.invocation
  return context === undefined || (
    context.method === invocation.method && context.id === invocation.id && context.epoch === invocation.epoch
  )
})

const actorRouteCallMatches = (
  event: ActorRouteRequestedEvent | ActorRouteResolvedEvent | ActorRouteFailedEvent,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): boolean => {
  const context = event.call?.invocation
  return context === undefined || (
    context.method === invocation.method && context.id === invocation.id && context.epoch === invocation.epoch
  )
}

const actorRouteRequestedForInvocation = (
  log: ReadonlyArray<Event>,
  invocation: { readonly method: string; readonly id: string; readonly epoch: number }
): ActorRouteRequestedEvent | undefined => {
  const matches = log.filter((event): event is ActorRouteRequestedEvent =>
    isActorRouteRequestedEvent(event) && event.id === invocation.id &&
    event.invocationEpoch === invocation.epoch && actorRouteCallMatches(event, invocation))
  return matches.length === 1 ? matches[0] : undefined
}

type ActorRouteTerminal = ActorRouteResolvedEvent | ActorRouteFailedEvent

const actorRouteTerminalsFor = (
  log: ReadonlyArray<Event>,
  request: ActorRouteRequestedEvent
): ReadonlyArray<ActorRouteTerminal> => {
  const requestIndex = log.indexOf(request)
  if (requestIndex < 0) return []
  const invocation = { method: "resolveSiteActor", id: request.id, epoch: request.invocationEpoch }
  return log.slice(requestIndex + 1).filter((event): event is ActorRouteTerminal =>
    (isActorRouteResolvedEvent(event) || isActorRouteFailedEvent(event)) &&
    actorRouteScopeMatches(event, request) && actorRouteCallMatches(event, invocation))
}

export const harnessKeys: KeyFragment = {
  prefixes: [KEY_PREFIX, DRAFT_KEY_PREFIX, COMPOSITION_KEY_PREFIX, ACTOR_ROUTE_KEY_PREFIX, LIFECYCLE_KEY_PREFIX],
  keyOf: (event) => {
    if (!/^(?:Site|Harness|ActionPlan)/u.test(event.type)) return undefined
    if (is(SiteActionPlanRequestedSchema, event)) return requestKeyOf(event)
    if (isResolvedEvent(event)) return resolutionKeyOf(event)
    if (is(HarnessResolutionFailedSchema, event)) return resolutionKeyOf(event)
    if (isPreparedEvent(event)) return preparedKeyOf({
      id: event.id,
      siteId: event.output.siteId,
      environment: event.output.environment,
      action: event.output.action
    }, event.outputDigest)
    if (is(ActionPlanFailedSchema, event)) return planFailureKeyOf(event, event.code)
    if (is(SiteHarnessDraftRequestedSchema, event)) return draftRequestKeyOf(event)
    if (isDraftPreparedEvent(event)) return draftPreparedKeyOf(event, event.outputDigest)
    if (isCompositionPreparedEvent(event)) return compositionPreparedKeyOf(event)
    if (is(SiteHarnessDraftFailedSchema, event)) return draftFailedKeyOf(event, event.code, event.error)
    if (isActorRouteRequestedEvent(event)) return actorRouteRequestKeyOf(event)
    if (isActorRouteResolvedEvent(event) || isActorRouteFailedEvent(event)) {
      return actorRouteResolutionKeyOf(event)
    }
    if (isLifecycleEvent(event)) return `${LIFECYCLE_KEY_PREFIX}${sha256(event.eventId)}`
    return undefined
  }
}

export const planSiteActionMethod = actorMethod({
  input: Schema.Struct({
    siteId: HarnessIdentifierSchema,
    environment: HarnessIdentifierSchema,
    action: HarnessIdentifierSchema
  }),
  output: SiteActionPlanSchema,
  event: ({ invocation, input, at }): Event => ({
    type: "SiteActionPlanRequested",
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    id: invocation.id,
    siteId: input.siteId,
    environment: input.environment,
    action: input.action,
    at
  }),
  state: (log, invocation) => {
    const request = requestedForInvocation(log, invocation)
    if (request === undefined) return undefined
    const resolutionFailed = resolutionFailureFor(log, request)
    if (resolutionFailed !== undefined) {
      return { status: "failed", error: `${resolutionFailed.code}: ${resolutionFailed.error}` }
    }
    const resolved = resolvedFor(log, request)
    if (resolved === undefined) return { status: "pending" }
    const expected = preparedPlanOf(resolved)
    if (expected.status === "failed") {
      const failed = planFailureFor(log, request, expected)
      return failed === undefined
        ? { status: "pending" }
        : { status: "failed", error: `${failed.code}: ${failed.error}` }
    }
    const prepared = preparedFor(log, request, expected)
    return prepared === undefined ? { status: "pending" } : { status: "completed", output: prepared.output }
  }
})

export const draftSiteHarnessMethod = actorMethod({
  input: Schema.Struct({
    captureId: CaptureIdSchema,
    actionId: Schema.optionalKey(ActionCandidateIdSchema)
  }),
  output: SiteHarnessDraftOutputSchema,
  event: ({ invocation, input, at }): Event => ({
    type: "SiteHarnessDraftRequested",
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    id: invocation.id,
    captureId: input.captureId,
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
    at
  }),
  state: (log, invocation) => {
    const request = draftRequestedForInvocation(log, invocation)
    if (request === undefined) return undefined
    const expected = preparedDraftOf(log, request)
    if (expected.status === "failed") {
      const failed = draftFailureFor(log, request, expected)
      return failed === undefined
        ? { status: "pending" }
        : { status: "failed", error: `${failed.code}: ${failed.error}` }
    }
    const prepared = draftPreparedFor(log, request, expected)
    return prepared === undefined ? { status: "pending" } : { status: "completed", output: prepared.output }
  }
})

/**
 * Privileged controller ingress for a value-free, trusted-compiled author
 * composition. This records structural evidence only; it does not build,
 * approve, activate, route, or execute the artifact.
 */
export const recordHarnessCompositionMethod = actorMethod({
  input: HarnessCompositionOutputSchema,
  output: HarnessCompositionOutputSchema,
  event: ({ invocation, input, at }): Event => {
    const output = validatedCompositionOutput(input)
    if (output === undefined) throw new Error("The harness composition evidence failed integrity validation.")
    return {
      type: "HarnessCompositionPrepared",
      schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
      id: invocation.id,
      output,
      outputDigest: compositionOutputDigestOf(output),
      at
    }
  },
  state: (log, invocation) => {
    const prepared = compositionPreparedForInvocation(log, invocation)
    return prepared === undefined ? undefined : { status: "completed", output: prepared.output }
  }
})

const actorRouteFailureMessages: Readonly<Record<ActorRouteFailedEvent["code"], string>> = {
  not_found: "No generated actor exists for the current approved site activation.",
  not_routable: "The current generated actor has no verified route for the requested target."
}

export const resolveSiteActorMethod = actorMethod({
  input: Schema.Struct({
    siteId: HarnessIdentifierSchema,
    environment: HarnessIdentifierSchema,
    targetId: HarnessTargetIdSchema
  }),
  output: SiteActorRouteSchema,
  event: ({ invocation, input, at }): Event => {
    const identity = {
      id: invocation.id,
      invocationEpoch: invocation.epoch,
      siteId: input.siteId,
      environment: input.environment,
      targetId: input.targetId
    }
    return {
      type: "SiteActorResolutionRequested",
      schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
      ...identity,
      requestDigest: actorRouteRequestDigestOf(identity),
      at
    }
  },
  state: (log, invocation) => {
    const request = actorRouteRequestedForInvocation(log, invocation)
    if (request === undefined) return undefined
    const terminals = actorRouteTerminalsFor(log, request)
    if (terminals.length === 0) return { status: "pending" }
    if (terminals.length !== 1) {
      return { status: "failed", error: `not_routable: ${actorRouteFailureMessages.not_routable}` }
    }
    const terminal = terminals[0]!
    if (terminal.type === "SiteActorResolutionFailed") {
      return { status: "failed", error: `${terminal.code}: ${actorRouteFailureMessages[terminal.code]}` }
    }
    return { status: "completed", output: terminal.output }
  }
})

export interface HarnessView {
  readonly requested: number
  readonly resolved: number
  readonly prepared: number
  readonly failed: number
  readonly draftRequested: number
  readonly draftPrepared: number
  readonly draftFailed: number
  readonly compositionPrepared: number
  readonly actorRouteRequested: number
  readonly actorRouteResolved: number
  readonly actorRouteFailed: number
}

export const harnessComponent: Component<HarnessView> = {
  name: "site-harness-resolution",
  keys: harnessKeys,
  derive: (log) => {
    // Passive request facts are high volume; select this component's event
    // families before strict decoding, while retaining the full log for drafts.
    const domainEvents = log.filter((event) => /^(?:Site|Harness|ActionPlan)/u.test(event.type))
    const planTransitions = domainEvents.filter((event): event is RequestedEvent => is(SiteActionPlanRequestedSchema, event))
      .flatMap((request): ReadonlyArray<Transition<never, never>> => {
        if (resolutionFailureFor(log, request) !== undefined) return []
        const resolved = resolvedFor(log, request)
        if (resolved === undefined) {
          const scope = scopeOf(request)
          return [effect({
            key: resolutionKeyOf(scope),
            ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
            input: scope,
            act: (input) => Effect.sync((): ReadonlyArray<Event> => [resolveHarnessEvent(input)])
          })]
        }

        const expected = preparedPlanOf(resolved)
        if (expected.status === "failed") {
          if (planFailureFor(log, request, expected) !== undefined) return []
          const scope = scopeOf(request)
          return [intent({
            key: planFailureKeyOf(scope, expected.code),
            ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
            input: { ...scope, code: expected.code, error: expected.error },
            events: (input, at): ReadonlyArray<Event> => [{
              type: "ActionPlanFailed",
              schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
              ...input,
              at
            }]
          })]
        }
        if (preparedFor(log, request, expected) !== undefined) return []
        const scope = scopeOf(request)
        return [intent({
          key: preparedKeyOf(scope, expected.outputDigest),
          ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
          input: { id: scope.id, output: expected.output, outputDigest: expected.outputDigest },
          events: (input, at): ReadonlyArray<Event> => [{
            type: "ActionPlanPrepared",
            schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
            id: input.id,
            output: input.output,
            outputDigest: input.outputDigest,
            at
          }]
        })]
      })
    const draftTransitions = domainEvents
      .filter((event): event is DraftRequestedEvent => is(SiteHarnessDraftRequestedSchema, event))
      .flatMap((request): ReadonlyArray<Transition<never, never>> => {
        const expected = preparedDraftOf(log, request)
        const scope = draftScopeOf(request)
        if (expected.status === "failed") {
          if (draftFailureFor(log, request, expected) !== undefined) return []
          return [intent({
            key: draftFailedKeyOf(scope, expected.code, expected.error),
            ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
            input: { ...scope, code: expected.code, error: expected.error },
            events: (input, at): ReadonlyArray<Event> => [{
              type: "SiteHarnessDraftFailed",
              schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
              ...input,
              at
            }]
          })]
        }
        if (draftPreparedFor(log, request, expected) !== undefined) return []
        return [intent({
          key: draftPreparedKeyOf(scope, expected.outputDigest),
          ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
          input: {
            ...scope,
            output: expected.output,
            outputDigest: expected.outputDigest
          },
          events: (input, at): ReadonlyArray<Event> => [{
            type: "SiteHarnessDraftPrepared",
            schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
            ...input,
            at
          }]
        })]
      })
    const actorRouteTransitions = domainEvents
      .filter(isActorRouteRequestedEvent)
      .flatMap((request): ReadonlyArray<Transition<never, never>> => {
        if (actorRouteTerminalsFor(log, request).length > 0) return []
        const scope = actorRouteScopeOf(request)
        return [effect({
          key: actorRouteResolutionKeyOf(scope),
          ...(request.call === undefined ? {} : { invocation: request.call.invocation }),
          input: scope,
          act: (input) => Effect.sync((): ReadonlyArray<Event> => [resolveSiteActorEvent(input)])
        })]
      })
    return {
      view: {
        requested: domainEvents.filter((event) => is(SiteActionPlanRequestedSchema, event)).length,
        resolved: domainEvents.filter(isResolvedEvent).length,
        prepared: domainEvents.filter(isPreparedEvent).length,
        failed: domainEvents.filter((event) => is(HarnessResolutionFailedSchema, event) || is(ActionPlanFailedSchema, event)).length,
        draftRequested: domainEvents.filter((event) => is(SiteHarnessDraftRequestedSchema, event)).length,
        draftPrepared: domainEvents.filter(isDraftPreparedEvent).length,
        draftFailed: domainEvents.filter((event) => is(SiteHarnessDraftFailedSchema, event)).length,
        compositionPrepared: domainEvents.filter(isCompositionPreparedEvent).length,
        actorRouteRequested: domainEvents.filter(isActorRouteRequestedEvent).length,
        actorRouteResolved: domainEvents.filter(isActorRouteResolvedEvent).length,
        actorRouteFailed: domainEvents.filter(isActorRouteFailedEvent).length
      },
      transitions: [...planTransitions, ...draftTransitions, ...actorRouteTransitions]
    }
  }
}
