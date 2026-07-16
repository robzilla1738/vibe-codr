import type { LspConfig } from "@vibe/config";
import type { Logger } from "@vibe/shared";
import { type Diagnostics, isTsJs, type LspStatus, TsDiagnostics } from "../diagnostics.ts";
import { LspDiagnostics, type LspClientFactory } from "./manager.ts";
import type { WhichFn } from "./registry.ts";

/**
 * `CompositeDiagnostics` — the diagnostics seam the engine wires when
 * `config.lsp.enabled`. It routes by extension: TS/JS files take the existing
 * in-process `TsDiagnostics` fast path (cheaper than an LSP round-trip, and
 * `typescript` is already a dep); everything else goes to the multi-language
 * `LspDiagnostics`. `status`/`dispose` fold across both. The seam
 * (`diagnose(absPath) => Promise<string | undefined>`) is unchanged, so nothing
 * in the tools/prompt path changes.
 */
export interface CompositeDiagnosticsOverrides {
  /** Swap the TS fast path (tests). */
  ts?: Diagnostics;
  /** Swap the LSP layer (tests). */
  lsp?: Diagnostics;
  /** Forwarded to the default LspDiagnostics (tests). */
  which?: WhichFn;
  clientFactory?: LspClientFactory;
}

export class CompositeDiagnostics implements Diagnostics {
  #ts: Diagnostics;
  #lsp: Diagnostics;

  constructor(
    config: LspConfig,
    workspaceRoot: () => string,
    log?: Logger,
    overrides?: CompositeDiagnosticsOverrides,
  ) {
    this.#ts = overrides?.ts ?? new TsDiagnostics(log);
    this.#lsp =
      overrides?.lsp ??
      new LspDiagnostics({
        config,
        workspaceRoot,
        ...(log ? { log } : {}),
        ...(overrides?.which ? { which: overrides.which } : {}),
        ...(overrides?.clientFactory ? { clientFactory: overrides.clientFactory } : {}),
      });
  }

  diagnose(absPath: string): Promise<string | undefined> {
    return isTsJs(absPath) ? this.#ts.diagnose(absPath) : this.#lsp.diagnose(absPath);
  }

  async available(): Promise<boolean> {
    return (await this.#ts.available()) || (await this.#lsp.available());
  }

  status(): LspStatus[] {
    return [...(this.#ts.status?.() ?? []), ...(this.#lsp.status?.() ?? [])];
  }

  dispose(): void {
    this.#ts.dispose?.();
    this.#lsp.dispose?.();
  }
}
