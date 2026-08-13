// @smithers-type-exports-begin
/** @typedef {import("./CellProps.ts").CellProps} CellProps */
// @smithers-type-exports-end

import React from "react";
import { basename } from "node:path";
import { Task } from "./Task.js";
import { runCell } from "./runCell.js";

/**
 * Native Smithers element: a Cell harness inside the workflow.
 *
 * Compiles to a compute `Task` so Sequence/Parallel/deps/pause/resume
 * apply. Cell stays the typed DAG; Smithers is the durable control
 * surface. Not a second scheduler.
 *
 * @param {CellProps} props
 */
export function Cell(props) {
  if (props.skipIf) return null;
  const { cell, inputs, deps, outputPort, ...rest } = props;
  return React.createElement(Task, {
    ...rest,
    outputSchema: undefined,
    deps,
    label: props.label ?? `cell:${basename(cell)}`,
    meta: { ...props.meta, kind: "cell", cell },
    children: (resolvedDeps) => {
      const membrane =
        typeof inputs === "function" ? inputs(resolvedDeps ?? {}) : { ...(inputs ?? {}), ...(resolvedDeps ?? {}) };
      return runCell({
        cell,
        inputs: membrane,
        timeoutMs: props.timeoutMs,
      }).then((fired) => {
        const selected = outputPort === undefined ? fired.outputs : fired.outputs[outputPort];
        if (outputPort !== undefined && (selected === null || typeof selected !== "object" || Array.isArray(selected))) {
          throw new Error(`cell output port ${outputPort} must be an object`);
        }
        return {
          ...(selected ?? fired.outputs),
          _cell: {
            path: fired.cell,
            digest: fired.digest,
            manifest: fired.manifest,
          },
        };
      });
    },
  });
}

export { runCell, findCellRunner } from "./runCell.js";
