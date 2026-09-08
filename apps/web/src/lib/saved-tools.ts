import type { WatchRequest } from "./browser-watches";
export type ToolCandidate = {
  harnessDigest: string;
  contractDigest: string;
  name: string;
  runtime: string;
  at?: number;
};
export type ToolOperation = {
  operationId: string;
  digest: string;
  status: string;
  at?: number;
  outputAvailable?: boolean;
};
export type ToolEvaluation = {
  id: string;
  harnessDigest: string;
  eligible: boolean;
  witnessIds?: string[];
};
export type ToolCatalog = {
  candidates: ToolCandidate[];
  routes: {
    type?: string;
    harnessDigest: string;
    name: string;
    generation: number;
  }[];
  operations?: ToolOperation[];
  evaluations?: ToolEvaluation[];
};
export type ToolInspection = {
  digest: string;
  expectedGeneration: number;
  artifact: {
    name: string;
    description: string;
    runtime: string;
    contractDigest: string;
    entrypoint: string;
    files: Record<string, string>;
    sources: { uri: string; revision: string; digest: string }[];
  };
  contract: {
    outcome: string;
    inputSchema: unknown;
    outputSchema: unknown;
    effect: string;
  };
  procedure?: { basis?: string };
  route?: { type?: string; harnessDigest: string; generation: number } | null;
};
export type ToolTest = {
  status: "eligible" | "failed" | "pending" | "unknown";
  digest: string;
  evaluationId: string;
  evaluation?: { witnessIds?: string[] };
};
export const libraryPath = "/harness/library";
export const isSavedVersion = (
  route: ToolInspection["route"],
  digest: string,
) => route?.type === "AikoHarnessPromoted" && route.harnessDigest === digest;
export async function libraryRequest<T>(
  request: WatchRequest,
  path: string,
  body?: object,
  signal?: AbortSignal,
) {
  const response = await request<{ available: boolean; result: T }>(
    libraryPath + path,
    body,
    signal,
  );
  if (response.available !== true || response.result === undefined)
    throw Error(
      "Saved tools are unavailable for this account. Try Refresh tools.",
    );
  return response.result;
}
export function toolInput(text: string): unknown {
  if (new TextEncoder().encode(text).length > 32768)
    throw Error("Inputs are too large. Keep them under 32 KB.");
  try {
    return JSON.parse(text);
  } catch {
    throw Error(
      "Enter valid JSON inputs. Use the input contract below as a guide.",
    );
  }
}
export const shortVersion = (digest: string) =>
  digest.replace(/^sha256:/, "").slice(0, 10);
export const operationLabel = (status: string) =>
  ({
    running: "Running",
    satisfied: "Completed and checked",
    violated: "Result did not pass its check",
    blocked: "Blocked",
    unknown: "Outcome unknown",
  })[status] ?? "Status unavailable";
export const hasUnsettledRun = (operations: ToolOperation[]) =>
  operations.some(
    (item) => item.status === "unknown" || item.status === "running",
  );
/** Each button journey retains its native operation IDs before awaiting the server.
 * Reading an uncertain result never invokes run again. No input is persisted in browser storage. */
export class ToolRevisionSession {
  description: string;
  files: Record<string, string>;
  testResult?: ToolTest;
  private testAttempt?: { key: string; id: string; digest?: string };
  runAttempt?: ToolOperation;
  runOutput?: unknown;
  constructor(
    public inspection: ToolInspection,
    private readonly nonce = () => crypto.randomUUID(),
  ) {
    this.description = inspection.artifact.description;
    this.files = { ...inspection.artifact.files };
  }
  private draftKey() {
    return JSON.stringify([
      this.inspection.digest,
      this.description,
      this.files,
    ]);
  }
  get tested() {
    return this.testAttempt?.key === this.draftKey()
      ? this.testResult
      : undefined;
  }
  async test(request: WatchRequest, signal?: AbortSignal) {
    if (!this.description.trim()) throw Error("Describe what this tool does.");
    if (Object.values(this.files).some((value) => !value.trim()))
      throw Error("Source files cannot be empty.");
    const key = this.draftKey();
    if (this.testAttempt?.key !== key) {
      this.testAttempt = { key, id: `tool-test-${this.nonce()}` };
      this.testResult = undefined;
    }
    const attempt = this.testAttempt;
    try {
      if (!attempt.digest) {
        const changed =
          this.description !== this.inspection.artifact.description ||
          JSON.stringify(this.files) !==
            JSON.stringify(this.inspection.artifact.files);
        if (changed) {
          const result = await libraryRequest<{
            status: string;
            digest: string;
          }>(
            request,
            "/revise",
            {
              predecessorDigest: this.inspection.digest,
              changes: { description: this.description, files: this.files },
            },
            signal,
          );
          if (result.status !== "candidate" || !result.digest)
            throw Error(
              "The revised candidate could not be confirmed. Your draft is still here.",
            );
          attempt.digest = result.digest;
        } else attempt.digest = this.inspection.digest;
      }
      this.testResult = await libraryRequest<ToolTest>(
        request,
        "/evaluate",
        { digest: attempt.digest, evaluationId: attempt.id },
        signal,
      );
      return this.testResult;
    } catch (error) {
      this.testResult = {
        status: "unknown",
        digest: attempt.digest ?? this.inspection.digest,
        evaluationId: attempt.id,
      };
      throw error;
    }
  }
  async save(request: WatchRequest, signal?: AbortSignal) {
    const checked = this.tested;
    if (checked?.status !== "eligible")
      throw Error("Test this revision successfully before saving a version.");
    const result = await libraryRequest<{ status: string }>(
      request,
      "/promote",
      {
        digest: checked.digest,
        evaluationId: checked.evaluationId,
        expectedGeneration: this.inspection.expectedGeneration,
      },
      signal,
    );
    if (result.status !== "promoted")
      throw Error(
        "This version was not saved. Refresh its current version before trying again.",
      );
    return checked.digest;
  }
  async run(
    request: WatchRequest,
    digest: string,
    input: unknown,
    signal?: AbortSignal,
  ) {
    if (this.runAttempt)
      throw Error("Check the existing run before starting another one.");
    const operationId = `tool-run-${this.nonce()}`;
    this.runAttempt = { operationId, digest, status: "running" };
    try {
      const witness = await libraryRequest<{
        status: string;
        operationId: string;
        outputRef?: string;
      }>(request, "/run", { digest, input, operationId }, signal);
      if (witness.operationId !== operationId)
        throw Error("The returned operation did not match this run.");
      this.runAttempt = {
        operationId,
        digest,
        status: witness.status,
        outputAvailable: !!witness.outputRef,
      };
      return this.runAttempt;
    } catch (error) {
      this.runAttempt = { operationId, digest, status: "unknown" };
      throw error;
    }
  }
  async output(
    request: WatchRequest,
    operation: ToolOperation,
    signal?: AbortSignal,
  ) {
    const result = await libraryRequest<{
      status: string;
      operationId: string;
      output: unknown;
    }>(request, "/output", { operationId: operation.operationId }, signal);
    if (
      result.status !== "satisfied" ||
      result.operationId !== operation.operationId
    )
      throw Error(
        "No checked result is available yet. This action has not been sent again.",
      );
    this.runOutput = result.output;
    if (this.runAttempt?.operationId === operation.operationId)
      this.runAttempt = {
        ...operation,
        status: "satisfied",
        outputAvailable: true,
      };
    return result.output;
  }
}
