import { describe, expect, it } from "vitest";
import {
  agentCatalogOptions,
  agentsPickerQuery,
  currentModelForTarget,
  mcpPickerQuery,
  mcpSecondary,
  modelPicker,
  normalizeMcpServer,
  providerCatalogOptions,
  providersPickerQuery,
  skillCatalogOptions,
  skillsPickerFilter,
} from "./catalog-draft";
import { seedChromeFromSessionStart } from "./chrome-seed";
import { paletteState } from "./commands-catalog";
import { isDensityChangeNotice, nextDensity, toolCollapsed } from "./density";
import { applyAtMention, atMentionState, formatAtPath, fuzzyPathScore, rankPaths } from "./file-fuzzy";
import { hydrateFromHistory } from "./history-hydrate";
import { ESSENTIAL_KEYS, formatKeysHelp } from "./keys-help";
import { cycleModeAction, deriveUiMode, selectModeAction } from "./modes";
import {
  chatSessions,
  chatsCwdFromHome,
  filterChatSessions,
  filterProjects,
  isChatsCwd,
  partitionProjects,
  projectLabel,
  relativeSessionTime,
  startupProjectCandidates,
  terminalCwdForWorkspace,
} from "./project-index";
import { decodeOutbound, encodeInbound } from "./protocol";
import {
  capChangedFileDiffs,
  capTranscriptState,
  groupIntoTurns,
  initialTranscript,
  reduceTranscript,
  updateGroupedTurns,
} from "./reducer";
import { isScrollAnchored } from "./scroll-anchor";
import { shikiThemeFor, shikiThemeId, shikiThemesCoverRegistry } from "./shiki-theme";
import { lineToCommands, parsePermissionDecision, routePendingPermLine } from "./slash";
import { externalHref, parseSearchResults, parseSources } from "./sources";
import { hasUnfinishedTasks, windowTasks } from "./task-window";
import { paletteColorScheme } from "./theme-scheme";
import { getTheme, THEME_NAMES } from "./themes";
import { turnWindowStart, windowStartIndex } from "./trail";

describe("slash routing", () => {
  it("maps plain text to submit-prompt", () => {
    expect(lineToCommands("hello")).toEqual([{ type: "submit-prompt", text: "hello" }]);
  });

  it("maps /plan text to set-mode + submit", () => {
    expect(lineToCommands("/plan add oauth")).toEqual([
      { type: "set-mode", mode: "plan" },
      { type: "submit-prompt", text: "add oauth" },
    ]);
  });

  it("maps /execute with start:true", () => {
    expect(lineToCommands("/execute")).toEqual([
      { type: "set-mode", mode: "execute", start: true },
    ]);
  });

  it("keeps path-like slashes as prompts", () => {
    expect(lineToCommands("/etc/hosts is world-readable")).toEqual([
      { type: "submit-prompt", text: "/etc/hosts is world-readable" },
    ]);
  });

  it("routes permission answers", () => {
    expect(parsePermissionDecision("y")).toEqual({ decision: "once" });
    expect(parsePermissionDecision("use staging")).toEqual({
      decision: "deny",
      feedback: "use staging",
    });
    expect(routePendingPermLine("/theme dark")).toEqual({ kind: "passthrough" });
  });
});

