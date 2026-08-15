import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import {
  clearChatImageThumbClientCache,
  canUseImageThumb,
  getThumbCacheEndpoint,
  resolveChatImageThumb,
} from "./imageThumbClient";
import {
  resetMediaEndpointForTests,
  setMediaEndpoint,
} from "./imageSrc";

afterEach(() => {
  clearChatImageThumbClientCache();
  resetMediaEndpointForTests();
  vi.restoreAllMocks();
});

describe("canUseImageThumb", () => {
  it("accepts real local paths and remote https", () => {
    expect(canUseImageThumb("/Users/me/a.png")).toBe(true);
    expect(canUseImageThumb("C:/Users/me/a.png")).toBe(true);
    expect(canUseImageThumb("https://cdn.example/x.jpg")).toBe(true);
  });

  it("rejects fused query-key paths (t:/Users/…)", () => {
    expect(canUseImageThumb("t:/Users/me/a.png")).toBe(false);
    // A real local src still wins over a fused path arg (src is the target).
    expect(canUseImageThumb("/Users/me/a.png", "t:/Users/me/a.png")).toBe(
      true,
    );
  });

  it("rejects loopback URLs and blob/data", () => {
    expect(canUseImageThumb("http://127.0.0.1:9/v1/media?t=x&p=y")).toBe(
      false,
    );
    expect(canUseImageThumb("blob:http://localhost/1")).toBe(false);
  });
});

describe("resolveChatImageThumb — fused paths never hit the thumb host", () => {
  it("returns null for a fused path without calling the host", async () => {
    const spy = vi.spyOn(api, "mediaImageThumb");
    const r = await resolveChatImageThumb("t:/Users/me/a.png");
    expect(r).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resolveChatImageThumb — endpoint change drops stale loopback URLs", () => {
  it("clears cached displaySrc when the media endpoint changes", async () => {
    setMediaEndpoint({ baseUrl: "http://127.0.0.1:1", token: "old" });
    expect(getThumbCacheEndpoint()).toBe("http://127.0.0.1:1?t=old");

    vi.spyOn(api, "mediaImageThumb").mockResolvedValue({
      thumbPath: "/Users/me/Library/cache/image-thumbs/abc.jpg",
      fromCache: true,
      width: 120,
      height: 80,
      isOriginal: false,
    });
    const first = await resolveChatImageThumb("/Users/me/a.png");
    expect(first?.displaySrc).toContain("127.0.0.1:1");
    expect(first?.displaySrc).toContain("t=old");

    // New endpoint (media server restarted with a new port/token).
    setMediaEndpoint({ baseUrl: "http://127.0.0.1:2", token: "new" });
    expect(getThumbCacheEndpoint()).toBe("http://127.0.0.1:2?t=new");

    const second = await resolveChatImageThumb("/Users/me/a.png");
    expect(second?.displaySrc).toContain("127.0.0.1:2");
    expect(second?.displaySrc).toContain("t=new");
  });
});
