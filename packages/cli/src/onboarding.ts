import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { writeGlobalConfig, globalConfigPath, type Config } from "@vibe/config";
import type { ProviderRegistry, ModelInfo, ProviderCreateOptions } from "@vibe/providers";
import {
  PROVIDER_CHOICES,
  initialChoiceIndex,
  type ProviderChoice,
} from "./providers-catalog.ts";

export { PROVIDER_CHOICES, initialChoiceIndex, type ProviderChoice };

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
  /** Base URL for a bring-your-own OpenAI-compatible endpoint (the `custom` provider). */
  baseURL?: string;
  searchKey?: string;
}

/** Build the global-config patch from collected answers (pure, for testing). */
export function buildOnboardingPatch(
  answers: OnboardingAnswers,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: answers.model };
  if (answers.providerId && (answers.apiKey || answers.baseURL)) {
    patch.providers = {
      [answers.providerId]: {
        ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
        ...(answers.baseURL ? { baseURL: answers.baseURL } : {}),
      },
    };
  }
  if (answers.searchKey) {
    patch.search = { apiKey: answers.searchKey };
  }
  return patch;
}

// ───────────────────────────── presentation ──────────────────────────────

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
type RGB = [number, number, number];
// Mirror the TUI's default graphite palette (packages/tui/src/themes.ts): white
// #eeeeee is the chrome accent (pointer, caret, labels), violet #8b5cf6 is the
// one signature hue — the selected row's solid band and the wordmark sweep.
// Onboarding is screen one; the TUI is screen two — same color language.
const VIOLET: RGB = [139, 92, 246]; // themes.ts selBg/heading
const CHROME: RGB = [238, 238, 238]; // themes.ts accent/primary (white chrome)
const INK: RGB = [10, 10, 10]; // themes.ts selFg — dark text on the violet band
const OK: RGB = [52, 211, 153];
const WARN: RGB = [251, 191, 36]; // amber — a saved-but-incomplete setup

