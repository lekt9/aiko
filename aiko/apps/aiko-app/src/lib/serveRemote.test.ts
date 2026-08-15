import { describe, expect, it } from "vitest";
import {
  buildServeConnectionCli,
  buildServeConnectionCliMasked,
  buildServeConnectionUrl,
  buildServeConnectionUrlMasked,
  buildServeRemoteWsBase,
  maskServeSecret,
  normalizeServeRemoteUrl,
  serveRemoteSpawnCliArgs,
} from "./serveRemote";

describe("maskServeSecret", () => {
  it("masks short and long secrets", () => {
    expect(maskServeSecret("")).toBe("");
    expect(maskServeSecret("ab")).toBe("••••");
    expect(maskServeSecret("abcd")).toBe("••••");
    expect(maskServeSecret("abcde")).toBe("••••bcde");
    expect(maskServeSecret("tokensecret99")).toBe("••••et99");
  });
});

describe("connection templates", () => {
  it("builds ws base, url, and cli forms", () => {
    expect(buildServeRemoteWsBase("127.0.0.1:2419")).toBe("ws://127.0.0.1:2419/ws");
    expect(buildServeConnectionUrl("127.0.0.1:2419", "tokensecret99")).toBe(
      "ws://127.0.0.1:2419/ws?server-key=tokensecret99",
    );
    expect(buildServeConnectionCli("127.0.0.1:2419", "tokensecret99")).toBe(
      "aiko --remote ws://127.0.0.1:2419/ws --secret tokensecret99",
    );
  });

  it("masks secrets in url and cli templates", () => {
    const secret = "tokensecret99";
    const urlM = buildServeConnectionUrlMasked("127.0.0.1:2419", secret);
    const cliM = buildServeConnectionCliMasked("127.0.0.1:2419", secret);
    expect(urlM).toContain("••••et99");
    expect(urlM).not.toContain(secret);
    expect(cliM).toContain("••••et99");
    expect(cliM).not.toContain(secret);
    expect(cliM.startsWith("aiko --remote ws://127.0.0.1:2419/ws --secret ")).toBe(
      true,
    );
  });
});

describe("normalizeServeRemoteUrl", () => {
  it("treats empty as omit", () => {
    expect(normalizeServeRemoteUrl(null)).toEqual({ ok: true, value: null });
    expect(normalizeServeRemoteUrl(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeServeRemoteUrl("")).toEqual({ ok: true, value: null });
    expect(normalizeServeRemoteUrl("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts ws/wss and rewrites http(s)", () => {
    expect(normalizeServeRemoteUrl("  ws://upstream.example:9000/agent  ")).toEqual({
      ok: true,
      value: "ws://upstream.example:9000/agent",
    });
    expect(normalizeServeRemoteUrl("wss://edge.example/ws")).toEqual({
      ok: true,
      value: "wss://edge.example/ws",
    });
    expect(normalizeServeRemoteUrl("https://edge.example/ws")).toEqual({
      ok: true,
      value: "wss://edge.example/ws",
    });
    expect(normalizeServeRemoteUrl("http://127.0.0.1:3000/ws")).toEqual({
      ok: true,
      value: "ws://127.0.0.1:3000/ws",
    });
  });

  it("rejects bad schemes, whitespace, empty host, secrets in query", () => {
    expect(normalizeServeRemoteUrl("ftp://x")).toEqual({ ok: false, error: "scheme" });
    expect(normalizeServeRemoteUrl("not-a-url")).toEqual({ ok: false, error: "scheme" });
    expect(normalizeServeRemoteUrl("ws://x y")).toEqual({
      ok: false,
      error: "whitespace",
    });
    expect(normalizeServeRemoteUrl("ws://")).toEqual({
      ok: false,
      error: "empty_host",
    });
    expect(normalizeServeRemoteUrl("ws://h/ws?server-key=sekrit")).toEqual({
      ok: false,
      error: "secret_in_query",
    });
    expect(normalizeServeRemoteUrl("ws://h/ws?token=abc")).toEqual({
      ok: false,
      error: "secret_in_query",
    });
  });
});

describe("serveRemoteSpawnCliArgs", () => {
  it("omits when unset and emits --remote when set", () => {
    expect(serveRemoteSpawnCliArgs("")).toBeNull();
    expect(serveRemoteSpawnCliArgs(null)).toBeNull();
    expect(serveRemoteSpawnCliArgs("ws://upstream:1/ws")).toEqual([
      "--remote",
      "ws://upstream:1/ws",
    ]);
    expect(serveRemoteSpawnCliArgs("not-valid")).toBeNull();
  });
});
