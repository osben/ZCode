import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

export const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // Bugfix: createSession.config expresses "requested override fields" and must not reuse the
  // snapshot's sessionConfigStateSchema.partial(); the snapshot schema sets default("build") for
  // mode to stay compatible with old snapshots, which would turn "mode not provided" into
  // "request to switch back to build", overriding the workspace default yolo.
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});
