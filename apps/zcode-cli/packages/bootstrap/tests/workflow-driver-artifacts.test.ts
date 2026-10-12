/**
 * Driver-side execution of user-facing artifacts (docs/dynamic-workflow/authoring.md
 * "Publishing content" + the driver row in the Tests table). Follows the shape of
 * workflow-driver-world-run.test.ts: only the driver port itself is touched, without going
 * through the script or the engine — the facade's type signature, the compile-time literal
 * rules for ids, and version inference all live upstream. What this file guards against is
 * wiring mistakes beyond the type system, plus the mapping contract of "one publish ->
 * one persisted record / one named rejection".
 *
 * ⚠ Terminology: in this file, artifact always means the **user-facing artifact** (the
 * bytes a script delivers for the user to see), not the engine-internal artifact (the
 * top-level return value, for the model to read). See the spec's terminology table.
 *
 * The file system uses a **real** temp directory + NodeFileSystemAdapter: the two things
 * proven on this side (symlinks judged out-of-bounds by real path, cap+1 probing) are
 * properties of a real file system and cannot be proven with a fake port. The store is a
 * fake — its persistence behavior is not part of this slice; this slice is only
 * responsible for "the parameters written in".
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileSystemError } from "@zcode/contracts";
import type {
  ExecutionPort,
  FileSystemPort,
  SessionId,
  ToolArtifactStorePort,
  ToolArtifactWriteResult,
  ToolBinaryArtifactWriteRequest,
} from "@zcode/contracts";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import {
  ARTIFACT_CAPS,
  InMemoryJournalStore,
  WorkflowError,
  type ArtifactPublishRequest,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";

const SESSION_ID = "sess_parent" as SessionId;

/** Execution port that fails on any touch: artifact publishing must not spawn subprocesses. */
function unsupportedExecutionPort(): ExecutionPort {
  return new Proxy({} as ExecutionPort, {
    get(_target, name) {
      return () => {
        throw new Error(`executionPort.${String(name)} 不应被产物发布触及`);
      };
    },
  });
}

function noopSink(): WorkflowReportSink {
  const unexpected = (name: string) => (): never => {
    throw new Error(`noopSink.${name} 不应被触及`);
  };
  return {
    askSubmitAttempted: unexpected("askSubmitAttempted"),
    askTurnEnded: unexpected("askTurnEnded"),
    askProgress: unexpected("askProgress"),
    askStats: unexpected("askStats"),
    askFailed: unexpected("askFailed"),
  };
}

interface RecordedWrite {
  kind: "text" | "binary";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  retention: string | undefined;
  contentType: string;
  extension: string | undefined;
  byteLength: number;
  text?: string;
}

/** Fake store that records write parameters. `binary: false` builds a text-write-only store (for capability probing). */
function fakeArtifactStore(options?: { binary?: boolean; failWith?: Error }): {
  store: ToolArtifactStorePort;
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const receipt = (index: number, bytes: number, contentType: string): ToolArtifactWriteResult => ({
    id: `artifact-${index}`,
    uri: `zcode-artifact://${SESSION_ID}/artifact-${index}`,
    path: `/store/${SESSION_ID}/artifact-${index}`,
    bytes,
    contentType,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
  });
  const store: ToolArtifactStorePort = {
    writeToolResultArtifact: async (request) => {
      if (options?.failWith) throw options.failWith;
      const byteLength = Buffer.byteLength(request.content, "utf8");
      writes.push({
        kind: "text",
        sessionId: request.sessionId,
        toolCallId: String(request.toolCallId),
        toolName: request.toolName,
        retention: request.retention,
        contentType: request.contentType ?? "",
        extension: undefined,
        byteLength,
        text: request.content,
      });
      return receipt(writes.length, byteLength, request.contentType ?? "text/plain");
    },
    readToolResultArtifact: async () => {
      throw new Error("readToolResultArtifact 不应被本用例触及");
    },
  };
  if (options?.binary !== false) {
    store.writeToolResultBinaryArtifact = async (request: ToolBinaryArtifactWriteRequest) => {
      if (options?.failWith) throw options.failWith;
      writes.push({
        kind: "binary",
        sessionId: request.sessionId,
        toolCallId: String(request.toolCallId),
        toolName: request.toolName,
        retention: request.retention,
        contentType: request.contentType,
        extension: request.extension,
        byteLength: request.content.byteLength,
      });
      return receipt(writes.length, request.content.byteLength, request.contentType);
    };
  }
  return { store, writes };
}

