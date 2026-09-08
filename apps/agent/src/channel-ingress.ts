import {
  channelSeal,
  channelHydrate,
  channelOpenEvent,
} from "./channel-custody.ts";
import type { HarnessBlobStore } from "./harness-library.ts";
import { Effect } from "effect";
import { Validator } from "@cfworker/json-schema";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import {
  CHANNEL_PROVENANCE,
  channelBindings,
  channelDigest,
  channelEventDigest,
  channelFact,
  type ChannelBinding,
} from "./channel-bindings.ts";
import { channelWiringView, type WiringJournal } from "./channel-wiring.ts";
import type { VerifiedIngress } from "./channel-runtime.ts";
import type { HostedChannels } from "./channel-host.ts";

type Port = { channel: string; generation: number };
export type ChannelBridgeSpec = {
  operationId: string;
  external: Port;
  input: Port;
  output: Port;
  wiring: { id: string; generation: number };
  decodeSchema: string;
  authorityRef: string;
  sendAuthorityRef: string;
  expiresAt: number;
};
type Bridge = ChannelBridgeSpec & {
  id: string;
  owner: string;
  artifact: ChannelBinding["artifact"];
};
export interface ChannelBridgeBindings {
  authorize(
    owner: string,
    operation: "bind" | "revoke" | "send",
    bridge: ChannelBridgeSpec,
  ): Promise<boolean>;
  now?(): number;
}
/** Only a trusted, configured lookup can mint this receive-only grant. The lookup
 * authenticates the opaque capability separately from the provider's body signature.
 * Neither a route ID nor an owner bearer token is itself a receiving capability.
 */
export interface ChannelSourceGrant {
  owner: string;
  channel: string;
  generation: number;
  bridge: string;
  capabilityRef: string;
  scope: "receive";
  expiresAt: number;
  verify(
    binding: ChannelBinding,
    request: Request,
    body: string,
  ): Promise<VerifiedIngress | undefined>;
}
export interface ChannelPublicIngressBindings {
  lookup(
    route: string,
    receiveCapability: string,
  ): Promise<ChannelSourceGrant | undefined>;
  hosted(owner: string): Promise<HostedChannels | undefined>;
  wake(owner: string): void | Promise<void>;
  now?(): number;
}
const reply = (status: number, value: unknown) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
/** Mount BEFORE account authentication at exactly this receive-only route. This
 * function never constructs an account principal and cannot list/mutate bindings.
 */
export function createChannelPublicIngress(
  bindings: ChannelPublicIngressBindings,
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      match = /^\/v1\/channel-ingress\/([A-Za-z0-9_-]{1,160})$/.exec(
        url.pathname,
      );
    if (!match || url.search)
      return reply(404, { error: "channel_ingress_route" });
    if (request.method !== "POST") return reply(405, { error: "receive_only" });
    const token = request.headers.get("x-channel-receive-capability");
    if (!token || token.length > 1024)
      return reply(401, { error: "receive_capability_required" });
    try {
      const grant = await bindings.lookup(match[1]!, token);
      if (
        !grant ||
        grant.scope !== "receive" ||
        !grant.owner ||
        !grant.channel ||
        !grant.bridge ||
        !grant.capabilityRef ||
        !Number.isSafeInteger(grant.generation) ||
        grant.generation < 1 ||
        !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= (bindings.now ?? Date.now)()
      )
        return reply(403, { error: "receive_capability_denied" });
      const hosted = await bindings.hosted(grant.owner);
      if (!hosted || hosted.owner !== grant.owner)
        return reply(404, { error: "channel_unconfigured" });
      const receipt = await hosted.receiveScoped(grant, request);
      // Custody is already durable. A transient wake failure must not lie about it.
      try {
        await bindings.wake(grant.owner);
      } catch {
        /* existing durable alarm covers recovery */
      }
      return reply(202, receipt);
    } catch (error) {
      const reason = String(error);
      if (/authentication|capability|signature/.test(reason))
        return reply(403, { error: "source_authentication_failed" });
      if (/payload_limit/.test(reason))
        return reply(413, { error: "payload_limit" });
      if (/generation|inactive|bridge_scope|bridge_unavailable/.test(reason))
        return reply(409, { error: "channel_scope_unavailable" });
      if (/occurrence_conflict/.test(reason))
        return reply(409, { error: "occurrence_conflict" });
      return reply(503, { error: "channel_custody_unconfirmed" });
    }
  };
}
const kinds = new Set([
  "Bound",
  "Revoked",
  "Selected",
  "InputLinked",
  "OutputLinked",
  "OutputRejected",
]);
export function channelBridgeEventKey(e: Event) {
  return e.provenance === CHANNEL_PROVENANCE &&
    typeof e.owner === "string" &&
    typeof e.id === "string" &&
    e.type.startsWith("AikoChannelBridge") &&
    kinds.has(e.type.slice(17))
    ? `aiko-channel-bridge:${e.owner}:${e.type}:${e.id}`
    : undefined;
}
const fact = (
  owner: string,
  kind: string,
  id: string,
  fields: Record<string, unknown>,
): Event => ({
  at: 0,
  ...fields,
  type: `AikoChannelBridge${kind}`,
  owner,
  id,
  provenance: CHANNEL_PROVENANCE,
});
const same = (a: unknown, b: unknown) => channelDigest(a) === channelDigest(b);
const local = (rows: readonly Event[], owner: string) =>
  rows.filter((e) => e.owner === owner);
