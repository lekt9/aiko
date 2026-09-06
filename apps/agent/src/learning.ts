import { createHash } from "node:crypto";
import {
  type Memory,
  MemoryError,
  validateRememberInput,
  validatePayload,
  type Json,
  type Observation,
  type Source,
  type SourceInput,
} from "entity-learn";
import { openMemory, type MemoryStoreBinding } from "./memory.ts";

export interface LearningInput {
  id: string;
  subject: string;
  title: string;
  kind: "entity" | "fact" | "episode" | "skill";
  type: string;
  payload: Json;
}
type Binding = MemoryStoreBinding;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const nativeSubject = (input: LearningInput) =>
  `learning/${encodeURIComponent(input.type)}/${encodeURIComponent(input.subject)}`;
const fields = ["id", "subject", "title", "kind", "type", "payload"];

/** Envelope checks plus the actual native memory admission policy; no parallel secret/JSON rules. */
export function validateLearningInput(raw: unknown): LearningInput | undefined {
  try {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Object.keys(raw).length !== fields.length ||
      Object.keys(raw).some((key) => !fields.includes(key))
    )
      return;
    const input = raw as LearningInput;
    if (
      typeof input.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.id) ||
      typeof input.subject !== "string" ||
      !input.subject.trim() ||
      input.subject.length > 256 ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 500 ||
      typeof input.type !== "string" ||
      !input.type.trim() ||
      input.type.length > 80 ||
      !["entity", "fact", "episode", "skill"].includes(input.kind) ||
      nativeSubject(input).length > 512 ||
      Buffer.byteLength(JSON.stringify(raw)) > 24_000
    )
      return;
    // The core rejects non-plain/deep JSON, invalid text and credential-shaped data.
    validatePayload(input.id);
    const checked = validateRememberInput(
      {
        subject: input.subject,
        title: input.title,
        kind: input.kind,
        type: input.type,
        payload: input.payload,
      },
    );
    return {
      id: input.id,
      subject: checked.subject,
      title: checked.title,
      kind: checked.kind ?? "fact",
      type: checked.type,
      payload: checked.payload,
    };
  } catch {
    return;
  }
}

function redactPayload(value: Json, redact: (value: string) => string): Json {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactPayload(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactPayload(item, redact),
      ]),
    );
  return value;
}

/** A semantic leaf uses native payload bytes and metadata, excluding observation time and hook identity. */
function contentDigest(observation: Observation): string {
  return sha256(
    `aiko-learning-content/v1\n${JSON.stringify([
      observation.payloadDigest,
      observation.title,
      observation.kind,
      observation.type,
    ])}`,
  );
}

/** Complete only this host's durable registration, atomically checking for later revocation. */
function approveLearningSource(
  memory: Memory,
  source: Source,
  registerKey: string,
  approveKey: string,
  registrationVersion?: number,
) {
  memory.journal.commit(
    memory.scope,
    approveKey,
    {
      operation: "approve",
      id: source.id,
      revision: source.revision,
      enabled: true,
    },
    (requestDigest) => {
      const current = memory.journal.source(memory.scope, source.id);
      if (!current || current.revision !== source.revision)
        throw new MemoryError(
          "source_changed",
          "Learning source changed before approval",
        );
      // Fresh registration can prove that no other write intervened without loading history.
      // Recovery uses the native journal because Source alone cannot distinguish an unapproved
      // registration from an explicit revoke with otherwise identical fields.
      if (
        registrationVersion === undefined ||
        memory.journal.scopeVersion(memory.scope) !== registrationVersion
      ) {
        const last = memory.journal
          .events(memory.scope)
          .findLast(({ event }) => event.source?.id === source.id);
        if (
          last?.event.operation !== "source" ||
          last.event.key !== registerKey ||
          last.event.source?.revision !== source.revision
        )
          throw new MemoryError(
            "source_disabled",
            "Learning source was revoked or quarantined",
          );
      }
      // This is the native approveSource event, committed under its normal replay key and
      // native storage transaction. A concurrent revoke cannot fit between the check and write.
      return {
        version: 1,
        scope: memory.scope,
        key: approveKey,
        requestDigest,
        recordedAt: memory.now(),
        operation: "source",
        observations: [],
        source: { ...current, enabled: true, failures: 0, error: null },
      };
    },
  );
  // A replayed approval receipt never overrides a later administrative revocation.
  const approved = memory.journal.source(memory.scope, source.id);
  if (!approved?.enabled || approved.revision !== source.revision)
    throw new MemoryError(
      "source_disabled",
      "Learning source requires host reapproval",
    );
}

