import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  // Shared app process is intentional for speed; mutating scenarios must not
  // rely on bare wall-clock sleeps (see harness expect.poll). CI retries once.
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: "line",
});
