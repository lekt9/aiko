/** Mount the operational Contract signal route on a Hono-compatible app. */
export function mountContractSignalRoutes(app, { driver, path = "/v1/contract/signals/frontier" } = {}) {
  if (!app?.post || !driver?.handleSignal) throw new Error("Contract signal route requires app and driver");
  app.post(path, async (c) => {
    const body = await c.req.json();
    try {
      const result = await driver.handleSignal(body);
      return c.json(result, 202);
    } catch (error) {
      return c.json({ error: "contract_signal_refused", detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  return app;
}

/** Fetch/Request form used by non-Hono production adapters and tests. */
export function createContractSignalHandler(driver) {
  return async function handle(request) {
    try {
      const result = await driver.handleSignal(await request.json());
      return Response.json(result, { status: 202 });
    } catch (error) {
      return Response.json({ error: "contract_signal_refused", detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  };
}
