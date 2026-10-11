import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

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
