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
  searchKey?: string;
}

/** Build the global-config patch from collected answers (pure, for testing). */
export function buildOnboardingPatch(
  answers: OnboardingAnswers,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: answers.model };
  if (answers.apiKey && answers.providerId) {
    patch.providers = { [answers.providerId]: { apiKey: answers.apiKey } };
  }
  if (answers.searchKey) {
    patch.search = { apiKey: answers.searchKey };
  }
  return patch;
}

// ───────────────────────────── presentation ──────────────────────────────

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
type RGB = [number, number, number];
const BRAND_A: RGB = [138, 92, 246]; // violet
const BRAND_B: RGB = [34, 211, 238]; // cyan
const ACCENT: RGB = [124, 161, 255];
const OK: RGB = [52, 211, 153];

function fg(text: string, [r, g, b]: RGB): string {
  return useColor ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m` : text;
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
  const rule = gradient("─".repeat(52), BRAND_A, BRAND_B);
  const wordmark = bold(gradient("◆ vibe-codr", BRAND_A, BRAND_B));
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
  const draw = () => {
    const rows = items.map((it, i) => {
      const active = i === idx;
      const pointer = active ? fg("❯", ACCENT) : " ";
      const label = active ? bold(fg(it.label, ACCENT)) : it.label;
      const badge = it.badge ? ` ${it.badge}` : "";
      const head = `${pointer} ${label}${badge}`;
      const hint = it.hint ? `\n    ${dim(it.hint)}` : "";
      return `${head}${hint}`;
    });
    return (
      `${bold(title)}\n\n${rows.join("\n")}\n\n` +
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
      const n = Number(k.str) - 1;
      const it = items[n];
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
      return active
        ? `${fg("❯", ACCENT)} ${bold(fg(m, ACCENT))}${star}`
        : `  ${m}${star}`;
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
    return `${bold(label)}${hint}\n${fg("❯", ACCENT)} ${field}\n`;
  };
  return keyLoop<string>(draw, (k, done) => {
    if (k.name === "return" || k.name === "enter") done(val.trim() || opts.def || "");
    else if (k.name === "backspace") val = val.slice(0, -1);
    else if (k.str && k.str.length === 1 && !k.ctrl && k.str >= " ") val += k.str;
  });
}

/** Braille spinner around an async task; no-op output when not a TTY. */
async function withSpinner<T>(label: string, work: Promise<T>): Promise<T> {
  if (!stdout.isTTY) return work;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  cursor.hide();
  const timer = setInterval(() => {
    const frame = frames[i++ % frames.length] ?? "";
    stdout.write(`\r${fg(frame, ACCENT)} ${dim(label)}   `);
  }, 80);
  try {
    return await work;
  } finally {
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
  apiKey: string | undefined,
): Promise<string> {
  const def = registry.get(choice.registryId);
  // A key in `opts` is enough for the cloud endpoint: the registry's baseURL
  // resolver swaps in the hosted URL (e.g. ollama.com) whenever a key is set.
  const opts: ProviderCreateOptions = apiKey ? { apiKey } : {};
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
  const items: SelectItem<ProviderChoice>[] = PROVIDER_CHOICES.map((c) => {
    const detected = c.env && process.env[c.env] && !c.localKeyless;
    const badge = detected
      ? fg(`✓ ${c.env} detected`, OK)
      : c.localKeyless
        ? dim("local · no key")
        : "";
    return { label: c.label, value: c, hint: c.blurb, badge };
  });
  const choice = await select(
    "Which model provider?",
    items,
    initialChoiceIndex(PROVIDER_CHOICES, process.env),
  );

  // Custom: the user supplies the whole model string; derive the provider.
  if (choice.registryId === "" || choice.key === "custom") {
    const model = await input("Model string", {
      placeholder: "provider/model-id",
      hint: "e.g. anthropic/claude-opus-4-8 or ollama/gpt-oss:120b-cloud",
    });
    const providerId = model.split("/")[0] ?? "";
    const def = registry.get(providerId);
    let apiKey: string | undefined;
    if (def && !def.auth.keyless && !registry.isConfigured(providerId, config)) {
      apiKey =
        (await input(`${providerId} API key`, { mask: true })).trim() ||
        undefined;
    }
    return persist({ model, providerId, apiKey });
  }

  // 2) Key — skip for local/keyless and when already in the environment.
  let apiKey: string | undefined;
  const envKey = choice.env ? process.env[choice.env] : undefined;
  if (choice.localKeyless) {
    if (choice.note) stdout.write(`${dim(`note: ${choice.note}`)}\n`);
  } else if (envKey) {
    stdout.write(`${fg("✓", OK)} Using ${bold(choice.env ?? "")} from your environment\n`);
  } else {
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

  // 3) Model — live picker (uses the key/env so cloud + local both list).
  const model = await chooseModel(registry, choice, apiKey ?? envKey);

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

  return persist({ model, providerId: choice.registryId, apiKey, searchKey });
}

/** Write the config patch and print a tidy confirmation. */
async function persist(answers: OnboardingAnswers): Promise<boolean> {
  await writeGlobalConfig(buildOnboardingPatch(answers));
  const summary = boxed(
    [
      `${fg("✓", OK)} ${bold("You're all set")}`,
      "",
      `${dim("model")}   ${fg(answers.model, ACCENT)}`,
      `${dim("config")}  ${globalConfigPath()}`,
      "",
      `${dim("try")}     vibe ${dim("·")} vibe -p ${dim('"summarize this repo"')}`,
    ],
    BRAND_A,
  );
  stdout.write(`\n${summary}\n\n`);
  return true;
}
