# 侧栏工作台（Codex 式右侧 Side Workbench）

侧栏改造已完成。当前技术设计与组件边界见
[IMPLEMENTATION.md](./IMPLEMENTATION.md)；视觉对照图保留在本目录。

主要实现位于：

- `src/components/side-workbench/`
- `src/lib/sideWorkbench.ts`
- `src-tauri/src/commands/terminal.rs`
- `src-tauri/src/pty_host.rs`

产品行为以现有实现、测试和 `docs/llm-wiki/` 为准；原始需求、阶段 Goal、计划与进度账本已在完工后移除。