function makeDriver(input: {
  cwd: string;
  fileSystemPort?: FileSystemPort;
  artifactStore?: ToolArtifactStorePort;
  parentSessionId?: SessionId;
}): WorkflowDriver {
  return createAgentRuntimeWorkflowDriver({
    journal: new InMemoryJournalStore(),
    emit: () => undefined,
    fileSystemPort: input.fileSystemPort ?? createNodeFileSystemAdapter(),
    executionPort: unsupportedExecutionPort(),
    escalationRegistry: createWorkflowEscalationRegistry(),
    cwd: input.cwd,
    runId: "run-1",
    ...(input.artifactStore === undefined ? {} : { artifactStore: input.artifactStore }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    runtimeFactory: () => {
      throw new Error("runtimeFactory 不应被产物发布触及");
    },
  })(noopSink());
}

function fileRequest(overrides: Partial<ArtifactPublishRequest> = {}): ArtifactPublishRequest {
  return {
    runId: "run-1",
    siteId: "artifact#1",
    ordinal: 1,
    op: "file",
    id: "report",
    version: 1,
    path: "out/report.pdf",
    ...overrides,
  };
}

function markdownRequest(overrides: Partial<ArtifactPublishRequest> = {}): ArtifactPublishRequest {
  return {
    runId: "run-1",
    siteId: "artifact#2",
    ordinal: 1,
    op: "markdown",
    id: "summary",
    version: 1,
    content: "# 结论\n\n跑通了。",
    ...overrides,
  };
}

/** Asserts that a publish is rejected with a given structured code and hands the error back to the caller for message assertions. */
async function rejection(promise: Promise<unknown>, code: string): Promise<WorkflowError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "发布本应被拒绝").toBeInstanceOf(WorkflowError);
  const error = caught as WorkflowError;
  expect(error.code).toBe(code);
  return error;
}

/** Workspace shared by this suite: a real temp directory containing an out-of-bounds target for the symlink cases. */
let workspace: string;
let outside: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-dwf-artifact-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(join(workspace, "out"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "TOP SECRET", "utf8");
  await writeFile(join(workspace, "out", "report.pdf"), "%PDF-1.7\n…", "utf8");
});

afterAll(async () => {
  await rm(join(workspace, ".."), { recursive: true, force: true });
});

