import { externalSessionSourceLabel, type ExternalSessionTranscript } from "./contract.js";

/** Spec "Continue in ZCode": the pack keeps the newest messages only and is lossy by design. */
export const CONTEXT_PACK_MESSAGES = 12;
export const CONTEXT_PACK_CHARS_PER_MESSAGE = 1200;

function trimMessage(text: string, limit: number): string {
  const normalized = text.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Builds the unsent draft text for "Continue in ZCode" from a transcript. */
export function buildExternalSessionContextPack(
  transcript: ExternalSessionTranscript,
  limits: { messages?: number; charsPerMessage?: number } = {},
): string {
  const maxMessages = limits.messages ?? CONTEXT_PACK_MESSAGES;
  const maxChars = limits.charsPerMessage ?? CONTEXT_PACK_CHARS_PER_MESSAGE;
  const { summary } = transcript;
  const nonEmpty = transcript.messages.filter((message) => message.text.trim().length > 0);
  const kept = nonEmpty.slice(Math.max(0, nonEmpty.length - maxMessages));
  const omitted = nonEmpty.length - kept.length;
  const lines: string[] = [
    `Continue the work from a ${externalSessionSourceLabel(summary.source)} session "${summary.title}" (${summary.workspacePath}).`,
    omitted > 0
      ? `Previous conversation (last ${kept.length} of ${nonEmpty.length} messages, trimmed):`
      : "Previous conversation (trimmed):",
    "",
  ];
  for (const message of kept) {
    const speaker = message.role === "user" ? "User" : "Assistant";
    lines.push(`**${speaker}:** ${trimMessage(message.text, maxChars)}`, "");
  }
  lines.push("Continue from here.");
  return lines.join("\n");
}
