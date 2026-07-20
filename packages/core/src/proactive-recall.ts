/**
 * Helpers for session-start proactive memory recall.
 *
 * The first user prompt is often path-heavy ("/Users/…/Screenshot …png make a
 * site like these images"). Seeding hybrid search with that raw string floods
 * the query with date/path tokens and attaches "make/website" to every prior
 * website digest — which is how unrelated notes get labeled RELEVANT and hijack
 * the turn. Clean the seed down to natural-language intent before search.
 */

import { queryTerms } from "./bm25.ts";

/** Image-ish / screenshot filename fragments that pollute BM25 when left in. */
const PATH_NOISE =
  /\b(?:screenshot|screen\s*shot|img|image|photo|pic|desktop|downloads|documents|users|home|var|tmp|private)\b/gi;

/** Absolute, home, or clearly filesystem path runs (incl. shell `\ ` escapes). */
const FS_PATH_RUN = /(?:^|[\s"'`])((?:\/|~\/|[A-Za-z]:\\)(?:\\ |\\[^ ]|[^\s"'`\\])+)/g;

/** Bare URL — never useful as a memory seed token. */
const URL_RUN = /\bhttps?:\/\/[^\s"'`]+/gi;

/** Numeric date/time crumbs left after path stripping (2026, 07, 09, 5.04.46…). */
const DATE_CRUMB =
  /\b(?:20\d{2}|0?\d{1,2}[./-]0?\d{1,2}(?:[./-]20\d{2})?|\d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:\s*[ap]m)?)\b/gi;

/** Trailing image extensions after a path was partially stripped. */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|heic|tiff?)\b/gi;

/**
 * Strip filesystem paths, URLs, screenshot/date noise from a first-turn prompt
 * so proactive recall keys on the user's intent, not path tokens.
 */
export function cleanProactiveRecallSeed(goal: string | null | undefined, prompt: string): string {
  let text = prompt ?? "";
  // Shell-escaped spaces → real spaces so path runs match as one token stream.
  text = text.replace(/\\ /g, " ");
  text = text.replace(URL_RUN, " ");
  text = text.replace(FS_PATH_RUN, " ");
  // Relative image filenames that survived path strip (foo.png, Screenshot x.png).
  text = text.replace(
    /(?:^|[\s])((?:[\w.-]+\s+)*[\w.-]+\.(?:png|jpe?g|gif|webp|bmp|svg|heic|tiff?))\b/gi,
    " ",
  );
  text = text.replace(IMAGE_EXT, " ");
  text = text.replace(PATH_NOISE, " ");
  text = text.replace(DATE_CRUMB, " ");
  // Collapse whitespace + trim.
  text = text.replace(/\s+/g, " ").trim();

  const parts = [goal?.trim(), text].filter((p): p is string => Boolean(p?.length));
  const seed = parts.join(" ").slice(0, 500).trim();
  return seed;
}

/** Durable, content-light state for the bounded proactive-recall controller. */
export interface ProactiveRecallSnapshot {
  userTurns: number;
  attempts: number;
  recalls: number;
  lastAttemptTurn?: number;
  lastTopicTerms?: string[];
}

export interface ProactiveRecallDecision {
  attempt: boolean;
  /** Clean goal + prompt used only when this turn is eligible for a search. */
  seed?: string;
}

const MAX_PROACTIVE_RECALLS = 3;
// A recall at user turn 1 may next run at turn 5: turns 2, 3, and 4 are fully
// between the two attempts.
const MIN_RECALL_TURN_DELTA = 4;
const TOPIC_SHIFT_MAX_JACCARD = 0.25;

function boundedInt(value: unknown, max: number): number {
  return Math.min(max, Math.max(0, Number.isFinite(value) ? Math.trunc(value as number) : 0));
}

function normalizedTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())),
  ]
    .filter((v) => /^[a-z0-9]{2,64}$/.test(v))
    .slice(0, 64);
}

