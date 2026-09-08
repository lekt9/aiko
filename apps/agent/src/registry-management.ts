import {
  channelRegistryContinuations,
  type ChannelManagementGrant,
} from "./channel-registry.ts";
import { channelDigest, CHANNEL_PROVENANCE } from "./channel-bindings.ts";
import {
  HarnessLibrary,
  harnessDigest,
  type HarnessLibraryBinding,
  type HarnessJournal,
  type HarnessArtifact,
  type HarnessContract,
  type HarnessVerifier,
} from "./harness-library.ts";
import type {
  HandlerPin,
  ChannelWiringBindings,
  createChannelWiring,
} from "./channel-wiring.ts";
import type { CodeSegmentTransport } from "./code-sandbox.ts";

/** Trusted host configuration only. Registration is staged: fixed preflight cases
 * establish eligibility, NOT coverage of management effects. Each real invocation
 * still runs through native channel effects and the independent output verifier.
 * Initial standing policy permits one management level and pure/reply children. */
export interface RegistryManagementPolicy {
  revision: string;
  /** Separate standing receiving policy. Absence denies adoption; no provider or source grants. */
  standingHooks?: { maxLifetimeMs: number; handlers: readonly HandlerPin[] };
  parents: readonly {
    definition: {
      artifact: HarnessArtifact;
      contract: HarnessContract;
      verifier: HarnessVerifier;
    };
    children: readonly HandlerPin[];
  }[];
  maxCalls: number;
  maxBytes: number;
  wallMs: number;
}
export function registryManagementContinuations(options: {
  binding: HarnessLibraryBinding;
  journal: HarnessJournal;
  transport: CodeSegmentTransport;
  wiring(): ReturnType<typeof createChannelWiring>;
  current(): RegistryManagementPolicy | undefined;
  receiving: ChannelWiringBindings["authorize"];
  authorityRef: string;
}) {
  const { binding, journal } = options,
    owner = binding.owner;
  const denied = () => Error("standing_channel_management_denied");
  const policy = () => {
    const p = options.current();
    if (
      !p?.revision ||
      !p.parents.length ||
      !Number.isSafeInteger(p.maxCalls) ||
      p.maxCalls < 1 ||
      p.maxCalls > 16 ||
      !Number.isSafeInteger(p.maxBytes) ||
      p.maxBytes < 1 ||
      p.maxBytes > 65536 ||
      !Number.isSafeInteger(p.wallMs) ||
      p.wallMs < 1 ||
      p.wallMs > 60000
    )
      throw denied();
    return {
      ...p,
      parents: p.parents.map((r) => ({
        ...r,
        children: structuredClone(r.children),
        definition: {
          ...r.definition,
          artifact: structuredClone(r.definition.artifact),
          contract: structuredClone(r.definition.contract),
        },
      })),
    };
  };
  const stamp = (p: RegistryManagementPolicy) =>
    harnessDigest({
      ...p,
      parents: p.parents.map((r) => ({
        pin: {
          harness: harnessDigest(r.definition.artifact),
          contract: harnessDigest(r.definition.contract),
        },
        children: r.children,
      })),
    });
  const inspect = async (
    pin: HandlerPin,
    operation: string | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const p = policy(),
      rule = p.parents.find(
        (r) =>
          harnessDigest(r.definition.artifact) === pin.harness &&
          harnessDigest(r.definition.contract) === pin.contract,
      );
    if (!rule || !rule.children.length || rule.children.length > 8)
      throw denied();
    if (!(await options.receiving(owner, options.authorityRef, "connect", {})))
      throw denied();
    const lib = new HarnessLibrary(binding, journal);
    for (const child of rule.children) {
      const resolved = await lib.resolve(child.harness as any),
        effects = (resolved.contract.applicability.hook as any)?.effects;
      if (
        resolved.artifact.contractDigest !== child.contract ||
        resolved.artifact.runtime !== "javascript" ||
        resolved.contract.effect !== "read" ||
        !Array.isArray(effects) ||
        effects.some((e) => !["pure", "channel.reply"].includes(e))
      )
        throw denied();
    }
    const rows = await journal.read();
    let claim: (typeof rows)[number] | undefined;
    let acceptedAt: number | undefined;
    let cancellationTurns: string[] = [],
      waiterId: unknown;
    if (operation !== undefined) {
      claim = rows.find(
        (e) =>
          e.type === "AikoChannelWiringClaimed" &&
          e.owner === owner &&
          e.provenance === CHANNEL_PROVENANCE &&
          e.id === operation,
      );
      const wire = claim?.wire as any,
        source = rows.find(
          (e) =>
            e.type === "AikoChannelWiringAccepted" &&
            e.owner === owner &&
            e.id === claim?.source,
        );
      acceptedAt = Number(source?.at);
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt <= 0) throw denied();
      const port = rows.find(
        (e) =>
          e.type === "AikoChannelWiringBound" &&
          e.owner === owner &&
          (e.port as any)?.channel === wire?.input?.channel,
      );
      if (
        !claim ||
        harnessDigest(wire?.handler) !== harnessDigest(pin) ||
        wire.authority !== options.authorityRef ||
        source?.authority !== options.authorityRef ||
        !port ||
        String(port.operationId).startsWith("child:") ||
        !Array.isArray(claim.ancestry) ||
        claim.ancestry.length !== 0
      )
        throw denied();
      const waiter = rows.find(
          (e) =>
            e.type === "AikoChannelWiringWaitRegistered" &&
            e.owner === owner &&
            e.id === source.requestWaiter,
        ),
        call = rows.find(
          (e) => e.type === "PackageCalled" && e.callId === waiter?.callId,
        );
      const execution = `channel-handler:${channelDigest([owner, binding.thread, operation])}`;
      cancellationTurns = [
        operation,
        execution,
        ...(call ? [String(call.turn)] : []),
      ];
      waiterId = waiter?.id;
      if (
        rows.some(
          (e) =>
            (["TurnCancelled", "TurnFailed"].includes(e.type) &&
              [operation, execution, ...(call ? [call.turn] : [])].includes(
                String(e.turn),
              )) ||
            (e.type === "AikoChannelWiringWaitCancelled" &&
              waiter &&
              e.id === waiter.id) ||
            (e.type === "CodeCancelled" && e.execId === execution),
        )
      )
        throw denied();
      const dispatched = rows.find(
        (e) =>
          e.type === "AikoChannelWiringHandlerDispatched" &&
          e.owner === owner &&
          e.operation === operation,
      );
      if (dispatched) {
        const grantRow = rows.find(
          (e) =>
            e.type === "AikoChannelWiringManagementGranted" &&
            e.owner === owner &&
            e.id === execution,
        );
        if (!grantRow) throw denied();
        const grant = (await binding.blobs.get(
          owner,
          grantRow.grantRef as any,
        )) as unknown as ChannelManagementGrant;
        if (grant.revision !== stamp(p) || grant.deadline <= Date.now())
          throw denied();
      }
    }
    if (
      stamp(policy()) !== stamp(p) ||
      !(await options.receiving(owner, options.authorityRef, "connect", {}))
    )
      throw denied();
    const fresh = await journal.read();
    if (
      fresh.some(
        (e) =>
          (["TurnCancelled", "TurnFailed"].includes(e.type) &&
            cancellationTurns.includes(String(e.turn))) ||
          (e.type === "CodeCancelled" &&
            cancellationTurns.includes(String(e.execId))) ||
          (e.type === "AikoChannelWiringWaitCancelled" &&
            waiterId !== undefined &&
            e.id === waiterId),
      ) ||
      stamp(policy()) !== stamp(p)
    )
      throw denied();
    signal.throwIfAborted();
    return { p, rule, claim, acceptedAt };
  };
  const continuations = channelRegistryContinuations({
    ...options,
    authorizeAdoption: async (decision) => {
      try {
        const p = policy(), standing = p.standingHooks;
        if (!standing || !Number.isSafeInteger(standing.maxLifetimeMs) || standing.maxLifetimeMs < 1 || standing.maxLifetimeMs > 86400000 ||
          decision.authorityRef !== options.authorityRef || decision.expiresAt <= Date.now() || decision.expiresAt > Date.now() + standing.maxLifetimeMs) return undefined;
        const rows = await journal.read();
        const dispatched = rows.find(e=>e.type === "AikoChannelWiringHandlerDispatched" && e.owner === owner && e.id === decision.execution);
        if (!dispatched || !p.parents.some(r=>harnessDigest(r.definition.artifact)===(dispatched.pin as HandlerPin)?.harness && harnessDigest(r.definition.contract)===(dispatched.pin as HandlerPin)?.contract)) return undefined;
        const children = rows.filter(e=>e.type === "AikoChannelWiringConnected" && e.owner === owner && String((e.wire as any)?.id) && rows.some(b=>b.type === "AikoChannelWiringBound" && b.owner === owner && String(b.operationId).startsWith(decision.namespace+":") && (b.port as any)?.channel === (e.wire as any)?.input.channel));
        if (!children.length) return undefined;
        for (const row of children) {
          const wire = row.wire as any;
          if (wire.authority !== options.authorityRef || !standing.handlers.some(pin=>harnessDigest(pin)===harnessDigest(wire.handler))) return undefined;
          const resolved = await new HarnessLibrary(binding,journal).resolve(wire.handler.harness);
          const effects = (resolved.contract.applicability.hook as any)?.effects;
          if (resolved.contract.effect !== "read" || !Array.isArray(effects) || effects.some(e=>!["pure","channel.reply"].includes(e))) return undefined;
          if (!await options.receiving(owner,options.authorityRef,"connect",wire)) return undefined;
        }
        return stamp(policy()) === stamp(p) ? stamp(p) : undefined;
      } catch { return undefined; }
    },
    authorize: async (pin, op, s) => {
      try {
        await inspect(pin, op, s);
        return true;
      } catch {
        return false;
      }
    },
    grant: async (pin, operation, execution, signal) => {
      const { p, rule, acceptedAt } = await inspect(pin, operation, signal);
      const deadline = Math.min(
        acceptedAt! + p.wallMs,
        Date.now() + rule.definition.contract.timeoutMs,
      );
      if (deadline <= Date.now()) throw denied();
      return {
        owner,
        execution,
        parentOperation: operation,
        revision: stamp(p),
        authorityRef: options.authorityRef,
        depth: 0,
        maxDepth: 1,
        maxCalls: p.maxCalls,
        maxBytes: p.maxBytes,
        backlog: 8,
        maxHops: 2,
        deadline,
        handlers: rule.children,
        methods: ["bind", "connect", "emit", "request", "wait"],
      };
    },
  });
  options.wiring().setAdoptionPolicy(continuations.authorizeAdoption);
  return continuations;
}
