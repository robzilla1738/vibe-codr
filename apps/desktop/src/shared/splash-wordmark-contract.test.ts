import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("responsive image wordmark", () => {
  const splash = readFileSync(join(process.cwd(), "src/renderer/layout/Splash.tsx"), "utf8");
  const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  it("uses the supplied wordmark responsively and inverts it in light themes", () => {
    expect(splash).toContain('<BrandWordmark className="splash-wordmark" />');
    expect(styles).toMatch(/\.splash-wordmark\s*\{[^}]*width:\s*clamp\(220px, 72cqi, 430px\);/s);
    expect(styles).toMatch(/html\[data-scheme="light"\] \.brand-wordmark-image\s*\{ filter:\s*invert\(1\); \}/s);
  });
});
