import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { agentProfileSchema, type AgentProfile } from "./subagent-profile.js";
import { createAgentStateId } from "./subagents-types.js";

export const subagentRuntimeStateSchema = z
  .object({
    disabledAgentIds: z.array(z.string()),
    builtInModelSelectionOverrides: z
      .object({
        Explore: modelSelectionSchema.optional(),
        "general-purpose": modelSelectionSchema.optional(),
      })
      .strict(),
    pluginAgentModelSelectionOverrides: z.record(z.string(), modelSelectionSchema),
  })
  .strict();
export type SubagentRuntimeState = z.infer<typeof subagentRuntimeStateSchema>;

/** The snapshot has been parsed; the read-failure fallback must not be conflated with RPC disconnection errors. */
export const subagentRuntimeConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      profiles: z.array(agentProfileSchema.refine((profile) => profile.source !== "built-in")),
      builtInModelSelectionOverrides:
        subagentRuntimeStateSchema.shape.builtInModelSelectionOverrides,
      pluginAgentModelSelectionOverrides:
        subagentRuntimeStateSchema.shape.pluginAgentModelSelectionOverrides,
    })
    .strict(),
  z.object({ kind: z.literal("built-in-fallback") }).strict(),
]);
export type SubagentRuntimeConfig = z.infer<typeof subagentRuntimeConfigSchema>;

/** Composes the result purely from the parse cache; enable/disable changes do not re-read or re-parse Markdown. */
export function resolveSubagentRuntimeProfiles(
  profiles: readonly AgentProfile[],
  state: SubagentRuntimeState,
) {
  const disabled = new Set(state.disabledAgentIds);
  return {
    profiles: profiles.filter(
      (profile) =>
        profile.source !== "user" ||
        !disabled.has(createAgentStateId({ name: profile.name, scope: "user", source: "user" })),
    ),
    builtInModelSelectionOverrides: state.builtInModelSelectionOverrides,
    pluginAgentModelSelectionOverrides: state.pluginAgentModelSelectionOverrides,
  };
}
