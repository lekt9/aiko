import type { Event } from "tardie/core/event";
import { endpointDescriptionEventKey } from "./observed-endpoint.ts";

/** An occurrence ID belongs to the native index attempt; queue redelivery keeps that same ID. */
export function requestMemoryEventKey(event: Event): string | undefined {
  if (event.type === "AikoObservedEndpointDescribed") return endpointDescriptionEventKey(event);
  if (!["AikoRequestMemoryIndexed", "AikoRequestMemoryIndexUnavailable", "AikoRequestMemoryChecked"].includes(event.type) ||
    typeof event.id !== "string" || !/^[a-f0-9-]{36}$/.test(event.id) ||
    typeof event.toolDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.toolDigest)) return undefined;
  if (event.type === "AikoRequestMemoryIndexed" && (typeof event.pointerId !== "string" ||
    !/^obs_[a-f0-9]{64}$/.test(event.pointerId) || typeof event.model !== "string" || !event.model || event.model.length > 256)) return undefined;
  return `aiko-request-memory:${event.type}:${event.id}`;
}