describe("workflow driver — 产物发布（artifact.file）", () => {
  it("把字节写进 store，并交出一条完整的落库记录", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });
    const before = Date.now();

    const record = await driver.executeArtifactPublish!(
      fileRequest({
        version: 3,
        opts: { title: "回归报告", description: "本轮的性能回归" },
      }),
    );

    expect(record).toMatchObject({
      id: "report",
      kind: "file",
      version: 3,
      title: "回归报告",
      description: "本轮的性能回归",
      contentType: "application/pdf",
      bytes: Buffer.byteLength("%PDF-1.7\n…", "utf8"),
      uri: `zcode-artifact://${SESSION_ID}/artifact-1`,
      sourcePath: "out/report.pdf",
    });
    // publishedAt is filled in by the driver (the engine has no clock), and must be a moment within this call.
    expect(record.publishedAt ?? 0).toBeGreaterThanOrEqual(before);
    expect(record.publishedAt ?? 0).toBeLessThanOrEqual(Date.now());
    expect(writes).toHaveLength(1);
  });

  it("按 spec 的四个参数写 store（retention / toolName / toolCallId / sessionId）", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await driver.executeArtifactPublish!(
      fileRequest({ runId: "run-42", siteId: "artifact#7", ordinal: 5 }),
    );

    expect(writes[0]).toMatchObject({
      kind: "binary",
      sessionId: SESSION_ID,
      // One set of bytes per version; (run, site, ordinal) uniquely identifies exactly one publish.
      toolCallId: "run-42:artifact#7@5",
      toolName: "CreateWorkflow",
      // Artifacts must outlive the session (the hub reads run history across sessions).
      retention: "project",
      contentType: "application/pdf",
      // The extension is handed over together with the bytes: on read-back the store infers the type from the persisted file name.
      extension: "pdf",
    });
  });

  it("路径是工作区相对的，子目录与反斜杠都归一成正斜杠出处", async () => {
    await mkdir(join(workspace, "a", "b"), { recursive: true });
    await writeFile(join(workspace, "a", "b", "note.txt"), "hi", "utf8");
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(
      fileRequest({ path: "./a/b/../b/note.txt" }),
    );

    expect(record.sourcePath).toBe("a/b/note.txt");
    expect(record.contentType).toBe("text/plain");
  });

  it("越出工作区的相对路径被 ArtifactPathOutsideWorkspace 拒绝", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const error = await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "../outside/secret.txt" })),
      "ArtifactPathOutsideWorkspace",
    );
    expect(error.message).toContain("../outside/secret.txt");
    expect(writes).toHaveLength(0);
  });

  it("绝对路径同样按越界处理（工作区之外没有可展示的出处）", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: join(outside, "secret.txt") })),
      "ArtifactPathOutsideWorkspace",
    );
  });

  it("工作区内指向外部的软链按解析后的真实路径判越界", async () => {
    // This is the boundary between publishing and world reads: files.read only does lexical
    // checks, while publishing copies bytes into a persistent store and puts them in front
    // of the user, so symlinks must be sealed off.
    const link = join(workspace, "leak.txt");
    await rm(link, { force: true });
    await symlink(join(outside, "secret.txt"), link);
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "leak.txt" })),
      "ArtifactPathOutsideWorkspace",
    );
    expect(writes).toHaveLength(0);
  });

  it("工作区内部的软链照常可发布（判据是真实路径的落点，而非是否软链）", async () => {
    const link = join(workspace, "alias.pdf");
    await rm(link, { force: true });
    await symlink(join(workspace, "out", "report.pdf"), link);
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(fileRequest({ path: "alias.pdf" }));
    expect(record.sourcePath).toBe("alias.pdf");
    expect(record.contentType).toBe("application/pdf");
  });

  it("路径不存在 / 指向目录都是 ArtifactSourceMissing", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const missing = await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "out/nope.pdf" })),
      "ArtifactSourceMissing",
    );
    expect(missing.message).toContain("out/nope.pdf");
    await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "out" })),
      "ArtifactSourceMissing",
    );
  });

  it("超过 20 MiB 上限的文件被拒绝而不是截断，消息给出下一步", async () => {
    const big = join(workspace, "out", "huge.bin");
    await writeFile(big, Buffer.alloc(ARTIFACT_CAPS.maxFileBytes + 1, 0));
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const error = await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "out/huge.bin" })),
      "ArtifactTooLarge",
    );
    // The code is already asserted by rejection(); the message only checks the variable part (the cap value).
    expect(error.message).toContain(String(ARTIFACT_CAPS.maxFileBytes));
    expect(writes).toHaveLength(0);
    await rm(big, { force: true });
  });

  it("按 cap+1 向端口探测上限（恰好 cap 字节必须放行，而不是与溢出混为一谈）", async () => {
    const seen: (number | undefined)[] = [];
    // Only readBinaryFile is stubbed: path resolution goes through the real file system
    // (symlink re-check needs a real realpath), and "what maxBytes the port received" is
    // the only thing this case needs to prove.
    const port = {
      readBinaryFile: async (request: { path: string; maxBytes?: number }) => {
        seen.push(request.maxBytes);
        return {
          path: request.path,
          content: new Uint8Array(ARTIFACT_CAPS.maxFileBytes),
          bytesRead: ARTIFACT_CAPS.maxFileBytes,
          sizeBytes: ARTIFACT_CAPS.maxFileBytes,
        };
      },
    } as unknown as FileSystemPort;
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({
      cwd: workspace,
      fileSystemPort: port,
      artifactStore: store,
      parentSessionId: SESSION_ID,
    });

    const record = await driver.executeArtifactPublish!(fileRequest());
    expect(seen).toEqual([ARTIFACT_CAPS.maxFileBytes + 1]);
    expect(record.bytes).toBe(ARTIFACT_CAPS.maxFileBytes);
    expect(writes).toHaveLength(1);
  });

  it("端口自己报的 too_large 也归一成 ArtifactTooLarge", async () => {
    const port = {
      readBinaryFile: async () => {
        throw createFileSystemError({ code: "too_large", message: "too big" });
      },
    } as unknown as FileSystemPort;
    const { store } = fakeArtifactStore();
    const driver = makeDriver({
      cwd: workspace,
      fileSystemPort: port,
      artifactStore: store,
      parentSessionId: SESSION_ID,
    });

    await rejection(driver.executeArtifactPublish!(fileRequest()), "ArtifactTooLarge");
  });
});

