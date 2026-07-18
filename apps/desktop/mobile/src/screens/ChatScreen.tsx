// Chat surface — the main remote-control screen. Boots the remote session on
// mount (connect + snapshot + history hydrate), then renders the topbar,
// transcript, live approval panels, composer, and toast. All behavior is
// driven by useRemoteSession, which reuses the desktop's pure state machines.
import { useEffect, useState } from "react";
import { StyleSheet, View, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Button, Spinner } from "../components/primitives";
import { TopBar } from "../components/TopBar";
import { Transcript } from "../components/Transcript";
import { LivePanels } from "../components/LivePanels";
import { Composer } from "../components/Composer";
import { Toast } from "../components/Toast";
import { ActivityDrawer, type Tab } from "../components/ActivityDrawer";
import { CatalogPicker } from "../components/CatalogPicker";
import { SettingsSheet } from "../components/SettingsSheet";
import { ConfigSettingsSheet } from "../components/ConfigSettingsSheet";
import { InspectorSheet } from "../components/InspectorSheet";
import { ProjectRailSheet } from "../components/ProjectRailSheet";
import { ProviderAuthSheet } from "../components/ProviderAuthSheet";
import { KeysSheet } from "../components/KeysSheet";
import { TerminalPanel } from "../components/TerminalPanel";
import { AtMentionPicker } from "../components/AtMentionPicker";
import { AmbientBackground } from "../components/AmbientBackground";
import { DiffReviewSheet } from "../components/DiffReviewSheet";
import { ChangedFilesPill } from "../components/ChangedFilesPill";
import { EmptySession } from "../components/EmptySession";
import { SessionsWorkspaceSheet } from "../components/SessionsWorkspaceSheet";
import { CloudWorkspaceSheet } from "../components/CloudWorkspaceSheet";
import { lineToCommands } from "@shared/slash";
import { encodedEngineCommandBytes, HOST_INBOUND_SAFE_BYTES } from "@shared/protocol";
import { useRemoteSession } from "../hooks/useRemoteSession";
import { commandsExpectBusy } from "@shared/command-busy";
import { planResolutionBlockedReason } from "@shared/plan-resolution";
import type { EngineCommand } from "@shared/commands";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import type { ConnectionConfig } from "../app/connection";
import { isCloudSessionRemoteOwned, type CloudSessionCatalogEntry } from "@shared/cloud";
import { BrandIcon } from "../components/BrandWordmark";

interface Props {
  client: RemoteEngineClient;
  connection: ConnectionConfig;
  onDisconnect: () => void;
  onSessionChange?: (cwd: string, sessionId: string) => void | Promise<void>;
}

