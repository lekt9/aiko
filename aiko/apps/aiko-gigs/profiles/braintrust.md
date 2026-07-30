# Braintrust Profile

## Headline
Systems Engineer & AI Agent Architect — Rust, TypeScript, Swift, Zig

## Hourly Rate
$150–200/hr (contract)

## About / Bio

I build systems that work at the boundary of operating systems, AI agents, and
native applications. My work spans low-level Rust/Zig runtimes, cross-platform
desktop apps (Tauri 2 + React), and agent-native tooling that runs on real
machines.

**What I've built:**
- **Aiko** — a contract-native AI agent that runs as a terminal TUI, headless
  background worker, and desktop app. Built the full Rust runtime: agent
  lifecycle, tool system, Contract ledger bridge (native dylib ABI), CDP/Electron
  browser primitives, ACP WebSocket session protocol, and macOS launchd
  background coordination.
- **Cross-platform desktop app** — Tauri 2 + React 19 + TypeScript, with native
  macOS and Windows packaging, code signing, notarization, and auto-update.
- **Agent-native browser integration** — CDP-based application observation and
  control tools for automated web interaction, form filling, and data extraction.
- **Contract substrate** — signed, append-only ledger with typed agency roles
  (purpose, sensor, action, evaluator, governor), dependency resolution, and
  bounded scheduler ticks. Native Rust↔Zig FFI bridge.
- **Cloudflare Workers infrastructure** — durable objects, email service,
  Turnstile, WAF, and Workers AI integrations.

**Stack depth:**
- **Languages:** Rust (primary), TypeScript, Swift, Zig, Python
- **Frameworks:** Tauri 2, React 19, SwiftUI, Cloudflare Workers
- **Systems:** macOS launchd, native dylib FFI, PTY management, CDP/DevTools Protocol
- **Tools:** Git worktrees, content-addressed builds, hermetic toolchains, Nix-style packaging

I ship working, verifiable software — every deliverable comes with automated
checks, not promises.

## Skills (for Braintrust taxonomy)

**Primary:**
- Rust (5+ years equivalent)
- TypeScript (5+ years)
- Systems Architecture
- API Design & Integration

**Secondary:**
- React / Frontend
- Swift / iOS / macOS
- Cloud Infrastructure (Cloudflare Workers, Durable Objects)
- Python
- Zig
- Desktop Application Development (Tauri, Electron)
- Browser Automation (CDP, Playwright)
- CI/CD & DevOps
- Technical Writing & Documentation

## Portfolio (real shipped work)

1. **Aiko — Contract-Native AI Agent Platform**
   - Built the complete agent runtime in Rust: tool system, prompt engine,
     session management, ACP WebSocket protocol, and native Contract ledger
     bridge via dylib ABI (Rust↔Zig FFI).
   - Cross-platform desktop app in Tauri 2 + React 19 + TypeScript.
   - macOS background worker with launchd integration for durable task execution.
   - Shipped as signed, notarized macOS package and signed Windows installer.

2. **Unbrowse — Agent-Native Browser**
   - Built CDP/Electron primitives for automated web interaction at the
     application layer (not DOM scraping).
   - Route graph compilation from real browser sessions for cached, sub-200ms
     API-native web access.
   - Integrated with Contract ledger for verifiable web task outcomes.

3. **Codegraff — Desktop Code Intelligence**
   - Tauri-based desktop app with project-aware sidebar, multi-session
     workspace, conversational flow, and keyboard-first controls.
   - Real-time code graph analysis with structural navigation.

## Work Preferences

- **Contract / consulting only**
- **Remote only**
- **Timezone:** US time zones preferred, flexible for the right project
- **Availability:** Immediate
- **Engagement length:** Open to short-term (2–4 weeks) or long-term (3–12 months)

## Red Flags (won't apply to)
- Full-time only roles
- On-site or hybrid requirements
- Crypto/NFT/web3 projects (blockchain infrastructure is fine, tokens are not)
- Roles requiring relocation

## Green Flags (prioritize)
- Systems or infrastructure projects
- AI/agent tooling and platforms
- Developer tools and productivity
- Cross-platform desktop applications
- Performance-critical or low-level work
- Teams that value shipped, tested code over slide decks
