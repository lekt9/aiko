import { createHash } from "node:crypto";
import type { Event } from "tardie/core/event";
import type { CodeResultCustody } from "./code-harness.ts";
import type { HarnessBlobStore } from "./harness-library.ts";

/** Host authorization for retained native results. No payload is opened here. */
export function codeResultCustody(options: {
  owner: string;
  thread: string;
  blobs: HarnessBlobStore;
  read(): Promise<readonly Event[]>;
  current(
    scope: import("./code-harness.ts").CodeResultScope,
  ): boolean | Promise<boolean>;
  currentData?(scope: {
    owner: string;
    thread: string;
  }): boolean | Promise<boolean>;
  tools(): readonly { name: string }[];
}): CodeResultCustody {
  return {
    blobs: options.blobs,
    read: options.read,
    authorizeData: async (scope) =>
      scope.owner === options.owner &&
      scope.thread === options.thread &&
      !!options.currentData &&
      (await options.currentData(scope)) &&
      (await options.currentData(scope)),
    authorize: async (scope) => {
      if (
        scope.owner !== options.owner ||
        scope.thread !== options.thread ||
        !(await options.current(scope))
      )
        return false;
      const tool = options.tools().find((tool) => tool.name === scope.tool);
      if (
        !tool ||
        `sha256:${createHash("sha256").update(JSON.stringify(tool)).digest("hex")}` !==
          scope.definitionDigest
      )
        return false;
      const rows = await options.read();
      const call = rows.findLast(
        (row) => row.type === "PackageCalled" && row.callId === scope.callId,
      );
      if (!call || call.name !== "tools.call" || typeof call.turn !== "string")
        return false;
      const execution = rows.findLast(
        (row) =>
          (row.type === "CodeDispatched" ||
            row.type === "CodeSpeculationStarted") &&
          typeof row.execId === "string" &&
          scope.callId.startsWith(`${row.execId}.`),
      );
      if (!execution || execution.turn !== call.turn) return false;
      if (
        execution.type === "CodeSpeculationStarted" &&
        !rows.some(
          (row) =>
            row.type === "CodeSpeculationReadAuthorized" &&
            row.execId === execution.execId &&
            row.callId === scope.callId &&
            row.name === call.name &&
            row.turn === call.turn,
        )
      )
        return false;
      // Initial definition append may still be in the native transaction. The
      // current registered spec above is authoritative; replay must also retain it.
      if (
        rows.some(
          (row) =>
            row.type === "AikoCodeToolStarted" && row.callId === scope.callId,
        ) &&
        !rows.some(
          (row) =>
            row.type === "AikoToolDefinitionRecorded" &&
            row.owner === scope.owner &&
            row.tool === scope.tool &&
            row.digest === scope.definitionDigest,
        )
      )
        return false;
      if (
        rows.some(
          (row) =>
            (row.type === "TurnCancelled" || row.type === "TurnFailed") &&
            row.turn === call.turn,
        )
      )
        return false;
      if (
        rows.some(
          (row) =>
            (row.type === "CodeCancelled" ||
              row.type === "CodeFailed" ||
              (row.type === "CodeSettled" && row.error !== undefined)) &&
            row.execId === execution.execId,
        )
      )
        return false;
      return await options.current(scope);
    },
  };
}
