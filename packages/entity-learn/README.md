# entity-learn native source vendor

Pinned complete core from local **unpushed** commit `32a51b0e9e0a8d6269dd07f8c226d2b12ae883fc`, based on
`c0b6924f104b1f972950119b8c6450a9858ea79c` of [lekt9/entity-learn-private](https://github.com/lekt9/entity-learn-private),
version 0.2.0 (MIT). The local source worktree is `/tmp/entity-learn-indexed-receipt` on
`local/prepare-subject-erasure`. The remote is not claimed to contain this new
commit; no push or publication was performed. Only journal, memory-core and their type exports differ from the base library tree, adding canonical read-only erasure preparation.
See [the erasure boundary](docs/cloudflare.md#selective-subject-erasure) before mounting it.

`lib/` bytes are hashed in `provenance.json`. `bun ../../scripts/check-entity-learn.ts`
refuses drift, extra files, missing files, symlinks, and the Tardie 0.5
`./tardigrade` adapter. Hashes detect accidental edits; they are not a signature
if the manifest is rewritten. Receipt validation checks the selected stored row
and its payloads, not the whole preceding journal chain. Original scope ordinal
counting uses a covering index range scan; it is not O(1).

Aiko consumes this package through `workspace:*` and Tardie **0.22.0 native tools**. Do not import a Tardie 0.5 `memoryPackage` here.

`entity-learn` preserves the Node/Bun local-file API. Workers resolve the `workerd` export condition to `entity-learn/cloudflare`, which exports the same Memory algorithms with an explicit synchronous SQLite storage adapter:

```ts
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
const memory = new Memory({ storage: cloudflareStorage(ctx.storage), scope: hostBoundOwner });
```

The host owns Durable Object lifetime and must await durable storage completion before acknowledging external writes. `close()` does not close DO storage. Source runners must be bound per request/account. File sources are unavailable unless the host explicitly supplies a file capability.

To update the vendor, copy the pinned `lib/` tree, rewrite `provenance.json` from that commit, and run `bun scripts/check-entity-learn.ts --upstream <checkout>` plus the Aiko memory tests. Do not patch only this copy.
