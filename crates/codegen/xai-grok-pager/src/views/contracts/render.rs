//! Contracts view rendering.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use super::layout;
use super::state::ContractsState;
use crate::render::line_utils::truncate_str;
use crate::theme::Theme;

/// Render the contracts view into the given buffer area.
///
/// Returns `Some((row, col))` for the cursor position, or `None` if no cursor
/// is shown (e.g., empty list).
pub fn render_contracts(
    buf: &mut Buffer,
    area: Rect,
    state: &mut ContractsState,
) -> Option<(u16, u16)> {
    let theme = Theme::current();
    state.last_area = area;

    // Fill background.
    buf.set_style(area, Style::default().bg(theme.bg_base));

    // ── Header ──────────────────────────────────────────────────────────
    let header = layout::header_area(area);
    render_header(buf, header, state, &theme);

    // ── List ────────────────────────────────────────────────────────────
    let list = layout::list_area(area);
    let row_rects = render_list(buf, list, state, &theme);
    state.row_rects = row_rects;

    // ── Footer ──────────────────────────────────────────────────────────
    let footer = layout::footer_area(area);
    render_footer(buf, footer, state, &theme);

    // ── Toast / error overlay ───────────────────────────────────────────
    if let Some(msg) = state.toast.as_deref().or(state.error.as_deref()) {
        render_toast(buf, area, msg, &theme);
    }

    // ── Inspect detail popup ────────────────────────────────────────────
    if state.inspect_detail.is_some() {
        render_inspect_detail(buf, area, state, &theme);
    }

    // Cursor lands on the selected row, column 0.
    if !state.entries.is_empty() {
        let visible_idx = state.selected.saturating_sub(state.scroll);
        let row_y = list.y.saturating_add(visible_idx as u16);
        if row_y < list.y.saturating_add(list.height) {
            return Some((row_y, 0));
        }
    }
    None
}

fn render_header(buf: &mut Buffer, area: Rect, state: &ContractsState, theme: &Theme) {
    // Title line.
    let title = "Contract Tasks";
    let subtitle = if state.loading {
        "Loading…".to_string()
    } else {
        let total = state.entries.len();
        let active = state.entries.iter().filter(|e| e.is_active()).count();
        let satisfied = state
            .entries
            .iter()
            .filter(|e| e.status == "satisfied")
            .count();
        let failed = state
            .entries
            .iter()
            .filter(|e| e.status == "failed")
            .count();
        format!(
            "{} total — {} active, {} satisfied, {} failed",
            total, active, satisfied, failed
        )
    };

    let title_span = Span::styled(
        title,
        Style::default()
            .fg(theme.text_primary)
            .add_modifier(Modifier::BOLD),
    );
    let sub_span = Span::styled(subtitle, Style::default().fg(theme.gray_dim));

    buf.set_span(area.x, area.y, &title_span, area.width);
    if area.height > 1 {
        buf.set_span(area.x, area.y + 1, &sub_span, area.width);
    }
}

fn render_list(buf: &mut Buffer, area: Rect, state: &ContractsState, theme: &Theme) -> Vec<Rect> {
    if area.height == 0 {
        return Vec::new();
    }

    if state.loading {
        let loading = Span::styled(
            "Loading contract tasks…",
            Style::default().fg(theme.gray_dim),
        );
        buf.set_span(area.x, area.y, &loading, area.width);
        return Vec::new();
    }

    if state.entries.is_empty() {
        let empty = Span::styled(
            "No contract tasks. Use `contract task begin --check \"<goal>\"` to create one.",
            Style::default().fg(theme.gray_dim),
        );
        buf.set_span(area.x, area.y, &empty, area.width);
        return Vec::new();
    }

    let visible_rows = area.height as usize;
    let mut row_rects = Vec::new();

    for (visible_idx, entry_idx) in (state.scroll..state.entries.len())
        .take(visible_rows)
        .enumerate()
    {
        let entry = &state.entries[entry_idx];
        let y = area.y.saturating_add(visible_idx as u16);
        let row_rect = Rect {
            x: area.x,
            y,
            width: area.width,
            height: 1,
        };
        row_rects.push(row_rect);

        let is_selected = entry_idx == state.selected;
        let is_hovered = state.hovered_row == Some(entry_idx);

        let row_bg = if is_selected {
            theme.bg_highlight
        } else if is_hovered {
            theme.bg_hover
        } else {
            theme.bg_base
        };

        // Status icon.
        let (status_icon, status_color) = status_icon_and_color(&entry.status, theme);

        // Selection bar on the left edge (like dashboard rows).
        if is_selected {
            let bar_style = Style::default().bg(row_bg).fg(theme.accent_user);
            buf.set_string(
                row_rect.x,
                row_rect.y,
                crate::glyphs::selection_bar(),
                bar_style,
            );
        }

        // Build the row spans.
        let icon_span = Span::styled(
            format!(" {} ", status_icon),
            Style::default()
                .fg(status_color)
                .add_modifier(Modifier::BOLD)
                .bg(row_bg),
        );
        let id_span = Span::styled(
            format!("{:>8} ", entry.id),
            Style::default().fg(theme.gray_dim).bg(row_bg),
        );
        // Truncate prompt to fit remaining width.
        let prompt_available = area
            .width
            .saturating_sub(3 + 9) // icon(3) + id(8) + spacer
            .max(10);
        let prompt_text = truncate_str(&entry.prompt, prompt_available as usize);
        let prompt_span = Span::styled(
            prompt_text,
            Style::default().fg(theme.text_primary).bg(row_bg),
        );

        let line = Line::from(vec![icon_span, id_span, prompt_span]);
        buf.set_line(row_rect.x, row_rect.y, &line, row_rect.width);
        // Ensure full row background.
        buf.set_style(row_rect, Style::default().bg(row_bg));
    }

    row_rects
}

