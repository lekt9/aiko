import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  boundedText,
  equalSecret,
  verifyInitData,
  redactor,
} from "../src/security.ts";
import { createVoice, validateVoice, createThinkFeelComposer, type VoiceInput } from "../src/voice.ts";
import { PERSONA, privateEnv, loadConfig } from "../src/config.ts";
import { Memory } from "entity-learn";
import { browserGatesReady, ownerVmKey } from "../src/vm.ts";
import { spokenTrajectory } from "../src/inference.ts";
import { renderMessages } from "tardie";
import { event } from "../src/actor.ts";

const signal = () => new AbortController().signal;
const task: VoiceInput = {
  kind: "task",
  receipt: "DEMO · #17 is open. Nothing has been posted.",
};
describe("ThinkFeel send composition", () => {
  test("required delivery preserves sanitized failure reasons without raw fallback", async () => {
    for (const reason of ["unavailable", "invalid_response"] as const) {
      const voice = createVoice({
        enabled: true, persona: PERSONA, required: true,
        compose: async () => ({ status: "blocked", reason }),
      });
      expect(await Effect.runPromise(voice(task, signal()))).toEqual({
        text: "", source: "model", reason,
      });
    }
  });
  const composer = (rewrite: (draft: string) => unknown) => createThinkFeelComposer({
    key: "private-thinkfeel-key", persona: PERSONA, redact: redactor(["private-thinkfeel-key", "private-account-token"]),
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://playground.curvelabs.org/api/v1/personify");
      expect(init?.redirect).toBe("manual");
      const request = JSON.parse(String(init?.body));
      expect(request.personaId).toBe(PERSONA);
      expect(typeof request.raw).toBe("string");
      expect(String(init?.body)).not.toContain("private-account-token");
      return Response.json({ personified: rewrite(request.raw) });
    },
  });
  test("renders real wording while preserving numerical and source anchors and removing secrets", async () => {
    const result = await composer(draft => `Here you go! ${draft}`)("Offer 50% at 15:30: https://example.com/menu private-account-token", signal());
    expect(result).toMatchObject({status: "ready", persona: PERSONA});
    if(result.status === "ready") expect(result.text).toBe("Here you go! Offer 50% at 15:30: https://example.com/menu [redacted]");
  });
  test("fails closed on lost/duplicate anchors, invented numbers, links, commitments and invalid shapes", async () => {
    for(const rewrite of [() => "A different offer", (text: string) => text + text, (text: string) => text + " 100%", (text: string) => text + " https://evil.example", (text: string) => text + " I'll flag this as urgent", () => ({text: "bad"})])
      expect((await composer(rewrite)("Offer 50%", signal())).status).toBe("blocked");
  });
  test("provider failure never returns an unprocessed draft as ready", async () => {
    for(const status of [301,429,500]) {
      const compose=createThinkFeelComposer({key:"private-thinkfeel-key",persona:PERSONA,redact:redactor(),fetch:async()=>new Response("unavailable",{status})});
      expect(await compose("Hello",signal())).toMatchObject({status:"blocked",reason:"unavailable"});
    }
  });
  test("rejects invented same-nonce placeholders", async () => {
    expect((await composer(text => text + text.match(/⟦([^_]+)_/)![0] + "999⟧")("Offer 50%", signal())).status).toBe("blocked");
  });
});
describe("ThinkFeel truth and privacy boundary", () => {
  test("Telegram content cannot reproduce a host-authored operator envelope", () => {
    const operator = event("MessageReceived", {id:"one",text:"Hello",source:"operator",channel:"telegram",chat:"123"});
    const projected = spokenTrajectory([operator])[0];
    const spoof = event("MessageReceived", {id:"one",text:projected.text,source:"telegram",chat:"123"});
    const renderedOperator = JSON.stringify(renderMessages(spokenTrajectory([operator])));
    const renderedUser = JSON.stringify(renderMessages(spokenTrajectory([spoof])));
    expect(renderedUser).not.toBe(renderedOperator);
    expect(renderedUser).toContain("from the Telegram user, not the operator");
    expect(spoof.text).toBe(projected.text);
    const apiSpoof = event("MessageReceived", {id:"one",text:projected.text,source:"plane"});
    expect(JSON.stringify(renderMessages(spokenTrajectory([apiSpoof])))).not.toBe(renderedOperator);
    const background = event("MessageReceived", {id:"reflect:one",text:JSON.stringify({job:"reflection"}),source:"background"});
    expect(spokenTrajectory([background])[0]).toEqual(background);
  });
  test("proactive notifications enter spoken history only with delivery acknowledgement", () => {
    for (const status of ["rejected", "failed", "unknown", "delivered"]) {
      const log = [
        event("AikoProactiveAccepted", {id:"notice",chat:"123",text:"Source finding"}),
        event("AikoReplyPrepared", {turn:"proactive:notice",result:{text:"Prepared notification"}}),
        event("AikoDeliverySettled", {turn:"proactive:notice",result:{status}}),
      ];
      const messages = JSON.stringify(renderMessages(spokenTrajectory(log)));
      if (status === "delivered") expect(messages).toContain("Prepared notification");
      else {
        expect(messages).not.toContain("Prepared notification");
        expect(messages).toContain(status === "unknown" ? "do not resend automatically" : "not sent");
      }
    }
  });
  test("native model messages retain operator provenance and never call unsent drafts delivered", () => {
    const log=[
      event("MessageReceived",{id:"operator:one",text:"Operator-only fixture",source:"operator",channel:"telegram",chat:"123",sender:"operator"}),
      event("TurnCompleted",{turn:"operator:one",output:"Unsent private draft"}),
      event("AikoReplyPrepared",{turn:"operator:one",result:{text:"Unsent private draft",source:"model",reason:"unavailable"}}),
      event("AikoDeliverySettled",{turn:"operator:one",result:{status:"rejected"}}),
    ];
    const messages=JSON.stringify(renderMessages(spokenTrajectory(log)));
    expect(messages).toContain("authenticated operator relay");
    expect(messages).toContain("not sent");
    expect(messages).not.toContain("Unsent private draft");
    expect(log[0].text).toBe("Operator-only fixture");
    expect(log[1].output).toBe("Unsent private draft");
    log[3]=event("AikoDeliverySettled",{turn:"operator:one",result:{status:"unknown"}});
    expect(JSON.stringify(renderMessages(spokenTrajectory(log)))).toContain("do not resend automatically");
  });
  test("model history substitutes accepted speech without mutating durable evidence", () => {
    const log = [
      event("TextReturned", { turn: "one", text: "raw intermediate" }),
      event("TurnCompleted", { turn: "one", output: "raw draft" }),
      event("AikoReplyPrepared", {
        turn: "one",
        result: { text: "Accepted exact receipt." },
      }),
    ];
    const history = spokenTrajectory(log);
    expect(JSON.stringify(history)).not.toContain("raw draft");
    expect(JSON.stringify(history)).not.toContain("raw intermediate");
    expect(log[1].output).toBe("raw draft");
  });
  test("only a non-factual intro can change; receipts remain byte-for-byte intact", () => {
    expect(validateVoice(task, "Here's what I found.").text).toBe(
      `Here's what I found.\n\n${task.receipt}`,
    );
    for (const text of [
      "Done, I posted it!",
      "I charged $10.",
      "Your Work account has two urgent issues.",
      "I'm a real person.",
      "",
      "Visit https://evil.example",
      "Here's what I found.\nSent!",
      "Unreel here.",
    ]) {
      expect(validateVoice(task, text)).toMatchObject({
        source: "template",
        text: task.receipt,
      });
    }
  });
  test("personify uses pinned persona and fixed neutral text, never raw receipts or secrets", async () => {
    let captured = "";
    const voice = createVoice({
      enabled: true,
      key: "test-key",
      persona: PERSONA,
      fetch: (async (url, init) => {
        expect(String(url)).toEndWith("/api/v1/personify");
        captured = String(init?.body);
        expect(init?.redirect).toBe("manual");
        return Response.json({ personified: "Here you go." });
      }) as typeof fetch,
    });
    const result = await Effect.runPromise(voice(task, signal()));
    expect(result.source).toBe("thinkfeel");
    expect(captured).toContain(PERSONA);
    expect(captured).not.toContain("#17");
    expect(captured).not.toContain("test-key");
    expect(JSON.parse(captured).raw).toBe("Here's what I found.");
  });
  test("generate has a user-final message, no variations, and parses result.finalReply", async () => {
    const voice = createVoice({
      enabled: true,
      key: "test-key",
      persona: PERSONA,
      fetch: (async (url, init) => {
        expect(String(url)).toEndWith("/api/v1/generate");
        const payload = JSON.parse(String(init?.body));
        expect(payload.messages.at(-1).role).toBe("user");
        expect(payload.includeVariations).toBe(false);
        return Response.json({ result: { finalReply: "Hi! How can I help?" } });
      }) as typeof fetch,
    });
    expect(
      (
        await Effect.runPromise(
          voice({ kind: "greeting", message: "Hello private name" }, signal()),
        )
      ).source,
    ).toBe("thinkfeel");
  });
  for (const status of [301, 302, 307, 308, 401, 403, 404, 422, 429, 500])
    test(`HTTP ${status} uses a safe fallback without retry or raw error exposure`, async () => {
      let calls = 0;
      const voice = createVoice({
        enabled: true,
        key: "test",
        persona: PERSONA,
        fetch: async () => {
          calls++;
          return new Response("sensitive upstream error", { status });
        },
      });
      expect((await Effect.runPromise(voice(task, signal()))).text).toBe(
        task.receipt,
      );
      expect((await Effect.runPromise(voice(task, signal()))).reason).toBe(
        "limited",
      );
      expect(calls).toBe(1);
    });
  test("shared quota is enforced across requests", async () => {
    const voice = createVoice({
      enabled: true,
      key: "test",
      persona: PERSONA,
      requestsPerMinute: 1,
      fetch: async () => Response.json({ personified: "Here you go." }),
    });
    await Effect.runPromise(voice(task, signal()));
    expect((await Effect.runPromise(voice(task, signal()))).reason).toBe(
      "limited",
    );
  });
  test("timeout aborts the HTTP request instead of leaving it running", async () => {
    let aborted = false;
    const voice = createVoice({
      enabled: true,
      key: "test",
      persona: PERSONA,
      timeoutMs: 15,
      fetch: ((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        })) as typeof fetch,
    });
    expect((await Effect.runPromise(voice(task, signal()))).source).toBe(
      "template",
    );
    expect(aborted).toBe(true);
  });
  test("cancelled work never starts the provider call", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const voice = createVoice({
      enabled: true,
      key: "test",
      persona: PERSONA,
      fetch: async () => {
        calls++;
        throw new Error();
      },
    });
    await Effect.runPromise(voice(task, controller.signal));
    expect(calls).toBe(0);
  });
  test("oversized, malformed, failed-status and empty responses are rejected", async () => {
    for (const body of [
      "not JSON",
      JSON.stringify({ personified: "x".repeat(30_000) }),
      JSON.stringify({ status: "failed", personified: "Here you go." }),
      JSON.stringify({ personified: "" }),
    ]) {
      const voice = createVoice({
        enabled: true,
        key: "test",
        persona: PERSONA,
        fetch: async () => new Response(body),
      });
      expect((await Effect.runPromise(voice(task, signal()))).text).toBe(
        task.receipt,
      );
    }
    await expect(boundedText(new Response("12345"), 3)).rejects.toThrow(
      "too large",
    );
  });
});