describe("transcript reducer", () => {
  it("persists explicit disclosure independently of density defaults", () => {
    let state = initialTranscript();
    state = reduceTranscript(state, {
      type: "tool-start",
      toolCallId: "disclosure",
      toolName: "bash",
      input: { command: "pwd" },
    });
    state = reduceTranscript(state, {
      type: "tool-finish",
      toolCallId: "disclosure",
      output: "/tmp",
      isError: false,
    });
    const id = state.blocks[0]!.id;
    state = reduceTranscript(state, { type: "set-expanded", id, expanded: true });
    expect(state.blocks[0]).toMatchObject({ kind: "tool", expandedOverride: true });
    state = reduceTranscript(state, { type: "set-expanded", id, expanded: false });
    expect(state.blocks[0]).toMatchObject({ kind: "tool", expandedOverride: false });
  });

  it("lets the all-thinking shortcut close verbose-default rows", () => {
    let state = reduceTranscript(initialTranscript(), {
      type: "thinking",
      text: "Inspecting the fixture",
    });
    state = reduceTranscript(state, { type: "toggle-thinking-all", density: "verbose" });
    expect(state.blocks[0]).toMatchObject({ kind: "thinking", expandedOverride: false });
  });

  it("caps whole-state replacement while shifting live cursors safely", () => {
    const blocks = Array.from({ length: 4 }, (_, index) => ({
      kind: "assistant" as const,
      id: index,
      text: String(index),
      streaming: index === 3,
      gap: false,
      timestamp: index,
    }));
    const state = capTranscriptState({
      ...initialTranscript(),
      blocks,
      activeAssistant: 3,
      toolByCallId: { dropped: 0, retained: 3 },
    }, 2);
    expect(state.blocks.map((block) => block.id)).toEqual([2, 3]);
    expect(state.activeAssistant).toBe(1);
    expect(state.toolByCallId).toEqual({ retained: 1 });
  });
  it("builds a user → assistant turn", () => {
    let s = initialTranscript();
    s = reduceTranscript(s, { type: "user", text: "hi" });
    s = reduceTranscript(s, { type: "delta", text: "hello" });
    s = reduceTranscript(s, { type: "finalize" });
    const turns = groupIntoTurns(s.blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user?.text).toBe("hi");
    expect(turns[0]!.items[0]).toMatchObject({ kind: "assistant", text: "hello", streaming: false });
  });

  it("incrementally rebuilds only the live turn and preserves completed turn identity", () => {
    let state = initialTranscript();
    state = reduceTranscript(state, { type: "user", text: "first" });
    state = reduceTranscript(state, { type: "delta", text: "done" });
    state = reduceTranscript(state, { type: "finalize" });
    state = reduceTranscript(state, { type: "user", text: "second" });
    state = reduceTranscript(state, { type: "delta", text: "a" });
    const firstBlocks = state.blocks;
    const firstTurns = groupIntoTurns(firstBlocks);
    state = reduceTranscript(state, { type: "delta", text: "b" });
    const nextTurns = updateGroupedTurns(firstBlocks, firstTurns, state.blocks);
    expect(nextTurns[0]).toBe(firstTurns[0]);
    expect(nextTurns[1]).not.toBe(firstTurns[1]);
    expect(nextTurns[1]!.items[0]).toMatchObject({ text: "ab" });
  });

  it("folds file-changed into tool block", () => {
    let s = initialTranscript();
    s = reduceTranscript(s, {
      type: "tool-start",
      toolCallId: "c1",
      toolName: "edit",
      input: { path: "a.ts" },
    });
    s = reduceTranscript(s, {
      type: "file-changed",
      toolCallId: "c1",
      path: "a.ts",
      action: "edit",
      added: 1,
      removed: 0,
      diff: "+x",
    });
    expect(s.blocks[0]).toMatchObject({ kind: "tool", isDiff: true, done: true });
    expect(s.changedFiles).toEqual([{ path: "a.ts", added: 1, removed: 0, diff: "+x" }]);
    s = reduceTranscript(s, {
      type: "tool-finish",
      toolCallId: "c1",
      output: "edited",
      isError: false,
    });
    expect(s.toolByCallId).toEqual({});
    expect(s.suppressCallIds).toEqual({});
  });

  it("bounds newline-free tool output and file diffs", () => {
    let s = initialTranscript();
    s = reduceTranscript(s, {
      type: "tool-start",
      toolCallId: "large-output",
      toolName: "bash",
      input: { cmd: "generate" },
    });
    s = reduceTranscript(s, {
      type: "tool-finish",
      toolCallId: "large-output",
      output: "x".repeat(600_000),
      isError: false,
    });
    const output = s.blocks[0];
    expect(output?.kind === "tool" ? output.output.join("\n").length : 0).toBeLessThan(525_000);
    expect(output?.kind === "tool" ? output.output[0] : "").toContain("earlier output characters omitted");

    s = reduceTranscript(s, {
      type: "file-changed",
      toolCallId: "large-diff",
      path: "huge.txt",
      action: "write",
      added: 1,
      removed: 0,
      diff: "d".repeat(1_100_000),
    });
    expect(s.changedFiles[0]?.diff?.length).toBeLessThan(1_050_000);
    expect(s.changedFiles[0]?.diff).toContain("earlier diff characters omitted");
  });

  it("keeps changed-file metadata while bounding total retained diff text", () => {
    const files = capChangedFileDiffs(
      [
        { path: "old.ts", added: 1, removed: 0, diff: "12345" },
        { path: "new.ts", added: 2, removed: 1, diff: "67890" },
      ],
      5,
    );
    expect(files).toEqual([
      { path: "old.ts", added: 1, removed: 0 },
      { path: "new.ts", added: 2, removed: 1, diff: "67890" },
    ]);
  });
});

