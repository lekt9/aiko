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

Aiko binds this Cell in code, not by re-implementing it:

```sh
./zig-out/bin/aiko-doctor bind-workflow patterns/fde/self-wire.cell.yaml --plan
```

The control surface that pauses and approves the bound revision is
`aiko-doctor workflow-control`. Smithers may drive that record; the
unpublished local checkout must not be documented as a shipped product
surface. See `docs/AIKO-WORKFLOW-BINDING.md` and `docs/SOURCE-OF-TRUTH.md`.
