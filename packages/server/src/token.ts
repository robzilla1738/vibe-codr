import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "@vibe/core";

export interface LoopbackToken {
  token: string;
  path: string;
}

/** Load or atomically create the machine-local loopback bearer token. */
export async function loadOrCreateLoopbackToken(
  directory = join(stateRoot(), "loopback"),
): Promise<LoopbackToken> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "token");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing?.trim()) {
    await chmod(path, 0o600);
    return { token: existing.trim(), path };
  }

  const token = randomBytes(32).toString("base64url");
  const temporary = join(directory, `.token.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { token, path };
}

/** Constant-time bearer comparison, including malformed or wrong-length input. */
export function matchesLoopbackBearer(expected: string, authorization: string | null): boolean {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.alloc(expectedBytes.length);
  const source = Buffer.from(supplied);
  source.copy(suppliedBytes, 0, 0, Math.min(source.length, suppliedBytes.length));
  return timingSafeEqual(expectedBytes, suppliedBytes) && source.length === expectedBytes.length;
}
