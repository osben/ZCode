import { BashOutputSchema, type ToolResultDisplayPayload } from "@zcode/contracts";

export function createBashResultDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  if (result.status === "backgrounded" || result.isImage || result.structuredContent?.length)
    return undefined;
  const outputPath = result.persistedOutputPath ?? result.rawOutputPath;
  const truncated = result.stdoutTruncated === true || result.stderrTruncated === true;
  if (!truncated && !outputPath) return undefined;

  // The model envelope may shorten the body again and hide Bash's truncation state.
  // Desktop needs a separate bounded header display; it must not parse model-facing
  // text or mistake a file path for a protocol reference that can be fetched on demand.
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const exceedsDisplayBudget = Buffer.byteLength(text, "utf8") > 150_000;
  const bounded = exceedsDisplayBudget
    ? new TextDecoder().decode(Buffer.from(text).subarray(0, 150_000), { stream: true })
    : text;
  return {
    kind: "bash_output",
    output: bounded,
    truncated: truncated || exceedsDisplayBudget,
    ...(outputPath ? { outputPath } : {}),
  };
}
