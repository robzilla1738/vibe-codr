import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();
import { packageInfoTool } from "./package-info.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
    freshness,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route fake responses by URL substring. Missing match → 404. */
function routeFetch(routes: Record<string, { body: unknown; status?: number }>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    if (!hit) return new Response("not found", { status: 404 });
    const { body, status = 200 } = hit[1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return urls;
}

test("npm: reports the latest version + metadata and non-latest dist-tags", async () => {
  routeFetch({
    "registry.npmjs.org/react/latest": {
      body: { version: "19.1.0", description: "React library", license: "MIT", homepage: "https://react.dev" },
    },
    "/-/package/react/dist-tags": {
      body: { latest: "19.1.0", canary: "0.0.0-canary", experimental: "0.0.0-exp" },
    },
  });
  const res = await packageInfoTool.execute({ name: "react" }, ctx());
  expect(res.isError).toBeFalsy();
  const out = String(res.output);
  expect(out).toContain("npm · react");
  expect(out).toContain("latest: 19.1.0");
  expect(out).toContain("MIT");
  expect(out).toContain("canary=0.0.0-canary"); // non-latest tags surfaced
  expect(out).not.toMatch(/latest=19\.1\.0/); // the `latest` tag isn't duplicated in the tag list
});

test("npm: defaults ecosystem to npm and encodes scoped names", async () => {
  const urls = routeFetch({
    "registry.npmjs.org/@types%2fnode/latest": { body: { version: "22.0.0" } },
    "/-/package/@types%2fnode/dist-tags": { body: { latest: "22.0.0" } },
  });
  const res = await packageInfoTool.execute({ name: "@types/node" }, ctx());
  expect(String(res.output)).toContain("latest: 22.0.0");
  expect(urls.some((u) => u.includes("@types%2fnode"))).toBe(true); // slash encoded
});

test("npm: surfaces a deprecation warning", async () => {
  routeFetch({
    "/request/latest": { body: { version: "2.88.2", deprecated: "no longer maintained" } },
    "/-/package/request/dist-tags": { body: { latest: "2.88.2" } },
  });
  const res = await packageInfoTool.execute({ name: "request" }, ctx());
  expect(String(res.output)).toContain("⚠ deprecated: no longer maintained");
});

test("npm: a missing package is a clean error, not a throw", async () => {
  routeFetch({}); // everything 404s
  const res = await packageInfoTool.execute({ name: "definitely-not-real-xyz" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("not found on npm");
});

test("pypi: reports the latest version + summary from the JSON API", async () => {
  routeFetch({
    "pypi.org/pypi/requests/json": {
      body: { info: { version: "2.32.3", summary: "Python HTTP for Humans.", license: "Apache-2.0" } },
    },
  });
  const res = await packageInfoTool.execute({ name: "requests", ecosystem: "pypi" }, ctx());
  const out = String(res.output);
  expect(out).toContain("pypi · requests");
  expect(out).toContain("latest: 2.32.3");
  expect(out).toContain("Python HTTP for Humans.");
});

test("pypi: a missing package is a clean error", async () => {
  routeFetch({});
  const res = await packageInfoTool.execute({ name: "nope-xyz", ecosystem: "pypi" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("not found on PyPI");
});

test("rejects malformed npm names before fetching (no wrong-endpoint requests)", async () => {
  const urls = routeFetch({ latest: { body: { version: "9.9.9" } } });
  for (const bad of ["../../evil", "foo?bar", "foo#frag", "@scope/p/extra", "..", "a b"]) {
    const res = await packageInfoTool.execute({ name: bad }, ctx());
    expect(res.isError).toBe(true);
    expect(String(res.output)).toContain("Invalid npm package name");
  }
  expect(urls).toHaveLength(0); // never hit the network for an invalid name
});

test("accepts a valid scoped npm name", async () => {
  routeFetch({
    "registry.npmjs.org/@scope%2fpkg/latest": { body: { version: "1.0.0" } },
    "/-/package/@scope%2fpkg/dist-tags": { body: { latest: "1.0.0" } },
  });
  const res = await packageInfoTool.execute({ name: "@scope/pkg" }, ctx());
  expect(res.isError).toBeFalsy();
  expect(String(res.output)).toContain("latest: 1.0.0");
});

test("rejects malformed PyPI names before fetching", async () => {
  const urls = routeFetch({ json: { body: { info: { version: "1" } } } });
  for (const bad of ["..", "../x", "foo/bar", "a b"]) {
    const res = await packageInfoTool.execute({ name: bad, ecosystem: "pypi" }, ctx());
    expect(res.isError).toBe(true);
    expect(String(res.output)).toContain("Invalid PyPI package name");
  }
  expect(urls).toHaveLength(0);
});

test("package_info is read-only (usable while planning) and concurrency-safe", () => {
  expect(packageInfoTool.readOnly).toBe(true);
  expect(packageInfoTool.concurrencySafe).toBe(true);
});
