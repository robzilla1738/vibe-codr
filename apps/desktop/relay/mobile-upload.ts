import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolveWritablePathInsideRoot } from "../src/shared/path-safe.js";
import { isBoundedCanonicalBase64, MOBILE_UPLOAD_MAX_BYTES, type MobileUploadResult } from "./protocol.js";

export interface MobileUploadInput {
  name: string;
  mimeType?: string;
  dataBase64: string;
}

export async function persistMobileUpload(cwd: string, input: MobileUploadInput): Promise<MobileUploadResult> {
  const decoded = decodeBoundedBase64(input.dataBase64);
  if (!decoded.ok) return decoded;
  const name = safeUploadName(input.name);
  const relativePath = `.vibe/mobile-attachments/${randomUUID()}-${name}`;
  const located = resolveWritablePathInsideRoot(cwd, relativePath, { existsSync, lstatSync, realpathSync });
  if (!located.ok) return { ok: false, error: located.error };
  try {
    await mkdir(dirname(located.target), { recursive: true, mode: 0o700 });
    await writeFile(located.target, decoded.bytes, { flag: "wx", mode: 0o600 });
    return {
      ok: true,
      path: relativePath,
      name,
      size: decoded.bytes.byteLength,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeBoundedBase64(value: string): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  if (!isBoundedCanonicalBase64(value)) {
    return { ok: false, error: "Attachment data is not valid base64" };
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MOBILE_UPLOAD_MAX_BYTES) {
    return { ok: false, error: `Attachment exceeds the ${MOBILE_UPLOAD_MAX_BYTES / 1024 / 1024}MB limit` };
  }
  if (bytes.toString("base64") !== value) return { ok: false, error: "Attachment data is not canonical base64" };
  return { ok: true, bytes };
}

function safeUploadName(value: string): string {
  const leaf = basename(value.replace(/\\/g, "/")).normalize("NFKC");
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "attachment";
}