describe("protocol", () => {
  it("round-trips bootstrap encode", () => {
    const line = encodeInbound({ op: "bootstrap", cwd: "/tmp/proj" });
    expect(line).toBe('{"op":"bootstrap","cwd":"/tmp/proj"}\n');
  });

  it("decodes ready / event / fatal", () => {
    expect(decodeOutbound('{"type":"ready","sessionId":"ses_1"}')).toEqual({
      type: "ready",
      sessionId: "ses_1",
    });
    expect(decodeOutbound('{"type":"fatal","message":"boom"}')).toEqual({
      type: "fatal",
      message: "boom",
    });
    expect(decodeOutbound("not-json")).toBeNull();
  });
});

describe("modes & themes", () => {
  it("derives ui modes", () => {
    expect(deriveUiMode("plan", "ask")).toBe("plan");
    expect(deriveUiMode("execute", "ask")).toBe("execute");
    expect(deriveUiMode("execute", "auto")).toBe("yolo");
  });

  it("gates plan-pending cycle", () => {
    const a = cycleModeAction("plan", { planPending: true });
    expect(a.optimistic).toBeNull();
    expect(a.commands).toEqual([{ type: "set-mode", mode: "execute" }]);
  });

  it("selects a mode directly and no-ops when unchanged", () => {
    expect(selectModeAction("execute", "execute").commands).toEqual([]);
    const toYolo = selectModeAction("execute", "yolo");
    expect(toYolo.optimistic?.uiMode).toBe("yolo");
    expect(toYolo.commands.some((c) => c.type === "set-approvals")).toBe(true);
    const gated = selectModeAction("plan", "yolo", { planPending: true });
    expect(gated.optimistic).toBeNull();
    expect(gated.commands).toEqual([{ type: "set-mode", mode: "execute" }]);
  });

  it("covers theme names", () => {
    for (const name of THEME_NAMES) {
      expect(getTheme(name).background).toBeTruthy();
    }
  });

  it("sets native control color scheme from the active palette", () => {
    expect(paletteColorScheme(getTheme("light"))).toBe("light");
    expect(paletteColorScheme(getTheme("default"))).toBe("dark");
  });

  it("maps every theme name to a Shiki pair that follows the app scheme", () => {
    expect(shikiThemesCoverRegistry()).toBe(true);
    for (const name of THEME_NAMES) {
      const [a, b] = shikiThemeFor(name);
      expect(a).toBeTruthy();
      expect(a).toBe(b);
      expect(a).toBe(shikiThemeId(name));
    }
    expect(shikiThemeId("light")).toBe("github-light");
    expect(shikiThemeId("tokyonight")).toBe("tokyo-night");
    expect(shikiThemeId("catppuccin")).toBe("catppuccin-mocha");
  });

  it("density overlay", () => {
    expect(nextDensity("quiet")).toBe("normal");
    expect(toolCollapsed("quiet", { collapsed: false, isError: true, isDiff: false })).toBe(true);
    expect(toolCollapsed("quiet", { collapsed: true, expandedOverride: true, isError: false, isDiff: false })).toBe(false);
    expect(toolCollapsed("verbose", { collapsed: true, isError: true, isDiff: false })).toBe(false);
    expect(toolCollapsed("verbose", { collapsed: false, expandedOverride: false, isError: true, isDiff: true })).toBe(true);
  });

  it("keeps density acknowledgements out of the transcript", () => {
    expect(isDensityChangeNotice("Details: verbose.")).toBe(true);
    expect(isDensityChangeNotice("details: quiet")).toBe(true);
    expect(isDensityChangeNotice("Details: normal operation resumed.")).toBe(false);

    const initial = initialTranscript();
    const next = reduceTranscript(initial, {
      type: "notice",
      text: "Details: normal.",
      level: "info",
    });
    expect(next).toBe(initial);
  });
});

