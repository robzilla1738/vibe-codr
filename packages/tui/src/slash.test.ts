import { test, expect } from "bun:test";
import {
  lineToCommand,
  lineToCommands,
  parsePermissionDecision,
  routePendingPermLine,
} from "./slash.ts";

test("plain text becomes a prompt submission", () => {
  expect(lineToCommand("fix the bug")).toEqual({
    type: "submit-prompt",
    text: "fix the bug",
  });
});

test("/model routes through run-slash, preserving args (incl. slashes in the id)", () => {
  // The engine's /model router handles `<id>`, `sub …`, and `key …` in one place,
  // so the TUI must hand it the full args verbatim (the dropped-args regression).
  expect(lineToCommand("/model openrouter/anthropic/claude-3.5")).toEqual({
    type: "run-slash",
    name: "model",
    args: "openrouter/anthropic/claude-3.5",
  });
  expect(lineToCommand("/model sub deepseek/deepseek-chat")).toEqual({
    type: "run-slash",
    name: "model",
    args: "sub deepseek/deepseek-chat",
  });
});

test("/model with no argument falls through to run-slash", () => {
  expect(lineToCommand("/model")).toEqual({
    type: "run-slash",
    name: "model",
    args: "",
  });
});

test("/plan and /execute map to mode changes; /yolo routes to the engine handler", () => {
  expect(lineToCommand("/plan")).toEqual({ type: "set-mode", mode: "plan" });
  expect(lineToCommand("/execute")).toEqual({ type: "set-mode", mode: "execute" });
  // /yolo needs BOTH settings (mode + approvals), so it runs engine-side.
  expect(lineToCommand("/yolo")).toEqual({ type: "run-slash", name: "yolo", args: "" });
});

test("a typed /approvals ask|auto is the VERBOSE immediate command (confirm notice)", () => {
  // No `quiet` flag: only the Shift+Tab cycle (commandsForUiMode) is quiet.
  expect(lineToCommand("/approvals auto")).toEqual({ type: "set-approvals", mode: "auto" });
  expect(lineToCommand("/approvals ask")).toEqual({ type: "set-approvals", mode: "ask" });
});

test("/goal routes to the engine slash handler — one authority for its verbs", () => {
  // Like /model: set/show/clear are parsed engine-side (engine-commands.ts), so
  // the TUI and REPL can't drift; bare /goal SHOWS (it used to silently clear).
  expect(lineToCommand("/goal ship it")).toEqual({
    type: "run-slash",
    name: "goal",
    args: "ship it",
  });
  expect(lineToCommand("/goal")).toEqual({ type: "run-slash", name: "goal", args: "" });
  expect(lineToCommand("/goal clear")).toEqual({ type: "run-slash", name: "goal", args: "clear" });
});

test("parsePermissionDecision grants only on EXACT tokens", () => {
  expect(parsePermissionDecision("y")).toEqual({ decision: "once" });
  expect(parsePermissionDecision("Yes")).toEqual({ decision: "once" });
  expect(parsePermissionDecision("allow")).toEqual({ decision: "once" });
  expect(parsePermissionDecision("a")).toEqual({ decision: "always" });
  expect(parsePermissionDecision("Always")).toEqual({ decision: "always" });
  expect(parsePermissionDecision("n")).toEqual({ decision: "deny" });
  expect(parsePermissionDecision("no")).toEqual({ decision: "deny" });
  expect(parsePermissionDecision("")).toEqual({ decision: "deny" });
  // `p`/`project` persists the grant into the project config.
  expect(parsePermissionDecision("p")).toEqual({ decision: "always-project" });
  expect(parsePermissionDecision("Project")).toEqual({ decision: "always-project" });
});

test("a typed sentence DENIES with the text as feedback — never first-letter grants", () => {
  // The old first-char parse turned "actually, wait…" into a silent ALWAYS
  // grant and threw the user's words away. Now any non-token reply is a deny
  // that carries the text, which the engine folds into the model-visible
  // deny reason so the denial steers the next attempt.
  expect(parsePermissionDecision("actually, wait — use staging")).toEqual({
    decision: "deny",
    feedback: "actually, wait — use staging",
  });
  expect(parsePermissionDecision("yes but only the src dir")).toEqual({
    decision: "deny",
    feedback: "yes but only the src dir",
  });
  expect(parsePermissionDecision("never push to main")).toEqual({
    decision: "deny",
    feedback: "never push to main",
  });
});

test("unknown slash commands pass through with their args", () => {
  expect(lineToCommand("/queue clear")).toEqual({
    type: "run-slash",
    name: "queue",
    args: "clear",
  });
  expect(lineToCommand("/loop 30s check --max 3")).toEqual({
    type: "run-slash",
    name: "loop",
    args: "30s check --max 3",
  });
});

test("a slash line that isn't a command name is sent to the model, not swallowed", () => {
  // A path, a comment, or an endpoint that merely starts with "/" is user text —
  // routing it to run-slash makes the engine print "Unknown command" and drop the
  // whole message (including any following lines), so it must be a prompt instead.
  expect(lineToCommand("/etc/hosts is world-readable")).toEqual({
    type: "submit-prompt",
    text: "/etc/hosts is world-readable",
  });
  expect(lineToCommand("// TODO: fix this later")).toEqual({
    type: "submit-prompt",
    text: "// TODO: fix this later",
  });
  // Multi-line bug report: the trailing lines must survive too.
  expect(lineToCommand("/api/users returns 500\n<stack trace>")).toEqual({
    type: "submit-prompt",
    text: "/api/users returns 500\n<stack trace>",
  });
});

test("/plan <text> switches mode AND submits the text (not swallowed)", () => {
  expect(lineToCommands("/plan add oauth to login")).toEqual([
    { type: "set-mode", mode: "plan" },
    { type: "submit-prompt", text: "add oauth to login" },
  ]);
  expect(lineToCommands("/execute run the migration")).toEqual([
    { type: "set-mode", mode: "execute" },
    { type: "submit-prompt", text: "run the migration" },
  ]);
  // Bare /plan is still a single mode switch.
  expect(lineToCommands("/plan")).toEqual([{ type: "set-mode", mode: "plan" }]);
  // A normal line is a single submit.
  expect(lineToCommands("fix the bug")).toEqual([{ type: "submit-prompt", text: "fix the bug" }]);
});

test("routePendingPermLine: a slash line passes through to command handling (not a deny)", () => {
  // /clear must be able to rescue a stuck permission card; every slash line is a
  // command, not a permission answer.
  expect(routePendingPermLine("/clear")).toEqual({ kind: "passthrough" });
  expect(routePendingPermLine("/theme dark")).toEqual({ kind: "passthrough" });
  expect(routePendingPermLine("  /model gpt-5  ")).toEqual({ kind: "passthrough" });
});

test("routePendingPermLine: a non-slash line still answers the pending permission", () => {
  expect(routePendingPermLine("y")).toEqual({ kind: "perm", decision: "once" });
  expect(routePendingPermLine("a")).toEqual({ kind: "perm", decision: "always" });
  expect(routePendingPermLine("n")).toEqual({ kind: "perm", decision: "deny" });
  // Free text = deny WITH feedback (steers the next attempt).
  expect(routePendingPermLine("use staging instead")).toEqual({
    kind: "perm",
    decision: "deny",
    feedback: "use staging instead",
  });
});
