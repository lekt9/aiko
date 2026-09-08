import { mediaVideoHarnessDefinition, renderVerifiedVideoFinding, type VideoOracleCase } from "./harness-video.ts";
import videoSource from "../assets/media-video.py" with { type: "text" };
import videoFixtures from "../assets/media-video-host-fixtures.json";
import { DefiniteComputeRuntimeFailure, type ComputeRuntimeRepair } from "./compute-runtime-recovery.ts";
import { gunzipSync } from "node:zlib";
import multilingualPack from "../assets/media-multilingual-host-fixtures.json";
import multilingualLock from "../assets/media-multilingual-model.lock.json";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { component, deriveComponent } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import {
  harnessDigest,
  type HarnessLibraryBinding,
  type HarnessJournal,
  type HarnessDigest,
} from "./harness-library.ts";
import {
  createHarnessSandboxBinding,
  type HarnessSandboxClient,
} from "./harness-sandbox.ts";
import { createMediaEvidence } from "./harness-media-evidence.ts";
import {
  mediaHarnessDefinitions,
  mediaLifecycleBudgets,
  type MediaFixture,
} from "./harness-media.ts";
import {
  createMediaProcessing,
  retainMediaAsset,
  resolveMediaAssets,
  mediaProcessingAppendAllowed,
  mediaProcessingEventKey,
  mediaProcessingReady,
  mediaProcessingNextWake,
  type MediaDelivery,
  type MediaInputScope,
} from "./media-processing.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import mediaSource from "../assets/media-harness.py" with { type: "text" };
import evidenceSource from "../assets/media-evidence.py" with { type: "text" };
import fixtures from "../assets/media-host-fixtures.json";
import modelLock from "../assets/media-model.lock.json";
import { sandboxDigest, type SandboxJob } from "./sandbox-job.ts";

export const mediaHostEventKey = (e: Event) =>
  e.type === "AikoMediaRuntimeRepairSettled" ? `aiko-media-host-repair:${e.owner}:${e.id}` :
  e.type === "AikoMediaCatalogPublished"
    ? `aiko-media-host-catalog:${e.owner}`
    : e.type === "AikoMediaIngressAccepted"
      ? `aiko-media-host:${e.owner}:${e.id}`
      : e.type === "AikoMediaIngressFailed"
        ? `aiko-media-host-failed:${e.owner}:${e.id}`
        : undefined;
export type MediaHost = ReturnType<typeof createMediaHost>;
/** Attachment authority comes only from authenticated host admission. This is an
 * adapter over the existing processing component, not another work scheduler. */
