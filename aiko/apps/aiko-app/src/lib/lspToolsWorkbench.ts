/**
 * Pure helpers for LSP tools workbench honesty (`[features].lsp_tools`).
 *
 * Product rules:
 * - Config toggle only — App has **no** language-server protocol client.
 * - Never invent diagnostics lists, server health, or live IDE status.
 * - When off/unset (CLI default off), the agent has no `lsp` tools.
 * - When on, the CLI agent *may* use lsp tools if servers are configured —
 *   App still does not show live diagnostics.
 * - Writes are independent agent-home only; shared mode is read-only.
 * - Soft-fail when CLI is known older than the documented surface.
 */

/** Config table for the feature flag. */
export const LSP_TOOLS_CONFIG_TABLE = "features";

/** Config key under `[features]`. */
export const LSP_TOOLS_CONFIG_KEY = "lsp_tools";

/** Full config path string for UI hints. */
export const LSP_TOOLS_CONFIG_PATH = "[features] lsp_tools";

/**
 * CLI documented default when the key is **unset** in config.toml.
 * Honesty: UI must show “unset” + “CLI default off”, not claim the key is set off.
 */
export const LSP_TOOLS_CLI_DEFAULT = false;

/** First CLI that documents this surface (features batch / user-guide 0.2.117). */
export const LSP_TOOLS_MIN_CLI = "0.2.117";

/** Settings anchor for the dedicated LSP tools card. */
export const LSP_TOOLS_SETTINGS_ANCHOR = "settings-anchor-lspTools";

/** Settings anchor for the broader agent config.toml section editor. */
export const LSP_TOOLS_CONFIG_EDIT_ANCHOR = "settings-anchor-configTomlEdit";

/** App never runs language servers itself (flip only if a real LSP client ships). */
export const HOST_LSP_CLIENT_AVAILABLE = false;

/** App never invents a live diagnostics surface (flip only when real). */
export const HOST_LSP_DIAGNOSTICS_AVAILABLE = false;

/**
 * Resolved product status for chips / banners.
 *
 * Priority (first match wins):
 * 1. `host_only` — not desktop / host unavailable
 * 2. `shared_readonly` — shared mode or not writable
 * 3. `cli_old` — CLI known older than min surface
 * 4. `unset` | `on` | `off` — from the config key
 */
export type LspToolsStatus =
  | "off"
  | "on"
  | "unset"
  | "shared_readonly"
  | "cli_old"
  | "host_only";

export type ResolveLspToolsStatusOpts = {
  /**
   * Bool form of `[features].lsp_tools`.
   * - `true` / `false` — set
   * - `null` / `undefined` — unset (CLI default off)
   */
  enabled: boolean | null | undefined;
  /** Host write gate (independent agent-home only). */
  writable?: boolean | null;
  /** `independent` | `shared` (case-insensitive). */
  mode?: string | null;
  /** Optional probed CLI version for soft-fail. */
  cliVersion?: string | null;
  /**
   * Minimum CLI that documents lsp_tools.
   * Defaults to {@link LSP_TOOLS_MIN_CLI}.
   */
  minCli?: string | null;
  /**
   * `api.isTauri()` — false → `host_only`.
   * Default true when omitted (optimistic once a snapshot was loaded).
   */
  isTauri?: boolean | null;
};

/** Compare two `x.y.z` versions. Returns null when either is unparseable. */
export function compareCliVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parse = (raw: string | null | undefined) => {
    if (raw == null) return null;
    const m = String(raw).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3] ?? "0");
    if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
    return { major, minor, patch };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/**
 * Soft-gate: whether the CLI is known to document `[features].lsp_tools`.
 * - Known ≥ min → true
 * - Known older → false
 * - Unknown / unparseable → null (soft-fail: still allow config write)
 */
export function cliSupportsLspTools(
  rawVersion: string | null | undefined,
  minCli: string = LSP_TOOLS_MIN_CLI,
): boolean | null {
  const cmp = compareCliVersions(rawVersion, minCli);
  if (cmp == null) return null;
  return cmp >= 0;
}

function normalizeMode(mode: string | null | undefined): "independent" | "shared" | null {
  if (mode == null) return null;
  const t = String(mode).trim().toLowerCase();
  if (!t) return null;
  if (t === "shared") return "shared";
  if (t === "independent") return "independent";
  return null;
}

