import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSdk, generateSdkPackageJson, verifySdkIntegrity } from "./build-sdk.ts";

test("SDK metadata is scoped, typed, and independently publishable", () => {
  const metadata = generateSdkPackageJson({ version: "1.2.3" });
  expect(metadata.name).toBe("@vibe/sdk");
  expect(metadata.version).toBe("1.2.3");
  expect(metadata.exports).toEqual({ ".": { types: "./index.d.ts", import: "./index.js" } });
  expect(metadata).not.toHaveProperty("private");
});

test("release builder emits a self-contained artifact with enforced integrity", async () => {
  const output = await buildSdk();
  expect(await Bun.file(join(output, "index.js")).exists()).toBe(true);
  expect(await Bun.file(join(output, "index.d.ts")).exists()).toBe(true);
  expect(await verifySdkIntegrity(output)).toBe(true);

  const copy = await mkdtemp(join(tmpdir(), "vibe-sdk-integrity-"));
  for (const file of ["index.js", "index.d.ts", "package.json", "README.md", "LICENSE", "integrity.json"]) {
    await Bun.write(join(copy, file), Bun.file(join(output, file)));
  }
  await writeFile(join(copy, "index.js"), "tampered");
  expect(await verifySdkIntegrity(copy)).toBe(false);
});
