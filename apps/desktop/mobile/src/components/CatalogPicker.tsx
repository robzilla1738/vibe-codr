// Catalog picker — the native analog of the desktop CatalogModal. Opens while
// the composer draft is `/model`, `/providers`, `/agents`, `/skills`, or `/mcp`.
// Fetches the live catalog over RPC and builds options with the SAME shared
// builders the desktop uses (modelCatalogOptions, providerCatalogOptions, …),
// so grouping, "current" markers, and Free badges are identical. Picking sends
// the option's EngineCommand (or slash line / prefill) — same paths as desktop.
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, Text, FlatList, Pressable } from "react-native";
import { Sheet } from "./Sheet";
import { Icon } from "./icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/ThemeProvider";
import { staticTokens as T } from "../theme/tokens";
import { Txt, Spinner, Card } from "./primitives";
import {
  modelPicker, providersPickerQuery, agentsPickerQuery, skillsPickerFilter, mcpPickerQuery,
  modelCatalogOptions, providerCatalogOptions, agentCatalogOptions, skillCatalogOptions, mcpCatalogOptions,
  currentModelForTarget, limitCatalogOptions, isSectionOption, type CatalogOption, type ModelPickerTarget,
} from "@shared/catalog-draft";
import type { EngineCommand } from "@shared/commands";
import type { ModelSummary, ProviderInfo, AgentInfo, SkillInfo, McpServerInfo } from "@shared/types";
import type { SessionChrome } from "@hooks/session-state";
import type { RemoteEngineClient } from "../remote/RemoteEngineClient";

type Kind = "model" | "providers" | "agents" | "skills" | "mcp";

interface Props {
  draft: string;
  chrome: SessionChrome;
  client: RemoteEngineClient;
  onSendCommand: (c: EngineCommand) => Promise<boolean>;
  onSendSlash: (line: string) => Promise<boolean>;
  onPrefill: (text: string) => void;
  onClose: () => void;
}

function detect(draft: string): { kind: Kind; query: string; target: ModelPickerTarget } | null {
  const mp = modelPicker(draft);
  if (mp) return { kind: "model", query: mp.query, target: mp.target };
  const pp = providersPickerQuery(draft); if (pp != null) return { kind: "providers", query: pp, target: "main" };
  const ap = agentsPickerQuery(draft); if (ap != null) return { kind: "agents", query: ap, target: "main" };
  const sp = skillsPickerFilter(draft); if (sp != null) return { kind: "skills", query: sp, target: "main" };
  const mc = mcpPickerQuery(draft); if (mc != null) return { kind: "mcp", query: mc, target: "main" };
  return null;
}

