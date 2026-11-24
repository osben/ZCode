import { readFile, stat } from "node:fs/promises";
import {
  READ_IMAGE_MAX_DIMENSION,
  detectImageMediaType,
  parseImageDataUrl,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { stripClaudeCodeHintLines } from "./bash-semantics.js";

const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
// RIFF 头：4 字节 "RIFF" + 4 字节小端长度，长度字段记录的是文件总长减去这 8 字节。
const RIFF_SIZE_OFFSET = 4;
const RIFF_HEADER_BYTES = 8;

export interface BashImageSource {
  artifactPath?: string;
  artifactSize?: number;
  inline: string;
}

export async function prepareBashImageOutput(
  stdout: BashImageSource,
  context: ToolExecutionContext,
): Promise<{ stdout: string } | undefined> {
  const source = stripClaudeCodeHintLines(await readBashImageSource(stdout));
  const parsed = parseImageDataUrl(source);
  // 声明类型必须先与 magic bytes 一致，原因有两个：resize 适配器对 WebP 原样透传、不解码；
  // 对其他格式按内容解码，却按声明的类型返回原 bytes。不检查的话，任意字节声明成 image/webp、
  // 或错标类型的图片（例如 PNG 标成 JPEG）都会带着错误类型发给 provider。
  if (!parsed || detectImageMediaType(parsed.data) !== parsed.mediaType) return undefined;
  // WebP 不解码，截断的 WebP 头部完好也能过上一步；只能用 RIFF 头声明的文件总长发现截断。
  if (parsed.mediaType === "image/webp" && isTruncatedRiff(parsed.data)) return undefined;
  if (!context.imageProcessorPort) return { stdout: parsed.dataUrl };

  try {
    const resized = await context.imageProcessorPort.resizeToFit(
      {
        data: parsed.data,
        maxDimension: READ_IMAGE_MAX_DIMENSION,
        mediaType: parsed.mediaType,
        trace: createToolTrace(context),
      },
      { signal: context.abortSignal },
    );
    return {
      stdout: `data:${resized.mediaType};base64,${Buffer.from(resized.data).toString("base64")}`,
    };
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    // Any resize failure falls back to text. Previously, after a decode failure only magic bytes let it through: a truncated or corrupted image
    // with an intact header was sent as an image block, the provider rejected it, and the bad image was replayed with session history so every later request failed.
    return undefined;
  }
}

async function readBashImageSource(stdout: BashImageSource): Promise<string> {
  if (!stdout.artifactPath) return stdout.inline;

  try {
    const size = stdout.artifactSize ?? (await stat(stdout.artifactPath)).size;
    if (size > MAX_IMAGE_FILE_BYTES) return stdout.inline;
    return await readFile(stdout.artifactPath, "utf8");
  } catch {
    // Image recognition is a provider-visible enhancement; if the temporary artifact file is missing, fall back to inline output and preserve the original Bash result.
    return stdout.inline;
  }
}

// Magic bytes already confirmed WebP before this call, and the data is at least 12 bytes, so the length field can be read safely.
function isTruncatedRiff(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return data.byteLength < view.getUint32(RIFF_SIZE_OFFSET, true) + RIFF_HEADER_BYTES;
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
    },
  } as unknown as TraceContext;
}
