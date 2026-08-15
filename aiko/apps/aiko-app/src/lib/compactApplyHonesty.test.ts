import { describe, expect, it } from "vitest";
import {
  buildCompactDialogFooter,
  buildCompactPresetNote,
  compactApplyEffectMessageKey,
  compactSettingsApplyMessageKey,
  resolveCompactApplyEffect,
  resolveCompactDialogHonesty,
  sessionHasLiveAgent,
} from "./compactApplyHonesty";

describe("sessionHasLiveAgent", () => {
  it("is true for ready / streaming / awaiting_permission", () => {
    expect(sessionHasLiveAgent("ready")).toBe(true);
    expect(sessionHasLiveAgent("streaming")).toBe(true);
    expect(sessionHasLiveAgent("awaiting_permission")).toBe(true);
    expect(sessionHasLiveAgent("READY")).toBe(true);
  });

  it("is false for idle / disconnected / connecting / empty", () => {
    expect(sessionHasLiveAgent("idle")).toBe(false);
    expect(sessionHasLiveAgent("disconnected")).toBe(false);
    expect(sessionHasLiveAgent("connecting")).toBe(false);
    expect(sessionHasLiveAgent(null)).toBe(false);
    expect(sessionHasLiveAgent(undefined)).toBe(false);
    expect(sessionHasLiveAgent("")).toBe(false);
  });
});

describe("resolveCompactApplyEffect", () => {
  it("idle session → idle regardless of CLI flags", () => {
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: false,
        cliSupportsFlags: true,
      }),
    ).toBe("idle");
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: false,
        cliSupportsFlags: false,
      }),
    ).toBe("idle");
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: false,
        cliSupportsFlags: true,
        forSettingsChange: true,
      }),
    ).toBe("idle");
  });

  it("live + flags unsupported → unsupported", () => {
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: true,
        cliSupportsFlags: false,
      }),
    ).toBe("unsupported");
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: true,
        cliSupportsFlags: false,
        forSettingsChange: true,
      }),
    ).toBe("unsupported");
  });

  it("live + flags → next_turn for /compact run path", () => {
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: true,
        cliSupportsFlags: true,
      }),
    ).toBe("next_turn");
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: true,
        cliSupportsFlags: true,
        forSettingsChange: false,
      }),
    ).toBe("next_turn");
  });

  it("live + flags + settings change → soft_respawn", () => {
    expect(
      resolveCompactApplyEffect({
        hasLiveAgent: true,
        cliSupportsFlags: true,
        forSettingsChange: true,
      }),
    ).toBe("soft_respawn");
  });
});

describe("compactApplyEffectMessageKey / compactSettingsApplyMessageKey", () => {
  it("maps effects to stable dialog keys", () => {
    expect(compactApplyEffectMessageKey("next_turn")).toBe(
      "slash.compactApply.nextTurn",
    );
    expect(compactApplyEffectMessageKey("soft_respawn")).toBe(
      "slash.compactApply.softRespawn",
    );
    expect(compactApplyEffectMessageKey("unsupported")).toBe(
      "slash.compactApply.unsupported",
    );
    expect(compactApplyEffectMessageKey("idle")).toBe(
      "slash.compactApply.idle",
    );
  });

  it("maps effects to stable settings keys", () => {
    expect(compactSettingsApplyMessageKey("soft_respawn")).toBe(
      "settings.compactionApply.softRespawn",
    );
    expect(compactSettingsApplyMessageKey("idle")).toBe(
      "settings.compactionApply.nextSpawn",
    );
    expect(compactSettingsApplyMessageKey("unsupported")).toBe(
      "settings.compactionApply.unsupported",
    );
    expect(compactSettingsApplyMessageKey("next_turn")).toBe(
      "settings.compactionApply.nextSpawn",
    );
  });
});

describe("buildCompactPresetNote", () => {
  it("returns i18n keys for light / standard / aggressive", () => {
    expect(buildCompactPresetNote("light")).toEqual({
      preset: "light",
      messageKey: "slash.compactPresetNote.light",
    });
    expect(buildCompactPresetNote("standard")).toEqual({
      preset: "standard",
      messageKey: "slash.compactPresetNote.standard",
    });
    expect(buildCompactPresetNote("aggressive")).toEqual({
      preset: "aggressive",
      messageKey: "slash.compactPresetNote.aggressive",
    });
  });

  it("falls back to standard for unknown / empty", () => {
    expect(buildCompactPresetNote("heavy").preset).toBe("standard");
    expect(buildCompactPresetNote("").messageKey).toBe(
      "slash.compactPresetNote.standard",
    );
    expect(buildCompactPresetNote(null).messageKey).toBe(
      "slash.compactPresetNote.standard",
    );
    expect(buildCompactPresetNote(undefined).preset).toBe("standard");
  });
});