fn status_icon_and_color(status: &str, theme: &Theme) -> (&'static str, Color) {
    match status {
        "active" => ("◉", theme.accent_running),
        "pending" => ("○", theme.gray_dim),
        "satisfied" => ("✓", theme.accent_success),
        "failed" => ("✗", theme.accent_error),
        "cancelled" => ("✗", theme.gray_dim),
        _ => ("?", theme.gray_dim),
    }
}

fn render_footer(buf: &mut Buffer, area: Rect, state: &ContractsState, theme: &Theme) {
    if area.height == 0 || area.width == 0 {
        return;
    }

    let help = if state.inspect_detail.is_some() {
        "Esc close  ↑↓ scroll".to_string()
    } else if state.entries.is_empty() {
        "Ctrl+Shift+C close  r refresh".to_string()
    } else {
        "↑↓ nav  Enter inspect  r refresh  Ctrl+Shift+C close".to_string()
    };

    let span = Span::styled(help, Style::default().fg(theme.gray_dim));
    buf.set_span(area.x, area.y, &span, area.width);
}

fn render_toast(buf: &mut Buffer, area: Rect, msg: &str, theme: &Theme) {
    let toast_area = Rect {
        x: area.x + 2,
        y: area.y.saturating_add(area.height.saturating_sub(3)),
        width: (area.width.saturating_sub(4)).min(msg.len() as u16 + 4),
        height: 1,
    };
    if toast_area.width < 4 {
        return;
    }
    let span = Span::styled(
        format!(" {} ", msg),
        Style::default()
            .bg(theme.accent_error)
            .fg(theme.text_primary),
    );
    buf.set_span(toast_area.x, toast_area.y, &span, toast_area.width);
}

fn render_inspect_detail(buf: &mut Buffer, area: Rect, state: &ContractsState, theme: &Theme) {
    let detail = match &state.inspect_detail {
        Some(d) => d.clone(),
        None => return,
    };

    // Popup: centered, max 60% of area.
    let popup_w = (area.width as f32 * 0.6) as u16;
    let popup_h = (area.height as f32 * 0.6) as u16;
    let popup_x = area.x + (area.width.saturating_sub(popup_w)) / 2;
    let popup_y = area.y + (area.height.saturating_sub(popup_h)) / 2;
    let popup = Rect {
        x: popup_x,
        y: popup_y,
        width: popup_w,
        height: popup_h,
    };

    // Background.
    buf.set_style(popup, Style::default().bg(theme.bg_dark));

    // Border: horizontal lines at top/bottom.
    let border_style = Style::default().fg(theme.gray_dim);
    let top_line = "─".repeat(popup_w as usize);
    let bot_line = "─".repeat(popup_w as usize);
    buf.set_string(popup.x, popup.y, &top_line, border_style);
    buf.set_string(popup.x, popup.y + popup_h - 1, &bot_line, border_style);

    // Title.
    let title = format!(
        " Contract {}",
        state
            .entries
            .get(state.selected)
            .map(|e| e.id.as_str())
            .unwrap_or("?")
    );
    let title_span = Span::styled(
        title,
        Style::default()
            .fg(theme.text_primary)
            .add_modifier(Modifier::BOLD),
    );
    buf.set_span(popup.x, popup.y, &title_span, popup.width);

    // Content lines.
    let content_area = Rect {
        x: popup.x + 1,
        y: popup.y + 1,
        width: popup.width.saturating_sub(2),
        height: popup.height.saturating_sub(3),
    };
    for (i, line) in detail.lines().enumerate() {
        if (i as u16) >= content_area.height {
            break;
        }
        let truncated = truncate_str(line, content_area.width as usize);
        let span = Span::styled(truncated, Style::default().fg(theme.text_primary));
        buf.set_span(
            content_area.x,
            content_area.y + i as u16,
            &span,
            content_area.width,
        );
    }
}
