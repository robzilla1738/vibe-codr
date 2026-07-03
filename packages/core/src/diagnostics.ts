import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@vibe/shared";

/**
 * In-process TypeScript language-service diagnostics (opencode-style
 * diagnostics-in-the-loop): after an edit/write to a TS/JS file, real compiler
 * errors are appended to the tool result, so the model sees "you broke the
 * types" in the SAME step instead of discovering it a full test run later.
 *
 * `typescript` is an optional peer dep (repo convention): absent → the whole
 * layer degrades to undefined and edits behave exactly as before (run_check
 * remains the verification path). Services are cached per tsconfig; file
 * versions bump on each diagnose so the service re-reads only what changed.
 */

interface TsModule {
  findConfigFile(searchPath: string, fileExists: (f: string) => boolean, name?: string): string | undefined;
  readConfigFile(path: string, readFile: (f: string) => string | undefined): { config?: unknown; error?: unknown };
  parseJsonConfigFileContent(
    json: unknown,
    host: unknown,
    basePath: string,
  ): { fileNames: string[]; options: unknown; errors: unknown[] };
  createLanguageService(host: unknown): TsLanguageService;
  flattenDiagnosticMessageText(text: unknown, newline: string): string;
  sys: {
    fileExists(f: string): boolean;
    readFile(f: string): string | undefined;
    readDirectory(...args: unknown[]): string[];
    getCurrentDirectory(): string;
    useCaseSensitiveFileNames: boolean;
  };
  getDefaultLibFilePath(options: unknown): string;
  ScriptSnapshot: { fromString(s: string): unknown };
}

interface TsDiagnostic {
  file?: { fileName: string; getLineAndCharacterOfPosition(pos: number): { line: number; character: number } };
  start?: number;
  messageText: unknown;
  code: number;
}

interface TsLanguageService {
  getSyntacticDiagnostics(file: string): TsDiagnostic[];
  getSemanticDiagnostics(file: string): TsDiagnostic[];
}

/** Files the TS service can say anything about. */
const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Cap on rendered diagnostics per call — the first errors are the signal. */
const MAX_DIAGNOSTICS = 8;
/** Cap on force-added (not-in-tsconfig) files retained per service, so a
 * long-lived process editing thousands of out-of-project files can't grow the
 * root set unbounded. The project's OWN fileNames are never evicted. */
const MAX_FORCE_ADDED = 2_000;
/** TS "this file isn't part of the project" meta-diagnostics. They fire ONLY
 * because we force-add an edited file the tsconfig excludes / places outside
 * rootDir — they're about project membership, not code correctness, so surfacing
 * them as "fix before moving on" is noise. Dropped for force-added files. */
const PROJECT_MEMBERSHIP_CODES = new Set([
  6059, // File is not under 'rootDir'
  6307, // File is not listed within the file list of project (via include)
  6504, // File is a JavaScript file … 'allowJs'
]);

/** Whether a path is TS/JS — the composite router uses this to keep TS/JS on the
 * cheap in-process fast path and send everything else to the LSP layer. */
export function isTsJs(absPath: string): boolean {
  return TS_EXT.test(absPath);
}

/** One language-server's state for `/doctor` (aggregated by the LSP layer).
 * `missing` = a candidate binary was never found for a language actually edited;
 * `crashed` = the server died and restart backoff gave up. */
export interface LspStatus {
  language: string;
  /** Resolved server command (absent when no candidate binary was found). */
  command?: string;
  state: "running" | "starting" | "idle" | "crashed" | "missing";
}

/**
 * The diagnostics seam the engine wires into edit/write via `ToolContext.diagnose`.
 * `diagnose(absPath)` returns a compact rendered error list to append verbatim to
 * the tool result, or undefined when the file is clean / diagnostics don't apply /
 * anything went wrong (always advisory — a failure NEVER reads as "clean"). The
 * TS fast path and the LSP layer both implement it; `status`/`dispose` are only
 * meaningful for the (server-spawning) LSP layer, so they're optional. */
export interface Diagnostics {
  diagnose(absPath: string): Promise<string | undefined>;
  /** Whether the layer is live (peer dep resolved / LSP enabled). */
  available(): Promise<boolean>;
  /** Per-language server status feeding `/doctor` (LSP-backed layers only). */
  status?(): LspStatus[];
  /** Tear down any spawned servers (LSP-backed layers only). */
  dispose?(): void;
}

let tsLoader: Promise<TsModule | null> | undefined;
function loadTs(): Promise<TsModule | null> {
  tsLoader ??= (async () => {
    try {
      // Non-literal specifier via a VARIABLE (a cast erases at transpile time and
      // `bun build --compile` would bundle the whole compiler into the binary).
      const specifier = "typescript";
      return (await import(specifier)) as unknown as TsModule;
    } catch {
      return null;
    }
  })();
  return tsLoader;
}