const find = (rows: readonly Event[], kind: string, id: unknown) =>
  rows.find((e) => e.type === `AikoChannelBridge${kind}` && e.id === id);
const externalId = (e: Event) =>
  channelDigest([e.owner, e.channel, e.generation, e.id]);
const active = (
  rows: readonly Event[],
  owner: string,
  id: string,
  now: number,
): Bridge | undefined => {
  const b = find(local(rows, owner), "Bound", id)?.bridge as Bridge | undefined;
  return b && b.expiresAt > now && !find(local(rows, owner), "Revoked", id)
    ? b
    : undefined;
};
const portKey = (p: Port) => `${p.channel}:${p.generation}`;
const exactPort = (x: any) =>
  x &&
  Object.keys(x).sort().join() === "channel,generation" &&
  typeof x.channel === "string" &&
  Number.isSafeInteger(x.generation) &&
  x.generation > 0;
/** Recheck a bridge-derived outbox intent after asynchronous sender authorization and
 * again under the shared commit gate. Ordinary outbox traffic is unaffected. */
export async function channelBridgeSendScope(
  rows: readonly Event[],
  owner: string,
  input: any,
  now: number,
  blobs?: HarnessBlobStore,
): Promise<{ managed: boolean; allowed: boolean }> {
  const claim = rows.find(
    (e) =>
      e.type === "AikoChannelWiringClaimed" &&
      e.owner === owner &&
      e.id === input?.task,
  );
  const linked = rows.find(
    (e) =>
      e.type === "AikoChannelBridgeInputLinked" &&
      e.owner === owner &&
      e.source === claim?.source,
  );
  if (!linked) return { managed: false, allowed: true };
  const b = linked.bridge as Bridge,
    context = (await channelOpenEvent(blobs, owner, linked))
      .context as VerifiedIngress;
  const external = channelBindings(rows, owner).get(b.external.channel);
  return {
    managed: true,
    allowed:
      !!active(rows, owner, b.id, now) &&
      external?.status === "active" &&
      external.generation === b.external.generation &&
      same(external.artifact, b.artifact) &&
      input.operationId ===
        channelDigest([owner, "bridge-output", b.id, linked.input]) &&
      input.authorization === b.sendAuthorityRef &&
      input.conversation === context.conversation &&
      input.replyTo === context.occurrence &&
      input.destination === external.destination,
  };
}

export function channelBridgeAppendAllowed(
  batch: readonly Event[],
  read: () => readonly Event[],
) {
  const rows = [...read()];
  for (const e of batch) {
    if (!e.type.startsWith("AikoChannelBridge")) {
      rows.push(e);
      continue;
    }
    const key = channelBridgeEventKey(e);
    if (!key) return false;
    const prior = rows.find((r) => channelBridgeEventKey(r) === key);
    if (prior && channelEventDigest(prior) !== channelEventDigest(e))
      return false;
    if (
      e.type === "AikoChannelBridgeSelected" &&
      !find(local(rows, String(e.owner)), "Bound", (e.bridge as Bridge).id)
    )
      return false;
    if (
      e.type === "AikoChannelBridgeInputLinked" &&
      !rows.some(
        (r) =>
          r.type === "AikoChannelWiringAccepted" &&
          r.owner === e.owner &&
          r.id === e.source,
      )
    )
      return false;
    if (
      e.type === "AikoChannelBridgeOutputLinked" &&
      !rows.some(
        (r) =>
          r.type === "AikoChannelOutputPrepared" &&
          r.owner === e.owner &&
          r.channel === e.channel &&
          r.generation === e.generation &&
          r.id === e.operationId,
      )
    )
      return false;
    rows.push(e);
  }
  return true;
}

