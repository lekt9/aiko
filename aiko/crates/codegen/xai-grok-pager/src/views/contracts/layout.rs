//! Contracts view layout — pure rect computations.

use ratatui::layout::Rect;

/// Minimum width for the contracts panel.
pub const MIN_CONTRACTS_WIDTH: u16 = 40;

/// Header height (title + subtitle line).
pub const HEADER_HEIGHT: u16 = 2;

/// Footer height (keybinding hints).
pub const FOOTER_HEIGHT: u16 = 1;

/// Compute the list area inside the view area, leaving room for header and footer.
pub fn list_area(view_area: Rect) -> Rect {
    let header_h = HEADER_HEIGHT.min(view_area.height);
    let footer_h = if view_area.height > header_h + FOOTER_HEIGHT {
        FOOTER_HEIGHT
    } else {
        0
    };
    Rect {
        x: view_area.x,
        y: view_area.y + header_h,
        width: view_area.width,
        height: view_area.height.saturating_sub(header_h + footer_h),
    }
}

/// Compute the header area at the top of the view.
pub fn header_area(view_area: Rect) -> Rect {
    Rect {
        x: view_area.x,
        y: view_area.y,
        width: view_area.width,
        height: HEADER_HEIGHT.min(view_area.height),
    }
}

/// Compute the footer area at the bottom of the view.
pub fn footer_area(view_area: Rect) -> Rect {
    let header_h = HEADER_HEIGHT.min(view_area.height);
    Rect {
        x: view_area.x,
        y: view_area.y.saturating_add(header_h).saturating_add(
            (view_area.height.saturating_sub(header_h)).saturating_sub(FOOTER_HEIGHT),
        ),
        width: view_area.width,
        height: FOOTER_HEIGHT.min(view_area.height.saturating_sub(header_h)),
    }
}
