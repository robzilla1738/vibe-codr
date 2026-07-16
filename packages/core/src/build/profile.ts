import type { RepoProfile } from "@vibe/shared";
import { bunExec } from "./exec.ts";
import { reconRepo } from "./codeintel.ts";
import { commandsHash, loadLedger, manifestHash, mergeConfirmedCommands } from "./ledger.ts";

/**
 * The recon → ledger → profile pipeline the engine runs once at bootstrap:
 * probe the working directory, then fill any command recon missed from the
 * cross-run ledger (a prior session's confirmed-green commands). Never throws;
 * the worst case is an empty profile.
 */
export async function resolveRepoProfile(
  cwd: string,
  opts: { ledger?: boolean; signal?: AbortSignal } = {},
): Promise<{ profile: RepoProfile; ledgerFilled: string[] }> {
  const profile = await reconRepo(bunExec(), cwd, opts.signal);
  if (opts.ledger === false || profile.greenfield) return { profile, ledgerFilled: [] };
  const hashes = {
    manifestHash: manifestHash({
      commands: profile.commands,
      manifestFiles: profile.manifestFiles,
      packageManager: profile.packageManager,
      primaryLanguage: profile.primaryLanguage,
    }),
    commandsHash: commandsHash(profile.commands),
  };
  const confirmed = loadLedger(cwd, hashes);
  if (!confirmed) return { profile, ledgerFilled: [] };
  const { commands, filled } = mergeConfirmedCommands(profile.commands, confirmed.commands);
  const conventions = [...new Set([...profile.conventions, ...confirmed.conventions])];
  return { profile: { ...profile, commands, conventions }, ledgerFilled: filled };
}

/**
 * Render the profile as the system-prompt "REPO FACTS" block. Deterministic
 * recon output, injected so no agent in the tree ever guesses how to build —
 * kept terse because it rides every prompt.
 */
export function formatRepoFacts(profile: RepoProfile): string | undefined {
  if (profile.greenfield) {
    return (
      "REPO FACTS (deterministic recon): the working directory is effectively empty (greenfield). " +
      "If you scaffold a project, establish a build + test command early — they become the verification gate."
    );
  }
  const bits: string[] = [];
  if (profile.primaryLanguage) bits.push(profile.primaryLanguage);
  if (profile.framework) bits.push(profile.framework);
  if (profile.packageManager) bits.push(`pkg manager: ${profile.packageManager}`);
  if (profile.monorepo.tool) bits.push(`monorepo: ${profile.monorepo.tool}`);
  const cmds = Object.entries(profile.commands)
    .map(([k, v]) => `${k}=\`${v}\``)
    .join("  ");
  const lines: string[] = [];
  lines.push(`REPO FACTS (deterministic recon${bits.length ? ` — ${bits.join(", ")}` : ""}):`);
  if (cmds) {
    lines.push(
      `This repo's REAL commands: ${cmds}`,
      "Use `run_check` to run them (compact PASS/FAIL verdicts) — never invent or guess a build/test command.",
    );
  } else {
    lines.push("No build/test commands were detected — say so honestly rather than inventing one.");
  }
  if (profile.conventions.length) lines.push(`Conventions: ${profile.conventions.join("; ")}.`);
  return lines.join("\n");
}
