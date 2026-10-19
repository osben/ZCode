import { describe, expect, it, vi } from "vitest";
import {
  createFileSystemError,
  type FileSystemPort,
  type Logger,
} from "@zcode/contracts";
import {
  NESTED_INSTRUCTION_MAX_CONTEXT_BYTES,
  NESTED_INSTRUCTION_MAX_FILE_BYTES,
  discoverNestedInstructions,
  type NestedInstructionDiscoveryInput,
} from "../src/context/nested-instructions/discover.js";
import type { NestedInstructionHistory } from "../src/context/nested-instructions/history.js";
import {
  NESTED_INSTRUCTION_MISS_TTL_MS,
  NestedInstructionTracker,
} from "../src/context/nested-instructions/tracker.js";
import type { NestedInstructionLocation } from "../src/context/nested-instructions/touched-paths.js";

const ROOT = "/repo";
const NO_HISTORY: NestedInstructionHistory = { delivered: new Set(), bytesDelivered: 0 };

/** In-memory FileSystemPort covering only the operations discovery uses. */
class MemoryFileSystem {
  readonly statPaths: string[] = [];
  readonly readPaths: string[] = [];
  readonly failures = new Map<string, Error>();

  constructor(private readonly files: Record<string, string>) {}

  async stat(request: { path: string }) {
    this.statPaths.push(request.path);
    const failure = this.failures.get(request.path);
    if (failure) throw failure;
    const content = this.files[request.path];
    if (content !== undefined) {
      return {
        path: request.path,
        kind: "file" as const,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    }
    if (this.isDirectory(request.path)) {
      return { path: request.path, kind: "directory" as const, sizeBytes: 0 };
    }
    return { path: request.path, kind: "missing" as const, sizeBytes: 0 };
  }

  async readTextFile(request: { path: string; maxBytes?: number }) {
    this.readPaths.push(request.path);
    const failure = this.failures.get(request.path);
    if (failure) throw failure;
    const content = this.files[request.path];
    if (content === undefined) {
      throw createFileSystemError({ code: "not_found", path: request.path, message: "missing" });
    }
    const bytes = Buffer.from(content, "utf8");
    const max = request.maxBytes ?? bytes.length;
    const returned = bytes.subarray(0, max).toString("utf8");
    return {
      path: request.path,
      content: returned,
      encoding: "utf8" as const,
      bytesRead: Math.min(bytes.length, max),
      sizeBytes: bytes.length,
      truncated: bytes.length > max,
    };
  }

  private isDirectory(path: string): boolean {
    const prefix = `${path}/`;
    return Object.keys(this.files).some((file) => file.startsWith(prefix));
  }
}

function createLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger & { debug: ReturnType<typeof vi.fn> };
}

function fileLocation(path: string): NestedInstructionLocation {
  return { path, kind: "file" };
}

function input(
  fileSystem: MemoryFileSystem,
  overrides: Partial<NestedInstructionDiscoveryInput> = {},
): NestedInstructionDiscoveryInput {
  return {
    locations: [fileLocation(`${ROOT}/packages/foo/src/a.ts`)],
    touchedFiles: [`${ROOT}/packages/foo/src/a.ts`],
    workspaceRoot: ROOT,
    platform: "linux",
    priorityFiles: ["AGENTS.md"],
    rootSourcePaths: [],
    readHistory: () => NO_HISTORY,
    fileSystem: fileSystem as unknown as FileSystemPort,
    tracker: new NestedInstructionTracker(),
    now: 0,
    ...overrides,
  };
}

