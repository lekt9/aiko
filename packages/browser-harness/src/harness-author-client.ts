import { boundaryOf } from "tardie"
import { makeActorClient } from "tardie/client"
import type { Event } from "tardie/core/log/event"

import { canonicalStringify } from "./har"
import {
  HARNESS_AUTHOR_ACTOR_NAME,
  HARNESS_AUTHOR_OUTPUT_CONTRACT,
  HARNESS_AUTHOR_REVISION,
  MAX_AUTHOR_MESSAGE_CHARS,
  MAX_AUTHOR_MODEL_CALLS,
  harnessAuthorBriefDigest,
  harnessAuthorProposalDigest,
  validateHarnessAuthorProposal,
  type HarnessAuthorBrief,
  type HarnessAuthorProposal
} from "./harness-author"

const AUTHOR_POLL_MS = 75
const AUTHOR_TIMEOUT_MS = 60_000
const AUTHOR_EVENT_PAGE_SIZE = 200
const AUTHOR_MAX_EVENT_PAGES = 32

export interface HarnessAuthorUsage {
  readonly modelCalls: number
  readonly tokenAccounting: "reported" | "unreported"
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
}

export interface HarnessAuthorResult {
  readonly actorName: typeof HARNESS_AUTHOR_ACTOR_NAME
  readonly proposal: HarnessAuthorProposal
  readonly proposalDigest: `sha256:${string}`
  readonly usage: HarnessAuthorUsage
}

export interface HarnessAuthorInvocationIdentity {
  readonly actorName: typeof HARNESS_AUTHOR_ACTOR_NAME
  readonly thread: string
  readonly turn: string
  readonly briefDigest: `sha256:${string}`
}

export interface HarnessAuthorGateway {
  readonly compose: (runId: string, brief: HarnessAuthorBrief) => Promise<HarnessAuthorResult>
}

export const harnessAuthorMessageTextOf = (brief: HarnessAuthorBrief): string => {
  const methods = brief.requests.reduce<Record<string, number>>((counts, request) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1
    return counts
  }, {})
  const findingCodes = brief.findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.code] = (counts[finding.code] ?? 0) + 1
    return counts
  }, {})
  const summary = {
    schemaVersion: brief.schemaVersion,
    proposalAbi: brief.proposalAbi,
    authorRevision: brief.authorRevision,
    captureId: brief.captureId,
    importDigest: brief.importDigest,
    siteId: brief.siteId,
    maximumReadInterfaces: brief.maximumReadInterfaces,
    counts: {
      requests: brief.requests.length,
      dependencies: brief.dependencies.length,
      findings: brief.findings.length
    },
    omitted: {
      requests: brief.omittedRequests,
      dependencies: brief.omittedDependencies,
      findings: brief.omittedFindings
    },
    methods,
    findingCodes,
    existingInterfaces: brief.existingInterfaces.map(({ id, sourceRequestId, method }) => ({ id, sourceRequestId, method }))
  }
  const message = `Compose a bounded site harness proposal. The complete value-free evidence is available only through the har_graph_* tools; search it before selecting request IDs or deciding findings.\n${canonicalStringify(summary)}`
  if (message.length > MAX_AUTHOR_MESSAGE_CHARS) throw new Error("Harness author message exceeds its render budget")
  return message
}

export class HarnessAuthorInvocationError extends Error {
  constructor(
    readonly code: "actor_unavailable" | "model_unavailable" | "author_timeout" | "author_failed" | "output_invalid",
    message: string,
    readonly usage?: HarnessAuthorUsage
  ) {
    super(message)
    this.name = "HarnessAuthorInvocationError"
  }
}

// The durable terminal carries the model's reply as a JSON string; native or local
// validation does not rewrite it. Parse once here so trusted schema validation
// sees an object whether the host mode produced a string or an already-decoded value.
const usageNumber = (value: unknown, names: ReadonlyArray<string>): number | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const name of names) {
    const candidate = record[name]
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate
  }
  return undefined
}

