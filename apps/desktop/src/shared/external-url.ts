/**
 * Canonical policy for URLs handed to the operating system's browser.
 * Model/tool output is untrusted: only HTTP(S) is accepted, and embedded
 * credentials are rejected because userinfo can visually disguise the host.
 */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