/**
 * Resolve LSP tools product status (mutually exclusive chip id).
 *
 * Does **not** invent diagnostics or server lists — status is config + host
 * honesty only.
 */
export function resolveLspToolsStatus(
  opts: ResolveLspToolsStatusOpts,
): LspToolsStatus {
  if (opts.isTauri === false) return "host_only";

  const mode = normalizeMode(opts.mode);
  const writable = opts.writable === true;
  if (mode === "shared" || opts.writable === false) {
    return "shared_readonly";
  }
  // Writable unknown + non-shared: continue (e.g. pure unit tests with only enabled).
  void writable;

  const min = (opts.minCli ?? LSP_TOOLS_MIN_CLI).trim() || LSP_TOOLS_MIN_CLI;
  if (cliSupportsLspTools(opts.cliVersion, min) === false) {
    return "cli_old";
  }

  if (opts.enabled === true) return "on";
  if (opts.enabled === false) return "off";
  return "unset";
}

/** Effective agent-tool availability (CLI semantics). Unset → CLI default off. */
export function effectiveLspToolsEnabled(
  enabled: boolean | null | undefined,
  cliDefault: boolean = LSP_TOOLS_CLI_DEFAULT,
): boolean {
  if (enabled === true) return true;
  if (enabled === false) return false;
  return cliDefault === true;
}

/** Toggle checked only when the key is explicitly set on (not “default off”). */
export function lspToolsToggleChecked(
  enabled: boolean | null | undefined,
): boolean {
  return enabled === true;
}

/**
 * Toggle for simple bool/unset form:
 * - null (unset) → true (first write enables)
 * - true → false
 * - false → true
 */
export function toggleLspToolsTri(
  current: boolean | null | undefined,
): boolean {
  if (current === true) return false;
  return true;
}

/** Presence label id for the key on disk. */
export function lspToolsPresence(
  enabled: boolean | null | undefined,
): "set_on" | "set_off" | "unset" {
  if (enabled === true) return "set_on";
  if (enabled === false) return "set_off";
  return "unset";
}

/** Whether writes are allowed (independent mode only). */
export function isLspToolsWritable(opts: {
  writable?: boolean | null;
  mode?: string | null;
  isTauri?: boolean | null;
}): boolean {
  if (opts.isTauri === false) return false;
  if (opts.writable !== true) return false;
  if (normalizeMode(opts.mode) === "shared") return false;
  return true;
}

// ── Empty / banner honesty ──────────────────────────────────────────────────

export type LspToolsEmptyKind =
  | "off"
  | "on"
  | "unset"
  | "shared_readonly"
  | "cli_old"
  | "host_only"
  | "no_diagnostics";

export type LspToolsEmptyPresentation = {
  kind: LspToolsEmptyKind;
  /** i18n MessageKey (settings.lspTools.empty.*). */
  titleKey:
    | "settings.lspTools.empty.off"
    | "settings.lspTools.empty.on"
    | "settings.lspTools.empty.unset"
    | "settings.lspTools.empty.sharedReadonly"
    | "settings.lspTools.empty.cliOld"
    | "settings.lspTools.empty.hostOnly"
    | "settings.lspTools.empty.noDiagnostics";
  hintKey?:
    | "settings.lspTools.empty.offHint"
    | "settings.lspTools.empty.onHint"
    | "settings.lspTools.empty.unsetHint"
    | "settings.lspTools.empty.sharedReadonlyHint"
    | "settings.lspTools.empty.cliOldHint"
    | "settings.lspTools.empty.hostOnlyHint"
    | "settings.lspTools.empty.noDiagnosticsHint";
};

/**
 * Honesty empty / banner for the status surface.
 *
 * Always includes “no App diagnostics” when the agent tools may be on —
 * never invents a diagnostics list empty-state as “0 problems”.
 */
