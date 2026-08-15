import { describe, expect, it } from "vitest";
import {
  HOST_LSP_CLIENT_AVAILABLE,
  HOST_LSP_DIAGNOSTICS_AVAILABLE,
  LSP_TOOLS_CLI_DEFAULT,
  LSP_TOOLS_CONFIG_EDIT_ANCHOR,
  LSP_TOOLS_CONFIG_KEY,
  LSP_TOOLS_CONFIG_PATH,
  LSP_TOOLS_CONFIG_TABLE,
  LSP_TOOLS_MIN_CLI,
  LSP_TOOLS_SETTINGS_ANCHOR,
  buildLspToolsPatch,
  buildLspToolsStatusChips,
  buildLspToolsSummaryText,
  cliSupportsLspTools,
  compareCliVersions,
  effectiveLspToolsEnabled,
  hasLspToolsChanges,
  isLspToolsWritable,
  lspToolsBannerMessageKey,
  lspToolsConfigAssignment,
  lspToolsEnabledFromSnapshot,
  lspToolsPresence,
  lspToolsStatusChipLabelKey,
  lspToolsStatusMessageKey,
  lspToolsToggleChecked,
  planOpenLspDocs,
  resolveLspToolsBanners,
  resolveLspToolsEmptyState,
  resolveLspToolsStatus,
  toggleLspToolsTri,
} from "./lspToolsWorkbench";

describe("resolveLspToolsStatus", () => {
  it("host_only when not Tauri", () => {
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: true,
        mode: "independent",
        isTauri: false,
      }),
    ).toBe("host_only");
  });

  it("shared_readonly for shared mode or non-writable", () => {
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: false,
        mode: "shared",
      }),
    ).toBe("shared_readonly");
    expect(
      resolveLspToolsStatus({
        enabled: false,
        writable: false,
        mode: "independent",
      }),
    ).toBe("shared_readonly");
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: true,
        mode: "shared",
      }),
    ).toBe("shared_readonly");
  });

  it("cli_old when CLI known older than min", () => {
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: true,
        mode: "independent",
        cliVersion: "0.2.100",
        minCli: "0.2.117",
      }),
    ).toBe("cli_old");
  });

  it("maps enabled tri-state to on / off / unset", () => {
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: true,
        mode: "independent",
        cliVersion: "0.2.117",
      }),
    ).toBe("on");
    expect(
      resolveLspToolsStatus({
        enabled: false,
        writable: true,
        mode: "independent",
        cliVersion: "0.2.117",
      }),
    ).toBe("off");
    expect(
      resolveLspToolsStatus({
        enabled: null,
        writable: true,
        mode: "independent",
        cliVersion: "0.2.117",
      }),
    ).toBe("unset");
    expect(
      resolveLspToolsStatus({
        enabled: undefined,
        writable: true,
        mode: "independent",
      }),
    ).toBe("unset");
  });

  it("priority: host_only > shared_readonly > cli_old > enabled", () => {
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: false,
        mode: "shared",
        isTauri: false,
        cliVersion: "0.1.0",
      }),
    ).toBe("host_only");
    expect(
      resolveLspToolsStatus({
        enabled: true,
        writable: false,
        mode: "shared",
        cliVersion: "0.1.0",
      }),
    ).toBe("shared_readonly");
  });
});

describe("cliSupportsLspTools / compareCliVersions", () => {
  it("parses version tokens (≥ min)", () => {
    expect(cliSupportsLspTools("0.2.117")).toBe(true);
    expect(cliSupportsLspTools("grok 0.2.117 (abc)")).toBe(true);
    expect(cliSupportsLspTools("0.2.118")).toBe(true);
    expect(cliSupportsLspTools("0.3.0")).toBe(true);
    expect(cliSupportsLspTools("0.2.116")).toBe(false);
    expect(cliSupportsLspTools("0.1.99")).toBe(false);
  });

  it("returns null for unknown (soft-fail)", () => {
    expect(cliSupportsLspTools(null)).toBe(null);
    expect(cliSupportsLspTools(undefined)).toBe(null);
    expect(cliSupportsLspTools("")).toBe(null);
    expect(cliSupportsLspTools("nope")).toBe(null);
  });

  it("compareCliVersions orders correctly", () => {
    expect(compareCliVersions("0.2.117", "0.2.117")).toBe(0);
    expect(compareCliVersions("0.2.118", "0.2.117")).toBeGreaterThan(0);
    expect(compareCliVersions("0.2.100", "0.2.117")).toBeLessThan(0);
    expect(compareCliVersions("nope", "0.2.117")).toBe(null);
  });
});

