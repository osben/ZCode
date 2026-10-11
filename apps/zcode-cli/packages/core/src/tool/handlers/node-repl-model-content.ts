import type { JsOutput, ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";

export function formatJsModelContent(output: unknown): ModelMessageContent {
  const o = output as JsOutput;
  const parts: string[] = [];
  if (o.error) {
    const errorHeader = `${o.error.name}: ${o.error.message}`;
    parts.push(errorHeader);
    // The first line of Error.stack already repeats name/message; appending the full stack would show the same error body twice.
    // message may contain multiline locator context, so strip the full header rather than only removing the first line.
    const stackFrames = o.error.stack
      ? o.error.stack.startsWith(`${errorHeader}\n`)
        ? o.error.stack.slice(errorHeader.length + 1).trimEnd()
        : o.error.stack.split("\n").slice(1).join("\n").trimEnd()
      : undefined;
    if (stackFrames?.trim()) parts.push(stackFrames);
  }
  if (o.logs) parts.push(o.logs);
  if (o.result !== undefined) parts.push(`=> ${o.result}`);
  if (o.browserScreenshotPaths && o.browserScreenshotPaths.length > 0) {
    parts.push(
      o.browserScreenshotPaths.map((path) => `Browser screenshot saved to: ${path}`).join("\n"),
    );
  }
  const text = parts.length > 0 ? parts.join("\n") : "(no output)";
  // Images collected by nodeRepl.emitImage become image content blocks (dataUrl), so the model can directly “see” screenshots.
  // Canonical result order puts emitted rasters before their textual summary.
  if (o.images && o.images.length > 0) {
    const blocks: ModelMessageContentBlock[] = [];
    for (const img of o.images) {
      blocks.push({
        type: "image",
        mediaType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.base64}`,
      });
    }
    blocks.push({ type: "text", text });
    return blocks;
  }
  return text;
}
