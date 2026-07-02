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

test("detectCommands: non-terminating test scripts are rejected, one-shot forms kept", () => {
  // [script value, whether cmds.test should be defined]
  const cases: [string, boolean][] = [
    ["jest --watchAll", false], // --watch\b missed --watchAll → hung the gate
    ["jest --watch", false],
    ["react-scripts test", false], // CRA runs Jest in watch mode unless CI=true
    ["CI=true react-scripts test", true], // explicit one-shot is fine
    ["vitest", false], // bare vitest watches by default
    ["vitest watch", false],
    ["npm run test:watch", false], // watch aliased through another script
    ["yarn watch", false],
    ["vitest run", true],
    ["jest --ci", true],
    ["jest", true],
    ["bun test", true],
  ];
  for (const [script, defined] of cases) {
    const cmds = detectCommands(manifests({ packageJson: JSON.stringify({ scripts: { test: script } }) }));
    expect([script, cmds.test !== undefined]).toEqual([script, defined]);
  }
});

test("detectCommands: @typescript-eslint devDep alone does NOT inject a tsc typecheck", () => {
  // A pure-JS repo whose only "typescript"-ish dep is the eslint plugin must not
  // get `npx tsc --noEmit` (no tsconfig / no .ts → TS18003 → spurious RED gate).
  const cmds = detectCommands(
    manifests({
      packageJson: JSON.stringify({
        scripts: {},
        devDependencies: { "@typescript-eslint/parser": "^6", "typescript-eslint": "^7" },
      }),
    }),
  );
  expect(cmds.typecheck).toBeUndefined();
  // …but a real `typescript` dependency key still yields tsc.
  const real = detectCommands(
    manifests({ packageJson: JSON.stringify({ scripts: {}, devDependencies: { typescript: "^5" } }) }),
  );
  expect(real.typecheck).toBe("npx tsc --noEmit");
});

test("detectCommands: tooling-only pyproject gets NO pip/pytest command", () => {
  // Only [tool.ruff] config — no build backend, pytest not in use. Injecting
  // `pip install -e .` / `python -m pytest -q` would be confidently wrong.
  const tooling = detectCommands(manifests({ pyproject: "[tool.ruff]\nline-length = 100" }));
  expect(tooling.install).toBeUndefined();
  expect(tooling.test).toBeUndefined();
  expect(tooling.lint).toBe("ruff check .");

  // A build-backend-only pyproject is installable but has no pytest.
  const backend = detectCommands(
    manifests({ pyproject: "[build-system]\nrequires = ['hatchling']\nbuild-backend = 'hatchling.build'" }),
  );
  expect(backend.install).toBe("pip install -e .");
  expect(backend.test).toBeUndefined();

  // Real pytest evidence (a dep and a config table) → the pytest command.
  const pytest = detectCommands(
    manifests({
      pyproject:
        "[project]\nname = 'x'\ndependencies = ['requests']\n[tool.pytest.ini_options]\naddopts = '-ra'\n",
    }),
  );
  expect(pytest.install).toBe("pip install -e .");
  expect(pytest.test).toBe("python -m pytest -q");
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
  // A double-colon rule is still a target.
  expect(detectCommands(manifests({ makefile: "test::\n\t./run" })).test).toBe("make test");
});

test("detectCommands: a Makefile VARIABLE assignment is not detected as a target", () => {
  // `build := …` / `test ::= …` are GNU-make assignments, not targets — running
  // `make build` on them fails the gate on a target that doesn't exist.
  const vars = detectCommands(
    manifests({ makefile: "build := $(CC) -O2\ntest ::= ./harness\nlint ?= eslint" }),
  );
  expect(vars.build).toBeUndefined();
  expect(vars.test).toBeUndefined();
});

// The recon section marker is a per-run nonce (`@@VIBECODR@@<uuid>@@`) so a
// scanned file can't spoof a section. A faithful fake exec derives the marker
// from the probe command (which embeds it in each `printf "<marker>NAME"`).
function markerFromProbe(probe: string): string {
  const m = /(@@VIBECODR@@[0-9a-f-]+@@)LS/.exec(probe);
  if (!m) throw new Error("probe did not contain a recon marker");
  return m[1]!;
}
const fakeRecon =
  (sections: Record<string, string>): Exec =>
  async (cmd) => {
    const marker = markerFromProbe(cmd);
    const body = Object.entries(sections)
      .map(([k, v]) => `${marker}${k}\n${v}`)
      .join("\n");
    return { out: `${body}\n${marker}END\n`, code: 0 };
  };

test("reconRepo: batched probe parsed into a profile; greenfield detected", async () => {
  const fake = fakeRecon({
    LS: "src\npackage.json",
    GITREPO: "true",
    GITBRANCH: "main",
    GITDIRTY: " M src/app.ts",
    PKG: JSON.stringify({
      scripts: { build: "tsc", test: "bun test" },
      devDependencies: { typescript: "^5" },
    }),
    LOCK: "bun.lock",
  });
  const profile = await reconRepo(fake, "/tmp/x");
  expect(profile.greenfield).toBe(false);
  expect(profile.primaryLanguage).toBe("TypeScript");
  expect(profile.packageManager).toBe("bun");
  expect(profile.git).toEqual({ isRepo: true, branch: "main", dirty: true });
  expect(profile.commands.build).toBe("bun run build");
  expect(profile.manifestFiles).toContain("package.json");

  expect((await reconRepo(fakeRecon({ LS: "README.md" }), "/tmp/y")).greenfield).toBe(true);
});

test("reconRepo: a scanned file containing the sentinel can't spoof a section", async () => {
  // A package.json whose CONTENT embeds the bare sentinel + a section name must
  // not inject a fake section (spoof git state / disable command detection). The
  // per-run nonce makes the real marker unguessable, so the injected text stays
  // inside PKG and is parsed as ordinary (invalid) JSON — detection degrades, git
  // truth is preserved.
  const evil = `@@VIBECODR@@GITDIRTY\n(spoofed clean)\n@@VIBECODR@@PKG\n{}`;
  const fake = fakeRecon({
    LS: "package.json",
    GITREPO: "true",
    GITDIRTY: " M real-change.ts", // real dirty state
    PKG: evil,
  });
  const profile = await reconRepo(fake, "/tmp/evil");
  // The real dirty state survived — the embedded "@@VIBECODR@@GITDIRTY" did not
  // overwrite it with the spoofed clean value.
  expect(profile.git.dirty).toBe(true);
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
  const fake = fakeRecon({
    LS: "package.json",
    PKG: JSON.stringify({ dependencies: { react: "18" } }),
  });
  const profile = await reconRepo(fake, "/tmp/w");
  expect(isWebApp(profile)).toBe(true);
});

test("serveDaemonCommand wraps the command in sh -c so PORT= prefixes work", () => {
  const cmd = serveDaemonCommand("PORT=4000 npm run dev", "/tmp/log", "/tmp/pid");
  expect(cmd).toContain('nohup sh -c "PORT=4000 npm run dev"');
  expect(cmd).toContain("echo $! >");
});