function markerPaths(body: string[] | undefined): string[] {
  return (body ?? [])
    .map((line) => /^\[nested-agents-md path=("(?:[^"\\]|\\.)*") bytes=\d+\]$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => JSON.parse(match[1]!) as string);
}

describe("discoverNestedInstructions: nested discovery", () => {
  it("delivers the AGENTS.md of the touched folder and never stats the workspace root", async () => {
    const fileSystem = new MemoryFileSystem({
      [`${ROOT}/AGENTS.md`]: "root rules",
      [`${ROOT}/packages/foo/AGENTS.md`]: "foo rules",
    });

    const result = await discoverNestedInstructions(input(fileSystem));

    expect(markerPaths(result)).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
    expect(result).toContain("foo rules");
    expect(result).not.toContain("root rules");
    expect(fileSystem.statPaths).not.toContain(`${ROOT}/AGENTS.md`);
    expect(fileSystem.readPaths).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
  });

  it("walks every ancestor below the root and emits the files root-to-leaf", async () => {
    const fileSystem = new MemoryFileSystem({
      [`${ROOT}/a/AGENTS.md`]: "a rules",
      [`${ROOT}/a/b/AGENTS.md`]: "b rules",
      [`${ROOT}/a/b/c/x.ts`]: "code",
    });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/a/b/c/x.ts`)],
        touchedFiles: [`${ROOT}/a/b/c/x.ts`],
      }),
    );

    expect(markerPaths(result)).toEqual([
      `${ROOT}/a/AGENTS.md`,
      `${ROOT}/a/b/AGENTS.md`,
    ]);
  });

  it("uses the first existing priority file per folder, in priority order", async () => {
    const both = new MemoryFileSystem({
      [`${ROOT}/packages/foo/AGENTS.md`]: "agents",
      [`${ROOT}/packages/foo/CLAUDE.md`]: "claude",
    });
    const onlyClaude = new MemoryFileSystem({ [`${ROOT}/packages/foo/CLAUDE.md`]: "claude" });
    const priorityFiles = ["AGENTS.md", "CLAUDE.md"];

    expect(
      markerPaths((await discoverNestedInstructions(input(both, { priorityFiles })))),
    ).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
    expect(
      markerPaths((await discoverNestedInstructions(input(onlyClaude, { priorityFiles })))),
    ).toEqual([`${ROOT}/packages/foo/CLAUDE.md`]);
  });

  it("lists every marker line before any instruction body", async () => {
    const fileSystem = new MemoryFileSystem({
      [`${ROOT}/a/AGENTS.md`]: "a rules",
      [`${ROOT}/a/b/AGENTS.md`]: "b rules",
    });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/a/b/c/x.ts`)],
        touchedFiles: [`${ROOT}/a/b/c/x.ts`],
      }),
    );

    const markerLines = (result ?? []).filter((line) => line.startsWith("[nested-agents-md "));
    expect(markerLines).toHaveLength(2);
    expect(result?.slice(0, markerLines.length)).toEqual(markerLines);
  });

  it("delivers nothing when no folder between the touched file and the root has instructions", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/src/other.ts`]: "x" });

    const result = await discoverNestedInstructions(input(fileSystem));

    expect(result).toBeUndefined();
  });
});

describe("discoverNestedInstructions: scope and root exclusion", () => {
  it("ignores touched paths outside the workspace without any stat", async () => {
    const fileSystem = new MemoryFileSystem({ "/elsewhere/AGENTS.md": "outside" });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation("/elsewhere/x/y.ts")],
        touchedFiles: ["/elsewhere/x/y.ts"],
      }),
    );

    expect(result).toBeUndefined();
    expect(fileSystem.statPaths).toEqual([]);
  });

  it("ignores an out-of-workspace or root-level priority file reached by traversal, without stat", async () => {
    const fileSystem = new MemoryFileSystem({
      "/outside/AGENTS.md": "outside",
      [`${ROOT}/AGENTS.md`]: "root",
    });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/packages/foo/x.ts`)],
        touchedFiles: [`${ROOT}/packages/foo/x.ts`],
        priorityFiles: ["../../AGENTS.md", "../../../../outside/AGENTS.md"],
      }),
    );

    expect(result).toBeUndefined();
    expect(fileSystem.statPaths).not.toContain(`${ROOT}/AGENTS.md`);
    expect(fileSystem.statPaths).not.toContain("/outside/AGENTS.md");
  });

  it("does not stat an explicit Glob/Grep path outside the workspace", async () => {
    const fileSystem = new MemoryFileSystem({ "/elsewhere/AGENTS.md": "outside" });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [{ path: "/elsewhere", kind: "unknown" }],
        touchedFiles: [],
      }),
    );

    expect(result).toBeUndefined();
    expect(fileSystem.statPaths).toEqual([]);
  });

  it("never re-injects a file the startup loader already loaded", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "startup" });

    const result = await discoverNestedInstructions(
      input(fileSystem, { rootSourcePaths: [`${ROOT}/packages/foo/AGENTS.md`] }),
    );

    expect(result).toBeUndefined();
    expect(fileSystem.readPaths).toEqual([]);
  });

  it("does not inject a candidate that the touching call itself returned (Read of AGENTS.md)", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/packages/foo/AGENTS.md`)],
        touchedFiles: [`${ROOT}/packages/foo/AGENTS.md`],
      }),
    );

    expect(result).toBeUndefined();
    expect(fileSystem.readPaths).toEqual([]);
  });

  it("skips a candidate already delivered according to history", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const history: NestedInstructionHistory = {
      delivered: new Set([`${ROOT}/packages/foo/AGENTS.md`]),
      bytesDelivered: 3,
    };

    const result = await discoverNestedInstructions(input(fileSystem, { readHistory: () => history }));

    expect(result).toBeUndefined();
    expect(fileSystem.readPaths).toEqual([]);
  });

  it("delivers again once history no longer shows the file (after compaction or microcompaction)", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const tracker = new NestedInstructionTracker();
    const visible: NestedInstructionHistory = {
      delivered: new Set([`${ROOT}/packages/foo/AGENTS.md`]),
      bytesDelivered: 3,
    };
    let current = visible;
    const base = input(fileSystem, { tracker, readHistory: () => current });

    expect((await discoverNestedInstructions(base))).toBeUndefined();

    current = NO_HISTORY;
    const after = await discoverNestedInstructions(base);
    expect(markerPaths(after)).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
  });

  it("never reads history when no nested instruction file exists in the touched folders", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/src/a.ts`]: "code" });
    const readHistory = vi.fn(() => NO_HISTORY);

    const result = await discoverNestedInstructions(input(fileSystem, { readHistory }));

    expect(result).toBeUndefined();
    expect(readHistory).not.toHaveBeenCalled();
  });

  it("never reads history when the touched folder is the workspace root", async () => {
    const fileSystem = new MemoryFileSystem({});
    const readHistory = vi.fn(() => NO_HISTORY);

    await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/x.ts`)],
        touchedFiles: [`${ROOT}/x.ts`],
        readHistory,
      }),
    );

    expect(readHistory).not.toHaveBeenCalled();
  });
});

describe("discoverNestedInstructions: targets from search and shell tools", () => {
  it("resolves a Grep path that names a file to its folder", async () => {
    const fileSystem = new MemoryFileSystem({
      [`${ROOT}/packages/foo/AGENTS.md`]: "foo",
      [`${ROOT}/packages/foo/src/a.ts`]: "code",
    });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [{ path: `${ROOT}/packages/foo/src/a.ts`, kind: "unknown" }],
        touchedFiles: [],
      }),
    );

    expect(markerPaths(result)).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
  });

  it("delivers nothing for a missing Glob/Grep path", async () => {
    const fileSystem = new MemoryFileSystem({});

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [{ path: `${ROOT}/nope`, kind: "unknown" }],
        touchedFiles: [],
      }),
    );

    expect(result).toBeUndefined();
  });

  it("treats a directory location as the folder itself", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [{ path: `${ROOT}/packages/foo`, kind: "directory" }],
        touchedFiles: [],
      }),
    );

    expect(markerPaths(result)).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
  });
});

describe("discoverNestedInstructions: budget and truncation", () => {
  it("truncates one file at the per-file limit and marks it", async () => {
    const big = "x".repeat(NESTED_INSTRUCTION_MAX_FILE_BYTES + 4_000);
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: big });

    const result = await discoverNestedInstructions(input(fileSystem));

    expect(result).toContain(
      `[nested-agents-md path=${JSON.stringify(`${ROOT}/packages/foo/AGENTS.md`)} bytes=${NESTED_INSTRUCTION_MAX_FILE_BYTES}]`,
    );
    expect(result).toContain(
      `[truncated: showing first ${NESTED_INSTRUCTION_MAX_FILE_BYTES} of ${big.length} bytes]`,
    );
  });

  it("refuses a file that cannot fit the remaining context budget without reading it", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "x".repeat(10_000) });
    const history: NestedInstructionHistory = {
      delivered: new Set(),
      bytesDelivered: NESTED_INSTRUCTION_MAX_CONTEXT_BYTES - 5_000,
    };

    const result = await discoverNestedInstructions(input(fileSystem, { readHistory: () => history }));

    expect(result).toBeUndefined();
    expect(fileSystem.readPaths).toEqual([]);
  });

  it("keeps the deeper folder and drops the broader one when budget allows only one", async () => {
    const fileSystem = new MemoryFileSystem({
      [`${ROOT}/a/AGENTS.md`]: "x".repeat(10_000),
      [`${ROOT}/a/b/AGENTS.md`]: "y".repeat(10_000),
    });
    const history: NestedInstructionHistory = {
      delivered: new Set(),
      bytesDelivered: NESTED_INSTRUCTION_MAX_CONTEXT_BYTES - 12_000,
    };

    const result = await discoverNestedInstructions(
      input(fileSystem, {
        locations: [fileLocation(`${ROOT}/a/b/x.ts`)],
        touchedFiles: [`${ROOT}/a/b/x.ts`],
        readHistory: () => history,
      }),
    );

    expect(markerPaths(result)).toEqual([`${ROOT}/a/b/AGENTS.md`]);
    expect(fileSystem.readPaths).toEqual([`${ROOT}/a/b/AGENTS.md`]);
  });
});

describe("discoverNestedInstructions: concurrency and caching", () => {
  it("delivers a file once when two calls in the same schedule race for it", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const tracker = new NestedInstructionTracker();
    const base = input(fileSystem, { tracker });

    const [first, second] = await Promise.all([
      discoverNestedInstructions({ ...base, touchedFiles: [] }),
      discoverNestedInstructions({ ...base, touchedFiles: [] }),
    ]);

    const deliveries = [first, second].filter((result) => result !== undefined);
    expect(deliveries).toHaveLength(1);
  });

  it("keeps a reservation until the step's results are committed, across a later streamed call", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const tracker = new NestedInstructionTracker();
    const base = input(fileSystem, { tracker });

    // First streamed call selects the file; its result is not in history yet.
    expect(markerPaths((await discoverNestedInstructions(base)))).toEqual([`${ROOT}/packages/foo/AGENTS.md`]);
    // A later call in the same step still sees no history entry, but must not deliver the file again.
    expect((await discoverNestedInstructions(base))).toBeUndefined();

    // Settlement commits the result to history, then clears reservations. Only then is history the source of truth.
    tracker.clearReservations();
    expect(markerPaths((await discoverNestedInstructions({ ...base, readHistory: () => NO_HISTORY })))).toEqual([
      `${ROOT}/packages/foo/AGENTS.md`,
    ]);
  });

  it("does not reserve a candidate that was skipped, so a later call can deliver it", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const tracker = new NestedInstructionTracker();
    fileSystem.failures.set(`${ROOT}/packages/foo/AGENTS.md`, new Error("transient"));
    const base = input(fileSystem, { tracker });

    expect((await discoverNestedInstructions(base))).toBeUndefined();

    fileSystem.failures.clear();
    expect(markerPaths((await discoverNestedInstructions(base)))).toEqual([
      `${ROOT}/packages/foo/AGENTS.md`,
    ]);
  });

  it("caches a missing candidate for the miss TTL and then re-stats it", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/x/y.ts`]: "code" });
    const tracker = new NestedInstructionTracker();
    const base = input(fileSystem, {
      tracker,
      locations: [fileLocation(`${ROOT}/x/y.ts`)],
      touchedFiles: [`${ROOT}/x/y.ts`],
    });
    const missPath = `${ROOT}/x/AGENTS.md`;

    await discoverNestedInstructions({ ...base, now: 0 });
    await discoverNestedInstructions({ ...base, now: NESTED_INSTRUCTION_MISS_TTL_MS - 1 });
    expect(fileSystem.statPaths.filter((path) => path === missPath)).toHaveLength(1);

    await discoverNestedInstructions({ ...base, now: NESTED_INSTRUCTION_MISS_TTL_MS });
    expect(fileSystem.statPaths.filter((path) => path === missPath)).toHaveLength(2);
  });

  it("picks up an AGENTS.md created after a miss once the TTL expires", async () => {
    const files: Record<string, string> = { [`${ROOT}/x/y.ts`]: "code" };
    const fileSystem = new MemoryFileSystem(files);
    const tracker = new NestedInstructionTracker();
    const base = input(fileSystem, {
      tracker,
      locations: [fileLocation(`${ROOT}/x/y.ts`)],
      touchedFiles: [`${ROOT}/x/y.ts`],
    });

    expect((await discoverNestedInstructions({ ...base, now: 0 }))).toBeUndefined();
    files[`${ROOT}/x/AGENTS.md`] = "created later";
    expect(
      markerPaths((await discoverNestedInstructions({ ...base, now: NESTED_INSTRUCTION_MISS_TTL_MS }))),
    ).toEqual([`${ROOT}/x/AGENTS.md`]);
  });
});

