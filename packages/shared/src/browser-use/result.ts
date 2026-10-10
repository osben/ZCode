import { z } from "zod";
import { browserErrorCodeSchema, browserPageStateSchema } from "./commands.js";
import { browserViewportSizeSchema } from "./command-metadata.js";
import { browserBackendTypeSchema } from "./backend.js";
import { browserSnapshotSchema, browserSnapshotElementSchema } from "./snapshot.js";

/**
 * Controlled-tab summary (returned by the list command): the Agent uses tabId to address a specific tab, including tabs opened by a human.
 */
export const browserTabSummarySchema = z
  .object({
    tabId: z.string(),
    url: z.string(),
    title: z.string(),
    /** Guest's current actual CSS viewport; required for both normal and free-size modes. */
    viewport: browserViewportSizeSchema,
    /**
     * Most recently visible/activated built-in browser tab on the main side. Lets the Agent bind to and read the current page
     * after the user manually changes the address, instead of reading the session's default tab by mistake.
     */
    active: z.boolean().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff"]).optional(),
  })
  .strict();
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>;

/** User IAB tab not yet claimed by the current browser session; ordinary tab commands cannot run before it is claimed. */
export const browserUserTabInfoSchema = z
  .object({
    id: z.string().min(1),
    lastOpened: z.string().optional(),
    tabGroup: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();
export type BrowserUserTabInfo = z.infer<typeof browserUserTabInfoSchema>;

/** JavaScript dialog information (returned by getDialog). */
export const browserDialogSchema = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    defaultPrompt: z.string().optional(),
  })
  .strict();
export type BrowserDialog = z.infer<typeof browserDialogSchema>;

/** UI/client metadata for a browser command; it does not automatically become a model image block. */
export const browserResponseMetaSchema = z
  .object({
    browserUse: z.literal(true),
    backendType: browserBackendTypeSchema,
    browserId: z.string().min(1),
    browserGeneration: z.number().int().nonnegative(),
    openTabIds: z.array(z.string()),
    tabId: z.string().optional(),
    currentUrl: z.string().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff", "closed"]).optional(),
  })
  .strict();
export type BrowserResponseMeta = z.infer<typeof browserResponseMetaSchema>;

export const browserRecordingArtifactSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("video/webm"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationMs: z.number().nonnegative(),
    frameCount: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserRecordingArtifact = z.infer<typeof browserRecordingArtifactSchema>;

export const browserRecordingJobSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    phase: z.enum(["preparing", "capturing", "finalizing", "completed", "failed", "cancelled"]),
    progress: z.number().min(0).max(1),
    startedAt: z.number().nonnegative(),
    updatedAt: z.number().nonnegative(),
    artifact: browserRecordingArtifactSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type BrowserRecordingJob = z.infer<typeof browserRecordingJobSchema>;

/**
 * Unified result for browser commands, shared by the Agent BrowserControlPort, protocol result, and main executor.
 * Screenshots use image; navigation/getState return state; snapshot returns snapshot; list returns tabs; failures return a structured error.
 */
export const browserCommandResultSchema = z
  .object({
    ok: z.boolean(),
    state: browserPageStateSchema.optional(),
    snapshot: browserSnapshotSchema.optional(),
    image: z
      .object({ base64: z.string(), mimeType: z.literal("image/png") })
      .strict()
      .optional(),
    /** Returned by list; includes only tabs visible in the current window/workspace/session/generation scope. */
    tabs: z.array(browserTabSummarySchema).optional(),
    /** Returned by BrowserUser.openTabs(); strictly separate from tabs.list() owned by the current session. */
    userTabs: z.array(browserUserTabInfoSchema).optional(),
    /** One actual tab returned by newTab. */
    tab: browserTabSummarySchema.optional(),
    /** Returned by evaluate: the page expression result, serializable as JSON. */
    value: z.unknown().optional(),
    /** Returned by elementInfo: information about the element at the coordinates (reuses the snapshot element shape; omitted if nothing is hit). */
    element: browserSnapshotElementSchema.optional(),
    /** Returned by getDialog: current JavaScript dialog information, or null if there is no dialog. */
    dialog: browserDialogSchema.nullable().optional(),
    /** Asynchronous WebView recording task; the Host rewrites a temporary main path to a workspace path when materializing it. */
    recording: browserRecordingJobSchema.optional(),
    error: z
      .object({
        code: browserErrorCodeSchema,
        message: z.string(),
        sideEffect: z.enum(["none", "uncertain"]).optional(),
      })
      .strict()
      .optional(),
    meta: browserResponseMetaSchema.optional(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;
