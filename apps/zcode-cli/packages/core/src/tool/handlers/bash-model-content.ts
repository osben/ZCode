import {
  BashOutputSchema,
  parseImageDataUrl,
  type BashOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import {
  formatCompactPersistedOutputContent,
  truncateMiddleForModel,
} from "../result-persistence-format.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;
const READ_TOOL_NAME = "Read";

export function formatBashModelContent(output: unknown): ModelMessageContent {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return stringifyFallback(output);

  const result = parsed.data;
  if (hasStructuredContent(result)) {
    return result.structuredContent as ModelMessageContent;
  }

  // Bash failures are returned as result objects; model-visible error results should remain plain text.
  if (isBashOutputProviderError(result)) {
    return formatProviderErrorContent(result);
  }

  const imageContent = maybeImageContent(result);
  if (imageContent) return imageContent;

  return formatTextContentForModel(result);
}

/** True when formatBashModelContent takes the failure branch: the body keeps head/tail by characters with a deterministic cap. */
export function isBashModelContentBounded(output: unknown): boolean {
  const parsed = BashOutputSchema.safeParse(output);
  return (
    parsed.success && !hasStructuredContent(parsed.data) && isBashOutputProviderError(parsed.data)
  );
}

function hasStructuredContent(result: BashOutput): boolean {
  return Array.isArray(result.structuredContent) && result.structuredContent.length > 0;
}

export function formatPersistedBashModelContent(input: {
  content: string;
  output: unknown;
  persistedPath: string;
  originalBytes: number;
}): ModelMessageContent | undefined {
  if (!BashOutputSchema.safeParse(input.output).success) return undefined;
  // The serializer has already written the complete Bash provider-visible content to the artifact.
  // Preview only that content here; do not run the regular formatter again and append full stderr/provider-error text to model context.
  return formatCompactPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

// A failed command's output is not written to disk: use the first 30000 bytes captured inline, keeping this segment's head/tail when overlong; anything past 30000 bytes is invisible.
// Fix rationale: when output over 30000 bytes was written to disk with only a 2KB head shown, the model could not see the error reason later in the output.
function formatProviderErrorContent(result: BashOutput): string {
  return truncateMiddleForModel(
    [
      `Exit code ${result.exitCode}`,
      formatStdoutForModel(result.stdout),
      formatStderrForModel(result),
    ]
      .filter(Boolean)
      .join("\n")
      .trim(),
  );
}

function formatTextContentForModel(result: BashOutput): string {
  return [
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStdoutContentForModel(result: BashOutput): string {
  let processedStdout = formatStdoutForModel(result.stdout);
  const persistedOutputPath =
    result.status === "backgrounded"
      ? undefined
      : (result.persistedOutputPath ?? result.rawOutputPath);
  if (persistedOutputPath) {
    processedStdout = formatCompactPersistedOutputContent({
      content: processedStdout,
      originalBytes: observedOutputBytes(result),
      persistedPath: persistedOutputPath,
    });
  }
  return processedStdout;
}

function stringifyFallback(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function formatStdoutForModel(stdout: string): string {
  if (!stdout) return "";
  return stdout.replace(/^(\s*\n)+/, "").trimEnd();
}

function formatStderrForModel(result: BashOutput): string {
  let message = result.stderr.trim();
  if (result.interrupted) {
    if (message) message += "\n";
    message += "<error>Command was aborted before completion</error>";
  }
  return message;
}

export function isBashOutputProviderError(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return isBashProviderErrorStatus(output);
}

function formatBackgroundInfoForModel(result: BashOutput): string {
  if (!result.backgroundTaskId) return "";
  const outputText = formatBackgroundOutputPaths(result);
  if (result.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${result.backgroundTaskId}. It is still running \u2014 you will be notified when it completes.${outputText} In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
  }
  if (result.backgroundedByUser) {
    return `Command was manually backgrounded by user with ID: ${result.backgroundTaskId}.${stripTrailingPeriod(outputText)}`;
  }
  const readHint = outputText
    ? ` To check interim output, use ${READ_TOOL_NAME} on that file path.`
    : "";
  if (result.timedOutAfterMs !== undefined) {
    const timeoutSeconds = Math.max(1, Math.round(result.timedOutAfterMs / 1000));
    return `Command did not complete within its ${timeoutSeconds}s timeout and was moved to the background (ID: ${result.backgroundTaskId}).${outputText} You will be notified when it completes.${readHint}`;
  }
  return `Command running in background with ID: ${result.backgroundTaskId}.${outputText} You will be notified when it completes.${readHint}`;
}

function formatBackgroundOutputPaths(result: BashOutput): string {
  // Bash stdout/stderr are already written directly to a single output file. Appending the legacy stdout/stderr paths
  // would expose two paths that disagree with the single output file.
  const outputPath =
    result.rawOutputPath ??
    result.persistedOutputPath ??
    result.stdoutPersistedOutputPath ??
    result.stderrPersistedOutputPath;
  return outputPath ? ` Output is being written to: ${outputPath}.` : "";
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function observedOutputBytes(result: BashOutput): number {
  if (typeof result.persistedOutputSize === "number") return result.persistedOutputSize;
  if (
    typeof result.stdoutPersistedOutputSize === "number" ||
    typeof result.stderrPersistedOutputSize === "number"
  ) {
    return (result.stdoutPersistedOutputSize ?? 0) + (result.stderrPersistedOutputSize ?? 0);
  }
  return (
    (result.stdoutBytes ?? Buffer.byteLength(result.stdout, "utf8")) +
    (result.stderrBytes ?? Buffer.byteLength(result.stderr, "utf8"))
  );
}

function maybeImageContent(result: BashOutput): ModelMessageContent | undefined {
  if (!result.isImage) return undefined;
  const parsed = parseImageDataUrl(result.stdout, { allowWhitespace: true });
  if (!parsed) return undefined;
  return [
    {
      type: "image",
      mediaType: parsed.mediaType,
      dataUrl: parsed.dataUrl,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
