import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("cloud export includes recursive submodule commit bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-cloud-export-"));
  roots.push(root);
  const parent = join(root, "parent");
  const child = join(root, "child");
  await mkdir(parent);
  await mkdir(child);
  const git = async (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });
  for (const cwd of [parent, child]) {
    await git(cwd, "init");
    await git(cwd, "config", "user.name", "Vibe Test");
    await git(cwd, "config", "user.email", "vibe@example.invalid");
  }
  await writeFile(join(child, "library.txt"), "portable\n");
  await git(child, "add", "library.txt");
  await git(child, "commit", "-m", "child");
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "modules/child");
  await git(parent, "commit", "-am", "parent");
  const base = join(root, "handoff.json");
  const output = join(root, "return.json");
  await writeFile(base, JSON.stringify({ manifest: { entries: [] } }));
  const script = join(import.meta.dirname, "..", "bin", "cloud-export.ts");
  const childProcess = Bun.spawn([process.execPath, "run", script, parent, base, output], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await childProcess.exited;
  if (exit !== 0) throw new Error(await new Response(childProcess.stderr).text());
  const value = JSON.parse(await readFile(output, "utf8")) as {
    git: { submodules: Array<{ path: string; head: string; bundlePath: string }> };
    files: Array<{ path: string; contentBase64: string }>;
  };
  expect(value.git.submodules).toEqual([
    expect.objectContaining({ path: "modules/child", head: expect.stringMatching(/^[0-9a-f]{40,64}$/) }),
  ]);
  expect(value.files.map((file) => file.path)).toContain(value.git.submodules[0]!.bundlePath);
});

test("cloud export records tracked deletions instead of failing the return", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-cloud-export-deleted-"));
  roots.push(root);
  await gitInit(root);
  await writeFile(join(root, "removed.txt"), "remove me\n");
  await Bun.$`git -C ${root} add removed.txt`.quiet();
  await Bun.$`git -C ${root} commit -m base`.quiet();
  await rm(join(root, "removed.txt"));

  const base = join(root, "handoff.json");
  const output = join(root, "return.json");
  await writeFile(base, JSON.stringify({ manifest: { entries: [{ path: "removed.txt" }] } }));
  await runExport(root, base, output);

  const value = JSON.parse(await readFile(output, "utf8")) as { git: { deleted: string[] } };
  expect(value.git.deleted).toContain("removed.txt");
});

async function gitInit(root: string): Promise<void> {
  await Bun.$`git -C ${root} init`.quiet();
  await Bun.$`git -C ${root} config user.name "Vibe Test"`.quiet();
  await Bun.$`git -C ${root} config user.email vibe@example.invalid`.quiet();
}

async function runExport(root: string, base: string, output: string): Promise<void> {
  const script = join(import.meta.dirname, "..", "bin", "cloud-export.ts");
  const childProcess = Bun.spawn([process.execPath, "run", script, root, base, output], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await childProcess.exited;
  if (exit !== 0) throw new Error(await new Response(childProcess.stderr).text());
}
