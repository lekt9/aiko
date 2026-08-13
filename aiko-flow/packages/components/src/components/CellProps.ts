import type React from "react";
import type { SmithersCtx } from "@smthrs/driver";
import type { CachePolicy } from "@smthrs/scheduler/CachePolicy";
import type { RetryPolicy } from "@smthrs/scheduler/RetryPolicy";
import type { OutputTarget } from "./OutputTarget.ts";
import type { DepsSpec } from "./DepsSpec.ts";
import type { InferDeps } from "./InferDeps.ts";

export type CellProps<Row = Record<string, unknown>, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}> = {
  key?: string;
  id: string;
  /** Path to a `*.cell.yaml`. Resolved from the run cwd. */
  cell: string;
  /** Membrane inputs. A function receives resolved `deps`. */
  inputs?: Record<string, unknown> | ((deps: InferDeps<D>) => Record<string, unknown>);
  output: Output;
  /** Select one membrane output as the persisted row; otherwise all outputs are returned. */
  outputPort?: string;
  dependsOn?: string[];
  needs?: Record<string, string>;
  deps?: D;
  depsOptional?: boolean;
  skipIf?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
  cache?: CachePolicy;
  label?: string;
  meta?: Record<string, unknown>;
  /** @internal Bound by createSmithers(). */
  smithersContext?: React.Context<SmithersCtx<unknown> | null>;
};
