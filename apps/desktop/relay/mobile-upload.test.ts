import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOBILE_UPLOAD_MAX_BYTES } from "./protocol";
import { persistMobileUpload } from "./mobile-upload";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-mobile-upload-"));
  roots.push(root);
  return root;
}

describe("mobile attachment persistence", () => {
  it("writes bounded bytes to a collision-safe project-relative path", async () => {
    const root = await projectRoot();
    const result = await persistMobileUpload(root, {
      name: "../Screenshot 2026.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("image-bytes").toString("base64"),
    });
    expect(result).toMatchObject({ ok: true, name: "Screenshot 2026.png", size: 11, mimeType: "image/png" });
    if (!result.ok) return;
    expect(result.path).toMatch(/^\.vibe\/mobile-attachments\/[0-9a-f-]+-Screenshot 2026\.png$/);
    expect(await readFile(join(root, result.path), "utf8")).toBe("image-bytes");
  });

  it("rejects malformed and oversized payloads without expensive decoding", async () => {
    const root = await projectRoot();
    await expect(persistMobileUpload(root, { name: "bad.txt", dataBase64: "not base64" })).resolves.toMatchObject({ ok: false });
    const tooLarge = Buffer.alloc(MOBILE_UPLOAD_MAX_BYTES + 1).toString("base64");
    await expect(persistMobileUpload(root, { name: "huge.bin", dataBase64: tooLarge })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("5MB") });
  });

  it("rejects a symlinked upload directory", async () => {
    const root = await projectRoot();
    const outside = await projectRoot();
    await symlink(await realpath(outside), join(root, ".vibe"));
    await expect(persistMobileUpload(root, { name: "escape.txt", dataBase64: Buffer.from("nope").toString("base64") })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("symbolic link") });
  });
});
