// ============================================================
// Execution side of artifact publishing (Boundary B's executeArtifactPublish).
// ============================================================
// Terminology: artifact in this file always means a **user-facing artifact**—bytes the script
// delivers for the **user** through `artifact.file` / `artifact.markdown`. It does not mean the
// engine-internal artifact (`RunSettlement.artifact`, the top-level return value of
// `serializeWorkflowArtifact`, which is for the **model**). This file does not handle the latter.
//
// The division of responsibilities matches workflow-world-read.ts: workflow-driver.ts handles
// actor sessions and turn orchestration, while this half converts an `(op, id, path | content,
// opts)` call into a real **byte copy**, without touching sessions, models, or the journal. Four
// responsibilities live here and only here:
//   1. **Validate argument and opts shapes.** The engine guarantees only that `id` and payload
//      are nonempty strings (runtime guard); `opts` is the script's unchanged third argument.
//      This side defines what a title looks like, following `worldReadStringArgs`: fail loudly
//      and never coerce with `String(...)`.
//   2. **Resolve paths and check containment.** Reuse the world-read resolver
//      (`resolveWithinWorkspace`) and add a realpath check; see {@link resolveWorkspaceFile}.
//   3. **Enforce limits.** Constants are in the pure package (`ARTIFACT_CAPS`), but enforcement
//      is here because only this side can read the bytes. Always **reject rather than truncate**
//      over-limit content (same policy as world-read: a silently truncated PDF is a bad
//      deliverable, while a rejection that states the limit gives the script a contract it can
//      adjust to).
//   4. **Write to the tool-artifact store** and normalize its receipt to `ArtifactVersionRecord`.
//
// All rejections are structured `WorkflowError`s (codes: ArtifactSourceMissing /
// ArtifactPathOutsideWorkspace / ArtifactTooLarge / ArtifactStoreUnavailable), because content
// methods return catchable promises in scripts. The gated pattern
// `try { await artifact.file(…) } catch { … }` depends on these rejections reaching the script.

import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadBytesResult,
  type SessionId,
  type ToolArtifactStorePort,
  type ToolArtifactWriteResult,
} from "@zcode/contracts";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  WorkflowError,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
} from "@zcode/dynamic-workflow";
import { resolveWithinWorkspace, toWorkspaceRelative } from "./workflow-world-read.js";

/** Ports and base directory needed for artifact publishing (a subset of driver deps, like {@link WorldReadDeps}). */
interface ArtifactPublishDeps {
  /** Filesystem port used to read bytes from a file being published. */
  readonly fileSystemPort: FileSystemPort;
  /** Base directory for path resolution and relativization (workspace root). */
  readonly cwd: string;
  /**
   * Destination for the bytes. **Optional**: pure replay / fake assemblies have no store.
   * If absent, content methods reject loudly with `ArtifactStoreUnavailable`; they do not
   * silently degrade to "published an empty artifact" or fall back to writing in the workspace.
   */
  readonly artifactStore?: ToolArtifactStorePort;
  /**
   * Session scope for store writes = this run's **parent session**. It is paired with
   * `artifactStore`: each store write is recorded per session (`zcode-artifact://<session>/<id>`),
   * and without a session ID the record cannot be read back later. Both must be present for
   * publishing capability; if either is missing, return `ArtifactStoreUnavailable`. A missing
   * store means this assembly has no storage, while a missing ID is a wiring error, but to the
   * script both mean the same thing: publishing cannot happen and must fail loudly.
   */
  readonly parentSessionId?: SessionId;
}

/**
 * Publish one content artifact: validate shape → confirm the store exists → read bytes (file
 * from disk / markdown body) → write to the store → normalize to a persisted record.
 *
 * The order is intentional: **shape first, store second, I/O last**. Shape validation is cheapest
 * and independent of assembly; reading a file when the store is missing is wasted work and
 * could mask the real cause ("this assembly has no storage") with `ArtifactSourceMissing`.
 */
export async function executeArtifactPublish(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): Promise<ArtifactVersionRecord> {
  assertArtifactId(request);
  const opts = artifactPublishOptions(request);
  const store = requireArtifactStore(deps, request);
  const payload =
    request.op === "file"
      ? await readFilePayload(deps, request, opts)
      : markdownPayload(request);
  const written = await writePayload(store, request, payload);
  return {
    id: request.id,
    kind: request.op,
    version: request.version,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    // Use the **locally computed** contentType rather than the store receipt: the extension table
    // and `opts.contentType` override together determine the type, and the UI switches on this
    // string. Making store normalization (which infers the type from the persisted filename)
    // authoritative would make dispatch depend on the store implementation.
    contentType: payload.contentType,
    // Take bytes / uri from the store receipt: those are the bytes **actually written to the
    // store** and the same bytes that will be read back later.
    bytes: written.bytes,
    uri: written.uri,
    ...(payload.kind === "binary" ? { sourcePath: payload.sourcePath } : {}),
    // The engine has no clock (pure core, replayable), so this side supplies the publication
    // time. Publication time is required.
    publishedAt: Date.now(),
  };
}

