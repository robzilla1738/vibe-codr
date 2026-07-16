import { describe, expect, it } from "vitest";
import { resolvePathInsideRoot, resolveWritablePathInsideRoot } from "./path-safe";

describe("resolvePathInsideRoot", () => {
  it("accepts a normal file under the project", () => {
    // resolve() will make absolute paths from cwd — use absolute cwd
    const res = resolvePathInsideRoot("/proj", "src/a.ts", {
      realpathSync(path) {
        if (path === "/proj") return "/proj";
        if (path.endsWith("src/a.ts")) return "/proj/src/a.ts";
        throw new Error(`ENOENT ${path}`);
      },
      existsSync: (p) => p === "/proj/src/a.ts" || p === "/proj",
      isFile: (p) => p === "/proj/src/a.ts",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.target).toBe("/proj/src/a.ts");
  });

  it("rejects lexical parent escape", () => {
    const res = resolvePathInsideRoot("/proj", "../etc/passwd", {
      realpathSync: (p) => p,
      existsSync: () => true,
      isFile: () => true,
    });
    expect(res).toEqual({ ok: false, error: "Path escapes the project" });
  });

  it("rejects symlink that resolves outside the project", () => {
    const res = resolvePathInsideRoot("/proj", "link-out", {
      realpathSync(path) {
        if (path === "/proj") return "/proj";
        // link-out is a symlink to /etc/passwd
        if (path.includes("link-out")) return "/etc/passwd";
        return path;
      },
      existsSync: () => true,
      isFile: () => true,
    });
    expect(res).toEqual({ ok: false, error: "Path escapes the project" });
  });

  it("rejects missing files", () => {
    const res = resolvePathInsideRoot("/proj", "missing.ts", {
      realpathSync(path) {
        if (path === "/proj") return "/proj";
        throw new Error("ENOENT");
      },
      existsSync: () => false,
      isFile: () => false,
    });
    expect(res.ok).toBe(false);
  });

  it("does not mistake a normal dot-prefixed child for a parent escape", () => {
    const res = resolvePathInsideRoot("/proj", "..cache/file.txt", {
      realpathSync(path) {
        if (path === "/proj") return "/proj";
        return "/proj/..cache/file.txt";
      },
      existsSync: () => true,
      isFile: () => true,
    });
    expect(res.ok).toBe(true);
  });
});

describe("resolveWritablePathInsideRoot", () => {
  it("accepts a future nested file when existing ancestors are real directories", () => {
    const res = resolveWritablePathInsideRoot("/proj", ".vibe/config.json", {
      existsSync: (path) => path === "/proj" || path === "/proj/.vibe",
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: (path) => path,
    });
    expect(res).toEqual({ ok: true, root: "/proj", target: "/proj/.vibe/config.json" });
  });

  it("rejects a project-owned symlink in a future write path", () => {
    const res = resolveWritablePathInsideRoot("/proj", ".vibe/config.json", {
      existsSync: () => true,
      lstatSync: (path) => ({ isSymbolicLink: () => path === "/proj/.vibe" }),
      realpathSync: (path) => path,
    });
    expect(res).toEqual({ ok: false, error: "Project path uses a symbolic link" });
  });
});
