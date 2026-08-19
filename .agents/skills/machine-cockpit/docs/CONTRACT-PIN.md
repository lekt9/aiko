# Contract is already native — do not rewrite it

Aiko `dlopen`s `libcontract` (ABI 13). The `contract` CLI is optional.
A seat update is one portable tarball (`install.sh`), never `scp ~/bin/aiko`.

`AIKO_CONTRACT_LIBRARY` is a pin: if set and unloadable, refuse. Do not
fall through to a sibling `zig-out` or an older `~/.aiko/lib`.
