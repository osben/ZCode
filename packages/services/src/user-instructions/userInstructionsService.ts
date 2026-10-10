import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import {
  atomicWriteFile,
  getClaudeUserInstructionsFilePath,
  getUserZcodeAgentsFilePath,
  withFileLock,
} from "@zcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  USER_INSTRUCTIONS_AGENT_READ_LIMIT_BYTES,
  USER_INSTRUCTIONS_EDIT_LIMIT_BYTES,
  type IUserInstructionsService,
  type UserInstructionsEol,
  type UserInstructionsImportSource,
  type UserInstructionsReadErrorCode,
  type UserInstructionsReadResult,
  type UserInstructionsWriteParams,
  type UserInstructionsWriteResult,
} from "./userInstructions.js";

const log = createServiceLogger("user-instructions");
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type InspectedPath =
  | { kind: "missing" }
  | { kind: "file"; targetPath: string; linkTarget?: string; sizeBytes: number; mode: number }
  | {
      kind: "error";
      code: Extract<
        UserInstructionsReadErrorCode,
        "BROKEN_LINK" | "NOT_REGULAR_FILE" | "READ_FAILED"
      >;
      linkTarget?: string;
      message?: string;
    };

type DecodedText =
  | {
      kind: "ok";
      content: string;
      eol: UserInstructionsEol;
      hasBom: boolean;
      mixedLineEndings: boolean;
    }
  | { kind: "error"; code: "NOT_UTF8" };

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 按 lstat → realpath → stat 检查路径。CLI 使用跟随链接的 stat，
 * 因此悬空链接与目录在 CLI 侧等同于不存在；这里显式区分以禁止误写。
 */
async function inspectPath(filePath: string): Promise<InspectedPath> {
  let linkStats;
  try {
    linkStats = await lstat(filePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return { kind: "missing" };
    if (getErrorCode(error) === "ENOTDIR") {
      return { kind: "error", code: "NOT_REGULAR_FILE", message: getErrorMessage(error) };
    }
    return { kind: "error", code: "READ_FAILED", message: getErrorMessage(error) };
  }

  let targetPath = filePath;
  let linkTarget: string | undefined;
  if (linkStats.isSymbolicLink()) {
    try {
      targetPath = await realpath(filePath);
      linkTarget = targetPath;
    } catch (error) {
      const rawTarget = await readlink(filePath).catch(() => undefined);
      const code = getErrorCode(error);
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") {
        return { kind: "error", code: "BROKEN_LINK", linkTarget: rawTarget };
      }
      return {
        kind: "error",
        code: "READ_FAILED",
        linkTarget: rawTarget,
        message: getErrorMessage(error),
      };
    }
  }

  let targetStats;
  try {
    targetStats = linkTarget === undefined ? linkStats : await stat(targetPath);
  } catch (error) {
    return { kind: "error", code: "READ_FAILED", linkTarget, message: getErrorMessage(error) };
  }
  if (!targetStats.isFile()) {
    return { kind: "error", code: "NOT_REGULAR_FILE", linkTarget };
  }
  return {
    kind: "file",
    targetPath,
    linkTarget,
    sizeBytes: targetStats.size,
    mode: targetStats.mode & 0o7777,
  };
}

/**
 * textarea 会把 CRLF 规范化为 LF，无法零处理地保留行尾；
 * 因此读取时记录主导行尾与 BOM，返回 LF 文本，保存时再还原。
 */
function decodeText(bytes: Uint8Array): DecodedText {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      hasBom ? bytes.subarray(3) : bytes,
    );
  } catch {
    return { kind: "error", code: "NOT_UTF8" };
  }

  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (char === 0x0a) {
      lf += 1;
    }
  }
  return {
    kind: "ok",
    content: text.replace(/\r\n?/g, "\n"),
    // 平局（含无换行）取 LF。
    eol: crlf > lf ? "crlf" : "lf",
    hasBom,
    mixedLineEndings: cr > 0 || (crlf > 0 && lf > 0),
  };
}

