import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { ComposerAttachment } from "../composer/Composer";

const MAX_RETAINED_COMPOSERS = 24;
const MAX_INPUT_HISTORY = 100;

export interface SessionComposerState {
  draft: string;
  attachments: ComposerAttachment[];
  history: string[];
}

const EMPTY_COMPOSER: SessionComposerState = { draft: "", attachments: [], history: [] };

function releaseAttachments(attachments: readonly ComposerAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function updateSessionComposerStates<K extends keyof SessionComposerState>(
  current: ReadonlyMap<string, SessionComposerState>,
  key: string,
  field: K,
  value: SetStateAction<SessionComposerState[K]>,
  options: {
    maxEntries?: number;
    release?: (attachments: readonly ComposerAttachment[]) => void;
  } = {},
): Map<string, SessionComposerState> {
  const previous = current.get(key) ?? EMPTY_COMPOSER;
  const nextValue = typeof value === "function"
    ? (value as (previous: SessionComposerState[K]) => SessionComposerState[K])(previous[field])
    : value;
  if (Object.is(previous[field], nextValue)) return current as Map<string, SessionComposerState>;
  const next = new Map(current);
  next.delete(key);
  next.set(key, { ...previous, [field]: nextValue });
  const maxEntries = options.maxEntries ?? MAX_RETAINED_COMPOSERS;
  while (next.size > maxEntries) {
    const oldest = next.keys().next().value as string | undefined;
    if (!oldest) break;
    const evicted = next.get(oldest);
    if (evicted) (options.release ?? releaseAttachments)(evicted.attachments);
    next.delete(oldest);
  }
  return next;
}

/**
 * Composer content belongs to a session, not to the application window. This
 * hook keeps a small in-memory LRU so switching projects/sessions cannot carry a
 * half-written prompt or Finder drop into another conversation.
 */
export function useSessionComposerState(contextKey: string | null): {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  attachments: ComposerAttachment[];
  setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
  history: string[];
  recordHistory: (value: string) => void;
} {
  const [states, setStates] = useState<Map<string, SessionComposerState>>(() => new Map());
  const statesRef = useRef(states);
  const contextKeyRef = useRef(contextKey);
  statesRef.current = states;
  contextKeyRef.current = contextKey;

  const update = useCallback(
    <K extends keyof SessionComposerState>(
      field: K,
      value: SetStateAction<SessionComposerState[K]>,
    ) => {
      const key = contextKeyRef.current;
      if (!key) return;
      setStates((current) => updateSessionComposerStates(current, key, field, value));
    },
    [],
  );

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => update("draft", value),
    [update],
  );
  const setAttachments = useCallback<Dispatch<SetStateAction<ComposerAttachment[]>>>(
    (value) => update("attachments", value),
    [update],
  );
  const recordHistory = useCallback((value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    update("history", (current) => {
      const withoutDuplicate = current.filter((entry) => entry !== normalized);
      return [...withoutDuplicate, normalized].slice(-MAX_INPUT_HISTORY);
    });
  }, [update]);

  useEffect(() => () => {
    for (const state of statesRef.current.values()) releaseAttachments(state.attachments);
  }, []);

  const active = contextKey ? states.get(contextKey) ?? EMPTY_COMPOSER : EMPTY_COMPOSER;
  return {
    draft: active.draft,
    setDraft,
    attachments: active.attachments,
    setAttachments,
    history: active.history,
    recordHistory,
  };
}