describe("rich sources", () => {
  it("parses source fences and raw web-search results", () => {
    expect(parseSources("[Docs](https://example.com/docs) — Primary reference")[0]).toMatchObject({
      title: "Docs",
      domain: "example.com",
      snippet: "Primary reference",
    });
    expect(parseSearchResults("Search results for x\n1. Example\nhttps://example.com\nA useful result.")[0])
      .toMatchObject({ title: "Example", domain: "example.com", snippet: "A useful result." });
  });

  it("allows only browser-safe external source URLs", () => {
    expect(externalHref("example.com")).toBe("https://example.com/");
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("https://trusted.example@evil.example/path")).toBeNull();
  });
});

describe("task window", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    title: `Task ${index}`,
    status: (index < 9 ? "completed" : index === 9 ? "in_progress" : "pending") as "completed" | "in_progress" | "pending",
  }));

  it("keeps active work visible and hides fully completed panels", () => {
    const windowed = windowTasks(tasks, 8);
    expect(windowed.lead).toBe(4);
    expect(windowed.visible.some((task) => task.status === "in_progress")).toBe(true);
    expect(hasUnfinishedTasks(tasks)).toBe(true);
    expect(hasUnfinishedTasks(tasks.map((task) => ({ ...task, status: "completed" as const })))).toBe(false);
  });
});

describe("chrome-seed", () => {
  it("merges snapshot over session-start", () => {
    const seeded = seedChromeFromSessionStart(
      { model: "event-model", mode: "plan" },
      {
        model: "snap-model",
        mode: "execute",
        approvalMode: "auto",
        theme: "tokyonight",
        accentColor: "#fff",
        details: "verbose",
        mouse: false,
        goal: "ship",
      },
    );
    expect(seeded.model).toBe("snap-model");
    expect(seeded.mode).toBe("execute");
    expect(seeded.approvalMode).toBe("auto");
    expect(seeded.theme).toBe("tokyonight");
    expect(seeded.goal).toBe("ship");
  });
});

describe("file-fuzzy", () => {
  it("ranks basename prefix highest", () => {
    const ranked = rankPaths(["src/app.tsx", "src/main.ts", "README.md"], "app");
    expect(ranked[0]).toBe("src/app.tsx");
    expect(fuzzyPathScore("src/app.tsx", "app")).toBeGreaterThan(fuzzyPathScore("README.md", "app"));
  });

  it("detects trailing @mention", () => {
    expect(atMentionState("see @src/a")).toEqual({ query: "src/a", atIndex: 4 });
    expect(atMentionState("/model")).toBeNull();
  });

  it("formatAtPath quotes spaces and preserves $ without replace backrefs", () => {
    expect(formatAtPath("src/a.ts")).toBe("@src/a.ts");
    expect(formatAtPath("docs/My Spec.md")).toBe('@"docs/My Spec.md"');
    expect(formatAtPath("price$100.md")).toBe("@price$100.md");
    // Shared applyAtMention inserts at atIndex without interpreting $ as $1/$&
    expect(applyAtMention("see @p", 4, "price$100.md", true)).toBe("see @price$100.md ");
    expect(applyAtMention("see @q", 4, "docs/My Spec.md", true)).toBe('see @"docs/My Spec.md" ');
  });
});

describe("keys-help", () => {
  it("lists essential chords", () => {
    expect(ESSENTIAL_KEYS.length).toBeGreaterThan(8);
    expect(formatKeysHelp()).toContain("Shift+Tab");
    expect(formatKeysHelp()).toContain("Esc");
  });
});

