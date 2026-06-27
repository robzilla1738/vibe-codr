import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeGlobalConfig, globalConfigPath, type Config } from "@vibe/config";
import type { ProviderRegistry } from "@vibe/providers";

/**
 * Whether first-run setup is needed: the configured model's provider has no
 * usable credentials (and isn't keyless), so a real run would fail with an
 * auth error. Keyless providers (e.g. LM Studio) never need onboarding.
 */
export function needsOnboarding(
  config: Config,
  registry: ProviderRegistry,
): boolean {
  const providerId = config.model.split("/")[0] ?? "";
  const def = registry.get(providerId);
  if (!def || def.auth.keyless) return false;
  return !registry.isConfigured(providerId, config);
}

export interface OnboardingAnswers {
  model: string;
  providerId: string;
  apiKey?: string;
  searchKey?: string;
}

/** Build the global-config patch from collected answers (pure, for testing). */
export function buildOnboardingPatch(
  answers: OnboardingAnswers,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: answers.model };
  if (answers.apiKey) {
    patch.providers = { [answers.providerId]: { apiKey: answers.apiKey } };
  }
  if (answers.searchKey) {
    patch.search = { apiKey: answers.searchKey };
  }
  return patch;
}

/**
 * Ask a question without echoing the typed answer (for secrets). Mutes stdout
 * while the user types, then restores it. Always restores, even on error.
 */
async function askSecret(
  rl: readline.Interface,
  query: string,
): Promise<string> {
  stdout.write(query);
  const original = stdout.write.bind(stdout);
  // Swallow the keystroke echo readline would otherwise write to stdout.
  (stdout as { write: unknown }).write = () => true;
  try {
    return (await rl.question("")).trim();
  } finally {
    (stdout as { write: typeof original }).write = original;
    original("\n");
  }
}

/**
 * Interactive first-run setup. Captures the model, its provider key, and an
 * optional TinyFish web-search key, then persists them to the user-global
 * config. No-ops (returns false) when stdin isn't a TTY so non-interactive
 * runs surface the normal auth error instead of hanging on a prompt.
 */
export async function runOnboarding(
  config: Config,
  registry: ProviderRegistry,
): Promise<boolean> {
  if (!stdin.isTTY) return false;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "\nWelcome to vibecodr — let's get you set up.\n" +
        "Keys are saved to " +
        globalConfigPath() +
        " (used across projects).\n\n",
    );

    const model =
      (await rl.question(`Model to use [${config.model}]: `)).trim() ||
      config.model;
    const providerId = model.split("/")[0] ?? "";
    const def = registry.get(providerId);
    const envHint = def?.auth.env[0] ? ` (or set $${def.auth.env[0]})` : "";

    let apiKey: string | undefined;
    if (def && !def.auth.keyless) {
      apiKey = (await askSecret(rl, `${providerId} API key${envHint}: `)) || undefined;
    }

    const searchKey =
      (await askSecret(
        rl,
        "TinyFish web-search key — free at agent.tinyfish.ai, optional: ",
      )) || undefined;

    await writeGlobalConfig(
      buildOnboardingPatch({ model, providerId, apiKey, searchKey }),
    );
    stdout.write(`\nSaved. Starting vibecodr…\n\n`);
    return true;
  } finally {
    rl.close();
  }
}
