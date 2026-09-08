import { Effect } from "effect";
import type { InferRequest } from "tardie/inference/contract";
import { renderMessages } from "tardie/projection/messages";
import { usageFrom } from "tardie/inference/usage";
import type { HarnessBlobStore, HarnessDigest } from "./harness-library.ts";
import { boundedText, type HttpFetch } from "./security.ts";

export type CompactionIdentity = InferRequest["identity"];
export type CompactRequest = Pick<
  InferRequest,
  "trajectory" | "identity" | "model" | "system" | "tools"
> & { previous?: unknown };
type Scope = {
  owner: string;
  actor: string;
  instance: string;
  thread: string;
  provider: string;
  model: string;
};
export type ProviderCompactionState = Scope & {
  kind: "aiko-provider-compaction.v1";
  ref: HarnessDigest;
};
export interface CompactionCustody {
  blobs?: HarnessBlobStore;
  current?(identity: CompactionIdentity): boolean | Promise<boolean>;
}
const scopeFor = (
  owner: string,
  identity: CompactionIdentity,
  model: { provider: string; model_id: string },
): Scope => ({
  owner,
  actor: identity.actor,
  instance: identity.instance,
  thread: identity.thread,
  provider: model.provider,
  model: model.model_id,
});
function compactedItems(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 1024 ||
    Buffer.byteLength(JSON.stringify(value)) > 262144 ||
    !value.some(
      (item) =>
        item?.type === "compaction" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    )
  )
    throw Error("Invalid provider compaction window");
  return value;
}
export async function hydrateProviderCompaction(
  state: unknown,
  owner: string,
  identity: CompactionIdentity,
  model: { provider: string; model_id: string },
  custody: CompactionCustody,
): Promise<unknown[]> {
  const expected = scopeFor(owner, identity, model),
    r = state as ProviderCompactionState;
  if (
    !custody.blobs ||
    !custody.current ||
    !(await custody.current(identity)) ||
    r?.kind !== "aiko-provider-compaction.v1" ||
    !/^sha256:[a-f0-9]{64}$/.test(r.ref) ||
    Object.entries(expected).some(([k, v]) => (r as any)[k] !== v)
  )
    throw Error("Provider compaction is outside current thread authority");
  const row = (await custody.blobs.get(owner, r.ref)) as any;
  if (
    row?.kind !== r.kind ||
    Object.entries(expected).some(([k, v]) => row[k] !== v) ||
    !(await custody.current(identity))
  )
    throw Error("Provider compaction custody is unavailable");
  return compactedItems(row.items);
}
/** Native checkpoint hook; https://developers.openai.com/api/docs/guides/compaction */
export function responsesCompactor(options: {
  owner: string;
  model: { provider: string; model_id: string };
  endpoint: string;
  transport: HttpFetch;
  custody: CompactionCustody;
}) {
  return (request: CompactRequest, key?: string, signal?: AbortSignal) =>
    Effect.promise(async () => {
      try {
        const { custody } = options;
        if (
          !custody.blobs ||
          !custody.current ||
          !(await custody.current(request.identity)) ||
          (request.model &&
            (request.model.provider !== options.model.provider ||
              request.model.model_id !== options.model.model_id))
        )
          return undefined;
        signal?.throwIfAborted();
        const input: unknown[] =
          request.previous === undefined
            ? []
            : await hydrateProviderCompaction(
                request.previous,
                options.owner,
                request.identity,
                options.model,
                custody,
              );
        // This is the same native transcript projection, preserving paired tool IDs.
        for (const message of renderMessages(request.trajectory, {
          messageRenderCap: 131072,
          resultRenderCap: 65536,
        })) {
          if (message.role === "tool")
            input.push({
              type: "function_call_output",
              call_id: message.toolCallId,
              output: message.content ?? "",
            });
          else {
            if (message.content)
              input.push({
                type: "message",
                role: message.role,
                content: message.content,
              });
            for (const call of message.toolCalls ?? [])
              input.push({
                type: "function_call",
                call_id: call.id,
                name: call.name,
                arguments: call.arguments,
              });
          }
        }
        const response = await options.transport(options.endpoint, {
          method: "POST",
          body: JSON.stringify({
            model: options.model.model_id,
            input,
            ...(request.system ? { instructions: request.system } : {}),
          }),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return undefined;
        }
        const result = JSON.parse(await boundedText(response, 524288));
        const items = compactedItems(result.output);
        signal?.throwIfAborted();
        if (!(await custody.current(request.identity))) return undefined;
        const scope = scopeFor(options.owner, request.identity, options.model);
        const ref = await custody.blobs.putPrivate(options.owner, {
          kind: "aiko-provider-compaction.v1",
          ...scope,
          items,
        });
        signal?.throwIfAborted();
        if (!(await custody.current(request.identity))) return undefined;
        return {
          state: { kind: "aiko-provider-compaction.v1", ...scope, ref },
          usage: usageFrom(result.usage, undefined, {
            provider: options.model.provider,
            model: options.model.model_id,
          }),
        };
      } catch {
        return undefined;
      }
    });
}
