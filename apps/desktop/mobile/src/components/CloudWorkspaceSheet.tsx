import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { CloudProviderId, CloudSessionCatalogEntry, CloudSettingsPublic, CloudStatusEvent } from "@shared/cloud";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Icon } from "./icons";
import { Spinner, Txt } from "./primitives";
import { Sheet } from "./Sheet";

const EMPTY_SETTINGS: CloudSettingsPublic = {
  experimentalEnabled: false, transferModelCredentials: true, lastProvider: "e2b", autoPauseMinutes: 10, deleteOnReturn: true,
  providers: { e2b: { configured: false }, vercel: { configured: false } }, credentialBindings: [], allowedDomains: [], additionalExclusions: [],
};

export function CloudWorkspaceSheet({ open, onClose, client, cwd, sessionId, model, busy, onReattach, onTargetChange }: {
  open: boolean; onClose: () => void; client: RemoteEngineClient; cwd: string; sessionId: string; model: string; busy: boolean;
  onReattach: (cwd: string, sessionId: string) => Promise<boolean>; onTargetChange?: (target: "local" | "cloud") => void;
}) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const [settings, setSettings] = useState<CloudSettingsPublic>(EMPTY_SETTINGS);
  const [sessions, setSessions] = useState<CloudSessionCatalogEntry[]>([]);
  const [provider, setProvider] = useState<CloudProviderId>("e2b");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CloudStatusEvent | null>(null);
  const [instruction, setInstruction] = useState("");
  const [includeCredentials, setIncludeCredentials] = useState(true);
  const [keepCloudCopy, setKeepCloudCopy] = useState(false);
  const [setupProvider, setSetupProvider] = useState<CloudProviderId | null>(null);
  const [e2bKey, setE2bKey] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [vercelTeam, setVercelTeam] = useState("");
  const [vercelProject, setVercelProject] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [bindingLabel, setBindingLabel] = useState("");
  const [bindingValue, setBindingValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [settingsResult, sessionsResult] = await Promise.all([client.cloud({ action: "settings" }), client.cloud({ action: "listSessions" })]);
      if (!settingsResult.ok) throw new Error(settingsResult.error);
      if (!sessionsResult.ok) throw new Error(sessionsResult.error);
      const nextSettings = settingsResult.value as CloudSettingsPublic;
      const nextSessions = sessionsResult.value as CloudSessionCatalogEntry[];
      setSettings(nextSettings); setSessions(Array.isArray(nextSessions) ? nextSessions : []);
      setProvider(nextSettings.lastProvider); setIncludeCredentials(nextSettings.transferModelCredentials); setKeepCloudCopy(!nextSettings.deleteOnReturn);
      setAllowedDomains(nextSettings.allowedDomains.join("\n")); setExclusions(nextSettings.additionalExclusions.join("\n"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [client]);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => client.onRelay((frame) => { if (frame.relay === "cloud-status") setProgress(frame.event); }), [client]);

  const current = useMemo(() => sessions.find((session) => session.sessionId === sessionId && !["suspended", "cleanup-pending", "lost"].includes(session.status)) ?? null, [sessions, sessionId]);
  useEffect(() => { if (open) onTargetChange?.(current ? "cloud" : "local"); }, [current, onTargetChange, open]);
  const configured = settings.providers[provider].configured;

  async function patchSettings(patch: Partial<Pick<CloudSettingsPublic, "experimentalEnabled" | "transferModelCredentials" | "lastProvider" | "autoPauseMinutes" | "deleteOnReturn" | "allowedDomains" | "additionalExclusions">>) {
    setWorking(true); setError(null);
    try {
      const result = await client.cloud({ action: "updateSettings", patch });
      if (!result.ok) throw new Error(result.error);
      setSettings(result.value as CloudSettingsPublic);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function connect(providerId: CloudProviderId) {
    setWorking(true); setError(null);
    try {
      const credentials = providerId === "e2b" ? { apiKey: e2bKey.trim() } : { token: vercelToken.trim(), teamId: vercelTeam.trim(), projectId: vercelProject.trim() };
      const result = await client.cloud({ action: "connect", provider: providerId, credentials });
      if (!result.ok) throw new Error(result.error);
      setE2bKey(""); setVercelToken(""); setSetupProvider(null); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function testProvider(providerId: CloudProviderId) {
    setWorking(true); setError(null);
    try {
      const result = await client.cloud({ action: "test", provider: providerId });
      if (!result.ok) throw new Error(result.error);
      const value = result.value as { ok: boolean; error?: string };
      if (!value.ok) throw new Error(value.error || "Cloud connection test failed");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function disconnect(providerId: CloudProviderId) {
    setWorking(true); setError(null);
    try { const result = await client.cloud({ action: "disconnect", provider: providerId }); if (!result.ok) throw new Error(result.error); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  function confirmDisconnect(providerId: CloudProviderId) {
    Alert.alert("Disconnect cloud provider?", `Remove the saved ${providerId === "e2b" ? "E2B" : "Vercel"} credentials from this Mac?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void disconnect(providerId) },
    ]);
  }

  async function handoff() {
    if (!sessionId) return;
    setWorking(true); setError(null); setProgress(null);
    try {
      if (!settings.experimentalEnabled) {
        const enabled = await client.cloud({ action: "updateSettings", patch: { experimentalEnabled: true } });
        if (!enabled.ok) throw new Error(enabled.error);
        setSettings(enabled.value as CloudSettingsPublic);
      }
      const result = await client.cloud({ action: "handoff", request: { cwd, provider, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), includeModelCredentials: includeCredentials } });
      if (!result.ok) throw new Error(result.error);
      const cloudSession = result.value as CloudSessionCatalogEntry;
      await onReattach(cwd, cloudSession.sessionId);
      onTargetChange?.("cloud");
      await load(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function returnLocal() {
    if (!current) return;
    setWorking(true); setError(null); setProgress(null);
    try {
      const result = await client.cloud({ action: "resumeLocal", sessionId: current.sessionId, keepCloudCopy });
      if (!result.ok) throw new Error(result.error);
      const value = result.value as { sessionId: string; cwd: string };
      await onReattach(value.cwd, value.sessionId);
      onTargetChange?.("local");
      await load(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function savePolicy() {
    await patchSettings({ allowedDomains: lines(allowedDomains), additionalExclusions: lines(exclusions) });
  }

  async function saveBinding() {
    if (!bindingLabel.trim() || !bindingValue) return;
    setWorking(true); setError(null);
    try {
      const result = await client.cloud({ action: "saveBinding", input: { label: bindingLabel.trim(), kind: "environment", value: bindingValue } });
      if (!result.ok) throw new Error(result.error);
      setSettings(result.value as CloudSettingsPublic); setBindingLabel(""); setBindingValue("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  async function recoveryAction(session: CloudSessionCatalogEntry) {
    setWorking(true); setError(null);
    try {
      const result = session.status === "lost"
        ? await client.cloud({ action: "recoverLost", sessionId: session.sessionId })
        : session.status === "handoff-interrupted"
          ? await client.cloud({ action: "reconnect", sessionId: session.sessionId })
          : await client.cloud({ action: "deleteCopy", sessionId: session.sessionId });
      if (!result.ok) throw new Error(result.error);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  function confirmRecoveryAction(session: CloudSessionCatalogEntry) {
    if (session.status === "lost" || session.status === "handoff-interrupted") { void recoveryAction(session); return; }
    Alert.alert("Delete cloud copy?", "This permanently removes the retained cloud sandbox. Your local session is not deleted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete copy", style: "destructive", onPress: () => void recoveryAction(session) },
    ]);
  }

  function removeBinding(id: string, label: string) {
    Alert.alert("Remove credential binding?", `Cloud sessions will no longer receive “${label}”.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void client.cloud({ action: "removeBinding", id }).then((result) => { if (result.ok) setSettings(result.value as CloudSettingsPublic); else setError(result.error); }) },
    ]);
  }

  return <Sheet open={open} onClose={working ? () => undefined : onClose} title={current ? "Cloud session" : "Local runtime"} icon={current ? "Cloud" : "Laptop"} heightRatio={0.96}>
    {loading ? <View style={s.center}><Spinner /><Txt variant="caption" color={colors.textSubtle}>Loading Cloud…</Txt></View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.route}><Runtime icon={current ? "Cloud" : "Laptop"} label="Current" value={current ? `${current.provider === "e2b" ? "E2B" : "Vercel"} Cloud` : "This Mac"} /><Icon name="ArrowRight" size={17} color={colors.textSubtle} /><Runtime icon={current ? "Laptop" : "Cloud"} label="Move to" value={current ? "This Mac" : provider === "e2b" ? "E2B Cloud" : "Vercel Cloud"} /></View>
      {current ? <>
        <Section title="Bring work back safely" subtitle="Cloud changes are verified before local files change. Divergence opens in a review worktree.">
          <Toggle label="Keep cloud sandbox" hint="Leave a suspended remote copy after this Mac takes over." value={keepCloudCopy} onChange={setKeepCloudCopy} />
          <Primary label={working ? "Verifying and syncing…" : "Verify and resume locally"} disabled={working} onPress={() => void returnLocal()} />
        </Section>
        <Section title="Cloud runtime" subtitle={`${current.provider === "e2b" ? "E2B" : "Vercel"} · ${current.status}`}><Meta label="Workspace" value={current.sourceRoot} /><Meta label="Sandbox" value={current.sandboxName || current.sandboxId} mono />{current.error ? <Txt variant="caption" color={colors.del}>{current.error}</Txt> : null}</Section>
      </> : <>
        <Section title="Cloud runtime" subtitle="Choose where Vibe keeps working with the same conversation and project.">
          <View style={s.providerRow}>{(["e2b", "vercel"] as CloudProviderId[]).map((id) => <Pressable key={id} onPress={() => setProvider(id)} style={[s.provider, provider === id && s.providerActive]}><View style={[s.radio, provider === id && { borderColor: colors.accent }]}>{provider === id ? <View style={s.radioDot} /> : null}</View><View style={{ flex: 1 }}><Txt variant="ui" weight="600">{id === "e2b" ? "E2B" : "Vercel"}</Txt><Txt variant="caption" color={colors.textSubtle}>{settings.providers[id].configured ? "Connected" : "Setup required"}</Txt></View></Pressable>)}</View>
          {!configured ? <Primary label={`Set up ${provider === "e2b" ? "E2B" : "Vercel"}`} onPress={() => setSetupProvider(provider)} /> : <View style={s.row}><Secondary label="Test connection" disabled={working} onPress={() => void testProvider(provider)} /><Secondary label="Disconnect" danger disabled={working} onPress={() => confirmDisconnect(provider)} /></View>}
        </Section>
        <Section title="Transfer boundary" subtitle="Conversation, project files, Git state, and portable jobs move. Machine credentials, SSH keys, generated dependencies, and Mac-only tools stay local.">
          <Toggle label="Include model access" hint={`Pass configured access for ${model || "the active model"}.`} value={includeCredentials} onChange={setIncludeCredentials} />
          <TextInput value={instruction} onChangeText={setInstruction} multiline placeholder="Next task in Cloud (optional)" placeholderTextColor={colors.textSubtle} style={[s.input, s.textarea]} />
          <Primary label={working ? progress?.message || "Starting Cloud…" : busy ? "Move when idle" : "Move session to Cloud"} disabled={working || !configured} onPress={() => void handoff()} />
          {!settings.experimentalEnabled ? <Txt variant="caption" color={colors.notice}>Continuing enables experimental Cloud for this Mac. You can turn it off again below.</Txt> : null}
        </Section>
      </>}
      {progress ? <Section title="Handoff progress" subtitle={progress.message}><View style={s.progress}><View style={[s.progressFill, { width: `${Math.round((progress.progress ?? 0.05) * 100)}%` }]} /></View><Txt variant="caption" color={colors.textSubtle}>{progress.stage || progress.status}</Txt></Section> : null}
      {error ? <View style={s.error}><Txt variant="ui" color={colors.del}>{error}</Txt></View> : null}
      <Section title="Cloud preferences" subtitle="These settings are shared with the desktop app.">
        <Toggle label="Enable experimental Cloud" value={settings.experimentalEnabled} onChange={(experimentalEnabled) => void patchSettings({ experimentalEnabled })} />
        <Toggle label="Include model access by default" value={settings.transferModelCredentials} onChange={(transferModelCredentials) => void patchSettings({ transferModelCredentials })} />
        <Toggle label="Delete sandbox after return" value={settings.deleteOnReturn} onChange={(deleteOnReturn) => void patchSettings({ deleteOnReturn })} />
        <View style={s.stepper}><View style={{ flex: 1 }}><Txt variant="ui">Idle auto-pause</Txt><Txt variant="caption" color={colors.textSubtle}>{settings.autoPauseMinutes} minutes</Txt></View><Secondary label="−" onPress={() => void patchSettings({ autoPauseMinutes: Math.max(1, settings.autoPauseMinutes - 5) })} /><Secondary label="+" onPress={() => void patchSettings({ autoPauseMinutes: Math.min(120, settings.autoPauseMinutes + 5) })} /></View>
      </Section>
      {sessions.some((session) => ["suspended", "cleanup-pending", "handoff-interrupted", "lost"].includes(session.status)) ? <Section title="Cloud recovery" subtitle="Resolve retained copies and interrupted ownership safely.">{sessions.filter((session) => ["suspended", "cleanup-pending", "handoff-interrupted", "lost"].includes(session.status)).map((session) => <View key={session.sessionId} style={s.recovery}><View style={{ flex: 1 }}><Txt variant="ui" weight="600" numberOfLines={1}>{session.sourceRoot}</Txt><Txt variant="caption" color={colors.textSubtle}>{session.provider} · {session.status}</Txt>{session.error ? <Txt variant="caption" color={colors.del}>{session.error}</Txt> : null}</View><Secondary label={session.status === "lost" ? "Recover" : session.status === "handoff-interrupted" ? "Retry" : "Delete copy"} danger={session.status !== "handoff-interrupted"} disabled={working} onPress={() => confirmRecoveryAction(session)} /></View>)}</Section> : null}
      <Pressable onPress={() => setAdvanced((value) => !value)} style={s.advancedHead}><Txt variant="ui" weight="600">Network, transfer, and credentials</Txt><Icon name={advanced ? "ChevronLeft" : "ChevronRight"} size={15} color={colors.textSubtle} /></Pressable>
      {advanced ? <>
        <Section title="Network and transfer" subtitle="One hostname or workspace-relative exclusion per line."><TextInput value={allowedDomains} onChangeText={setAllowedDomains} multiline placeholder="api.openai.com\ngithub.com" placeholderTextColor={colors.textSubtle} style={[s.input, s.textarea]} /><TextInput value={exclusions} onChangeText={setExclusions} multiline placeholder="fixtures/private\nlarge-models" placeholderTextColor={colors.textSubtle} style={[s.input, s.textarea]} /><Secondary label="Save policy" disabled={working} onPress={() => void savePolicy()} /></Section>
        <Section title="Credential bindings" subtitle="Explicitly expose narrowly scoped environment values to Cloud.">{settings.credentialBindings.map((binding) => <View key={binding.id} style={s.binding}><View style={{ flex: 1 }}><Txt variant="ui">{binding.label}</Txt><Txt variant="caption" color={colors.textSubtle}>{binding.ready ? "Ready" : "Missing"}</Txt></View><Secondary label="Remove" danger onPress={() => removeBinding(binding.id, binding.label)} /></View>)}<TextInput value={bindingLabel} onChangeText={setBindingLabel} placeholder="Binding name" placeholderTextColor={colors.textSubtle} style={s.input} /><TextInput value={bindingValue} onChangeText={setBindingValue} secureTextEntry placeholder="Secret value" placeholderTextColor={colors.textSubtle} style={s.input} /><Secondary label="Save binding" disabled={working || !bindingLabel.trim() || !bindingValue} onPress={() => void saveBinding()} /></Section>
      </> : null}
      {setupProvider ? <Section title={`Connect ${setupProvider === "e2b" ? "E2B" : "Vercel"}`} subtitle={setupProvider === "vercel" ? "Reuse the Mac’s Vercel CLI sign-in or paste a token. Vibe auto-detects a team and creates or reuses the default Sandbox project; IDs are optional overrides." : "Credentials are encrypted in the Mac’s existing Cloud store and never shown again."}>{setupProvider === "e2b" ? <TextInput value={e2bKey} onChangeText={setE2bKey} secureTextEntry placeholder="E2B API key" placeholderTextColor={colors.textSubtle} style={s.input} /> : <><TextInput value={vercelToken} onChangeText={setVercelToken} secureTextEntry placeholder="Access token (optional)" placeholderTextColor={colors.textSubtle} style={s.input} /><TextInput value={vercelTeam} onChangeText={setVercelTeam} placeholder="Team ID (optional)" placeholderTextColor={colors.textSubtle} style={s.input} /><TextInput value={vercelProject} onChangeText={setVercelProject} placeholder="Project ID (optional)" placeholderTextColor={colors.textSubtle} style={s.input} /></>}<View style={s.row}><Secondary label="Cancel" onPress={() => setSetupProvider(null)} /><Primary label={working ? "Finding workspace and testing…" : setupProvider === "vercel" && !vercelToken.trim() ? "Use Vercel CLI session" : "Connect and test"} disabled={working || (setupProvider === "e2b" ? !e2bKey.trim() : !!vercelProject.trim() && !vercelTeam.trim())} onPress={() => void connect(setupProvider)} /></View></Section> : null}
    </ScrollView>}
  </Sheet>;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) { const { colors } = useTheme(); const s = makeStyles(colors); return <View style={s.section}><View><Txt variant="title">{title}</Txt>{subtitle ? <Txt variant="caption" color={colors.textSubtle} style={{ marginTop: 2 }}>{subtitle}</Txt> : null}</View>{children}</View>; }
function Runtime({ icon, label, value }: { icon: "Cloud" | "Laptop"; label: string; value: string }) { const { colors } = useTheme(); const s = makeStyles(colors); return <View style={s.runtime}><Icon name={icon} size={17} color={colors.accent} /><View><Txt variant="micro" color={colors.textSubtle}>{label.toUpperCase()}</Txt><Txt variant="ui" weight="600">{value}</Txt></View></View>; }
function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void }) { const { colors } = useTheme(); const s = makeStyles(colors); return <Pressable onPress={() => onChange(!value)} style={s.toggleRow}><View style={{ flex: 1 }}><Txt variant="ui">{label}</Txt>{hint ? <Txt variant="caption" color={colors.textSubtle}>{hint}</Txt> : null}</View><View style={[s.toggle, value && { backgroundColor: colors.accent, borderColor: colors.accent }]}><View style={[s.knob, value && { transform: [{ translateX: 16 }] }]} /></View></Pressable>; }
function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) { const { colors } = useTheme(); return <View style={{ flexDirection: "row", gap: T.sSm }}><Txt variant="caption" color={colors.textSubtle} style={{ width: 74 }}>{label}</Txt><Txt variant="caption" mono={mono} style={{ flex: 1 }} numberOfLines={2}>{value}</Txt></View>; }
function Primary({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) { const { colors } = useTheme(); return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ minHeight: 42, paddingHorizontal: T.sBase, alignItems: "center", justifyContent: "center", borderRadius: T.radius, backgroundColor: colors.accent, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}><Txt variant="ui" weight="600" color={colors.bg}>{label}</Txt></Pressable>; }
function Secondary({ label, onPress, disabled, danger }: { label: string; onPress?: () => void; disabled?: boolean; danger?: boolean }) { const { colors } = useTheme(); return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ minHeight: 36, paddingHorizontal: T.sSm, alignItems: "center", justifyContent: "center", borderRadius: T.radiusSm, borderWidth: 1, borderColor: danger ? colors.del : colors.borderSoft, backgroundColor: danger ? colors.delBg : colors.surfaceSubtle, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}><Txt variant="caption" weight="600" color={danger ? colors.del : colors.textSecondary}>{label}</Txt></Pressable>; }
function lines(value: string) { return value.split("\n").map((line) => line.trim()).filter(Boolean); }

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) { return StyleSheet.create({
  center: { minHeight: 240, alignItems: "center", justifyContent: "center", gap: T.sXs },
  content: { padding: T.sBase, gap: T.sMd, paddingBottom: T.s2xl },
  route: { flexDirection: "row", alignItems: "center", gap: T.sXs },
  runtime: { flex: 1, minHeight: 58, flexDirection: "row", alignItems: "center", gap: T.sXs, padding: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.elevated },
  section: { gap: T.sSm, padding: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.elevated },
  providerRow: { gap: T.sXs },
  provider: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: T.sXs, padding: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.surfaceSubtle },
  providerActive: { borderColor: colors.borderActive, backgroundColor: colors.navActiveBg },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  input: { minHeight: 42, paddingHorizontal: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusSm, backgroundColor: colors.surfaceSubtle, color: colors.assistant, fontSize: T.textUi },
  textarea: { minHeight: 84, paddingTop: T.sSm, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: T.sXs, flexWrap: "wrap" },
  toggleRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: T.sSm },
  toggle: { width: 38, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceSubtle, padding: 2 },
  knob: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.assistant },
  stepper: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: T.sXs },
  progress: { height: 5, borderRadius: 3, backgroundColor: colors.surfaceSubtle, overflow: "hidden" },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: colors.accent },
  error: { padding: T.sSm, borderRadius: T.radiusMd, backgroundColor: colors.delBg },
  recovery: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingVertical: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  advancedHead: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd },
  binding: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: T.sXs },
}); }
