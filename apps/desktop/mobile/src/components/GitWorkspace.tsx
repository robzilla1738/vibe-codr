import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { GitBranch, GitFullStatus, GitStatusEntry } from "@shared/git-types";
import type { GitRelayRequest } from "@relay/protocol";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Icon } from "./icons";
import { Spinner, Txt } from "./primitives";

type Tab = "branches" | "changes" | "history" | "remotes" | "prs";

export function GitWorkspace({ client, cwd }: { client: RemoteEngineClient; cwd: string }) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [tab, setTab] = useState<Tab>("branches");
  const [status, setStatus] = useState<GitFullStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await client.git({ action: "status", cwd });
      if (!result.ok) throw new Error(result.error);
      if (!("status" in result)) throw new Error("Git status response was incomplete.");
      setStatus(result.status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [client, cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = useCallback(async (request: GitRelayRequest, fallback: string) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await client.git(request);
      if (!result.ok) throw new Error(result.error);
      setMessage(("message" in result && result.message) || fallback);
      await refresh(true);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  if (loading) return <View style={s.center}><Spinner /><Txt variant="caption" color={colors.textSubtle}>Loading repository…</Txt></View>;
  if (!status) return <View style={s.center}><Icon name="GitBranch" size={22} color={colors.textSubtle} /><Txt variant="ui" color={colors.textSubtle}>{error || "This project is not a Git repository."}</Txt><SmallButton label="Retry" onPress={() => void refresh()} /></View>;

  return (
    <View style={{ gap: T.sSm }}>
      <View style={s.summary}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt variant="title" mono numberOfLines={1}>{status.branch}</Txt>
          <Txt variant="caption" color={colors.textSubtle}>{status.clean ? "Clean working tree" : `${status.entries.length} changed · ${status.stagedCount} staged`}{status.ahead ? ` · ↑${status.ahead}` : ""}{status.behind ? ` · ↓${status.behind}` : ""}</Txt>
        </View>
        <Pressable accessibilityLabel="Refresh Git status" disabled={busy} onPress={() => void refresh()} style={s.iconButton}><Icon name="RotateCcw" size={15} color={colors.textSecondary} /></Pressable>
      </View>
      <View style={s.syncRow}>
        <SmallButton label="Fetch" disabled={busy} onPress={() => void run({ action: "fetch", request: { cwd } }, "Fetched latest")} />
        <SmallButton label="Pull" disabled={busy} onPress={() => void run({ action: "pull", request: { cwd } }, "Pulled latest")} />
        <SmallButton label="Push" disabled={busy} onPress={() => void run({ action: "push", request: { cwd } }, "Pushed branch")} />
      </View>
      {message ? <View style={s.success}><Icon name="Check" size={13} color={colors.add} /><Txt variant="caption" color={colors.add}>{message}</Txt></View> : null}
      {error ? <View style={s.error}><Txt variant="caption" color={colors.del}>{error}</Txt></View> : null}
      <View style={s.tabs}>
        {(["branches", "changes", "history", "remotes", "prs"] as Tab[]).map((value) => (
          <Pressable key={value} onPress={() => setTab(value)} style={[s.tab, tab === value && s.tabActive]}>
            <Txt variant="caption" color={tab === value ? colors.accent : colors.textSecondary} style={{ textTransform: "capitalize" }}>{value === "prs" ? "PRs" : value}</Txt>
            {value === "changes" && status.entries.length ? <View style={s.count}><Txt variant="micro" color={colors.textSecondary}>{status.entries.length}</Txt></View> : null}
          </Pressable>
        ))}
      </View>
      {tab === "branches" ? <Branches status={status} cwd={cwd} busy={busy} run={run} /> : null}
      {tab === "changes" ? <Changes status={status} cwd={cwd} busy={busy} run={run} /> : null}
      {tab === "history" ? <History status={status} /> : null}
      {tab === "remotes" ? <Remotes status={status} /> : null}
      {tab === "prs" ? <PullRequests client={client} cwd={cwd} /> : null}
    </View>
  );
}

function Branches({ status, cwd, busy, run }: { status: GitFullStatus; cwd: string; busy: boolean; run: (request: GitRelayRequest, fallback: string) => Promise<boolean> }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const local = status.branches.filter((branch) => !branch.remote);
  const remote = status.branches.filter((branch) => branch.remote);
  async function create() {
    const branch = name.trim(); if (!branch) return;
    if (await run({ action: "createBranch", request: { cwd, name: branch, checkout: true } }, `Created ${branch}`)) { setName(""); setCreating(false); }
  }
  return (
    <View style={{ gap: T.sXs }}>
      <View style={s.sectionHead}><Txt variant="label" color={colors.textSubtle}>LOCAL BRANCHES</Txt><SmallButton label={creating ? "Cancel" : "New branch"} onPress={() => setCreating((value) => !value)} /></View>
      {creating ? <View style={s.createRow}><TextInput value={name} onChangeText={setName} autoFocus autoCapitalize="none" autoCorrect={false} placeholder="branch-name" placeholderTextColor={colors.textSubtle} style={s.input} onSubmitEditing={() => void create()} /><SmallButton label="Create" primary disabled={!name.trim() || busy} onPress={() => void create()} /></View> : null}
      <View style={s.list}>
        {local.map((branch) => <BranchRow key={branch.name} branch={branch} busy={busy} confirming={deleteName === branch.name} onPick={() => { if (!branch.current) void run({ action: "checkout", request: { cwd, name: branch.name } }, `Switched to ${branch.name}`); }} onDelete={() => setDeleteName(branch.name)} onCancel={() => setDeleteName(null)} onConfirm={() => void run({ action: "deleteBranch", request: { cwd, name: branch.name } }, `Deleted ${branch.name}`).then((ok) => { if (ok) setDeleteName(null); })} />)}
      </View>
      {remote.length ? <><Txt variant="label" color={colors.textSubtle} style={{ marginTop: T.sXs }}>REMOTE BRANCHES</Txt><View style={s.list}>{remote.map((branch) => <BranchRow key={branch.name} branch={branch} busy={busy} onPick={() => void run({ action: "checkout", request: { cwd, name: branch.name, track: true } }, `Tracking ${branch.name}`)} />)}</View></> : null}
    </View>
  );
}

function BranchRow({ branch, busy, confirming, onPick, onDelete, onCancel, onConfirm }: { branch: GitBranch; busy: boolean; confirming?: boolean; onPick: () => void; onDelete?: () => void; onCancel?: () => void; onConfirm?: () => void }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  return <View style={s.branchRow}><Pressable disabled={busy || branch.current} onPress={onPick} style={({ pressed }) => [s.branchMain, pressed && { opacity: 0.6 }]}><View style={[s.branchDot, { backgroundColor: branch.current ? colors.accent : "transparent", borderColor: branch.current ? colors.accent : colors.borderStrong }]} /><View style={{ flex: 1, minWidth: 0 }}><Txt variant="ui" mono numberOfLines={1} color={branch.current ? colors.accent : colors.assistant}>{branch.name}</Txt>{branch.lastSubject ? <Txt variant="caption" color={colors.textSubtle} numberOfLines={1}>{branch.lastSubject}</Txt> : null}</View>{branch.ahead ? <Txt variant="caption" color={colors.add}>↑{branch.ahead}</Txt> : null}{branch.behind ? <Txt variant="caption" color={colors.notice}>↓{branch.behind}</Txt> : null}</Pressable>{!branch.current && onDelete ? confirming ? <View style={s.confirm}><SmallButton label="Keep" onPress={onCancel!} /><SmallButton label="Delete" danger onPress={onConfirm!} /></View> : <Pressable accessibilityLabel={`Delete ${branch.name}`} onPress={onDelete} style={s.iconButton}><Icon name="Trash2" size={14} color={colors.textSubtle} /></Pressable> : null}</View>;
}

function Changes({ status, cwd, busy, run }: { status: GitFullStatus; cwd: string; busy: boolean; run: (request: GitRelayRequest, fallback: string) => Promise<boolean> }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const [commitMessage, setCommitMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const groups = useMemo(() => ({
    staged: status.entries.filter((entry) => entry.index !== " " && entry.index !== "?"),
    unstaged: status.entries.filter((entry) => entry.working !== " " && entry.working !== "?"),
    untracked: status.entries.filter((entry) => entry.index === "?"),
  }), [status.entries]);
  if (status.clean) return <View style={s.center}><Icon name="Check" size={20} color={colors.add} /><Txt variant="ui" color={colors.textSecondary}>Working tree is clean.</Txt></View>;
  async function commitChanges(amend = false) {
    const value = commitMessage.trim(); if (!value) return;
    if (await run({ action: "commit", request: { cwd, message: value, amend } }, amend ? "Amended commit" : "Committed")) setCommitMessage("");
  }
  return <View style={{ gap: T.sSm }}>
    <View style={s.syncRow}><SmallButton label="Stage all" disabled={busy} onPress={() => void run({ action: "stage", request: { cwd, all: true, allIncludingUntracked: includeUntracked } }, "Staged changes")} /><SmallButton label="Unstage all" disabled={busy || !groups.staged.length} onPress={() => void run({ action: "unstage", request: { cwd } }, "Unstaged changes")} /></View>
    <Pressable onPress={() => setIncludeUntracked((value) => !value)} style={s.checkRow}><View style={[s.checkbox, includeUntracked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>{includeUntracked ? <Icon name="Check" size={11} color={colors.bg} /> : null}</View><Txt variant="caption" color={colors.textSecondary}>Include untracked files</Txt></Pressable>
    <ChangeGroup title="STAGED" entries={groups.staged} action="−" onAction={(path) => void run({ action: "unstage", request: { cwd, paths: [path] } }, `Unstaged ${path}`)} />
    <ChangeGroup title="UNSTAGED" entries={groups.unstaged} action="+" onAction={(path) => void run({ action: "stage", request: { cwd, paths: [path] } }, `Staged ${path}`)} />
    <ChangeGroup title="UNTRACKED" entries={groups.untracked} action="+" onAction={(path) => void run({ action: "stage", request: { cwd, paths: [path] } }, `Staged ${path}`)} />
    <TextInput value={commitMessage} onChangeText={setCommitMessage} multiline placeholder="Commit message…" placeholderTextColor={colors.textSubtle} style={[s.input, s.commitInput]} />
    <View style={s.syncRow}><SmallButton label="Commit" primary disabled={busy || !commitMessage.trim()} onPress={() => void commitChanges()} /><SmallButton label="Amend" disabled={busy || !commitMessage.trim()} onPress={() => void commitChanges(true)} /></View>
  </View>;
}

function ChangeGroup({ title, entries, action, onAction }: { title: string; entries: GitStatusEntry[]; action: string; onAction: (path: string) => void }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  if (!entries.length) return null;
  return <View><Txt variant="label" color={colors.textSubtle} style={{ marginBottom: T.s2xs }}>{title} · {entries.length}</Txt><View style={s.list}>{entries.map((entry, index) => <View key={`${entry.path}-${index}`} style={s.fileRow}><Text style={[s.statusCode, { color: entry.index === "?" ? colors.notice : colors.tool }]}>{entry.index === "?" ? "?" : entry.index !== " " ? entry.index : entry.working}</Text><Txt variant="caption" mono style={{ flex: 1 }} numberOfLines={2}>{entry.path}</Txt><Pressable onPress={() => onAction(entry.path)} style={s.fileAction}><Txt variant="title" color={colors.accent}>{action}</Txt></Pressable></View>)}</View></View>;
}

function History({ status }: { status: GitFullStatus }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  return <View style={s.list}>{status.recentCommits.map((commit) => <View key={commit.hash} style={s.commitRow}><Txt variant="caption" mono color={colors.accent}>{commit.shortHash}</Txt><View style={{ flex: 1, minWidth: 0 }}><Txt variant="ui" numberOfLines={2}>{commit.subject}</Txt><Txt variant="caption" color={colors.textSubtle}>{commit.author} · {relativeTime(commit.date)}</Txt></View></View>)}</View>;
}

function Remotes({ status }: { status: GitFullStatus }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  if (!status.remotes.length) return <Txt variant="ui" color={colors.textSubtle}>No remotes configured.</Txt>;
  return <View style={s.list}>{status.remotes.map((remote) => <View key={remote.name} style={s.remoteRow}><Icon name="Cloud" size={15} color={colors.tool} /><View style={{ flex: 1, minWidth: 0 }}><Txt variant="ui" weight="600">{remote.name}</Txt><Txt variant="caption" mono color={colors.textSubtle} numberOfLines={2}>{remote.url}</Txt>{remote.host ? <Txt variant="caption" color={colors.textSecondary}>{remote.host}{remote.owner && remote.repo ? ` · ${remote.owner}/${remote.repo}` : ""}</Txt> : null}</View></View>)}</View>;
}

function PullRequests({ client, cwd }: { client: RemoteEngineClient; cwd: string }) {
  const { colors } = useTheme(); const s = makeStyles(colors);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [prs, setPrs] = useState<Array<{ number: number; title: string; state: string; head: string; url: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const check = await client.git({ action: "ghAvailable", cwd });
      if (!check.ok) throw new Error(check.error);
      const installed = "available" in check && check.available;
      setAvailable(installed);
      if (!installed) return;
      const result = await client.git({ action: "prList", cwd });
      if (!result.ok) throw new Error(result.error);
      if (!("prs" in result)) throw new Error("Pull-request response was incomplete.");
      setPrs(result.prs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  }, [client, cwd]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    const prTitle = title.trim(); if (!prTitle) return;
    setCreating(true); setError(null);
    try {
      const result = await client.git({ action: "prCreate", request: { cwd, title: prTitle, ...(body.trim() ? { body: body.trim() } : {}), ...(base.trim() ? { base: base.trim() } : {}), draft } });
      if (!result.ok) throw new Error(result.error);
      const url = "url" in result ? result.url : undefined;
      setShowCreate(false); setTitle(""); setBody(""); setBase(""); setDraft(false);
      await load();
      if (url) await Linking.openURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCreating(false); }
  }

  if (loading) return <View style={s.center}><Spinner /><Txt variant="caption" color={colors.textSubtle}>Loading pull requests…</Txt></View>;
  if (available === false) return <View style={s.center}><Txt variant="ui" color={colors.textSecondary}>GitHub CLI is not available on your Mac.</Txt><Txt variant="caption" color={colors.textSubtle}>Install and authenticate `gh` to manage pull requests here.</Txt></View>;
  return <View style={{ gap: T.sSm }}>
    <View style={s.sectionHead}><Txt variant="label" color={colors.textSubtle}>PULL REQUESTS</Txt><SmallButton label={showCreate ? "Cancel" : "New PR"} onPress={() => setShowCreate((value) => !value)} /></View>
    {error ? <View style={s.error}><Txt variant="caption" color={colors.del}>{error}</Txt></View> : null}
    {showCreate ? <View style={s.prForm}>
      <TextInput value={title} onChangeText={setTitle} placeholder="Pull request title" placeholderTextColor={colors.textSubtle} style={s.input} />
      <TextInput value={body} onChangeText={setBody} placeholder="Description (optional)" placeholderTextColor={colors.textSubtle} multiline style={[s.input, s.commitInput]} />
      <TextInput value={base} onChangeText={setBase} placeholder="Base branch (optional)" placeholderTextColor={colors.textSubtle} autoCapitalize="none" autoCorrect={false} style={s.input} />
      <Pressable onPress={() => setDraft((value) => !value)} style={s.checkRow}><View style={[s.checkbox, draft && { backgroundColor: colors.accent, borderColor: colors.accent }]}>{draft ? <Icon name="Check" size={11} color={colors.bg} /> : null}</View><Txt variant="caption" color={colors.textSecondary}>Create as draft</Txt></Pressable>
      <SmallButton label={creating ? "Creating…" : "Create pull request"} primary disabled={creating || !title.trim()} onPress={() => void create()} />
    </View> : null}
    <View style={s.list}>{prs.length ? prs.map((pr) => <Pressable key={pr.number} onPress={() => void Linking.openURL(pr.url)} style={({ pressed }) => [s.prRow, pressed && { opacity: 0.65 }]}><View style={{ flex: 1, minWidth: 0 }}><Txt variant="ui" numberOfLines={2}>{pr.title}</Txt><Txt variant="caption" color={colors.textSubtle}>#{pr.number} · {pr.head} · {pr.state.toLowerCase()}</Txt></View><Icon name="ExternalLink" size={14} color={colors.textSubtle} /></Pressable>) : <View style={{ padding: T.sSm }}><Txt variant="ui" color={colors.textSubtle}>No open pull requests.</Txt></View>}</View>
  </View>;
}

function SmallButton({ label, onPress, disabled, primary, danger }: { label: string; onPress?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  const { colors } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ height: 34, paddingHorizontal: T.sSm, alignItems: "center", justifyContent: "center", borderRadius: T.radiusSm, borderWidth: 1, borderColor: danger ? colors.del : primary ? colors.accent : colors.borderSoft, backgroundColor: danger ? colors.delBg : primary ? colors.accent : colors.surfaceSubtle, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 }]}><Txt variant="caption" weight="600" color={danger ? colors.del : primary ? colors.bg : colors.textSecondary}>{label}</Txt></Pressable>;
}

function relativeTime(ms: number) { const minutes = Math.floor((Date.now() - ms) / 60000); if (minutes < 1) return "now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    center: { minHeight: 180, alignItems: "center", justifyContent: "center", gap: T.sXs },
    summary: { flexDirection: "row", alignItems: "center", gap: T.sXs, paddingBottom: T.sXs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    syncRow: { flexDirection: "row", gap: T.sXs, flexWrap: "wrap" },
    iconButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: T.radiusSm },
    success: { flexDirection: "row", alignItems: "center", gap: T.s2xs, paddingHorizontal: T.sXs, paddingVertical: T.s2xs, backgroundColor: colors.addBg, borderRadius: T.radiusSm },
    error: { paddingHorizontal: T.sXs, paddingVertical: T.sXs, backgroundColor: colors.delBg, borderRadius: T.radiusSm },
    tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    tab: { flex: 1, minHeight: 36, flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabActive: { borderBottomColor: colors.accent },
    count: { minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.surfaceSubtle },
    sectionHead: { minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    createRow: { flexDirection: "row", alignItems: "center", gap: T.sXs },
    input: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusSm, backgroundColor: colors.surfaceSubtle, paddingHorizontal: T.sSm, color: colors.assistant, fontSize: T.textUi, fontFamily: "SF Mono" },
    commitInput: { minHeight: 84, paddingTop: T.sSm, textAlignVertical: "top", fontFamily: undefined },
    list: { borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, overflow: "hidden", backgroundColor: colors.elevated },
    branchRow: { minHeight: 52, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    branchMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingHorizontal: T.sSm, paddingVertical: T.sXs },
    branchDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1 },
    confirm: { flexDirection: "row", gap: 2, paddingRight: T.s2xs },
    checkRow: { flexDirection: "row", alignItems: "center", gap: T.sXs },
    checkbox: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
    fileRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: T.sXs, paddingLeft: T.sSm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    statusCode: { width: 14, fontFamily: "SF Mono", fontSize: T.textCaption, fontWeight: "600" },
    fileAction: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    commitRow: { flexDirection: "row", alignItems: "flex-start", gap: T.sSm, padding: T.sSm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    remoteRow: { flexDirection: "row", alignItems: "flex-start", gap: T.sSm, padding: T.sSm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
    prForm: { gap: T.sXs, padding: T.sSm, borderWidth: 1, borderColor: colors.borderSoft, borderRadius: T.radiusMd, backgroundColor: colors.elevated },
    prRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: T.sXs, padding: T.sSm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  });
}