// ——————————————————————————————— Internal: shape validation ———————————————————————————————

/** Validated `opts` (facade's `ArtifactOptions` / `ArtifactFileOptions`). */
interface ArtifactPublishOptions {
  title?: string;
  description?: string;
  /** Used only for `file`; markdown is always `text/markdown`. */
  contentType?: string;
}

/**
 * Runtime guard for artifact IDs. Compile-time literal diagnostics (the analyzer) are the main
 * gate, and the engine separately checks that an ID is a nonempty string. Validate its
 * character set and length again here because **this is the only side that uses the ID as a
 * key**: it becomes the store's `toolCallId` and eventually part of the persisted filename. An
 * invalid ID reaching here means something bypassed compilation, so use `DriverError` instead
 * of an `Artifact*` code; those codes should each describe their own specific failure.
 */
function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

/**
 * Read and validate script-supplied `opts`. Three rules, shared with {@link worldRunArgs}:
 *   1. It may be absent (`opts?`); if present, it must be an options object (not an array or null).
 *   2. Validate each recognized key's type and limit; **never coerce**. A title changed from
 *      undefined to `"undefined"` via `String(undefined)` would appear as an opaque string on the
 *      card instead of an actionable error.
 *   3. Ignore unknown keys (the facade's type signature rejects them at compile time; reporting
 *      them at runtime would move a compile-time issue to runtime). Therefore markdown methods
 *      do not read `contentType` at all.
 */
function artifactPublishOptions(request: ArtifactPublishRequest): ArtifactPublishOptions {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object, got ${describeArg(raw)}. ` +
        `Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = optionalText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = optionalText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType = request.op === "file" ? optionalContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/** An optional bounded text option (title / description). Length is measured in characters (UTF-16 code units). */
function optionalText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string, got ${describeArg(value)}.`,
    );
  }
  if (value.length > max) {
    // Reject instead of truncating: a title cut off halfway through looks like a **valid** but
    // bad artifact, and the card has no way to show that it was truncated.
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ` +
        `${max}. Shorten it.`,
    );
  }
  return value;
}

/**
 * Override value for `opts.contentType`. It must be a bare MIME without parameters (`type/subtype`):
 * the UI dispatches on this exact string (`text/markdown` uses a markdown card,
 * `application/pdf` a PDF card), and `text/markdown; charset=utf-8` would miss the branch entirely,
 * landing in the download card despite an explicit type.
 */
function optionalContentType(request: ArtifactPublishRequest, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType must be a string, got ${describeArg(value)}.`,
    );
  }
  if (!CONTENT_TYPE_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as ` +
        `'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on ` +
        `the exact string.`,
    );
  }
  return value;
}

// ——————————————————————————————— Internal: read bytes ———————————————————————————————

/** Content to write to the store. `file` uses binary write; `markdown` uses text write. */
type ArtifactPayload =
  | {
      readonly kind: "binary";
      readonly bytes: Uint8Array;
      readonly contentType: string;
      /** Extension for the persisted filename (preserve it because the store infers type from the filename when reading back). */
      readonly extension?: string;
      /** Original workspace-relative path (source attribution + "show in workspace"). */
      readonly sourcePath: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly contentType: "text/markdown" };

/**
 * `artifact.file(id, path, opts)`: resolve path → read bytes (cap+1 probe) → determine contentType.
 */
async function readFilePayload(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
  opts: ArtifactPublishOptions,
): Promise<ArtifactPayload> {
  const given = request.path;
  if (typeof given !== "string" || given === "") {
    // The engine already verified payload is a string; an empty string can only come from a wiring error.
    throw new WorkflowError(
      "DriverError",
      `artifact.file: path must be a non-empty string, got ${describeArg(given)}. Pass the ` +
        `workspace-relative path the subagent wrote.`,
    );
  }
  const { real, relative } = await resolveWorkspaceFile(deps, given);
  const bytes = await readCappedBytes(deps, given, real);
  const extension = fileExtension(real);
  return {
    kind: "binary",
    bytes,
    contentType:
      opts.contentType ??
      (extension === undefined ? undefined : EXTENSION_CONTENT_TYPES[extension]) ??
      // If the extension is absent from the table, do not guess (no magic-byte sniffing). The UI
      // will show a "download / show in workspace" card instead of rendering something it cannot read.
      "application/octet-stream",
    ...(extension === undefined ? {} : { extension }),
    sourcePath: relative,
  };
}

