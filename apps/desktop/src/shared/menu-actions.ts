/** Main-process application-menu actions accepted by the renderer. */
export const MENU_ACTIONS = [
  "newSession",
  "openProject",
  "toggleSettings",
  "toggleGit",
  "toggleInspector",
  "toggleTerminal",
  "toggleJobs",
  "showKeys",
  "continueLatest",
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

const MENU_ACTION_SET = new Set<string>(MENU_ACTIONS);

/** Runtime guard for the Electron IPC boundary. */
export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === "string" && MENU_ACTION_SET.has(value);
}
