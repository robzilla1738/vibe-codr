import { hydrateFromHistory } from "../shared/history-hydrate";
import type { EngineSnapshot } from "../shared/types";
import {
  loadTranscriptCache,
  transcriptConversationSignature,
} from "./transcript-cache";

/** One authoritative hydration path for bootstrap, reconnect, and resync. */
export async function transcriptForSnapshot(
  cwd: string,
  snapshot: EngineSnapshot,
): Promise<ReturnType<typeof hydrateFromHistory>> {
  const hydrated = hydrateFromHistory(snapshot.history ?? []);
  if (!snapshot.history?.length) return hydrated;
  const cached = await loadTranscriptCache(cwd, snapshot.sessionId);
  return cached
    && transcriptConversationSignature(cached) === transcriptConversationSignature(hydrated)
    ? cached
    : hydrated;
}
