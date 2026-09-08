import { Schema } from "effect"
import { actorMethod, type Component } from "tardie"
import type { Event } from "tardie/core/log/event"
import { intent } from "tardie/core/reconciliation"
import { CaptureIdSchema, CapturedWebsiteInspectionSchema, WebsiteInspectionRequestedSchema, HAR_EVENT_SCHEMA_VERSION, harKeys, harViewOf, HarView, is, inspectionOutcomeOf, inspectionCompletedKeyOf, inspectionFailedKeyOf, matchingInspectionCompletion, matchingInspectionFailure } from "./har-facts"
export * from "./har-facts"

export const inspectWebsiteMethod = actorMethod({
  input: Schema.Struct({ captureId: CaptureIdSchema }),
  output: CapturedWebsiteInspectionSchema,
  event: ({ invocation, input, at }): Event => ({
    type: "WebsiteInspectionRequested",
    schemaVersion: HAR_EVENT_SCHEMA_VERSION,
    id: invocation.id,
    captureId: input.captureId,
    at
  }),
  state: (events, invocation) => {
    const requested = events.find((event) =>
      is(WebsiteInspectionRequestedSchema, event) && event.id === invocation.id) as
      typeof WebsiteInspectionRequestedSchema.Type | undefined
    if (requested === undefined) return undefined
    const outcome = inspectionOutcomeOf(events, requested.captureId)
    if (outcome.status === "completed") {
      const completed = matchingInspectionCompletion(events, requested, outcome.output)
      return completed === undefined ? { status: "pending" } : { status: "completed", output: outcome.output }
    }
    const failed = matchingInspectionFailure(events, requested, outcome.failure)
    return failed === undefined
      ? { status: "pending" }
      : { status: "failed", error: `${outcome.failure.code}: ${outcome.failure.error}` }
  }
})

export const harComponent: Component<HarView> = {
  name: "har-captures",
  keys: harKeys,
  derive: (log) => {
    const transitions = log.filter((event) => event.type === "WebsiteInspectionRequested" && is(WebsiteInspectionRequestedSchema, event)).flatMap((event) => {
      const request = event as typeof WebsiteInspectionRequestedSchema.Type
      const outcome = inspectionOutcomeOf(log, request.captureId)
      if (outcome.status === "completed") {
        if (matchingInspectionCompletion(log, request, outcome.output) !== undefined) return []
        return [intent({
          key: inspectionCompletedKeyOf(request.captureId, request.id, outcome.output),
          input: { id: request.id, captureId: request.captureId, output: outcome.output },
          events: (input, at): ReadonlyArray<Event> => [{
            type: "WebsiteInspectionCompleted",
            schemaVersion: HAR_EVENT_SCHEMA_VERSION,
            id: input.id,
            captureId: input.captureId,
            output: input.output,
            at
          }]
        })]
      }
      if (matchingInspectionFailure(log, request, outcome.failure) !== undefined) return []
      return [intent({
        key: inspectionFailedKeyOf(request.captureId, request.id, outcome.failure),
        input: { id: request.id, captureId: request.captureId, ...outcome.failure },
        events: (input, at): ReadonlyArray<Event> => [{
          type: "WebsiteInspectionFailed",
          schemaVersion: HAR_EVENT_SCHEMA_VERSION,
          id: input.id,
          captureId: input.captureId,
          code: input.code,
          error: input.error,
          at
        }]
      })]
    })
    return { view: harViewOf(log), transitions }
  }
}
