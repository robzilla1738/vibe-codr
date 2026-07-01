import { test, expect } from "bun:test";
import { clipboardCommands, copyToClipboard } from "./clipboard.ts";

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
