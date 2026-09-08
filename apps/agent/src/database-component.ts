import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import type { Event } from "tardie/core/event";
import { EventLog } from "tardie/core/log";
import { canonical, clone, DataError, identifier, type Command, type StructuredStore } from "../../../packages/structured-data/src/index.ts";
import { authorizeDatabaseCommand, type DatabaseSourceResolver, type RefreshStop } from "./database-refresh.ts";
import { executeDatabaseRefreshGraph } from "./database-refresh-graph.ts";
import { executeDatabaseBridge, reconcileDatabaseBridge, isDatabaseMemoryCommand } from "./database-bridge.ts";

export interface DatabaseCustody {
  put(owner: string, value: unknown): Promise<string>;
  get(owner: string, ref: string): Promise<unknown>;
}
export interface DatabaseBinding {
  owner: string;
  thread: string;
  store: StructuredStore;
  custody: DatabaseCustody;
  /** Installed by the host; event/model fields never grant database access. */
  authorize(kind: "read" | "write", signal: AbortSignal): Promise<boolean>;
  now?: () => number;
  /** Read the complete owner log, including domain events omitted from model context. */
  readEvents?: () => Promise<readonly Event[]>;
  /** Refresh synchronous domain projections before a local query or command. */
  collections?: (events: readonly Event[]) => void;
  sources?: DatabaseSourceResolver;
  sourceCatalog?: () => Promise<unknown>;
  entities?: import("./database-entities.ts").DatabaseEntities;
}
export interface DatabaseRequest extends Event {
  type: "AikoDatabaseOperationRequested";
  id: string;
  owner: string;
  thread: string;
  commandRef: string;
  commandKind: Command["kind"];
  cause: string;
  epoch: number;
  at: number;
}
interface RetainedCommand {
  version: 1;
  owner: string;
  thread: string;
  operationId: string;
  producer: string;
  command: Command;
}
async function retainedCommand(binding: DatabaseBinding, input: DatabaseRequest): Promise<RetainedCommand> {
  const retained = await binding.custody.get(binding.owner, input.commandRef) as RetainedCommand;
  if (!retained || retained.version !== 1 || retained.owner !== binding.owner || retained.thread !== binding.thread || retained.operationId !== input.id || retained.command.kind !== input.commandKind) throw new DataError("forbidden", "Database command custody mismatch");
  return retained;
}
export interface DatabaseOperation {
  request: DatabaseRequest;
  cancelled: boolean;
  status: "queued" | "committed" | "cancelled" | "conflict" | "rejected" | "unavailable";
  revision?: number;
  code?: string;
}
export const databaseEventKey = (e: Event): string | undefined =>
  ["AikoDatabaseOperationRequested", "AikoDatabaseOperationSettled", "AikoDatabaseOperationCancelled", "AikoDatabaseRefreshGraphPlanned", "AikoDatabaseRefreshPlanned", "AikoDatabaseRefreshGroupStarted", "AikoDatabaseRefreshGroupSettled", "AikoDatabaseBridgePlanned", "AikoDatabaseBridgeEvidenceCommitted", "AikoDatabaseBridgeMemoryCommitted"].includes(e.type) && typeof e.owner === "string" && typeof e.id === "string"
    ? `aiko-database:${e.type}:${e.owner}:${e.id}` : undefined;