/** Host-delivered evidence enters the same native source normalization and scoped journal as other tools. */
export async function indexLearning(
  binding: Binding,
  value: LearningInput,
  redact: (value: string) => string,
): Promise<{
  observation: string;
  subject: string;
  digest: string;
  changed: boolean;
}> {
  const validated = validateLearningInput(value);
  if (!validated)
    throw new MemoryError("invalid_input", "Invalid learning evidence");
  // Identity must stay fixed across recovery. Sensitive identifiers are refused, never silently renamed.
  if (
    [validated.id, validated.subject, validated.type].some(
      (part) => redact(part) !== part,
    )
  )
    throw new MemoryError(
      "sensitive_material",
      "Learning identity contains sensitive material",
    );
  const input = validateLearningInput({
    ...validated,
    title: redact(validated.title),
    payload: redactPayload(validated.payload, redact),
  });
  if (!input)
    throw new MemoryError(
      "invalid_input",
      "Invalid redacted learning evidence",
    );
  const identity = sha256(input.subject);
  const sourceId = `learning-${identity}`;
  const locator = `aiko-learning:${identity}`;
  const recipe: SourceInput = {
    id: sourceId,
    namespace: "learning",
    type: input.type,
    kind: input.kind,
    resolver: "adapter",
    locator,
    format: "json",
    ttlSeconds: 31_536_000,
    schema: { id: "id", title: "title" },
  };
  const recipeKey = sha256(JSON.stringify([recipe, input.id]));
  const registerKey = `learning-register:${sourceId}:${recipeKey}`;
  const approveKey = `learning-approve:${sourceId}:${recipeKey}`;
  let predecessor: string | undefined;
  const memory = openMemory(binding, {
    [locator]: async (source, context) => {
      context.signal.throwIfAborted();
      if (
        source.id !== sourceId ||
        source.locator !== locator ||
        source.namespace !== "learning" ||
        source.type !== input.type ||
        source.kind !== input.kind ||
        source.schema?.id !== "id" ||
        source.schema?.title !== "title"
      )
        throw new MemoryError("adapter_mismatch", "Unexpected learning source");
      return {
        data: [{ id: input.subject, title: input.title, data: input.payload }],
        // Persist the immediately preceding evidence in native provenance, so retries preserve change detection.
        producer: {
          kind: "tool",
          reference: `aiko-learning:${input.id}#previous=${predecessor ?? "none"}`,
        },
      };
    },
  });
  try {
    const previous = memory.journal.source(memory.scope, sourceId);
    if (previous && !previous.enabled) {
      if (
        previous.type !== recipe.type ||
        previous.kind !== recipe.kind ||
        previous.locator !== recipe.locator ||
        previous.namespace !== recipe.namespace
      )
        throw new MemoryError(
          "source_disabled",
          "Learning source requires host reapproval",
        );
      approveLearningSource(memory, previous, registerKey, approveKey);
    }
    if (previous) {
      const priorHead = memory.journal.head(
        memory.scope,
        nativeSubject({ ...input, type: previous.type }),
      );
      const priorHit = priorHead && memory.get(priorHead.id);
      if (priorHit?.state === "current") predecessor = priorHit.observation.id;
    }
    if (
      !previous ||
      previous.type !== recipe.type ||
      previous.kind !== recipe.kind
    ) {
      const registrationVersion = memory.journal.scopeVersion(memory.scope) + 1;
      const registered = memory.registerSource(recipe, registerKey);
      approveLearningSource(
        memory,
        registered,
        registerKey,
        approveKey,
        registrationVersion,
      );
    }
    const refreshed = await memory.refresh(sourceId, {
      key: `learning-read:${sha256(input.id)}`,
      maxBytes: 32_000,
      timeoutMs: 5_000,
    });
    if (refreshed.error)
      throw new MemoryError(refreshed.error, "Learning observation failed");
    const observation =
      refreshed.observations.length === 1
        ? memory.get(refreshed.observations[0])?.observation
        : undefined;
    if (!observation)
      throw new MemoryError(
        "evidence_unavailable",
        "Learning evidence is suppressed or unavailable",
      );
    const digest = contentDigest(observation);
    const previousId = /#previous=(obs_[a-f0-9]{64}|none)$/.exec(
      observation.producer.evidenceReference ?? "",
    )?.[1];
    const prior =
      previousId && previousId !== "none"
        ? memory.get(previousId)?.observation
        : undefined;
    return {
      observation: observation.id,
      subject: observation.subject,
      digest,
      changed: !prior || contentDigest(prior) !== digest,
    };
  } finally {
    memory.close();
  }
}

