# Installing Typed Neuron

This is the **standalone Neuron bundle** installer. The published monorepo
product path is the root [`README.md`](../../README.md) (`zig build` or
`aiko/` `scripts/contract-runtime.sh install`). Inventory:
[`../../docs/SOURCE-OF-TRUTH.md`](../../docs/SOURCE-OF-TRUTH.md).

A single static binary plus an installer script. No runtime dependencies, no
package manager, no daemon you didn't start.

## Install

```sh
tar xzf typed-neuron-<os>-<arch>.tar.gz
cd typed-neuron-<os>-<arch>
./install.sh
```

That puts `neuron` in `~/.local/bin`, creates a node directory under
`~/.local/state/typed-neuron`, and generates a stable Ed25519 device identity.
The identity is written once and never rotated by reinstalling, so upgrading in
place keeps a node's identity and its journal.

Verify before you trust it — `manifest.json` carries the digest of the binary
that shipped:

```sh
shasum -a 256 bin/neuron          # compare against binary_sha256
cat manifest.json
bin/neuron --version              # prints the exact source revision it was built from
```

If `~/.local/bin` isn't on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Installer options

| Flag | Default | Purpose |
|---|---|---|
| `--prefix DIR` | `~/.local` | where the binary lands |
| `--node-dir DIR` | `~/.local/state/typed-neuron` | node config, identity, journal |
| `--listen IP:PORT` | `0.0.0.0:7331` | address the swarm node binds |
| `--transport tailnet\|loopback` | `tailnet` | `tailnet` refuses non-tailnet peers |
| `--write-prefix PREFIX` | `artifact/swarm/` | capability ceiling for the node |
| `--no-init` | — | install the binary only, create no node |

Installing without a node at all:

```sh
./install.sh --prefix /usr/local --no-init
```

## First run — five minutes

Nothing below needs a server, a network, or a config file.

```sh
# 1. Create an agent. This is three writes: manifest, snapshot 0000, active pointer.
neuron agent init ./node alpha

# 2. Drive a goal through the stage network (intake → worker → verifier → settler).
neuron agent run ./node alpha --goal "summarize the substrate" --json

# 3. Rebuild the agent's view from durable state alone.
neuron agent inspect ./node alpha --json
```

Re-run step 2 with the same goal: it returns `"status":"replayed"` with
`"steps":0` and appends **zero bytes** to the journal. Firings are deduplicated
by identity, so redelivery is free and side-effect-free.

### Make it do real work

Out of the box the worker stage is a deterministic reference resolution. Attach
a real boundary and the agent's product becomes whatever that boundary returns:

```sh
printf '#!/bin/sh\nexec tr "[:lower:]" "[:upper:]"\n' > worker.sh && chmod +x worker.sh

neuron interface discover "$PWD/worker.sh" --json               # a read; grants nothing
neuron interface describe "$PWD/worker.sh" --kind process \
    --id proc/shout --input-channel stdin --deterministic --output i.json
neuron interface test i.json --json                             # contract + adversarial battery
digest=$(neuron interface admit ./node i.json --json | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["interface"])')
neuron interface attach ./node alpha --interface "$digest" --role worker
```

> **A process boundary must be given an absolute path.** `./worker.sh` and
> `worker.sh` both fail with `InterfaceBoundaryUnusable`, which does not say so.
> Use `"$PWD/worker.sh"`.

Then run a goal and the product is whatever the boundary returned:

```sh
neuron agent run ./node alpha --goal "real work now" --json
```

Describing pins the implementation by digest but grants nothing — an interface
is inert until `admit`. Fit is not permission.

### Watch it happen

```sh
neuron telemetry serve ./node/state          # then open http://127.0.0.1:8787/
```

A live view that tails the journal: every committed firing appears within about
120ms, the derivation graph grows along the commit ordinal, and clicking a
firing shows the claim it made and the sources it cited.

Two properties worth knowing, because they are enforced rather than intended:

- **It never takes the substrate lock.** The node keeps committing while you
  watch, and an observer can never wedge a running node.
- **Artifact payloads never cross the wire.** Ids, schemas, sizes, citations,
  and claims are served; `bytes` are not. An artifact can hold a screenshot, a
  token, or a key, and an observability port is the wrong place to learn that.

Binding is loopback-only. `--allow-public` exists and fails closed without it;
the stream still reveals the shape of a workload to anyone who can reach it.

### Inspect after the fact

```sh
neuron telemetry trace   ./node/state --json   # per firing: when, cited, wrote
neuron telemetry stale   ./node/state --json   # derivations whose sources moved
neuron telemetry project ./node/state --json   # aggregate counters
```

All three are pure reads and all three survive `neuron compact`.

## Running a swarm node

```sh
neuron node serve ~/.local/state/typed-neuron
```

With `--transport tailnet` (the default) the node refuses any peer outside
`100.64.0.0/10`. `SWARM_NODE.md` in the bundle covers peering, node claims, and
leased edges.

## Upgrading

Unpack the new bundle and run `install.sh` again with the same `--node-dir`.
Package files are replaced; identity, configuration, and journal are not.

## Uninstalling

```sh
rm ~/.local/bin/neuron
rm -rf ~/.local/state/typed-neuron    # deletes the journal — this is the memory
```

The journal *is* the state. Removing it discards every artifact, admission, and
attachment the node ever accumulated.

## Building from source

Requires Zig 0.16.

```sh
zig build                     # ./zig-out/bin/neuron
zig build test                # unit suite
bash tests/gate.sh            # the acceptance gate
sh packaging/build-bundle.sh  # produces dist/typed-neuron-<os>-<arch>.tar.gz
```

The gates are the acceptance criterion, not the unit tests. Each drives the
public CLI from an empty directory and asserts against durable state.
