# credential-envelope

`CredentialEnvelope` stores both secret records and their inventory in the native OS
credential vault (macOS Keychain or Linux Secret Service). It has no file backend and
refuses when neither native vault is available. Cell inputs expose only inventory,
MFA handoff, revocation, and logout. Provision/rotation secrets enter only through a
trusted destination-bound caller using the Python API, never through a Cell port.

`SyntheticVault` is an in-memory witness double. Production construction in
`manage.py` is deliberately hard-wired to `OSCredentialVault`.
