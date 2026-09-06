/** JSON-only wire contract; no credentials, host handles or executable callbacks cross it. */
export interface CodeCall {
  ordinal: number;
  packageName: string;
  method: string;
  args: unknown;
}
export interface CodeSegment {
  version: 1;
  code: string;
  packages: Record<string, string[]>;
  values: Record<string, unknown>;
  ambient: { at: number; seed: string };
  history: { call: CodeCall; result: unknown }[];
}
export interface CodeSegmentResult {
  calls: CodeCall[];
  settled: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
}
export const CODE_SEGMENT_MAX_BYTES = 2 * 1024 * 1024;
export const codeCallKey = (call: CodeCall): string => JSON.stringify([
  call.ordinal, call.packageName, call.method, canonical(call.args),
]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]),
  );
  return value;
}
