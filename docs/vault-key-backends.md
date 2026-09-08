# Vault key backends

The vault (`apps/server`) seals every secret — connection passwords, SSO material, session cookie jars — as `VaultCipher` envelopes: AES-256-GCM with a per-record 256-bit data-encryption key (DEK), bound to a context string (`tenant:<t>:<purpose>:<scope>`) as AAD. The DEK itself is wrapped by a configurable root of trust. `encryption.kind` in the 0600 server config selects the backend; switching backends is a re-seal, not a schema change.

## Backends

- `local` — `LocalKeyring`. DEKs wrapped with a named active key from a base64 keyring in private configuration. Multiple key versions are supported; `active` names the wrapping key for new envelopes.
- `kms` — `KmsKeyWrapper`. DEKs wrapped by AWS KMS with an encryption context (`unlock:<context>`), so KMS itself refuses cross-context decryption. Region and key ID come from configuration; credentials resolve through the ambient AWS chain.
- `1password-connect` — `OnePasswordKeyWrapper`. The KEK is a 32-byte field inside a 1Password item, referenced as `op://<vault>/<item>/<field>` and fetched from a 1Password Connect server (or the service-account API, which shares the path shape). 1Password never sees envelope contexts: per-context binding is enforced locally by the envelope AAD, exactly like `local`. Key material is held in memory, zeroed on refresh, and cached per `cacheTtlMs` (default: process lifetime).

## 1Password backend rules

- The Connect origin must be an origin-only HTTPS URL; loopback HTTP is accepted only when `localDevelopment` is enabled, matching the vault-address rule.
- The service-account/Connect token is 20–200 characters with no whitespace or control characters; it lives only in the 0600 config file.
- `redirect: "error"`, bounded response size (256 KiB), bounded timeout, and strict `op://` parsing (three non-empty segments, no whitespace).
- Key material must decode to exactly 32 bytes or the operation fails closed; a missing field, malformed item, or non-2xx response never degrades to a fallback.
- `keyId` is a stable digest of the secret reference, so records wrapped by a different provider or reference are rejected rather than silently opened.

## Rotation and migration

`server:rewrap` (`ops.ts`, maintenance window required) re-wraps every stored envelope's DEK in place with the current backend — run it after adding a key version, rotating the KMS key, or changing the 1Password item. Migration between backends (e.g. local → 1Password) is open-with-old, seal-with-new through the same maintenance flow; the DEK never appears outside the process, and both ciphers are constructed from configuration only.

## Trust model

1Password and KMS protect keys at rest and in transit; neither observes plaintext DEKs or envelope contents. Context binding is always local (AAD), so the security of a record is: AES-256-GCM with a random DEK, wrapped by the backend key, guarded by the context equality check on every open. Compromise of the database yields ciphertext only; compromise of a backend key yields wrapped DEKs whose contexts still must match.