describe("presence / effective / toggle", () => {
  it("never invents set_off for unset; CLI default is off", () => {
    expect(lspToolsPresence(null)).toBe("unset");
    expect(lspToolsPresence(undefined)).toBe("unset");
    expect(effectiveLspToolsEnabled(null)).toBe(LSP_TOOLS_CLI_DEFAULT);
    expect(effectiveLspToolsEnabled(null)).toBe(false);
    expect(lspToolsToggleChecked(null)).toBe(false);
    expect(lspToolsToggleChecked(true)).toBe(true);
    expect(lspToolsToggleChecked(false)).toBe(false);
  });

  it("toggle: unset → true, then flips", () => {
    expect(toggleLspToolsTri(null)).toBe(true);
    expect(toggleLspToolsTri(true)).toBe(false);
    expect(toggleLspToolsTri(false)).toBe(true);
  });

  it("enabledFromSnapshot soft-fails missing → null", () => {
    expect(lspToolsEnabledFromSnapshot({})).toBe(null);
    expect(lspToolsEnabledFromSnapshot({ lspToolsEnabled: true })).toBe(true);
    expect(lspToolsEnabledFromSnapshot({ lspToolsEnabled: false })).toBe(
      false,
    );
    expect(lspToolsEnabledFromSnapshot(null)).toBe(null);
  });
});

describe("buildLspToolsPatch", () => {
  it("only patches concrete bool flips", () => {
    expect(buildLspToolsPatch(true, null)).toEqual({
      lspToolsEnabled: true,
    });
    expect(hasLspToolsChanges(buildLspToolsPatch(true, null))).toBe(true);
    expect(buildLspToolsPatch(null, null)).toEqual({});
    expect(buildLspToolsPatch(true, true)).toEqual({});
    expect(hasLspToolsChanges({})).toBe(false);
  });

  it("does not patch null draft (unset stays unset)", () => {
    expect(buildLspToolsPatch(null, true)).toEqual({});
  });
});

describe("resolveLspToolsEmptyState / banners", () => {
  it("off: agent has no lsp tools", () => {
    const e = resolveLspToolsEmptyState("off");
    expect(e.kind).toBe("off");
    expect(e.titleKey).toBe("settings.lspTools.empty.off");
  });

  it("on: no App diagnostics honesty (never invents list)", () => {
    const e = resolveLspToolsEmptyState("on");
    expect(e.kind).toBe("no_diagnostics");
    expect(e.titleKey).toBe("settings.lspTools.empty.noDiagnostics");
    const onCopy = resolveLspToolsEmptyState("on", {
      preferNoDiagnosticsWhenOn: false,
    });
    expect(onCopy.kind).toBe("on");
  });

  it("unset / shared / cli_old / host_only map honestly", () => {
    expect(resolveLspToolsEmptyState("unset").kind).toBe("unset");
    expect(resolveLspToolsEmptyState("shared_readonly").kind).toBe(
      "shared_readonly",
    );
    expect(resolveLspToolsEmptyState("cli_old").kind).toBe("cli_old");
    expect(resolveLspToolsEmptyState("host_only").kind).toBe("host_only");
  });

  it("banners always include no_app_lsp + agent_tools_only; never fake diagnostics list", () => {
    const on = resolveLspToolsBanners("on");
    expect(on).toContain("no_app_lsp");
    expect(on).toContain("agent_tools_only");
    expect(on).toContain("no_diagnostics");
    expect(on).toContain("soft_respawn");
    expect(on).not.toContain("diagnostics_list" as never);

    const off = resolveLspToolsBanners("off");
    expect(off).toContain("no_app_lsp");
    expect(off).not.toContain("no_diagnostics");

    expect(lspToolsBannerMessageKey("no_app_lsp")).toBe(
      "settings.lspTools.banner.noAppLsp",
    );
  });
});

