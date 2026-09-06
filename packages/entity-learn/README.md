# entity-learn native source vendor

Source: `/home/deck/work/entity-learn`, version 0.2.0 (MIT), including the native storage-adapter change maintained in that repository. The `lib/` files are identical to the native library source, not a second memory implementation.

`entity-learn` preserves the Node/Bun local-file API. Workers resolve the `workerd` export condition to `entity-learn/cloudflare`, which exports the same Memory algorithms with an explicit synchronous SQLite storage adapter:

```ts
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
const memory = new Memory({ storage: cloudflareStorage(ctx.storage), scope: hostBoundOwner });
```

The host owns Durable Object lifetime and must await durable storage completion before acknowledging external writes. `close()` does not close DO storage. Source runners must be bound per request/account. File sources are unavailable unless the host explicitly supplies a file capability.

Native backend parity tests live in `/home/deck/work/entity-learn/tests/cloudflare.test.ts`; app integration tests exercise this exact vendored code. To update the vendor, synchronize native `lib/` source and run the native and Aiko memory tests. Do not patch only this copy.
