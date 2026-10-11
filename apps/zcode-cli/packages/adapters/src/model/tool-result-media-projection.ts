import type { ModelMessage as AiSdkModelMessage } from "ai";
import {
  getUnsupportedModelInputMediaKind,
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
type AiSdkUserContentParts = Extract<AiSdkUserContent, unknown[]>;

interface ToolResultMediaProjectionOptions {
  apiFormat?: string;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
  toolName: string;
}

const CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS = new Set(["openai-compatible", "gateway"]);
const TOOL_RESULT_MEDIA_INTRO_PREFIX = "Tool result media from";

export function shouldTextifyStructuredToolResults(
  options: Pick<ToolResultMediaProjectionOptions, "apiFormat" | "providerKind">,
): boolean {
  if (options.apiFormat !== undefined) {
    return options.apiFormat === "openai-chat-completions";
  }
  // Root cause: the openai kind uses the Responses API. Classifying it by the broad OpenAI-like
  // family would incorrectly project it as Chat Completions tool text + synthetic user. Without an
  // explicit format, fall back only for providers that actually use Chat-style results; explicit
  // apiFormat still has highest priority.
  return (
    options.providerKind !== undefined &&
    CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS.has(options.providerKind)
  );
}

/**
 * Whether a tool result contains video media. AI SDK tool result parts have no video variant (besides
 * image-data, they support only file-data/pdf), so video tool results for all provider kinds
 * (including anthropic) must use textify + trailing user-part projection; otherwise video is lost
 * at the wire boundary.
 */
export function toolResultHasVideoMedia(content: ModelMessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "video");
}

/**
 * Pairing rule (driven by the producer predicate): a text block immediately following a media block
 * is paired with that media when it contains a protected media credential (such as a producer-issued
 * image_ref). When provider projection moves media into a separate user message (OpenAI-like textify),
 * the paired text must move with it and retain its order. Leaving the text in the tool message would
 * put the "reference text" and "referenced media" in separate messages, making frames easy to mismatch.
 * Ordinary text (explanations, summaries) is not a credential and is not paired, so generic tool media
 * semantics remain unchanged. Credential detection is part of the producer frame contract, referenced
 * by the host through frame-contract.
 * The producer's canonical order is image-first (raster first, followed by image_ref). Pairing lookup
 * reads authority forward from the image and does not depend on provider-specific truncation behavior.
 */
type PairedTextOptions = Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">;

function isPairedTextBlock(
  content: ModelMessageContentBlock[],
  index: number,
  options: PairedTextOptions,
): boolean {
  const block = content[index];
  if (block?.type !== "text" || block.text.trim().length === 0) return false;
  // Pair only producer-issued media credentials. Pairing arbitrary adjacent text would change the
  // generic media semantics of every tool (adjacent descriptions for ordinary screenshots/file
  // previews are not media credentials).
  if (!containsOfficialCuaImageRefCredentialText(block.text)) return false;
  // Skipping blank text to find an earlier image would break the producer-required direct
  // image -> image_ref adjacency and could reauthorize a frame_ref separated by an inserted block.
  const candidate = content[index - 1];
  return (
    candidate !== undefined &&
    contentBlockToUserMediaParts(candidate, {
      ...options,
      toolName: "",
    }).length > 0
  );
}

function pairedTextIndexes(
  content: ModelMessageContentBlock[],
  options: PairedTextOptions,
): Set<number> {
  // With stripMedia, media is not deferred (toToolResultMediaUserParts returns empty), so do not
  // omit paired text first; otherwise it would disappear from the tool output and every other message.
  if (options.stripMedia === true) return new Set();
  const paired = new Set<number>();
  for (let index = 0; index < content.length; index += 1) {
    if (isPairedTextBlock(content, index, options)) paired.add(index);
  }
  return paired;
}

export function toStructuredToolResultText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "inputFormat"> = {},
): string {
  if (typeof content === "string") return content;
  const paired = pairedTextIndexes(content, options);
  return modelMessageContentToText(
    content.map((block, index) => {
      // Paired text is deferred together with media (see toToolResultMediaUserParts); omit it here
      // so the model does not see duplicate reference text in the same request.
      if (paired.has(index)) return { type: "text", text: "" };
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      return unsupportedText ? { type: "text", text: unsupportedText } : block;
    }),
  );
}

export function toToolResultMediaUserParts(
  content: ModelMessageContent,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  if (typeof content === "string" || options.stripMedia) return [];
  const blocks = content;
  const paired = pairedTextIndexes(blocks, options);

  const parts: AiSdkUserContentParts = [
    {
      type: "text",
      text: `${TOOL_RESULT_MEDIA_INTRO_PREFIX} ${options.toolName}:`,
    },
  ];
  // The separator is only needed between "two consecutive paired text blocks." The old condition
  // `parts.length > 1` assumed paired text was always enqueued first (the old text-first layout).
  // After the producer changed to image-first, raster is enqueued first and that condition would
  // insert an unnecessary empty text block between the image and its image_ref.
  let lastPushedWasPairedText = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.type === "text" && paired.has(index)) {
      // Defer paired text with its adjacent media, preserving their order.
      if (lastPushedWasPairedText) parts.push({ type: "text", text: "\n\n" });
      parts.push({ type: "text", text: block.text });
      lastPushedWasPairedText = true;
      continue;
    }
    const mediaParts = contentBlockToUserMediaParts(block, options);
    if (mediaParts.length === 0) continue;
    parts.push(...mediaParts);
    lastPushedWasPairedText = false;
  }
  return parts.length > 1 ? parts : [];
}

function contentBlockToUserMediaParts(
  block: ModelMessageContentBlock,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  switch (block.type) {
    case "image": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      // As on the user-message path, pass video/* file parts to the patched provider package to
      // convert into video_url / video blocks.
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) return [];
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (!data) return [];
      return [
        {
          type: "file",
          data: data.data,
          filename: block.name,
          mediaType: block.mediaType,
        },
      ];
    }

    case "text":
    case "reasoning":
    case "resource_link":
      return [];
  }
}

/**
 * Generic fail-closed guard (coordinate frame references must not reach the model without their raster):
 * if a structured tool result carries frame-reference text (such as the exact JSON for a CUA image_ref)
 * but its media cannot be delivered because the model does not support it (or stripMedia is set),
 * fail the entire result. Replacing the media with a placeholder would leave an actionable reference
 * and prompt the model to act on coordinates from an unseen image. This rule depends only on the
 * structural combination of "reference text + undeliverable media" and does not know about specific tools.
 */
export function undeliverableFrameReferenceText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  // Use the same embedded-scan detector as MCP normalization/hooks. Wrapping image_ref in explanatory
  // text must not bypass fail-closed behavior; this safety boundary does not depend on payload shape.
  const frameReferenceIndexes = content.flatMap((block, index) =>
    block.type === "text" && containsOfficialCuaImageRefCredentialText(block.text) ? [index] : [],
  );
  if (frameReferenceIndexes.length === 0) return undefined;
  const unavailable =
    "This tool returned a coordinate frame reference without a deliverable raster. " +
    "No image_ref or raster was exposed; do not use frame-bound coordinates. " +
    "Switch to an image-capable model and capture a new raster first.";
  if (options.stripMedia === true) return unavailable;
  // Every credential must independently have a deliverable raster immediately before it; unrelated
  // images elsewhere in the result cannot legitimize an orphan reference.
  return frameReferenceIndexes.every((index) => isPairedTextBlock(content, index, options))
    ? undefined
    : unavailable;
}