describe("discoverNestedInstructions: failure handling", () => {
  it("skips a candidate whose stat fails unexpectedly, logs at debug, and never throws", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    fileSystem.failures.set(
      `${ROOT}/packages/foo/AGENTS.md`,
      createFileSystemError({ code: "io_error", message: "disk", path: `${ROOT}/packages/foo/AGENTS.md` }),
    );
    const logger = createLogger();

    const result = await discoverNestedInstructions(input(fileSystem, { logger }));

    expect(result).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      "Nested instruction stat failed",
      expect.objectContaining({ event: "instructions.nested.skipped" }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs discovery at debug with counts and no file content", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "secret body" });
    const logger = createLogger();

    await discoverNestedInstructions(input(fileSystem, { logger }));

    expect(logger.debug).toHaveBeenCalledWith(
      "Nested instructions discovered",
      expect.objectContaining({ event: "instructions.nested.discovered", deliveredCount: 1 }),
    );
    const serialized = JSON.stringify(logger.debug.mock.calls);
    expect(serialized).not.toContain("secret body");
  });

  it("returns nothing for an already aborted signal", async () => {
    const fileSystem = new MemoryFileSystem({ [`${ROOT}/packages/foo/AGENTS.md`]: "foo" });
    const controller = new AbortController();
    controller.abort();

    const result = await discoverNestedInstructions(input(fileSystem, { signal: controller.signal }));

    expect(result).toBeUndefined();
    expect(fileSystem.statPaths).toEqual([]);
  });
});
