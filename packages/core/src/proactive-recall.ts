/**
 * Helpers for session-start proactive memory recall.
 *
 * The first user prompt is often path-heavy ("/Users/…/Screenshot …png make a
 * site like these images"). Seeding hybrid search with that raw string floods
 * the query with date/path tokens and attaches "make/website" to every prior
 * website digest — which is how unrelated notes get labeled RELEVANT and hijack
 * the turn. Clean the seed down to natural-language intent before search.
 */

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
