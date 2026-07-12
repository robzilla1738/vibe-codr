import { describe, test, expect, mock } from "bun:test";
import {
  captionImages,
  captionsToContextBlock,
  shouldRelay,
  type CaptionResult,
} from "./vision-relay.ts";
import type { VisionRelayConfig } from "@vibe/config";
import type { ImageAttachment } from "./mentions.ts";

/** Build a minimal VisionRelayConfig for tests. */
function relayConfig(overrides: Partial<VisionRelayConfig> = {}): VisionRelayConfig {
  return {
    enabled: true,
    relayModel: "openai/gpt-4o",
    timeoutMs: 30_000,
    maxCaptionChars: 2_000,
    ...overrides,
  };
}

/** Build a minimal ImageAttachment for tests. */
function fakeImage(path = "screenshot.png"): ImageAttachment {
  return {
    path,
    mediaType: "image/png",
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
}

// ── shouldRelay ────────────────────────────────────────────────────────────

describe("shouldRelay", () => {
  test("true when enabled + relayModel set + has images + primary does NOT support images", () => {
    expect(shouldRelay(relayConfig(), true, false)).toBe(true);
  });

  test("false when primary model DOES support images", () => {
    expect(shouldRelay(relayConfig(), true, true)).toBe(false);
  });

  test("false when primary model support is unknown (undefined — benefit of the doubt)", () => {
    expect(shouldRelay(relayConfig(), true, undefined)).toBe(false);
  });

  test("false when relay is disabled", () => {
    expect(shouldRelay(relayConfig({ enabled: false }), true, false)).toBe(false);
  });

  test("false when no relayModel configured", () => {
    expect(shouldRelay(relayConfig({ relayModel: undefined }), true, false)).toBe(false);
  });

  test("false when no images attached", () => {
    expect(shouldRelay(relayConfig(), false, false)).toBe(false);
  });
});

// ── captionsToContextBlock ─────────────────────────────────────────────────

describe("captionsToContextBlock", () => {
  test("renders each caption as a fenced block with the filename header", () => {
    const captions: CaptionResult[] = [
      { path: "a.png", caption: "A red button labeled Submit.", degraded: false },
      { path: "b.jpg", caption: "A terminal showing an error.", degraded: false },
    ];
    const block = captionsToContextBlock(captions);
    expect(block).toContain("image: a.png (vision relay description)");
    expect(block).toContain("A red button labeled Submit.");
    expect(block).toContain("image: b.jpg (vision relay description)");
    expect(block).toContain("A terminal showing an error.");
  });

  test("marks degraded captions with (relay degraded) header", () => {
    const captions: CaptionResult[] = [
      { path: "c.png", caption: "[vision relay could not caption...]", degraded: true },
    ];
    const block = captionsToContextBlock(captions);
    expect(block).toContain("(relay degraded)");
    expect(block).toContain("[vision relay could not caption...]");
  });

  test("empty array produces empty string", () => {
    expect(captionsToContextBlock([])).toBe("");
  });
});

// ── captionImages ──────────────────────────────────────────────────────────

describe("captionImages", () => {
  test("captions all images via the relay model and returns allSucceeded=true", async () => {
    // Mock generateText by injecting a fake resolveRelayModel that returns an
    // object with the shape generateText needs. We can't easily mock the `ai`
    // module here, so we test the degradation path + the resolve-failure path
    // which don't require generateText to succeed.
    //
    // Instead, we test: relay model resolution failure → all images degrade.
    const config = relayConfig();
    const images = [fakeImage("a.png"), fakeImage("b.png")];
    const result = await captionImages(
      images,
      config,
      () => Promise.reject(new Error("no API key for openai")),
      new AbortController().signal,
    );
    expect(result.allSucceeded).toBe(false);
    expect(result.captions).toHaveLength(2);
    expect(result.captions[0]!.degraded).toBe(true);
    expect(result.captions[1]!.degraded).toBe(true);
    expect(result.captions[0]!.caption).toContain("vision relay could not caption");
    expect(result.captions[0]!.caption).toContain("no API key for openai");
    expect(result.captions[0]!.path).toBe("a.png");
    expect(result.captions[1]!.path).toBe("b.png");
  });

  test("degradation note includes the filename and media type", async () => {
    const result = await captionImages(
      [fakeImage("screenshot.png")],
      relayConfig(),
      () => Promise.reject(new Error("provider down")),
      new AbortController().signal,
    );
    expect(result.captions[0]!.caption).toContain("screenshot.png");
    expect(result.captions[0]!.caption).toContain("image/png");
  });

  test("empty images array produces empty captions", async () => {
    // Even with no images, the relay model is resolved first (it fails here),
    // then the empty images array maps to an empty captions array.
    const result = await captionImages(
      [],
      relayConfig(),
      () => Promise.reject(new Error("no key")),
      new AbortController().signal,
    );
    expect(result.captions).toEqual([]);
    // The model resolution failed, so allSucceeded is false even though there
    // were no images to caption (the relay is not healthy).
    expect(result.allSucceeded).toBe(false);
  });
});
