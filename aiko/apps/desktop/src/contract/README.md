// contract/ — TypeScript reference implementations for contract-native services.
//
// These modules were extracted from aiko-cli (now archived) and serve as the
// SPECIFICATION for what must become substrate-native in the Rust backend and
// ultimately in the signed libcontract.dylib (ebm.zig, route.zig, etc.).
//
// They will NOT compile as-is in this repo — they import from "./native" which
// expects bun:ffi FFI bindings, while this app uses @tauri-apps/api invoke().
// The concepts are identical; only the transport differs.
//
// Migration plan (by priority):
//
//   1. fractal-ebm.ts  → ebm.zig  (already exists in dylib; extend with tree
//      structure, depth-decay propagation, argmin-energy routing)
//
//   2. channels.ts     → Rust channel registry in the backend, mapping I/O
//      channels to agency type system (NodeRole, EffectScope, CadenceClass)
//
//   3. hooks.ts        → Rust middleware pipeline: declare → gate → run →
//      mark_satisfied per hook, chained in priority order
//
//   4. daemon.ts       → Rust background service: tick scheduler, gate claims,
//      auto-execute learned patterns, queue novel claims
//
//   5. gate.ts         → enhancement to contract_gate in dylib: add runtime
//      confirmation pathway (grantConfirmations / consumeConfirmation)
//
//   6. tool-neurons.ts → already partially in dylib (contract_gate); the
//      neuronize + recall patterns move into the backend
//
// Once all six are substrate-native, any consumer (CLI, desktop, Telegram bot)
// gets them for free by loading the dylib — one binary, one source of truth.
