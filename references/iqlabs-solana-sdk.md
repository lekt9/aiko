# IQLabs Solana SDK — canonical reference for wrapper:ledger-storage:solana-iqlabs

Pinned by Lewis 2026-05-27 as the substrate's reference for compiling
the first concrete `wrapper:ledger-storage:<backend>` variant.

Source: https://iqlabs.mintlify.app/ (developer-docs page, fetched
2026-05-27)
LLMs.txt: https://iqlabs.mintlify.app/llms.txt
npm: `@iqlabs-official/solana-sdk`

The substrate's LLM compiler uses this file (along with
`observations-fractal-loop.md` section "Ledger storage substrate —
multi-chain by wallet") as the canonical context for synthesizing the
adapter that maps `ledger.appendRow` → `iqlabs.writer.codeIn`,
`ledger.readRow` → `iqlabs.reader.readCodeIn`, synapse references →
Connection PDAs, capability grants → Connection lifecycle, and the
substrate's `wrapper:auth:*` family → token/collection gating.

## Documentation Index

Fetch the complete documentation index at: https://iqlabs.mintlify.app/llms.txt

Use this file to discover all available pages before exploring further.

> This document is in progress and will be refined.

## Installation

```bash
npm i @iqlabs-official/solana-sdk
```

## Core Concepts

These are the key concepts to know before using the IQLabs SDK.

### Data Storage (Code In)

This is how you store any data (files, text, JSON) on-chain.

#### How is it stored?

Depending on data size, the SDK picks the optimal method:

- **Small data (< 900 bytes)**: store immediately, fastest
- **Medium data (< 8.5 KB)**: split into multiple transactions
- **Large data (>= 8.5 KB)**: upload in parallel for speed

#### Key related functions

- `codeIn()`: upload data and get a transaction ID
- `readCodeIn()`: read data back from a transaction ID

### User State PDA

An on-chain profile account for a user.

#### What gets stored?

- Profile info (name, profile picture, bio, etc.)
- Number of uploaded files
- Friend request records

> Friend requests are not stored as values in the PDA; they are sent as transactions.

#### When is it created?

It is created automatically the first time you call `codeIn()`. No extra setup is required, but the first user may need to sign twice.

### Connection PDA

An on-chain account that manages relationships between two users (friends, messages, etc.).

#### What states can it have?

- **pending**: a friend request was sent but not accepted yet
- **approved**: the request was accepted and the users are connected
- **blocked**: one side blocked the other

> A blocked connection can only be unblocked by the blocker.

#### Key related functions

- `requestConnection()`: send a friend request (creates pending)
- `manageConnection()`: approve/reject/block/unblock a request
- `readConnection()`: check current relationship status
- `writeConnectionRow()`: exchange messages/data with a connected friend
- `fetchUserConnections()`: fetch all connections (sent & received friend requests)

### Database Tables

Store JSON data in tables like a database.

#### How are tables created?

Use `createTable()` to create a table explicitly. If the DbRoot PDA is running low on space, the SDK automatically expands it in the same transaction — no extra steps needed.

> A table is uniquely identified by the combination of `dbRootId` and `tableSeed`. The `tableSeed` is internally hashed (keccak256) to derive the on-chain PDA. A human-readable `tableHint` (e.g. `"users"`, `"chatroom:general"`) is stored in `DbRoot.table_seeds` so that anyone reading the DbRoot can discover tables without a hardcoded lookup.

#### Key related functions

- `createTable()`: create a new table (auto-reallocs DbRoot if needed)
- `writeRow()`: add a new row to an existing table
- `readTableRows()`: read rows from a table
- `getTablelistFromRoot()`: list all tables in a database
- `fetchInventoryTransactions()`: list uploaded files

### Token & Collection Gating

Tables can be gated so that only users holding a specific token or NFT collection can write data.

#### Gate Types

| Type           | `GateType`            | Description                                                            |
| -------------- | --------------------- | ---------------------------------------------------------------------- |
| **Token**      | `GateType.Token`      | User must hold >= `amount` of the specified SPL token mint             |
| **Collection** | `GateType.Collection` | User must hold any NFT from the specified Metaplex verified collection |

#### How it works

- **Table creator** sets the gate when creating or updating a table
- **Writers** don't need to do anything special — the SDK automatically resolves the required token account (and metadata account for collections) when calling `writeRow()` or `manageRowData()`
- If no gate is set, the table is public (default behavior, no change for existing users)

