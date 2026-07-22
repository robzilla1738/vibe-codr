import { safeExternalUrl } from "./external-url";

const EXTERNAL_HOST_MARKERS = [
  "accounts.", "auth.", "login.", "oauth.", "checkout.", "billing.",
  "stripe.com", "paypal.com", "github.com/login", "google.com/o/oauth",
];

export type LinkDisposition = "embedded" | "external" | "reject";

export function linkDisposition(
  rawUrl: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; button?: number } = {},
): LinkDisposition {
  const safe = safeExternalUrl(rawUrl);
  if (!safe) return "reject";
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.button === 1) return "external";
  const normalized = safe.toLowerCase();
  return EXTERNAL_HOST_MARKERS.some((marker) => normalized.includes(marker))
    ? "external"
    : "embedded";
}