describe("palette extras", () => {
  it("merges custom command names", () => {
    const state = paletteState("/run", ["run-tests"], "skills");
    expect(
      state.open && state.mode === "command" && state.items.some((i) => i.name === "run-tests"),
    ).toBe(true);
  });

  it("keeps one model selector and splits the palette into compact groups", () => {
    const commands = paletteState("/", ["models", "deploy-app"], "commands");
    const skills = paletteState("/", ["models", "deploy-app"], "skills");
    const system = paletteState("/", ["models", "deploy-app"], "system");
    const names = (state: typeof commands) => state.open && state.mode === "command"
      ? state.items.map((item) => item.name)
      : [];

    expect(names(commands)).toContain("model");
    expect(names(commands)).toContain("vision");
    expect(names(commands)).not.toContain("models");
    expect(names(commands)).not.toContain("deploy-app");
    expect(names(skills)).toContain("deploy-app");
    expect(names(skills)).not.toContain("models");
    expect(names(system)).toContain("settings");
    expect(names(system)).toContain("sandbox");
    expect(names(system)).not.toContain("model");
  });

  it("presents handoff as a first-class Local or Cloud choice", () => {
    const command = paletteState("/handoff", ["handoff"]);
    expect(command.open && command.mode === "command" && command.items[0]).toMatchObject({
      name: "handoff",
      description: "Move this session between Local and Cloud",
      values: ["cloud", "local"],
    });
    const values = paletteState("/handoff ", ["handoff"]);
    expect(values.open && values.mode === "value" ? values.items : []).toEqual(["cloud", "local"]);
    expect(values.open && values.mode === "value"
      ? values.command.valueDescriptions?.cloud
      : undefined).toBe("Continue this session in an isolated sandbox");
  });
});

describe("history hydrate", () => {
  it("rebuilds user/assistant from snapshot history", () => {
    const s = hydrateFromHistory([
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 1,
      },
      {
        id: "2",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        createdAt: 2,
      },
    ]);
    expect(s.blocks.some((b) => b.kind === "user" && b.text === "hi")).toBe(true);
    expect(s.blocks.some((b) => b.kind === "assistant" && b.text === "hello")).toBe(true);
  });

  it("pairs persisted assistant tool calls with role:tool results", () => {
    const s = hydrateFromHistory([
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } }],
        createdAt: 1,
      },
      {
        id: "2",
        role: "tool",
        parts: [{ type: "tool-result", toolCallId: "call-1", toolName: "read", output: "hello", isError: false }],
        createdAt: 2,
      },
    ]);
    expect(s.blocks).toContainEqual(expect.objectContaining({
      kind: "tool",
      toolName: "read",
      done: true,
      isError: false,
      output: ["hello"],
    }));
  });

  it("marks orphan tool-starts done after history hydrate", () => {
    const s = hydrateFromHistory([
      {
        id: "a1",
        role: "assistant",
        createdAt: 2,
        parts: [
          { type: "tool-call", toolCallId: "orphan", toolName: "bash", input: { cmd: "sleep" } },
        ],
      },
    ]);
    const tool = s.blocks.find((b) => b.kind === "tool");
    expect(tool?.kind === "tool" && tool.done).toBe(true);
    expect(Object.keys(s.toolByCallId)).toHaveLength(0);
  });
});

