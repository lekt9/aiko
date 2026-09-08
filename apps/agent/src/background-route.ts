import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { Router } from "tardie/core/communication/router";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { childCreated, childLineageOf, threadCreatedOf } from "tardie/core/thread";
import type { Event } from "tardie/core/event";
import { backgroundThread, threadBinding, type ThreadRole } from "./account-binding.ts";

/** Native same-owner handoff. The destination journal and event key own delivery. */
export function routeBackground(owner: string, role: Exclude<ThreadRole, "control" | "secretary">, message: Event) {
  return Effect.gen(function* () {
    const self = yield* Self;
    if (threadBinding(self.thread)?.owner !== owner) throw Error("Cross-account route refused");
    const target = { ...self, thread: role === "foreground" ? `user-${owner}` : backgroundThread(owner, role) };
    const router = yield* Router, log = yield* EventLog;
    const created = threadCreatedOf(yield* log.read);
    const lineage = role === "foreground" ? undefined : childLineageOf(created!, "colocated");
    if (lineage) yield* log.append([childCreated(`background:${role}`, target, lineage, Date.now())]);
    yield* router.send(envelopeOf(linkOf(self, target), message, lineage));
  });
}
