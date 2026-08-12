# Security Policy

Please report security vulnerabilities **privately**. Do not open a public
GitHub issue or pull request that describes an exploitable flaw.

## How to report

1. Preferred: a [GitHub private security advisory](https://github.com/lekt9/aiko/security/advisories/new) on this repository.
2. If you cannot use advisories, contact the maintainers listed on
   [`github.com/lekt9/aiko`](https://github.com/lekt9/aiko).

Include:

- the affected binary or crate (`aiko`, `aiko-doctor`, `neuron`, `libcontract`, desktop)
- a minimal reproduction
- impact (data exposure, local privilege, remote effect)

## What this project will not do

- Treat a public issue as a coordinated disclosure channel
- Commit credentials, private keys, or customer operational data as “repro fixtures”

## Scope notes

- Model-provider keys belong on the operator-side proxy, not in client docs or
  client config for the default login path (`aiko login`).
- The desktop and native loopback API are local trust boundaries. Treat
  anything bound beyond loopback as a security-sensitive change.