export const harnessAuthorUsageOf = (events: ReadonlyArray<Event>): HarnessAuthorUsage => {
  const modelCalls = events.filter((event) => event.type === "ModelCalled").length
  const reports = events.flatMap((event) => {
    const usage = (event as Event & { readonly usage?: unknown }).usage
    return usage === undefined ? [] : [usage]
  })
  const normalized = reports.map((usage) => {
    const promptTokens = usageNumber(usage, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"])
    const completionTokens = usageNumber(usage, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"])
    const reportedTotal = usageNumber(usage, ["totalTokens", "total_tokens"])
    const computedTotal = promptTokens === undefined || completionTokens === undefined
      ? undefined
      : promptTokens + completionTokens
    const totalTokens = reportedTotal === undefined ? computedTotal
      : computedTotal === undefined ? reportedTotal
      : Math.max(reportedTotal, computedTotal)
    return { promptTokens, completionTokens, totalTokens }
  })
  const reported = modelCalls > 0 && normalized.length >= modelCalls && normalized.every((usage) =>
    usage.promptTokens !== undefined && usage.completionTokens !== undefined && usage.totalTokens !== undefined)
  if (!reported) return { modelCalls, tokenAccounting: "unreported" }
  return {
    modelCalls,
    tokenAccounting: "reported",
    promptTokens: normalized.reduce((total, usage) => total + usage.promptTokens!, 0),
    completionTokens: normalized.reduce((total, usage) => total + usage.completionTokens!, 0),
    totalTokens: normalized.reduce((total, usage) => total + usage.totalTokens!, 0)
  }
}

const completedOutputOf = (output: unknown): unknown => {
  if (typeof output !== "string") return output
  try {
    return JSON.parse(output) as unknown
  } catch {
    return output
  }
}

const drainAuthorEvents = async (
  client: ReturnType<typeof makeActorClient>,
  thread: string
): Promise<ReadonlyArray<Event>> => {
  const events: Event[] = []
  let after = 0
  for (let pageIndex = 0; pageIndex < AUTHOR_MAX_EVENT_PAGES; pageIndex++) {
    const page = await client.events(HARNESS_AUTHOR_ACTOR_NAME, thread, {
      after,
      limit: AUTHOR_EVENT_PAGE_SIZE
    })
    if (page.length === 0) return events
    for (const row of page) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= after) {
        throw new HarnessAuthorInvocationError("author_failed", "The author event sequence did not advance.")
      }
      events.push(row.event)
      after = row.seq
    }
  }
  throw new HarnessAuthorInvocationError("author_failed", "The author event log exceeded its bounded scan.")
}

const fetchBefore = (deadline: number): typeof globalThis.fetch => {
  const boundedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Harness author deadline elapsed")
    const deadlineSignal = AbortSignal.timeout(remaining)
    const signal = init?.signal == null
      ? deadlineSignal
      : AbortSignal.any([init.signal, deadlineSignal])
    return globalThis.fetch(input, { ...init, signal })
  }
  return Object.assign(boundedFetch, { preconnect: globalThis.fetch.preconnect })
}

