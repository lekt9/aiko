# First-run setup gate

Product rules for the **full-screen initialization wizard** before the workbench home.

## Goals

1. **Hard gate:** embedded Aiko CLI must be found and runnable before entering home.
2. **Soft gate:** Official login / API key / custom relay may be **skipped**.
3. Match app chrome (tokens, logo, dark/light); **no scrollbars** on the gate page.
4. The runtime is native: packaged builds use only their version-matched embedded Aiko CLI sidecar.

## Flow

```
boot → probe CLI (≤3s per --version; Host spawn_blocking)
  ├─ timeout (FE 12s) → loading chrome + Retry / open Setup (not infinite spin)
  ├─ embedded CLI missing/invalid → SetupWizard Runtime error + reinstall guidance
  ├─ CLI ok + !setupWizardCompleted → Account step (skippable)
  └─ CLI ok + setupWizardCompleted → home
```

### Step 1 — Runtime (cannot skip)

| Action | Host |
|--------|------|
| Verify | `probe_cli` resolves the packaged `aiko` sidecar and runs `--version` |
| Retry | Re-run the embedded-sidecar probe |
| Failure | Explain that the package is incomplete and direct the user to reinstall Aiko App |

There is no runtime download, manual binary picker, PATH selection, WSL CLI selector,
or CLI self-update surface. The app and CLI are one versioned package.

### Step 2 — Account (skippable)

OAuth, official key, relay, import CLI / grok-go. No `window.prompt`.

### Step 3 — Ready → Enter

Persists `setupWizardCompleted: true`. If account skipped: `authSetupDeferred: true`.

## Settings fields

| Field | Role |
|-------|------|
| `setupWizardCompleted` | Wizard finished with CLI ready |
| `authSetupDeferred` | User skipped account step |
| `onboardingDone` / `setupSkipped` | Legacy; migrated when CLI present |

## UI

- Component: `src/components/SetupWizard.tsx`
- Styles: `src/styles/setup-wizard.css` (overflow hidden, no scrollbars)
- i18n: `setup.*` keys in `src/i18n/messages.ts`

## Honesty (SETUP-GATE-PRO)

Pure helpers: `src/lib/setupGatePro.ts` (+ tests).

| Rule | Behavior |
|------|----------|
| Hard CLI | `canEnterHome` / boot `resolveSetupGateBoot` never mark **ready** without `cliFound` |
| Soft account | Account step is always skippable; `buildAuthDeferredFlags` never sets deferred when auth is ok |
| Errors | Embedded-sidecar probe and account failures use stable `setup.error.*` titles + recovery hints |
| Ready checklist | Never soft-ok CLI; auth row is soft when skipped |
| Legacy migrate | Older `onboardingDone` / `setupSkipped` + CLI → write `setupWizardCompleted` once |

## CLI probe (macOS, Windows, Linux)

`cli_probe::probe_cli` resolves the sidecar beside the packaged application binary.
The probe must reject a missing, non-runnable, or version-skewed sidecar. It never
falls back to a home directory, package manager, manual setting, or process PATH.

## Commands

| Command | Role |
|---------|------|
| `probe_cli` | Verify the embedded Aiko CLI sidecar |

## Managed configuration (enterprise, optional)

Settings → Runtime → **Managed setup** (`ManagedSetupPanel`):

1. **CLI ready** (hard dependency; same as first-run Runtime).
2. **Team login / `AIKO_DEPLOYMENT_KEY`** (or `[endpoints].deployment_key`).
3. **Preview** — `aiko setup --json` (writes nothing; secrets redacted).
4. **Install** — `aiko setup` with in-app confirm (no `window.confirm`); soft-respawns agent.
5. **Verify local status** — host `managed_setup_status` soft-probes:
   - `managed_config.toml` / `requirements.toml` / `managed_config.sig.json` / `managed_identity.sig.json` under active `AIKO_HOME`
   - system `/etc/aiko/managed_config.toml` when present (Unix)
   - `aiko inspect` flags `managedSettingsActive` / `Exists` / `Path` when CLI works
   - **explicit** inspect/doctor signature verification fields when present (`signatureVerified` etc.) → `signatureVerified` + `signatureVerifySource`; otherwise `presenceOnly: true`

Signature UI status (pure `deriveSignatureStatus` / `buildSignatureView`):

| Status | Meaning |
|--------|---------|
| `absent` | No managed artifacts |
| `present_unverified` | Files / inspect flags present; App did **not** crypto-verify |
| `verify_ok` | **Only** when host/CLI/doctor explicitly reported verification success |
| `verify_failed` | CLI rejected signature / envelope, or host reported verified=false |
| `soft_fail` | Probe/inspect unavailable or status unknown |

The App **does not re-verify cryptographic signatures**; path presence and `managedSettingsActive` never invent `verify_ok`. CLI rejects bad signatures before writing. Soft-fail when CLI/inspect is missing.

## Non-goals

- Downloading or selecting a separate CLI at runtime.
- Forcing project selection before home.
- App-side re-implementation of managed-config crypto verification.
