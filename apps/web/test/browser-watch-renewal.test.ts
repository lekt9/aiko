import { afterEach, expect, test, vi } from "vitest";
import {
  makeWatchRenewal,
  retainedWatchRenewal,
  type WatchStatus,
  type WatchSite,
} from "../src/lib/browser-watches";
import { connectorRequest } from "../src/lib/connectors";
import { handleConnectorRequest } from "../src/server/connector-proxy";
const site: WatchSite = {
  connectionId: "site",
  connectionRevision: "r1",
  sourceGeneration: 1,
  origin: "https://example.test",
  label: "Site",
  events: [],
  expiresAt: 9000,
};
const watch: WatchStatus = {
  id: "watch",
  generation: 3,
  leaseRevision: 2,
  status: "paused",
  budget: { used: 90, limit: 100, remaining: 10 },
  config: {
    id: "watch",
    label: "Updates",
    connectionId: "site",
    connectionRevision: "r1",
    sourceGeneration: 1,
    origin: site.origin,
    kind: "push",
    outcome: "received",
    action: { kind: "actor", instruction: "Summarize" },
    expiresAt: 5000,
    backlog: 32,
    maxOccurrences: 100,
  },
};
test("renewal pins current generation and clamps actual connection expiry after selection", () => {
  expect(makeWatchRenewal(watch, site, 10000, 120, 6000)).toEqual({
    id: "watch",
    expectedGeneration: 3,
    expectedLeaseRevision: 2,
    expiresAt: 9000,
    maxOccurrences: 120,
  });
  expect(watch.status).toBe("paused");
  expect(watch.budget?.used).toBe(90);
  expect(makeWatchRenewal(watch, site, 5000, 120, 1000).expiresAt).toBe(5000);
});
test("unchanged or smaller bounds, exhausted ceiling, expired or changed connections fail", () => {
  for (const [end, limit] of [
    [5000, 100],
    [4000, 120],
    [7000, 99],
    [7000, 1_000_001],
  ])
    expect(() => makeWatchRenewal(watch, site, end!, limit!, 1000)).toThrow();
  expect(() =>
    makeWatchRenewal(
      { ...watch, budget: { used: 120, limit: 100, remaining: 0 } },
      site,
      6000,
      120,
      1000,
    ),
  ).toThrow();
  expect(() =>
    makeWatchRenewal(watch, { ...site, expiresAt: 800 }, 9000, 120, 1000),
  ).toThrow();
  expect(() =>
    makeWatchRenewal(
      watch,
      { ...site, connectionRevision: "r2" },
      9000,
      120,
      1000,
    ),
  ).toThrow("connection changed");
});
test("pending and attention statuses reconstruct identical predecessor and bounds after restart", () => {
  for (const status of ["pending", "needs-attention"] as const) {
    const current = {
      ...watch,
      renewal: {
        leaseRevision: 3,
        expiresAt: 9000,
        maxOccurrences: 120,
        status,
        attempts: 1,
        deadlineAt: 7000,
      },
    };
    const request = retainedWatchRenewal(current);
    expect(request).toEqual({
      id: "watch",
      expectedGeneration: 3,
      expectedLeaseRevision: 2,
      expiresAt: 9000,
      maxOccurrences: 120,
    });
    expect(() => makeWatchRenewal(current, site, 9000, 130, 1000)).toThrow(
      "existing renewal",
    );
    expect(
      retainedWatchRenewal({
        ...current,
        renewal: { ...current.renewal, status: "confirmed" },
      }),
    ).toBeUndefined();
  }
});
const original = process.env.AIKO_CONNECTOR_ORIGIN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env.AIKO_CONNECTOR_ORIGIN;
  else process.env.AIKO_CONNECTOR_ORIGIN = original;
});
test("client preserves exact renewal on uncertain response and proxy uses the owner's fixed endpoint", async () => {
  const body = makeWatchRenewal(watch, site, 9000, 120, 1000);
  vi.stubGlobal("window", {});
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(Error("response lost"))
    .mockImplementation(async () =>
      Response.json({ available: true, result: { status: "pending" } }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    connectorRequest("/channels/browser-watches/renew", body, undefined, {
      bearer: "owner",
      telegram: false,
    }),
  ).rejects.toThrow();
  await connectorRequest("/channels/browser-watches/renew", body, undefined, {
    bearer: "owner",
    telegram: false,
  });
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  expect(fetch.mock.calls[1][0]).toBe("/api/channels/browser-watches/renew");
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const response = await handleConnectorRequest(
    new Request("https://web.example/api/channels/browser-watches/renew", {
      method: "POST",
      headers: {
        authorization: "tms owner",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  const [url, init] = fetch.mock.calls[2];
  expect(url.pathname).toBe("/api/channels/browser-watches/renew");
  expect(init.headers.Authorization).toBe("tms owner");
  expect(JSON.parse(init.body)).toEqual(body);
  expect(
    (
      await handleConnectorRequest(
        new Request("https://web.example/api/channels/browser-watches/renew", {
          headers: { authorization: "tms owner" },
        }),
      )
    ).status,
  ).toBe(404);
});
