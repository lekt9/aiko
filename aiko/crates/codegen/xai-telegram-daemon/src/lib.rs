//! Telegram daemon with full channel occupancy.
//!
//! Runs a persistent long-polling loop against the Telegram Bot API,
//! using all available affordances: typing indicators, file uploads,
//! voice messages, inline keyboards, MarkdownV2 formatting — and gates
//! substantive actions through the contract substrate.
//!
//! # Usage
//!
//! ```bash
//! TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_AUTHORIZED_CHATS="108611440" telegram-daemon
//! ```

pub mod agent_mail;
pub mod api;
pub mod bot;
pub mod daemon;
pub mod types;
