/**
 * The engine appends vision-relay captions to the prompt it sends downstream.
 * Those captions are useful model context, but they are transport metadata and
 * should never become part of the user's visible message in the app.
 */
const RELAY_BLOCK = /\n{1,2}--- image: [^\n]+ \((?:vision relay description|relay degraded)\) ---[\s\S]*$/;

export function stripVisionRelayContext(text: string): string {
  const clean = text.replace(RELAY_BLOCK, "").trimEnd();
  return clean || text.trim();
}
