/**
 * A small shared coordination board for the session tree. Subagents run on
 * isolated event buses with no view of each other, so without this N parallel
 * children can make contradictory decisions (pick the same name, duplicate work,
 * disagree on an interface). The blackboard lets them post short notes —
 * decisions, claims, conflicts — and read what siblings have posted. It's
 * shared by reference across the tree via SessionDeps (like the file lock), and
 * bounded so it can't grow without limit.
 */
export interface Note {
  /** Who posted it (a session/agent id or label). */
  from: string;
  /** The note text (decision, claim, conflict, fact). */
  text: string;
  /** When it was posted (ms epoch). */
  at: number;
}

export interface Blackboard {
  /** Post a note (text is trimmed + length-capped). Returns the stored note. */
  post(from: string, text: string, now?: number): Note;
  /** The most recent notes (newest last), up to `limit` (default all kept). */
  read(limit?: number): Note[];
  /** Total notes currently retained. */
  size(): number;
}

/** Max notes retained (oldest evicted) and per-note char cap. */
const MAX_NOTES = 200;
const MAX_NOTE_CHARS = 2_000;

export function createBlackboard(): Blackboard {
  const notes: Note[] = [];
  return {
    post(from, text, now = Date.now()) {
      const trimmed = text.trim().slice(0, MAX_NOTE_CHARS);
      const note: Note = { from, text: trimmed, at: now };
      notes.push(note);
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
      return note;
    },
    read(limit) {
      return limit && limit > 0 ? notes.slice(-limit) : notes.slice();
    },
    size() {
      return notes.length;
    },
  };
}

/** Render notes as a compact block for the model (post_note / read_notes / kickoff). */
export function formatNotes(notes: Note[]): string {
  if (!notes.length) return "No shared notes yet.";
  return notes
    .map((n) => `• [${n.from}] ${n.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}
