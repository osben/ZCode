import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

/**
 * Config options an external ACP agent offers for its session (specs/acp-agent-runtime.md "S6"). Labels
 * and values come from the agent; `currentValue` is the agent's value, or the user's choice once the
 * choice is stored (it reaches the agent before the next prompt).
 */
export const externalAgentConfigValueSchema = z
  .object({
    value: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    group: z.string().nullable(),
  })
  .strict();
export type ExternalAgentConfigValue = z.infer<typeof externalAgentConfigValueSchema>;

export const externalAgentConfigOptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    currentValue: z.string(),
    options: z.array(externalAgentConfigValueSchema),
  })
  .strict();
export type ExternalAgentConfigOption = z.infer<typeof externalAgentConfigOptionSchema>;

export const externalAgentConfigStateSchema = z
  .object({
    agentId: z.string().min(1),
    options: z.array(externalAgentConfigOptionSchema),
  })
  .strict();
export type ExternalAgentConfigState = z.infer<typeof externalAgentConfigStateSchema>;

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Sparse selection intent accepted and persisted by the session; provider/model/thought are only effective projections for the UI. */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // Reasoning levels are capabilities of the current model, not workspace/UI preferences.
  // default exists only for compatibility with older snapshots; new agents must project the actual set from runtime.
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // Additive evolution on the frozen surface, following the same rule as meta: agent collaboration
  // mode (core CollaborationMode). Include a default to preserve parsing of old snapshots/senders; the
  // projection updates through SessionModeChanged events.
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /** Explicit approval result; drafts are consumed once by interactionId, and ordinary mode updates do not reset it. */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** Correlation for the most recent tool transition, used for targeted draft synchronization without adding a visible history event. */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
  /**
   * Additive (S6): the selects of the ACP agent that last ran in this session. Absent until the
   * session has an offered snapshot; the composer shows them only while the selected model is that
   * agent (`acp:<agentId>`). Optional so older snapshots still parse.
   */
  externalAgentConfig: externalAgentConfigStateSchema.optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