export interface MemorySnapshot {
  root: string;
  leaves: {
    subject: string;
    observation: string;
    digest: string;
    title: string;
    kind: string;
  }[];
  /** Completeness describes the accessible recorded corpus, never unobserved external state. */
  complete: boolean;
}

/** Raw log windows stay available to ordinary recall as context, outside the semantic change root. */
function rawLogEpisode(
  observation: Observation,
  source: Source | undefined,
): boolean {
  if (observation.kind !== "episode" || observation.type !== "event" || !source)
    return false;
  return (
    (source.namespace.startsWith("tardigrade/") &&
      source.locator.startsWith("tdg-log:")) ||
    source.namespace === "logs" ||
    source.namespace.startsWith("logs/")
  );
}

/** Bounded native heads, not copied storage or an invented entity extractor. */
export function memorySnapshot(binding: Binding): MemorySnapshot {
  const memory = openMemory(binding);
  try {
    const before = memory.journal.scopeVersion(memory.scope);
    // Independent kind scans prevent raw conversation events from displacing semantic entities.
    // Episodes have a separate context-scan budget because the native library cannot filter by producer.
    const groups = ["entity", "fact", "skill"].map((kind) =>
      memory.journal.candidates(memory.scope, { kind, cap: 257 }),
    );
    const episodes = memory.journal.candidates(memory.scope, {
      kind: "episode",
      cap: 4097,
    });
    const sourceCache = new Map<string, Source | undefined>();
    const sourceFor = (observation: Observation) => {
      const id = observation.producer.sourceId;
      if (!id) return undefined;
      if (!sourceCache.has(id))
        sourceCache.set(id, memory.journal.source(memory.scope, id));
      return sourceCache.get(id);
    };
    const candidates = [...groups.flat(), ...episodes.slice(0, 4096)]
      .filter(
        (observation) => !rawLogEpisode(observation, sourceFor(observation)),
      )
      .sort(
        (a, b) =>
          b.recordedAt - a.recordedAt || a.subject.localeCompare(b.subject),
      );
    const admitted = candidates.flatMap((candidate) => {
      const hit = memory.get(candidate.id);
      if (!hit || hit.state !== "current") return [];
      const observation = hit.observation;
      return [
        {
          subject: observation.subject,
          observation: observation.id,
          digest: contentDigest(observation),
          title: observation.title,
          kind: observation.kind,
        },
      ];
    });
    const leaves = admitted
      .slice(0, 256)
      .sort((a, b) =>
        a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
      );
    let level = leaves.map((leaf) =>
      sha256(
        `aiko-memory-leaf/v1\n${JSON.stringify([leaf.subject, leaf.digest])}`,
      ),
    );
    if (!level.length) level = [sha256("aiko-memory-empty/v1")];
    while (level.length > 1) {
      const parents: string[] = [];
      for (let index = 0; index < level.length; index += 2)
        parents.push(
          sha256(
            `aiko-memory-node/v1\n${level[index]}\n${level[index + 1] ?? level[index]}`,
          ),
        );
      level = parents;
    }
    return {
      root: level[0],
      leaves,
      complete:
        groups.every((group) => group.length <= 256) &&
        episodes.length <= 4096 &&
        admitted.length <= 256 &&
        before === memory.journal.scopeVersion(memory.scope),
    };
  } finally {
    memory.close();
  }
}
