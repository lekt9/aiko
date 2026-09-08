import type {
  ChannelPublicIngressBindings,
  ChannelBridgeBindings,
  ChannelBridgeSpec,
} from "./channel-ingress.ts";
import type { HostedChannels } from "./channel-host.ts";
export type ProviderIngressLookup = ChannelPublicIngressBindings["lookup"];
export type ProviderBridgeFactory = (
  owner: string,
) => ChannelBridgeBindings | undefined;
export function providerBridgeReadiness(
  hosted: HostedChannels | undefined,
  lookup: ProviderIngressLookup | undefined,
) {
  return {
    providerBridge: !!hosted?.bridge && !!hosted.wiring,
    providerIngress: !!lookup && !!hosted?.bridge && !!hosted.wiring,
  };
}
/** Called only after account authentication and write-scope checks. The native
 * bridge independently verifies exact authority/scope; owner login grants none. */
export async function providerBridgeApi(
  request: Request,
  hosted: HostedChannels | undefined,
  wake: () => void | Promise<void>,
) {
  if (!hosted?.bridge || !hosted.wiring)
    return Response.json(
      { error: "provider_bridge_unconfigured" },
      { status: 503 },
    );
  if (request.method !== "POST")
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "invalid_body" }, { status: 400 });
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        return Response.json({ error: "body_limit" }, { status: 413 });
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const input = JSON.parse(text);
    let result: unknown;
    if (
      input?.operation === "bind" &&
      input.spec &&
      typeof input.spec === "object"
    )
      result = await hosted.run(
        hosted.bridge.api.bind(input.spec as ChannelBridgeSpec),
      );
    else if (
      input?.operation === "revoke" &&
      typeof input.id === "string" &&
      input.id.length <= 256
    )
      result = await hosted.run(hosted.bridge.api.revoke(input.id));
    else return Response.json({ error: "invalid_operation" }, { status: 400 });
    try {
      await wake();
    } catch {
      /* Custody has committed; native recovery owns pending work. */
    }
    return Response.json(
      { result },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "bridge_operation_rejected" },
      { status: 409 },
    );
  } finally {
    reader.releaseLock();
  }
}

import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
/** Native tools.call surface. HTTP and codeMode share the same scoped bridge effects. */
export function providerBridgeTools(
  hosted: HostedChannels,
): NativeTool<Self>[] {
  const text = { type: "string" },
    port = {
      type: "object",
      properties: {
        channel: text,
        generation: { type: "integer", minimum: 1 },
      },
      required: ["channel", "generation"],
      additionalProperties: false,
    };
  const spec = {
    type: "object",
    properties: {
      operationId: text,
      external: port,
      input: port,
      output: port,
      wiring: {
        type: "object",
        properties: { id: text, generation: { type: "integer", minimum: 1 } },
        required: ["id", "generation"],
        additionalProperties: false,
      },
      decodeSchema: text,
      authorityRef: text,
      sendAuthorityRef: text,
      expiresAt: { type: "number" },
    },
    required: [
      "operationId",
      "external",
      "input",
      "output",
      "wiring",
      "decodeSchema",
      "authorityRef",
      "sendAuthorityRef",
      "expiresAt",
    ],
    additionalProperties: false,
  };
  return (["bind", "revoke"] as const).map((operation) => ({
    spec: {
      name: `provider_bridge_${operation}`,
      description: `${operation} an explicit provider/typed-handler bridge. Requires separately configured exact receiving and send authority; this does not create a provider subscription.`,
      inputSchema:
        operation === "bind"
          ? spec
          : {
              type: "object",
              properties: { id: text },
              required: ["id"],
              additionalProperties: false,
            },
    },
    run: (input: unknown) =>
      Effect.gen(function* () {
        const self = yield* Self;
        if (
          self.actor !== "aiko" ||
          self.thread !== hosted.thread ||
          !hosted.bridge
        )
          return { status: "unavailable" };
        if(operation === "bind") return {status:"recorded",bridge:yield* hosted.bridge.api.bind(input as ChannelBridgeSpec)};
        yield* hosted.bridge.api.revoke((input as {id:string}).id);
        return {status:"recorded"};
      }),
  }));
}
