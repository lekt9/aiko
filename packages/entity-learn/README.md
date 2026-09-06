# entity-learn native source vendor

Pinned complete core from `/home/deck/work/entity-learn` version 0.2.0 (MIT), commit `44ca591bc45835d5cd8e9c599f7e60f685d2eed9` at [lekt9/entity-learn-private](https://github.com/lekt9/entity-learn-private). `lib/` bytes are hashed in `provenance.json`. `bun ../../scripts/check-entity-learn.ts` refuses drift, extra files, missing files, symlinks, and the Tardie 0.5 `./tardigrade` adapter. Hashes detect accidental edits; they are not a signature if the manifest is rewritten.

Aiko consumes this package through `workspace:*` and Tardie **0.22.0 native tools**. Do not import a Tardie 0.5 `memoryPackage` here.

`entity-learn` preserves the Node/Bun local-file API. Workers resolve the `workerd` export condition to `entity-learn/cloudflare`, which exports the same Memory algorithms with an explicit synchronous SQLite storage adapter:

```ts
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
const memory = new Memory({ storage: cloudflareStorage(ctx.storage), scope: hostBoundOwner });
```

The host owns Durable Object lifetime and must await durable storage completion before acknowledging external writes. `close()` does not close DO storage. Source runners must be bound per request/account. File sources are unavailable unless the host explicitly supplies a file capability.

To update the vendor, copy the pinned `lib/` tree, rewrite `provenance.json` from that commit, and run `bun scripts/check-entity-learn.ts --upstream <checkout>` plus the Aiko memory tests. Do not patch only this copy.
