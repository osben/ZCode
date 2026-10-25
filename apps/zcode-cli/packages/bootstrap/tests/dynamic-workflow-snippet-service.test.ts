/**
 * dwf snippet service (the execution surface of EvalWorkflowSnippet). See docs/dynamic-workflow/authoring.md.
 *
 * These cases run in a **real sandbox** (runWorkflowScript spawns a node child process, following
 * the e2e precedent in the runtime package), but world reads land on an in-memory fs stub — the
 * thing under test is the orchestration at the service layer: scratch facade compilation,
 * diagnostics paths, settlement mapping, logs capture, timeouts, and artifact caps. Integration
 * with the real filesystem is covered by workflow-driver-world-read-args.test.ts and runtime e2e.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionPort, FileSystemPort, TraceContext } from "@zcode/contracts";
import { NodeExecutionAdapter } from "@zcode/adapters/exec";
import { WORLD_RUN_LITERAL_CODE } from "@zcode/dynamic-workflow";
import { createDynamicWorkflowSnippetService } from "../src/app/dynamic-workflow-snippet-service.js";
/**
 * Dedicated run cwd: the harness writes the entry file to `<cwd>/.zcode/workflow-runs/<runId>.mjs`
 * and keeps it. Using process.cwd() would leave archives in the package directory and let parallel
 * test files overwrite each other's entry files of the same name.
 */
const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-bootstrap-test-cwd-"));

/** Minimal in-memory fs port (shaped after the stub in workflow-driver-world-read-args.test.ts). */
function stubFileSystemPort(glob: string[], read: string, globHangs: boolean): FileSystemPort {
  const unsupported = (name: string) => () => {
    throw new Error(`stubFileSystemPort.${name} 不应被触及`);
  };
  return {
    async searchFiles(request: { path: string; pattern: string }) {
      // A world read that never answers: the only legitimate way to keep the snippet "alive with
      // nothing to do" is one in-flight host request (same as the HANG case in the runtime
      // package's tests/failures.test.ts); a bare never-resolving promise is judged stalled on the spot by the cell.
      if (globHangs) await new Promise<never>(() => {});
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files: glob,
        numFiles: glob.length,
        truncated: false,
      };
    },
    async readTextFile(request: { path: string }) {
      return {
        path: request.path,
        content: read,
        encoding: "utf-8",
        bytesRead: read.length,
        sizeBytes: read.length,
        truncated: false,
      };
    },
    createDirectory: unsupported("createDirectory"),
    stat: unsupported("stat"),
    readBinaryFile: unsupported("readBinaryFile"),
    readTextFileRange: unsupported("readTextFileRange"),
    writeTextFile: unsupported("writeTextFile"),
    removeFile: unsupported("removeFile"),
    listDirectory: unsupported("listDirectory"),
    searchText: unsupported("searchText"),
  } as unknown as FileSystemPort;
}

function unsupportedExecutionPort(): ExecutionPort {
  return {
    run: () => {
      throw new Error("本用例不应触及 ExecutionPort（git.* world-read）");
    },
  };
}

const trace: TraceContext = {
  traceId: "trace-snippet-test",
  spanId: "span-1",
  sessionId: "sess_test",
} as TraceContext;

function makeService(options?: { glob?: string[]; read?: string; globHangs?: boolean }) {
  return createDynamicWorkflowSnippetService({
    fileSystemPort: stubFileSystemPort(
      options?.glob ?? [],
      options?.read ?? "",
      options?.globHangs ?? false,
    ),
    executionPort: unsupportedExecutionPort(),
    availableParallelism: () => 4,
  });
}

function request(code: string, timeoutMs = 30_000) {
  return { code, cwd: TEST_CWD, timeoutMs, trace };
}