describe("project rail", () => {
  const projects = [
    {
      cwd: "/work/alpha/app",
      name: "app",
      updatedAt: 100,
      sessions: [
        {
          id: "s1",
          title: "Refine Electron UI",
          model: "openai/gpt",
          mode: "execute" as const,
          goal: null,
          createdAt: 1,
          updatedAt: 100,
        },
      ],
    },
    {
      cwd: "/work/beta/app",
      name: "app",
      updatedAt: 50,
      sessions: [],
    },
  ];

  it("filters by session content while preserving its project", () => {
    expect(filterProjects(projects, "electron")).toEqual([
      { ...projects[0], sessions: projects[0]!.sessions },
    ]);
    expect(filterProjects(projects, "beta")).toEqual([
      { ...projects[1], sessions: projects[1]!.sessions },
    ]);
  });

  it("disambiguates duplicate project names and formats recency", () => {
    expect(projectLabel(projects[0]!, projects)).toBe("app — alpha");
    expect(relativeSessionTime(1_000, 121_000)).toBe("2m");
  });

  it("restores the last authorized workspace before newer recents", () => {
    expect(startupProjectCandidates(projects, "/work/beta/app").map((project) => project.cwd))
      .toEqual(["/work/beta/app", "/work/alpha/app"]);
    expect(startupProjectCandidates(projects, "/missing").map((project) => project.cwd))
      .toEqual(["/work/alpha/app", "/work/beta/app"]);
    expect(startupProjectCandidates(projects, null).map((project) => project.cwd))
      .toEqual(["/work/alpha/app", "/work/beta/app"]);
  });

  it("resolves chats cwd under home and partitions chats from projects", () => {
    expect(chatsCwdFromHome("/Users/rob")).toBe("/Users/rob/.vibe/chats");
    expect(chatsCwdFromHome("C:\\Users\\rob")).toBe("C:\\Users\\rob\\.vibe\\chats");
    expect(isChatsCwd("/Users/rob/.vibe/chats/", "/Users/rob/.vibe/chats")).toBe(true);

    const chatsRoot = "/Users/rob/.vibe/chats";
    const withChats = [
      ...projects,
      {
        cwd: chatsRoot,
        name: "chats",
        updatedAt: 200,
        sessions: [
          {
            id: "c1",
            title: "Quick idea",
            model: "x",
            mode: "execute" as const,
            goal: null,
            createdAt: 1,
            updatedAt: 200,
          },
        ],
      },
    ];
    const { chats, projects: repos } = partitionProjects(withChats, chatsRoot);
    expect(chats?.cwd).toBe(chatsRoot);
    expect(chatSessions(chats)).toHaveLength(1);
    expect(repos.map((p) => p.cwd)).toEqual(["/work/alpha/app", "/work/beta/app"]);
    expect(filterChatSessions(chatSessions(chats), "quick")).toHaveLength(1);
    expect(filterChatSessions(chatSessions(chats), "nope")).toHaveLength(0);
    expect(partitionProjects(projects, chatsRoot).chats).toBeNull();
  });

  it("opens chat terminals at home and project terminals at the project root", () => {
    const chatsRoot = "/Users/rob/.vibe/chats";
    expect(terminalCwdForWorkspace(chatsRoot, chatsRoot, "/Users/rob")).toBe("/Users/rob");
    expect(terminalCwdForWorkspace("/work/alpha/app", chatsRoot, "/Users/rob")).toBe(
      "/work/alpha/app",
    );
    expect(terminalCwdForWorkspace(chatsRoot, null, "/Users/rob")).toBeNull();
  });
});

describe("scroll anchoring", () => {
  it("follows near the bottom and disengages after intentional upward scroll", () => {
    expect(isScrollAnchored({ scrollHeight: 1000, scrollTop: 428, clientHeight: 500 })).toBe(true);
    expect(isScrollAnchored({ scrollHeight: 1000, scrollTop: 427, clientHeight: 500 })).toBe(false);
    expect(isScrollAnchored({ scrollHeight: 600, scrollTop: 0, clientHeight: 700 })).toBe(true);
  });
});

