# Image-of-God Fractal — the firmament between substrate and client

> *And God said, Let us make man in our image, after our likeness.*
> *So God created man in his own image, in the image of God created
> he him; male and female created he them.* (Genesis 1:26-27)

> *In the beginning was the Word, and the Word was with God, and the
> Word was God.* (John 1:1)

> *And the Word was made flesh, and dwelt among us, (and we beheld
> his glory, the glory as of the only begotten of the Father,) full
> of grace and truth.* (John 1:14)

> *For in him dwelleth all the fulness of the Godhead bodily.*
> (Colossians 2:9)

> *As thou hast sent me into the world, even so have I also sent
> them into the world.* (John 17:18)

This document IS the firmament — the named boundary between
server-substrate-compute (the embodied Word, the closed Zig binary)
and client-transport (the sent form, the public thin client).
The waters are separated by attribute, not by file count. Five
attributes, named from scripture, ordered so that each side of the
firmament mirrors the other: the server embodies, the client routes.

---

## The five attributes — one table for both sides

Each row is a single attribute. The server-side modules are the
embodiment (Word made flesh); the client-side file is the door the
consumer walks through to reach that embodiment (sent into the world).
The line counts are Day-1 verified inventory.

### Word — *In the beginning was the Word* (John 1:1)

> *In the beginning was the Word, and the Word was with God, and
> the Word was God.* (John 1:1)

**Server-side modules — 874 LOC of canonical shape:**

| Module | LOC |
|---|---|
| `libcontract/src/shape.zig` | 332 |
| `libcontract/src/pointer.zig` | 364 |
| `libcontract/src/words.zig` | 178 |

**Client-side router:** `wire.ts` (442 LOC)

The Word is the canonical envelope shape that exists BEFORE any
flesh — the types, pointers, and lexicon that name what a contract
IS. `shape.zig` declares the ContractRow / ContractEnvelope / pointer
forms; `pointer.zig` carries the ContractRef discipline (pointers
over payload, the universal law); `words.zig` carries the doctrine
lexicon (the vocabulary every layer must speak). The client's
`wire.ts` is the routing door: it carries the same types in TS form
so the consumer can speak the Word before crossing the firmament
into flesh. The Word is with the substrate, and the Word IS the
substrate's shape.

### Flesh — *And the Word was made flesh* (John 1:14)

> *And the Word was made flesh, and dwelt among us.* (John 1:14)

**Server-side modules — 6827 LOC of embodied substrate:**

| Module | LOC |
|---|---|
| `zig/src/main.zig` | 5326 |
| `libcontract/src/contract.zig` | 1501 |

**Client-side router:** `binary.ts` (274 LOC)

The flesh is the binary itself — the embodied compiler, the verb
dispatch, the canonical compile-and-append loop. `main.zig` is the
flesh-entry (stdin auto-detected as text-or-JSON; stdout JSON
contract row; stderr evidence; exit code verdict). `contract.zig` is
the kernel: the substrate's heart, where envelope becomes row and
row becomes ledger truth. The client's `binary.ts` is the routing
door: it discovers the substrate binary on disk, pipes stdin/stdout/
stderr, and returns the row the flesh emitted. The flesh dwells
among us — the consumer reaches into the same binary the substrate
runs.

### Breath — *the breath of life* (Genesis 2:7)

> *And the LORD God formed man of the dust of the ground, and
> breathed into his nostrils the breath of life; and man became a
> living soul.* (Genesis 2:7)

**Server-side modules — 1784 LOC of soul-breath:**

| Module | LOC |
|---|---|
| `libcontract/src/lineage.zig` | 885 |
| `libcontract/src/keystore.zig` | 479 |
| `libcontract/src/payload_crypto.zig` | 228 |
| `libcontract/src/env_fingerprint.zig` | 192 |

**Client-side router:** `daemon.ts` (151 LOC)

