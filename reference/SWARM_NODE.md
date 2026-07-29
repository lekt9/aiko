# Typed Neuron Swarm Node

The portable entry point is:

```sh
neuron node serve <node_dir>
```

Every installation runs the same `neuron.wire/v1` framed interface and is both
a server and a client. A peer stimulus still crosses the ordinary Neuron
validation, capability, evidence, atomic commit, and idempotency boundary.

## Install

Build a host bundle:

```sh
bash packaging/build-bundle.sh /tmp/neuron-dist
```

Extract it on a machine and run:

```sh
./install.sh
```

The default user installation is:

```text
~/.local/bin/neuron
~/.local/state/typed-neuron/
  node.json       public configuration
  device.seed     private stable Ed25519 seed (0600)
  state/          durable substrate
  service/        generated systemd and launchd definitions
```

Installation is idempotent. Reinstalling the binary does not rotate
`device.seed` or erase state. The installer verifies the bundled binary
against `manifest.json` before copying it. An existing node also fails closed
if an installer invocation supplies a different listener, transport, or write
ceiling; edit and review `node.json` deliberately for a configuration change.

## Initialize manually

For a real multi-machine node, bind a Tailscale address or wildcard listener:

```sh
neuron node init ~/.local/state/typed-neuron \
  --listen 0.0.0.0:7331 \
  --transport tailnet \
  --write-prefix artifact/swarm/my-machine/

neuron node id ~/.local/state/typed-neuron
neuron node serve ~/.local/state/typed-neuron
```

The default transport admits only Tailscale's `100.64.0.0/10` peers. Being on
the tailnet grants no authority by itself: the node applies its configured
capability ceiling before reading a firing. To use per-machine ceilings, copy
`ceilings.example.json` into the node directory and set
`"ceilings_file":"ceilings.json"` in `node.json`. Unknown peers then fail
closed.

`loopback` transport exists solely for local integration and package tests. It
requires a `127.0.0.0/8` or `::1` listener and never admits a LAN peer.

## Interface

Built-in receptors:

| Neuron | Purpose | Effects |
|---|---|---|
| `mesh/health` | End-to-end admission and runtime health | none |
| `mesh/proxy` | Write a typed artifact inside the peer ceiling | one write |

Send a bounded health stimulus:

```sh
neuron node fire 100.64.0.12:7331 \
  --ref mesh/health \
  --schema neuron.health/v1 \
  --payload '{}' \
  --firing health-$(date +%s)
```

Write through the typed proxy:

```sh
neuron node fire 100.64.0.12:7331 \
  --ref mesh/proxy \
  --schema mesh.proxy/v2 \
  --payload '{"schema":"mesh.proxy/v2","artifact_id":"artifact/swarm/a/message","bytes":"hello"}' \
  --firing message-$(date +%s)
```

The response is a framed commit result:

```json
{"status":"committed","effects_committed":1,"duplicates_skipped":0}
```

The same firing id and request may be retried safely; the CLI derives a stable
logical nonce from that id and the receiving runtime deduplicates the exact
firing. A caller may instead pin and reuse an explicit `--nonce`:

```sh
neuron node fire 100.64.0.12:7331 \
  --ref mesh/proxy \
  --schema mesh.proxy/v2 \
  --payload '{"schema":"mesh.proxy/v2","artifact_id":"artifact/swarm/a/message","bytes":"hello"}' \
  --firing message-42 \
  --nonce 42
```

## Service activation

The installer materializes both service definitions without enabling them:

```sh
# Linux user service
mkdir -p ~/.config/systemd/user
cp ~/.local/state/typed-neuron/service/typed-neuron.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now typed-neuron

# macOS LaunchAgent
mkdir -p ~/Library/LaunchAgents
cp ~/.local/state/typed-neuron/service/io.typed-neuron.node.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.typed-neuron.node.plist
```

## What “swarm” means here

The implemented swarm is a federation of independently governed Neuron
runtimes that exchange typed stimuli over one interface. Nodes retain their
own identity, state, capabilities, audit log, and settlement authority.

This does not yet imply one strongly consistent global memory. Cross-machine
artifact replication, topology convergence, distributed cache identity, and
quorum settlement remain separate limbs and require their own witnesses.
