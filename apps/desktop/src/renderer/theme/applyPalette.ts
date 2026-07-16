import type { Palette } from "../../shared/themes";
import { paletteColorScheme, resolveChromeAccent } from "../../shared/theme-scheme";

/** Apply a TUI palette as CSS variables on :root. */
export function applyPalette(p: Palette, accentOverride?: string, themeName?: string): void {
  const root = document.documentElement;
  const scheme = paletteColorScheme(p);
  // The CLI light palette targets terminal cells. The desktop shell needs a
  // brighter raised surface and stronger neutral contrast because macOS window
  // materials and antialiasing otherwise wash those same values out.
  const ui = scheme === "light"
    ? {
        ...p,
        assistant: "#20242e",
        muted: "#68707a",
        heading: "#20242e",
        border: "#d5d8df",
        background: "#f8f8f7",
        panel: "#eff0f2",
        elevated: "#ffffff",
        ctx: "#677184",
        taskDone: "#7b8494",
      }
    : p;
  const chrome = resolveChromeAccent(p, accentOverride);
  const diff = themeName === "contrast"
    ? { add: "#5fff00", del: "#ff3b3b", addBg: "#003000", delBg: "#3a0000" }
    : scheme === "light"
      ? { add: "#087a3b", del: "#c92a2a", addBg: "#dff5e8", delBg: "#fde5e5" }
      : { add: "#00d26a", del: "#ff4d4f", addBg: "#123522", delBg: "#3b1d22" };
  root.style.colorScheme = scheme;
  root.dataset.scheme = scheme;
  if (themeName) root.dataset.theme = themeName;
  root.style.setProperty("--bg", ui.background);
  root.style.setProperty("--panel", ui.panel);
  root.style.setProperty("--elevated", ui.elevated);
  root.style.setProperty("--border", ui.border);
  root.style.setProperty("--muted", ui.muted);
  root.style.setProperty("--assistant", ui.assistant);
  root.style.setProperty("--primary", chrome.primary);
  root.style.setProperty("--accent", chrome.accent);
  root.style.setProperty("--user", p.user);
  root.style.setProperty("--tool", p.tool);
  root.style.setProperty("--notice", p.notice);
  root.style.setProperty("--plan", p.plan);
  root.style.setProperty("--subagent", p.subagent);
  root.style.setProperty("--add", p.add);
  root.style.setProperty("--del", p.del);
  root.style.setProperty("--add-bg", p.addBg);
  root.style.setProperty("--del-bg", p.delBg);
  root.style.setProperty("--diff-add", diff.add);
  root.style.setProperty("--diff-del", diff.del);
  root.style.setProperty("--diff-add-bg", diff.addBg);
  root.style.setProperty("--diff-del-bg", diff.delBg);
  root.style.setProperty("--gutter", p.gutter);
  // Light mode keeps headings and interface chrome neutral even when the CLI
  // palette uses a blue heading accent. Blue remains available through the
  // dedicated code/link role for filenames and references.
  root.style.setProperty("--heading", scheme === "light" ? ui.heading : chrome.heading);
  root.style.setProperty("--code", p.code);
  root.style.setProperty("--sel-bg", chrome.selBg);
  root.style.setProperty("--sel-fg", chrome.selFg);
  root.style.setProperty("--task-done", ui.taskDone);
  root.style.setProperty("--task-active", p.taskActive);
  root.style.setProperty("--task-pending", p.taskPending);
  root.style.setProperty("--ctx", ui.ctx);
  root.style.setProperty("--rail", ui.panel);
  root.style.setProperty("--surface", ui.elevated);
  root.style.setProperty("--ring", chrome.ring);
  root.style.setProperty("--focus", chrome.focus);
  root.style.setProperty("--mode", chrome.mode);
}
