import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunWrite, clipboardCommands, copyToClipboard } from "./clipboard.ts";

test("clipboardCommands picks the platform tool", () => {
  expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
  expect(clipboardCommands("win32")).toEqual([["clip"]]);
  // Linux tries Wayland then X11 tools, in order.
  expect(clipboardCommands("linux")[0]).toEqual(["wl-copy"]);
  expect(clipboardCommands("linux").some((c) => c[0] === "xclip")).toBe(true);
});

test("copyToClipboard writes via the first launcher that succeeds", () => {
  const calls: { cmd: string[]; text: string }[] = [];
  const ok = copyToClipboard("hello", {
    platform: "darwin",
    write: (cmd, text) => {
      calls.push({ cmd, text });
      return true;
    },
  });
  expect(ok).toBe(true);
  expect(calls).toEqual([{ cmd: ["pbcopy"], text: "hello" }]);
});

test("copyToClipboard falls through to the next Linux tool when one can't launch", () => {
  const tried: string[] = [];
  const ok = copyToClipboard("x", {
    platform: "linux",
    write: (cmd) => {
      tried.push(cmd[0]!);
      return cmd[0] === "xclip"; // wl-copy missing, xclip works
    },
  });
  expect(ok).toBe(true);
  expect(tried).toEqual(["wl-copy", "xclip"]);
});

test("copyToClipboard reports success from OSC52 even if no command launches", () => {
  let osc52Text = "";
  const ok = copyToClipboard("copied", {
    platform: "linux",
    osc52: (t) => {
      osc52Text = t;
      return true;
    },
    write: () => false, // no clipboard binary available
  });
  expect(ok).toBe(true);
  expect(osc52Text).toBe("copied");
});

test("copyToClipboard ignores empty text", () => {
  let called = false;
  const write = () => {
    called = true;
    return true;
  };
  expect(copyToClipboard("", { write })).toBe(false);
  expect(called).toBe(false);
});

test("bunWrite delivers a large payload intact (no backpressure truncation)", async () => {
  // A ~2MB selection under stdin backpressure must not be truncated by an
  // immediate end(); bunWrite flushes the write before closing.
  const dir = mkdtempSync(join(tmpdir(), "vibe-clip-"));
  const out = join(dir, "out.txt");
  const payload = "x".repeat(2_000_000);
  expect(bunWrite(["sh", "-c", `cat > ${out}`], payload)).toBe(true);
  // Poll for the sink to reach the OS-piped child and complete the copy (re-stat
  // a fresh Bun.file each iteration — its size is snapshotted at creation).
  let got = "";
  for (let i = 0; i < 300; i++) {
    const f = Bun.file(out);
    if ((await f.exists()) && f.size >= payload.length) {
      got = await f.text();
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(got).toBe(payload);
});
