// workspace-config topic (additive V4 addition): live source of workspace-level configuration catalogs.
// Background: in the old protocol, provider-registry/model-catalog updates were sent per session through
// `state.updated` (settings patches), then the host's zcodeTaskIndexSyncer converted them to
// workspace_config_options_update broadcasts for the UI. The old session/subscribe + state.updated
// vocabulary does not carry configuration catalogs, so they now use this topic.
// Semantics: conflated latest state (like sessions-index), carrying workspace-level config and slash-command catalogs.
// This is workspace-level, not session-level. Session-level current selections live in `config` on the
// conversation topic (sessionConfigStateSchema); currentValue here represents the workspace default.
// Evolution rule: additive changes are allowed (new topics and optional fields); changing existing
// field shapes is not.
import { z } from "zod";

// Matches the host-side ZCodeConfigSelectValue (zcode-task-types-core): the syncer forwards
// workspace_config_options_update without mapping, so downstream useZCodeConfig consumers need no changes.
export const workspaceConfigSelectValueSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // Value source: native model catalog or a session-injected option (used by the UI for deduplication and display).
  origin: z.enum(["native", "injected"]).optional(),
  // Provider/group ID for the model option (provider → model group selection).
  modelProviderId: z.string().optional(),
  modelProviderName: z.string().optional(),
  // Missing means this is an older payload or capabilities are unknown; an empty array means the catalog
  // is known to have no selectable reasoning levels.
  modelThoughtLevels: z.array(z.string()).optional(),
  modelDefaultThoughtLevel: z.string().optional(),
});
export type WorkspaceConfigSelectValue = z.infer<typeof workspaceConfigSelectValueSchema>;

// Matches the host-side ZCodeConfigOption shape (id: model / mode / thought_level / custom).
export const workspaceConfigOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["select", "boolean"]),
  currentValue: z.union([z.string(), z.boolean()]),
  options: z.array(workspaceConfigSelectValueSchema).optional(),
});
export type WorkspaceConfigOption = z.infer<typeof workspaceConfigOptionSchema>;

// Workspace-level slash-command catalog; matches the host-side ZCodeSlashCommand shape.
export const workspaceSlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputHint: z.string().optional(),
  source: z.enum(["builtin", "custom"]).optional(),
});
export type WorkspaceSlashCommand = z.infer<typeof workspaceSlashCommandSchema>;

// Topic payload: replace the whole value (conflated latest state); never deep-merge, following the same rule.
export const workspaceConfigStateSchema = z.object({
  configOptions: z.array(workspaceConfigOptionSchema),
  slashCommands: z.array(workspaceSlashCommandSchema),
});
export type WorkspaceConfigState = z.infer<typeof workspaceConfigStateSchema>;

export const workspaceConfigSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level configuration log generation; shaped like sessions-index logEpoch but independent of it.
  logEpoch: z.string(),
  config: workspaceConfigStateSchema,
});
export type WorkspaceConfigSnapshot = z.infer<typeof workspaceConfigSnapshotSchema>;

// The delta set intentionally has one operation: configuration catalogs are small whole-value
// replacements, not field-level deltas.
export const workspaceConfigDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("config.updated"), config: workspaceConfigStateSchema }),
]);
export type WorkspaceConfigDelta = z.infer<typeof workspaceConfigDeltaSchema>;

/** Construct a workspace-config topic key (paired with parseWorkspaceConfigTopic). */
export function workspaceConfigTopic(workspaceId: string): string {
  return `workspace-config/${workspaceId}`;
}

/** Parse a workspace-config topic key ("workspace-config/<workspaceId>"). */
export function parseWorkspaceConfigTopic(topic: string): string | null {
  if (!topic.startsWith("workspace-config/")) return null;
  const workspaceId = topic.slice("workspace-config/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
