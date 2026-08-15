/**
 * Auto-wake (CLI config `auto_wake_enabled`) — pure normalize helpers.
 *
 * When enabled, Aiko may inject a synthetic turn after background
 * work completes (bash / monitor / task completion, scheduled loops) so the
 * agent can react without a new user prompt. Behavior is entirely CLI-side.
 *
 * - Config key (agent-home independent mode): top-level `auto_wake_enabled`.
 * - No well-documented CLI flag. Env `GROK_AUTO_WAKE` appears pattern-shaped
 *   (wildcards) in the CLI binary — App does **not** invent 0/1 env overrides.
 * - App default: **off** (opt-in). Soft-respawn after change so the next agent
 *   process reloads independent agent-home config. Older / unknown CLIs that
 *   ignore the key soft-fail (config write is still safe).
 */

/** Top-level config.toml key. */
export const AUTO_WAKE_CONFIG_KEY = "auto_wake_enabled";

/**
 * Normalize the enable toggle.
 * null / undefined → false (App opt-in default; CLI default not documented).
 */
export function normalizeAutoWakeEnabled(
  raw: boolean | null | undefined,
): boolean {
  return raw === true;
}

/**
 * Config.toml assignment line for independent agent-home writes.
 * Example: `auto_wake_enabled = true`
 */
export function autoWakeConfigAssignment(
  enabled: boolean | null | undefined,
): string {
  return `${AUTO_WAKE_CONFIG_KEY} = ${normalizeAutoWakeEnabled(enabled)}`;
}

/** True when two raw toggles normalize equal (soft-respawn flip check). */
export function autoWakeEqual(
  a: boolean | null | undefined,
  b: boolean | null | undefined,
): boolean {
  return normalizeAutoWakeEnabled(a) === normalizeAutoWakeEnabled(b);
}