describe("dynamic workflow snippet service", () => {
  it("returns diagnostics for agent() without executing anything", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`return await agent("a").ask("x");`));
    expect(result.kind).toBe("diagnostics");
    if (result.kind !== "diagnostics") return;
    expect(result.diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("runs a world-read + pure-logic snippet and returns the artifact", async () => {
    const service = makeService({ glob: ["b.ts", "a.ts", "a.test.ts"] });
    const result = await service.evalSnippet(
      request(
        `const paths = await files.glob("**/*.ts");\n` +
          `log(\`saw \${paths.length}\`);\n` +
          `return paths.filter((p) => p.endsWith(".test.ts"));`,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // facade normalization: workspace-relative + lexicographic order (the nail in the glob-incident
    // coffin lives on the driver side; here we assert the end-to-end shape).
    expect(result.artifact).toEqual(["a.test.ts"]);
    expect(result.logs).toEqual(["saw 3"]);
    expect(result.logsTruncated).toBe(false);
  });

  it("returns completed without artifact when the snippet has no return", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`log("side quest only");`));
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect("artifact" in result).toBe(false);
    expect(result.logs).toEqual(["side quest only"]);
  });

  it("maps a script throw to a structured failure with the sandbox message", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`throw new Error("boom from snippet");`));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("DriverError");
    expect(result.error.message).toContain("boom from snippet");
  });

  it("kills the sandbox on wall-clock timeout and fails structurally", async () => {
    // Hang on a world read that never answers: the request stays in flight, the cell will not judge
    // it stalled, and only the wall clock can end it.
    const service = makeService({ globHangs: true });
    const result = await service.evalSnippet(request(`await files.glob("**");`, 1_000));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    // A wall-clock timeout is a host-side failure: the engine settles stopped(interrupted)
    // (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md decision 12); the snippet has
    // no resume semantics, so for the caller it is still a structured failure with code Interrupted.
    expect(result.error.code).toBe("Interrupted");
    expect(result.error.message).toContain("1000ms");
  }, 20_000);

  it("fails a stalled snippet at once instead of waiting for the wall clock", async () => {
    // A never-resolving promise with no in-flight request is a stall (execution-engine.md "The vm cell"
    // stall detection): the cell ends the run with ScriptStalled and the snippet immediately gets a
    // structured failure instead of hanging until the 30s timeout.
    const service = makeService();
    const result = await service.evalSnippet(request(`await new Promise(() => {});`, 30_000));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("DriverError");
    expect(result.error.message).toContain("Stalled");
  }, 10_000);

  it("rejects an oversized return value with ArtifactTooLarge", async () => {
    const service = makeService();
    const result = await service.evalSnippet(
      // A 300KB string artifact: exceeds the 256KB serialization cap.
      request(`return "x".repeat(300 * 1024);`),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("ArtifactTooLarge");
    expect(result.error.message).toContain("262144");
  });

  it("caps captured logs and marks truncation", async () => {
    const service = makeService();
    const result = await service.evalSnippet(
      request(`for (let i = 0; i < 120; i++) log("line " + i);`),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.logs.length).toBe(100);
    expect(result.logsTruncated).toBe(true);
  });

  it("surfaces world-read cap rejections as catchable inside the snippet", async () => {
    // 2001 files exceed the 2000 cap of files.glob: the service does not truncate, the script catches the structured rejection.
    const service = makeService({ glob: Array.from({ length: 2001 }, (_, i) => `f${i}.ts`) });
    const result = await service.evalSnippet(
      request(
        `try {\n  await files.glob("**");\n  return "no-cap";\n} catch (error) {\n` +
          `  return (error as { code?: string }).code ?? "caught";\n}`,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.artifact).toBe("WorldReadCapExceeded");
  });
});

describe("dynamic workflow snippet service — world.run", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "dwf-snippet-world-run-"));
  afterAll(() => rmSync(outputRoot, { force: true, recursive: true }));

  function makeWorldRunService() {
    return createDynamicWorkflowSnippetService({
      fileSystemPort: stubFileSystemPort([], ""),
      // Real execution port: the e2e point of world.run is precisely "the same driver facing a real command".
      executionPort: new NodeExecutionAdapter({
        outputRootDir: outputRoot,
        processEnv: process.env as Record<string, string>,
      }) as unknown as ExecutionPort,
      availableParallelism: () => 4,
    });
  }

  it("runs a real command and hands the nonzero exit code back to script logic", async () => {
    const service = makeWorldRunService();
    const result = await service.evalSnippet(
      request(
        `const r = await world.run("node", ["-e", "console.log('hi'); process.exit(3)"]);\n` +
          `return { code: r.exitCode, out: r.stdout.trim() };`,
        30_000,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // A nonzero exit is a value: gating logic branches inside the script, not via exception control flow.
    expect(result.artifact).toEqual({ code: 3, out: "hi" });
  }, 30_000);

  it("rejects a non-literal cmd with the positioned world.run diagnostic", async () => {
    const service = makeWorldRunService();
    const result = await service.evalSnippet(
      request(`const cmd = "node";\nawait world.run(cmd, []);`),
    );
    expect(result.kind).toBe("diagnostics");
    if (result.kind !== "diagnostics") return;
    expect(result.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(result.diagnostics[0]?.line).toBe(2);
  });
});
