# Offer inline sign-in for account tasks

When a requested task needs an unconnected website account, Aiko calls `connector_recommend` with the service name and domain. The existing durable login notification supplies a Telegram **Sign in** button that opens the private connection screen. Aiko should briefly ask the user to sign in there, check the verified connection state, and continue within the user's authorization.

The previous instructions made connector catalog discovery a prerequisite for every login, although the native browser connector already opens a domain directly. They could lead the model to refuse job applications or offer a manual login walkthrough instead of opening the available sign-in screen. The updated actor instructions and tool descriptions distinguish API discovery from native website authentication. Credentials stay in the private login surface; opening that surface does not authorize an application submission or claim a successful login.

The evaluation used Codegraff `deepseek-v4-flash`, the native Cloudflare host adapter, actual code-mode tool dispatch, `connector_recommend`, and durable login notifications. Connection and Telegram transports were fixtures, so no real job application, sign-in, or external message occurred. The API catalog was unavailable in every case. Each case passed only when it invoked the website connection, produced exactly one inline button, and completed the native turn.

| Case | Previous instructions | Updated instructions |
| --- | --- | --- |
| JobStreet application requiring login | No button; deferred the task | One Sign in button |
| Carousell listing requiring login | One Sign in button | One Sign in button |
| LinkedIn applications, held out | One Sign in button | One Sign in button |

The matched runs used the same current tool surface; the actor instructions differed. All three updated cases called the domain login directly. They made 14 model calls in total, compared with 22 for the baseline. This small evaluation is a behavior regression check, not a general quality or latency benchmark. Token totals and billed cost are unavailable. Early fixture runs with a mismatched host or an invalid placeholder authorization origin were discarded.

The 52 targeted regression tests passed, including private sign-in with the catalog available, absent, or unavailable; owner isolation; one inline button across restart; code-mode tool dispatch; and the existing response/model fallback paths. Cloudflare typechecking, the Worker dry run, and the native CLI build passed. The actor build digest is `sha256:fe054fac5746c2d539751ddeb678c9db69fd9b60c7adee87835776d963918080`.

Evaluation artifacts are under `artifacts/inline-login-response/`. Deployment was prepared in an isolated checkout to preserve the previously deployed chat repair and model configuration while other workspace changes were in progress.

Deployed Worker version: `014448f4-90a3-4413-8067-7476f148ae9c`.