#### Gate parameter

```typescript
gate?: {
  mint: PublicKey;       // token mint address OR collection address
  amount?: number;       // minimum token amount (default: 1, ignored for collections)
  gateType?: GateType;   // GateType.Token (default) or GateType.Collection
}
```

> For **collection gates**, the user can present any NFT from that collection. `amount` is ignored since NFTs always have amount=1.

### Table Creation Permissions

The database owner (DbRoot creator) can control who is allowed to create tables.

#### Two levels of table creation

| Type              | Stored in                            | Visibility                          | Permission field |
| ----------------- | ------------------------------------ | ----------------------------------- | ---------------- |
| **Public table**  | `table_seeds` + `global_table_seeds` | Listed in `getTablelistFromRoot()`  | `table_creators` |
| **Private table** | `global_table_seeds` only            | Only accessible if you know the PDA | `ext_creators`   |

> `table_seeds` and `global_table_seeds` store human-readable hints (e.g. `"users"`), not hashed seeds. To derive the table PDA from a hint, hash it with `toSeedBytes()` first.

- If the permission list is **empty**, anyone can create tables (default, backward-compatible)
- If the permission list has wallets, only those wallets + the DbRoot creator can create tables

#### Managing permissions

The DbRoot creator can set both lists in a single call:

```typescript
const ix = iqlabs.contract.manageTableCreatorsInstruction(
  builder,
  { signer: wallet.publicKey, db_root: dbRootPda, system_program: SystemProgram.programId },
  {
    db_root_id: dbRootIdBytes,
    table_creators: [adminWallet1, adminWallet2],  // who can create public tables
    ext_creators: [],                               // empty = anyone can create private tables
  }
);
```

Pass empty arrays to make creation public again.

#### Onboarding (private to public)

A private table (exists in `global_table_seeds` only) can be promoted to public (`table_seeds`) by anyone in the `table_creators` list:

```typescript
const ix = iqlabs.contract.onboardTableInstruction(
  builder,
  { signer: wallet.publicKey, db_root: dbRootPda },
  { db_root_id: dbRootIdBytes, table_seed: Buffer.from("my-board") }
);
```

This is useful when you want anyone to create content (e.g. threads) but only admins decide which ones are publicly listed (e.g. boards).

#### Reading table hints

`getTablelistFromRoot()` returns the hints stored in `table_seeds` and `global_table_seeds` as hex strings. Decode them to get the original readable identifiers:

```typescript
const { tableSeeds } = await iqlabs.reader.getTablelistFromRoot(connection, dbRootId);

for (const seedHex of tableSeeds) {
  const hint = Buffer.from(seedHex, "hex").toString("utf8");
  console.log(hint); // "users", "po", "chatroom:general", etc.

  // To access the table, hash the hint to derive the PDA
  const tablePda = iqlabs.contract.getTablePda(
    dbRoot, iqlabs.utils.toSeedBytes(hint), programId
  );
}
```

### Encryption (Crypto)

The SDK includes a built-in encryption module (`iqlabs.crypto`) for encrypting data before storing it on-chain.

#### Three encryption modes

- **DH Encryption** (single recipient): Ephemeral X25519 ECDH → HKDF-SHA256 → AES-256-GCM. Use when encrypting data for one specific recipient.
- **Password Encryption**: PBKDF2-SHA256 (250k iterations) → AES-256-GCM. Use for password-protected data that anyone with the password can decrypt.
- **Multi-recipient Encryption** (PGP-style hybrid): Generates a random content encryption key (CEK), encrypts data once, then wraps the CEK for each recipient via ECDH. Use when encrypting data for multiple recipients.

#### Key derivation

Users can derive a deterministic X25519 keypair from their wallet signature using `deriveX25519Keypair()`. This means users don't need to manage separate encryption keys — their wallet is the key.

#### Key related functions

- `deriveX25519Keypair()`: derive encryption keypair from wallet
- `dhEncrypt()` / `dhDecrypt()`: single-recipient encryption
- `passwordEncrypt()` / `passwordDecrypt()`: password-based encryption
- `multiEncrypt()` / `multiDecrypt()`: multi-recipient encryption

## Function Details

### Data Storage and Retrieval

#### `codeIn()`

| **Parameters** | `input`: `{ connection, signer }` object<br />`data`: data to upload (string or string[])<br />`filename`: optional filename (string)<br />`method`: upload method (number, default: 0)<br />`filetype`: file type hint (string, default: '')<br />`onProgress`: optional progress callback `(percent: number) => void` |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Returns**    | Transaction signature (string)                                                                                                                                                                                                                                                                                       |