describe("buildLspToolsStatusChips", () => {
  it("includes status + always no_app_lsp", () => {
    expect(buildLspToolsStatusChips("on")).toEqual([
      "on",
      "no_app_lsp",
      "no_diagnostics",
    ]);
    expect(buildLspToolsStatusChips("unset")).toEqual([
      "unset",
      "cli_default_off",
      "no_app_lsp",
    ]);
    expect(buildLspToolsStatusChips("shared_readonly")).toContain(
      "shared_readonly",
    );
    expect(lspToolsStatusChipLabelKey("no_app_lsp")).toBe(
      "settings.lspTools.chip.noAppLsp",
    );
  });
});

describe("buildLspToolsSummaryText", () => {
  it("never invents diagnostics or server names", () => {
    const text = buildLspToolsSummaryText({
      status: "on",
      enabled: true,
      path: "/tmp/agent-home/config.toml",
      mode: "independent",
      cliVersion: "0.2.120",
    });
    expect(text).toContain("Status: on");
    expect(text).toContain(LSP_TOOLS_CONFIG_PATH);
    expect(text).toContain("does not run language servers");
    expect(text).toContain("does not show live diagnostics");
    expect(text.toLowerCase()).not.toContain("0 errors");
    expect(text.toLowerCase()).not.toContain("typescript-language-server");
  });

  it("off copy says agent has no lsp tools", () => {
    const text = buildLspToolsSummaryText({ status: "off", enabled: false });
    expect(text).toContain("agent has no lsp tools");
  });
});

describe("planOpenLspDocs", () => {
  it("honesty: App does not run language servers; CLI agent tools only", () => {
    const plan = planOpenLspDocs();
    expect(plan.runsLanguageServersInApp).toBe(false);
    expect(plan.agentToolsOnly).toBe(true);
    expect(plan.diagnosticsInApp).toBe(false);
    expect(plan.workbenchAnchorId).toBe(LSP_TOOLS_SETTINGS_ANCHOR);
    expect(plan.configEditAnchorId).toBe(LSP_TOOLS_CONFIG_EDIT_ANCHOR);
    expect(plan.externalDocsUrl).toBe(null);
    expect(plan.honestyNote.toLowerCase()).toContain("does not run language servers");
    expect(HOST_LSP_CLIENT_AVAILABLE).toBe(false);
    expect(HOST_LSP_DIAGNOSTICS_AVAILABLE).toBe(false);
  });

  it("accepts optional external docs without inventing one", () => {
    const plan = planOpenLspDocs({
      externalDocsUrl: "https://example.com/lsp",
    });
    expect(plan.externalDocsUrl).toBe("https://example.com/lsp");
    expect(plan.runsLanguageServersInApp).toBe(false);
  });
});

describe("isLspToolsWritable / assignment / status keys", () => {
  it("writable only independent + writable + tauri", () => {
    expect(
      isLspToolsWritable({
        writable: true,
        mode: "independent",
        isTauri: true,
      }),
    ).toBe(true);
    expect(
      isLspToolsWritable({
        writable: true,
        mode: "shared",
      }),
    ).toBe(false);
    expect(
      isLspToolsWritable({
        writable: false,
        mode: "independent",
      }),
    ).toBe(false);
    expect(
      isLspToolsWritable({
        writable: true,
        mode: "independent",
        isTauri: false,
      }),
    ).toBe(false);
  });

  it("config assignment and constants", () => {
    expect(lspToolsConfigAssignment(true)).toBe("lsp_tools = true");
    expect(lspToolsConfigAssignment(false)).toBe("lsp_tools = false");
    expect(lspToolsConfigAssignment(null)).toBe("lsp_tools = false");
    expect(LSP_TOOLS_CONFIG_TABLE).toBe("features");
    expect(LSP_TOOLS_CONFIG_KEY).toBe("lsp_tools");
    expect(LSP_TOOLS_CONFIG_PATH).toBe("[features] lsp_tools");
    expect(LSP_TOOLS_MIN_CLI).toBe("0.2.117");
    expect(LSP_TOOLS_CLI_DEFAULT).toBe(false);
    expect(lspToolsStatusMessageKey("on")).toBe("settings.lspTools.status.on");
    expect(lspToolsStatusMessageKey("host_only")).toBe(
      "settings.lspTools.status.hostOnly",
    );
  });
});
