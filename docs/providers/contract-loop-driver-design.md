# ContractLoopDriver — Design

## Problem

Aiko currently uses `libcontract.dylib` as a **passive FFI bridge**: it declares contracts, marks them satisfied, and fires neurons through FFI calls. But the real power of the dcontract substrate lies in its **event loop** — the recursive neuron tree that chains automatically through `fill`, `break_above`, `guard`, and `ebm_proto` events.

From session analysis of 20,769 contract events, the pattern is:
1. Agent declares ONE contract → substrate interprets → spawns children
2. Children fire independently → `break_above` terminates parent iterations
3. Parent auto-fills gaps: `fill who:contract via contract X (diffuse-default wave N)`
4. Failures trigger `guard` → recovery neuron → retry
5. EBM learns: `fire:ok` → energy decreases, `fire:retryable` → energy increases
6. Cache invalidation: content-addressed snapshots → new hash → re-fire

Aiko should be an **active participant** in this loop, not just a fire-and-forget caller.

## Architecture

### New Module: `contract_loop.rs`

```
crates/codegen/xai-grok-shell/src/contract_native/
├── contract_loop.rs          ← NEW: active loop driver
├── neuron_bridge.rs          ← existing: FFI bridge (fire_neuron, admit_tool_effect)
├── membrane.rs               ← existing: typed membrane types
├── contract_events.rs        ← existing: event injection for LLM introspection
├── contract_learning.rs      ← existing: learning contracts + self-growing limbs
├── reflex_policy.rs          ← existing: reflex policy
├── activity_sensor.rs        ← existing: activity observation
└── skill_registry/           ← existing: skill graph planning
```

### Core Type: `ContractLoopDriver`

```rust
pub struct ContractLoopDriver {
    /// Current contract being driven
    contract_id: String,
    /// The goal/plan text
    goal: String,
    /// Current wave number
    wave: u32,
    /// Children that have fired and their outcomes
    children: BTreeMap<String, ChildOutcome>,
    /// Pending fills from the substrate
    pending_fills: Vec<FillIteration>,
    /// EBM muscle rankings snapshot
    muscle_rankings: Option<MuscleRankings>,
    /// Whether we're in sabbath (two-phase commit)
    sabbath: bool,
    /// Evidence accumulated for sabbath self-attestation
    sabbath_evidence: Vec<SabbathEvidence>,
}
```

### Key Methods

#### 1. `ContractLoopDriver::new(contract_id, goal)`
Initialize the driver for a contract. Query EBM muscle rankings for context.

#### 2. `ContractLoopDriver::poll_events() -> Vec<LoopEvent>`
Read the contracts.jsonl event log, parse new events since last poll position. Returns typed loop events:
- `LoopEvent::ChildDeclared { id, action, layer }`
- `LoopEvent::ChildResolved { id, outcome }`
- `LoopEvent::BreakAbove { source_id, depth }`
- `LoopEvent::FillIteration { via_contract, wave, delta }`
- `LoopEvent::Guard { error_class, remediation }`
- `LoopEvent::SabbathCheckpoint { awaited }`
- `LoopEvent::EbmUpdate { key, weight, mean }`

#### 3. `ContractLoopDriver::handle_fill_iteration(FillIteration) -> ToolCall`
When the substrate emits `fill who:contract via contract X`, this method:
1. Looks up child X's outcome in `self.children`
2. Determines what tool/action to take next
3. Uses EBM routing to select the best approach
4. Returns the tool call to execute

This is the core of one-shot: the agent doesn't need to know what to do next — the substrate tells us via fills.

#### 4. `ContractLoopDriver::handle_guard(GuardEvent) -> RecoveryAction`
When a guard fires:
1. Query EBM for alternative routes (exclude the failed one)
2. If no alternative, spawn a recovery neuron (new child)
3. Feed the failure evidence back for learning
4. Return the recovery action

#### 5. `ContractLoopDriver::select_tool_via_ebm(goal, context) -> Option<ToolCandidate>`
Query muscle rankings for the goal context, return the lowest-energy candidate. This replaces hard-coded tool selection with learned routing.

#### 6. `ContractLoopDriver::provide_sabbath_evidence() -> SabbathEvidence`
When the substrate enters sabbath (two-phase commit), provide self-attestation:
- List all children and their outcomes
- Provide the EBM energy delta for the wave
- State whether chain coherence holds
- Return the evidence for the sabbath-eval child

### Integration Points

#### A. Turn Start — Arm the Driver

When Aiko begins a turn with a contract goal, arm the driver:

