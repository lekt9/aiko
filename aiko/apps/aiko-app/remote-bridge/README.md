# remote-bridge (historical / reference)

> **Deprecated for Aiko App runtime.**  
> Remote IM connectors now run **in-process in Rust**: `src-tauri/src/remote_im/`.  
> Host does **not** spawn this Node package.

This directory remains as a protocol reference (Feishu long-connection, engine ideas) migrated from agent-connect. Do not install `@ronglecat/agent-connect` for the App.

Active path:

- `src-tauri/src/remote_im/channels/` — Feishu WS, Telegram, Discord, Slack, DingTalk, WeCom, generic
- `src-tauri/src/remote_im/engine.rs` — `/p` `/r` / Aiko turns
- `src-tauri/src/remote_im/bridge.rs` — start/stop status IPC
