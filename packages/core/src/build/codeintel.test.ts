import { test, expect } from "bun:test";
import type { Exec } from "./exec.ts";
import {
  looksGreenfield,
  detectCommands,
  detectServeCommand,
  isWebApp,
  reconRepo,
  serveDaemonCommand,
  type RepoManifests,
} from "./codeintel.ts";

const manifests = (over: Partial<RepoManifests> = {}): RepoManifests => ({
  lockfiles: [],
  ...over,
});

test("looksGreenfield: dotfiles/README/LICENSE only", () => {
  expect(looksGreenfield([])).toBe(true);
  expect(looksGreenfield([".git", "README.md", "LICENSE", ".gitignore"])).toBe(true);
  expect(looksGreenfield(["src", "package.json"])).toBe(false);
});

test("detectCommands: package.json scripts, watch/dev scripts rejected", () => {
  const cmds = detectCommands(
    manifests({
      packageJson: JSON.stringify({
        scripts: {
          build: "vite build",
          test: "vitest run",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          dev: "vite --watch",
        },
        devDependencies: { typescript: "^5" },
      }),
      lockfiles: ["package-lock.json"],
    }),
  );
  expect(cmds.build).toBe("npm run build");
  expect(cmds.test).toBe("npm run test");
  expect(cmds.typecheck).toBe("npm run typecheck");
  expect(cmds.lint).toBe("npm run lint");
  expect(cmds.install).toBe("npm ci");
});

test("detectCommands: a watch test script is NOT a usable gate command", () => {
  const cmds = detectCommands(
    manifests({
      packageJson: JSON.stringify({ scripts: { test: "vitest --watch" } }),
    }),
  );
  expect(cmds.test).toBeUndefined();
});

test("detectCommands: 'vite build' is not falsely rejected as a dev server", () => {
  const cmds = detectCommands(
    manifests({ packageJson: JSON.stringify({ scripts: { build: "vite build" } }) }),
  );
  expect(cmds.build).toBe("npm run build");
});

test("detectCommands: typescript dep without a script yields npx tsc --noEmit", () => {
  const cmds = detectCommands(
    manifests({
      packageJson: JSON.stringify({ scripts: {}, devDependencies: { typescript: "^5.4" } }),
    }),
  );
  expect(cmds.typecheck).toBe("npx tsc --noEmit");
});

test("detectCommands: bun lockfile selects bun as the package manager", () => {
  const cmds = detectCommands(
    manifests({
      packageJson: JSON.stringify({ scripts: { test: "bun test" } }),
      lockfiles: ["bun.lock"],
    }),
  );
  expect(cmds.test).toBe("bun run test");
  expect(cmds.install).toBe("bun install");
});

test("detectCommands: cargo / go / pyproject / Makefile heuristics", () => {
  expect(detectCommands(manifests({ cargo: "[package]\nname='x'" })).test).toBe("cargo test");
  expect(detectCommands(manifests({ gomod: "module x" })).typecheck).toBe("go vet ./...");
  const py = detectCommands(manifests({ pyproject: "[tool.mypy]\n[tool.ruff]" }));
  expect(py.typecheck).toBe("mypy .");
  expect(py.lint).toBe("ruff check .");
  const mk = detectCommands(manifests({ makefile: "build:\n\tcc x.c\ntest:\n\t./run-tests" }));
  expect(mk.build).toBe("make build");
  expect(mk.test).toBe("make test");
});

test("reconRepo: batched probe parsed into a profile; greenfield detected", async () => {
  const probeOut = (sections: Record<string, string>) =>
    `${Object.entries(sections)
      .map(([k, v]) => `@@VIBECODR@@${k}\n${v}`)
      .join("\n")}\n@@VIBECODR@@END\n`;

  const fake: Exec = async () => ({
    out: probeOut({
      LS: "src\npackage.json",
      GITREPO: "true",
      GITBRANCH: "main",
      GITDIRTY: " M src/app.ts",
      PKG: JSON.stringify({
        scripts: { build: "tsc", test: "bun test" },
        devDependencies: { typescript: "^5" },
      }),
      LOCK: "bun.lock",
    }),
    code: 0,
  });
  const profile = await reconRepo(fake, "/tmp/x");
  expect(profile.greenfield).toBe(false);
  expect(profile.primaryLanguage).toBe("TypeScript");
  expect(profile.packageManager).toBe("bun");
  expect(profile.git).toEqual({ isRepo: true, branch: "main", dirty: true });
  expect(profile.commands.build).toBe("bun run build");
  expect(profile.manifestFiles).toContain("package.json");

  const empty: Exec = async () => ({
    out: "@@VIBECODR@@LS\nREADME.md\n@@VIBECODR@@END\n",
    code: 0,
  });
  expect((await reconRepo(empty, "/tmp/y")).greenfield).toBe(true);
});

test("reconRepo: a throwing exec degrades to a non-greenfield empty profile", async () => {
  const boom: Exec = async () => {
    throw new Error("spawn failed");
  };
  const profile = await reconRepo(boom, "/tmp/z");
  expect(profile.greenfield).toBe(false);
  expect(profile.commands).toEqual({});
});

test("detectServeCommand: vite dev server with deterministic port; next PORT env", () => {
  const vite = detectServeCommand(
    manifests({
      packageJson: JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vue: "^3" } }),
    }),
    4111,
  );
  expect(vite?.cmd).toContain("--port 4111");
  expect(vite?.needsBuild).toBe(false);

  const next = detectServeCommand(
    manifests({
      packageJson: JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14" } }),
    }),
    4112,
  );
  expect(next?.cmd).toContain("PORT=4112");

  expect(
    detectServeCommand(manifests({ packageJson: JSON.stringify({ scripts: {} }) }), 4113),
  ).toBeNull();
});

test("isWebApp keys off the detected framework", async () => {
  const fake: Exec = async () => ({
    out: `@@VIBECODR@@LS\npackage.json\n@@VIBECODR@@PKG\n${JSON.stringify({ dependencies: { react: "18" } })}\n@@VIBECODR@@END\n`,
    code: 0,
  });
  const profile = await reconRepo(fake, "/tmp/w");
  expect(isWebApp(profile)).toBe(true);
});

test("serveDaemonCommand wraps the command in sh -c so PORT= prefixes work", () => {
  const cmd = serveDaemonCommand("PORT=4000 npm run dev", "/tmp/log", "/tmp/pid");
  expect(cmd).toContain('nohup sh -c "PORT=4000 npm run dev"');
  expect(cmd).toContain("echo $! >");
});
