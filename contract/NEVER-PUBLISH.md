# Contract subtree — publication note

This file used to describe a standalone closed skill tree at
`~/.agent-skills/contract/`. That layout is gone.

**Current fact:** `contract/` lives in the published Aiko monorepo
([`github.com/lekt9/aiko`](https://github.com/lekt9/aiko)) so the Zig root
build can link `libcontract` and `aiko-doctor` from one clone.

## What is still true

- Contract is the durable interpreter: ledger, W6H, signatures, validity
  windows. It is not a second agent and it is not the user-facing `aiko`
  binary.
- Do not `npm publish` this subtree. There is still no `package.json` here.
  The public edge for JS speakers, if any, is a thin client — not this tree.
- Do not put customer operational data, wallet root keys, or operator
  Tailscale hosts in this directory.
- `docs/` under this subtree are design notes and due-diligence drafts, not
  the product README. Start at [`../docs/SOURCE-OF-TRUTH.md`](../docs/SOURCE-OF-TRUTH.md).

## What is no longer true

- This is not `~/.agent-skills/contract/`.
- A pre-push hook that refuses `github.com` is not the publication policy of
  this monorepo. The public remote is GitHub.
- Clone instructions that point at a private Gitea or Tailscale IP are stale.

License for the published monorepo is Apache-2.0 at the repository root.