export function createMediaHost(options: {
  owner: string;
  library: HarnessLibraryBinding;
  sandbox: HarnessSandboxClient;
  placement: "local" | "codegraff";
  kv: WorkflowKV;
  journal: HarnessJournal;
  current(): { active: boolean; revision: string };
  serialize<T>(fn: () => Promise<T>): Promise<T>;
}) {
  const { owner, library, kv, journal } = options,
    blobs = library.blobs;
  const allowed = () => {
    const p = options.current();
    if (!p.active || !p.revision) throw Error("Owned media grant unavailable");
    return p;
  };
  const catalogKey = `media-host-catalog:${owner}`;
  const multilingualEnabled = async () => {
    allowed();
    return ((await kv.get(catalogKey)) as any)?.multilingual === true;
  };
  const publishCatalog = async () =>
    options.serialize(async () => {
      const grant = allowed();
      await journal.append([
        {
          type: "AikoMediaCatalogPublished",
          owner,
          id: "multilingual",
          variant: "multilingual",
          at: 0,
        },
      ]);
      await kv.put(catalogKey, { version: 1, multilingual: true });
      if (allowed().revision !== grant.revision)
        throw Error("Media grant changed");
      return { status: "published", variants: ["multilingual"] };
    });
  const key = (id: string) => `media-host-ingress:${owner}:${id}`;
  type Ingress = {
    owner: string;
    channel: string;
    operationId: string;
    contentRef: HarnessDigest;
    promptRef: HarnessDigest;
    mimeType: string;
    language?: string;
    deadline: number;
    delivery: MediaDelivery;
    grant: string;
    repairedFrom?: string;
  };
  const retained = async (scope: MediaInputScope) => {
    const grant = allowed();
    if (scope.owner !== owner) throw Error("Media ingress scope mismatch");
    const ref = await kv.get(key(scope.operationId));
    if (typeof ref !== "string")
      throw Error("Media ingress custody unavailable");
    if (allowed().revision !== grant.revision) throw Error("Media grant changed");
    const row = (await blobs.get(owner, ref as HarnessDigest)) as Ingress;
    if (
      allowed().revision !== grant.revision ||
      row.grant !== grant.revision ||
      row.owner !== owner ||
      scope.owner !== owner ||
      row.channel !== scope.channel ||
      row.contentRef !== scope.contentRef
    )
      throw Error("Media ingress scope mismatch");
    return row;
  };
  const authorize = async (scope: MediaInputScope) => {
    try {
      const p = allowed(),
        row = await retained(scope);
      return row.grant === p.revision && allowed().revision === p.revision;
    } catch {
      return false;
    }
  };
  const append = (events: readonly Event[]) =>
    options.serialize(async () => {
      const rows = await journal.read();
      if (!mediaProcessingAppendAllowed(events, () => rows))
        throw Error("Stale media completion");
      await journal.append([...events]);
    });
  let preparedEnvironment: string | undefined;
  let processing: ReturnType<typeof createMediaProcessing> | undefined,
    preparing: Promise<ReturnType<typeof createMediaProcessing>> | undefined;
  const prepare = (
    signal: AbortSignal,
    refresh = false,
  ): Promise<ReturnType<typeof createMediaProcessing>> => {
    if (processing && !refresh) return Promise.resolve(processing);
    if (preparing) return preparing;
    const run = async () => {
      const p = allowed(),
        environmentDigest = await options.sandbox.harnessEnvironment(signal),
        runtimeLockDigest = options.sandbox.pythonRuntimeLockDigest;
      if (!runtimeLockDigest || allowed().revision !== p.revision)
        throw Error("Isolated media runtime unavailable");
      const preparedPin = harnessDigest([p.revision, environmentDigest, runtimeLockDigest]);
      if (processing && preparedEnvironment === preparedPin) return processing;
      const contextRef = harnessDigest({
          owner,
          grant: p.revision,
          runtimeLockDigest,
          environmentDigest,
          scope: "owned-media-read/v1",
        }),
        authorityRef = harnessDigest({
          owner,
          grant: p.revision,
          scope: "owned-media-read/v1",
        });
      const multilingualFixtures = multilingualPack;
      const assets = async (input: any, signal: AbortSignal) => {
        signal.throwIfAborted();
        allowed();
        const name = input?.asset;
        if (typeof name === "string" && Object.hasOwn(videoFixtures.assets, name)) {
          const value = (videoFixtures.assets as Record<string, NonNullable<SandboxJob["assets"]>[string]>)[name]!;
          if (Buffer.from(value.data, "base64").length !== value.bytes || await sandboxDigest(value.data) !== value.digest) throw Error("Trusted video fixture changed");
          return { [name]: value };
        }
        if (typeof name === "string" && Object.hasOwn(fixtures.assets, name)) {
          const value = (
            fixtures.assets as Record<
              string,
              NonNullable<SandboxJob["assets"]>[string]
            >
          )[name]!;
          if ((await sandboxDigest(value.data)) !== value.digest)
            throw Error("Trusted media fixture changed");
          return { [name]: value };
        }
        if (
          typeof name === "string" &&
          Object.hasOwn(multilingualFixtures.assets, name)
        ) {
          const packed = (multilingualFixtures.assets as any)[name];
          const decoded = Buffer.from(
            gunzipSync(Buffer.from(packed.encoded, "base64")),
          );
          const value = {
            data: decoded.toString("base64"),
            bytes: packed.bytes,
            digest: packed.digest,
          };
          if (
            decoded.length !== packed.bytes ||
            (await sandboxDigest(value.data)) !== value.digest
          )
            throw Error("Trusted multilingual fixture changed");
          return { [name]: value };
        }
        return resolveMediaAssets(blobs, owner, input);
      };
      const evidence = createMediaEvidence({
        owner,
        blobs,
        sourceCode: evidenceSource,
        runtimeLockDigest,
        environmentDigest,
        contextRef,
        authorityRef,
        authorize: async () => allowed().revision === p.revision,
        assets,
        execute: (job, s) => options.sandbox.harnessJob(job, s),
      });
      const definitions = [...mediaHarnessDefinitions(
        runtimeLockDigest,
        mediaSource,
        {
          modelPath: "/models/whisper-tiny.en",
          modelRevision: modelLock.model.revision,
          fixtures: fixtures.fixtures as unknown as MediaFixture[],
          ...evidence,
        },
      )];
      definitions.push(mediaVideoHarnessDefinition(runtimeLockDigest, videoSource, {
        frames: definitions.find(d => d.artifact.name === "media.frames")!,
        fixtures: videoFixtures.fixtures as unknown as VideoOracleCase[],
      }));
      const multilingual = mediaHarnessDefinitions(
        runtimeLockDigest,
        mediaSource,
        {
          modelPath: "/models/whisper-tiny",
          modelRevision: multilingualLock.model.revision,
          languages: ["en", "es"],
          selectionLanguages: ["es"],
          transcriptionName: "media.transcribe.multilingual",
          fixtures: multilingualFixtures.fixtures as unknown as MediaFixture[],
          ...evidence,
        },
      ).find((d) => d.artifact.name === "media.transcribe.multilingual")!;
      const catalog = async () => {
        const current = (await multilingualEnabled())
          ? [...definitions, multilingual]
          : definitions;
        for (const d of current)
          (library.verifiers as Map<string, typeof d.verifier>).set(
            d.verifier.digest,
            d.verifier,
          );
        return current;
      };
      for (const d of definitions)
        (library.verifiers as Map<string, typeof d.verifier>).set(
          d.verifier.digest,
          d.verifier,
        );
      const execution = createHarnessSandboxBinding({
        owner,
        thread: library.thread,
        placement: options.placement,
        sandbox: options.sandbox,
        assets: (job, s) => assets(job.input, s),
        current: async (s) => {
          s.throwIfAborted();
          if (allowed().revision !== p.revision)
            throw Error("Media grant changed");
          return {
            owner,
            active: true,
            runtimeDigest: environmentDigest,
            pythonRuntimeLockDigest: runtimeLockDigest,
            contextRef,
            authorityRef,
            sessionRevision: null,
            effects: ["read"],
            origins: [],
            methods: [],
            budget: {
              wallMs: mediaLifecycleBudgets.invocationWallMs,
              requests: 0,
              outputBytes: 2097152,
              memoryBytes: 2147483648,
              processes: 64,
              scratchBytes: 67108864,
            },
          };
        },
      });
      const mediaLibrary: HarnessLibraryBinding = {
        ...library,
        ...execution,
        // The base registry's standing evaluation grant covers JavaScript.
        // Media has its own fixed catalog and exact host-owned cases; never
        // inherit or broaden the unrelated registry grant.
        authorizeEvaluation: async (artifact, contract, context, fixture, signal) => {
          signal.throwIfAborted();
          if (allowed().revision !== p.revision) return false;
          const definition = (await catalog()).find(d =>
            harnessDigest(d.contract) === harnessDigest(contract) &&
            harnessDigest(d.artifact) === harnessDigest(artifact));
          if (!definition || !definition.verifier.cases.some(c =>
            harnessDigest(c) === harnessDigest(fixture))) return false;
          return execution.authorize(artifact, contract, context, fixture.input, signal);
        },
      };
      processing = createMediaProcessing({
        library: mediaLibrary,
        definitions,
        catalog,
        journal: { read: journal.read, append },
        authorize: async (scope) => authorize(scope),
        delivery: async (scope) => (await retained(scope)).delivery,
      });
      preparedEnvironment = preparedPin;
      return processing;
    };
    preparing = run().finally(() => {
      preparing = undefined;
    });
    return preparing;
  };
  const supports = (mime: string) =>
    mime.startsWith("audio/") || mime.startsWith("video/");
  const admit = async (input: {
    owner: string;
    operationId: string;
    channel: string;
    bytes: Uint8Array;
    prompt: string;
    mimeType: string;
    language?: string;
    delivery: MediaDelivery;
    deadline?: number;
    repairedFrom?: string;
  }) => {
    if (
      input.owner !== owner ||
      !supports(input.mimeType) ||
      !/^[-A-Za-z0-9._:]{1,159}$/.test(input.operationId) ||
      !["api", "telegram"].includes(input.channel)
    )
      throw Error("Media admission scope denied");
    if (
      typeof input.prompt !== "string" ||
      input.prompt.length > 4000 ||
      !input.bytes.length ||
      input.bytes.length > 20 * 1024 * 1024 ||
      (input.deadline !== undefined &&
        (!Number.isSafeInteger(input.deadline) ||
          input.deadline <= Date.now() ||
          input.deadline >
            Date.now() + mediaLifecycleBudgets.maxAdmissionWallMs))
    )
      throw Error("Media input limit");
    if (
      input.language !== undefined &&
      (typeof input.language !== "string" ||
        !/^[a-z]{2,3}$/.test(input.language))
    )
      throw Error("Invalid media language hint");
    if (
      input.language &&
      input.language !== "en" &&
      (input.language !== "es" || !(await multilingualEnabled()))
    )
      throw Error("Media language catalog unavailable");
    const p = allowed();
    if (
      input.delivery.source === "telegram" &&
      (input.channel !== "telegram" ||
        input.delivery.chat !== owner ||
        input.delivery.sender !== owner)
    )
      throw Error("Foreign media delivery");
    if (input.channel === "api" && input.delivery.source !== "api")
      throw Error("Media delivery mismatch");
    const contentRef = await retainMediaAsset(blobs, owner, input.bytes),
      promptRef = await blobs.putPrivate(owner, input.prompt);
    return options.serialize(async () => {
      const previous = await kv.get(key(input.operationId));
      if (!previous) {
        const rows = await journal.read(),
          at = Date.now();
        const admissions = rows.filter(
          (e) =>
            e.type === "AikoMediaIngressAccepted" ||
            (e.type === "MessageReceived" && !e.mediaOperationId),
        );
        if (
          admissions.filter((e) => Number(e.at) > at - 60000).length >= 10 ||
          admissions.filter((e) => Number(e.at) > at - 86400000).length >= 100
        )
          throw Error("Media admission limited");
        if (
          rows.filter(
            (e) =>
              e.type === "AikoMediaIngressAccepted" &&
              !rows.some(
                (t) =>
                  t.id === e.id &&
                  [
                    "AikoMediaCompleted",
                    "AikoMediaCancelled",
                    "AikoMediaIngressFailed",
                  ].includes(t.type),
              ),
          ).length >= 2
        )
          throw Error("Media admission busy");
      }
      let row: Ingress = {
        owner,
        channel: input.channel,
        operationId: input.operationId,
        contentRef,
        promptRef,
        mimeType: input.mimeType,
        ...(input.language ? { language: input.language } : {}),
        deadline:
          input.deadline ??
          Date.now() + mediaLifecycleBudgets.maxAdmissionWallMs,
        delivery: input.delivery,
        grant: p.revision,
        ...(input.repairedFrom ? {repairedFrom:input.repairedFrom} : {}),
      };
      if (previous) {
        const old = (await blobs.get(
          owner,
          previous as HarnessDigest,
        )) as Ingress;
        row = { ...row, deadline: input.deadline ?? old.deadline };
        if (harnessDigest(old) !== harnessDigest(row))
          throw Error("Media operation identity conflict");
      }
      if (allowed().revision !== p.revision) throw Error("Media grant changed");
      const requestRef = await blobs.putPrivate(owner, row);
      await kv.claim(key(input.operationId), requestRef);
      const winner = await kv.get(key(input.operationId));
      if (winner !== requestRef)
        throw Error("Media operation identity conflict");
      await journal.append([
        {
          type: "AikoMediaIngressAccepted",
          owner,
          id: input.operationId,
          channel: input.channel,
          contentRef,
          requestRef,
          ...(row.repairedFrom ? {repairedFrom:row.repairedFrom} : {}),
          at: Date.now(),
        },
      ]);
      return { status: "accepted", id: input.operationId };
    });
  };
  const native = component({
    name: "aiko.media-host",
    keys: {
      prefixes: [
        "aiko-media-host-catalog:",
        "aiko-media-host:",
        "aiko-media-host-failed:",
        "aiko-media-host-repair:",
        "aiko-media:",
      ],
      keyOf: (e: Event) => mediaHostEventKey(e) ?? mediaProcessingEventKey(e),
    },
    initial: () => [] as Event[],
    step: (rows: Event[], e: Event) => [...rows, e],
    output: (rows) => ({
      view: undefined,
      transitions: [
        ...rows.filter(e => e.type === "AikoMediaIngressFailed" && e.owner === owner && typeof e.runtimeFailureRef === "string" &&
          !rows.some(t=>t.type === "AikoMediaRuntimeRepairSettled" && t.owner === owner && t.id === e.id)).slice(0,1).map(e=>effect({
          key:`aiko-media-host-repair:${owner}:${e.id}`,input:e,
          act:(failure,signal)=>Effect.gen(function*(){
            const self=yield* Self;
            if(self.actor!=="aiko" || self.thread!==library.thread)throw Error("Media repair scope denied");
            return yield* Effect.promise(async()=>{
              const settled=(status:string, extra:object={})=>[{type:"AikoMediaRuntimeRepairSettled",owner,id:failure.id,status,at:Date.now(),...extra}];
              try {
                const ingress=rows.find(x=>x.type === "AikoMediaIngressAccepted" && x.owner===owner && x.id===failure.id)!;
                const original=await retained({owner,channel:String(ingress.channel),operationId:String(failure.id),contentRef:ingress.contentRef as HarnessDigest});
                if(original.repairedFrom || original.deadline<=Date.now())return settled("refused");
                const repair=options.sandbox as typeof options.sandbox & Partial<ComputeRuntimeRepair>;
                if(!repair.repairRuntime)return settled("unsupported");
                // Check custody before spending the bounded rebuild grant.
                await blobs.get(owner,original.contentRef);
                const prompt=await blobs.get(owner,original.promptRef);
                if(typeof prompt!=="string" || !await authorize(original))return settled("refused");
                const operationId=`media-repair:${harnessDigest([owner,original.operationId,failure.runtimeFailureRef]).slice(7)}`;
                const deadline=AbortSignal.any([signal,AbortSignal.timeout(original.deadline-Date.now())]);
                await repair.repairRuntime({owner,operationId,failureRef:failure.runtimeFailureRef as HarnessDigest,grant:original.grant,deadline:original.deadline},deadline,()=>authorize(original));
                if(!await authorize(original))return settled("refused");
                const asset=await resolveMediaAssets(blobs,owner,{asset:`media-${original.contentRef.slice(7)}`});
                if(!await authorize(original))return settled("refused");
                await admit({owner,operationId,channel:original.channel,bytes:Buffer.from(Object.values(asset)[0]!.data,"base64"),prompt,mimeType:original.mimeType,language:original.language,delivery:original.delivery,deadline:original.deadline,repairedFrom:original.operationId});
                return settled("ready",{operationId});
              } catch (error) { if(signal.aborted)throw error; return settled("unconfirmed"); }
            });
          }),
        })),
        ...rows
        .filter(
          (e) =>
            e.type === "AikoMediaIngressAccepted" &&
            mediaProcessingReady(rows, owner, String(e.id)) &&
            !rows.some(f=>f.type === "AikoMediaIngressFailed" && f.owner===owner && typeof f.runtimeFailureRef === "string" && !rows.some(t=>t.type === "AikoMediaRuntimeRepairSettled" && t.owner===owner && t.id===f.id)) &&
            e.owner === owner &&
            !rows.some(
              (x) =>
                x.owner === owner &&
                x.id === e.id &&
                [
                  "AikoMediaCompleted",
                  "AikoMediaCancelled",
                  "AikoMediaIngressFailed",
                ].includes(x.type),
            ),
        )
        .slice(0, 1)
        .map((e) =>
          effect({
            key: `aiko-media:${owner}:AikoMediaCompleted:${e.id}`,
            input: e,
            act: (e, signal) =>
              Effect.gen(function* () {
                const self = yield* Self;
                const log = yield* EventLog;
                if (self.actor !== "aiko" || self.thread !== library.thread)
                  throw Error("Media host thread denied");
                return yield* Effect.promise(async () => {
                  try {
                    const row = await retained({
                      owner,
                      channel: String(e.channel),
                      operationId: String(e.id),
                      contentRef: e.contentRef as HarnessDigest,
                    });
                    const admitted = (await journal.read()).some(x => x.type === "AikoMediaAccepted" && x.owner === owner && x.id === e.id);
                    if (row.deadline <= Date.now()) {
                      if (!admitted) throw Error("Media deadline expired");
                      return [{type:"AikoMediaCompleted", owner, id:e.id, channel:row.channel, contentRef:row.contentRef, status:"unavailable", reason:"media-deadline-expired", at:Date.now()}];
                    }
                    const deadline = AbortSignal.any([signal, AbortSignal.timeout(row.deadline - Date.now())]);
                    const p = await prepare(deadline, true);
                    const { delivery, grant, ...input } = row;
                    if (!admitted) await p.admit(input, deadline);
                    const output = deriveComponent(
                      p.component,
                      await journal.read(),
                    );
                    const completed: Event[] = [];
                    for (const transition of output.transitions) {
                      if (transition.kind !== "effect")
                        throw Error("Unexpected media transition");
                      if ((transition.input as Event).id !== e.id) continue;
                      const events = await Effect.runPromise(
                        transition
                          .act(transition.input, deadline)
                          .pipe(
                            Effect.provideService(Self, self),
                            Effect.provideService(EventLog, log),
                          ),
                      );
                      completed.push(...events);
                    }
                    return completed;
                  } catch (error) {
                    // Once processing was admitted, retained effects may be
                    // uncertain. A later missing runtime cannot justify replay.
                    const beforeProcessing = !(await journal.read()).some(x=>x.type === "AikoMediaAccepted" && x.owner===owner && x.id===e.id);
                    return [
                      {
                        type: "AikoMediaIngressFailed",
                        owner,
                        id: e.id,
                        at: Date.now(),
                        reason: "media-processing-unavailable-or-unconfirmed",
                        ...(error instanceof DefiniteComputeRuntimeFailure && beforeProcessing ? {runtimeFailureRef:error.failureRef} : {}),
                      },
                    ];
                  }
                });
              }),
          }),
        ),
      ],
    }),
  });
  const inference = (base: Layer.Layer<Infer>) =>
    Layer.effect(
      Infer,
      Effect.gen(function* () {
        const binding = yield* Infer;
        return {
          ...binding,
          react: (request: InferRequest, k?: string, s?: AbortSignal) =>
            Effect.gen(function* () {
              const signal = s ?? new AbortController().signal;
              // Complete only the current admitted video turn. Historical media
              // messages cannot hijack a later user request. Output hydration
              // rechecks the same current grant and retained delivery scope.
              const currentMessage = request.trajectory.find(e => e.type === "MessageReceived" && e.id === request.identity.turn);
              if (currentMessage && typeof currentMessage.mediaOperationId === "string") {
                const scope = {owner, channel: String(currentMessage.channel), operationId: currentMessage.mediaOperationId, contentRef: currentMessage.mediaContentRef as HarnessDigest};
                const admission = yield* Effect.promise(() => retained(scope));
                if (admission.mimeType.startsWith("video/")) {
                  const output = yield* Effect.promise(async () => {
                    const proc = await prepare(signal);
                    const result = await proc.readResult(scope, signal);
                    const hydrate = async (name: string) => {
                      const stage = result?.stages.find(s => s.name === name && s.status === "satisfied");
                      return stage?.operationId ? (await proc.readOutput(scope, stage.operationId, signal)).output : undefined;
                    };
                    const semantic = await hydrate("media.video.crossing"), frames = await hydrate("media.frames");
                    if (!await authorize(scope)) throw Error("Video reply authority changed");
                    signal.throwIfAborted();
                    return renderVerifiedVideoFinding(semantic, frames);
                  });
                  return {kind: "complete" as const, output};
                }
              }
              const trajectory: Event[] = [];
              for (const event of request.trajectory) {
                if (
                  event.type !== "MessageReceived" ||
                  typeof event.mediaOperationId !== "string"
                ) {
                  trajectory.push(event);
                  continue;
                }
                const scope = {
                  owner,
                  channel: String(event.channel),
                  operationId: event.mediaOperationId,
                  contentRef: event.mediaContentRef as HarnessDigest,
                };
                const hydrated = yield* Effect.promise(async () => {
                  const proc = await prepare(signal);
                  const input = await proc.hydrateInput(scope, signal);
                  const outputs = [];
                  for (const stage of input.result?.stages ?? [])
                    if (stage.operationId && stage.outputRef)
                      outputs.push(
                        await proc.readOutput(scope, stage.operationId, signal),
                      );
                  return { ...input, outputs };
                });
                trajectory.push({ ...event, text: JSON.stringify(hydrated) });
              }
              return yield* binding.react({ ...request, trajectory }, k, s);
            }),
        };
      }),
    ).pipe(Layer.provide(base));
  const template = createMediaProcessing({
    library,
    definitions: [],
    journal,
    authorize: async () => false,
  });
  const tools = template.tools.map((t) => ({
    ...t,
    run: (raw: unknown, ctx: any) =>
      Effect.gen(function* () {
        const p = yield* Effect.promise((s) => prepare(s));
        return yield* p.tools
          .find((x) => x.spec.name === t.spec.name)!
          .run(raw, ctx);
      }),
  }));
  return {
    component: native,
    tools,
    admit,
    supports,
    nextWake: async () => mediaProcessingNextWake(await journal.read(), owner),
    inference,
    prepare,
    publishCatalog,
  };
}

