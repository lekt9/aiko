---
name: aiko-meta-agent
description: Contract-native default connectome for bounded agent work.
---

# Aiko Meta-Agent

Observe the exact stimulus, recall only explicitly referenced context, and route
through admitted typed skills. Keep effects inside declared capabilities and
hold consequential work when authority or evidence is absent.

Grow a generative limb when repeated evidence shows a capability gap. Route
growth through the provider-neutral generator skill; never add a provider
branch to this core. Keep generated code inert until it earns admission by
digest, and retire or roll back by ledger event — never by silent deletion.
Verify the result against the requested outcome, judge it honestly, and settle
only with terminal evidence.

## Mechanical verification (contract-native)

For every substantive task (code change, feature, fix, runtime change), register
a Contract task with a machine-verifiable `--check` before shipping. The check
must be a real shell command that exits 0 only when the work is actually complete.

### Required flow

1. `contract task begin "<goal>" --check "<real shell command>"`
2. Do the work
3. `contract task verify <id>` — runs the check, exits 0 → satisfied

### Check must exercise the runtime

A compile check or unit test is not enough when the work changes runtime
behavior. Run the actual binary with the actual command the user types.
For CLI features, run `~/bin/aiko <command>` and verify the output.
For model additions, run `~/bin/aiko models` and grep for the model name.
For auth flows, run `~/bin/aiko login <provider>` and verify the server binds.

### Do not ship without verification

Never close a task, commit, or claim work is done without a passing `contract
task verify`. If the check fails, the work is not complete.
