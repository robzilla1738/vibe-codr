import type { LspConfig } from "@vibe/config";

/**
 * Pure filetype → language-server table. NO IO except the injected `which`
 * probe: `resolveServer` picks the FIRST candidate command actually present on
 * PATH, so a language with no installed server simply gets no diagnostics (never
 * an install, never a false failure). The table is data — adding a language is a
 * one-line entry.
 */

/** One candidate server executable + its stdio-mode default args. */
export interface ServerCandidate {
  command: string;
  args: string[];
}

/** A language's LSP wiring: the id sent in `didOpen`, and ordered candidates
 * (first present on PATH wins). */
export interface LanguageDef {
  languageId: string;
  candidates: ServerCandidate[];
}

/** A resolved, ready-to-spawn server for a language. */
export interface ResolvedServer {
  command: string;
  args: string[];
  languageId: string;
}

/** Probe whether a binary exists on PATH. Injectable so tests never touch PATH. */
export type WhichFn = (command: string) => string | null;

const STDIO = "--stdio";

/**
 * language key → server candidates. Keys are the stable identifiers used in
 * `config.lsp.disabledLanguages` / `config.lsp.servers` and in `/doctor`. The
 * candidate ORDER is the preference order (e.g. basedpyright before the older
 * pyright before pylsp).
 */
export const LANGUAGE_SERVERS: Record<string, LanguageDef> = {
  py: {
    languageId: "python",
    candidates: [
      { command: "basedpyright-langserver", args: [STDIO] },
      { command: "pyright-langserver", args: [STDIO] },
      { command: "pylsp", args: [] },
    ],
  },
  go: { languageId: "go", candidates: [{ command: "gopls", args: [] }] },
  rust: { languageId: "rust", candidates: [{ command: "rust-analyzer", args: [] }] },
  c: { languageId: "c", candidates: [{ command: "clangd", args: [] }] },
  cpp: { languageId: "cpp", candidates: [{ command: "clangd", args: [] }] },
  java: { languageId: "java", candidates: [{ command: "jdtls", args: [] }] },
  ruby: {
    languageId: "ruby",
    candidates: [
      { command: "ruby-lsp", args: [] },
      { command: "solargraph", args: ["stdio"] },
    ],
  },
  php: {
    languageId: "php",
    candidates: [
      { command: "intelephense", args: [STDIO] },
      { command: "phpactor", args: ["language-server"] },
    ],
  },
  lua: { languageId: "lua", candidates: [{ command: "lua-language-server", args: [] }] },
  zig: { languageId: "zig", candidates: [{ command: "zls", args: [] }] },
};

/** File extension (lowercase, no dot) → language key. */
const EXT_TO_LANG: Record<string, string> = {
  py: "py",
  pyi: "py",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  java: "java",
  rb: "ruby",
  rake: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
};

/** The language key for a path, or undefined when no server maps to it. */
export function languageForPath(absPath: string): string | undefined {
  const m = /\.([^.\\/]+)$/.exec(absPath);
  if (!m) return undefined;
  return EXT_TO_LANG[m[1]!.toLowerCase()];
}

/**
 * Resolve the server to spawn for a language, or undefined when disabled or no
 * candidate binary is present. Honors, in order: `disabledLanguages`, an explicit
 * per-language `enabled:false`, a `command` override (replaces the candidate
 * list), and an `args` override (replaces the resolved candidate's default args).
 */
export function resolveServer(
  lang: string,
  config: Pick<LspConfig, "disabledLanguages" | "servers">,
  which: WhichFn,
): ResolvedServer | undefined {
  if (config.disabledLanguages.includes(lang)) return undefined;
  const override = config.servers[lang];
  if (override?.enabled === false) return undefined;

  const def = LANGUAGE_SERVERS[lang];
  const languageId = def?.languageId ?? lang;

  // An explicit command override REPLACES the built-in candidates (the user
  // knows their setup); an unknown language with a command override is still
  // honored, using the language key as the LSP languageId.
  const candidates: ServerCandidate[] = override?.command
    ? [{ command: override.command, args: override.args ?? [] }]
    : (def?.candidates ?? []);

  for (const candidate of candidates) {
    if (which(candidate.command)) {
      // `args` override wins over the candidate's defaults (e.g. tweak a default
      // server's flags without swapping the binary).
      const args = override?.args ?? candidate.args;
      return { command: candidate.command, args, languageId };
    }
  }
  return undefined;
}
