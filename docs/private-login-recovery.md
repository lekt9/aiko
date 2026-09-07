# Private sign-in recovery

The reported LinkedIn error followed a lost private Chromium target. Form inspection now recovers missing tabs without replaying credentials. Expired private pages are cleaned and marked for an explicit form reopen; status polling preserves the pending connector until then. Explicit disconnect remains final, and the connector's own authorization deadline is still enforced.

Recovery closes abandoned private popups, preserves verified credential custody while cleanup finishes, and does not start another login after recovering a verified result. Credential workflows cannot silently recreate their target. Login progress uses the existing durable event outbox, so a temporary event-publication failure does not turn a successful form response into an error or lose its trace.

The deployment script resolves paths from its own checkout. This permits releasing this fix independently of other work in the shared workspace.

## Reproduction

Deployment: https://aiko-agent.lewis-6d8.workers.dev/connect

```sh
TMPDIR=/tmp bun test apps/agent/test
pnpm --filter @unlock/agent typecheck
AIKO_NATIVE_SESSION_CHROME=/path/to/chrome \
  AIKO_NATIVE_LOGIN_TEST_DOMAIN=unlock-login-canary.lewis-6d8.workers.dev \
  bun test apps/agent/test/native-request-recovery-live.test.ts
bun scripts/verify-deployed-login-recovery.ts
CHROME_BIN=/path/to/chrome python3 scripts/verify-native-login-ui.browser.py --live
bash scripts/witness-login-repair.sh
```

The deployed API harness checks the exact runner bundle hash, restarts its runner, expires a pending form, polls through the public completion API, rejects a wrong synthetic password, and verifies the correct synthetic password. It also loads LinkedIn's actual username/password fields before and after a restart without submitting LinkedIn credentials. Its account and target checks prevent it from altering a personal account.

The browser harness uses real coordinate clicks and the deployed native-login and connection APIs. Only the Telegram session adapter is simulated for the dedicated canary bearer. This is not a test of authentication inside a real Telegram client or of the owner's LinkedIn password/MFA.

Evidence is retained in `artifacts/connectors/login-repair-api.json`, `artifacts/connectors/browser/native-login-recovery-ui.json`, its accompanying PNG, and `artifacts/verification/login-repair-*.log`. The outer witness requires fresh API and UI receipts. The API receipt includes the runner hash for future version checks; regression scripts and this incident record are versioned in Git.
