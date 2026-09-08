import type { HarnessBlobStore, HarnessDigest } from "./harness-library.ts";
import type { Event } from "tardie/core/event";
export type ChannelPrivateRef = {
  kind: "aiko-channel-private.v1";
  owner: string;
  ref: HarnessDigest;
};
export async function channelSeal(
  blobs: HarnessBlobStore | undefined,
  owner: string,
  value: unknown,
): Promise<ChannelPrivateRef> {
  if (!blobs) throw new Error("channel_custody_unavailable");
  return {
    kind: "aiko-channel-private.v1",
    owner,
    ref: await blobs.putPrivate(owner, value),
  };
}
export async function channelHydrate(
  blobs: HarnessBlobStore | undefined,
  owner: string,
  raw: unknown,
): Promise<any> {
  const r = raw as ChannelPrivateRef;
  if (
    !blobs ||
    !r ||
    r.kind !== "aiko-channel-private.v1" ||
    r.owner !== owner ||
    typeof r.ref !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(r.ref)
  )
    throw new Error("channel_custody_unavailable");
  try {
    return await blobs.get(owner, r.ref);
  } catch {
    throw new Error("channel_custody_unavailable");
  }
}
/** Provider runtime payloads are sealed at the shared journal boundary. Metadata used
 * for scheduling/fencing remains visible; the secret-derived digest stays sealed too. */
const fields: Record<string, string[]> = {
  AikoChannelPollFetched: ["batch"],
  AikoChannelReceived: ["body", "context", "digest"],
  AikoChannelInputAccepted: ["observation", "context"],
  AikoChannelOutputPrepared: ["input", "digest"],
  AikoChannelBridgeInputLinked: ["context"],
};
export async function channelSealEvent(
  blobs: HarnessBlobStore | undefined,
  owner: string,
  event: Event,
): Promise<Event> {
  if (!blobs || event.privateRef || !fields[event.type]) return event;
  const safe = { ...event },
    value: Record<string, unknown> = {};
  for (const field of fields[event.type]!)
    if (field in safe) {
      value[field] = safe[field];
      delete safe[field];
    }
  return { ...safe, privateRef: await channelSeal(blobs, owner, value) };
}
export async function channelOpenEvent(
  blobs: HarnessBlobStore | undefined,
  owner: string,
  event: Event,
): Promise<Event> {
  if (!event.privateRef) return event;
  const value = await channelHydrate(blobs, owner, event.privateRef);
  const { privateRef: _ref, ...safe } = event;
  return { ...safe, ...value };
}