describe("resolveCompactDialogHonesty", () => {
  it("normalizes mode/detail and detailApplies for segments only", () => {
    const summary = resolveCompactDialogHonesty({
      mode: "summary",
      detail: "minimal",
    });
    expect(summary.mode).toBe("summary");
    expect(summary.detail).toBe("minimal");
    expect(summary.detailApplies).toBe(false);
    expect(summary.detailLabelKey).toBeNull();
    expect(summary.modeLabelKey).toBe("settings.compactionMode.summary");

    const segments = resolveCompactDialogHonesty({
      mode: "SEGMENTS",
      detail: " Balanced ",
    });
    expect(segments.mode).toBe("segments");
    expect(segments.detail).toBe("balanced");
    expect(segments.detailApplies).toBe(true);
    expect(segments.detailLabelKey).toBe("settings.compactionDetail.balanced");
  });

  it("never invents token savings without both known numbers", () => {
    expect(
      resolveCompactDialogHonesty({
        mode: "summary",
        detail: "verbose",
      }).tokensSaved,
    ).toBeNull();
    expect(
      resolveCompactDialogHonesty({
        mode: "summary",
        detail: "verbose",
        tokensBefore: 10_000,
      }).hasKnownSavings,
    ).toBe(false);
    expect(
      resolveCompactDialogHonesty({
        mode: "summary",
        detail: "verbose",
        tokensAfter: 3_000,
      }).tokensSaved,
    ).toBeNull();
    expect(
      resolveCompactDialogHonesty({
        mode: "summary",
        detail: "verbose",
        tokensBefore: Number.NaN,
        tokensAfter: 100,
      }).hasKnownSavings,
    ).toBe(false);
    expect(
      resolveCompactDialogHonesty({
        mode: "summary",
        detail: "verbose",
        tokensBefore: null,
        tokensAfter: null,
      }).savingsMessageKey,
    ).toBe("slash.compactApply.savingsUnknown");
  });

  it("reports savings only when both before and after are known", () => {
    const h = resolveCompactDialogHonesty({
      mode: "transcript",
      detail: "none",
      tokensBefore: 12_000.9,
      tokensAfter: 4_000.2,
    });
    expect(h.tokensBefore).toBe(12_000);
    expect(h.tokensAfter).toBe(4_000);
    expect(h.tokensSaved).toBe(8_000);
    expect(h.hasKnownSavings).toBe(true);
    expect(h.savingsMessageKey).toBe("slash.compactApply.savingsKnown");
    expect(h.savingsVars).toEqual({
      before: "12000",
      after: "4000",
      saved: "8000",
    });
  });

  it("allows negative savings when after > before (honest)", () => {
    const h = resolveCompactDialogHonesty({
      mode: "summary",
      detail: "verbose",
      tokensBefore: 100,
      tokensAfter: 150,
    });
    expect(h.tokensSaved).toBe(-50);
    expect(h.hasKnownSavings).toBe(true);
  });
});

describe("buildCompactDialogFooter", () => {
  it("composes apply + mode + savings banners", () => {
    const footer = buildCompactDialogFooter({
      hasLiveAgent: true,
      cliSupportsFlags: true,
      mode: "segments",
      detail: "minimal",
      tokensBefore: 8000,
      tokensAfter: 2000,
    });
    expect(footer.apply.messageKey).toBe("slash.compactApply.nextTurn");
    expect(footer.mode.messageKey).toBe("slash.compactApply.modeDetail");
    expect(footer.mode.vars).toEqual({ mode: "segments", detail: "minimal" });
    expect(footer.savings.messageKey).toBe("slash.compactApply.savingsKnown");
    expect(footer.dialog.tokensSaved).toBe(6000);
  });

  it("idle + unknown tokens → idle apply + unknown savings", () => {
    const footer = buildCompactDialogFooter({
      hasLiveAgent: false,
      cliSupportsFlags: true,
      mode: "summary",
      detail: "verbose",
    });
    expect(footer.apply.messageKey).toBe("slash.compactApply.idle");
    expect(footer.mode.messageKey).toBe("slash.compactApply.modeOnly");
    expect(footer.savings.messageKey).toBe(
      "slash.compactApply.savingsUnknown",
    );
  });

  it("live without CLI flags → unsupported apply", () => {
    const footer = buildCompactDialogFooter({
      hasLiveAgent: true,
      cliSupportsFlags: false,
      mode: "transcript",
      detail: "none",
    });
    expect(footer.apply.messageKey).toBe("slash.compactApply.unsupported");
  });
});

describe("product matrix", () => {
  const cases: Array<{
    name: string;
    live: boolean;
    flags: boolean;
    settings?: boolean;
    effect: ReturnType<typeof resolveCompactApplyEffect>;
  }> = [
    { name: "idle + flags", live: false, flags: true, effect: "idle" },
    { name: "idle + no flags", live: false, flags: false, effect: "idle" },
    {
      name: "live + no flags",
      live: true,
      flags: false,
      effect: "unsupported",
    },
    {
      name: "live + flags → next_turn",
      live: true,
      flags: true,
      effect: "next_turn",
    },
    {
      name: "live + flags + settings change → soft_respawn",
      live: true,
      flags: true,
      settings: true,
      effect: "soft_respawn",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        resolveCompactApplyEffect({
          hasLiveAgent: c.live,
          cliSupportsFlags: c.flags,
          forSettingsChange: c.settings,
        }),
      ).toBe(c.effect);
    });
  }
});
