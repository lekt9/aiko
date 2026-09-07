# Mini app login repair, 2026-09-07

Live Worker logs showed the open Telegram mini app repeatedly receiving HTTP 401. The launch data was older than the five-minute limit in `verifyInitData`. The UI reused that launch data for every API request, including while an owner was still using the app. The approval poll retried every three seconds, and the private sign-in panel replaced the authentication error with a generic connection failure.

Two additional defects were found in the sign-in path. The UI discarded an immediate `connected` response from the automatic login operation and proceeded to poll a connection that the backend had already completed. Browser setup and private login also lacked a propagated cancellation signal on this API path; native login waited behind the account's broader request queue.

Fresh Telegram launch data now establishes a signed, owner-bound 12-hour app session, held only in tab memory. Expired launch data cannot establish or renew it. Server authorization still checks the account, scopes and request origin. Authentication failures stop retries and tell the owner to close and reopen the mini app.

The login panel handles immediate success and verification-code challenges. Native operations receive cancellation and a 100-second server deadline. Native login uses the connector's existing mutation queue, and its progress endpoint can be read during browser work. A cancelled caller can stop waiting for another caller's browser startup without cancelling that startup.

Browser setup records timestamped stages and fixed installation-result markers in the owner's Tardigrade log. The UI updates them once per second. These include allocation, waking a saved browser, installing the runtime and Chromium, installing the driver, readiness and failure. Arbitrary shell output, credentials and private page content are excluded.

The isolated release preserved the previously deployed chat/model-routing and inline-sign-in repairs while excluding concurrent password-manager work. All 652 agent tests passed, with 8 environment-dependent tests skipped. Cloudflare and web TypeScript checks and the production builds passed. Browser-harness verified progress during a delayed form request, one credential submission with immediate success, and expired authentication ending the spinner without sending credentials. HTTP tests cover launch freshness, session expiry, tampering, restart and foreign-account rejection. Private diagnostics are under `/tmp/aiko-login-audit/`; the release checkout is `/tmp/aiko-mini-app-release/`.

Deployed Worker version: `3eee0411-ac00-464e-ad53-546fd09d89ca`.

The first deployed probe reused an already verified canary connection that renewed in the background; submitting a fresh login to it correctly failed. This revealed that read-only `form`, `view` and `finish` retries also rejected an already connected row. They now return its still-valid verified result without invoking the browser or accepting another credential submission. The 28 connector lifecycle/API tests pass, including this regression.

After explicitly disconnecting only the synthetic canary connection, the deployed test opened a fresh sign-in, observed live `opening`, `checking`, `starting` and `ready` progress, and returned `connected` with `credentialsSaved: true`. The safe receipt is `artifacts/mini-app-login/deployed-canary.json`. This verifies the deployed browser integration against the canary website, not a real third-party account login.

The final deployed read-only retry returned HTTP 200 and `connected` for the verified canary without submitting credentials again.
