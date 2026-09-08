# Hosted Aiko

Aiko runs as a Cloudflare Worker with one Durable Object per account. The web console, connector UI, API and Telegram webhook reach that Worker directly. Browsers run in persistent, account-isolated Codegraff VMs. No desktop service, local Chrome session, sibling checkout, or SQLite file on the developer's computer is needed to operate the hosted app.

| State or capability | Hosted owner |
| --- | --- |
| Threads, events, alarms and recovery | Account Durable Object, using the Tardie runtime |
| Memory and journals | entity-learn in Durable Object SQL storage |
| Workflows, connector records and sealed password-manager grants | Account Durable Object |
| Browser profiles, login custody, captured request evidence | Account's remote Codegraff VM |
| Encrypted recovery snapshots | R2; independent `AIKO_BACKUP_KEY` |
| User authentication | Account-bound API tokens or verified Telegram Mini App sessions |
| Operator access | Separate `AIKO_OPERATOR_TOKEN`; owner credentials cannot export or restore accounts |

The optional Unlock vault service in `apps/server` uses Postgres/Supabase. It is separate from Aiko's hosted state and identity. Adding Supabase tables does not move Tardie history or authenticate Aiko users. Hosted Aiko does not require Supabase. SQLite here is a storage engine managed by the cloud host, not a dependency on the developer's disk.

## Build from a fresh checkout

Install Node 24, Bun 1.4 and pnpm 10.12.1. Building requires the playground
checkout beside Unlock as `../unbrowse-playground`; the browser library is a
direct `link:` to its `runtime/`, not a local snapshot. See
[shared browser setup and CI access](shared-browser-runtime.md). Hosted users
still need no local checkout or browser.

```sh
# If the sibling is absent, clone it once:
git clone git@github.com:unbrowse-ai/playground.git ../unbrowse-playground
(cd ../unbrowse-playground/runtime && bun install --frozen-lockfile --ignore-scripts)
pnpm install --frozen-lockfile --ignore-scripts
pnpm aiko:cloud:build
pnpm aiko:cloud:verify
```

The build compiles protocol and SDK packages, bundles the remote browser runner, builds connector assets, typechecks the Worker and performs a Wrangler dry run. It needs no Aiko secrets or native state. The verification starts real local workerd with synthetic credentials, writes a message, stops and restarts the process, and checks durable readback, duplicate delivery, account isolation and read-only scopes. It makes no model, browser-provider or Telegram calls.

For the browser client regression tests, explicitly install its hash-verified binary first (the cloud build does not require it):

```sh
bun -e 'import { installPinnedAgentBrowser } from "@unbrowse/browser-harness/install-agent-browser"; await installPinnedAgentBrowser();'
pnpm test:browser-client
```

## Deploy to your account

Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell or CI secret store. The checked-in Wrangler configuration has no fixed account ID. Configure the Worker name, model routes and R2 bucket in `apps/agent/wrangler.jsonc`. To keep a separate configuration, place it alongside that file and set `AIKO_WRANGLER_CONFIG` to its absolute path. Keep actor instance IDs stable when redeploying existing data.

Create the configured R2 bucket once in the target account:

```sh
pnpm --filter @unlock/agent exec wrangler r2 bucket create aiko-state-backups
```

Provide these secrets through the environment or an owner-only `AIKO_SECRET_FILE` (the legacy separate `AIKO_OPERATOR_FILE` is also supported):