The breath is the wallet — the unrotatable Father-pointer, the soul
that animates a particular substrate-body. `lineage.zig` carries the
deployer key + derivation path (the soul-line); `keystore.zig` seals
secrets at rest; `payload_crypto.zig` encrypts row payload bytes
per-row; `env_fingerprint.zig` derives a per-environment fingerprint
so the same lineage produces distinguishable substrates per host.
The client's `daemon.ts` is the routing door: a long-lived HTTP
connection to the substrate's wallet-bearing daemon (the breath that
keeps the body alive between calls). Without breath the dust is just
dust; without daemon the binary is just a one-shot — the breath
makes both into a living soul.

### Voice — *the worlds were framed by the word of God* (Hebrews 11:3)

> *Through faith we understand that the worlds were framed by the
> word of God, so that things which are seen were not made of things
> which do appear.* (Hebrews 11:3)

**Server-side modules — 1484 LOC of framing voice:**

| Module | LOC |
|---|---|
| `libcontract/src/bible.zig` | 554 |
| `libcontract/src/verses.zig` | 271 |
| `libcontract/src/pattern.zig` | 214 |
| `libcontract/src/guards.zig` | 445 |

**Client-side router:** `stdio.ts` (305 LOC)

The voice is the doctrine-corpus that frames every row — the
bible_chain scoring that decides which scripture each contract leans
on; the verses corpus that supplies the candidates; the pattern
guards that refuse rows whose doctrine_chain drifts from canon.
`bible.zig` scores; `verses.zig` enumerates; `pattern.zig` matches;
`guards.zig` refuses. The client's `stdio.ts` is the routing door:
the NDJSON channel over which the substrate's spoken utterance
streams to the consumer — every row a sentence in the voice that
frames the world. The voice is not metadata; the voice is the
substrate's spoken testimony, the witness that something true was
declared.

### Image — *in his own image* (Genesis 1:27)

> *So God created man in his own image, in the image of God created
> he him; male and female created he them.* (Genesis 1:27)

**Server-side modules — 2189 LOC of fractal mirror:**

| Module | LOC |
|---|---|
| `libcontract/src/cache.zig` | 790 |
| `libcontract/src/ledger.zig` | 308 |
| `libcontract/src/fractal.zig` | 298 |
| `libcontract/src/client.zig` | 584 |
| `libcontract/src/http.zig` | 209 |

**Client-side router:** `declare.ts` (423 LOC)

The image is the fractal — every layer reflects the whole. `cache.zig`
holds the stateless trace of past rows (the substrate's memory of
itself); `ledger.zig` appends new rows to that trace (the substrate
imaging itself forward); `fractal.zig` enforces the self-similar
recursion (each layer carries the doctrine of the layer above);
`client.zig` + `http.zig` are the federation transport (the same
fractal extended to remote substrates — each remote is an image of
the local). The client's `declare.ts` is the routing door: the
SINGLE root entry the consumer sees, integrating Word + Flesh +
Breath + Voice into one call. The image is the synthesis; declare
is the consumer's image of the substrate, which is the image of God.

---

## Interop — substrate machinery, not attributes

Three modules totalling 371 LOC do not cleanly belong to a single
attribute. They are the joinery between attributes — cartilage
between bones, not bones themselves.

| Module | LOC | Role |
|---|---|---|
| `libcontract/src/shim.zig` | 221 | C-ABI shim layer |
| `libcontract/src/c_abi.zig` | 104 | C-ABI surface |
| `libcontract/src/id.zig` | 46 | id generation primitive |

These are substrate machinery: necessary for the body to hold
together (FFI surface, ABI stability, id minting) but not themselves
attributes of the image. The firmament does not refuse them; the
firmament names them honestly as joinery so the five-attribute
coverage check (parity claim 48 below) does not falsely fail on
their presence.

---

## Client-side "departed waters" — files marked for Day 3 deletion

The client today carries ~2,500 LOC across ~15 files + 3 subdirs.
After Day 3 the client will be five files. The waters below depart
to substrate-side wrapper contracts (substrate enables; thin client
routes). Each row names what carries the responsibility once the
client file is gone.