describe("catalog-draft", () => {
  it("detects model / providers / agents / skills / mcp drafts", () => {
    expect(modelPicker("/model")).toEqual({ query: "", target: "main" });
    expect(modelPicker("/model clau")).toEqual({ query: "clau", target: "main" });
    expect(modelPicker("/model agent review foo")).toEqual({
      query: "foo",
      target: { agent: "review" },
    });
    expect(modelPicker("/model key openai ")).toBeNull();
    expect(modelPicker("/model refresh")).toBeNull();
    expect(modelPicker("/model sub haiku", "main")).toEqual({ query: "haiku", target: "sub" });
    expect(providersPickerQuery("/providers ant")).toBe("ant");
    expect(agentsPickerQuery("/agents")).toBe("");
    expect(agentsPickerQuery("/agents new foo")).toBeNull();
    expect(skillsPickerFilter("/skills web")).toBe("web");
    expect(skillsPickerFilter("/skill web")).toBeNull();
    expect(mcpPickerQuery("/mcp")).toBe("");
  });

  it("normalizes host listMcp shape", () => {
    expect(
      normalizeMcpServer({
        name: "filesystem",
        connected: true,
        configured: true,
        toolCount: 4,
        resourceCount: 1,
        promptCount: 0,
      }),
    ).toEqual({
      name: "filesystem",
      connected: true,
      configured: true,
      toolCount: 4,
      resourceCount: 1,
      promptCount: 0,
      error: undefined,
    });
    expect(mcpSecondary(normalizeMcpServer({ name: "x", connected: false, configured: true, toolCount: 0, resourceCount: 0, promptCount: 0 }))).toContain(
      "disconnected",
    );
  });

  it("normalizeMcpServer coerces array tools and non-finite counts", () => {
    expect(
      normalizeMcpServer({
        name: "svc",
        connected: true,
        tools: [{ name: "a" }, { name: "b" }],
        resourceCount: "nope",
        promptCount: undefined,
      }),
    ).toMatchObject({ toolCount: 2, resourceCount: 0, promptCount: 0 });
  });

  it("tool-finish tolerates undefined/null/non-JSON output without throwing", () => {
    let s = initialTranscript();
    s = reduceTranscript(s, {
      type: "tool-start",
      toolCallId: "c1",
      toolName: "bash",
      input: { cmd: "echo" },
    });
    expect(() => {
      s = reduceTranscript(s, {
        type: "tool-finish",
        toolCallId: "c1",
        output: undefined,
        isError: false,
      });
    }).not.toThrow();
    const tool = s.blocks.find((b) => b.kind === "tool");
    expect(tool?.kind === "tool" && tool.done).toBe(true);

    s = reduceTranscript(s, {
      type: "tool-start",
      toolCallId: "c2",
      toolName: "bash",
      input: { cmd: "x" },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      s = reduceTranscript(s, {
        type: "tool-finish",
        toolCallId: "c2",
        output: circular,
        isError: true,
      });
    }).not.toThrow();
  });

  it("builds provider / agent / skill prefill options", () => {
    const providers = providerCatalogOptions([
      { id: "openai", configured: true, keyless: false, env: ["OPENAI_API_KEY"] },
      { id: "acme", configured: false, keyless: false, env: ["ACME_KEY"] },
    ]);
    expect(providers[0]?.prefill).toBe("/model openai/");
    expect(providers[1]?.setupProviderId).toBe("acme");

    const agents = agentCatalogOptions([
      { name: "review", description: "Reviewer", model: null, mode: "execute" },
    ]);
    expect(agents[0]?.prefill).toBe("/agents new ");
    expect(agents[1]?.prefill).toBe("/model agent review ");
    expect(agents[1]?.openModelsForAgent).toBe("review");

    expect(skillCatalogOptions([{ name: "commit", description: "Write a commit" }])[0]?.prefill).toBe(
      "/skill commit ",
    );
  });

  it("marks current model for main / sub / agent targets", () => {
    expect(currentModelForTarget("main", "openai/gpt", "anthropic/haiku", [])).toBe("openai/gpt");
    expect(currentModelForTarget("sub", "openai/gpt", "anthropic/haiku", [])).toBe("anthropic/haiku");
    expect(
      currentModelForTarget({ agent: "review" }, "openai/gpt", undefined, [
        { name: "review", description: "", model: "openai/o4-mini", mode: "execute" },
      ]),
    ).toBe("openai/o4-mini");
  });
});