- `AIKO_OPERATOR_TOKEN`: random operator credential, at least 32 characters.
- `CODEGRAFF_API_KEY`: model gateway and remote browser VM access.
- `CEREBRAS_API_KEY`: required by the default Cerebras model routes; alternatively configure all routes for your chosen available provider.
- `AIKO_PLANE_CREDENTIALS`: Required JSON account/digest/scopes bindings; use `[]` explicitly for a new deployment with only a canary account. To provision a token, create an owner-only `AIKO_SECRET_FILE` and run `pnpm aiko:key new /absolute/private/client.env read,write`; then deploy the updated configuration. This writes the client token privately and adds its digest to that configuration file. Retain the complete desired account list on redeploy.
- `AIKO_MANAGER_KEY` and `AIKO_MANAGER_PROVIDERS_JSON`: needed when enabling password-manager connections. Retain the same encryption key for existing grants.
- `AIKO_BOT_TOKEN` and `AIKO_WEBHOOK_SECRET`: optional pair for Telegram. Web/API deployments can omit both.
- `AIKO_BACKUP_KEY`: a base64-encoded 32-byte encryption key, supplied through the environment, `AIKO_SECRET_FILE`, or the deployment state file. Generate it **once for a new deployment**, save it in your recovery secret store, and reuse it on every machine. The deploy command refuses to invent a replacement key.

Additional voice, Arcade and connector-vault secrets are passed through when configured. Model choices and public-access settings belong in Wrangler vars. Changing an existing deployment to disable an integration also requires removing its retained Worker secrets; omitted secrets are not deleted by deployment.

```sh
pnpm aiko:cloud:deploy
```

Publishing uploads code and secrets in one Worker version, then checks `/ready`. It does not stop a local service or change Telegram delivery. New Telegram setup and existing-host migration must explicitly configure the webhook; for an existing local installation use the [verified cutover procedure](aiko-cloudflare-cutover.md), which preserves history and pending updates.

Wrangler supports account selection through [system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) and publishing secrets with [deploy `--secrets-file`](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

## Ship an existing installation with one command

After the setup above, run from the Unlock checkout:

```sh
pnpm ship --message "Release hosted Aiko"
```

[`scripts/ship.ts`](../scripts/ship.ts) owns this sequence:

1. Show the current branch, upstream and configured Worker URL. Refuse conflicts,
   obvious credential filenames and configured secret values in the proposed
   commit. This is a last guard, not a comprehensive secret audit.
2. Build the Mini App, native Tardigrade actors, both Durable Object classes and
   browser/compute/coding runners. Freeze the compiled Worker modules, assets and
   Wrangler configuration for this release; publishing does **not** rebuild from
   a checkout another editor might change.
3. Run `git add --all`, commit pending changes (or reuse a clean HEAD), and push
   that exact commit without force. This saves a **source checkpoint**, not a
   claim that verification passed. Inspect the displayed changes before running;
   the command includes all nonignored changes in this repository.
4. Require workspace types/tests, release-script regression tests, isolated UI
   journeys and the local workerd restart/isolation check. Workerd verifies the
   frozen Worker build. Check logs remain under `artifacts/ship/<release-id>/`.
5. Refuse source, artifact, branch, upstream or private-configuration drift. Then
   publish the frozen build once using the existing deploy script.
6. Read back the release ID, commit and linked browser-source digest from
   `/ready`; compare the served Mini App assets byte-for-byte; check the console,
   control page, denied anonymous actor access and authorized canary history read.

The Mini App, console/API, Telegram handler and native actors are **one hosted
Worker release**, not separate actor deployments. This does not deploy the
optional `apps/server` vault, another app's Worker, or the playground app; migrate
an external database; change the Telegram webhook; send a test chat message; or
force-restart existing VMs. Updated runners are included, but this command does
not confirm adoption by already-running VMs; their existing preparation/version
checks govern it. Remote model/browser quality and a private Telegram login are
not established by these release checks.

The directly linked browser checkout is fingerprinted even when dirty, and its
HEAD/dirty state are recorded. It is **not** committed or pushed by this command.
Keep its source changes in its own repository; the frozen release artifacts are
local evidence, not a replacement for source custody. Dependencies, the verified
browser-client binary, Chromium/browser-harness and any local media-test runtime
must already be installed. A failed prerequisite or test blocks deployment; there
is no skip-tests flag.

```sh
pnpm ship --dry-run  # Show target, changes and plan; no build/commit/push/deploy
pnpm ship --verify   # Read-only recheck of the last release; never republishes
```

A failed check leaves any completed commit/push intact. Fix the blocker and run a
new release. Once publishing may have begun, the outcome is held as uncertain: the command
records that state in `.git/aiko-ship.json` (the common Git directory for
worktrees) and refuses another publish until it is reconciled. Try `--verify`
first. If it still fails, inspect Wrangler's deployment/version history (the
version message includes the release ID) and the receipt before deciding what to
do; do not delete the receipt simply to retry.
The same directory holds a release lock with the running PID. Remove a stale lock
only after confirming that its release process has stopped. No automated rollback
or repeated publish is attempted.

