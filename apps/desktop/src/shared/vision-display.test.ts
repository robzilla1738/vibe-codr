import { describe, expect, it } from "vitest";
import { stripVisionRelayContext } from "./vision-display";

describe("stripVisionRelayContext", () => {
  it("keeps the user's message and removes a successful relay block", () => {
    expect(stripVisionRelayContext(
      'what is this image? @"/tmp/reference.png"\n\n--- image: /tmp/reference.png (vision relay description) ---\nA screenshot of a dashboard.',
    )).toBe('what is this image? @"/tmp/reference.png"');
  });

  it("removes degraded relay blocks too", () => {
    expect(stripVisionRelayContext(
      "Please inspect this\n\n--- image: screenshot.png (relay degraded) ---\n[vision relay could not caption this image]",
    )).toBe("Please inspect this");
  });

  it("leaves ordinary messages untouched", () => {
    expect(stripVisionRelayContext("Describe the error in this log.")).toBe("Describe the error in this log.");
  });
});
