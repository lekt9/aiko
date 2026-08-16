import React from "react";
import { Task } from "./Task.js";

/** A Smithers task whose execution authority is the Contract driver, never control.json. */
export function ContractCell(props) {
  if (props.skipIf) return null;
  const { driver, signal, deps, ...rest } = props;
  if (!driver?.handleSignal) throw new Error("ContractCell requires an operational Contract driver");
  return React.createElement(Task, {
    ...rest,
    deps,
    label: props.label ?? "contract:graph-harness-cell",
    meta: { ...props.meta, kind: "contract-cell", authority: "contract" },
    children: (resolvedDeps) => driver.handleSignal(typeof signal === "function" ? signal(resolvedDeps ?? {}) : signal),
  });
}
