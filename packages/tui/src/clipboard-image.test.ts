import { test, expect } from "bun:test";
import {
  clipboardImageProbes,
  decodeProbe,
  probeClipboardImage,
  readClipboardImage,
  type ClipboardExec,
  type ExecResult,
} from "./clipboard-image.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

function ok(stdout: Uint8Array): ExecResult {
  return { launched: true, code: 0, stdout };
}
const notInstalled: ExecResult = { launched: false, code: -1, stdout: new Uint8Array() };
const ranNoImage: ExecResult = { launched: true, code: 1, stdout: new Uint8Array() };

test("clipboardImageProbes order: darwin pngpaste→osascript, linux wl-paste→xclip", () => {
  expect(clipboardImageProbes("darwin").map((c) => c[0])).toEqual(["pngpaste", "osascript"]);
  expect(clipboardImageProbes("linux").map((c) => c[0])).toEqual(["wl-paste", "xclip"]);
  expect(clipboardImageProbes("win32")).toEqual([]);
});

test("decodeProbe accepts raw PNG stdout but rejects non-PNG bytes", () => {
  expect(decodeProbe(["pngpaste", "-"], ok(PNG))).toEqual(PNG);
  expect(decodeProbe(["pngpaste", "-"], ok(new Uint8Array([1, 2, 3])))).toBeNull();
  expect(decodeProbe(["pngpaste", "-"], ranNoImage)).toBeNull();
  expect(decodeProbe(["pngpaste", "-"], notInstalled)).toBeNull();
});

test("decodeProbe decodes osascript «data PNGf…» hex", () => {
  const hex = [...PNG].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const stdout = new TextEncoder().encode(`«data PNGf${hex}»\n`);
  expect(decodeProbe(["osascript", "-e", "…"], ok(stdout))).toEqual(PNG);
  // Non-image osascript output (no «data PNGf…») → null.
  expect(decodeProbe(["osascript", "-e", "…"], ok(new TextEncoder().encode("nope")))).toBeNull();
});

test("probeClipboardImage returns the first probe's image (pngpaste wins)", async () => {
  const calls: string[][] = [];
  const exec: ClipboardExec = async (cmd) => {
    calls.push(cmd);
    return cmd[0] === "pngpaste" ? ok(PNG) : ranNoImage;
  };
  const res = await probeClipboardImage(exec, "darwin");
  expect(res).toEqual({ bytes: PNG });
  expect(calls).toEqual([["pngpaste", "-"]]); // stopped after the first hit
});

test("probeClipboardImage falls through pngpaste (not installed) to osascript", async () => {
  const hex = [...PNG].map((b) => b.toString(16).padStart(2, "0")).join("");
  const exec: ClipboardExec = async (cmd) =>
    cmd[0] === "pngpaste" ? notInstalled : ok(new TextEncoder().encode(`«data PNGf${hex}»`));
  const res = await probeClipboardImage(exec, "darwin");
  expect(res).toEqual({ bytes: PNG });
});

test("probeClipboardImage: tool ran but no image → none", async () => {
  const exec: ClipboardExec = async () => ranNoImage;
  expect(await probeClipboardImage(exec, "linux")).toEqual({ kind: "none" });
});

test("probeClipboardImage: no tool launched → unavailable", async () => {
  const exec: ClipboardExec = async () => notInstalled;
  expect(await probeClipboardImage(exec, "linux")).toEqual({ kind: "unavailable" });
  // No probes for an unknown platform → also unavailable.
  expect(await probeClipboardImage(exec, "win32")).toEqual({ kind: "unavailable" });
});

test("probeClipboardImage: an exec that throws is treated as tool-missing", async () => {
  const exec: ClipboardExec = async () => {
    throw new Error("boom");
  };
  expect(await probeClipboardImage(exec, "linux")).toEqual({ kind: "unavailable" });
});

test("readClipboardImage writes the decoded bytes to a temp file and returns its path", async () => {
  const written: { path: string; bytes: Uint8Array }[] = [];
  const res = await readClipboardImage({
    platform: "darwin",
    exec: async (cmd) => (cmd[0] === "pngpaste" ? ok(PNG) : ranNoImage),
    outPath: "/tmp/vibe-clip-test.png",
    writeFile: async (path, bytes) => {
      written.push({ path, bytes });
    },
  });
  expect(res).toEqual({ kind: "image", path: "/tmp/vibe-clip-test.png" });
  expect(written).toEqual([{ path: "/tmp/vibe-clip-test.png", bytes: PNG }]);
});

test("readClipboardImage returns none/unavailable without writing a file", async () => {
  let wrote = false;
  const writeFile = async () => {
    wrote = true;
  };
  const none = await readClipboardImage({ platform: "linux", exec: async () => ranNoImage, writeFile });
  expect(none).toEqual({ kind: "none" });
  const un = await readClipboardImage({ platform: "linux", exec: async () => notInstalled, writeFile });
  expect(un).toEqual({ kind: "unavailable" });
  expect(wrote).toBe(false);
});
