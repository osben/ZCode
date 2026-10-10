import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Agent（CLI adapter）对每个指令文件读取的上限，超出部分被截断。 */
export const USER_INSTRUCTIONS_AGENT_READ_LIMIT_BYTES = 100 * 1024;
/** 设置页可加载进编辑器的上限，超过后只显示过大态。 */
export const USER_INSTRUCTIONS_EDIT_LIMIT_BYTES = 5 * 1024 * 1024;

export type UserInstructionsEol = "lf" | "crlf";

export type UserInstructionsReadErrorCode =
  | "BROKEN_LINK"
  | "NOT_REGULAR_FILE"
  | "NOT_UTF8"
  | "TOO_LARGE_TO_EDIT"
  | "READ_FAILED";

export type UserInstructionsReadResult =
  | {
      kind: "ok";
      path: string;
      linkTarget?: string;
      state: "missing" | "file";
      /** 已规范化为 LF 且去掉 BOM 的文本。 */
      content: string;
      /** 磁盘原始字节的 sha256；文件不存在时为 null。 */
      revision: string | null;
      sizeBytes: number;
      eol: UserInstructionsEol;
      hasBom: boolean;
      mixedLineEndings: boolean;
      agentReadLimitBytes: number;
      editLimitBytes: number;
    }
  | {
      kind: "error";
      path: string;
      linkTarget?: string;
      code: UserInstructionsReadErrorCode;
      sizeBytes?: number;
      message?: string;
    };

export type UserInstructionsWriteResult =
  | { kind: "ok"; revision: string; sizeBytes: number }
  | { kind: "conflict"; currentRevision: string | null }
  | {
      kind: "error";
      code: "BROKEN_LINK" | "NOT_REGULAR_FILE" | "WRITE_FAILED";
      message?: string;
    };

export type UserInstructionsImportSource =
  | { kind: "missing"; path: string }
  | { kind: "ok"; path: string; content: string }
  | { kind: "error"; path: string; code: UserInstructionsReadErrorCode; message?: string };

export interface UserInstructionsWriteParams {
  /** UI 草稿（LF）；服务按 eol/hasBom 还原磁盘格式。 */
  content: string;
  expectedRevision: string | null;
  eol: UserInstructionsEol;
  hasBom: boolean;
}

/**
 * 全局用户指令 `~/.zcode/AGENTS.md` 的读写服务。
 * 磁盘文件是唯一事实源；服务不缓存内容，每次调用都重新读取。
 */
export interface IUserInstructionsService {
  read(): Promise<UserInstructionsReadResult>;
  write(params: UserInstructionsWriteParams): Promise<UserInstructionsWriteResult>;
  readClaudeImportSource(): Promise<UserInstructionsImportSource>;
}

export const IUserInstructionsService = createServiceDescriptor<IUserInstructionsService>(
  ServiceChannels.UserInstructions,
);