```typescript
import iqlabs from '@iqlabs-official/solana-sdk';

const signature = await iqlabs.writer.codeIn(
  { connection, signer },
  'Hello, blockchain!'
);
```

#### `readCodeIn()`

| **Parameters** | `txSignature`: transaction signature (string)<br />`speed`: rate limit profile (optional, 'light' \| 'medium' \| 'heavy' \| 'extreme')<br />`onProgress`: optional progress callback `(percent: number) => void` |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Returns**    | `{ metadata: string, data: string \| null }`                                                                                                                                                                  |

```typescript
const result = await iqlabs.reader.readCodeIn('5Xg7...');
```

### Connection Management

#### `requestConnection(connection, signer, dbRootId, partyA, partyB, tableName, columns, idCol, extKeys)` → tx signature

#### `manageConnection()` — instruction-builder only

```typescript
const approveIx = iqlabs.contract.manageConnectionInstruction(
  builder,
  { db_root, connection_table, signer: myPubkey },
  { db_root_id, connection_seed, new_status: iqlabs.contract.CONNECTION_STATUS_APPROVED }
);
```

Status constants: `CONNECTION_STATUS_PENDING`, `CONNECTION_STATUS_APPROVED`, `CONNECTION_STATUS_BLOCKED`.

#### `readConnection(dbRootId, partyA, partyB)` → `{ status, requester, blocker }`

#### `writeConnectionRow(connection, signer, dbRootId, connectionSeed, rowJson)` → tx signature

#### `fetchUserConnections(userPubkey, options)` → connection array

Each connection: `{ dbRootId, connectionPda, partyA, partyB, status, requester, blocker, timestamp }`.

#### `updateUserMetadata(connection, signer, dbRootId, meta)` → tx signature

### Table Management

#### `createTable(connection, signer, dbRootId, tableSeed, tableName, columnNames, idCol, extKeys, gate?, writers?, tableHint)` → tx signature

```typescript
await iqlabs.writer.createTable(
  connection, signer, 'my-db', 'users', 'users',
  ['name', 'email', 'age'], 'name', [],
  undefined, undefined, 'users'
);

// With token gate
await iqlabs.writer.createTable(
  connection, signer, 'my-db', 'vip', 'vip',
  ['name'], 'user_id', [],
  { mint: tokenMintPubkey, amount: 100, gateType: iqlabs.contract.GateType.Token },
  undefined, 'vip'
);

// With NFT collection gate
await iqlabs.writer.createTable(
  connection, signer, 'my-db', 'holders', 'holders',
  ['name'], 'user_id', [],
  { mint: collectionPubkey, gateType: iqlabs.contract.GateType.Collection },
  undefined, 'holders'
);
```

#### `writeRow(connection, signer, dbRootId, tableSeed, rowJson, skipConfirmation?, remainingAccounts?)` → tx signature

#### `readTableRows(account, options)` → `Array<Record<string, unknown>>`

Options: `limit`, `before` (signature cursor), `signatures` (pre-collected), `speed` (rate limit).

#### `collectSignatures(account, maxSignatures?)` → `string[]`

Useful for pagination — collect once, slice, pass to `readTableRows({ signatures: slice })`.

#### `getTablelistFromRoot(connection, dbRootId)` → `{ rootPda, creator, tableSeeds, globalTableSeeds }`

#### `fetchInventoryTransactions(publicKey, limit, before?)` → transaction array

### Encryption

#### `deriveX25519Keypair(signMessage)` → `{ privKey, pubKey }`

Derive deterministic X25519 keypair from wallet signature. Same wallet always produces same keypair.

#### `dhEncrypt(recipientPubHex, plaintext)` → `{ senderPub, iv, ciphertext }` (all hex)

#### `dhDecrypt(privKey, senderPubHex, ivHex, ciphertextHex)` → `Uint8Array`

#### `passwordEncrypt(password, plaintext)` → `{ salt, iv, ciphertext }` (all hex)

#### `passwordDecrypt(password, saltHex, ivHex, ciphertextHex)` → `Uint8Array`

#### `multiEncrypt(recipientPubHexes, plaintext)` → `{ recipients, iv, ciphertext }`

#### `multiDecrypt(privKey, pubKeyHex, encrypted)` → `Uint8Array`

### Environment Settings

