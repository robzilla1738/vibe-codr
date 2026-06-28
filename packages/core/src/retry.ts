/**
 * Exponential-backoff retry for transient provider failures. The AI SDK retries
 * the streaming call itself (via `maxRetries`); this wraps the surrounding work
 * (model resolution, one-shot calls) and classifies what's worth retrying.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Override transient classification (defaults to {@link isTransientError}). */
  isTransient?: (err: unknown) => boolean;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Heuristically decide whether an error is a transient network/rate-limit issue. */
export function isTransientError(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; code?: string; name?: string; message?: string };
  const status = e?.status ?? e?.statusCode;
  if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) {
    return true;
  }
  const code = e?.code ?? "";
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(code)) {
    return true;
  }
  const text = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /timeout|temporarily|rate limit|overloaded|too many requests|fetch failed|network/.test(
    text,
  );
}

/**
 * Run `fn`, retrying on transient errors with exponential backoff (delay
 * doubles each attempt). Non-transient errors throw immediately. After
 * `maxAttempts` retries the last error is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isTransient = opts.isTransient ?? isTransientError;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts || !isTransient(err)) throw err;
      await sleep(opts.baseDelayMs * 2 ** attempt);
      attempt++;
    }
  }
}
