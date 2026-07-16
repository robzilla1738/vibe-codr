/**
 * A small shared coordination board for the session tree. Subagents run on
 * isolated event buses with no view of each other, so without this N parallel
 * children can make contradictory decisions (pick the same name, duplicate work,
 * disagree on an interface). The blackboard lets them post short notes —
 * decisions, claims, conflicts — and read what siblings have posted. It's
 * shared by reference across the tree via SessionDeps (like the file lock), and
 * bounded so it can't grow without limit.
 */

/**
 * What a note is for. The kind drives both how it renders and how it ages out:
 * - `claim`    a file/area an agent is taking (transient — dropped once the fan-out ends);
 * - `decision` a settled choice the whole run must respect (load-bearing — outlives claims/info);
 * - `conflict` a disagreement that needs the lead to arbitrate (load-bearing);
 * - `info`     an incidental fact (transient).
 */
export type NoteKind = "claim" | "decision" | "conflict" | "info";

export interface Note {
  /** Who posted it (a session/agent id or label). */
  from: string;
  /** The note text (decision, claim, conflict, fact). */
  text: string;
  /** What the note is for — drives rendering + eviction priority. */
  kind: NoteKind;
  /** When it was posted (ms epoch). */
  at: number;
}

export interface Blackboard {
  /** Post a note (text is trimmed + length-capped). `kind` defaults to "info". Returns the stored note. */
  post(from: string, text: string, kind?: NoteKind, now?: number): Note;
  /** The most recent notes (newest last), up to `limit` (default all kept), optionally filtered by `kind`. */
  read(limit?: number, kind?: NoteKind): Note[];
  /** Total notes currently retained. */
  size(): number;
  /** Drop every note — a fresh top-level turn starts a fresh coordination context. */
  clear(): void;
}

/** Max notes retained (oldest evicted) and per-note char cap. */
const MAX_NOTES = 200;
const MAX_NOTE_CHARS = 2_000;

/** Notes that age out first: transient coordination chatter, not run-wide state. */
function isEvictable(note: Note): boolean {
  return note.kind === "info" || note.kind === "claim";
}

export function createBlackboard(): Blackboard {
  const notes: Note[] = [];
  // Enforce the cap by evicting the OLDEST transient note (info/claim) first, so
  // a settled decision/conflict — load-bearing for the whole run — survives a
  // flood of claims. Decisions/conflicts are only sacrificed once no transient
  // note remains (the board is full of load-bearing state and still over cap).
  const trim = () => {
    while (notes.length > MAX_NOTES) {
      const oldestTransient = notes.findIndex(isEvictable);
      notes.splice(oldestTransient === -1 ? 0 : oldestTransient, 1);
    }
  };
  return {
    post(from, text, kind = "info", now = Date.now()) {
      const trimmed = text.trim().slice(0, MAX_NOTE_CHARS);
      const note: Note = { from, text: trimmed, kind, at: now };
      notes.push(note);
      trim();
      return note;
    },
    read(limit, kind) {
      const scoped = kind ? notes.filter((n) => n.kind === kind) : notes;
      return limit && limit > 0 ? scoped.slice(-limit) : scoped.slice();
    },
    size() {
      return notes.length;
    },
    clear() {
      notes.length = 0;
    },
  };
}

/** Render notes as a compact block for the model (post_note / read_notes / kickoff). */
export function formatNotes(notes: Note[]): string {
  if (!notes.length) return "No shared notes yet.";
  return notes
    .map((n) => `• [${n.kind.toUpperCase()}] [${n.from}] ${n.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}
