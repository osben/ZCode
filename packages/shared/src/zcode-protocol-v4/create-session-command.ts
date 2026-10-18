import { z } from "zod";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { incognitoProfileSchema } from "../incognito-profile.js";
import { modelSelectionSchema } from "../model-selection.js";
import {
  zcodeExecutionWorktreeSchema,
  zcodeProtocolMcpServerSchema,
} from "../zcode-protocol/index.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { createSessionRequestedConfigSchema } from "./create-session-config.js";
import { submissionModeSchema } from "./submission.js";
import * as worktreePreparationCommand from "./worktree-preparation-command.js";

/** `createSession` command payload (§6.4), split out of command.ts. */
export const createSessionPayloadSchema = z.object({
  workspaceId: z.string(),
  ...worktreePreparationCommand.worktreePreparationCreateSessionFields,
  permissionScope: z.literal("session").optional(),
  firstInput: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
    })
    .optional(),
  config: createSessionRequestedConfigSchema.optional(),
  // Execution worktree: the agent runs in this linked worktree directory while the session stays
  // listed under workspaceId. Additive: older CLI z.object schemas silently drop this key
  // (fail-closed) and the session then executes in the parent workspace as before.
  executionWorktree: zcodeExecutionWorktreeSchema.optional(),
  // MCP is runtime startup configuration; include it in the record during create, not as a later write after first send.
  mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
  // Off-Peak tool-surface flag, equivalent to legacy session/create — V4 createSession is Desktop's
  // actual new-session path; without forwarding this, OffPeakCreate/OffPeakList are never registered. Additive:
  // older CLI z.object schemas silently drop this key (fail-closed).
  offPeakToolEnabled: z.boolean().optional(),
  // Dynamic workflow rollout flag, following the same pattern as offPeakToolEnabled.
  dynamicWorkflowEnabled: z.boolean().optional(),
  // Gray-release mode is sent alongside the boolean (launch.md “On demand: activation”); older CLIs silently discard it via z.object.
  dynamicWorkflowMode: z.enum(DYNAMIC_WORKFLOW_MODES).optional(),
  // Incognito profile (specs/incognito-session.md), frozen at creation. Unlike the additive flags
  // above, dropping it is not fail-closed: senders must gate on the incognitoSession capability.
  incognito: incognitoProfileSchema.optional(),
});
