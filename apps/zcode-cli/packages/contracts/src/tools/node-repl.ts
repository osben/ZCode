import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const JsInputBaseShape = {
  // The same model schema serves both the persistent core REPL and the fresh-kernel Browser
  // Use MCP. Field descriptions must not promise cross-call state for either execution
  // boundary; each tool description explains its own lifecycle.
  code: z.string().describe("JavaScript code to execute in the Node REPL session"),
  // Marking this optional alone does not tell the model when to override the default; a long
  // wait could otherwise time out after the side effect has completed.
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      "Per-call timeout in milliseconds. You MUST provide this when the code is expected to run longer than 30000 ms, including all awaited operations. Set it to at least the estimated total runtime plus 15000 ms. If that exceeds the 120000 ms maximum, split the work into multiple calls.",
    ),
};
const JsUserTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Required short user-facing title in the user's language that describes the intended action without implementation terms such as js, JavaScript, or node_repl",
  );

/** js: execute a JavaScript snippet in the persistent REPL. */
export const JsInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema,
  })
  .strict();
export type JsInput = z.infer<typeof JsInputSchema>;

// New calls must provide a user-readable title, but historical calls from old sessions and third-party providers may lack it.
export const JsRuntimeInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema.optional(),
  })
  .strict();
export type JsRuntimeInput = z.infer<typeof JsRuntimeInputSchema>;

export const JsOutputSchema = z
  .object({
    result: z.string().optional(),
    logs: z.string(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    // Images collected by nodeRepl.emitImage (such as a tab.screenshot); formatModelContent
    // converts them to image content blocks for the model.
    images: z.array(z.object({ base64: z.string(), mimeType: z.string() }).strict()).optional(),
    // Absolute session-artifact path to the original PNG from an explicit model call to tab.screenshot().
    browserScreenshotPaths: z.array(z.string()).optional(),
    responseMeta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type JsOutput = z.infer<typeof JsOutputSchema>;

export const JsInputJsonSchema = toToolJsonSchema(JsInputSchema);
export const JsOutputJsonSchema = toToolJsonSchema(JsOutputSchema);
