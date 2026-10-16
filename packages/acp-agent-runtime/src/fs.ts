/**
 * Filesystem bridge helpers.
 *
 * When the host provides `AcpHostBridge.fs`, the runtime advertises
 * `clientCapabilities.fs` and answers `fs/read_text_file` /
 * `fs/write_text_file` through these helpers, so agent edits flow through the
 * application's file layer (path policy is the host's responsibility).
 */
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { AcpFsBridge } from "./types.js";

export function readTextFileViaBridge(
  bridge: AcpFsBridge,
  request: ReadTextFileRequest,
): Promise<ReadTextFileResponse> {
  const offset = typeof request.line === "number" && request.line > 0 ? request.line - 1 : null;
  const limit = typeof request.limit === "number" && request.limit >= 0 ? request.limit : null;
  return bridge.readFile(request.path).then((content) => ({
    content: sliceLines(content, offset, limit),
  }));
}

export async function writeTextFileViaBridge(
  bridge: AcpFsBridge,
  request: WriteTextFileRequest,
): Promise<WriteTextFileResponse> {
  await bridge.writeFile(request.path, request.content);
  return {};
}

/** Applies ACP `line` (1-based) and `limit` semantics to file content. */
function sliceLines(content: string, offset: number | null, limit: number | null): string {
  if (offset === null && limit === null) return content;
  const lines = content.split("\n");
  const from = offset ?? 0;
  const to = limit === null ? undefined : from + limit;
  return lines.slice(from, to).join("\n");
}