export function resolveLspToolsEmptyState(
  status: LspToolsStatus,
  opts?: {
    /** Prefer the no-diagnostics honesty banner when status is on. Default true. */
    preferNoDiagnosticsWhenOn?: boolean;
  },
): LspToolsEmptyPresentation {
  switch (status) {
    case "host_only":
      return {
        kind: "host_only",
        titleKey: "settings.lspTools.empty.hostOnly",
        hintKey: "settings.lspTools.empty.hostOnlyHint",
      };
    case "shared_readonly":
      return {
        kind: "shared_readonly",
        titleKey: "settings.lspTools.empty.sharedReadonly",
        hintKey: "settings.lspTools.empty.sharedReadonlyHint",
      };
    case "cli_old":
      return {
        kind: "cli_old",
        titleKey: "settings.lspTools.empty.cliOld",
        hintKey: "settings.lspTools.empty.cliOldHint",
      };
    case "unset":
      return {
        kind: "unset",
        titleKey: "settings.lspTools.empty.unset",
        hintKey: "settings.lspTools.empty.unsetHint",
      };
    case "off":
      return {
        kind: "off",
        titleKey: "settings.lspTools.empty.off",
        hintKey: "settings.lspTools.empty.offHint",
      };
    case "on":
    default: {
      const preferNoDiag = opts?.preferNoDiagnosticsWhenOn !== false;
      if (preferNoDiag) {
        return {
          kind: "no_diagnostics",
          titleKey: "settings.lspTools.empty.noDiagnostics",
          hintKey: "settings.lspTools.empty.noDiagnosticsHint",
        };
      }
      return {
        kind: "on",
        titleKey: "settings.lspTools.empty.on",
        hintKey: "settings.lspTools.empty.onHint",
      };
    }
  }
}

/** Soft banner ids for chips under the card. */
export type LspToolsBannerId =
  | "shared_readonly"
  | "cli_old"
  | "host_only"
  | "soft_respawn"
  | "no_app_lsp"
  | "agent_tools_only"
  | "no_diagnostics";

/**
 * Ordered honesty banners for the panel (status-driven + always-on product rules).
 * Never includes a fake diagnostics list banner claiming zero findings.
 */
export function resolveLspToolsBanners(
  status: LspToolsStatus,
  opts?: { includeSoftRespawn?: boolean },
): LspToolsBannerId[] {
  const banners: LspToolsBannerId[] = [];

  if (status === "host_only") banners.push("host_only");
  if (status === "shared_readonly") banners.push("shared_readonly");
  if (status === "cli_old") banners.push("cli_old");

  // Always-on product honesty.
  banners.push("no_app_lsp");
  banners.push("agent_tools_only");

  if (status === "on" || status === "cli_old") {
    banners.push("no_diagnostics");
  }

  if (opts?.includeSoftRespawn !== false && status !== "host_only") {
    banners.push("soft_respawn");
  }

  return banners;
}

export function lspToolsBannerMessageKey(
  id: LspToolsBannerId,
):
  | "settings.lspTools.banner.sharedReadonly"
  | "settings.lspTools.banner.cliOld"
  | "settings.lspTools.banner.hostOnly"
  | "settings.lspTools.banner.softRespawn"
  | "settings.lspTools.banner.noAppLsp"
  | "settings.lspTools.banner.agentToolsOnly"
  | "settings.lspTools.banner.noDiagnostics" {
  switch (id) {
    case "shared_readonly":
      return "settings.lspTools.banner.sharedReadonly";
    case "cli_old":
      return "settings.lspTools.banner.cliOld";
    case "host_only":
      return "settings.lspTools.banner.hostOnly";
    case "soft_respawn":
      return "settings.lspTools.banner.softRespawn";
    case "agent_tools_only":
      return "settings.lspTools.banner.agentToolsOnly";
    case "no_diagnostics":
      return "settings.lspTools.banner.noDiagnostics";
    case "no_app_lsp":
    default:
      return "settings.lspTools.banner.noAppLsp";
  }
}

// ── Status chips ────────────────────────────────────────────────────────────

export type LspToolsStatusChipId =
  | "off"
  | "on"
  | "unset"
  | "shared_readonly"
  | "cli_old"
  | "host_only"
  | "cli_default_off"
  | "no_app_lsp"
  | "no_diagnostics";

/**
 * Ordered status chips for the card header.
 * Always appends no-App-LSP honesty; no diagnostics chip when off/unset.
 */
