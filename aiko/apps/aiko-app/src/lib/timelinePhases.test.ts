import { describe, expect, it } from "vitest";
import type { MessageSegment } from "./session";
import {
  buildTimelineUnits,
  isPhaseWorthy,
  phaseTitleModel,
} from "./timelinePhases";

function tool(
  id: string,
  title: string,
  status = "completed",
): Extract<MessageSegment, { kind: "tool" }> {
  return {
    kind: "tool",
    toolCallId: id,
    title,
    toolKind: "read_file",
    status,
    streaming: status === "running",
  };
}

describe("timelinePhases", () => {
  it("isPhaseWorthy: thought+tool or ≥2 tools", () => {
    expect(isPhaseWorthy(["plan"], [tool("a", "Read a")])).toBe(true);
    expect(isPhaseWorthy([], [tool("a", "a"), tool("b", "b")])).toBe(true);
    expect(isPhaseWorthy(["only think"], [])).toBe(false);
    expect(isPhaseWorthy([], [tool("a", "a")])).toBe(false);
  });

  it("closes phase when content starts (not at full turn end only)", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "**定位** 目录结构" },
      tool("t1", "Read a"),
      tool("t2", "Read b"),
      { kind: "content", text: "结论如下。" },
      { kind: "thought", text: "再查一遍" },
      tool("t3", "Read c"),
      { kind: "content", text: "补充。" },
    ];
    // Still streaming after first content would keep later work live — turn done:
    const units = buildTimelineUnits(segs, { streaming: false });
    expect(units.map((u) => u.kind)).toEqual([
      "phase",
      "content",
      "phase",
      "content",
    ]);
    const p0 = units[0]!;
    expect(p0.kind).toBe("phase");
    if (p0.kind === "phase") {
      expect(p0.live).toBe(false);
      expect(p0.tools).toHaveLength(2);
      expect(p0.thoughts[0]).toContain("定位");
      const title = phaseTitleModel(p0);
      expect(title.gist).toBeTruthy();
      expect(title.stepCount).toBe(2);
    }
  });

  it("merges adjacent think/tool bursts into ONE phase (no body between)", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "round1" },
      tool("t1", "Read a"),
      { kind: "thought", text: "round2" },
      tool("t2", "Read b"),
      tool("t3", "Read c"),
    ];
    const units = buildTimelineUnits(segs, { streaming: false });
    // A long agent turn must NOT render as a stack of “Worked for 1s” blocks.
    expect(units.map((u) => u.kind)).toEqual(["phase"]);
    if (units[0]!.kind === "phase") {
      expect(units[0]!.tools).toHaveLength(3);
      expect(units[0]!.thoughts).toEqual(["round1", "round2"]);
      expect(units[0]!.items).toHaveLength(5);
    }
  });

  it("content still splits phases (answer boundary)", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "round1" },
      tool("t1", "Read a"),
      { kind: "content", text: "结论如下。" },
      { kind: "thought", text: "round2" },
      tool("t2", "Read b"),
    ];
    const units = buildTimelineUnits(segs, { streaming: false });
    expect(units.map((u) => u.kind)).toEqual(["phase", "content", "phase"]);
  });

  it("trailing work stays live while streaming", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "**探索**" },
      tool("t1", "Read a", "completed"),
      tool("t2", "Read b", "running"),
    ];
    const live = buildTimelineUnits(segs, { streaming: true });
    expect(live).toHaveLength(1);
    expect(live[0]!.kind).toBe("phase");
    if (live[0]!.kind === "phase") {
      expect(live[0]!.live).toBe(true);
      expect(live[0]!.runningCount).toBe(1);
    }
    const done = buildTimelineUnits(segs.map((s) =>
      s.kind === "tool" ? { ...s, status: "completed", streaming: false } : s,
    ), { streaming: false });
    if (done[0]!.kind === "phase") {
      expect(done[0]!.live).toBe(false);
    }
  });

  it("empty tool status without streaming is not running", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "plan" },
      {
        kind: "tool",
        toolCallId: "t1",
        title: "Read",
        toolKind: "read_file",
        status: "",
        streaming: false,
      },
      {
        kind: "tool",
        toolCallId: "t2",
        title: "List",
        toolKind: "list_dir",
        status: "completed",
        streaming: false,
      },
      { kind: "content", text: "done" },
    ];
    const units = buildTimelineUnits(segs, { streaming: false });
    expect(units[0]!.kind).toBe("phase");
    if (units[0]!.kind === "phase") {
      expect(units[0]!.live).toBe(false);
      expect(units[0]!.runningCount).toBe(0);
    }
  });

  it("turn end clears runningCount even when tools still claim running", () => {
    // Real bug: tool_call_update never sent "completed", so status stayed
    // in_progress after the assistant finished — UI showed "工作中 8m…".
    const segs: MessageSegment[] = [
      { kind: "thought", text: "The video analysis is running" },
      tool("t1", "Read file", "in_progress"),
      tool("t2", "Edit file", "running"),
      { kind: "content", text: "分析完成" },
    ];
    const live = buildTimelineUnits(segs, { streaming: true });
    expect(live[0]!.kind).toBe("phase");
    if (live[0]!.kind === "phase") {
      expect(live[0]!.runningCount).toBe(2);
    }
    const done = buildTimelineUnits(segs, { streaming: false });
    expect(done[0]!.kind).toBe("phase");
    if (done[0]!.kind === "phase") {
      expect(done[0]!.live).toBe(false);
      expect(done[0]!.runningCount).toBe(0);
    }
  });

  it("single thought or single tool stays bare (not a phase chip)", () => {
    expect(
      buildTimelineUnits(
        [{ kind: "thought", text: "hmm" }, { kind: "content", text: "hi" }],
        { streaming: false },
      ).map((u) => u.kind),
    ).toEqual(["thought", "content"]);

    expect(
      buildTimelineUnits(
        [tool("only", "Read x"), { kind: "content", text: "ok" }],
        { streaming: false },
      ).map((u) => u.kind),
    ).toEqual(["tool", "content"]);
  });

  it("phase id stays stable while a live phase grows (no endSi churn)", () => {
    const base: MessageSegment[] = [
      { kind: "thought", text: "plan" },
      tool("a", "Read a"),
    ];
    const p1 = buildTimelineUnits(base, { streaming: true });
    const grown = buildTimelineUnits(
      [...base, tool("b", "Read b"), tool("c", "Read c")],
      { streaming: true },
    );
    if (p1[0]!.kind === "phase" && grown[0]!.kind === "phase") {
      expect(p1[0]!.id).toBe(grown[0]!.id);
    }
  });

  it("failed tools set errorCount for default expand", () => {
    const units = buildTimelineUnits(
      [
        { kind: "thought", text: "try" },
        tool("ok", "Read a"),
        {
          ...tool("bad", "Shell"),
          toolKind: "run_terminal_command",
          status: "failed",
          isError: true,
        },
      ],
      { streaming: false },
    );
    expect(units[0]!.kind).toBe("phase");
    if (units[0]!.kind === "phase") {
      expect(units[0]!.errorCount).toBe(1);
    }
  });

  it("history reconstruction thought→tools→content yields phase then content", () => {
    const segs: MessageSegment[] = [
      { kind: "thought", text: "**定位** 项目" },
      tool("t1", "Read a"),
      tool("t2", "Read b"),
      tool("t3", "Read c"),
      { kind: "content", text: "项目概览……" },
    ];
    const units = buildTimelineUnits(segs, { streaming: false });
    expect(units.map((u) => u.kind)).toEqual(["phase", "content"]);
    if (units[0]!.kind === "phase") {
      expect(units[0]!.live).toBe(false);
      expect(units[0]!.tools).toHaveLength(3);
    }
  });
});
