import { Effect } from "effect";
import { workCommandLanguage } from "../../../packages/protocol/src/secretary-language.ts";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
import { boundedText } from "./security.ts";
import {
  contactForWork,
  type SecretaryWorkBinding,
} from "./secretary-policy.ts";
import { pair, secretaryState } from "./secretary-state.ts";
import type { BunHost } from "tardie/bun/host";
import type { MemoryBinding } from "./memory.ts";
import type { secretaryTelegram } from "./secretary-telegram.ts";
import {
  proactivePreferences,
  validateProactivePreferences,
} from "./proactive-policy.ts";
import { harnessDigest } from "./harness-library.ts";
import {
  createWork,
  planDigest,
  saveWork,
  workDigest,
  workEvent,
  workEvaluationFailure,
  WorkError,
  workState,
  workTerminal,
  workText,
  workTime,
  workView,
  type Commitment,
} from "./commitments.ts";

export function createSecretaryWorkBinding(
  host: Pick<BunHost, "read" | "seed" | "commitRoot" | "self">,
  memory: MemoryBinding,
  telegram?: ReturnType<typeof secretaryTelegram>,
): SecretaryWorkBinding {
  return {
    owner: memory.owner,
    thread: memory.thread,
    memory,
    telegram,
    read: () => host.read(memory.thread),
    append: async (rows) => {
      if (rows.length === 1)
        await host.commitRoot(host.self(memory.thread), rows[0]);
      else await host.seed(memory.thread, rows);
    },
    readSecretary: () => host.read("secretary-" + memory.owner),
  };
}

export async function secretaryWorkView(binding: SecretaryWorkBinding) {
  const [events, contactEvents] = await Promise.all([
    binding.read(),
    binding.readSecretary(),
  ]);
  const contacts = secretaryState(contactEvents),
    state = workState(events, binding.owner);
  const chats = new Map<
    string,
    { connectionId: string; chat: string; name: string }
  >();
  for (const m of contacts.messages.values()) {
    if (m.chatType === "private" && m.chat !== binding.owner)
      chats.set(pair(m.connectionId, m.chat), {
        connectionId: m.connectionId,
        chat: m.chat,
        name: m.name,
      });
  }
  return {
    ...workView(events, binding.owner, binding.now?.()),
    attention: proactivePreferences(events, binding.owner),
    contacts: [...chats.entries()].map(([key, c]) => ({
      ...c,
      enabled:
        contacts.grants.get(key)?.enabled === true &&
        contacts.connections.get(c.connectionId)?.canReply === true,
      handling: state.contactHandling.get(key) ?? "aiko",
      handlingRevision:
        events.findLast(
          (e) =>
            e.type === "AikoWorkContactHandling" &&
            e.owner === binding.owner &&
            e.connectionId === c.connectionId &&
            e.chat === c.chat,
        )?.id ?? null,
    })),
  };
}

