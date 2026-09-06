import { createHash } from "node:crypto";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { event, type AikoEvent } from "./actor.ts";

/** Provider contract only. No Codegraff provisioning, browser binary or shell is mounted by the app. */
export type Vm = {
  owner: string;
  id: string;
  state: "running" | "stopped";
  profilePath: string;
};
export type VmProvider = {
  // Must reconcile by the same stable owner key; ensure must not blindly create on retries.
  ensure: (ownerKey: string, signal: AbortSignal) => Promise<Vm>;
  find: (ownerKey: string, signal: AbortSignal) => Promise<Vm | undefined>;
  start: (id: string, signal: AbortSignal) => Promise<void>;
  stop: (id: string, signal: AbortSignal) => Promise<void>;
};
export type BrowserGates = {
  classicSourceVerified: boolean;
  cloakSaasRights: boolean;
  independentEgress: boolean;
  humanSigninRelay: boolean;
  vmCompatibility: boolean;
  spendApproved: boolean;
};
export const browserGatesReady = (gates: BrowserGates) =>
  [
    "classicSourceVerified",
    "cloakSaasRights",
    "independentEgress",
    "humanSigninRelay",
    "vmCompatibility",
    "spendApproved",
  ].every((key) => gates[key as keyof BrowserGates] === true);
export const ownerVmKey = (owner: string) =>
  `aiko-${createHash("sha256").update(owner).digest("hex")}`;
const checkedVm = (owner: string, vm: Vm) => {
  if (
    vm.owner !== owner ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(vm.id) ||
    vm.profilePath !== `/data/aiko/${ownerVmKey(owner)}/browser`
  )
    throw new Error("invalid scoped VM");
  return vm;
};

type Request = {
  id: string;
  action: "wake" | "sleep";
  started: boolean;
  settled: boolean;
};
type State = {
  vm?: Vm;
  activeTasks: Set<string>;
  requests: Map<string, Request>;
};
/** Native lifecycle component, intentionally NOT mounted until the six host-owned gates are verified.
 * An idle signal is advisory; active task leases prevent stop. Stop never deletes the VM disk.
 * Started effects recover by read-back; an ambiguous start/stop is surfaced, not blindly replayed.
 */
export function vmLifecycle(
  owner: string,
  gates: BrowserGates,
  provider?: VmProvider,
) {
  return component({
    name: "aiko.vm",
    keys: {
      prefixes: ["aiko-vm:", "aiko-vm-start:"],
      keyOf: (raw) => {
        const e = raw as AikoEvent;
        return e.type === "AikoVmSettled"
          ? `aiko-vm:${e.id}`
          : e.type === "AikoVmStarted"
            ? `aiko-vm-start:${e.id}`
            : undefined;
      },
    },
    initial: (): State => ({ activeTasks: new Set(), requests: new Map() }),
    step: (previous, raw): State => {
      const e = raw as AikoEvent;
      if (e.owner !== owner) return previous;
      const state = {
        ...previous,
        requests: new Map(previous.requests),
        activeTasks: new Set(previous.activeTasks),
      };
      if (e.type === "AikoVmTaskAcquired")
        state.activeTasks.add(String(e.task));
      if (e.type === "AikoVmTaskReleased")
        state.activeTasks.delete(String(e.task));
      if (
        e.type === "AikoVmRequested" &&
        (e.action === "wake" || e.action === "sleep") &&
        !state.requests.has(String(e.id))
      )
        state.requests.set(String(e.id), {
          id: String(e.id),
          action: e.action,
          started: false,
          settled: false,
        });
      const current = state.requests.get(String(e.id));
      if (current && e.type === "AikoVmStarted")
        state.requests.set(current.id, { ...current, started: true });
      if (current && e.type === "AikoVmSettled") {
        state.requests.set(current.id, { ...current, settled: true });
        if (e.vm) {
          try {
            state.vm = checkedVm(owner, e.vm as Vm);
          } catch {
            /* quarantine mismatched VM evidence */
          }
        }
      }
      return state;
    },
    output: (state) => ({
      view: undefined,
      transitions: [...state.requests.values()]
        .filter((r) => !r.settled)
        .slice(0, 1)
        .map((request) =>
          effect({
            key: `aiko-vm:${request.id}`,
            input: { request, vm: state.vm, active: state.activeTasks.size },
            interrupts: (input, raw) =>
              input.request.action === "sleep" &&
              raw.type === "AikoVmTaskAcquired" &&
              (raw as AikoEvent).owner === owner,
            act: (input, signal) =>
              Effect.gen(function* () {
                const stamp = { owner, id: input.request.id };
                if (!browserGatesReady(gates) || !provider)
                  return [
                    event("AikoVmSettled", { ...stamp, status: "blocked" }),
                  ];
                if (input.request.action === "sleep" && input.active)
                  return [event("AikoVmSettled", { ...stamp, status: "busy" })];
                const log = yield* EventLog;
                if (!input.request.started)
                  yield* log.append([event("AikoVmStarted", stamp)]);
                return yield* Effect.tryPromise({
                  try: async () => {
                    if (input.request.started) {
                      const found = await provider.find(
                        ownerVmKey(owner),
                        signal,
                      );
                      return [
                        event("AikoVmSettled", {
                          ...stamp,
                          status:
                            found &&
                            found.state ===
                              (input.request.action === "wake"
                                ? "running"
                                : "stopped")
                              ? "reconciled"
                              : "unknown",
                          ...(found ? { vm: checkedVm(owner, found) } : {}),
                        }),
                      ];
                    }
                    if (input.request.action === "sleep" && !input.vm)
                      return [
                        event("AikoVmSettled", {
                          ...stamp,
                          status: "not_provisioned",
                        }),
                      ];
                    const vm = checkedVm(
                      owner,
                      input.vm ??
                        (await provider.ensure(ownerVmKey(owner), signal)),
                    );
                    if (
                      input.request.action === "wake" &&
                      vm.state === "stopped"
                    )
                      await provider.start(vm.id, signal);
                    if (
                      input.request.action === "sleep" &&
                      vm.state === "running"
                    )
                      await provider.stop(vm.id, signal);
                    const verified = await provider.find(
                      ownerVmKey(owner),
                      signal,
                    );
                    if (!verified) throw new Error("missing read-back");
                    const expected =
                      input.request.action === "wake" ? "running" : "stopped";
                    return [
                      event("AikoVmSettled", {
                        ...stamp,
                        status:
                          verified.state === expected ? "verified" : "unknown",
                        vm: checkedVm(owner, verified),
                      }),
                    ];
                  },
                  catch: () => [
                    event("AikoVmSettled", { ...stamp, status: "unknown" }),
                  ],
                }).pipe(Effect.catch((events) => Effect.succeed(events)));
              }),
          }),
        ),
    }),
  });
}
