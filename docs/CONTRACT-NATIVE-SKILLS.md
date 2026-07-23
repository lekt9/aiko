# Contract-native skills

Aiko now treats domain behavior as versioned Contract graph bundles rather
than adding another branch to the Rust substrate. The substrate owns graph
validation, lineage, fan-out limits, effect/authority policy, evidence, and
settlement. A bundle owns triggers, domain instructions, node dependencies,
effects, and verification requirements.

## Resolution

The registry discovers `contract-skill.json` beside `SKILL.md`. Equal IDs use
this deterministic precedence:

1. project `.agents/skills`, `.aiko/skills`, then `.grok/skills`;
2. user `~/.agents/skills`, `~/.aiko/skills`, then `~/.grok/skills`;
3. Aiko's bundled library.

Invalid schemas, unsafe relative script paths, unknown effects, dependency
cycles, unsupported platforms, and ungoverned consequential nodes fail closed.
At most four matching bundles and fourteen skill nodes enter a turn, preserving
two nodes for the generic observation/verification spine.

## Inspect and test

```sh
aiko native contract-skills list
aiko native contract-skills plan "inspect this project and run its tests"
./scripts/test-contract-native-skills.sh
```

The TUI equivalent is `/contract-skills` or
`/contract-skills <goal>`. Desktop Settings → Skills uses the same native
endpoints: `GET /v1/contract-skills` and
`POST /v1/contract-skills/plan`.

The canonical suite validates all ten bundles, their examples, Rust registry
tests, malformed/cyclic/path-traversal/effect-laundering cases, the native
binary, and the desktop build. Set `AIKO_SKILL_TEST_FAST=1` for manifest-only
checks while authoring.

## Create, override, or remove

Use the repository generator to reproduce the bundled examples:

```sh
./scripts/generate-contract-native-skills.py
```

For a new bundle, initialize a normal skill folder, add a manifest conforming
to [the v1 schema](../.agents/contract-skill.schema.json), then add cases under
`tests/cases.json`. A project or user bundle with the same ID replaces the
bundled version locally. Removing that directory restores the next lower
precedence version; no ledger or compiled runtime mutation is required.

Consequential effects must be declared on the actual node that performs them.
Wrapping a purchase, message, publication, deletion, permission change, or
account mutation in a read-only parent never removes the authority hold.