function fg(text: string, [r, g, b]: RGB): string {
  return useColor ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m` : text;
}
/** Solid selected-row band: violet background, dark text — the TUI's selBg/selFg. */
function band(text: string): string {
  const [br, bg2, bb] = VIOLET;
  const [fr, fgr, fb] = INK;
  return useColor
    ? `\x1b[48;2;${br};${bg2};${bb}m\x1b[38;2;${fr};${fgr};${fb}m${text}\x1b[39m\x1b[49m`
    : text;
}
function bold(text: string): string {
  return useColor ? `\x1b[1m${text}\x1b[22m` : text;
}
function dim(text: string): string {
  return useColor ? `\x1b[2m${text}\x1b[22m` : text;
}
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function visibleLen(s: string): number {
  return [...stripAnsi(s)].length;
}

/** Per-character horizontal gradient — gives the wordmark its sheen. */
function gradient(text: string, from: RGB, to: RGB): string {
  if (!useColor) return text;
  const chars = [...text];
  const last = Math.max(1, chars.length - 1);
  const body = chars
    .map((ch, i) => {
      const t = chars.length === 1 ? 0 : i / last;
      const r = Math.round(from[0] + (to[0] - from[0]) * t);
      const g = Math.round(from[1] + (to[1] - from[1]) * t);
      const b = Math.round(from[2] + (to[2] - from[2]) * t);
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    })
    .join("");
  return `${body}\x1b[39m`;
}

const cursor = {
  hide: () => useColor && stdout.write("\x1b[?25l"),
  show: () => useColor && stdout.write("\x1b[?25h"),
};

function banner(): string {
  const rule = gradient("─".repeat(52), CHROME, VIOLET);
  const wordmark = bold(gradient("◆ vibe-codr", CHROME, VIOLET));
  return [
    "",
    `  ${wordmark}`,
    `  ${dim("a model-agnostic coding agent for your terminal")}`,
    `  ${rule}`,
    "",
  ].join("\n");
}

/** A rounded box sized to its content; only the border is colored. */
function boxed(lines: string[], color: RGB): string {
  const width = Math.max(...lines.map(visibleLen));
  const bar = fg("│", color);
  const top = fg(`╭${"─".repeat(width + 2)}╮`, color);
  const bottom = fg(`╰${"─".repeat(width + 2)}╯`, color);
  const body = lines.map(
    (l) => `${bar} ${l}${" ".repeat(width - visibleLen(l))} ${bar}`,
  );
  return [top, ...body, bottom].join("\n");
}

// ─────────────────────────── interactive prims ───────────────────────────

interface Key {
  name?: string;
  ctrl?: boolean;
  str?: string;
}

/**
 * Drive a single full-screen-ish prompt: draw a frame, redraw it in place on
 * each keypress, and resolve when the handler calls `done`. Manages raw mode
 * and cursor visibility, and exits cleanly on Ctrl-C. Frames must end with a
 * newline; redraw works by moving up the previous frame's line count.
 */
function keyLoop<T>(
  draw: () => string,
  onKey: (key: Key, done: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve) => {
    emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    cursor.hide();

    let prevLines = 0;
    const render = () => {
      const frame = draw();
      if (prevLines) stdout.write(`\x1b[${prevLines}A`);
      stdout.write("\x1b[0J");
      stdout.write(frame);
      prevLines = (frame.match(/\n/g) ?? []).length;
    };

    let finished = false;
    const cleanup = () => {
      stdin.off("keypress", handler);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      cursor.show();
    };
    const done = (value: T) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };
    const handler = (str: string | undefined, key: Key | undefined) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        stdout.write(`\n${dim("Setup cancelled.")}\n`);
        process.exit(130);
      }
      onKey({ name: key?.name, ctrl: key?.ctrl, str }, done);
      if (!finished) render();
    };

    stdout.write("\n");
    render();
    stdin.on("keypress", handler);
  });
}

interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
  badge?: string;
}

/** Arrow-key single-select for a short list. */
function select<T>(
  title: string,
  items: SelectItem<T>[],
  initial = 0,
): Promise<T> {
  let idx = Math.min(Math.max(initial, 0), items.length - 1);
  // Window the list so a long menu (each row up to 2 lines with its hint) doesn't
  // draw a frame taller than the viewport — which the in-place `\x1b[{n}A` redraw
  // can't fully overwrite, spamming scrollback with a duplicated menu per keypress.
  const WINDOW = 8;
  const draw = () => {
    const start = Math.min(
      Math.max(0, idx - Math.floor(WINDOW / 2)),
      Math.max(0, items.length - WINDOW),
    );
    const rows = items.slice(start, start + WINDOW).map((it, i) => {
      const active = start + i === idx;
      // The active row is the TUI's violet selection band (solid bg, dark text).
      const head = active
        ? `${band(` ❯ ${it.label} `)}${it.badge ? ` ${it.badge}` : ""}`
        : `   ${it.label}${it.badge ? ` ${it.badge}` : ""}`;
      const hint = it.hint ? `\n    ${dim(it.hint)}` : "";
      return `${head}${hint}`;
    });
    const more =
      items.length > WINDOW ? `${dim(`  …${items.length} options (${idx + 1}/${items.length})`)}\n` : "";
    return (
      `${bold(title)}\n\n${rows.join("\n")}\n${more}\n` +
      `${dim("↑/↓ move · enter select · ctrl-c quit")}\n`
    );
  };
  return keyLoop<T>(draw, (k, done) => {
    if (k.name === "up" || k.name === "k") idx = (idx - 1 + items.length) % items.length;
    else if (k.name === "down" || k.name === "j") idx = (idx + 1) % items.length;
    else if (k.name === "return" || k.name === "enter") {
      const it = items[idx];
      if (it) done(it.value);
    } else if (k.str && /^[1-9]$/.test(k.str)) {
      // Map the digit to the Nth VISIBLE (windowed) row, not the Nth absolute
      // item: the menu scrolls and shows no numbers, so absolute indexing
      // silently selected an off-screen entry once the list scrolled.
      const start = Math.min(
        Math.max(0, idx - Math.floor(WINDOW / 2)),
        Math.max(0, items.length - WINDOW),
      );
      const n = start + Number(k.str) - 1;
      const it = n < start + WINDOW ? items[n] : undefined;
      if (it) {
        idx = n;
        done(it.value);
      }
    }
  });
}

/** Filterable, scrolling single-select — for long live model lists. */
function selectFiltered(
  title: string,
  all: string[],
  recommended?: string,
): Promise<string> {
  let query = "";
  let idx = recommended ? Math.max(0, all.indexOf(recommended)) : 0;
  const WINDOW = 8;
  const view = () =>
    query
      ? all.filter((m) => m.toLowerCase().includes(query.toLowerCase()))
      : all;

  const draw = () => {
    const list = view();
    if (idx >= list.length) idx = Math.max(0, list.length - 1);
    const start = Math.min(
      Math.max(0, idx - Math.floor(WINDOW / 2)),
      Math.max(0, list.length - WINDOW),
    );
    const slice = list.slice(start, start + WINDOW);
    const rows = slice.map((m, i) => {
      const real = start + i;
      const active = real === idx;
      const star = m === recommended ? fg(" ★", OK) : "";
      return active ? `${band(` ❯ ${m} `)}${star}` : `   ${m}${star}`;
    });
    const more =
      list.length > WINDOW
        ? dim(`  …${list.length} matches (${idx + 1}/${list.length})`)
        : "";
    const filter = query
      ? `${dim("filter:")} ${query}`
      : dim("type to filter…");
    return (
      `${bold(title)}\n${filter}\n\n${rows.join("\n") || dim("  (no matches)")}\n${more}\n\n` +
      `${dim("↑/↓ move · type to filter · enter select · ctrl-c quit")}\n`
    );
  };

  return keyLoop<string>(draw, (k, done) => {
    const list = view();
    if (k.name === "up") idx = Math.max(0, idx - 1);
    else if (k.name === "down") idx = Math.min(list.length - 1, idx + 1);
    else if (k.name === "return" || k.name === "enter") {
      const chosen = list[idx];
      if (chosen) done(chosen);
    } else if (k.name === "backspace") {
      query = query.slice(0, -1);
      idx = 0;
    } else if (k.str && k.str.length === 1 && !k.ctrl && k.str >= " ") {
      query += k.str;
      idx = 0;
    }
  });
}

interface InputOptions {
  mask?: boolean;
  def?: string;
  placeholder?: string;
  hint?: string;
}

/** An http(s) URL WITH a host — mirrors the config schema's `httpUrl`. `new URL`
 * alone accepts a scheme-less `localhost:1234` (protocol `localhost:`, empty host),
 * so onboarding must check the scheme + host itself before persisting. */
function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Single-line text input (optionally masked for secrets). */
function input(label: string, opts: InputOptions = {}): Promise<string> {
  let val = "";
  const draw = () => {
    const shown = opts.mask ? "•".repeat(val.length) : val;
    let field: string;
    if (val) field = shown;
    else if (opts.def) field = dim(`[${opts.def}]`);
    else field = dim(opts.placeholder ?? "");
    const hint = opts.hint ? `\n${dim(opts.hint)}` : "";
    return `${bold(label)}${hint}\n${fg("❯", CHROME)} ${field}\n`;
  };
  return keyLoop<string>(draw, (k, done) => {
    if (k.name === "return" || k.name === "enter") done(val.trim() || opts.def || "");
    else if (k.name === "backspace") val = val.slice(0, -1);
    else if (k.str && k.str.length === 1 && !k.ctrl && k.str >= " ") val += k.str;
  });
}

/** Braille spinner around an async task; no-op output when not a TTY. `deps.exit`
 * is injectable for tests. */
export async function withSpinner<T>(
  label: string,
  work: Promise<T>,
  deps: { exit?: (code: number) => void } = {},
): Promise<T> {
  if (!stdout.isTTY) return work;
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  cursor.hide();
  const timer = setInterval(() => {
    const frame = frames[i++ % frames.length] ?? "";
    stdout.write(`\r${fg(frame, CHROME)} ${dim(label)}   `);
  }, 80);
  // No keyLoop/raw mode is active during the awaited work, so Ctrl+C is a default
  // SIGINT that would kill the process with the cursor still hidden. Restore it
  // first (clear the spinner line + show the cursor), then exit.
  const onSigint = () => {
    clearInterval(timer);
    stdout.write("\r\x1b[0K");
    cursor.show();
    exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    return await work;
  } finally {
    process.removeListener("SIGINT", onSigint);
    clearInterval(timer);
    stdout.write("\r\x1b[0K");
    cursor.show();
  }
}

// ──────────────────────────────── flow ───────────────────────────────────

/** Let the user pick a model: fetch the live list when possible, else type one. */
async function chooseModel(
  registry: ProviderRegistry,
  choice: ProviderChoice,
  config: Config,
  apiKey: string | undefined,
): Promise<string> {
  const def = registry.get(choice.registryId);
  // A key in `opts` is enough for the cloud endpoint: the registry's baseURL
  // resolver swaps in the hosted URL (e.g. ollama.com) whenever a key is set.
  // With no freshly-entered key, resolve via the registry so token-file
  // providers (e.g. codex reusing ~/.codex/auth.json) and saved keys still list.
  let opts: ProviderCreateOptions = apiKey ? { apiKey } : {};
  if (!apiKey && def) {
    try {
      opts = registry.resolveAuth(choice.registryId, config);
    } catch {
      opts = {};
    }
  }
  let models: ModelInfo[] = [];
  if (def) {
    try {
      models = await withSpinner(
        `Fetching ${choice.label} models…`,
        def.listModels(opts),
      );
    } catch {
      models = [];
    }
  }

  if (models.length > 0) {
    const ids = models
      .map((m) => `${m.providerId}/${m.id}`)
      .sort((a, b) => a.localeCompare(b));
    stdout.write(`${fg("✓", OK)} ${dim(`${ids.length} models available`)}\n`);
    const recommended = ids.includes(choice.defaultModel)
      ? choice.defaultModel
      : undefined;
    return selectFiltered("Choose a model", ids, recommended);
  }

  // No live list (offline, local server down, or fetch failed): type one.
  const fallbackHint = choice.localKeyless
    ? `couldn't reach ${choice.label} — enter a model id (start its server first)`
    : "couldn't fetch the model list — enter a model id";
  const typed = await input("Model id", {
    def: choice.defaultModel || undefined,
    placeholder: choice.defaultModel || `${choice.registryId}/<model>`,
    hint: fallbackHint,
  });
  return typed || choice.defaultModel;
}

/**
 * Interactive first-run setup: a branded picker for the provider, a masked key
 * prompt (skipped when the key is already in the environment or the provider is
 * local/keyless), a live model picker, and an optional web-search key — all
 * persisted to the user-global config. No-ops (returns false) when stdin isn't
 * a TTY so non-interactive runs surface the normal auth error instead.
 */
export async function runOnboarding(
  config: Config,
  registry: ProviderRegistry,
): Promise<boolean> {
  if (!stdin.isTTY) return false;

  stdout.write(banner());

  // 1) Provider — preselect whichever key is already in the environment.
  // A provider can also be configured WITHOUT its menu env var — codex reads
  // ~/.codex/auth.json (or OPENAI_API_KEY), and a previously-saved config key
  // counts too — so badge those as detected as well (keyless providers are
  // "configured" by definition and excluded).
  const configuredIds = new Set(
    registry
      .list()
      .filter((d) => !d.auth.keyless && registry.isConfigured(d.id, config))
      .map((d) => d.id),
  );
  const items: SelectItem<ProviderChoice>[] = PROVIDER_CHOICES.map((c) => {
    const envDetected = Boolean(c.env && process.env[c.env] && !c.localKeyless);
    const authDetected =
      !envDetected &&
      !c.localKeyless &&
      !c.customEndpoint &&
      c.registryId !== "" &&
      configuredIds.has(c.registryId);
    const badge = envDetected
      ? fg(`✓ ${c.env} detected`, OK)
      : authDetected
        ? fg(c.registryId === "codex" ? "✓ codex login detected" : "✓ configured", OK)
        : c.localKeyless
          ? dim("local · no key")
          : "";
    return { label: c.label, value: c, hint: c.blurb, badge };
  });
  const choice = await select(
    "Which model provider?",
    items,
    initialChoiceIndex(PROVIDER_CHOICES, process.env, configuredIds),
  );

  // Custom OpenAI-compatible endpoint: a base URL + optional key + a model id.
  if (choice.customEndpoint) {
    // Re-prompt until the base URL is a real http(s) URL (or empty = skip). A
    // scheme-less `localhost:1234` parses as protocol `localhost:` with an EMPTY
    // host — it would pass a naive check, persist, show "all set", then fail every
    // request. Reject it here so the caller never writes a bricked config (the
    // schema also rejects it at write time; this makes the failure a friendly
    // re-prompt instead of a thrown ConfigError).
    let baseURL = "";
    for (;;) {
      baseURL = (
        await input("Base URL", {
          placeholder: "https://my-endpoint.example.com/v1",
          hint: "any OpenAI-compatible /v1 endpoint",
        })
      ).trim();
      if (!baseURL || isHttpUrl(baseURL)) break;
      stdout.write(
        `${fg("✗", WARN)} ${dim("Enter a full http(s) URL with a host, e.g. https://host:8080/v1")}\n`,
      );
    }
    if (!baseURL) {
      // The user skipped the endpoint — a key or model id is meaningless
      // without it, so persist nothing rather than a dangling `custom/…`
      // config the next launch can't use.
      stdout.write(
        `\n${dim("Skipped — run")} ${bold("vibe setup")} ${dim("anytime to configure the custom endpoint.")}\n\n`,
      );
      return true;
    }
    const apiKey =
      (await input("API key (optional)", { mask: true, placeholder: "Enter to skip" })).trim() ||
      undefined;
    // Re-prompt until the model id is non-empty: persisting `custom/` (an
    // empty id) would print "You're all set", then fail to resolve on the
    // very next launch.
    let modelId = "";
    for (;;) {
      modelId = (
        await input("Model id", { placeholder: "model-name", hint: "as the endpoint names it" })
      ).trim();
      if (modelId) break;
      stdout.write(
        `${fg("✗", WARN)} ${dim("A model id is required — the name your endpoint serves, e.g. llama-3.3-70b")}\n`,
      );
    }
    return persist(
      {
        model: `custom/${modelId}`,
        providerId: "custom",
        apiKey,
        baseURL,
      },
      // A custom OpenAI-compatible endpoint REQUIRES a base URL (the `custom`
      // provider throws "base URL required" without one); both it and a model
      // id are guaranteed non-empty above, so this really is "all set".
      { configured: true },
    );
  }

  // Other / advanced: the user supplies the whole model string; derive the provider.
  if (choice.registryId === "" || choice.key === "custom") {
    // Re-prompt until non-empty: persisting `model: ""` would neither run nor
    // re-trigger onboarding (needsOnboarding can't derive a provider from ""),
    // soft-bricking plain `vibecodr` until the user finds `vibe setup`.
    let model = "";
    for (;;) {
      model = (
        await input("Model string", {
          placeholder: "provider/model-id",
          hint: "e.g. anthropic/claude-opus-4-8 or zai/glm-5.2",
        })
      ).trim();
      if (model) break;
      stdout.write(
        `${fg("✗", WARN)} ${dim("A model string is required — provider/model-id, e.g. anthropic/claude-opus-4-8")}\n`,
      );
    }
    const providerId = model.split("/")[0] ?? "";
    const def = registry.get(providerId);
    let apiKey: string | undefined;
    if (def && !def.auth.keyless && !registry.isConfigured(providerId, config)) {
      apiKey =
        (await input(`${providerId} API key`, { mask: true })).trim() ||
        undefined;
    }
    // Usable if keyless, already-configured (env/saved), or a key was provided;
    // otherwise (key required + skipped) don't print a false "all set".
    const configured =
      Boolean(def?.auth.keyless) || registry.isConfigured(providerId, config) || Boolean(apiKey);
    return persist({ model, providerId, apiKey }, { configured });
  }

  // 2) Key — skip for local/keyless and whenever the provider is ALREADY
  // configured: an env var, a previously-saved key, OR a reusable token file
  // another CLI wrote (e.g. codex's ~/.codex/auth.json). isConfigured() covers
  // all three, so a `codex login` session needs no key prompt here.
  let apiKey: string | undefined;
  const envKey = choice.env ? process.env[choice.env] : undefined;
  if (choice.localKeyless) {
    if (choice.note) stdout.write(`${dim(`note: ${choice.note}`)}\n`);
  } else if (registry.isConfigured(choice.registryId, config)) {
    const how = envKey
      ? `${bold(choice.env ?? "")} from your environment`
      : choice.registryId === "codex"
        ? "your Codex/ChatGPT session (~/.codex/auth.json)"
        : "your saved credentials";
    stdout.write(`${fg("✓", OK)} Using ${how}\n`);
  } else {
    if (choice.note) stdout.write(`${dim(`note: ${choice.note}`)}\n`);
    const link = choice.keyUrl ? `get one at ${choice.keyUrl}` : undefined;
    apiKey =
      (
        await input(`${choice.label} API key`, {
          mask: true,
          hint: link,
          placeholder: "paste your key (Enter to skip)",
        })
      ).trim() || undefined;
  }

  // 3) Model — live picker (uses the key/env/token so cloud + local both list).
  const model = await chooseModel(registry, choice, config, apiKey ?? envKey);

  // 4) Optional web search.
  let searchKey: string | undefined;
  if (!process.env.TINYFISH_API_KEY) {
    searchKey =
      (
        await input("Web-search key (optional)", {
          mask: true,
          hint: "TinyFish — free at agent.tinyfish.ai · Enter to skip",
          placeholder: "Enter to skip",
        })
      ).trim() || undefined;
  }

  // Whether the provider will actually be USABLE after this: a keyless local
  // provider, an already-configured one (env/saved/token), or one we just got a
  // key for. If the user SKIPPED a required key, the provider stays unconfigured
  // and we must not claim "all set" (which sends them into a re-onboarding loop
  // with a false confirmation).
  const configured =
    Boolean(choice.localKeyless) || registry.isConfigured(choice.registryId, config) || Boolean(apiKey);
  return persist({ model, providerId: choice.registryId, apiKey, searchKey }, { configured });
}

/** Write the config patch and print a tidy confirmation. */
async function persist(answers: OnboardingAnswers, opts: { configured?: boolean } = {}): Promise<boolean> {
  await writeGlobalConfig(buildOnboardingPatch(answers));
  if (opts.configured === false) {
    // The model was saved, but the provider has no usable credential — be honest
    // so the user knows why the next launch re-prompts, instead of "You're all set".
    const summary = boxed(
      [
        `${fg("!", WARN)} ${bold("Almost there — no API key set")}`,
        "",
        `${dim("model")}   ${fg(answers.model, VIOLET)}`,
        `${dim("config")}  ${globalConfigPath()}`,
        "",
        `${dim("next")}    run ${bold("vibe setup")} again and paste a key, or set the provider's API-key env var`,
      ],
      VIOLET,
    );
    stdout.write(`\n${summary}\n\n`);
    return true;
  }
  const summary = boxed(
    [
      `${fg("✓", OK)} ${bold("You're all set")}`,
      "",
      `${dim("model")}   ${fg(answers.model, VIOLET)}`,
      `${dim("config")}  ${globalConfigPath()}`,
      "",
      `${dim("try")}     vibe ${dim("·")} vibe -p ${dim('"summarize this repo"')}`,
    ],
    VIOLET,
  );
  stdout.write(`\n${summary}\n\n`);
  return true;
}
