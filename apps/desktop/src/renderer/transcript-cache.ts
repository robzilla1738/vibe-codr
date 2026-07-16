import { estimateJsonUtf8Bytes } from "../shared/json-size";
import {
  type Block,
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  type TranscriptState,
} from "../shared/reducer";

const DATABASE = "vibe-codr-presentation";
const STORE = "transcripts";
const VERSION = 2;
const MAX_ENTRIES = 20;
const MAX_SERIALIZED_CHARS = 32 * 1024 * 1024;
const MAX_TOTAL_SERIALIZED_CHARS = 96 * 1024 * 1024;

interface CacheRecord {
  key: string;
  savedAt: number;
  signature: string;
  state: string;
  size?: number;
}

function keyFor(cwd: string, sessionId: string): string {
  return `${cwd}\u0000${sessionId}`;
}

export function transcriptCacheKeyBelongsToCwd(key: string, cwd: string): boolean {
  return key.startsWith(`${cwd}\u0000`);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        // A blocked upgrade can later succeed after the caller has already
        // fallen back to no cache. Close that unowned late handle immediately.
        if (db) closeDatabase(db);
        return;
      }
      settled = true;
      resolve(db);
    };
    try {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains(STORE)
          ? request.transaction!.objectStore(STORE)
          : request.result.createObjectStore(STORE, { keyPath: "key" });
        if (!store.indexNames.contains("savedAt")) {
          store.createIndex("savedAt", "savedAt");
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function closeDatabase(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    /* Optional cache cleanup must not affect the active session. */
  }
}

function blockIdentity(block: Block): string {
  if (block.kind === "user") {
    return `u:${block.origin ?? "user"}:${block.label ?? ""}:${block.text}`;
  }
  if (block.kind === "assistant") return `a:${block.text}`;
  if (block.kind === "thinking") {
    return `r:${block.text}`;
  }
  if (block.kind === "notice") return `n:${block.level}:${block.text}`;
  return JSON.stringify({
    kind: block.kind,
    toolName: block.toolName,
    label: block.label,
    output: block.output,
    isDiff: block.isDiff,
    isMarkdown: block.isMarkdown,
    isSources: block.isSources,
    isError: block.isError,
    done: block.done,
    tail: block.tail,
  });
}

/** Hash every content-bearing field while deliberately excluding presentation
 * state (ids, timestamps, collapse state, and elapsed-time chrome). */
export function transcriptContentSignature(state: TranscriptState): string {
  let hash = 2166136261;
  let chars = 0;
  let items = 0;
  for (const block of state.blocks) {
    const value = blockIdentity(block);
    items += 1;
    chars += value.length;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }
  for (const file of state.changedFiles) {
    const value = JSON.stringify([file.path, file.added, file.removed, file.diff]);
    items += 1;
    chars += value.length;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }
  return `${items}:${chars}:${(hash >>> 0).toString(16)}`;
}

/** Compare a cache with the fields engine history can reconstruct exactly.
 * Event-only notices and file-change presentations are intentionally excluded:
 * the host persists tool calls/results, but not the authoritative file-change
 * event counts/diffs, so hydration can only guess those values. Non-diff tool
 * results remain covered and prevent stale executable output from matching. */
export function transcriptConversationSignature(state: TranscriptState): string {
  return transcriptContentSignature({
    ...state,
    blocks: state.blocks.filter(
      (block) => block.kind !== "notice" && (block.kind !== "tool" || !block.isDiff),
    ),
    changedFiles: [],
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function transcriptBlock(value: unknown): value is Block {
  const block = record(value);
  if (!block || !Number.isSafeInteger(block.id) || (block.id as number) < 0) return false;
  switch (block.kind) {
    case "user":
      return typeof block.text === "string"
        && typeof block.timestamp === "number"
        && Number.isFinite(block.timestamp)
        && block.timestamp >= 0
        && (block.origin === undefined || block.origin === "user" || block.origin === "engine")
        && optionalString(block.label);
    case "assistant":
      return typeof block.text === "string"
        && typeof block.streaming === "boolean"
        && typeof block.gap === "boolean"
        && typeof block.timestamp === "number"
        && Number.isFinite(block.timestamp)
        && block.timestamp >= 0;
    case "thinking":
      return typeof block.text === "string"
        && typeof block.collapsed === "boolean"
        && optionalNonNegative(block.seconds);
    case "notice":
      return typeof block.text === "string"
        && (block.level === "info" || block.level === "warn" || block.level === "error");
    case "tool":
      return optionalString(block.toolName)
        && typeof block.label === "string"
        && Array.isArray(block.output)
        && block.output.every((line) => typeof line === "string")
        && typeof block.collapsed === "boolean"
        && typeof block.isDiff === "boolean"
        && (block.isMarkdown === undefined || typeof block.isMarkdown === "boolean")
        && (block.isSources === undefined || typeof block.isSources === "boolean")
        && typeof block.isError === "boolean"
        && typeof block.done === "boolean"
        && optionalString(block.tail)
        && optionalNonNegative(block.startedAt)
        && optionalNonNegative(block.elapsedMs);
    default:
      return false;
  }
}

function numericRecord(value: unknown): boolean {
  const item = record(value);
  return !!item && Object.values(item).every((entry) =>
    Number.isSafeInteger(entry) && (entry as number) >= 0
  );
}

function trueRecord(value: unknown): boolean {
  const item = record(value);
  return !!item && Object.values(item).every((entry) => entry === true);
}

function isTranscriptState(value: unknown): value is TranscriptState {
  const state = record(value);
  return !!state
    && Array.isArray(state.blocks)
    && state.blocks.length <= MAX_RETAINED_TRANSCRIPT_BLOCKS
    && state.blocks.every(transcriptBlock)
    && Array.isArray(state.changedFiles)
    && state.changedFiles.every((value) => {
      const file = record(value);
      return !!file
        && typeof file.path === "string"
        && typeof file.added === "number"
        && Number.isFinite(file.added)
        && file.added >= 0
        && typeof file.removed === "number"
        && Number.isFinite(file.removed)
        && file.removed >= 0
        && optionalString(file.diff);
    })
    && Number.isSafeInteger(state.nextId)
    && (state.nextId as number) >= 0
    && Number.isSafeInteger(state.activeAssistant)
    && numericRecord(state.toolByCallId)
    && trueRecord(state.suppressCallIds);
}

function settle(state: TranscriptState): TranscriptState {
  return {
    ...state,
    activeAssistant: -1,
    toolByCallId: {},
    blocks: state.blocks.map((block) => {
      if (block.kind === "assistant" && block.streaming) return { ...block, streaming: false };
      if (block.kind === "tool" && !block.done) return { ...block, done: true, tail: undefined };
      return block;
    }),
  };
}

function isSettled(state: TranscriptState): boolean {
  return state.activeAssistant === -1
    && Object.keys(state.toolByCallId).length === 0
    && state.blocks.every((block) =>
      (block.kind !== "assistant" || !block.streaming) && (block.kind !== "tool" || block.done)
    );
}

export async function loadTranscriptCache(
  cwd: string,
  sessionId: string,
): Promise<TranscriptState | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(keyFor(cwd, sessionId));
      request.onsuccess = () => {
        try {
          resolve(decodeTranscriptCacheRecord(request.result));
        } finally {
          closeDatabase(db);
        }
      };
      request.onerror = () => {
        closeDatabase(db);
        resolve(null);
      };
    } catch {
      closeDatabase(db);
      resolve(null);
    }
  });
}