export function buildLspToolsStatusChips(
  status: LspToolsStatus,
): LspToolsStatusChipId[] {
  const chips: LspToolsStatusChipId[] = [];

  switch (status) {
    case "host_only":
      chips.push("host_only");
      break;
    case "shared_readonly":
      chips.push("shared_readonly");
      break;
    case "cli_old":
      chips.push("cli_old");
      break;
    case "on":
      chips.push("on");
      break;
    case "off":
      chips.push("off");
      break;
    case "unset":
      chips.push("unset", "cli_default_off");
      break;
    default:
      break;
  }

  chips.push("no_app_lsp");
  if (status === "on" || status === "cli_old") {
    chips.push("no_diagnostics");
  }
  return chips;
}

export function lspToolsStatusChipLabelKey(
  chip: LspToolsStatusChipId,
):
  | "settings.lspTools.chip.off"
  | "settings.lspTools.chip.on"
  | "settings.lspTools.chip.unset"
  | "settings.lspTools.chip.sharedReadonly"
  | "settings.lspTools.chip.cliOld"
  | "settings.lspTools.chip.hostOnly"
  | "settings.lspTools.chip.cliDefaultOff"
  | "settings.lspTools.chip.noAppLsp"
  | "settings.lspTools.chip.noDiagnostics" {
  switch (chip) {
    case "on":
      return "settings.lspTools.chip.on";
    case "off":
      return "settings.lspTools.chip.off";
    case "unset":
      return "settings.lspTools.chip.unset";
    case "shared_readonly":
      return "settings.lspTools.chip.sharedReadonly";
    case "cli_old":
      return "settings.lspTools.chip.cliOld";
    case "host_only":
      return "settings.lspTools.chip.hostOnly";
    case "cli_default_off":
      return "settings.lspTools.chip.cliDefaultOff";
    case "no_diagnostics":
      return "settings.lspTools.chip.noDiagnostics";
    case "no_app_lsp":
    default:
      return "settings.lspTools.chip.noAppLsp";
  }
}

// ── Summary text (copy / debug) ─────────────────────────────────────────────

export type BuildLspToolsSummaryTextOpts = {
  status: LspToolsStatus;
  enabled?: boolean | null;
  path?: string | null;
  mode?: string | null;
  cliVersion?: string | null;
  minCli?: string | null;
};

/**
 * Plain-English summary for copy. Never invents server names or diagnostics.
 */
export function buildLspToolsSummaryText(
  opts: BuildLspToolsSummaryTextOpts,
): string {
  const min = (opts.minCli ?? LSP_TOOLS_MIN_CLI).trim() || LSP_TOOLS_MIN_CLI;
  const presence = lspToolsPresence(opts.enabled);
  const effective = effectiveLspToolsEnabled(opts.enabled);
  const lines: string[] = [
    "LSP tools (Aiko App workbench honesty)",
    `Config: ${LSP_TOOLS_CONFIG_PATH}`,
    `Status: ${opts.status}`,
    `Presence: ${presence}`,
    `Effective (CLI default off when unset): ${effective ? "on" : "off"}`,
    "App does not run language servers itself.",
    "App does not show live diagnostics — CLI agent tools only when enabled.",
  ];

  if (opts.mode) lines.push(`Mode: ${opts.mode}`);
  if (opts.path) lines.push(`Path: ${opts.path}`);
  if (opts.cliVersion) lines.push(`CLI: ${opts.cliVersion}`);
  lines.push(`Min CLI surface: ${min}`);

  switch (opts.status) {
    case "off":
      lines.push("When off, the agent has no lsp tools.");
      break;
    case "unset":
      lines.push(
        "Key is unset — CLI default is off (agent has no lsp tools until enabled).",
      );
      break;
    case "on":
      lines.push(
        "When on, the CLI agent may use lsp tools if servers are configured in agent config — App still has no live diagnostics.",
      );
      break;
    case "shared_readonly":
      lines.push(
        "Shared mode is read-only — switch to independent agent-home to write the flag.",
      );
      break;
    case "cli_old":
      lines.push(
        `CLI may be older than ${min}; lsp_tools may be ignored (soft-fail).`,
      );
      break;
    case "host_only":
      lines.push("Desktop host required to read or write agent-home config.");
      break;
    default:
      break;
  }

  return lines.join("\n");
}

// ── Docs / open plan ────────────────────────────────────────────────────────