export function ChatScreen({ client, connection, onDisconnect, onSessionChange }: Props) {
  const { colors, setThemeName, setAccent } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useRemoteSession({ client, cwd: connection.cwd });
  const { chrome, visibleTurns, hiddenCount, revealEarlier, foldedTurns, toggleTurnFold, revealTurnItems, itemWindowFor, uiMode, modeColor, toast, bootError, booting, ready } = session;
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<Tab>("session");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [executionTarget, setExecutionTarget] = useState<"local" | "cloud">("local");
  const [providersOpen, setProvidersOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [diffReviewOpen, setDiffReviewOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [composerHeight, setComposerHeight] = useState(122);
  const s = makeStyles(colors);

  useEffect(() => {
    if (chrome.theme) setThemeName(chrome.theme);
  }, [chrome.theme, setThemeName]);
  useEffect(() => {
    setAccent(chrome.accent || undefined);
  }, [chrome.accent, setAccent]);
  useEffect(() => {
    if (!ready || !chrome.cwd || !chrome.sessionId) return;
    void onSessionChange?.(chrome.cwd, chrome.sessionId);
  }, [ready, chrome.cwd, chrome.sessionId, onSessionChange]);
  useEffect(() => {
    if (!ready || !chrome.sessionId) return;
    void client.cloud({ action: "listSessions" }).then((result) => {
      if (!result.ok || !Array.isArray(result.value)) return;
      const entry = (result.value as CloudSessionCatalogEntry[]).find((item) => item.sessionId === chrome.sessionId);
      setExecutionTarget(entry && isCloudSessionRemoteOwned(entry.status) ? "cloud" : "local");
    }).catch(() => undefined);
  }, [client, ready, chrome.sessionId]);
  useEffect(() => {
    void session.bootstrap({ cwd: connection.cwd });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function handleSend(commands: EngineCommand[]): Promise<boolean> {
    // Reject oversized commands before sending (desktop parity: commandFitsInboundLimit).
    for (const c of commands) {
      if (encodedEngineCommandBytes(c) > HOST_INBOUND_SAFE_BYTES) {
        session.showToast("Message is too large to send safely. Shorten it or attach the content as a file.", "error");
        return false;
      }
    }
    // Plan accept blocked by an active goal run (desktop parity: answerPlan checks).
    for (const c of commands) {
      if (c.type === "resolve-plan" && c.decision === "accept") {
        const blocked = planResolutionBlockedReason("accept", chrome.goalRun);
        if (blocked) { session.showToast(blocked, "warn"); return false; }
      }
    }
    if (commandsExpectBusy(commands)) session.dispatchChrome({ type: "set-busy", busy: true });
    return session.sendMany(commands);
  }

  function handleAbort() {
    void session.send({ type: "abort" });
  }

  if (booting && !ready) {
    return (
      <View style={[s.center, { paddingTop: insets.top }]}>
        <BrandIcon size={58} style={{ marginBottom: T.sBase }} />
        <Spinner size="large" />
        <Txt variant="ui" color={colors.textSecondary} style={{ marginTop: T.sSm }}>Connecting to engine…</Txt>
      </View>
    );
  }

  if (bootError && !ready) {
    return (
      <View style={[s.center, { paddingTop: insets.top, paddingHorizontal: T.sLg }]}>
        <BrandIcon size={58} style={{ marginBottom: T.sBase, opacity: 0.78 }} />
        <Txt variant="heading" color={colors.del} style={{ marginBottom: T.sSm }}>Connection failed</Txt>
        <Txt variant="prose" color={colors.textSecondary} style={{ marginBottom: T.sLg, textAlign: "center" }}>{bootError}</Txt>
        <View style={{ flexDirection: "row", gap: T.sSm }}>
          <Button label="Retry" variant="primary" onPress={() => session.bootstrap({ cwd: connection.cwd })} />
          <Button label="Disconnect" variant="ghost" onPress={onDisconnect} />
        </View>
      </View>
    );
  }

  return (
    <View style={[s.shell, { backgroundColor: "transparent" }]}>
      <AmbientBackground />
      <TopBar chrome={chrome} modeColor={modeColor} busy={chrome.busy} connectionState={session.connectionState} onDisconnect={onDisconnect} onOpenSidebar={() => setProjectsOpen(true)} />
      <View style={{ flex: 1, paddingTop: insets.top + 52, paddingBottom: composerHeight }}>
        {hiddenCount > 0 ? (
          <Pressable onPress={revealEarlier} style={{ alignItems: "center", paddingVertical: 8 }}><Txt variant="caption" color={colors.textSubtle}>↑ Reveal {hiddenCount} earlier turn{hiddenCount === 1 ? "" : "s"}</Txt></Pressable>
        ) : null}
        {visibleTurns.length === 0 && !chrome.busy
          ? <EmptySession cwd={chrome.cwd} model={chrome.model} />
          : <Transcript turns={visibleTurns} thinkingStream={chrome.thinkingStream} foldedTurns={foldedTurns} onToggleFold={toggleTurnFold} onEditUser={setComposerText} itemWindowFor={itemWindowFor} onRevealItems={revealTurnItems} />}
        <LivePanels chrome={chrome} pendingCapabilities={session.pendingCapabilities} onSend={handleSend} />
      </View>
      <AtMentionPicker draft={composerText} cwd={chrome.cwd} client={client} onPick={setComposerText} />
      <ChangedFilesPill files={session.transcript.changedFiles} onReview={() => setDiffReviewOpen(true)} />
      <Composer
        chrome={chrome}
        uiMode={uiMode}
        modeColor={modeColor}
        text={composerText}
        setText={setComposerText}
        onSend={handleSend}
        onAbort={handleAbort}
        onCycleMode={session.cycleMode}
        onSelectMode={session.selectMode}
        onClear={session.clearSessionLocal}
        executionTarget={executionTarget}
        onOpenCloud={() => setCloudOpen(true)}
        onOpenWorkspace={(target) => {
          if (target === "terminal") setTerminalOpen(true);
          else { setActivityTab(target); setActivityOpen(true); }
        }}
        workspaceBadges={{ session: session.pendingCapabilities.length > 0 || chrome.perms.length > 0 || !!chrome.question || !!chrome.plan, changes: session.transcript.changedFiles.length > 0, git: !!chrome.git, jobs: chrome.jobs.length > 0 }}
        onHeightChange={setComposerHeight}
        onShellRoute={(kind) => {
          if (kind === "keys") setKeysOpen(true);
          else if (kind === "settings") setSettingsOpen(true);
          else if (kind === "jobs") { setActivityTab("jobs"); setActivityOpen(true); }
          else if (kind === "git") { setActivityTab("git"); setActivityOpen(true); }
        }}
      />
      <InspectorSheet open={reviewOpen} onClose={() => setReviewOpen(false)} chrome={chrome} changedFiles={session.transcript.changedFiles} />
      <ProviderAuthSheet
        open={providersOpen}
        onClose={() => setProvidersOpen(false)}
        client={client}
        currentModel={chrome.model}
        onSelectModel={(m) => { void handleSend([{ type: "set-model", model: m }]); }}
      />
      <ProjectRailSheet
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        client={client}
        activeCwd={chrome.cwd}
        activeSessionId={chrome.sessionId}
        onSwitch={(cwd, resume) => { setProjectsOpen(false); void session.switchSession({ cwd, ...(resume ? { resume } : {}) }); }}
        onNewChat={(cwd) => session.switchSession({ cwd })}
        onOpenSessions={() => { setProjectsOpen(false); setSessionsOpen(true); }}
        onOpenSettings={() => { setProjectsOpen(false); setConfigOpen(true); }}
      />
      <SessionsWorkspaceSheet
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        client={client}
        activeCwd={chrome.cwd}
        activeSessionId={chrome.sessionId}
        busy={chrome.busy}
        needsInput={chrome.perms.length > 0 || !!chrome.question || !!chrome.plan}
        onSwitch={(cwd, id) => { setSessionsOpen(false); void session.switchSession({ cwd, resume: id }); }}
        onNewChat={(cwd) => session.switchSession({ cwd })}
      />
      <CloudWorkspaceSheet
        open={cloudOpen}
        onClose={() => setCloudOpen(false)}
        client={client}
        cwd={chrome.cwd}
        sessionId={chrome.sessionId}
        model={chrome.model}
        busy={chrome.busy}
        onReattach={(cwd, id) => session.switchSession({ cwd, resume: id })}
        onTargetChange={setExecutionTarget}
      />
      <ConfigSettingsSheet open={configOpen} onClose={() => setConfigOpen(false)} client={client} cwd={chrome.cwd} />
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        chrome={chrome}
        onSendSlash={(line) => { void handleSend(lineToCommands(line)); }}
        onSendCommand={(c) => { void handleSend([c]); }}
        onOpenModel={() => { setSettingsOpen(false); setComposerText("/model "); }}
        onOpenProviders={() => { setSettingsOpen(false); setProvidersOpen(true); }}
      />
      <CatalogPicker
        draft={composerText}
        chrome={chrome}
        client={client}
        onSendCommand={async (c) => { const ok = await handleSend([c]); return ok; }}
        onSendSlash={async (line) => { const ok = await handleSend(lineToCommands(line)); return ok; }}
        onPrefill={setComposerText}
        onClose={() => setComposerText("")}
      />
      <KeysSheet open={keysOpen} onClose={() => setKeysOpen(false)} />
      <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} client={client} cwd={chrome.cwd} />
      <DiffReviewSheet open={diffReviewOpen} onClose={() => setDiffReviewOpen(false)} changedFiles={session.transcript.changedFiles} />
      <Toast toast={toast} />
      <ActivityDrawer client={client} open={activityOpen} onClose={() => setActivityOpen(false)} chrome={chrome} changedFiles={session.transcript.changedFiles} onOpenReview={() => { setActivityOpen(false); setReviewOpen(true); }} onOpenDiffReview={() => { setActivityOpen(false); setDiffReviewOpen(true); }} tab={activityTab} onTabChange={setActivityTab} />
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    shell: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  });
}
