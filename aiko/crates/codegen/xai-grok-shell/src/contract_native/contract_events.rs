//! Neuron event injection — appends compact `⟐`-prefixed event lines to
//! tool result messages so the LLM can introspect on its own membrane
//! activity in real time.
//!
//! Gated by env var `AIKO_NEURON_EVENTS` (default "off"):
//!   - "off"     → no events (zero overhead)
//!   - "minimal" → one-liner: `⟐ tool_name ✓ 25ms`
//!   - "compact" → energy delta + step: `⟐ tool_name e:-0.50→-0.48 ✓ 25ms delib→verify`

const ENV_VAR: &str = "AIKO_NEURON_EVENTS";
const PREFIX: &str = "\u{27d0}"; // U+27D0 LOZENGE — stable anchor, never in tool output
const CHECK: &str = "\u{2713}"; // ✓
const CROSS: &str = "\u{2717}"; // ✗

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Variant {
    Off,
    Minimal,
    Compact,
}

impl Variant {
    pub fn from_env() -> Self {
        match std::env::var(ENV_VAR).ok().as_deref() {
            Some("minimal") => Self::Minimal,
            Some("compact") => Self::Compact,
            Some("1" | "true" | "on" | "yes") => Self::Compact, // legacy: "on" = compact
            _ => Self::Off,
        }
    }
}

/// Format a neuron firing event line for a tool call.
///
/// The event line is appended to the tool result's text content before the
/// message is pushed to chat history. Returns `None` when the variant is
/// `Off` — the caller writes no extra bytes to the tool result.
pub(crate) fn format_firing_event(
    variant: Variant,
    tool_name: &str,
    duration_ms: u64,
    settled: bool,
) -> Option<String> {
    if variant == Variant::Off {
        return None;
    }
    let verdict = if settled { CHECK } else { CROSS };
    let dur = if duration_ms > 0 {
        format!("{duration_ms}ms")
    } else {
        String::new()
    };

    if variant == Variant::Minimal {
        let parts: Vec<&str> = vec![tool_name, verdict, &dur]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
        return Some(format!("{PREFIX} {}\n", parts.join(" ")));
    }

    // Compact: tool_name ✓ 25ms
    let parts: Vec<&str> = vec![tool_name, verdict, &dur]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    Some(format!("{PREFIX} {}\n", parts.join(" ")))
}

/// Format a step transition event line.
pub(super) fn format_step_event(
    variant: Variant,
    step_from: &str,
    step_to: &str,
    completed: bool,
) -> Option<String> {
    if variant == Variant::Off {
        return None;
    }
    let verdict = if completed { CHECK } else { CROSS };
    Some(format!(
        "{PREFIX} step:{step_from}\u{2192}{step_to} {verdict}\n"
    ))
}