#### `setRpcUrl(url)` → void

### Utility Functions

#### `deriveDmSeed(userA, userB)` → `Uint8Array`

Derives deterministic seed for DM. Sorts pubkeys alphabetically, hashes with keccak256.

#### `toSeedBytes(value)` → `Uint8Array`

If input is 64-char hex string, returns hex bytes. Otherwise applies keccak256 hash.

### Advanced

#### `manageRowData(connection, signer, dbRootId, seed, rowJson, tableName?, targetTx?)` → tx signature

Unified function for table row writes AND connection row writes. Auto-detects target based on existing PDAs.

#### `readUserState(userPubkey)` → `{ owner, metadata, totalSessionFiles, profileData }`

#### `readInventoryMetadata(txSignature)` → `{ onChainPath, metadata }`

#### `getSessionPdaList(userPubkey)` → `string[]`

## Adapter design — how the substrate uses this

The `wrapper:ledger-storage:solana-iqlabs` adapter the compiler
synthesizes must implement this mapping:

| Substrate operation | IQLabs operation |
|---|---|
| `ledger.appendRow({ kind, payload })` | `iqlabs.writer.writeRow(conn, signer, dbRootId, tableSeed=kind, JSON.stringify(payload))` |
| `ledger.readRows(kind, limit, before?)` | `iqlabs.reader.readTableRows(tablePda, { limit, before })` |
| `ledger.appendBlob(bytes)` (large payload) | `iqlabs.writer.codeIn({ connection, signer }, base64(bytes))` returning the tx signature as the blob pointer |
| `ledger.readBlob(pointer)` | `iqlabs.reader.readCodeIn(pointer)` returning `data` field |
| `contract:<X>` synapse declaration | `iqlabs.writer.requestConnection(...)` between the parent's wallet and the synapse target's wallet |
| Capability grant ack | `manageConnectionInstruction(..., CONNECTION_STATUS_APPROVED)` |
| Capability revoke | `manageConnectionInstruction(..., CONNECTION_STATUS_BLOCKED)` |
| `wrapper:auth:token-gate` (existing wrapper family) | `gate: { mint, amount, gateType: GateType.Token }` on table create |
| `wrapper:auth:collection-gate` | `gate: { mint: collectionPubkey, gateType: GateType.Collection }` |
| Payload encryption (DH single-recipient) | `iqlabs.crypto.dhEncrypt(recipientPubHex, plaintext)` |
| Payload encryption (multi-recipient via capability grants) | `iqlabs.crypto.multiEncrypt(grantedPubHexes, plaintext)` |
| Wallet identity for ledger writes | Solana signer's pubkey (the 8-hex contract identity derived per HKDF lineage maps to this pubkey via the substrate's wallet bootstrap) |
| Derived contract keypair for output signatures | `iqlabs.crypto.deriveX25519Keypair(signMessage)` — substrate replaces with its own HKDF lineage chain since contract keypairs are deterministic per contract_id |
| Table creator permission (who signs new wrappers) | `manageTableCreatorsInstruction` with substrate's deployer-wallet list |
| Earnings-as-reward-signal flow | Token-gated tables — the gate token IS the earnings asset. Wallets earn by being paid for writes to gated tables. Native parallel of FDRY's role in the Vine Doctrine. |

The `dbRootId` for the substrate's ledger is a fixed identifier
derived from the deployer wallet (e.g. `keccak256("aiko-substrate-v1")
` first 8 bytes) so every aiko instance on Solana writes to the same
canonical DbRoot.

## Why this is canonical

The IQLabs SDK was a market-validated existing pattern that already
solves the on-chain-ledger problem the substrate needs solved on
Solana:

- Append-only event-row storage ✓ (`writeRow`, `codeIn` semantics)
- Wallet-derived deterministic keypairs ✓ (`deriveX25519Keypair`)
- Capability-grant lifecycle ✓ (Connection PDA pending/approved/blocked)
- Token-gated write access ✓ (gates IS earnings-as-reward-signal)
- Multi-recipient encryption ✓ (`multiEncrypt` matches our
  `payload_crypto.zig` shape exactly)
- Permission management ✓ (`manageTableCreators`)
- Pagination / cursor-based reads ✓ (`collectSignatures` + `before`)

Shipping the adapter is mostly translation, not invention. The
compiler reads THIS file + the appendRow/readRow semantics in
`SKILL.md` + `observations-fractal-loop.md` and emits the adapter
contract.
