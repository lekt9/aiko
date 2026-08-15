import { describe, expect, it } from "vitest";
import {
  isEndOfTurnMarker,
  mapEndOfTurnReason,
  parseEndOfTurnContent,
} from "./endOfTurn";

describe("endOfTurn", () => {
  it("maps user stop / stall / error", () => {
    expect(mapEndOfTurnReason("user_stop").reason).toBe("user_stop");
    expect(mapEndOfTurnReason("stall").messageKey).toBe("endOfTurn.stall");
    expect(mapEndOfTurnReason("permission_denied").tone).toBe("error");
    expect(mapEndOfTurnReason("error").reason).toBe("error");
  });

  it("recognizes markers", () => {
    expect(isEndOfTurnMarker("turn_cancelled")).toBe(true);
    expect(isEndOfTurnMarker("turn_end")).toBe(true);
    expect(isEndOfTurnMarker("tool_step")).toBe(false);
  });

  it("parses content", () => {
    expect(parseEndOfTurnContent("turn_end|user_stop")).toBe("user_stop");
    expect(parseEndOfTurnContent("turn_cancelled")).toBe("cancelled");
  });

  it("keeps host journal user_stop reason (history matches live chip)", () => {
    // Host stop: turn_cancelled|user_stop — must not collapse to generic cancelled.
    expect(parseEndOfTurnContent("turn_cancelled|user_stop")).toBe("user_stop");
    expect(
      mapEndOfTurnReason(
        parseEndOfTurnContent("turn_cancelled|user_stop"),
      ).messageKey,
    ).toBe("activity.cancelledByUser");
    expect(
      parseEndOfTurnContent("turn_cancelled|user_stop|partial:hello"),
    ).toBe("user_stop");
    expect(parseEndOfTurnContent("turn_cancelled|agent_exit")).toBe(
      "agent_exit",
    );
    expect(parseEndOfTurnContent("turn_end|stall")).toBe("stall");
  });
});