describe("workflow driver — 产物的内容类型", () => {
  const table: [string, string][] = [
    ["pdf", "application/pdf"],
    ["html", "text/html"],
    ["htm", "text/html"],
    ["md", "text/markdown"],
    ["markdown", "text/markdown"],
    ["txt", "text/plain"],
    ["csv", "text/csv"],
    ["json", "application/json"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["svg", "image/svg+xml"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ];

  it.each(table)("扩展名 .%s → %s", async (extension, contentType) => {
    const name = `typed.${extension}`;
    await writeFile(join(workspace, "out", name), "x", "utf8");
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(fileRequest({ path: `out/${name}` }));
    expect(record.contentType).toBe(contentType);
    expect(writes[0]?.contentType).toBe(contentType);
  });

  it("表外扩展名与无扩展名都落到 application/octet-stream（不做内容嗅探）", async () => {
    await writeFile(join(workspace, "out", "blob.zzz"), "x", "utf8");
    await writeFile(join(workspace, "out", "Makefile"), "x", "utf8");
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    expect(
      (await driver.executeArtifactPublish!(fileRequest({ path: "out/blob.zzz" }))).contentType,
    ).toBe("application/octet-stream");
    expect(
      (await driver.executeArtifactPublish!(fileRequest({ path: "out/Makefile" }))).contentType,
    ).toBe("application/octet-stream");
  });

  it("opts.contentType 覆盖扩展名表", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(
      fileRequest({ opts: { contentType: "text/html" } }),
    );
    expect(record.contentType).toBe("text/html");
    // The extension still comes from the source file: the override changes the display type, not the persisted file name.
    expect(writes[0]).toMatchObject({ contentType: "text/html", extension: "pdf" });
  });

  it("带参数的 contentType 被拒绝（展示侧按裸 MIME 精确分派）", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const error = await rejection(
      driver.executeArtifactPublish!(
        fileRequest({ opts: { contentType: "text/markdown; charset=utf-8" } }),
      ),
      "DriverError",
    );
    // The message only checks the variable part: the rejected contentType appears verbatim.
    expect(error.message).toContain("text/markdown; charset=utf-8");
  });
});

describe("workflow driver — 产物发布（artifact.markdown）", () => {
  it("走文本写通道，恒 text/markdown，且不带 sourcePath", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(
      markdownRequest({ opts: { title: "小结" } }),
    );

    expect(record).toMatchObject({
      id: "summary",
      kind: "markdown",
      version: 1,
      title: "小结",
      contentType: "text/markdown",
    });
    expect(record.sourcePath).toBeUndefined();
    expect(writes[0]).toMatchObject({
      kind: "text",
      contentType: "text/markdown",
      toolName: "CreateWorkflow",
      retention: "project",
      toolCallId: "run-1:artifact#2@1",
      text: "# 结论\n\n跑通了。",
    });
  });

  it("正文按 UTF-8 计字节：恰好 256 KB 放行，多一个字节即 ArtifactTooLarge", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const exact = "a".repeat(ARTIFACT_CAPS.maxMarkdownBytes);
    const ok = await driver.executeArtifactPublish!(markdownRequest({ content: exact }));
    expect(ok.bytes).toBe(ARTIFACT_CAPS.maxMarkdownBytes);

    const error = await rejection(
      driver.executeArtifactPublish!(markdownRequest({ content: `${exact}a` })),
      "ArtifactTooLarge",
    );
    expect(error.message).toContain(String(ARTIFACT_CAPS.maxMarkdownBytes));
    expect(writes).toHaveLength(1);
  });

  it("多字节字符按 UTF-8 而不是按字符数计上限", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    // "中" is 3 bytes in UTF-8: the character count is far below the limit while the byte count just crosses it.
    const content = "中".repeat(Math.floor(ARTIFACT_CAPS.maxMarkdownBytes / 3) + 1);
    expect(content.length).toBeLessThan(ARTIFACT_CAPS.maxMarkdownBytes);
    await rejection(
      driver.executeArtifactPublish!(markdownRequest({ content })),
      "ArtifactTooLarge",
    );
  });

  it("markdown 不读 opts.contentType（这一族恒 text/markdown）", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(
      markdownRequest({ opts: { contentType: "text/html" } }),
    );
    expect(record.contentType).toBe("text/markdown");
  });
});