## Operate and recover from another computer

The deploy command saves only canary credentials, the recovery key and the deployed URL in `AIKO_CLOUDFLARE_STATE_FILE` (default: `$XDG_CONFIG_HOME/unbrowse/aiko-cloudflare.env`, or `~/.config/unbrowse/aiko-cloudflare.env`). The file is written atomically with mode 0600. Verifiers also accept the corresponding `AIKO_*` environment variables, so CI does not need that file. Store these credentials in your secret manager; a private file remaining only on the old computer is not a recovery plan.

Use the deployed `/` console or `/control` with the appropriate credential. `/connect` serves the connector interface. These URLs do not proxy through the developer's computer. Account tokens carry read/write scopes and cannot choose another account by changing query parameters. Telegram sessions are verified against the deployed bot credentials.

### Open the connector interface

For this installation, open [Aiko in Telegram](https://t.me/aikospillstea_bot?start=web), press **Start** if needed, then choose **Connect apps** from the chat menu. Select an app or **Add a website**, and complete its private sign-in. Passwords and verification codes belong in that form, never in chat.

The public page is [Aiko Connect](https://aiko-agent.lewis-6d8.workers.dev/connect). Opening it in an ordinary browser does not authenticate you: the current connector UI requires a verified Telegram Mini App launch. Account bearer credentials work with the API and console; they are not a sign-in option on `/connect`. Do not put credentials in URL parameters.

A successful `/ready` response checks configuration, not connector execution. Before a connector handoff, run `bun scripts/verify-connectors-deployment.ts` and the isolated native-login/index check in [connector verification](connector-verification.md). Preserve failed receipts; a verified login does not prove indexing or reusable tools succeeded.

Use [encrypted cloud backups and recovery](aiko-cloud-backup.md) to replace a lost remote browser VM or restore an account. Keep `AIKO_BACKUP_KEY`, `AIKO_MANAGER_KEY`, operator credentials and Cloudflare/Codegraff access in durable secret custody. The cloud service continues when the development machine is off; access to the cloud providers and recovery keys is still required.

The historical local demo, SQLite export tools and optional vault service remain available for development and migration. They are not the hosted entry point.

Foreground fallback verbosity is enabled in Wrangler with `AIKO_VERBOSE_FALLBACKS=true`. Missing answers, missing results, uncertain browser outcomes, failures and cancellations produce a chat notice with the reason and bounded, redacted result summaries. Reply-formatting failures also show a notice with the available answer. Browser summaries include action/status metadata rather than raw page or form contents. This does not retry uncertain actions or deliveries, and it does not repair requests that have not reached a terminal event.

`AIKO_VERBOSE_FALLBACKS_SINCE` is the fixed activation timestamp in epoch milliseconds. Keep it stable on redeploy: older suppressed replies remain quiet, while new fallbacks become visible. `/ready` reports both settings. The native host accepts the same environment variables.

For a stuck queue, an operator can `POST /api/control/wake?account=ACCOUNT` to schedule processing of existing durable work. It does not insert a message, resume terminal turns, or reset delivery records. Account credentials cannot use this operation. Alarm errors appear as `runtime.alarm_failed` in Worker logs; retired account naming epochs disarm their alarms while retaining history. The native scheduler keeps router and control threads eligible while foreground work is pending.