interface ServiceEntry {
  service: TsLanguageService;
  fileNames: Set<string>;
  versions: Map<string, number>;
  /** Force-added (not-in-tsconfig) files, in insertion order, for bounded LRU
   * eviction — the project's own fileNames never appear here. */
  forceAdded: string[];
  /** The tsconfig's raw text at build time — the cache is rebuilt when it changes. */
  configText: string | undefined;
}

/** File mtime in ms, or 0 when unstattable. Folded into the script version so a
 * dependency edited OUT-OF-BAND (a `bash` sed, not routed through `diagnose`)
 * still busts the service's cached snapshot instead of serving stale content. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Language-service diagnostics keyed by tsconfig. `diagnose(absPath)` returns a
 * compact rendered error list for that file, or undefined when TS is
 * unavailable, the file isn't TS/JS, or there are no errors — callers append it
 * verbatim to tool output.
 */
export class TsDiagnostics implements Diagnostics {
  #services = new Map<string, ServiceEntry>();
  #log: Logger | undefined;

  constructor(log?: Logger) {
    this.#log = log;
  }

  /** Whether diagnostics are live (the peer dep resolved). Probes lazily. */
  async available(): Promise<boolean> {
    return (await loadTs()) !== null;
  }

  async diagnose(absPath: string): Promise<string | undefined> {
    if (!TS_EXT.test(absPath)) return undefined;
    const ts = await loadTs();
    if (!ts) return undefined;
    try {
      const entry = this.#serviceFor(ts, absPath);
      if (!entry) return undefined;
      // A file WRITTEN after the service was first built (e.g. the model just
      // created it) isn't in the tsconfig's resolved fileNames yet — add it so
      // freshly-authored code is diagnosed too, instead of silently skipped.
      const inProject = entry.fileNames.has(absPath);
      if (!inProject) {
        entry.fileNames.add(absPath);
        // Track force-added files in insertion order and evict the oldest beyond
        // the cap, so a long-lived process editing thousands of out-of-project
        // files can't grow the root set unbounded. The project's own fileNames
        // are never in this list, so they're never evicted.
        entry.forceAdded.push(absPath);
        while (entry.forceAdded.length > MAX_FORCE_ADDED) {
          const evict = entry.forceAdded.shift()!;
          entry.fileNames.delete(evict);
          entry.versions.delete(evict);
        }
      }
      // Bump the version so the service re-reads the just-written file.
      entry.versions.set(absPath, (entry.versions.get(absPath) ?? 0) + 1);
      let diags = [
        ...entry.service.getSyntacticDiagnostics(absPath),
        ...entry.service.getSemanticDiagnostics(absPath),
      ];
      // A force-added file the tsconfig deliberately excludes (or that sits
      // outside rootDir) triggers "not part of the project" meta-diagnostics —
      // noise about project membership, not code correctness. Drop those for a
      // file that wasn't already in the project.
      if (!inProject) diags = diags.filter((d) => !PROJECT_MEMBERSHIP_CODES.has(d.code));
      if (!diags.length) return undefined;
      const lines = diags.slice(0, MAX_DIAGNOSTICS).map((d) => {
        const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if (d.file && d.start !== undefined) {
          const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
          return `  ${d.file.fileName}:${line + 1}:${character + 1} TS${d.code}: ${message}`;
        }
        return `  TS${d.code}: ${message}`;
      });
      const more = diags.length > MAX_DIAGNOSTICS ? `\n  …(${diags.length - MAX_DIAGNOSTICS} more)` : "";
      return `TypeScript diagnostics (fix before moving on):\n${lines.join("\n")}${more}`;
    } catch (err) {
      // Diagnostics are an enhancement — a service failure must never fail an edit.
      this.#log?.debug(`diagnostics skipped: ${(err as Error).message}`);
      return undefined;
    }
  }

  #serviceFor(ts: TsModule, absPath: string): ServiceEntry | undefined {
    const configPath = ts.findConfigFile(dirname(absPath), ts.sys.fileExists, "tsconfig.json");
    if (!configPath) return undefined;
    // Rebuild when tsconfig.json changes (strict/paths/include edits): its own
    // path isn't a TS file, so nothing else invalidates the cache and diagnostics
    // would otherwise keep using stale compilerOptions/fileNames for the session.
    const configText = ts.sys.readFile(configPath);
    const cached = this.#services.get(configPath);
    if (cached && cached.configText === configText) return cached;

    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!raw.config) return undefined;
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath));
    const fileNames = new Set(parsed.fileNames);
    const versions = new Map<string, number>();

    const host = {
      getScriptFileNames: () => [...fileNames],
      // Version = the explicit `diagnose` bump COMBINED with the file's mtime, so
      // both a re-write through the tool and an out-of-band change are re-read.
      getScriptVersion: (f: string) => `${versions.get(f) ?? 0}:${mtimeOf(f)}`,
      getScriptSnapshot: (f: string) => {
        const content = ts.sys.readFile(f);
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => dirname(configPath),
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (o: unknown) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    const entry: ServiceEntry = { service: ts.createLanguageService(host), fileNames, versions, forceAdded: [], configText };
    this.#services.set(configPath, entry);
    return entry;
  }
}