/**
 * Resolve the script's **workspace-relative** path to a readable real path and check containment twice.
 *
 * First perform a lexical check ({@link resolveWithinWorkspace}, same criterion as `files.read`),
 * then check again after realpath—**symlinks are checked using their resolved real path**.
 * World reads intentionally perform only the lexical check (the script sees the bytes it reads
 * and is responsible for whether it escapes). This side cannot copy that behavior: publishing
 * **copies bytes into a persistent store and presents them to the user**, so a symlink could
 * turn `~/.ssh/id_rsa` into a card. This check enforces the same invariant on the write side.
 *
 * Resolve `cwd` itself with realpath too: on macOS `/tmp` is a symlink to `/private/tmp`, and
 * without normalization every file inside the workspace would appear to escape it.
 */
async function resolveWorkspaceFile(
  deps: ArtifactPublishDeps,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWithinWorkspace(deps.cwd, given);
  if (resolved === undefined) throw outsideWorkspace(given);
  // Use the **script-supplied path** (normalized) for source attribution, not realpath: "show in
  // workspace" on the card should point to a location the user recognizes, not the symlink target.
  const relative = toWorkspaceRelative(deps.cwd, resolved);

  let realCwd: string;
  let real: string;
  try {
    realCwd = await realpath(deps.cwd);
  } catch (cause) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: cannot resolve the workspace root '${deps.cwd}': ${errorText(cause)}`,
      { cause },
    );
  }
  try {
    real = await realpath(resolved);
  } catch (cause) {
    // ENOENT (including a missing intermediate segment) reaches this branch: a missing path and
    // a symlink pointing to a missing target mean the same thing.
    throw sourceMissing(given, cause);
  }
  if (resolveWithinWorkspace(realCwd, real) === undefined) throw outsideWorkspace(given);
  return { real, relative };
}

/**
 * Read bytes with a **cap+1 probe**: the port's `maxBytes` means "return too_large when exceeded,
 * do not truncate," so requesting cap+1 distinguishes "exactly cap bytes" (allow) from "over
 * cap" (reject) while reading at most one extra byte. Same pattern as `files.grep` / `git.diff`.
 */
async function readCappedBytes(
  deps: ArtifactPublishDeps,
  given: string,
  path: string,
): Promise<Uint8Array> {
  const cap = ARTIFACT_CAPS.maxFileBytes;
  let result: FileSystemReadBytesResult;
  try {
    result = await deps.fileSystemPort.readBinaryFile({ path, maxBytes: cap + 1 });
  } catch (cause) {
    if (isFileSystemPortError(cause)) {
      if (cause.code === "too_large") throw tooLarge(given, cap);
      // not_found / is_directory / not_file all mean "there is no regular file to publish here."
      if (cause.code === "not_found" || cause.code === "is_directory" || cause.code === "not_file") {
        throw sourceMissing(given, cause);
      }
    }
    throw new WorkflowError(
      "DriverError",
      `artifact.file: failed to read '${given}': ${errorText(cause)}`,
      { cause },
    );
  }
  if (result.content.byteLength > cap) throw tooLarge(given, cap);
  return result.content;
}

/** `artifact.markdown(id, content, opts)`: measure body size in UTF-8 bytes and reject if over the limit. */
function markdownPayload(request: ArtifactPublishRequest): ArtifactPayload {
  const content = request.content;
  if (typeof content !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.markdown: content must be a string, got ${describeArg(content)}.`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = ARTIFACT_CAPS.maxMarkdownBytes;
  if (bytes > cap) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.markdown: content is ${bytes} bytes, over the cap of ${cap} bytes. Shorten ` +
        `it, or write the long content to a workspace file and publish it with artifact.file.`,
    );
  }
  return { kind: "text", text: content, contentType: "text/markdown" };
}

// ——————————————————————————————— Internal: write to store ———————————————————————————————

/** Confirmed publishing destination: store and session scope (see {@link ArtifactPublishDeps}). */
interface ArtifactStoreTarget {
  readonly store: ToolArtifactStorePort;
  readonly sessionId: SessionId;
}

/**
 * Confirm that this publish operation has a destination, or return `ArtifactStoreUnavailable`.
 * **Probe each op separately**: files require binary write (`writeToolResultBinaryArtifact` is
 * optional on the port), while markdown needs only text write. A store with only text write can
 * therefore publish markdown but not files. Return a named rejection instead of sending a PDF
 * through the text channel as UTF-8, which would silently corrupt the bytes.
 */
function requireArtifactStore(
  deps: ArtifactPublishDeps,
  request: ArtifactPublishRequest,
): ArtifactStoreTarget {
  const store = deps.artifactStore;
  if (store === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because this assembly has no ` +
        `artifact store.`,
    );
  }
  if (request.op === "file" && store.writeToolResultBinaryArtifact === undefined) {
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
        `does not support binary writes.`,
    );
  }
  const sessionId = deps.parentSessionId;
  if (sessionId === undefined || sessionId === "") {
    // A present store with a missing session ID can only be a wiring error (production assembly
    // always provides both together). Still report the same code: to the script, both mean this
    // publish has no destination.
    throw new WorkflowError(
      "ArtifactStoreUnavailable",
      `artifact.${request.op}: cannot publish "${request.id}" because the artifact store has ` +
        `no session scope (parent session id not wired).`,
    );
  }
  return { store, sessionId };
}