export function encodeUserInstructionsContent(params: {
  content: string;
  eol: UserInstructionsEol;
  hasBom: boolean;
}): Buffer {
  const normalized = params.content.replace(/\r\n?/g, "\n");
  const text = params.eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const body = Buffer.from(text, "utf8");
  return params.hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

type LoadedText =
  | { kind: "missing" }
  | {
      kind: "ok";
      linkTarget?: string;
      bytes: Buffer;
      decoded: Extract<DecodedText, { kind: "ok" }>;
    }
  | {
      kind: "error";
      code: UserInstructionsReadErrorCode;
      linkTarget?: string;
      sizeBytes?: number;
      message?: string;
    };

async function loadText(filePath: string): Promise<LoadedText> {
  const inspected = await inspectPath(filePath);
  if (inspected.kind !== "file") return inspected;
  if (inspected.sizeBytes > USER_INSTRUCTIONS_EDIT_LIMIT_BYTES) {
    return {
      kind: "error",
      code: "TOO_LARGE_TO_EDIT",
      linkTarget: inspected.linkTarget,
      sizeBytes: inspected.sizeBytes,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(inspected.targetPath);
  } catch (error) {
    return {
      kind: "error",
      code: "READ_FAILED",
      linkTarget: inspected.linkTarget,
      message: getErrorMessage(error),
    };
  }
  // stat 与 readFile 之间文件可能被外部追加，按实际读到的字节再判一次。
  if (bytes.length > USER_INSTRUCTIONS_EDIT_LIMIT_BYTES) {
    return {
      kind: "error",
      code: "TOO_LARGE_TO_EDIT",
      linkTarget: inspected.linkTarget,
      sizeBytes: bytes.length,
    };
  }
  const decoded = decodeText(bytes);
  if (decoded.kind === "error") {
    return {
      kind: "error",
      code: decoded.code,
      linkTarget: inspected.linkTarget,
      sizeBytes: bytes.length,
    };
  }
  return { kind: "ok", linkTarget: inspected.linkTarget, bytes, decoded };
}

async function readUserInstructions(): Promise<UserInstructionsReadResult> {
  const path = getUserZcodeAgentsFilePath();
  const loaded = await loadText(path);
  const limits = {
    agentReadLimitBytes: USER_INSTRUCTIONS_AGENT_READ_LIMIT_BYTES,
    editLimitBytes: USER_INSTRUCTIONS_EDIT_LIMIT_BYTES,
  };
  if (loaded.kind === "missing") {
    return {
      kind: "ok",
      path,
      state: "missing",
      content: "",
      revision: null,
      sizeBytes: 0,
      eol: "lf",
      hasBom: false,
      mixedLineEndings: false,
      ...limits,
    };
  }
  if (loaded.kind === "error") {
    if (loaded.code === "READ_FAILED") {
      log.warn("[user-instructions] read failed", { path, message: loaded.message });
    }
    return { kind: "error", path, ...stripUndefined(loaded), code: loaded.code };
  }
  return {
    kind: "ok",
    path,
    ...(loaded.linkTarget ? { linkTarget: loaded.linkTarget } : {}),
    state: "file",
    content: loaded.decoded.content,
    revision: hashBytes(loaded.bytes),
    sizeBytes: loaded.bytes.length,
    eol: loaded.decoded.eol,
    hasBom: loaded.decoded.hasBom,
    mixedLineEndings: loaded.decoded.mixedLineEndings,
    ...limits,
  };
}

function stripUndefined(loaded: Extract<LoadedText, { kind: "error" }>): {
  linkTarget?: string;
  sizeBytes?: number;
  message?: string;
} {
  return {
    ...(loaded.linkTarget !== undefined ? { linkTarget: loaded.linkTarget } : {}),
    ...(loaded.sizeBytes !== undefined ? { sizeBytes: loaded.sizeBytes } : {}),
    ...(loaded.message !== undefined ? { message: loaded.message } : {}),
  };
}

function assertWriteParams(params: unknown): asserts params is UserInstructionsWriteParams {
  const candidate = params as Partial<UserInstructionsWriteParams> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.content !== "string" ||
    !(candidate.expectedRevision === null || typeof candidate.expectedRevision === "string") ||
    (candidate.eol !== "lf" && candidate.eol !== "crlf") ||
    typeof candidate.hasBom !== "boolean"
  ) {
    throw new TypeError("Invalid user instructions write params");
  }
}

async function writeUserInstructions(
  params: UserInstructionsWriteParams,
): Promise<UserInstructionsWriteResult> {
  assertWriteParams(params);
  const path = getUserZcodeAgentsFilePath();
  try {
    // 锁路径固定为 ~/.zcode/AGENTS.md 本身（而非链接目标），与引导页迁移共用。
    return await withFileLock(path, async (): Promise<UserInstructionsWriteResult> => {
      // 读取与保存之间路径类型可能变化，锁内复查；类型错误不是冲突，直接拒绝写入。
      const inspected = await inspectPath(path);
      if (inspected.kind === "error") {
        if (inspected.code === "READ_FAILED") {
          return { kind: "error", code: "WRITE_FAILED", message: inspected.message };
        }
        return { kind: "error", code: inspected.code };
      }

      const currentRevision =
        inspected.kind === "missing" ? null : hashBytes(await readFile(inspected.targetPath));
      if (currentRevision !== params.expectedRevision) {
        log.info("[user-instructions] write rejected by revision conflict", {
          path,
          hasCurrentFile: currentRevision !== null,
        });
        return { kind: "conflict", currentRevision };
      }

      const bytes = encodeUserInstructionsContent(params);
      await atomicWriteFile(
        inspected.kind === "missing" ? path : inspected.targetPath,
        bytes,
        inspected.kind === "missing" ? {} : { mode: inspected.mode },
      );
      log.info("[user-instructions] saved", {
        path,
        created: inspected.kind === "missing",
        viaLink: inspected.kind === "file" && inspected.linkTarget !== undefined,
        sizeBytes: bytes.length,
      });
      return { kind: "ok", revision: hashBytes(bytes), sizeBytes: bytes.length };
    });
  } catch (error) {
    log.warn("[user-instructions] write failed", { path, message: getErrorMessage(error) });
    return { kind: "error", code: "WRITE_FAILED", message: getErrorMessage(error) };
  }
}

async function readClaudeImportSource(): Promise<UserInstructionsImportSource> {
  const path = getClaudeUserInstructionsFilePath();
  const loaded = await loadText(path);
  if (loaded.kind === "missing") return { kind: "missing", path };
  if (loaded.kind === "error") {
    return {
      kind: "error",
      path,
      code: loaded.code,
      ...(loaded.message !== undefined ? { message: loaded.message } : {}),
    };
  }
  return { kind: "ok", path, content: loaded.decoded.content };
}

export function createUserInstructionsService(): IUserInstructionsService {
  return {
    read: readUserInstructions,
    write: writeUserInstructions,
    readClaudeImportSource,
  };
}
