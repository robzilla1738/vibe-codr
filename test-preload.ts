/**
 * Bun test preload (see bunfig.toml `[test] preload`). Runs once before any test.
 *
 * Isolates the user-global config for the whole test run so tests that persist
 * settings — `/model`, `/model sub`, `/model key`, `/accent`, `/theme`,
 * `/reasoning` — never overwrite the developer's real
 * `~/.config/vibe-codr/config.json`.
 *
 * It MUST use `XDG_CONFIG_HOME`, not `HOME`: Bun's `os.homedir()` caches at
 * startup and ignores a runtime `process.env.HOME`, so setting HOME here would do
 * nothing. `globalConfigPath()` reads `XDG_CONFIG_HOME` on every call, so this
 * redirect actually takes effect. Individual tests may override it further.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "vibe-test-xdg-"));
// Config (writeGlobalConfig) and the models.dev cache both live under XDG dirs;
// isolate both so the suite never touches the developer's real files.
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
// Per-project machine state (sessions, plans, checkpoints, offload artifacts)
// lives under ~/.vibe/state — isolate it too so engine/session tests never
// write into the developer's real state dir. Individual test files may still
// override with their own temp root.
process.env.VIBE_STATE_DIR = join(root, "state");
