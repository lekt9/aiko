---
name: typed-neuron/auto-attacher
description: 'Wires a newly admitted limb into the topology by writing one typed edge manifest per explicitly declared per-Neuron `accepts` schema. Use when an admission has just landed and the package must become reachable — it fires on a `neuron.limb-admission/v1` stimulus and emits `neuron.edge-manifest/v1` plus a `neuron.attach-result/v1` summary under `topology/edges/`.'
probe_input: '{"budget":{"max_bytes":131072,"max_depth":1,"max_effects":32,"max_messages":0,"max_spawns":0,"max_writes":32},"firing_id":"auto-attacher-probe-001","messages":[],"now_ms":0,"permitted_reads":["admission/echo"],"reads":[{"bytes":"{\"digest\":\"deadbeef\",\"package\":\"{\\\"neurons\\\":[{\\\"accepts\\\":[\\\"test.echo-request/v1\\\"],\\\"emits\\\":[\\\"test.echo-result/v1\\\"],\\\"id\\\":\\\"echo-neuron\\\"}],\\\"package\\\":\\\"typed-neuron/echo\\\"}\",\"schema\":\"neuron.limb-admission/v1\"}","digest":"494c36e389164e908292c6a0d1e4e36d138d65be8034686cbae6664982b8cd77","id":"admission/echo","schema":"neuron.limb-admission/v1"}],"receptor_schema":"neuron.limb-admission/v1","schema":"neuron.stimulus/v1"}'
expect_contains: '"bytes":"{\"admission_digest\":\"deadbeef\",\"budget\":{\"max_cost\":1000,\"max_firings\":100},\"delivery_mode\":\"stimulus\",\"destination\":\"neuron/limb/deadbeef/echo-neuron\",\"package\":\"typed-neuron/echo\",\"partition_key\":\"test.echo-request/v1\",\"predicate\":\"schema-match\",\"priority\":50,\"schema\":\"neuron.edge-manifest/v1\",\"source\":\"receptor/test.echo-request/v1\"}","id":"topology/edges/deadbeef/test-echo-request-v1","schema":"neuron.edge-manifest/v1"},"kind":"write"},{"artifact":{"bytes":"{\"admission_digest\":\"deadbeef\",\"edges_created\":1,\"neurons\":[\"echo-neuron\"],\"package\":\"typed-neuron/echo\",\"receptors\":[\"test.echo-request/v1\"],\"schema\":\"neuron.attach-result/v1\"}'
grounding: neuron/AGENTS.md#9, neuron/AGENTS.md#26, neuron/AGENTS.md#30
---

# typed-neuron/auto-attacher

**Status**: reference generative limb (§30)

Automatically wires admitted limbs to matching receptor schemas via typed edges.

## What it does

After `admit()` atomically writes the admission artifact and event, the
auto-attacher reads the immutable manifest and writes edge manifests to
`topology/edges/` for each explicit per-Neuron `accepts` schema. It never
infers an interface from schema names.

## Key invariants

- §30.4: A limb receives no ambient authority. The attacher writes edge manifests only — it does not grant caps.
- §26: Edge manifests include source, destination, predicate, delivery_mode, priority, and budget.
- §9: Missing explicit `accepts` means the Neuron is not auto-attached.

## Conformance

```sh
python3 tests/conformance.py
```

## Acceptance

The frontmatter `expect_contains` is the written edge artifact's id,
`topology/edges/deadbeef/test-echo-request-v1`. Producing it requires the
whole transform to have run: parse the admission's `package` field (a JSON
document nested as a *string* inside the admission artifact), walk
`neurons[].accepts` to find `test.echo-request/v1`, sanitize that schema URI
into an artifact-id fragment (`/` and `.` → `-`), and join it under the
admission digest. A handler that emits a fixed decision, echoes its stimulus,
or reads `schemas` friendly names instead of per-Neuron `accepts` yields a
different id and fails.

The same firing also emits `"destination":"neuron/limb/deadbeef/echo-neuron"`
inside the edge manifest bytes and `"result":"attached-1-edges"` as its
control — either would serve as a secondary check.