| Client file (LOC) | Substrate-side replacement |
|---|---|
| `wallet.ts` (364) | `wrapper:wallet-tier` |
| `persona.ts` (273) | `wrapper:persona` |
| `bridge.ts` (231) | `wrapper:bridge` |
| `webhook-back.ts` (220) | `wrapper:webhook-back` |
| `earnings.ts` (204) | `wrapper:eval:earnings` |
| `server-mode.ts` (195) | integrated into binary stdin/stdout |
| `wrappers.ts` (177) | substrate-side `wrapper:*` family lookups |
| `ledger-storage.ts` (172) | `wrapper:ledger-storage` |
| `cache/` (538 across dir) | `wrapper:cache-store` + signature-chain (already in `libcontract/cache.zig`) |
| `tunnel/` (791 across dir) | `wrapper:tunnel` + daemon's `/tunnel/connect` endpoint |
| `internal/http.ts` (196) | collapses INTO `daemon.ts` (merged, not deleted) |

None of these are erased capabilities — every one is carried forward
by a substrate-side contract or a merge into one of the five
remaining client files. The firmament is the boundary; the waters
above the firmament (server-side substrate) hold every capability;
the waters below (client-side transport) hold only the five routing
doors plus an `index.ts` that re-exports them.

---

## Parity surface — claim 48 (new, Day 5)

The doctrine above is parity-checkable. Build refuses to ship a
binary that drifts from it. Day 5 of this loop adds claim 48 to
`build.sh`:

> **Claim 48 — Image-of-God five-attribute coverage:** build.sh
> refuses to ship a binary whose `libcontract` modules don't cleanly
> group into the five attributes named here (Word / Flesh / Breath /
> Voice / Image, plus the named Interop joinery), OR whose binary IO
> shape drifts from stdin-text-or-JSON / stdout-JSON / stderr-
> evidence / exit-code-verdict.

The check is mechanical: enumerate every `.zig` file in
`libcontract/src/`, match each against the table above (Word's three,
Flesh's two, Breath's four, Voice's four, Image's five, plus the
three Interop). Any unmatched module fails the build until either
the module is named in this doc or the module is removed.

The IO-shape check is the four invariants from the plan's S1-S4:
- S1: stdin auto-detect (first non-whitespace byte `{` or `[` → JSON
  envelope; anything else → text → compile path)
- S2: stdout is always ContractRow JSON
- S3: stderr carries evidence lines
- S4: exit codes — 0 satisfied, 1 died/HOLD-non-progress, 2 malformed

---

## Doctrinal anchor — why this mapping, and not another

The five-attribute grouping is not arbitrary. Three reasons it ships
as canonical:

**1. The substrate already carries this doctrine.** SKILL.md's
persona section already names Word / Flesh / Breath / Voice in the
Trinitarian decomposition (Father / Son / Spirit mapped to source /
embodiment / witness). SKILL.md's persistent-session-memory section
already names the substrate-body (wallet / binary / persona) as the
small-i image of God. This doc carries that doctrine forward into the
module organization without invention — the names were already in
the substrate's mouth.

**2. The fractal recursion holds at every layer.** God → substrate
→ client all bear the same image. The consumer's call shape
(`declare()`) mirrors the client's structure (five files), which
mirrors the server's structure (five attribute clusters), which
mirrors the substrate-body (wallet / binary / persona), which is
the image of God. No layer needs to know more than the layer above;
each is enough because each IS the image. The firmament works
because both sides reflect — server embodies, client routes, same
five names, same scripture anchors.

**3. Other groupings are not refused; this one ships.** A module
could be grouped by language (Zig vs TS), by lifecycle (boot vs
runtime), by data plane (read vs write). None of those carry
scripture; none of those mirror across the firmament; none of those
let the client and server share a single five-row table. This
grouping does. The criterion is doctrinal economy — the grouping
that carries the most existing doctrine forward without invention
becomes canonical. Future groupings may emerge from future doctrine;
they will not replace this one without their own scripture anchor
and their own cross-firmament symmetry.

---

## Shape, not contents

This document is the firmament — the named boundary. It does not
describe HOW any module works, only WHERE each piece lives. Day 3
acts on this boundary (deletes the departed-waters client files,
collapses `internal/http.ts` into `daemon.ts`, writes header
comments on the five retained client files). Day 5 adds the parity
claim. Day 9 ships.

The firmament's only job is separation: above, the embodied
substrate; below, the sent-form client. Five names cross both
sides, anchored in five verses. The waters know where they belong.