```rust
// In contract_native.rs, around line ~250 where contracts are declared
pub async fn arm_contract_loop(contract_id: String, goal: String, cwd: PathBuf) -> Option<ContractLoopDriver> {
    let driver = ContractLoopDriver::new(contract_id, goal);
    driver.poll_events().await; // Prime with initial state
    Some(driver)
}
```

#### B. Tool Call Boundary — Feed Results Back

After each tool call, feed the result back into the loop:

```rust
impl ContractLoopDriver {
    pub async fn feed_tool_result(&mut self, tool_name: &str, success: bool, output: &str) -> Vec<LoopEvent> {
        // Record the outcome
        // Poll for new events (fill iterations, breaks, guards)
        // Return events that require action
        self.poll_events().await
    }
}
```

#### C. Turn End — Settle the Loop

At turn end, settle the contract loop:

```rust
impl ContractLoopDriver {
    pub async fn settle(&self) -> ContractGraphVerdict {
        // Check if all fills are resolved
        // If in sabbath, provide evidence
        // Return completed/retryable/evidence
    }
}
```

### Event Parser

Parse the contracts.jsonl event log incrementally:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event")]
enum ContractEvent {
    #[serde(rename = "declared")]
    Declared {
        id: String,
        plan: String,
        action: String,
        pointer_type: String,
        layer: u32,
        parent_id: Option<String>,
    },
    #[serde(rename = "iterated")]
    Iterated {
        id: String,
        wave: u32,
        action_exit: i32,
        action_result: String,
        delta: f64,
        delta_gap: Vec<String>,
    },
    #[serde(rename = "break_above")]
    BreakAbove {
        id: String,
        source_id: String,
        depth: u32,
        action_result: String,
    },
    #[serde(rename = "guard")]
    Guard {
        id: String,
        error_class: String,
        layer: String,
        remediation: String,
    },
    #[serde(rename = "ebm_proto")]
    EbmProto {
        key: String,
        from_id: String,
        w: f64,
        mean: String,
    },
    #[serde(rename = "satisfied")]
    Satisfied {
        id: String,
        wave: u32,
        proof: String,
    },
    #[serde(rename = "cache_resolved")]
    CacheResolved {
        id: String,
        wave: u32,
        snapshot: String,
    },
    #[serde(rename = "child_added")]
    ChildAdded {
        id: String,
        child_id: String,
    },
    #[serde(rename = "pattern")]
    Pattern {
        id: String,
        pattern_text: String,
    },
}
```

### One-Shot Surface

The public API that the agent/LLM sees:

```rust
/// One-shot: declare intent, the loop handles everything.
pub async fn contract_one_shot(goal: &str, cwd: &Path) -> ContractOutcome {
    let contract_id = declare_contract(goal, cwd);
    let mut driver = arm_contract_loop(contract_id, goal);
    
    loop {
        match driver.poll_next_action() {
            LoopAction::ExecuteTool { tool_name, arguments } => {
                let result = execute_tool(tool_name, arguments).await;
                driver.feed_tool_result(&tool_name, result.success, &result.output);
            }
            LoopAction::Retry { reason, alternative } => {
                // Guard fired — retry with alternative approach
                let result = execute_alternative(alternative).await;
                driver.feed_retry_result(result);
            }
            LoopAction::SabbathAttest => {
                let evidence = driver.provide_sabbath_evidence();
                driver.submit_sabbath_evidence(evidence);
            }
            LoopAction::Complete { verdict } => {
                return verdict;
            }
        }
    }
}
```

## Migration Path

1. **Phase 1 (this PR)**: Add `contract_loop.rs` with event parsing and the `ContractLoopDriver` type. Wire into `contract_native.rs` as an opt-in capability behind env var `AIKO_CONTRACT_LOOP=true`. Existing fire-and-forget path unchanged.

2. **Phase 2**: Wire the loop driver into tool call boundaries in `tool_calls.rs` and turn start in `spawn.rs`. Feed tool results back into the loop.

3. **Phase 3**: Enable `contract_one_shot` as the default entry point for graph-executed contracts. The agent declares intent once; the loop handles fills, retries, and sabbath.

## Env Var Gating

- `AIKO_CONTRACT_LOOP=true` — enables the ContractLoopDriver (default: false for backward compat)
- `AIKO_CONTRACT_LOOP_POLL_MS=100` — poll interval for event log (default: 100ms)
- `AIKO_CONTRACT_LOOP_MAX_WAVES=7` — max waves before forcing settle (default: 7)

## Witness

The design is complete when:
- `contract_loop.rs` exists with `ContractLoopDriver` struct
- `handle_fill_iteration` method defined
- `handle_guard` method defined
- `select_tool_via_ebm` (ebm_router) method defined
- Integration points documented for Phase 2/3
