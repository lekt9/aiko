# commons

Converged monorepo for the Unbrowse workspace. Everything that used to be a
separate clone — several with no remote at all — is now one repository with one
history.

## Clone

```bash
git clone git@gitea:Unbrowse/commons.git
```

That's it. No submodule init, no `--recurse-submodules`, no bootstrap script.

## Pull

```bash
git pull
```

## What's inside

| Path | What it is | Was |
|------|-----------|-----|
| `aiko/` | Aiko agent + contract harness, skills, apps | local only, **no remote** |
| `contract/` | Contract substrate (5263 commits) | local only, **no remote** |
| `unbrowse/` | Unbrowse core | github.com/unbrowse-ai/unbrowse |
| `neuron/` | Neuron (Zig) — membrane, swarm, morphogenesis | gitea `Unbrowse/neuron` |
| `unbrowse-dev/` | Unbrowse dev snapshot | local only, **no remote** |

Three of these existed nowhere but this laptop before convergence.

## History

Imported with `git subtree add`, so **all 5393 commits are present and
reachable**, and `git blame` walks back into the original commits normally.

One caveat: `git log -- contract/<file>` stops at the import merge. Historical
commits recorded that file at the repo root (`CLAUDE.md`), not at
`contract/CLAUDE.md`, so path-filtered log doesn't cross the merge boundary. To
read a project's history directly:

```bash
git log 65b58cad          # contract's pre-merge tip
git blame contract/CLAUDE.md   # works across the boundary
```

Each import merge commit records the source tip SHA in its message.

## Artifacts are not tracked

The pre-convergence working trees held ~98 GB (aiko 70 G, contract 28 G) —
almost entirely build output and benchmark runs. Only real source came across
(~322 MB). The root `.gitignore` keeps it that way: `node_modules/`, `dist/`,
`build/`, `target/`, `zig-out/`, benchmark run dirs, and local agent state
(`.grok/`, `.graff/`).

Excluded at convergence: `dist/` (865 M), `benchmarks/harbor/` (939 M), tauri
`binaries/` (446 M), `node_modules/` (308 M), and benchmark run dirs that
contained embedded git repos (they would have become broken gitlinks).

The original clones are untouched at `/Volumes/Disk/home-offload/unbrowse/` if
you ever need the old artifacts back.

## Pushing a project back upstream

`unbrowse/` and `neuron/` still have upstreams:

```bash
git subtree push --prefix=unbrowse git@github.com:unbrowse-ai/unbrowse.git main
git subtree push --prefix=neuron   git@gitea:Unbrowse/neuron.git             main
```