/** Public ingress must apply this before accepting arbitrary event or method JSON. */
export function databaseExternalEventAllowed(e: Event): boolean {
  return !e.type.startsWith("AikoDatabase") && (e.call as { invocation?: { method?: string } } | undefined)?.invocation?.method !== "databaseWait";
}
function assertBinding(binding: DatabaseBinding) {
  identifier(binding.owner); identifier(binding.thread);
  if (binding.store.owner !== binding.owner) throw new DataError("forbidden", "Database owner binding mismatch");
}
/** Host/tool admission seals the full command before its structural native event is appended. */
export async function prepareDatabaseCommand(binding: DatabaseBinding, input: {
  operationId: string; command: Command; producer: string; cause: string; epoch?: number;
}, signal: AbortSignal): Promise<DatabaseRequest> {
  assertBinding(binding); identifier(input.operationId); identifier(input.cause);
  const command = clone(input.command);
  if (canonical(command).length > 1_048_576) throw new DataError("limit", "Database command exceeds byte budget");
  if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Database writes unavailable");
  signal.throwIfAborted();
  const retained: RetainedCommand = { version: 1, owner: binding.owner, thread: binding.thread, operationId: input.operationId, producer: input.producer, command };
  const commandRef = await binding.custody.put(binding.owner, retained);
  signal.throwIfAborted();
  if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Database write authority changed");
  return { type: "AikoDatabaseOperationRequested", id: input.operationId, owner: binding.owner, thread: binding.thread, commandRef, commandKind: command.kind, cause: input.cause, epoch: input.epoch ?? 0, at: (binding.now ?? Date.now)() };
}
export function databaseState(events: readonly Event[], binding: Pick<DatabaseBinding, "owner" | "thread">): Map<string, DatabaseOperation> {
  return events.reduce((state, event) => step(state, event, binding), new Map<string, DatabaseOperation>());
}
function step(state: Map<string, DatabaseOperation>, e: Event, binding: Pick<DatabaseBinding, "owner" | "thread">): Map<string, DatabaseOperation> {
  const next = new Map(state);
  if (e.type === "AikoDatabaseOperationRequested" && e.owner === binding.owner && e.thread === binding.thread && typeof e.id === "string" && typeof e.commandRef === "string" && !next.has(e.id)) {
    next.set(e.id, { request: e as DatabaseRequest, status: "queued", cancelled: false });
  }
  if ((e.type === "AikoDatabaseOperationCancelled" && e.owner === binding.owner && e.thread === binding.thread) || e.type === "TurnCancelled") {
    for (const [id, operation] of next) if (operation.status === "queued" && (e.type === "TurnCancelled" ? operation.request.cause === e.turn && operation.request.epoch === Number(e.epoch ?? 0) : id === e.id)) next.set(id, { ...operation, cancelled: true });
  }
  if (e.type === "AikoDatabaseOperationSettled" && e.owner === binding.owner && e.thread === binding.thread && typeof e.id === "string") {
    const prior = next.get(e.id);
    if (prior?.status === "queued" && e.commandRef === prior.request.commandRef && ["committed", "cancelled", "conflict", "rejected", "unavailable"].includes(String(e.status))) {
      next.set(e.id, { ...prior, status: e.status as DatabaseOperation["status"], ...(typeof e.revision === "number" ? { revision: e.revision } : {}), ...(typeof e.code === "string" ? { code: e.code } : {}) });
    }
  }
  return next;
}
export function databaseComponent(binding: DatabaseBinding) {
  assertBinding(binding);
  return component({
    name: "aiko.databases",
    keys: { prefixes: ["aiko-database:"], keyOf: databaseEventKey },
    initial: () => new Map<string, DatabaseOperation>(),
    step: (state, e) => step(state, e, binding),
    output: state => {
      const operation = [...state.values()].find(o => o.status === "queued");
      if (!operation) return { view: undefined, transitions: [] };
      const request = operation.request;
      return { view: undefined, transitions: [effect({
        key: `aiko-database:AikoDatabaseOperationSettled:${binding.owner}:${request.id}`,
        input: request,
        interrupts: (input, e) => e.type === "TurnCancelled" && e.turn === input.cause && Number(e.epoch ?? 0) === input.epoch || e.type === "AikoDatabaseOperationCancelled" && e.owner === input.owner && e.id === input.id,
        act: (input, signal) => Effect.gen(function* () {
          const log = yield* EventLog;
          const settled = (status: DatabaseOperation["status"], extra: Record<string, string | number> = {}): Event[] => [{ type: "AikoDatabaseOperationSettled", id: input.id, owner: binding.owner, thread: binding.thread, commandRef: input.commandRef, status, ...extra, at: (binding.now ?? Date.now)() }];
          const result = yield* Effect.tryPromise({ try: async () => {
            const current = databaseState(await Effect.runPromise(log.read), binding).get(input.id);
            if (!current || current.request.commandRef !== input.commandRef) throw new DataError("forbidden", "Operation admission changed");
            const receipt = binding.store.receipt(input.id);
            if (receipt) return settled(receipt.outcome ?? "committed", { revision: receipt.revision });
            if ((input.commandKind === "mapping.promote" || input.commandKind === "mapping.correct") && binding.store.bridgePlan(input.id)) {
              let stop: "cancelled" | "forbidden" | undefined = current.cancelled || signal.aborted ? "cancelled" : undefined;
              if (!stop) {
                try { if (!await binding.authorize("write", signal)) stop = "forbidden"; }
                catch { stop = signal.aborted ? "cancelled" : "forbidden"; }
              }
              const recovered = await reconcileDatabaseBridge(binding, input, { append: events => Effect.runPromise(log.append(events)) }, signal, stop);
              if (recovered) return settled(recovered.outcome ?? "committed", { revision: recovered.revision });
              const retained = await retainedCommand(binding, input);
              if (!isDatabaseMemoryCommand(retained.command)) throw new DataError("forbidden", "Publication command mismatch");
              const latest = databaseState(await Effect.runPromise(log.read), binding).get(input.id);
              // A staged publication owns its partial-write bookkeeping. Do not
              // bypass it with the generic cancellation/admission return below.
              const committed = latest?.cancelled || signal.aborted
                ? await reconcileDatabaseBridge(binding, input, { append: events => Effect.runPromise(log.append(events)) }, signal, "cancelled")
                : await executeDatabaseBridge(binding, input, retained.command, retained.producer, { append: events => Effect.runPromise(log.append(events)) }, signal);
              if (!committed) throw new DataError("unavailable", "Publication reconciliation unavailable");
              return settled(committed.outcome ?? "committed", { revision: committed.revision });
            }
            if (input.commandKind === "table.refresh") {
              const events = await Effect.runPromise(log.read);
              if (events.some(event => ["AikoDatabaseRefreshGraphPlanned", "AikoDatabaseRefreshPlanned"].includes(event.type) && event.owner === binding.owner && event.thread === binding.thread && event.id === input.id)) {
                // A stopped refresh still owns earlier stage/group receipts. Read
                // those before the generic admission guard discards their outcome.
                let stop: RefreshStop | undefined = current.cancelled || signal.aborted ? "cancelled" : undefined;
                if (!stop) {
                  try { if (!await binding.authorize("write", signal)) stop = "forbidden"; }
                  catch { stop = signal.aborted ? "cancelled" : "forbidden"; }
                }
                const retained = await retainedCommand(binding, input);
                if (retained.command.kind !== "table.refresh") throw new DataError("forbidden", "Refresh command mismatch");
                const recovered = await executeDatabaseRefreshGraph(binding, input, retained.command, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)) }, signal, stop);
                return settled(recovered.outcome ?? "committed", { revision: recovered.revision });
              }
            }
            if (current.cancelled) return settled("cancelled");
            signal.throwIfAborted();
            if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Database writes unavailable");
            const retained = await retainedCommand(binding, input);
            signal.throwIfAborted();
            if (!await binding.authorize("write", signal)) throw new DataError("forbidden", "Database write authority changed");
            const latest = databaseState(await Effect.runPromise(log.read), binding).get(input.id);
            if (latest?.cancelled) return settled("cancelled");
            signal.throwIfAborted();
            binding.collections?.(await Effect.runPromise(log.read));
            await authorizeDatabaseCommand(binding, retained.command, signal);
            const committed = retained.command.kind === "table.refresh"
              ? await executeDatabaseRefreshGraph(binding, input, retained.command, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)) }, signal)
              : isDatabaseMemoryCommand(retained.command)
                ? await executeDatabaseBridge(binding, input, retained.command, retained.producer, { append: events => Effect.runPromise(log.append(events)) }, signal)
              : binding.store.execute(input.id, retained.command, { producer: retained.producer, at: input.at });
            return settled(committed.outcome ?? "committed", { revision: committed.revision });
          }, catch: error => error }).pipe(Effect.catch(error => Effect.promise(async () => {
            if (input.commandKind === "table.refresh") {
              try {
                const retained = await retainedCommand(binding, input);
                if (retained.command.kind === "table.refresh") {
                  // Even a lost host acknowledgement can follow a committed
                  // group. Reconcile receipts only; never retry its source here.
                  const recovered = await executeDatabaseRefreshGraph(binding, input, retained.command, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)) }, signal, signal.aborted ? "cancelled" : "unavailable");
                  return settled(recovered.outcome ?? "committed", { revision: recovered.revision });
                }
              } catch { /* No recoverable plan, or storage itself remains unavailable. */ }
            }
            return settled(error instanceof DataError && error.code === "conflict" ? "conflict" : error instanceof DataError && error.code === "forbidden" ? "rejected" : "unavailable", { code: error instanceof DataError ? error.code : "operation_unavailable" });
          })));
          return result;
        }),
      })] };
    },
  });
}
