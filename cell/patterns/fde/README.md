# FDE pattern — Aiko seats Aiko

Cell-native self-wire loop. Same primitive as every other pattern:
`Cell = membrane + (run | organelles+wiring)`.

```text
account-handle → deploy-workflow → deploy-aiko
                      │
                      └─ authored cell wires deploy-aiko
```

Account credentials are an opaque `cred:` handle. Raw API keys, tokens,
passwords, and cookies are refused at the membrane. `auth` (token / api_key /
username+password) stays for API reverse-engineering; this pattern is the
employee seat.

```sh
python run.py run patterns/fde/self-wire.cell.yaml \
  --inputs '{"account":{"tenant":"acme","origin":"https://mail.example","account_id":"aiko-ops"},"role":"ops-staffer","outcome":"own daily roster confirmation"}' \
  --out /tmp/fde
```

On the Smithers control surface, `<Cell>` is a native workflow element
(same class as `<Task>`). The Cell is a harness *inside* the agent
workflow.

Smithers preserves this typed harness through `Cell`/`runCell`; `ContractCell`
composes it with native Contract lifecycle and recovery. Cell does not keep a
second credential, context, readiness, or durable-control record. See
`docs/SOURCE-OF-TRUTH.md` and `tests/no-duplicate-fde-primitives-gate.sh`.