/**
 * Write to the store. Constraints for the four arguments:
 *   - `retention: "project"`: the artifact must outlive the session (the hub reads run-history artifacts across sessions).
 *   - `toolName: "CreateWorkflow"`: the artifact belongs to the tool that started this run.
 *   - `toolCallId: `${runId}:${siteId}@${ordinal}``: each version stores one set of bytes, and
 *     (run, site, ordinal) uniquely identifies a publish (the engine computes the version before
 *     dispatch; rerunning the same version uses the same ordinal).
 *   - `sessionId` = parent session.
 */
async function writePayload(
  target: ArtifactStoreTarget,
  request: ArtifactPublishRequest,
  payload: ArtifactPayload,
): Promise<ToolArtifactWriteResult> {
  const common = {
    sessionId: target.sessionId,
    toolCallId: `${request.runId}:${request.siteId}@${request.ordinal}`,
    toolName: ARTIFACT_TOOL_NAME,
    retention: "project" as const,
  };
  try {
    if (payload.kind === "text") {
      return await target.store.writeToolResultArtifact({
        ...common,
        content: payload.text,
        contentType: payload.contentType,
      });
    }
    // Binary-write support was already checked in requireArtifactStore (op === "file" branch).
    const writeBinary = target.store.writeToolResultBinaryArtifact;
    if (writeBinary === undefined) {
      throw new WorkflowError(
        "ArtifactStoreUnavailable",
        `artifact.file: cannot publish "${request.id}" because this assembly's artifact store ` +
          `does not support binary writes.`,
      );
    }
    return await writeBinary.call(target.store, {
      ...common,
      content: payload.bytes,
      contentType: payload.contentType,
      // Pass the extension to the store with the bytes: it infers type from the persisted
      // filename on readback, and losing the extension would make an .xlsx appear as
      // application/octet-stream.
      ...(payload.extension === undefined ? {} : { extension: payload.extension }),
    });
  } catch (cause) {
    if (cause instanceof WorkflowError) throw cause;
    // A write failure (disk full, permissions, store error) is a **specific** failure, unlike a
    // missing store, so do not reuse ArtifactStoreUnavailable. Include the reason so the
    // journal's failure_json explains what happened.
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: writing "${request.id}" v${request.version} to the artifact ` +
        `store failed: ${errorText(cause)}`,
      { cause },
    );
  }
}

// ——————————————————————————————— Pure helpers ———————————————————————————————

/** Owning tool name for the artifact in the store: it was published by this CreateWorkflow call. */
const ARTIFACT_TOOL_NAME = "CreateWorkflow";

/**
 * Extension → MIME. Anything outside the table uses `application/octet-stream`:
 * **do not sniff content** (magic bytes would introduce a second criterion, and the two
 * criteria would eventually disagree).
 *
 * Why not reuse core's `inferAttachmentMimeFromPath`: that table is for **model input
 * attachments**, with a `text/plain` fallback (feeding text-like files to the model is
 * intentional). Here the consumer is UI dispatch, and the fallback must mean "unknown, show a
 * download card"—the correct fallback is the opposite in these two places.
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Bare MIME (`type/subtype`, no parameters). See {@link optionalContentType} for the rationale. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * Filename extension (lowercase, without the dot). Accept only `[a-z0-9]+`: `archive.tar.gz`
 * yields `gz`; `Makefile`, `.gitignore` (leading dot, no suffix), and `report.v2 final` have no extension.
 */
function fileExtension(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : undefined;
}

function outsideWorkspace(given: string): WorkflowError {
  return new WorkflowError(
    "ArtifactPathOutsideWorkspace",
    `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by ` +
      `their real path). Only files inside the workspace can be published.`,
  );
}

function sourceMissing(given: string, cause: unknown): WorkflowError {
  return new WorkflowError(
    "ArtifactSourceMissing",
    `artifact.file: '${given}' does not exist or is not a regular file. Confirm the subagent ` +
      `actually wrote it before publishing.`,
    { cause },
  );
}

function tooLarge(given: string, cap: number): WorkflowError {
  return new WorkflowError(
    "ArtifactTooLarge",
    `artifact.file: '${given}' is over the cap of ${cap} bytes. Publish a smaller artifact ` +
      `(a summary, a slice, or a compressed version).`,
  );
}

/** Short description of an argument shape (for error messages only; do not echo full contents). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** One-line text for an arbitrary thrown value (for error messages). */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
