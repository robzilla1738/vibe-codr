#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const valueFor = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};

const gitRevision = (): string => {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not resolve engine revision: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
};

const revision = valueFor("revision") ?? process.env.VIBE_ENGINE_COMMIT?.trim() ?? gitRevision();
if (!/^[0-9a-f]{40}$/i.test(revision)) {
  throw new Error(`engine revision must be a 40-character Git commit, received "${revision}"`);
}

const outfile = resolve(root, valueFor("outfile") ?? join("dist", "vibecodr-engine-host"));
const target = valueFor("target") as Bun.Build.CompileTarget | undefined;
mkdirSync(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "packages", "macos-bridge", "bin", "engine-host.ts")],
  compile: {
    ...(target ? { target } : {}),
    outfile,
  },
  define: {
    "process.env.VIBE_ENGINE_COMMIT": JSON.stringify(revision),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}
console.log(`Built ${outfile} with engine revision ${revision}`);
