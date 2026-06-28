const ESC = "[";
const enabled = process.stdout.isTTY ?? false;

function wrap(code: string, text: string): string {
  return enabled ? `${ESC}${code}m${text}${ESC}0m` : text;
}

export const ansi = {
  dim: (t: string) => wrap("2", t),
  bold: (t: string) => wrap("1", t),
  italic: (t: string) => wrap("3", t),
  cyan: (t: string) => wrap("36", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  red: (t: string) => wrap("31", t),
  magenta: (t: string) => wrap("35", t),
};
