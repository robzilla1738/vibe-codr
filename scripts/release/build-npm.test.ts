import { test, expect } from "bun:test";
import {
  collectWorkspaceVersions,
  ensureShebang,
  generateNpmPackageJson,
  missingInlinedSymbols,
  OPTIONAL_DEP_NAMES,
  REQUIRED_INLINED_SYMBOLS,
  resolveOptionalDeps,
} from "./build-npm.ts";

test("collectWorkspaceVersions: root deps/devDeps win over per-package peers", () => {
  const versions = collectWorkspaceVersions([
    // root
    { devDependencies: { "@ai-sdk/anthropic": "^2.0.83", "@opentui/core": "^0.4.2" } },
    // a package declares a looser peer range — must NOT override the root pin
    { peerDependencies: { "@ai-sdk/anthropic": "^2.0.0" }, dependencies: { ai: "^5.0.0" } },
  ]);
  expect(versions["@ai-sdk/anthropic"]).toBe("^2.0.83");
  expect(versions["@opentui/core"]).toBe("^0.4.2");
  expect(versions.ai).toBe("^5.0.0");
});

test("resolveOptionalDeps: uses workspace versions, falls back to * for the unpinned two", () => {
  const versions = {
    "@ai-sdk/anthropic": "^2.0.83",
    "@ai-sdk/openai": "^2.0.109",
    "@ai-sdk/deepseek": "^1.0.44",
    "@ai-sdk/openai-compatible": "^1.0.41",
    "@opentui/core": "^0.4.2",
    "@opentui/solid": "^0.4.2",
    "solid-js": "^1.9.13",
    "web-tree-sitter": "0.25.10",
  };
  const opt = resolveOptionalDeps(versions);
  // Every advertised optional dep is present.
  for (const name of OPTIONAL_DEP_NAMES) expect(name in opt).toBe(true);
  expect(opt["@ai-sdk/anthropic"]).toBe("^2.0.83");
  expect(opt["web-tree-sitter"]).toBe("0.25.10");
  // The repo doesn't pin these — fall back to `*`.
  expect(opt["@modelcontextprotocol/sdk"]).toBe("*");
  expect(opt["@huggingface/transformers"]).toBe("*");
  // Keys are sorted for a stable diff.
  expect(Object.keys(opt)).toEqual([...Object.keys(opt)].sort());
});

test("generateNpmPackageJson produces the published shape", () => {
  const pkg = generateNpmPackageJson({
    version: "0.3.0",
    rootPkg: {
      license: "MIT",
      description: "A model-agnostic CLI coding agent for the terminal.",
      engines: { bun: ">=1.2.0" },
    },
    optionalDependencies: { "@ai-sdk/anthropic": "^2.0.83" },
  });
  expect(pkg.name).toBe("vibe-codr");
  expect(pkg.version).toBe("0.3.0");
  expect(pkg.bin).toEqual({ vibecodr: "./vibecodr.js", vibe: "./vibecodr.js" });
  expect(pkg.engines).toEqual({ bun: ">=1.2.0" });
  expect(pkg.license).toBe("MIT");
  expect(pkg.type).toBe("module");
  expect(pkg.files).toContain("vibecodr.js");
  expect(pkg.optionalDependencies).toEqual({ "@ai-sdk/anthropic": "^2.0.83" });
  // Falls back to a git repository URL when root has none.
  expect((pkg.repository as { url: string }).url).toContain("github.com");
});

test("ensureShebang only prepends when missing", () => {
  expect(ensureShebang("console.log(1)")).toBe("#!/usr/bin/env bun\nconsole.log(1)");
  expect(ensureShebang("#!/usr/bin/env bun\ncode")).toBe("#!/usr/bin/env bun\ncode");
});

test("missingInlinedSymbols catches an externalized SDK the module-id grep can't", () => {
  // An INLINED bundle carries the SDKs' internal class exports.
  const inlined = [
    "class AnthropicMessagesLanguageModel {}",
    "class OpenAICompatibleChatLanguageModel {}",
  ].join("\n");
  expect(missingInlinedSymbols(inlined)).toEqual([]);

  // The 0ebce43 regression: `--external` drops the SDK source, so the internal
  // symbols vanish — BUT the module ids AND factory names still appear as string
  // literals (they live in defs.ts, always bundled). The OLD guard grepped for
  // those and passed anyway; this predicate must FAIL.
  const externalized = [
    'import "@ai-sdk/anthropic";',
    'import "@ai-sdk/openai-compatible";',
    'const F = { factory: "createAnthropic" };',
    'const G = { factory: "createOpenAICompatible" };',
  ].join("\n");
  expect(externalized).toContain("@ai-sdk/anthropic"); // module ids survive externalizing
  expect(externalized).toContain("createOpenAICompatible"); // factory names survive too
  expect(missingInlinedSymbols(externalized)).toEqual([...REQUIRED_INLINED_SYMBOLS]);
});
