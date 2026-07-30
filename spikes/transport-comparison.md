# Aiko peer transport comparison

Date: 2026-07-21

| Requirement | rust-libp2p 0.56 production spike | Iroh 1.0.3 isolated spike |
| --- | --- | --- |
| Three-node direct LAN handoff | Pass: QUIC transfer and Kademlia provider recovery test | Pass: `presets::Minimal`, A → B, A exits, B → C |
| Hosted services disabled | Pass: no seeds, DNS, relay, or internet in LAN tests | Pass: Minimal preset has no relay or address lookup service |
| Authenticated peer transport | Noise/libp2p peer identity over QUIC | Iroh endpoint public-key identity over QUIC |
| mDNS discovery | Native behaviour, tested by the production swarm | Not supplied by the minimal endpoint; Aiko would add it |
| Provider DHT | Native Kademlia provider records; three-node seed-departure test passes | Not supplied; Aiko would add or carry another stack |
| Bounded request/response | Native behaviour with Aiko's validated CBOR messages | Aiko would implement framing and dispatch on QUIC streams |
| Peer exchange | Implemented in Aiko over libp2p | Aiko would implement it |
| Optional self-hosted relay | Native relay server/client roles | Supported by Iroh, but not exercised in the no-service spike |
| Direct invitation | Multiaddr plus peer ID | `EndpointAddr` plus endpoint ID |
| Debug spike executable | Integrated collective test executable: about 55 MB | Minimal handoff executable: about 46 MB |
| Runtime source dependency | crates.io packages pinned by the Aiko lockfile | Git revision used only by the isolated spike |

Commands and evidence:

```sh
cargo test -p xai-aiko-collective
CARGO_TARGET_DIR=/tmp/aiko-iroh-spike \
  cargo run --manifest-path spikes/iroh-transport/Cargo.toml
```

The Iroh run prints `iroh-minimal three-node offline handoff: ok`. The
rust-libp2p suite proves direct transfer, restart persistence, and provider
recovery after the original seed departs.

Decision: keep rust-libp2p as the single default peer stack. Iroh's direct QUIC
API is smaller conceptually, but adopting it would require rebuilding the DHT,
mDNS, provider, request/response, and peer-exchange primitives or shipping two
network stacks. The Aiko object and wire protocols remain transport-neutral,
so an Iroh adapter can be reconsidered if direct/NAT connection measurements on
real macOS and Windows machines materially outperform libp2p. NAT traversal,
relay failure, release-size, and cross-machine memory measurements are release
qualification evidence, not claims made by this local-only spike.

