# Local entity-learn package

`entity-learn-0.2.0.tgz` is an npm pack of the actual working tree at `/home/deck/work/entity-learn`, including its built core and log adapter. This is not a registry substitute or a rewritten memory implementation. The upstream package declares MIT licensing; its package metadata and README are retained in the archive.

The source tree had pre-existing changes. `entity-learn-0.2.0.provenance.json` records the upstream HEAD, dirty-tree status, library/build file SHA-256 hashes and tarball SHA-256. Aiko additionally exports the already existing, framework-neutral `tardigradeLogSource` from the upstream `lib/index.ts` so it can be imported without the old Tardie-specific adapter. No other upstream library implementation was changed for Aiko.

## Runtime compatibility

Aiko imports only the public `entity-learn` core. The bundled `entity-learn/tardigrade` adapter targets Tardie 0.5 and **must not be imported into Aiko**. Aiko's native bindings target 0.22 and are covered by actual native-host recovery tests. pnpm reports the optional legacy peer mismatch; it resolves the peer to the existing 0.22.0 package rather than installing another runtime. Do not suppress this by downgrading Tardie.

## Updating deliberately

1. Review the local library changes and run its `npm test`.
2. Run `npm run build` in the library, then `npm pack --ignore-scripts --pack-destination /home/deck/work/unlock/vendor`.
3. Refresh the provenance hashes. Use a new artifact name if its content changes; keep the dependency and lockfile pointing at the reviewed bytes.
4. Install through pnpm, then run Aiko's typecheck, tests and build. Verify `pnpm --filter @unlock/agent list tardie entity-learn --depth 3` still shows only one Tardie version.

Do not silently replace the archive under an existing frozen lockfile. No install-time build script or absolute-path dependency is required on another machine.
