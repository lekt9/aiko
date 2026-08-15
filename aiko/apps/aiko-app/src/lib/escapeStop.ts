/**
 * Esc → stop generation gate.
 *
 * Shortcuts catalog documents Esc as “Stop generation / close overlay”.
 * Overlays, permission, ask-user, find, menus, and voice own Escape first;
 * stop only when the turn is busy and nothing else claims the key.
 */

export type EscapeStopOpts = {
  /** True when Stop is available (streaming / awaiting permission / latch). */
  streamingOrBusy: boolean;
  /** Search, dialogs, doctor, shortcuts help, export modal, etc. */
  overlayOpen: boolean;
  /** Permission bar owns Esc → deny. */
  permOpen: boolean;
  /** Ask-user questionnaire modal. */
  askUserOpen: boolean;
  /** In-chat find bar. */
  chatFindOpen: boolean;
  /** Slash palette, composer +, context menu, user menu, phone tools. */
  slashOrMenuOpen: boolean;
  /** Prompt history picker. */
  promptHistoryOpen?: boolean;
  /** In-progress voice dictation steals Esc. */
  voiceStealsEscape?: boolean;
};

/**
 * Whether global Escape should call `stop()` instead of doing nothing.
 * True only when a stoppable turn is active and no higher-priority owner
 * of Escape is open.
 */
export function shouldEscapeStopGeneration(opts: EscapeStopOpts): boolean {
  if (!opts.streamingOrBusy) return false;
  if (opts.voiceStealsEscape) return false;
  if (opts.overlayOpen) return false;
  if (opts.permOpen) return false;
  if (opts.askUserOpen) return false;
  if (opts.chatFindOpen) return false;
  if (opts.slashOrMenuOpen) return false;
  if (opts.promptHistoryOpen) return false;
  return true;
}