describe("transcript windowing", () => {
  it("pages earlier turns via reveal count", () => {
    expect(windowStartIndex(30, 40, 0)).toBe(0);
    expect(windowStartIndex(60, 40, 0)).toBe(20);
    expect(windowStartIndex(60, 40, 20)).toBe(0);
    expect(windowStartIndex(80, 40, 20)).toBe(20);
  });

  it("caps in-turn items in step increments and pages older items back", () => {
    expect(turnWindowStart(100, 120, 24)).toBe(0);
    expect(turnWindowStart(144, 120, 24)).toBe(24);
    expect(turnWindowStart(200, 120, 24)).toBe(96);
    expect(turnWindowStart(200, 120, 24, 24)).toBe(72);
    expect(turnWindowStart(200, 120, 24, 96)).toBe(0);
  });
});

describe("rich blocks rendering", () => {
  it("bar chart renders as rich kind", async () => {
    const { richKind } = await import("./rich-blocks");
    expect(richKind("chart")).toBe("bar");
    expect(richKind("barchart")).toBe("bar");
    expect(richKind("line")).toBe("line");
    expect(richKind("sparkline")).toBe("sparkline");
    expect(richKind("pie")).toBe("pie");
    expect(richKind("weather")).toBe("weather");
    expect(richKind("sources")).toBe("sources");
    expect(richKind("python")).toBeNull();
  });
});

describe("breakpoints", () => {
  it("names layout thresholds used by CSS and JS", async () => {
    const { BREAKPOINTS, atBreakpoint, belowBreakpoint } = await import("./breakpoints");
    expect(BREAKPOINTS).toEqual({
      wide: 1280,
      laptop: 1100,
      dock: 960,
      tablet: 900,
      compact: 720,
      narrow: 640,
    });
    expect(atBreakpoint("wide", 1280)).toBe(true);
    expect(belowBreakpoint("tablet", 899)).toBe(true);
    expect(belowBreakpoint("tablet", 900)).toBe(false);
    expect(belowBreakpoint("narrow", 640)).toBe(false);
  });
});

describe("theme palette parity", () => {
  it("DEFAULT palette matches the canonical Vibe Dark surfaces", async () => {
    const { THEMES } = await import("./themes");
    const d = THEMES.default!;
    expect(d.background).toBe("#0a0a0a");
    expect(d.panel).toBe("#141414");
    expect(d.elevated).toBe("#1e1e1e");
    expect(d.border).toBe("#3c3c3c");
    expect(d.code).toBe("#56b6c2");
    expect(d.primary).toBe("#e6e6e6");
    expect(d.selBg).toBe("#2a2a2a");
    expect(d.heading).toBe("#e6e6e6");
  });

  it("removes the former OpenCode palette name", async () => {
    const { THEMES, getTheme } = await import("./themes");
    expect(THEMES.opencode).toBeUndefined();
    expect(getTheme("opencode")).toBe(THEMES.default);
  });

  it("resolveChromeAccent keeps palette selection until /accent overrides", async () => {
    const { THEMES } = await import("./themes");
    const { contrastOn, resolveChromeAccent } = await import("./theme-scheme");
    const d = THEMES.default!;
    expect(resolveChromeAccent(d)).toMatchObject({
      selBg: d.selBg,
      selFg: d.selFg,
      heading: d.heading,
      ring: d.accent,
    });
    const violet = resolveChromeAccent(d, "#bb9af7");
    expect(violet.selBg).toBe("#bb9af7");
    expect(violet.selFg).toBe(contrastOn("#bb9af7"));
    expect(violet.heading).toBe("#bb9af7");
    expect(violet.focus).toBe("#bb9af7");
    expect(contrastOn("#eeeeee")).toBe("#0a0a0a");
    expect(contrastOn("#0a0a0a")).toBe("#eeeeee");
  });
});

describe("permission copy", () => {
  it("uses human kinds instead of raw tool ids", async () => {
    const { permissionKind, permissionDetail } = await import("./tool-icons");
    expect(permissionKind("job_kill")).toBe("Stop a background job");
    expect(permissionKind("bash")).toBe("Run a command");
    expect(permissionDetail("job_kill", { id: "job_1" })).toBe("Stop job_1");
    expect(permissionDetail("bash", { command: "npm run dev" })).toBe("npm run dev");
  });
});
