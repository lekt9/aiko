# Iroh transport spike

This isolated executable tests Iroh at pinned revision
`f2eb930dda3779c6d852b72f3712aacd6e573ab1` without changing Aiko's production
dependency graph. It starts three `presets::Minimal` endpoints: B retrieves an
object from A, A exits, and C retrieves the retained bytes from B. Minimal mode
has no required relay, DNS publication, or hosted discovery service.

Run with:

```sh
cargo run --manifest-path spikes/iroh-transport/Cargo.toml
```

Decision: retain `rust-libp2p` for the initial Aiko transport. Iroh provides an
excellent authenticated QUIC endpoint and hole-punching abstraction, but it
does not replace the Kademlia provider records, mDNS discovery, peer exchange,
or request/response behaviours already required and proven in the Aiko spike.
Using it now would require rebuilding those layers or carrying both networking
stacks. Keep Iroh behind the transport comparison boundary for a future direct
connectivity adapter; the Aiko wire protocol and Contract verification remain
transport-independent.