/** Called only by authenticated owner surfaces, or by the limited model preparation tool below. */
export async function applyWorkCommand(
  binding: SecretaryWorkBinding,
  raw: unknown,
  source: { trusted: boolean; ref: string },
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new WorkError("Invalid work command");
  const input = raw as Record<string, unknown>,
    now = binding.now?.() ?? Date.now();
  const operationId = workText(input.operationId, "operation id", 128),
    digest = workDigest(input);
  if (binding.memory.redact(JSON.stringify(input)) !== JSON.stringify(input))
    throw new WorkError("Remove sensitive material from work details");
  const events = await binding.read();
  if (input.action === "attention") {
    if (!source.trusted)
      throw new WorkError(
        "Notification preferences require an owner instruction",
        403,
      );
    const preferences = validateProactivePreferences(input.preferences),
      preferencesDigest = harnessDigest(preferences);
    const prior = events.find(
      (e) =>
        e.type === "AikoProactivePreferencesSet" &&
        e.owner === binding.owner &&
        e.id === operationId,
    );
    if (prior) {
      if (prior.preferencesDigest !== preferencesDigest)
        throw new WorkError("Operation id already used", 409);
      return {
        status: "duplicate",
        message:
          "That preference change was already recorded. Your current settings are shown below.",
      };
    }
    if (
      proactivePreferences(events, binding.owner).revision !==
      input.expectedRevision
    )
      throw new WorkError("Preferences changed; refresh", 409);
    await binding.append([
      workEvent(
        "AikoProactivePreferencesSet",
        {
          owner: binding.owner,
          id: operationId,
          previousRevision: input.expectedRevision,
          preferences,
          preferencesDigest,
        },
        now,
      ),
    ]);
    return {
      status: "saved",
      message: preferences.enabled
        ? "I’ve saved when you want updates. Decisions will still be available in Needs you."
        : "I’ve switched proactive updates off. You can still check decisions in Needs you.",
    };
  }
  const prior = events.find(
    (e) =>
      e.owner === binding.owner &&
      e.operationId === operationId &&
      ["AikoWorkTransition", "AikoWorkContactHandling"].includes(e.type),
  );
  if (prior) {
    if (prior.commandDigest !== digest)
      throw new WorkError("Operation id already used for another change", 409);
    return {
      status: "duplicate",
      message:
        "That change was already recorded. The current work is shown below.",
      work: workState(events, binding.owner).commitments.get(String(prior.id)),
    };
  }
  if (input.action === "contact") {
    if (!source.trusted && input.handling !== "owner")
      throw new WorkError("Only the owner can hand back a contact", 403);
    const connectionId = workText(input.connectionId, "connection", 256),
      chat = workText(input.chat, "contact", 32);
    const contacts = secretaryState(await binding.readSecretary());
    if (
      contacts.connections.get(connectionId)?.owner !== binding.owner ||
      ![...contacts.messages.values()].some(
        (m) =>
          m.connectionId === connectionId &&
          m.chat === chat &&
          m.chatType === "private",
      )
    )
      throw new WorkError("Contact not found", 404);
    if (!["owner", "aiko"].includes(String(input.handling)))
      throw new WorkError("Invalid handling");
    const last = events.findLast(
      (e) =>
        e.owner === binding.owner &&
        e.type === "AikoWorkContactHandling" &&
        e.connectionId === connectionId &&
        e.chat === chat,
    );
    if ((last?.id ?? null) !== input.expectedRevision)
      throw new WorkError("Contact changed; refresh", 409);
    await binding.append([
      workEvent(
        "AikoWorkContactHandling",
        {
          owner: binding.owner,
          id: operationId,
          operationId,
          commandDigest: digest,
          connectionId,
          chat,
          handling: input.handling,
          previousId: last?.id ?? null,
        },
        now,
      ),
    ]);
    return {
      status: "changed",
      message:
        input.handling === "owner"
          ? "You’re handling this contact. I won’t start another reply until you hand it back. A reply already in flight may still arrive."
          : "You’ve handed this contact back. I’ll check the current permissions before replying; this doesn’t restart paused work.",
    };
  }
  let w: Commitment, previous: number;
  const state = workState(events, binding.owner);
  if (input.action === "capture") {
    if (
      state.commitments.size >= 500 ||
      [...state.commitments.values()].filter((w) => !workTerminal(w)).length >=
        100
    )
      throw new WorkError("Work ledger capacity reached", 409);
    w = createWork(binding.owner, input, source.ref, source.trusted, now);
    previous = 0;
    if (
      w.plan &&
      !contactForWork(await binding.readSecretary(), binding.owner, w)
    )
      throw new WorkError("Choose a connected, observed contact", 409);
  } else {
    const existing = state.commitments.get(workText(input.id, "work id", 128));
    if (!existing) throw new WorkError("Work not found", 404);
    if (existing.version !== input.expectedVersion)
      throw new WorkError("Work changed; refresh and try again", 409);
    previous = existing.version;
    w = structuredClone(existing);
    w.version++;
    w.updatedAt = now;
    if (input.action === "decide") {
      if (!source.trusted)
        throw new WorkError("Only the owner can approve a decision", 403);
      const d = w.decision;
      if (
        !d ||
        d.status !== "pending" ||
        input.decisionId !== d.id ||
        input.planDigest !== d.planDigest ||
        d.planDigest !== planDigest(w) ||
        now >= d.expiresAt ||
        w.control !== "active" ||
        w.handling !== "aiko"
      )
        throw new WorkError(
          "Decision expired, paused or changed; refresh",
          409,
        );
      if (input.choice === "approve") {
        if (d.kind === "review" && w.status !== "candidate")
          throw new WorkError("Choose a later review, take over, or confirm completion. This decision does not authorize another message.", 409);
        if (d.kind === "authorize") {
          const c = contactForWork(
            await binding.readSecretary(),
            binding.owner,
            w,
          );
          if (
            !c?.grant?.enabled ||
            !c.connection.enabled ||
            !c.connection.canReply ||
            !c.incoming ||
            now - c.incoming.date * 1000 >= 86400000
          )
            throw new WorkError(
              "Current contact reply permission and a recent incoming message are required",
              409,
            );
          if (w.dueAt === null)
            throw new WorkError(
              "An agenda workflow needs an explicit deadline",
            );
          w.mandate = {
            planDigest: planDigest(w),
            grantId: c.grant.id,
            approvedAt: now,
            expiresAt: w.dueAt,
            sourceUpdateId: Math.max(
              0,
              ...(await binding.readSecretary())
                .filter((e) => e.type === "AikoSecretaryUpdate")
                .map((e) => Number(e.updateId)),
            ),
          };
          w.nextReviewAt = now;
        }
        w.status = "ready";
        w.acceptanceBasis = "ownerInstruction";
        w.nextAction = w.plan
          ? "Request the numbered agenda items"
          : d.recommendation;
        w.actionAssignee = "Aiko";
        d.status = "approved";
      } else if (input.choice === "decline") {
        d.status = "declined";
        w.handling = "owner";
        w.nextAction = "Waiting for your next instruction";
        w.actionAssignee = "You";
        delete w.mandate;
      } else throw new WorkError("Choose approve or decline");
    } else if (input.action === "change") {
      const change = String(input.change);
      if (!source.trusted && !["pause", "takeover", "cancel"].includes(change))
        throw new WorkError("This change needs an owner decision", 403);
      if (workTerminal(w) && !["reopen", "retry"].includes(change))
        throw new WorkError("Reopen this work before changing it", 409);
      if (change === "retry") {
        if (!workEvaluationFailure(events, { ...w, version: previous }))
          throw new WorkError("No failed check remains on this version", 409);
      } else if (change === "pause") {
        w.control = "paused";
        w.suspensionReason = workText(
          input.reason ?? "Paused by you",
          "pause reason",
        );
        w.resumeWhen = "Explicit owner instruction";
      } else if (change === "resume") {
        if (w.status === "candidate" && w.decision?.status !== "pending")
          throw new WorkError(
            "Edit this proposal and its dates before authorizing it again",
            409,
          );
        w.control = "active";
        w.handling = "aiko";
        delete w.suspensionReason;
        delete w.resumeWhen;
        w.nextReviewAt = now;
      } else if (change === "takeover") {
        w.handling = "owner";
        w.actionAssignee = "You";
      } else if (change === "cancel") {
        w.status = "cancelled";
        w.nextAction = "Withdrawn";
        delete w.mandate;
      } else if (change === "complete") {
        w.status = "completed";
        w.evidenceRefs = [...w.evidenceRefs, source.ref];
        w.preparationNote = workText(
          input.evidence,
          "completion evidence",
          4000,
        );
        w.coverage = "Completion confirmed by the authenticated owner.";
        w.nextAction = "Completed";
      } else if (change === "reopen") {
        w.status = "waiting";
        w.waitingFor = w.accountableParty;
        w.nextReviewAt = workTime(input.nextReviewAt, "next review");
        if (w.nextReviewAt <= now)
          throw new WorkError("Choose a future review time");
        w.nextAction = "Review the reopened obligation";
        const contact = contactForWork(
          await binding.readSecretary(),
          binding.owner,
          w,
        );
        w.evidenceAfterMessageId = Math.max(
          0,
          ...(contact?.messages.map((m) => m.messageId) ?? []),
        );
        delete w.preparationNote;
        delete w.evidenceMessageId;
        w.evidenceRefs = [];
        delete w.mandate;
      } else if (change === "review") {
        w.nextReviewAt = workTime(input.nextReviewAt, "next review");
        if (w.nextReviewAt <= now)
          throw new WorkError("Choose a future review time");
        w.waitingFor = workText(
          input.waitingFor ?? w.accountableParty,
          "waiting for",
          200,
        );
        w.nextAction = workText(
          input.nextAction ?? "Review the outstanding dependency",
          "next step",
        );
        w.status = "waiting";
        delete w.mandate;
      } else if (change === "edit") {
        if ([...state.receipts.values()].some((r) => r.workId === w.id))
          throw new WorkError(
            "This workflow already has an execution receipt. Cancel it and prepare new work.",
            409,
          );
        const replacement = createWork(
          binding.owner,
          { ...input, id: w.id },
          source.ref,
          true,
          now,
        );
        w = {
          ...replacement,
          version: w.version,
          createdAt: w.createdAt,
          sourceRefs: [...w.sourceRefs, source.ref],
        };
      } else throw new WorkError("Unsupported change");
      if (
        !["edit", "pause", "resume", "retry"].includes(change) &&
        w.decision?.status === "pending"
      )
        w.decision.status = "superseded";
    } else throw new WorkError("Unsupported work command");
  }
  // Bind replay identity to the exact submitted command, not a later clock or inferred payload.
  const journal = {
    read: binding.read,
    append: (rows: import("tardie/core/event").Event[]) =>
      binding.append(rows.map((e) => ({ ...e, commandDigest: digest }))),
  };
  await saveWork(journal, w, previous, operationId);
  const message = workCommandLanguage(
    String(input.action),
    typeof input.change === "string" ? input.change : undefined,
    w,
    [...workState(await binding.read(), binding.owner).receipts.values()],
  );
  return { status: "saved", work: w, message };
}