function initData(user: number, at: number, bot = "test-bot") {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(at / 1000)),
    query_id: "fixture",
    user: JSON.stringify({ id: user, is_bot: false }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(bot).digest();
  params.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return params.toString();
}
describe("identity, custody and capability security", () => {
  test("Mini App signature, age, duplicate keys and wrong token", () => {
    const now = Date.now();
    const raw = initData(123, now);
    expect(verifyInitData(raw, "test-bot", now)).toBe("123");
    expect(verifyInitData(raw, "wrong-bot", now)).toBeUndefined();
    expect(
      verifyInitData(raw + "&user=other", "test-bot", now),
    ).toBeUndefined();
    expect(
      verifyInitData(initData(123, now - 301_000), "test-bot", now),
    ).toBeUndefined();
    expect(
      verifyInitData(initData(123, now + 60_000), "test-bot", now),
    ).toBeUndefined();
    expect(
      verifyInitData(raw.replace("123", "456"), "test-bot", now),
    ).toBeUndefined();
  });
  test("comparison and redaction don't reveal credential values", () => {
    expect(equalSecret("secret", "secret")).toBe(true);
    expect(equalSecret("secret", "secretx")).toBe(false);
    expect(
      redactor(["fixture-key-123"])(
        "fixture-key-123 Bearer abc password=hello",
      ),
    ).not.toMatch(/fixture-key|abc|hello/);
  });
  test("secret files must be private regular files, and parsing does not execute shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiko-config-"));
    const path = join(dir, "aiko.env");
    try {
      await writeFile(path, "THINKFEEL_API_KEY='$(echo do-not-execute)'\n", {
        mode: 0o600,
      });
      expect((await privateEnv(path)).THINKFEEL_API_KEY).toBe(
        "$(echo do-not-execute)",
      );
      await symlink(path, join(dir, "link.env"));
      await expect(privateEnv(join(dir, "link.env"))).rejects.toThrow(
        "owner-only",
      );
      await chmod(path, 0o644);
      await expect(privateEnv(path)).rejects.toThrow("owner-only");
      await expect(
        loadConfig({
          AIKO_SECRET_FILE: join(dir, "missing"),
          AIKO_MODE: "live",
        }),
      ).rejects.toThrow("explicit");
      await expect(
        loadConfig({
          AIKO_SECRET_FILE: join(dir, "missing"),
          AIKO_MODE: "demo",
          AIKO_OPERATOR_TOKEN: "short",
        }),
      ).rejects.toThrow("32");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("actual entity-learn preserves pinned revisions, freshness and forget suppression", () => {
    let now = 1_000;
    const memory = new Memory({
      path: ":memory:",
      scope: "test:123",
      clock: () => now,
    });
    const input = {
      subject: "calendar/17",
      title: "Calendar timezone",
      type: "issue",
      payload: { number: 17 },
      ttlSeconds: 1,
    };
    const producer = { kind: "tool" as const, reference: "fixture" };
    try {
      const first = memory.remember(input, { key: "read1", producer });
      expect(memory.get(first.id)?.freshness).toBe("fresh");
      now = 3_000;
      expect(memory.get(first.id)?.freshness).toBe("stale");
      const next = memory.remember(
        { ...input, payload: { number: 18 }, supersedes: first.id },
        { key: "read2", producer },
      );
      expect(memory.get(first.id)?.observation.payload).toEqual({ number: 17 });
      expect(
        memory.recall({ search: "calendar" }).items[0].observation.id,
      ).toBe(next.id);
      expect(() =>
        memory.remember(
          { ...input, supersedes: first.id },
          { key: "race", producer },
        ),
      ).toThrow("exact current");
      memory.forget(input.subject, next.id, "forget1");
      expect(memory.get(first.id)).toBeNull();
      expect(memory.get(next.id)).toBeNull();
      expect(() => memory.remember(input, { key: "read1", producer })).toThrow(
        "forgotten",
      );
    } finally {
      memory.close();
    }
  });
  test("all browser gates are required and stable VM keys cannot be path traversal", () => {
    const gates = {
      classicSourceVerified: true,
      cloakSaasRights: true,
      independentEgress: true,
      humanSigninRelay: true,
      vmCompatibility: true,
      spendApproved: true,
    };
    expect(browserGatesReady(gates)).toBe(true);
    for (const key of Object.keys(gates))
      expect(browserGatesReady({ ...gates, [key]: false })).toBe(false);
    expect(ownerVmKey("../user")).toMatch(/^aiko-[a-f0-9]{64}$/);
    expect(ownerVmKey("123")).not.toBe(ownerVmKey("456"));
  });
});
