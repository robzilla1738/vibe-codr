/** Short, sortable, collision-resistant id (timestamp + random suffix). */
export function createId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const body = `${ts}${rand}`;
  return prefix ? `${prefix}_${body}` : body;
}