/** Decode an IndexedDB value without trusting legacy/corrupt record metadata. */
export function decodeTranscriptCacheRecord(value: unknown): TranscriptState | null {
  const cached = record(value);
  if (
    !cached
    || typeof cached.key !== "string"
    || typeof cached.savedAt !== "number"
    || !Number.isFinite(cached.savedAt)
    || cached.savedAt < 0
    || typeof cached.signature !== "string"
    || typeof cached.state !== "string"
    || cached.state.length > MAX_SERIALIZED_CHARS
    || transcriptCacheRecordSize(cached) === null
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cached.state);
    return isTranscriptState(parsed)
      && isSettled(parsed)
      && cached.signature === transcriptContentSignature(parsed)
      ? settle(parsed)
      : null;
  } catch {
    return null;
  }
}

/** Validate cleanup metadata before eviction dereferences legacy/corrupt rows. */
export function transcriptCacheRecordSize(value: unknown): number | null {
  const cached = record(value);
  if (!cached || typeof cached.state !== "string") return null;
  if (cached.size === undefined) return cached.state.length;
  return Number.isSafeInteger(cached.size)
    && (cached.size as number) >= 0
    && cached.size === cached.state.length
    ? cached.size as number
    : null;
}

export async function saveTranscriptCache(
  cwd: string,
  sessionId: string,
  state: TranscriptState,
): Promise<void> {
  if (estimateJsonUtf8Bytes(state, MAX_SERIALIZED_CHARS) > MAX_SERIALIZED_CHARS) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return;
  }
  if (serialized.length > MAX_SERIALIZED_CHARS) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.put({
        key: keyFor(cwd, sessionId),
        savedAt: Date.now(),
        signature: transcriptContentSignature(state),
        state: serialized,
        size: serialized.length,
      } satisfies CacheRecord);
      let retained = 0;
      let retainedChars = 0;
      const cursor = store.index("savedAt").openCursor(null, "prev");
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const size = transcriptCacheRecordSize(entry.value);
        if (size === null) {
          entry.delete();
          entry.continue();
          return;
        }
        const keep = retained < MAX_ENTRIES
          && retainedChars + size <= MAX_TOTAL_SERIALIZED_CHARS;
        if (keep) {
          retained += 1;
          retainedChars += size;
        } else {
          entry.delete();
        }
        entry.continue();
      };
      transaction.oncomplete = () => {
        closeDatabase(db);
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        closeDatabase(db);
        resolve();
      };
    } catch {
      closeDatabase(db);
      resolve();
    }
  });
}

export async function deleteTranscriptCache(cwd: string, sessionId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(keyFor(cwd, sessionId));
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => {
        closeDatabase(db);
        resolve();
      };
    } catch {
      closeDatabase(db);
      resolve();
    }
  });
}

export async function deleteTranscriptCachesForCwd(cwd: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        for (const key of request.result) {
          if (typeof key === "string" && transcriptCacheKeyBelongsToCwd(key, cwd)) store.delete(key);
        }
      };
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => {
        closeDatabase(db);
        resolve();
      };
    } catch {
      closeDatabase(db);
      resolve();
    }
  });
}