export type LspDocsPlan = {
  /** Always false today — App has no LSP protocol client. */
  runsLanguageServersInApp: false;
  /** Tools are CLI agent-side only when the flag is on. */
  agentToolsOnly: true;
  /** Never invent a live diagnostics surface. */
  diagnosticsInApp: false;
  /** Settings anchor for this card. */
  workbenchAnchorId: string;
  /** Optional jump to broader config.toml section editor. */
  configEditAnchorId: string;
  /** External docs URL — null means do not invent a docs site. */
  externalDocsUrl: string | null;
  /** English honesty note for UI / clipboard. */
  honestyNote: string;
};

export type PlanOpenLspDocsOpts = {
  /** Optional external docs URL only when the product truly has one. */
  externalDocsUrl?: string | null;
  workbenchAnchorId?: string;
  configEditAnchorId?: string;
};

/**
 * Plan “open docs / config” action.
 *
 * Honesty: App does not run language servers — point at config section /
 * honesty copy only. Never invents a fake diagnostics page or LSP client UI.
 */
export function planOpenLspDocs(
  opts: PlanOpenLspDocsOpts = {},
): LspDocsPlan {
  const url = (opts.externalDocsUrl ?? "").trim() || null;
  return {
    runsLanguageServersInApp: false,
    agentToolsOnly: true,
    diagnosticsInApp: false,
    workbenchAnchorId:
      (opts.workbenchAnchorId ?? "").trim() || LSP_TOOLS_SETTINGS_ANCHOR,
    configEditAnchorId:
      (opts.configEditAnchorId ?? "").trim() || LSP_TOOLS_CONFIG_EDIT_ANCHOR,
    externalDocsUrl: url,
    honestyNote:
      "Aiko App does not run language servers or show live diagnostics. " +
      `[features].lsp_tools` +
      " only exposes CLI agent lsp tools when enabled and servers are configured in agent config.",
  };
}

/** Config.toml assignment line for independent agent-home writes (bool only). */
export function lspToolsConfigAssignment(
  enabled: boolean | null | undefined,
): string {
  const v = enabled === true;
  return `${LSP_TOOLS_CONFIG_KEY} = ${v}`;
}

/** Host patch shape for agentConfigEditSet (only lspToolsEnabled). */
export type LspToolsConfigPatch = {
  lspToolsEnabled?: boolean | null;
};

/** Build a host patch from draft vs baseline (only concrete bool flips). */
export function buildLspToolsPatch(
  draftEnabled: boolean | null | undefined,
  baselineEnabled: boolean | null | undefined,
): LspToolsConfigPatch {
  const patch: LspToolsConfigPatch = {};
  // Normalize undefined → null for comparison; only write concrete bools.
  const d = draftEnabled === true ? true : draftEnabled === false ? false : null;
  const b =
    baselineEnabled === true
      ? true
      : baselineEnabled === false
        ? false
        : null;
  if (d !== b && d !== null) {
    patch.lspToolsEnabled = d;
  }
  return patch;
}

export function hasLspToolsChanges(patch: LspToolsConfigPatch): boolean {
  return patch.lspToolsEnabled != null;
}

/**
 * Map host snapshot field → UI tri-state.
 * Soft-fail missing → null (unset); never invent CLI default as set_off.
 */
export function lspToolsEnabledFromSnapshot(
  snap: { lspToolsEnabled?: boolean | null } | null | undefined,
): boolean | null {
  if (snap?.lspToolsEnabled === true) return true;
  if (snap?.lspToolsEnabled === false) return false;
  return null;
}

/** i18n status line key for a resolved status. */
export function lspToolsStatusMessageKey(
  status: LspToolsStatus,
):
  | "settings.lspTools.status.off"
  | "settings.lspTools.status.on"
  | "settings.lspTools.status.unset"
  | "settings.lspTools.status.sharedReadonly"
  | "settings.lspTools.status.cliOld"
  | "settings.lspTools.status.hostOnly" {
  switch (status) {
    case "on":
      return "settings.lspTools.status.on";
    case "off":
      return "settings.lspTools.status.off";
    case "unset":
      return "settings.lspTools.status.unset";
    case "shared_readonly":
      return "settings.lspTools.status.sharedReadonly";
    case "cli_old":
      return "settings.lspTools.status.cliOld";
    case "host_only":
    default:
      return "settings.lspTools.status.hostOnly";
  }
}