/** Lexical topic shift: intentionally no embedding request on ordinary turns. */
export function isProactiveTopicShift(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  const a = new Set(previous);
  const b = new Set(next);
  if (b.size < 2) return false;
  if (!a.size) return true;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 && intersection / union <= TOPIC_SHIFT_MAX_JACCARD;
}

/**
 * Pure state machine for proactive recall. Only real user-origin prompts advance
 * its clock. Searches are capped as well as successful injections, preventing a
 * stream of irrelevant topic shifts from spending an embedding call every turn.
 */
export class ProactiveRecallController {
  #userTurns = 0;
  #attempts = 0;
  #recalls = 0;
  #lastAttemptTurn: number | undefined;
  #lastTopicTerms: string[] = [];
  #pendingOutcome = false;

  constructor(initial?: ProactiveRecallSnapshot) {
    if (initial) this.restore(initial);
  }

  /** Legacy resumes persisted only the injected block, not controller state. */
  static fromLegacy(userTurns: number, recalled: boolean): ProactiveRecallController {
    return new ProactiveRecallController({
      userTurns: Math.max(0, Math.trunc(userTurns)),
      attempts: recalled ? 1 : 0,
      recalls: recalled ? 1 : 0,
      ...(recalled ? { lastAttemptTurn: 1 } : {}),
    });
  }

  consider(
    origin: "user" | "engine",
    goal: string | null | undefined,
    prompt: string,
  ): ProactiveRecallDecision {
    if (origin !== "user") return { attempt: false };
    this.#userTurns++;
    this.#pendingOutcome = false;

    const seed = cleanProactiveRecallSeed(goal, prompt);
    if (!seed.trim() || this.#attempts >= MAX_PROACTIVE_RECALLS) return { attempt: false };

    const promptOnly = cleanProactiveRecallSeed(null, prompt);
    const nextTerms = queryTerms(promptOnly);
    if (this.#attempts > 0) {
      const last = this.#lastAttemptTurn ?? 0;
      if (this.#userTurns - last < MIN_RECALL_TURN_DELTA) return { attempt: false };
      if (!isProactiveTopicShift(this.#lastTopicTerms, nextTerms)) return { attempt: false };
    }

    this.#attempts++;
    this.#lastAttemptTurn = this.#userTurns;
    this.#lastTopicTerms = nextTerms.slice(0, 64);
    this.#pendingOutcome = true;
    return { attempt: true, seed };
  }

  /** Record that the most recent eligible search actually injected context. */
  recordRecall(): void {
    if (!this.#pendingOutcome) return;
    this.#recalls = Math.min(MAX_PROACTIVE_RECALLS, this.#recalls + 1);
    this.#pendingOutcome = false;
  }

  snapshot(): ProactiveRecallSnapshot {
    return {
      userTurns: this.#userTurns,
      attempts: this.#attempts,
      recalls: this.#recalls,
      ...(this.#lastAttemptTurn !== undefined ? { lastAttemptTurn: this.#lastAttemptTurn } : {}),
      ...(this.#lastTopicTerms.length ? { lastTopicTerms: [...this.#lastTopicTerms] } : {}),
    };
  }

  restore(snapshot: ProactiveRecallSnapshot): void {
    this.#userTurns = boundedInt(snapshot.userTurns, Number.MAX_SAFE_INTEGER);
    this.#attempts = boundedInt(snapshot.attempts, MAX_PROACTIVE_RECALLS);
    this.#recalls = Math.min(this.#attempts, boundedInt(snapshot.recalls, MAX_PROACTIVE_RECALLS));
    const last = boundedInt(snapshot.lastAttemptTurn, this.#userTurns);
    this.#lastAttemptTurn = last > 0 ? last : undefined;
    this.#lastTopicTerms = normalizedTerms(snapshot.lastTopicTerms);
    this.#pendingOutcome = false;
  }
}