/** Authenticated hosts call this after their ordinary owner/write admission. */
export async function mediaIngressApi(
  request: Request,
  owner: string,
  media: MediaHost | undefined,
  wake: () => void | Promise<void>,
): Promise<Response> {
  if (!media)
    return Response.json(
      { error: "isolated_media_not_configured" },
      { status: 503 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "json_required" }, { status: 415 });
  try {
    const { boundedText } = await import("./security.ts");
    const body = JSON.parse(
      await boundedText(new Response(request.body), 12 * 1024 * 1024),
    );
    if (new URL(request.url).pathname === "/api/media/catalog") {
      if (
        !body ||
        Object.keys(body).join(",") !== "variant" ||
        body.variant !== "multilingual"
      )
        throw Error("Untrusted media variant");
      return Response.json(await media.publishCatalog());
    }
    if (
      !body ||
      !["id,media,text", "id,language,media,text"].includes(
        Object.keys(body).sort().join(","),
      ) ||
      typeof body.id !== "string" ||
      !/^[-A-Za-z0-9_]{8,80}$/.test(body.id) ||
      typeof body.text !== "string" ||
      body.text.length > 4000 ||
      !body.media ||
      Object.keys(body.media).sort().join(",") !== "data,mimeType" ||
      typeof body.media.data !== "string" ||
      typeof body.media.mimeType !== "string"
    )
      throw Error("invalid");
    const bytes = Buffer.from(body.media.data, "base64");
    if (
      !bytes.length ||
      bytes.length > 8 * 1024 * 1024 ||
      bytes.toString("base64") !== body.media.data
    )
      throw Error("invalid");
    if (!media.supports(body.media.mimeType))
      return Response.json({ error: "unsupported_media" }, { status: 415 });
    const result = await media.admit({
      owner,
      operationId: `media:${body.id}`,
      channel: "api",
      bytes,
      prompt: body.text,
      mimeType: body.media.mimeType,
      ...(body.language !== undefined ? { language: body.language } : {}),
      delivery: { source: "api" },
    });
    await wake();
    return Response.json(result, { status: 202 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error && error.message.includes("conflict")
            ? "media_identity_conflict"
            : "media_admission_unavailable",
      },
      {
        status:
          error instanceof Error && error.message.includes("conflict")
            ? 409
            : 400,
      },
    );
  }
}