export function createChannelBridge(
  owner: string,
  journal: WiringJournal,
  bindings: ChannelBridgeBindings,
  prepare: (
    id: string,
    generation: number,
    input: {
      operationId: string;
      task: string;
      authorization: string;
      payload: string;
      conversation: string;
      replyTo: string;
      ancestry: string[];
    },
  ) => Effect.Effect<string, never, Self | EventLog>,
) {
  const now = bindings.now ?? Date.now;
  const scoped = Effect.gen(function* () {
    const self = yield* Self;
    if (self.actor !== "aiko" || self.thread !== `user-${owner}`)
      throw new Error("channel_owner_mismatch");
  });
  const available = (
    rows: readonly Event[],
    b: Bridge,
    requireLatest = true,
    pendingIngress = false,
  ) => {
    const external = channelBindings(rows, owner).get(b.external.channel);
    const state = channelWiringView(rows, owner),
      wire = state.wires.get(`${b.wiring.id}:${b.wiring.generation}`);
    const latest = [...state.wires.values()]
      .filter((w) => w.id === b.wiring.id)
      .at(-1);
    return (
      (external?.status === "active" || pendingIngress && external?.status === "pending" && external.ingressBeforeSubscribe === true) &&
      external.generation === b.external.generation &&
      same(external.artifact, b.artifact) &&
      wire?.status === "active" &&
      (!requireLatest || latest?.generation === b.wiring.generation) &&
      same(wire.input, b.input) &&
      same(
        { channel: wire.output.channel, generation: wire.output.generation },
        b.output,
      )
    );
  };
  const api = {
    bind: (raw: ChannelBridgeSpec) =>
      Effect.gen(function* () {
        yield* scoped;
        const spec = structuredClone(raw);
        if (
          !spec ||
          Object.keys(spec).sort().join() !==
            "authorityRef,decodeSchema,expiresAt,external,input,operationId,output,sendAuthorityRef,wiring" ||
          ![spec.external, spec.input, spec.output].every(exactPort) ||
          !spec.wiring ||
          Object.keys(spec.wiring).sort().join() !== "generation,id" ||
          !Number.isSafeInteger(spec.wiring.generation) ||
          spec.wiring.generation < 1 ||
          ![
            spec.operationId,
            spec.authorityRef,
            spec.sendAuthorityRef,
            spec.decodeSchema,
            spec.wiring.id,
          ].every(
            (s) => typeof s === "string" && s.length > 0 && s.length < 1024,
          ) ||
          !Number.isFinite(spec.expiresAt) ||
          spec.expiresAt <= now()
        )
          throw new Error("channel_bridge_scope");
        if (
          !(yield* Effect.promise(() =>
            bindings.authorize(owner, "bind", spec),
          ))
        )
          throw new Error("channel_bridge_capability");
        return yield* Effect.promise(() =>
          journal.transact((rows) => {
            const external = channelBindings(rows, owner).get(
              spec.external.channel,
            );
            if (
              !external ||
              !external.artifact.operations.includes("decode") ||
              !external.artifact.operations.includes("send")
            )
              throw new Error("channel_bridge_scope");
            const b: Bridge = {
              ...spec,
              owner,
              id: channelDigest([owner, "bridge", spec.operationId]),
              artifact: external.artifact,
            };
            const prior = find(local(rows, owner), "Bound", b.id);
            if (prior) {
              if (!same(prior.bridge, b))
                throw new Error("channel_bridge_conflict");
              return { events: [], result: b };
            }
            if (
              !available(rows, b, true, true) ||
              local(rows, owner).some(
                (e) =>
                  e.type === "AikoChannelBridgeBound" &&
                  same((e.bridge as Bridge).external, b.external) &&
                  active(rows, owner, String(e.id), now()),
              )
            )
              throw new Error("channel_bridge_scope");
            return {
              events: [fact(owner, "Bound", b.id, { bridge: b })],
              result: b,
            };
          }),
        );
      }),
    revoke: (id: string) =>
      Effect.gen(function* () {
        yield* scoped;
        const rows = yield* Effect.promise(journal.read);
        const b = find(local(rows, owner), "Bound", id)?.bridge as
          Bridge | undefined;
        if (
          !b ||
          !(yield* Effect.promise(() => bindings.authorize(owner, "revoke", b)))
        )
          throw new Error("channel_bridge_capability");
        yield* Effect.promise(() =>
          journal.transact((events) => ({
            events: find(local(events, owner), "Revoked", id)
              ? []
              : [fact(owner, "Revoked", id, {})],
            result: undefined,
          })),
        );
      }),
  };
  /** Called synchronously INSIDE the shared host journal gate. No asynchronous
   * adapter work, input-selected code or network effects are performed here. */
  const admit = async (
    batch: readonly Event[],
    before: readonly Event[],
  ): Promise<Event[]> => {
    const result: Event[] = [];
    for (const e of batch) {
      result.push(e);
      if (e.owner !== owner) continue;
      const rows = [...before, ...result];
      if (e.type === "AikoChannelReceived") {
        const prior = find(local(rows, owner), "Selected", externalId(e));
        if (prior) continue;
        const b = local(rows, owner)
          .filter((r) => r.type === "AikoChannelBridgeBound")
          .map((r) => active(rows, owner, String(r.id), now()))
          .find(
            (b) =>
              b &&
              b.external.channel === e.channel &&
              b.external.generation === e.generation,
          );
        if (b && available(rows, b, true, true))
          result.push(
            fact(owner, "Selected", externalId(e), { bridge: b, input: e.id }),
          );
      }
      if (e.type !== "AikoChannelInputAccepted") continue;
      const selected = find(local(rows, owner), "Selected", externalId(e));
      if (!selected) continue;
      const b = selected.bridge as Bridge;
      if (find(local(rows, owner), "InputLinked", externalId(e))) continue;
      const state = channelWiringView(rows, owner),
        port = state.ports.get(portKey(b.input)),
        wire = state.wires.get(`${b.wiring.id}:${b.wiring.generation}`);
      const observation = e.observation as {
          schemaVersion: string;
          text: string;
        },
        context = e.context as VerifiedIngress;
      const value = { text: observation.text };
      const rejected =
        !active(rows, owner, b.id, now()) || !available(rows, b)
          ? "bridge_stale"
          : !port ||
              !wire ||
              observation.schemaVersion !== b.decodeSchema ||
              !new Validator(wire.inputSchema as any).validate(value).valid
            ? "bridge_decode_schema"
            : undefined;
      if (rejected) {
        const external = channelBindings(rows, owner).get(b.external.channel)!;
        result.push(
          channelFact("InputRejected", external, String(e.id), {
            reason: rejected,
            at: now(),
          }),
        );
        continue;
      }
      const accepted = state.rows.filter(
        (r) => r.type === "AikoChannelWiringAccepted" && same(r.port, b.input),
      );
      const pending = accepted.filter(
        (r) =>
          !state.rows.some(
            (c) => c.type === "AikoChannelWiringCursor" && c.source === r.id,
          ),
      );
      if (
        pending.length >= port!.backlog ||
        new TextEncoder().encode(JSON.stringify(value)).length > port!.maxBytes
      )
        throw new Error("channel_bridge_backpressure");
      const source = channelDigest([owner, "provider-input", externalId(e)]),
        correlation = channelDigest([
          owner,
          b.external,
          context.partition,
          context.occurrence,
        ]);
      const valueRef = await channelSeal(journal.blobs, owner, value);
      const correlationRef = await channelSeal(
        journal.blobs,
        owner,
        correlation,
      );
      result.push({
        type: "AikoChannelWiringAccepted",
        owner,
        provenance: CHANNEL_PROVENANCE,
        id: source,
        at: now(),
        port: b.input,
        schema: wire!.accepts,
        valueRef,
        bytes: new TextEncoder().encode(JSON.stringify(value)).length,
        sequence: accepted.length + 1,
        correlation: correlationRef.ref,
        correlationRef,
        occurrence: source,
        digest: (await channelSeal(journal.blobs, owner, [value, correlation]))
          .ref,
        ancestry: [],
      });
      result.push(
        fact(owner, "InputLinked", externalId(e), {
          bridge: b,
          source,
          correlation: correlationRef.ref,
          context,
          input: e.id,
        }),
      );
    }
    return result;
  };
  const native = component({
    name: "aiko.channel-bridge",
    keys: { prefixes: ["aiko-channel-bridge:"], keyOf: channelBridgeEventKey },
    initial: () => [] as Event[],
    step: (s, e) => (e.owner === owner ? [...s, e] : s),
    output: (rows) => ({
      view: undefined,
      transitions: rows
        .filter(
          (e) =>
            e.type === "AikoChannelWiringAccepted" &&
            e.invocation &&
            !find(rows, "OutputLinked", e.id) &&
            !find(rows, "OutputRejected", e.id),
        )
        .flatMap((output) => {
          const claim = rows.find(
            (e) =>
              e.type === "AikoChannelWiringClaimed" &&
              e.id === output.invocation,
          );
          const linked = rows.find(
            (e) =>
              e.type === "AikoChannelBridgeInputLinked" &&
              e.source === claim?.source,
          );
          if (!claim || !linked) return [];
          const b = linked.bridge as Bridge,
            wire = claim.wire as any;
          const settled = rows.findLast(
            (e) =>
              e.type === "AikoChannelWiringSettled" &&
              e.invocation === output.invocation,
          );
          if (
            settled?.status !== "satisfied" ||
            wire.id !== b.wiring.id ||
            wire.generation !== b.wiring.generation ||
            !same(output.port, b.output) ||
            output.replyTo !== linked.source ||
            output.correlation !== linked.correlation
          )
            return [];
          return [
            effect({
              key: `aiko-channel-bridge:out:${output.id}`,
              input: { id: output.id },
              act: () =>
                Effect.gen(function* () {
                  yield* scoped;
                  const reject = (reason: string) =>
                    Effect.promise(() =>
                      journal.transact((events) => ({
                        events: find(
                          local(events, owner),
                          "OutputRejected",
                          output.id,
                        )
                          ? []
                          : [
                              fact(owner, "OutputRejected", String(output.id), {
                                bridge: b.id,
                                reason,
                              }),
                            ],
                        result: [] as Event[],
                      })),
                    );
                  const current = yield* Effect.promise(journal.read);
                  if (
                    !active(current, owner, b.id, now()) ||
                    !available(current, b, false)
                  )
                    return yield* reject("bridge_scope_unavailable");
                  if (
                    !(yield* Effect.promise(() =>
                      bindings.authorize(owner, "send", b),
                    ))
                  )
                    return yield* reject("bridge_send_capability_denied");
                  const retained = yield* Effect.promise(async () => {
                    try {
                      return {
                        value: await channelHydrate(
                          journal.blobs,
                          owner,
                          output.valueRef,
                        ),
                        linked: await channelOpenEvent(
                          journal.blobs,
                          owner,
                          linked,
                        ),
                      };
                    } catch {
                      return undefined;
                    }
                  });
                  if (!retained) return yield* reject("output_unavailable");
                  const value = retained.value as any;
                  if (
                    !value ||
                    Object.keys(value).join() !== "text" ||
                    typeof value.text !== "string"
                  )
                    return yield* reject("bridge_output_schema");
                  const context = retained.linked.context as VerifiedIngress;
                  const external = channelBindings(current, owner).get(
                    b.external.channel,
                  )!;
                  if (context.ancestry.length + 1 >= external.maxHops)
                    return yield* reject("bridge_hop_limit");
                  const operationId = channelDigest([
                    owner,
                    "bridge-output",
                    b.id,
                    linked.input,
                  ]);
                  const preparedId = yield* prepare(
                    b.external.channel,
                    b.external.generation,
                    {
                      operationId,
                      task: String(output.invocation),
                      authorization: b.sendAuthorityRef,
                      payload: value.text,
                      conversation: context.conversation,
                      replyTo: context.occurrence,
                      ancestry: [...context.ancestry, operationId],
                    },
                  ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
                  if (!preparedId) {
                    const retained = yield* Effect.promise(journal.read);
                    if (
                      !retained.some(
                        (e) =>
                          e.type === "AikoChannelOutputPrepared" &&
                          e.owner === owner &&
                          e.channel === b.external.channel &&
                          e.generation === b.external.generation &&
                          e.id === operationId,
                      )
                    )
                      return yield* reject("outbox_not_prepared");
                  }
                  yield* Effect.promise(() =>
                    journal.transact((events) => ({
                      events: find(
                        local(events, owner),
                        "OutputLinked",
                        output.id,
                      )
                        ? []
                        : [
                            fact(owner, "OutputLinked", String(output.id), {
                              operationId,
                              channel: b.external.channel,
                              generation: b.external.generation,
                              bridge: b.id,
                            }),
                          ],
                      result: undefined,
                    })),
                  );
                  return [];
                }),
            }),
          ];
        }),
    }),
  });
  return {
    api,
    admit,
    component: native,
    grantAllowed: (rows: readonly Event[], grant: ChannelSourceGrant) => {
      const b = active(rows, owner, grant.bridge, now());
      return (
        !!b &&
        b.external.channel === grant.channel &&
        b.external.generation === grant.generation &&
        available(rows, b, true, true)
      );
    },
  };
}