export function CatalogPicker({ draft, chrome, client, onSendCommand, onSendSlash, onPrefill, onClose }: Props) {
  const { colors } = useTheme();
  const det = useMemo(() => detect(draft), [draft]);
  const [options, setOptions] = useState<CatalogOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!det) { setOptions([]); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        let opts: CatalogOption[] = [];
        if (det.kind === "model") {
          const items = (await client.rpc("listModels")) as ModelSummary[];
          const current = currentModelForTarget(det.target, chrome.model, chrome.subagentModel, []);
          opts = modelCatalogOptions(items ?? [], det.target, current);
        } else if (det.kind === "providers") {
          const items = (await client.rpc("listProviders")) as ProviderInfo[];
          opts = providerCatalogOptions(items ?? []);
        } else if (det.kind === "agents") {
          const items = (await client.rpc("listAgents")) as AgentInfo[];
          opts = agentCatalogOptions(items ?? []);
        } else if (det.kind === "skills") {
          const items = (await client.rpc("listSkills")) as SkillInfo[];
          opts = skillCatalogOptions(items ?? []);
        } else if (det.kind === "mcp") {
          const items = (await client.rpc("listMcp")) as McpServerInfo[];
          opts = mcpCatalogOptions(items ?? []);
        }
        const q = det.query.trim().toLowerCase();
        const filtered = q ? opts.filter((o) => isSectionOption(o) || o.primary.toLowerCase().includes(q) || o.secondary.toLowerCase().includes(q)) : opts;
        if (!cancelled) { setOptions(limitCatalogOptions(filtered).options); setLoading(false); }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [det, client, chrome.model, chrome.subagentModel]);

  if (!det) return null;
  const s = makeStyles(colors);

  async function pick(opt: CatalogOption) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (opt.command) { await onSendCommand(opt.command); onClose(); return; }
    if (opt.line) { await onSendSlash(opt.line); onClose(); return; }
    if (opt.prefill) { onPrefill(opt.prefill); return; }
    if (opt.setupProviderId) { onPrefill(`/providers ${opt.setupProviderId}`); return; }
    if (opt.openModelsForAgent) { onPrefill(`/model agent ${opt.openModelsForAgent} `); return; }
  }

  return (
    <Sheet open={!!det} onClose={onClose} title={`/${det.kind}`} icon="Search" maxHeightRatio={0.7}>
      {det.query ? <Txt variant="caption" color={colors.textSubtle} style={{ paddingHorizontal: T.sBase, paddingTop: T.sXs }}>filter: {det.query}</Txt> : null}
      {loading ? <View style={s.center}><Spinner /></View> :
       error ? <View style={s.center}><Txt variant="ui" color={colors.del}>{error}</Txt></View> :
       options.length === 0 ? <View style={s.center}><Txt variant="ui" color={colors.textSubtle}>No matches</Txt></View> :
        <FlatList
          data={options}
          keyExtractor={(o) => o.key}
          renderItem={({ item }) => (
            <Pressable disabled={isSectionOption(item)} onPress={() => pick(item)} style={({ pressed }) => [s.row, isSectionOption(item) && s.rowStatic, pressed && !isSectionOption(item) && s.rowPressed, item.current && s.rowSelected]}>
              {isSectionOption(item) ? (
                <Txt variant="caption" color={colors.textSubtle} style={[s.section, { fontWeight: "600" }]}>{item.primary}</Txt>
              ) : (
                <View style={{ flex: 1 }}>
                  <View style={s.optRow}>
                    <Text style={[s.primary, { color: item.current ? colors.selFg : colors.assistant }]} numberOfLines={1}>{item.primary}</Text>
                    {item.free ? <Text style={s.free}>Free</Text> : null}
                    {item.current ? <Text style={s.current}>current</Text> : null}
                  </View>
                  {item.secondary ? <Text style={s.secondary} numberOfLines={1}>{item.secondary}</Text> : null}
                </View>
              )}
            </Pressable>
          )}
        />}
    </Sheet>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
    scrimHit: { flex: 1 },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: T.radiusXl, borderTopRightRadius: T.radiusXl, borderWidth: 1, borderColor: colors.borderSoft, paddingHorizontal: T.sBase, paddingTop: T.sXs },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center", marginBottom: T.sXs },
    head: { flexDirection: "row", alignItems: "center", gap: T.sSm, marginBottom: T.sXs },
    center: { paddingVertical: T.s2xl, alignItems: "center" },
    row: { paddingVertical: T.s2xs, paddingHorizontal: T.sXs, borderRadius: T.radiusSm, gap: 2 },
    rowStatic: { backgroundColor: "transparent" },
    rowPressed: { backgroundColor: colors.surfaceSubtle },
    rowSelected: { backgroundColor: colors.selBg, borderWidth: 1, borderColor: colors.selFg },
    section: { paddingVertical: T.sSm, paddingHorizontal: T.sXs, color: colors.textSubtle },
    optRow: { flexDirection: "row", alignItems: "center", gap: T.sXs },
    primary: { fontFamily: undefined, fontSize: T.textUi, fontWeight: "400", letterSpacing: 0, lineHeight: T.textUi * T.leadingUi },
    secondary: { color: colors.textSubtle, fontSize: T.textCaption, lineHeight: T.textCaption * T.leadingUi },
    current: { color: colors.textSubtle, fontSize: T.textMicro, fontWeight: "600", letterSpacing: T.trackingUi },
    free: { color: colors.add, fontSize: T.textMicro, fontWeight: "600" },
  });
}