export async function secretaryWorkApi(
  request: Request,
  binding: SecretaryWorkBinding,
  wake: () => void | Promise<void>,
) {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (request.method === "GET") return json(await secretaryWorkView(binding));
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const input = JSON.parse(
      await boundedText(new Response(request.body), 16384),
    );
    const result = await applyWorkCommand(binding, input, {
      trusted: true,
      ref: "owner:" + String(input.operationId),
    });
    await wake();
    return json(result);
  } catch (e) {
    return json(
      { error: e instanceof WorkError ? e.message : "I couldn’t confirm whether that change was saved. Refresh the work before trying again." },
      e instanceof WorkError ? e.status : 400,
    );
  }
}

const string = { type: "string" },
  timestamp = {
    type: "integer",
    description:
      "Epoch milliseconds; resolve the owner's time zone explicitly.",
  };
export function secretaryWorkTools(
  binding: SecretaryWorkBinding,
): NativeTool<Self | EventLog>[] {
  const specs = [
    {
      name: "commitment_list",
      description:
        "Read the owner's commitments, decisions, waiting list, preparation notes and observed contacts. Does not send anything.",
      properties: {},
      required: [],
    },
    {
      name: "commitment_capture",
      description:
        "Capture an outcome and next review in the durable owner ledger. Inferences remain candidates. An agenda workflow prepares an exact request and one reminder for owner approval; it cannot authorize itself.",
      properties: {
        id: string,
        operationId: string,
        outcome: string,
        successCondition: string,
        accountableParty: string,
        nextAction: string,
        actionAssignee: string,
        dependencyRefs: { type: "array", items: string, maxItems: 32 },
        dueAt: {
          ...timestamp,
          type: ["integer", "null"],
          description:
            "Explicit deadline in epoch milliseconds, or null if unknown. Never invent a deadline.",
        },
        timeZone: string,
        nextReviewAt: timestamp,
        plan: {
          type: "object",
          properties: {
            kind: { const: "agenda" },
            connectionId: string,
            chat: string,
            contactName: string,
            count: { type: "integer", minimum: 1, maximum: 10 },
            requestText: string,
            reminderText: string,
            reminderAt: timestamp,
            escalateAt: timestamp,
          },
          required: [
            "kind",
            "connectionId",
            "chat",
            "contactName",
            "count",
            "requestText",
            "reminderText",
            "reminderAt",
            "escalateAt",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "id",
        "operationId",
        "outcome",
        "successCondition",
        "accountableParty",
        "nextAction",
        "timeZone",
      ],
    },
    {
      name: "commitment_contact_takeover",
      description:
        "When the owner says they will handle a contact, stop future automatic replies to that observed contact until explicit hand-back. Read commitment_list first to resolve the exact contact and handlingRevision. Does not resume, approve or send anything.",
      properties: {
        connectionId: string,
        chat: string,
        operationId: string,
        expectedRevision: { type: ["string", "null"] },
      },
      required: ["connectionId", "chat", "operationId", "expectedRevision"],
    },
    {
      name: "commitment_change",
      description:
        "Pause, take over or cancel work when the owner requests it. Resuming, approving, editing and confirming completion use the owner work surface.",
      properties: {
        id: string,
        operationId: string,
        expectedVersion: { type: "integer" },
        change: { enum: ["pause", "takeover", "cancel"] },
        reason: string,
      },
      required: ["id", "operationId", "expectedVersion", "change"],
    },
  ];
  return specs.map((spec) => ({
    spec: {
      name: spec.name,
      description: spec.description,
      inputSchema: {
        type: "object",
        properties: spec.properties,
        required: spec.required,
        additionalProperties: false,
      },
    },
    run: (raw, ctx) =>
      Effect.gen(function* () {
        const self = yield* Self;
        if (
          self.actor !== "aiko" ||
          self.thread !== binding.thread ||
          self.thread !== "user-" + binding.owner
        )
          return { status: "rejected", reason: "owner_scope" };
        if (spec.name === "commitment_list")
          return yield* Effect.promise(() => secretaryWorkView(binding));
        const rows = yield* Effect.promise(binding.read);
        const message = rows.find(
          (e) => e.type === "MessageReceived" && e.id === ctx.turn,
        );
        const ownerInput =
          message &&
          ["telegram", "plane", "local"].includes(String(message.source)) &&
          (message.source !== "telegram" ||
            (String(message.sender) === binding.owner &&
              String(message.chat) === binding.owner));
        if (!ownerInput)
          return {
            status: "rejected",
            reason:
              "A current owner request is required; external observations and scheduled wakes cannot create authority",
          };
        try {
          return yield* Effect.tryPromise(() =>
            applyWorkCommand(
              binding,
              {
                ...(raw as object),
                action:
                  spec.name === "commitment_capture"
                    ? "capture"
                    : spec.name === "commitment_contact_takeover"
                      ? "contact"
                      : "change",
                ...(spec.name === "commitment_contact_takeover"
                  ? { handling: "owner" }
                  : {}),
              },
              { trusted: false, ref: String(message.id) },
            ),
          );
        } catch {
          return { status: "rejected", reason: "Invalid work request" };
        }
      }).pipe(
        Effect.catch((e) =>
          Effect.succeed({
            status: "rejected",
            reason:
              e instanceof WorkError ? e.message : "Could not update work",
          }),
        ),
      ),
  }));
}
