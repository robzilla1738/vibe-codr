// A small, pure VT/ANSI screen model for the remote terminal. Not a full
// xterm emulator (full-screen apps like vim/less are out of scope for the
// contextual terminal), but it correctly handles the common shell cases:
// SGR color, carriage return, line feed, backspace, tab, line wrap, and
// OSC/cursor sequences are stripped. Pure + unit-tested so the renderer is
// just a projection. Capped to keep memory bounded over long sessions.
import { useReducer } from "react";

export interface Cell { ch: string; color: string | null }
export interface Screen { lines: Cell[][]; col: number; row: number; color: string | null }

const MAX_LINES = 2000;
const MAX_COLS = 400;

const SGR_COLORS: Record<number, string | null> = {
  0: null, 30: "#ff6b6b", 31: "#ff5c5c", 32: "#4fd6be", 33: "#f5a742", 34: "#5c9cf5",
  35: "#bb9af7", 36: "#56b6c2", 37: "#eeeeee", 90: "#808080", 91: "#ff8e8e", 92: "#7fd88f",
  93: "#fab283", 94: "#7db5ff", 95: "#d7a7ff", 96: "#8de4e4", 97: "#ffffff",
};

function blank(): Cell[] { return [] }
function ensureLine(screen: Screen, row: number): Cell[] {
  while (screen.lines.length <= row) screen.lines.push(blank());
  return screen.lines[row]!;
}

function writeChar(screen: Screen, ch: string): void {
  const line = ensureLine(screen, screen.row);
  while (line.length < screen.col) line.push({ ch: " ", color: screen.color });
  line[screen.col] = { ch, color: screen.color };
  screen.col += 1;
  if (screen.col >= MAX_COLS) { screen.col = 0; screen.row += 1; }
}

function newline(screen: Screen): void { screen.row += 1; screen.col = 0; trim(screen); }
function trim(screen: Screen): void {
  if (screen.lines.length > MAX_LINES) screen.lines.splice(0, screen.lines.length - MAX_LINES);
}

export function reduceScreen(prev: Screen, data: string): Screen {
  // Clone structurally (lines shallow-cloned lazily on write).
  const screen: Screen = { lines: prev.lines.map((l) => [...l]), col: prev.col, row: prev.row, color: prev.color };
  let i = 0;
  while (i < data.length) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      // ESC sequence
      const next = data.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI ... terminated by a byte in 0x40-0x7e
        let j = i + 2;
        while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j++;
        const body = data.slice(i + 2, j);
        const fin = data.charCodeAt(j);
        if (fin === 0x6d) {
          // SGR
          const params = body.split(";").map((n) => (n === "" ? 0 : parseInt(n, 10)));
          const code = params[0] ?? 0;
          if (code === 0) screen.color = null;
          else if (SGR_COLORS[code]) screen.color = SGR_COLORS[code]!;
        }
        // other CSI (cursor movement etc.) — stripped for the simplified model
        i = j + 1;
        continue;
      }
      if (next === 0x5d) {
        // OSC ... terminated by BEL or ST (ESC \)
        let j = i + 2;
        while (j < data.length && data.charCodeAt(j) !== 0x07 && !(data.charCodeAt(j) === 0x1b && data.charCodeAt(j + 1) === 0x5c)) j++;
        i = data.charCodeAt(j) === 0x07 ? j + 1 : j + 2;
        continue;
      }
      // Other ESC (e.g. \e[ ignored above; lone ESC) — skip the ESC and next byte
      i += 2;
      continue;
    }
    if (c === 0x0d) { screen.col = 0; i++; continue; }
    if (c === 0x0a) { newline(screen); i++; continue; }
    if (c === 0x08) { if (screen.col > 0) screen.col--; i++; continue; }
    if (c === 0x09) { screen.col = Math.min(MAX_COLS - 1, (Math.floor(screen.col / 8) + 1) * 8); i++; continue; }
    if (c === 0x07) { i++; continue; }
    if (c < 0x20) { i++; continue; }
    writeChar(screen, data[i]!);
    i++;
  }
  trim(screen);
  return screen;
}

export function initialScreen(): Screen {
  return { lines: [], col: 0, row: 0, color: null };
}

/** One VoiceOver utterance per terminal row instead of one element per cell. */
export function terminalLineText(line: Cell[]): string {
  return line.map((cell) => cell.ch).join("") || " ";
}

export function useTerminalScreen() {
  const [screen, dispatch] = useReducer(reduceScreen, undefined, initialScreen);
  const write = (data: string) => dispatch(data);
  return { screen, write };
}
