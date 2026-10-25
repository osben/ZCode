import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** Rescan on a miss, bypassing a file index that has not yet expired. */
  refresh?: boolean;
}

export interface IFileService {
  /** Match and return bounded candidates in the Host to avoid downloading the full file index to the Renderer. */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * Read a range of raw file bytes by offset for on-demand loading of large binary files such as PDFs.
   * The return value must remain a top-level Uint8Array: RPC serialization uses the raw byte path only for top-level binary data;
   * nesting it in an object field degrades to JSON+base64. Return a shorter array at EOF.
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * Length (in characters) of the column-packed workspace file index. Used with listWorkspaceFilesRange;
   * callers fetch it in chunks by length (see fetchWorkspaceFileEntriesPacked).
   * Returns a number: RPC Int fast path.
   */
  listWorkspaceFilesLength(params: { rootPath: string }): Promise<number>;
  /**
   * Return a chunk of the column-packed string (workspaceFileEntriesCodec format, [offset, offset+length)).
   * It must be returned as a bare top-level string: the RPC String fast path uses a length prefix and raw bytes; an Object would
   * JSON-escape the large string (measured 6–9 s of main-thread work). Keep each chunk under ~4 MB: reassembling large messages in the
   * renderer takes several seconds (measured 4.6–6.3 s), while chunking and yielding between chunks lets the main thread process each small piece (~50 ms),
   * keeping input responsive.
   * The Host caches the complete pack for 60 s with a .zcodeignore fingerprint; chunking only slices that cached pack.
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
  }): Promise<string>;
  /**
   * Read/write workspace search ignore rules (.zcodeignore) for editing in Settings.
   * source: "file" means existing file contents; "template" means an initial preview before the file is created (written only on save).
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * Section actions in Settings (return new content to fill the editor; write to disk only on save):
   * "sync-gitignore" rewrites only the gitignore sync section (preserving the default and custom sections);
   * "reset-defaults" resets only the default exclusion section (preserving the gitignore and custom sections).
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