export const harnessAuthorInvocationIdentityOf = (
  runId: string,
  brief: HarnessAuthorBrief
): HarnessAuthorInvocationIdentity => {
  const briefDigest = harnessAuthorBriefDigest(brief)
  const runSuffix = runId.replace(/^capture-lab-/u, "").slice(0, 32)
  return {
    actorName: HARNESS_AUTHOR_ACTOR_NAME,
    thread: `author-${runSuffix}-${briefDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    turn: `${HARNESS_AUTHOR_REVISION}-${briefDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    briefDigest
  }
}

export class TardigradeHarnessAuthorGateway implements HarnessAuthorGateway {
  readonly #options: { readonly baseUrl: string; readonly token?: string }

  constructor(options: { readonly baseUrl: string; readonly token?: string }) {
    this.#options = options
  }

  async compose(runId: string, brief: HarnessAuthorBrief): Promise<HarnessAuthorResult> {
    const deadline = Date.now() + AUTHOR_TIMEOUT_MS
    const client = makeActorClient({
      baseUrl: this.#options.baseUrl,
      fetch: fetchBefore(deadline),
      ...(this.#options.token === undefined ? {} : { token: this.#options.token })
    })
    try {
      await client.ensureActor(HARNESS_AUTHOR_ACTOR_NAME)
    } catch {
      if (Date.now() >= deadline) {
        throw new HarnessAuthorInvocationError("author_timeout", "The harness author exceeded the 60-second controller deadline.")
      }
      throw new HarnessAuthorInvocationError(
        "actor_unavailable",
        "The dedicated harness author actor is not installed on the local Tardigrade host."
      )
    }
    const invocation = harnessAuthorInvocationIdentityOf(runId, brief)
    try {
      await client.append(HARNESS_AUTHOR_ACTOR_NAME, invocation.thread, {
        type: "MessageReceived",
        id: invocation.turn,
        text: harnessAuthorMessageTextOf(brief),
        input: brief,
        output: {
          name: HARNESS_AUTHOR_OUTPUT_CONTRACT.name,
          schema: HARNESS_AUTHOR_OUTPUT_CONTRACT.schema
        }
      })
    } catch {
      if (Date.now() >= deadline) {
        throw new HarnessAuthorInvocationError("author_timeout", "The harness author exceeded the 60-second controller deadline.")
      }
      throw new HarnessAuthorInvocationError("actor_unavailable", "The local host refused the harness author request.")
    }

    let lastEvents: ReadonlyArray<Event> = []
    while (Date.now() < deadline) {
      let events: ReadonlyArray<Event>
      try {
        events = await drainAuthorEvents(client, invocation.thread)
        lastEvents = events
      } catch (cause) {
        if (Date.now() >= deadline) {
          throw new HarnessAuthorInvocationError("author_timeout", "The harness author exceeded the 60-second controller deadline.")
        }
        if (cause instanceof HarnessAuthorInvocationError) throw cause
        throw new HarnessAuthorInvocationError("actor_unavailable", "The local host became unavailable while the harness author was running.")
      }
      const boundary = boundaryOf(events, invocation.turn)
      if (boundary?.kind === "completed") {
        const modelCalls = events.filter((event) => event.type === "ModelCalled" && (
          (event as { readonly turn?: unknown }).turn === undefined ||
          (event as { readonly turn?: unknown }).turn === invocation.turn
        ))
        if (modelCalls.length < 1 || modelCalls.length > MAX_AUTHOR_MODEL_CALLS) {
          throw new HarnessAuthorInvocationError("author_failed", "The author exceeded its bounded model/tool-turn contract.")
        }
        try {
          const proposal = validateHarnessAuthorProposal(completedOutputOf(boundary.output), brief)
          return {
            actorName: HARNESS_AUTHOR_ACTOR_NAME,
            proposal,
            proposalDigest: harnessAuthorProposalDigest(proposal),
            usage: harnessAuthorUsageOf(events)
          }
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : "unknown validation failure"
          throw new HarnessAuthorInvocationError(
            "output_invalid",
            `The author returned a proposal that failed trusted validation: ${detail}`,
            harnessAuthorUsageOf(events)
          )
        }
      }
      if (boundary?.kind === "failed") {
        const unavailable = /model|provider|credential|configuration/iu.test(boundary.error)
        throw new HarnessAuthorInvocationError(
          unavailable ? "model_unavailable" : "author_failed",
          unavailable
            ? "Configure an allowed Tardigrade model provider before invoking the harness author."
            : "The harness author turn failed before producing a valid proposal.",
          harnessAuthorUsageOf(events)
        )
      }
      if (boundary?.kind === "cancelled") {
        throw new HarnessAuthorInvocationError("author_failed", "The harness author turn was cancelled.", harnessAuthorUsageOf(events))
      }
      await Bun.sleep(AUTHOR_POLL_MS)
    }
    throw new HarnessAuthorInvocationError(
      "author_timeout",
      "The harness author exceeded the 60-second controller deadline.",
      harnessAuthorUsageOf(lastEvents)
    )
  }
}
