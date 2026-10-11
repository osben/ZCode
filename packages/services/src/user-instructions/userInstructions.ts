import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Maximum amount of each instruction file read by the Agent (CLI adapter); excess content is truncated. */
export const USER_INSTRUCTIONS_AGENT_READ_LIMIT_BYTES = 100 * 1024;
/** Maximum amount the settings page can load into the editor; larger files show an oversized-file state. */
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
      /** Text normalized to LF with the BOM removed. */
      content: string;
      /** SHA-256 of the original bytes on disk; null when the file does not exist. */
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
  /** UI draft (LF); the service restores the on-disk format using eol/hasBom. */
  content: string;
  expectedRevision: string | null;
  eol: UserInstructionsEol;
  hasBom: boolean;
}

/**
 * Read/write service for the global user instructions file at `~/.zcode/AGENTS.md`.
 * The file on disk is the single source of truth; the service does not cache its contents and reads it again on each call.
 */
export interface IUserInstructionsService {
  read(): Promise<UserInstructionsReadResult>;
  write(params: UserInstructionsWriteParams): Promise<UserInstructionsWriteResult>;
  readClaudeImportSource(): Promise<UserInstructionsImportSource>;
}

export const IUserInstructionsService = createServiceDescriptor<IUserInstructionsService>(
  ServiceChannels.UserInstructions,
);
