---
name: typed-neuron/unbrowse
description: Sealed read boundary that admits a route only after a cited observation and separate cited replay agree, projects drift as demotion, and never retains credentials or raw traffic.
probe_input: '{"kind":"observation","credential_handle":"cred:opaque-probe"}'
expect_contains: observation-projected
---

# Unbrowse boundary limb

A capture is evidence, never admission. The boundary reduces each origin read to
route shape, response digest/schema, an opaque credential handle, and a source
firing id. The pure neuron projects those cited events into Contract state.
Only agreement from a distinct replay firing promotes; schema drift demotes
before response data may be served.

The package contains no credential provider and no ambient environment lookup.
Aiko supplies a scoped resolver at the last request boundary. Raw request and
response bytes remain invocation data and are excluded from every durable event
and projection. A later control plane admits/attaches these exact package bytes;
it does not generate a Smithers-specific variant.
