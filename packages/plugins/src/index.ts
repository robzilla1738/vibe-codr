export { HookBus } from "./hooks.ts";
export type { HookName, HookHandler, HookPayloads } from "./hooks.ts";
export {
  CommandRegistry,
  isSlashCommandName,
  parseSlash,
  type SlashCommand,
  type SlashResult,
} from "./commands.ts";
export {
  SkillRegistry,
  parseSkillMarkdown,
  parseFrontmatterBool,
  type Skill,
} from "./skills.ts";
export {
  PluginHost,
  type Plugin,
  type PluginApi,
  type PluginHostDeps,
  type PluginStatus,
} from "./plugin.ts";
export {
  parsePluginManifest,
  manifestCompatibilityError,
  type PluginManifestV1,
  type PluginContributionType,
  type PluginCapability,
  type PluginCapabilityType,
  PLUGIN_API_VERSION,
  PLUGIN_CONTRIBUTION_TYPES,
  PLUGIN_CAPABILITY_TYPES,
} from "./manifest.ts";
export {
  verifyCatalogIndex,
  canonicalCatalogBytes,
  type CatalogEntryV1,
  type CatalogEntryKind,
  type CatalogArtifactSource,
  type VerifiedCatalogV1,
  type TrustedCatalogKeys,
} from "./catalog.ts";
export {
  ExtensionLifecycleStore,
  type InstalledExtensionV1,
  type InstalledExtensionVersionV1,
} from "./lifecycle.ts";