describe("workflow driver — 产物的实参形状", () => {
  const cases: [string, unknown][] = [
    ["字符串", "title"],
    ["数组", ["title"]],
    ["null", null],
  ];

  it.each(cases)("opts 是%s时大声拒绝", async (_label, opts) => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const error = await rejection(
      driver.executeArtifactPublish!(markdownRequest({ opts })),
      "DriverError",
    );
    expect(error.message).toContain("opts");
  });

  it("title / description 必须是 string，绝不强转", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const title = await rejection(
      driver.executeArtifactPublish!(markdownRequest({ opts: { title: 7 } })),
      "DriverError",
    );
    expect(title.message).toContain("opts.title");
    expect(title.message).toContain("number");
    const description = await rejection(
      driver.executeArtifactPublish!(markdownRequest({ opts: { description: {} } })),
      "DriverError",
    );
    expect(description.message).toContain("opts.description");
  });

  it("title / description 超长按上限拒绝而不是截断", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const title = await rejection(
      driver.executeArtifactPublish!(
        markdownRequest({ opts: { title: "x".repeat(ARTIFACT_CAPS.maxTitleLength + 1) } }),
      ),
      "ArtifactTooLarge",
    );
    expect(title.message).toContain(String(ARTIFACT_CAPS.maxTitleLength));
    await rejection(
      driver.executeArtifactPublish!(
        markdownRequest({
          opts: { description: "x".repeat(ARTIFACT_CAPS.maxDescriptionLength + 1) },
        }),
      ),
      "ArtifactTooLarge",
    );
    // Exactly at the limit is allowed through.
    const ok = await driver.executeArtifactPublish!(
      markdownRequest({ opts: { title: "x".repeat(ARTIFACT_CAPS.maxTitleLength) } }),
    );
    expect(ok.title).toHaveLength(ARTIFACT_CAPS.maxTitleLength);
  });

  it("不认识的 opts 键静默忽略（编译期已拦住，运行期不再报第二次）", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const record = await driver.executeArtifactPublish!(
      markdownRequest({ opts: { title: "小结", 未知键: 1 } }),
    );
    expect(record.title).toBe("小结");
  });

  it("非法 id（字符集 / 超长）是接线错误，报 DriverError", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await rejection(
      driver.executeArtifactPublish!(markdownRequest({ id: "bad id/slash" })),
      "DriverError",
    );
    await rejection(
      driver.executeArtifactPublish!(
        markdownRequest({ id: "i".repeat(ARTIFACT_CAPS.maxIdLength + 1) }),
      ),
      "DriverError",
    );
  });

  it("payload 缺席或类型不对同样大声失败（引擎护栏之外的第二道）", async () => {
    const { store } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: undefined })),
      "DriverError",
    );
    await rejection(
      driver.executeArtifactPublish!(markdownRequest({ content: undefined })),
      "DriverError",
    );
  });
});

describe("workflow driver — 产物存储缺席", () => {
  it("装配没有 store 时，两个内容成员都以 ArtifactStoreUnavailable 拒绝", async () => {
    const driver = makeDriver({ cwd: workspace, parentSessionId: SESSION_ID });

    const file = await rejection(
      driver.executeArtifactPublish!(fileRequest()),
      "ArtifactStoreUnavailable",
    );
    expect(file.message).toContain("report");
    await rejection(driver.executeArtifactPublish!(markdownRequest()), "ArtifactStoreUnavailable");
  });

  it("store 不支持二进制写时：文件拒绝，markdown 照常发布", async () => {
    const { store, writes } = fakeArtifactStore({ binary: false });
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    await rejection(driver.executeArtifactPublish!(fileRequest()), "ArtifactStoreUnavailable");
    const record = await driver.executeArtifactPublish!(markdownRequest());
    expect(record.kind).toBe("markdown");
    expect(writes).toHaveLength(1);
  });

  it("store 在场但父会话 id 未接线时同样大声失败（不猜一个会话）", async () => {
    const { store, writes } = fakeArtifactStore();
    const driver = makeDriver({ cwd: workspace, artifactStore: store });

    await rejection(driver.executeArtifactPublish!(markdownRequest()), "ArtifactStoreUnavailable");
    expect(writes).toHaveLength(0);
  });

  it("store 缺席时不读文件（病因是没有落点，不该被一条 ArtifactSourceMissing 盖掉）", async () => {
    const port = new Proxy({} as FileSystemPort, {
      get(_target, name) {
        return () => {
          throw new Error(`fileSystemPort.${String(name)} 不应在 store 缺席时被触及`);
        };
      },
    });
    const driver = makeDriver({ cwd: workspace, fileSystemPort: port, parentSessionId: SESSION_ID });

    await rejection(
      driver.executeArtifactPublish!(fileRequest({ path: "out/nope.pdf" })),
      "ArtifactStoreUnavailable",
    );
  });

  it("store 写入自身失败归一成 DriverError，并带上原因文本", async () => {
    const { store } = fakeArtifactStore({ failWith: new Error("ENOSPC: no space left") });
    const driver = makeDriver({ cwd: workspace, artifactStore: store, parentSessionId: SESSION_ID });

    const error = await rejection(driver.executeArtifactPublish!(fileRequest()), "DriverError");
    expect(error.message).toContain("ENOSPC");
  });
});