export async function telegramMediaAdmission(
  media: MediaHost | undefined,
  inbound: import("./telegram-normalize.ts").TelegramInbound,
  download: (
    owner: string,
    descriptor: import("./telegram-media.ts").TelegramMediaDescriptor,
    signal: AbortSignal,
  ) => Promise<{ bytes: Uint8Array; mimeType: string }>,
): Promise<boolean> {
  if (!media || inbound.secretary || inbound.media?.length !== 1) return false;
  const descriptor = inbound.media[0]!;
  const hint =
    descriptor.mimeType ??
    (descriptor.kind === "voice"
      ? "audio/ogg"
      : descriptor.kind === "video"
        ? "video/mp4"
        : "application/octet-stream");
  if (!media.supports(hint)) return false;
  const content = await download(
    inbound.user,
    descriptor,
    AbortSignal.timeout(45000),
  );
  await media.admit({
    owner: inbound.user,
    ...(inbound.language ? { language: inbound.language } : {}),
    channel: "telegram",
    operationId: `telegram:${inbound.update}`,
    bytes: content.bytes,
    prompt: inbound.caption ?? inbound.text,
    mimeType: media.supports(content.mimeType) ? content.mimeType : hint,
    delivery: {
      source: "telegram",
      chat: inbound.user,
      sender: inbound.user,
      ...(inbound.messageId
        ? {
            telegram: {
              messageId: inbound.messageId,
              ...(inbound.messageThreadId
                ? { messageThreadId: inbound.messageThreadId }
                : {}),
            },
          }
        : {}),
    },
  });
  return true;
}
