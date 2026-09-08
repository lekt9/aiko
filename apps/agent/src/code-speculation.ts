import { parse } from "@babel/parser";
import { Effect } from "effect";
import type { Action, ActionCall } from "tardie/log/events";
import type { InferRequest, ToolCallProgress, NativeCodeServices } from "tardie/inference/contract";
import type { Package } from "tardie/code/package/definition";
import { adoptSpeculativePrefix, speculateCodePrefix, type CodeSpeculation } from "tardie/code/execution/reactor";

interface ReadCall { readonly packageName: string; readonly method: string; readonly args: unknown }
export type SpeculationAuthority = (call: ReadCall) => boolean;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

// Only JSON literals cross this AST boundary. Expressions cannot smuggle calls.
function literal(node: any, depth = 0): unknown {
  if (!node || depth > 24) throw Error("Not a bounded literal");
  switch (node.type) {
    case "StringLiteral": case "BooleanLiteral": return node.value;
    case "NumericLiteral": if (Number.isFinite(node.value)) return node.value; break;
    case "NullLiteral": return null;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral" && Number.isFinite(node.argument.value)) return -node.argument.value;
      break;
    case "ArrayExpression": return node.elements.map((element: any) => literal(element, depth + 1));
    case "ObjectExpression": {
      const value: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (property.type !== "ObjectProperty" || property.computed || property.shorthand) throw Error("Not a plain object");
        const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : undefined;
        if (key === undefined || forbiddenKeys.has(key) || Object.hasOwn(value, key)) throw Error("Ambiguous object key");
        value[key] = literal(property.value, depth + 1);
      }
      return value;
    }
  }
  throw Error("Not a JSON literal");
}
function readCall(statement: any, packages: ReadonlySet<string>): ReadCall {
  let expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;
  if (statement.type === "VariableDeclaration") {
    if (statement.kind !== "const" || statement.declarations.length !== 1) throw Error("Not an immutable declaration");
    const declaration = statement.declarations[0];
    if (declaration.id.type !== "Identifier" || packages.has(declaration.id.name) || forbiddenKeys.has(declaration.id.name)) throw Error("Capability shadowing");
    expression = declaration.init;
  }
  if (expression?.type !== "AwaitExpression" || expression.argument.type !== "CallExpression") throw Error("Not a top-level awaited call");
  const call = expression.argument, member = call.callee;
  if (call.optional || call.arguments.length !== 1 || member.type !== "MemberExpression" || member.computed || member.optional ||
      member.object.type !== "Identifier" || member.property.type !== "Identifier" || !packages.has(member.object.name) || forbiddenKeys.has(member.property.name)) throw Error("Not a direct package call");
  return { packageName: member.object.name, method: member.property.name, args: literal(call.arguments[0]) };
}
/** Parsed, closed statements with explicit read authority; punctuation is never authorization. */
export function safeReadPrefix(source: string, packages: ReadonlySet<string>, authority: SpeculationAuthority): string | undefined {
  if (source.length > 65_536) return;
  let accepted: string | undefined, candidates = 0, parsedBytes = 0;
  for (let index = source.indexOf(";"); index !== -1; index = source.indexOf(";", index + 1)) {
    if (++candidates > 128 || (parsedBytes += index + 1) > 1_048_576) break;
    const candidate = source.slice(0, index + 1);
    try {
      const parsed = parse(candidate, { sourceType: "script", allowAwaitOutsideFunction: true });
      if (parsed.program.directives.length || !parsed.program.body.length || parsed.program.body.length > 8) continue;
      const calls = parsed.program.body.map(statement => readCall(statement, packages));
      if (calls.every(authority)) accepted = candidate;
    } catch { /* Partial or unsafe statements have no execution authority. */ }
  }
  return accepted;
}
function jsonString(text: string, from: number): { value: string; next: number; complete: boolean } | undefined {
  if (text[from] !== '"') return;
  let value = "";
  for (let index = from + 1; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') return { value, next: index + 1, complete: true };
    if (character.charCodeAt(0) < 32) return;
    if (character !== "\\") { value += character; continue; }
    const escape = text[++index];
    if (escape === undefined) return { value, next: index, complete: false };
    if (escape === "u") {
      const hex = text.slice(index + 1, index + 5);
      if (hex.length < 4) return { value, next: text.length, complete: false };
      try { value += JSON.parse(`"\\u${hex}"`); } catch { return; }
      index += 4;
    } else {
      try { value += JSON.parse(`"\\${escape}"`); } catch { return; }
    }
  }
  return { value, next: text.length, complete: false };
}
/** Decode an append-only code string without turning unfinished escapes into source. */
export function partialExecuteCode(argumentsText: string): string | undefined {
  if (argumentsText.length > 262_144) return;
  let index = 0;
  const whitespace = () => { while (" \t\r\n".includes(argumentsText[index] ?? "x")) index++; };
  whitespace(); if (argumentsText[index++] !== "{") return;
  const seen = new Set<string>();
  for (;;) {
    whitespace(); const key = jsonString(argumentsText, index);
    if (!key?.complete || seen.has(key.value)) return;
    seen.add(key.value); index = key.next; whitespace();
    if (argumentsText[index++] !== ":") return;
    whitespace(); const value = jsonString(argumentsText, index);
    if (!value) return;
    if (key.value === "code") return value.value;
    if (key.value !== "summary" || !value.complete) return;
    index = value.next; whitespace(); if (argumentsText[index++] !== ",") return;
  }
}
export interface CodeSpeculationOptions<R extends NativeCodeServices> {
  readonly request: InferRequest;
  readonly attempt?: string;
  readonly packages: ReadonlyArray<Package<R>>;
  readonly authority: SpeculationAuthority;
  readonly acceptsSource: (source: string) => boolean;
  readonly signal?: AbortSignal;
}
/** A trusted inference attachment. Tardie owns execution, IDs, results and adoption. */
export const createCodeSpeculation = <R extends NativeCodeServices>(options: CodeSpeculationOptions<R>) => Effect.gen(function* () {
  const runNative = options.request.nativeCode?.run;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const packageNames = new Set(options.packages.map(pkg => pkg.name));
  interface Candidate { readonly authority: CodeSpeculation; readonly finished: Promise<boolean> }
  const candidates = new Map<string, Candidate>();
  const onToolCallProgress = async (progress: ToolCallProgress, providerSignal: AbortSignal) => {
    await options.request.onToolCallProgress?.(progress, providerSignal);
    if (!runNative || !options.request.tools.some(tool => tool.name === "execute") || !options.attempt || progress.logicalAttempt !== options.attempt || progress.name !== "execute" || candidates.size >= 8) return;
    const identity = JSON.stringify([progress.physicalAttempt, progress.callId]);
    if (candidates.has(identity) || providerSignal.aborted || controller.signal.aborted) return;
    const source = partialExecuteCode(progress.argumentsText);
    if (source === undefined || !options.acceptsSource(source)) return;
    const prefix = safeReadPrefix(source, packageNames, options.authority);
    if (prefix === undefined) return;
    const bytes = new TextEncoder().encode(JSON.stringify([options.request.identity, options.attempt, progress.physicalAttempt, progress.callId]));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const authority: CodeSpeculation = {
      execId: `spec-${hash}`, turn: options.request.identity.turn, epoch: Number((options.request.trajectory.findLast(event => event.type === "ModelCalled") as any)?.epoch ?? 0),
      attempt: options.attempt, physicalAttempt: progress.physicalAttempt, providerCallId: progress.callId, prefix, at: Date.now(),
    };
    const signal = AbortSignal.any([providerSignal, controller.signal]);
    // The model stream continues while this scoped native execution reads.
    const finished = runNative(speculateCodePrefix(authority, options.packages, {
      call: { attemptTimeoutMs: 10_000, retryDelaysMs: [] },
    }), signal).then(() => true, () => false);
    candidates.set(identity, { authority, finished });
  };
  const finish = (action: Action): Effect.Effect<Action> => Effect.gen(function* () {
    const normalize = (call: ActionCall) => Effect.gen(function* () {
      if (call.name !== "execute" || !action.physicalAttempt) return call;
      const candidate = candidates.get(JSON.stringify([action.physicalAttempt, call.providerCallId ?? call.callId]));
      const code = (call.arguments as { code?: unknown } | undefined)?.code;
      if (!candidate || typeof code !== "string" || !options.acceptsSource(code) || !code.startsWith(candidate.authority.prefix) ||
          safeReadPrefix(candidate.authority.prefix, packageNames, options.authority) !== candidate.authority.prefix) return call;
      if (!(yield* Effect.promise(() => candidate.finished)) || controller.signal.aborted) return call;
      if (!runNative || !(yield* Effect.promise(() => runNative(adoptSpeculativePrefix({ ...candidate.authority, code }))))) return call;
      return { ...call, callId: candidate.authority.execId, providerCallId: call.providerCallId ?? call.callId };
    });
    try {
      if (action.kind === "call") return { ...action, ...(yield* normalize(action)) };
      if (action.kind === "calls") return { ...action, calls: yield* Effect.forEach(action.calls, normalize) };
      return action;
    } finally { controller.abort(); options.signal?.removeEventListener("abort", abort); }
  });
  return { onToolCallProgress, finish, abort: () => { controller.abort(); options.signal?.removeEventListener("abort", abort); } };
});
