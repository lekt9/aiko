/** UI contract fixture only: no native evaluation, model, provider, or webhook execution. */
import { createHash } from "node:crypto";
import type { ToolInspection, ToolOperation } from "../src/lib/saved-tools";
const digest = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const base = digest("saved-tools-fixture"),
  contract = digest("fixed-double-contract");
const original: ToolInspection = {
  digest: base,
  expectedGeneration: 1,
  artifact: {
    name: "Double a number",
    description: "Double the supplied number",
    runtime: "javascript",
    contractDigest: contract,
    entrypoint: "main.js",
    files: { "main.js": "return input.n * 2;" },
    sources: [
      { uri: "fixture:controlled-source", revision: "1", digest: base },
    ],
  },
  contract: {
    outcome: "Return twice the supplied number",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "number" }, note: { type: "string" } },
    },
    effect: "read",
  },
};
let tools = new Map([[base, original]]),
  active = base,
  generation = 1,
  unavailable = false,
  uncertain = false,
  conflict = false;
let operations: ToolOperation[] = [],
  calls: { operation: string; input: unknown }[] = [],
  evaluations: any[] = [];
const outputs = new Map<string, unknown>();
const reply = (result: unknown, status = 200) =>
  Response.json(
    status === 200
      ? { available: true, result }
      : { error: "fixture_operation_unavailable" },
    { status },
  );
export async function savedToolsFixtureApi(
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/preview/tools-state")
    return Response.json({ calls, operations, active, generation });
  if (url.pathname.startsWith("/preview/tools-")) {
    if (url.pathname.endsWith("reset")) {
      tools = new Map([[base, structuredClone(original)]]);
      active = base;
      generation = 1;
      unavailable = false;
      uncertain = false;
      conflict = false;
      operations = [];
      calls = [];
      evaluations = [];
      outputs.clear();
    }
    if (url.pathname.endsWith("uncertain")) uncertain = true;
    if (url.pathname.endsWith("conflict")) conflict = true;
    if (url.pathname.endsWith("unavailable")) unavailable = !unavailable;
    if (url.pathname.endsWith("settle")) {
      for (const op of operations)
        if (op.status === "unknown") {
          op.status = "satisfied";
          op.outputAvailable = true;
          outputs.set(op.operationId, {
            result: 18,
            note: "<img src=x onerror=alert(1)>",
          });
        }
    }
    return Response.json({ ok: true });
  }
  if (!url.pathname.startsWith("/api/harness/library")) return;
  if (request.headers.get("authorization") !== "tms watch-fixture-session")
    return reply(undefined, 401);
  if (unavailable) return reply(undefined, 503);
  const operation = url.pathname.slice("/api/harness/library".length);
  const input =
    request.method === "POST" ? ((await request.json()) as any) : undefined;
  calls.push({ operation, input });
  if (!operation)
    return reply({
      candidates: [...tools.values()].map((t) => ({
        harnessDigest: t.digest,
        contractDigest: contract,
        name: t.artifact.name,
        runtime: t.artifact.runtime,
      })),
      routes: [
        {
          type: "AikoHarnessPromoted",
          harnessDigest: active,
          name: original.artifact.name,
          generation,
        },
      ],
      operations,
      evaluations,
    });
  if (operation === "/inspect") {
    const found = tools.get(input.digest);
    return found
      ? reply({
          ...found,
          expectedGeneration: generation,
          route: {
            type: "AikoHarnessPromoted",
            harnessDigest: active,
            generation,
          },
        })
      : reply(undefined, 409);
  }
  if (operation === "/revise") {
    const previous = tools.get(input.predecessorDigest);
    if (!previous) return reply(undefined, 409);
    const next = {
      ...structuredClone(previous),
      artifact: { ...previous.artifact, ...input.changes },
    };
    next.digest = digest(JSON.stringify(next.artifact));
    tools.set(next.digest, next);
    return reply({
      status: "candidate",
      digest: next.digest,
      predecessorDigest: previous.digest,
    });
  }
  if (operation === "/evaluate") {
    const found = tools.get(input.digest);
    if (!found) return reply(undefined, 409);
    let evaluation = evaluations.find((e) => e.id === input.evaluationId);
    if (!evaluation) {
      evaluation = {
        id: input.evaluationId,
        harnessDigest: input.digest,
        eligible: !found.artifact.files["main.js"]!.includes("return 0"),
        witnessIds: ["development", "held-out"],
      };
      evaluations.push(evaluation);
    }
    return reply({
      status: evaluation.eligible ? "eligible" : "failed",
      digest: input.digest,
      evaluationId: input.evaluationId,
      evaluation,
    });
  }
  if (operation === "/promote") {
    if (conflict) {
      conflict = false;
      generation++;
      return reply(undefined, 409);
    }
    if (
      input.expectedGeneration !== generation ||
      !evaluations.some(
        (e) =>
          e.id === input.evaluationId &&
          e.harnessDigest === input.digest &&
          e.eligible,
      )
    )
      return reply(undefined, 409);
    active = input.digest;
    generation++;
    return reply({ status: "promoted", digest: active });
  }
  if (operation === "/recall")
    return reply(
      typeof input.input?.n === "number"
        ? { status: "available", digest: active }
        : { status: "unavailable" },
    );
  if (operation === "/run") {
    let found = operations.find((o) => o.operationId === input.operationId);
    if (!found) {
      found = {
        operationId: input.operationId,
        digest: input.digest,
        status: uncertain ? "unknown" : "satisfied",
        at: Date.now(),
        outputAvailable: !uncertain,
      };
      operations.push(found);
      if (!uncertain)
        outputs.set(found.operationId, {
          result: input.input.n * 2,
          note: "<img src=x onerror=alert(1)>",
        });
    }
    return found.status === "unknown"
      ? reply(undefined, 409)
      : reply({ ...found, outputRef: digest(found.operationId) });
  }
  if (operation === "/output") {
    const found = operations.find((o) => o.operationId === input.operationId);
    return found?.status === "satisfied"
      ? reply({
          status: "satisfied",
          operationId: found.operationId,
          output: outputs.get(found.operationId),
          freshness: "historical-operation",
        })
      : reply(undefined, 409);
  }
  return reply(undefined, 404);
}
