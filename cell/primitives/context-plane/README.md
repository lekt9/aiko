# Cited context plane

A dependency-free durable context envelope. Every claim must cite at least one
`stimulus`, `message`, or digest-verified `pinned_read`. Citations bind the
source version and bytes digest. Moving a source appends a version and makes
claims resting on the superseded digest invalid; history is never rewritten.

The canonical handoff artifact is `STATE/cited-context-lineage.json`. It is
ordinary canonical JSON, verified by `context_plane.py verify`, and needs no
Aiko host or running service. Every command requires the envelope tenant and
refuses a mismatch. Malformed, tampered, unpinned, or uncited input fails
closed.

```sh
./context_plane.py init --state state --tenant acme
./context_plane.py source-add --state state --tenant acme   --kind stimulus --id order/42 --content '{"workers":4}'
./context_plane.py claim-add --state state --tenant acme   --id roster/42 --text 'four workers required' --source order/42
./context_plane.py status --state state --tenant acme
```

`source-move` is the only source mutation and retains prior versions. A
`pinned_read` additionally requires `--pin` equal to the SHA-256 of its exact
content. The gate cites the invalidation approach in `neuron/src/redrive.zig`:
uncited reads do not create lineage, so this plane refuses uncited claims
instead of pretending they can be invalidated.
