/**
 * Read an image off the OS clipboard by shelling out to the platform's clipboard
 * tool, then hand back the decoded bytes. The TUI writes those bytes to a session
 * temp file and inserts an `@<path>` mention so the EXISTING mention pipeline
 * (byte caps, media typing) owns everything downstream.
 *
 * All shell-out goes through an injectable `exec` seam so the platform probe
 * ORDER and the decode logic are unit-testable without a real clipboard. The
 * real wiring (`readClipboardImage`) is a thin adapter over Bun.spawn + a tmp
 * file; keep app.tsx wiring correspondingly thin.
 *
 * Probe order per platform (first that yields an image wins):
 *   - darwin: `pngpaste -` (raw PNG on stdout) → `osascript` (AppleScript
 *     `«data PNGf…»` hex on stdout, decoded here).
 *   - linux:  `wl-paste -t image/png` (Wayland) → `xclip -selection clipboard
 *     -t image/png -o` (X11).
 *   - anything else: no probes → unavailable.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** PNG's 8-byte magic signature — the fingerprint every probe's bytes must carry
 * so a tool that printed an error string (not an image) is never mistaken for one. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Result of running one probe command. `launched:false` means the binary
 * couldn't start (not installed) — distinct from "ran but the clipboard held no
 * image" (`launched:true`, non-zero/empty), so the caller can tell "no tool" from
 * "no image". */
export interface ExecResult {
  launched: boolean;
  code: number;
  stdout: Uint8Array;
}

/** Injectable command runner: runs `cmd`, returns its exit code + stdout bytes. */
export type ClipboardExec = (cmd: string[]) => Promise<ExecResult>;

export type ClipboardImageResult =
  /** An image was found and written to `path`. */
  | { kind: "image"; path: string }
  /** A clipboard tool ran but the clipboard held no image (e.g. text). */
  | { kind: "none" }
  /** No usable clipboard tool for this platform / none could launch. */
  | { kind: "unavailable" };

/** The ordered probe commands for a platform, most-preferred first. Pure, so the
 * order is unit-testable. */
export function clipboardImageProbes(platform: string): string[][] {
  if (platform === "darwin") {
    return [
      ["pngpaste", "-"],
      ["osascript", "-e", "the clipboard as «class PNGf»"],
    ];
  }
  if (platform === "linux") {
    return [
      ["wl-paste", "-t", "image/png"],
      ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ];
  }
  return [];
}

function startsWithPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Extract PNG bytes from one probe's result, or null if this probe produced no
 * image. `osascript` prints the AppleScript literal `«data PNGf89504E47…»` (hex)
 * to stdout — decoded here; every other probe writes raw PNG bytes to stdout.
 */
export function decodeProbe(cmd: string[], res: ExecResult): Uint8Array | null {
  if (!res.launched || res.code !== 0 || res.stdout.length === 0) return null;
  if (cmd[0] === "osascript") {
    // osascript prints the guillemets as UTF-8 (`«` = 0xC2 0xAB) in a UTF-8
    // terminal, so decode as UTF-8 — a latin1 decode would mojibake the `«…»`.
    const text = new TextDecoder().decode(res.stdout);
    const m = /«data PNGf([0-9A-Fa-f]+)»/.exec(text);
    if (!m) return null;
    const bytes = hexToBytes(m[1]!);
    return startsWithPng(bytes) ? bytes : null;
  }
  return startsWithPng(res.stdout) ? res.stdout : null;
}

/**
 * Probe the clipboard for an image via the injected `exec`. Returns the decoded
 * bytes, or a reason: "none" (a tool ran but no image), "unavailable" (no tool
 * launched). Pure over the seam.
 */
export async function probeClipboardImage(
  exec: ClipboardExec,
  platform: string,
): Promise<{ bytes: Uint8Array } | { kind: "none" | "unavailable" }> {
  let anyLaunched = false;
  for (const cmd of clipboardImageProbes(platform)) {
    let res: ExecResult;
    try {
      res = await exec(cmd);
    } catch {
      continue; // treat an exec seam throw as "tool couldn't launch"
    }
    if (res.launched) anyLaunched = true;
    const bytes = decodeProbe(cmd, res);
    if (bytes) return { bytes };
  }
  return { kind: anyLaunched ? "none" : "unavailable" };
}

/**
 * The per-session directory that pasted clipboard PNGs are written into,
 * namespaced by pid so two concurrent TUIs never collide. Pastes can't be
 * deleted per-file at paste time — `expandMentions` reads the file at SUBMIT
 * time, so a paste-time unlink would race the read — so every clip lands here
 * and the whole dir is removed once on app teardown (see `cleanupClipboardTempDir`).
 */
export function clipboardTempDir(): string {
  return join(tmpdir(), `vibe-clips-${process.pid}`);
}

/**
 * Best-effort teardown: remove the per-session clips dir (and everything in it).
 * NEVER throws — a cleanup failure (dir already gone, permissions) is swallowed
 * so a doomed unlink can't trap the exit path that calls this.
 */
export async function cleanupClipboardTempDir(dir: string = clipboardTempDir()): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // swallow — teardown must not throw
  }
}

export interface ReadClipboardImageDeps {
  exec?: ClipboardExec;
  platform?: string;
  /** Where to write the decoded image. Defaults to a unique tmp PNG path. */
  outPath?: string;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** Bun-backed exec: runs `cmd`, capturing stdout bytes. A spawn failure (binary
 * absent) surfaces as `launched:false` rather than throwing. */
const bunExec: ClipboardExec = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    return { launched: true, code, stdout };
  } catch {
    return { launched: false, code: -1, stdout: new Uint8Array() };
  }
};

/**
 * Probe the clipboard and, if an image is present, write it to a session temp
 * file. Returns `{kind:"image", path}` on success, `{kind:"none"}` when no image
 * is on the clipboard, `{kind:"unavailable"}` when no clipboard tool exists. Never
 * throws for the expected cases — the caller shows a one-line notice.
 */
export async function readClipboardImage(
  deps: ReadClipboardImageDeps = {},
): Promise<ClipboardImageResult> {
  const exec = deps.exec ?? bunExec;
  const platform = deps.platform ?? process.platform;
  const probe = await probeClipboardImage(exec, platform);
  if ("kind" in probe) return probe;
  const path = deps.outPath ?? join(clipboardTempDir(), `vibe-clip-${randomUUID()}.png`);
  // Default writer ensures the (per-session) parent dir exists first; an injected
  // writeFile owns its own placement and skips this.
  const write =
    deps.writeFile ??
    (async (p: string, b: Uint8Array) => {
      await mkdir(dirname(p), { recursive: true });
      await Bun.write(p, b);
    });
  await write(path, probe.bytes);
  return { kind: "image", path };
}
