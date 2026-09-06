// Synthetic browser actions for approval UI QA only. Never used by src/main.ts.
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import type { BrowserDriverFactory } from "../src/browser-driver.ts";
export const browserUiFixture = {
  model: Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "approval-ui" },
    }),
    react: (request) => {
      const count = request.trajectory.filter(
        (e) =>
          e.type === "ToolReturned" &&
          (e as { turn?: string }).turn === request.identity.turn,
      ).length;
      return Effect.succeed(
        count >= 2
          ? {
              kind: "complete" as const,
              output: "Synthetic approval fixture finished.",
            }
          : {
              kind: "call" as const,
              callId: `fixture-${count}`,
              name: count ? "agent_browser_click" : "agent_browser_navigate",
              arguments: count
                ? { selector: "@e1" }
                : { url: "https://example.com" },
            },
      );
    },
  }),
  browserFactory: (async () => ({
    execute: async (action) =>
      action.action === "click"
        ? { performed: "fixture click; not a real site action" }
        : {
            url: "https://example.com",
            snapshot:
              'button "Synthetic submit" [ref=e1] <img src=x onerror=alert(1)>',
          },
    close: async () => {},
  })) satisfies BrowserDriverFactory,
};
