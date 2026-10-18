import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FileMutatedEvent } from "@zcode/contracts";
import { createLspService, LspService } from "../src/lsp/index.js";
import { LSP_EDIT_DIAGNOSTICS_WAIT_MS } from "../src/lsp/constants.js";
import {
  FakeConnection,
  FakeLanguageServerPort,
  LSP_KEY,
  MemoryFileSystem,
  WORKSPACE,
  fileUri,
  flushMicrotasks,
  makePreferences,
  makeServer,
  rawDiagnostic,
  type RecordedMessage,
} from "./lsp-fakes.js";
import type { LspPreferences, ResolvedLspServer } from "@zcode/contracts";

const FILE = `${WORKSPACE}/src/a.ts`;
const FILE_URI = fileUri(FILE);
const DOC = "const user = 1;\nuser;\nlet other = 2;\n";

interface Harness {
  port: FakeLanguageServerPort;
  fs: MemoryFileSystem;
  server: ResolvedLspServer;
  service: LspService;
  prefs: { current: LspPreferences };
}

function setup(
  input: { server?: Partial<ResolvedLspServer>; prefs?: Partial<LspPreferences> } = {},
): Harness {
  const port = new FakeLanguageServerPort();
  const fs = new MemoryFileSystem();
  fs.set(FILE, DOC);
  const server = makeServer(input.server);
  const prefs = { current: makePreferences(input.prefs) };
  const service = createLspService({
    port,
    servers: [server],
    key: LSP_KEY,
    fileSystem: fs.asPort(),
    getPreferences: () => prefs.current,
  });
  return { port, fs, server, service, prefs };
}

function mutation(
  partial: Partial<FileMutatedEvent> & Pick<FileMutatedEvent, "kind">,
): FileMutatedEvent {
  return { path: FILE, ...partial } as FileMutatedEvent;
}

/** Lets queued promise continuations run so that the fake-timer waits are registered before time advances. */
async function settleAsync(): Promise<void> {
  await flushMicrotasks(50);
  await vi.advanceTimersByTimeAsync(0);
}

function methodNames(messages: RecordedMessage[]): string[] {
  return messages.map((message) => message.method);
}

let harness: Harness;

beforeEach(() => {
  harness = setup();
});

afterEach(() => {
  harness.service.dispose();
  vi.useRealTimers();
});

describe("post-edit diagnostics (spec §6)", () => {
  it("attaches only the new issues, ignoring a pre-existing one that shifted", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.onNotify = (message) => {
      if (message.method === "textDocument/didOpen") {
        connection.publish(FILE_URI, [rawDiagnostic({ line: 0, message: "old error" })], 1);
      }
      if (message.method === "textDocument/didChange") {
        const version = (message.params as { textDocument: { version: number } }).textDocument
          .version;
        connection.publish(
          FILE_URI,
          [
            rawDiagnostic({ line: 1, message: "old error" }),
            rawDiagnostic({ line: 3, message: "new error", code: 2322, source: "ts" }),
          ],
          version,
        );
      }
    };
    await harness.service.diagnostics(FILE);

    harness.fs.set(FILE, "\nconst user = 1;\nuser;\nlet fresh: number = 'x';\n");
    harness.service.onFileMutated(
      mutation({
        kind: "changed",
        content: "\nconst user = 1;\nuser;\nlet fresh: number = 'x';\n",
        changedRange: { startLine: 4, endLine: 4 },
      }),
    );
    const result = await harness.service.collectEditDiagnostics();

    expect(result.attachmentBody).toBe(
      "Found 1 new diagnostic issues in 1 files\nsrc/a.ts:4:1 error new error [ts 2322]",
    );
  });

  it("uses the changed range when the file had no baseline", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.onNotify = (message) => {
      if (message.method === "textDocument/didOpen") {
        connection.publish(
          FILE_URI,
          [
            rawDiagnostic({ line: 1, message: "inside range" }),
            rawDiagnostic({ line: 6, message: "outside range" }),
          ],
          1,
        );
      }
    };
    harness.service.onFileMutated(
      mutation({ kind: "created", content: DOC, changedRange: { startLine: 2, endLine: 2 } }),
    );
    const result = await harness.service.collectEditDiagnostics();
    expect(result.attachmentBody).toBe(
      "Found 1 new diagnostic issues in 1 files\nsrc/a.ts:2:1 error inside range",
    );
  });

  it("keeps a file pending after two quick changes and a versionless publish (ambiguous)", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    harness.service.onFileMutated(
      mutation({
        kind: "changed",
        content: DOC + "\n",
        changedRange: { startLine: 4, endLine: 4 },
      }),
    );
    await flushMicrotasks();
    // Watched-file notice goes out before the document sync for each mutation.
    expect(methodNames(connection.notifications)).toEqual([
      "workspace/didChangeWatchedFiles",
      "textDocument/didOpen",
      "workspace/didChangeWatchedFiles",
      "textDocument/didChange",
    ]);

    connection.publish(FILE_URI, [rawDiagnostic({ line: 0, message: "maybe stale" })]);
    const pending = await harness.service.collectEditDiagnostics({ waitMs: 0 });
    expect(pending.attachmentBody).toBe("Diagnostics pending for 1 files");
  });

  it("drops a versioned publish older than the current version", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC + "x", changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    connection.publish(FILE_URI, [rawDiagnostic({ line: 0, message: "stale" })], 1);
    const result = await harness.service.collectEditDiagnostics({ waitMs: 0 });
    expect(result.attachmentBody).toBe("Diagnostics pending for 1 files");
  });

  it("returns nothing and does not wait when no file was mutated", async () => {
    const result = await harness.service.collectEditDiagnostics({ waitMs: 2_000 });
    expect(result).toEqual({});
  });
});

describe("failed servers and post-edit diagnostics", () => {
  it("does not report pending for an edit whose server failed to start", async () => {
    harness.port.state = "failed";
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    expect(await harness.service.collectEditDiagnostics({ waitMs: 0 })).toEqual({});
  });
});

describe("FileMutated synchronization", () => {
  it("sends watched-file changes and closes deleted documents", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.responses.set("textDocument/documentSymbol", () => []);
    await harness.service.query("documentSymbol", { operation: "documentSymbol", filePath: FILE });
    harness.service.onFileMutated(mutation({ kind: "changed", content: DOC + "more\n" }));
    await flushMicrotasks();
    harness.service.onFileMutated(mutation({ kind: "deleted" }));
    await flushMicrotasks();

    expect(connection.methods("workspace/didChangeWatchedFiles")).toEqual([
      {
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: FILE_URI, type: 2 }] },
      },
      {
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: FILE_URI, type: 3 }] },
      },
    ]);
    expect(connection.methods("textDocument/didClose")).toEqual([
      { method: "textDocument/didClose", params: { textDocument: { uri: FILE_URI } } },
    ]);
  });

  it("keeps at most 50 documents open per server and closes the least recently used", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.responses.set("textDocument/documentSymbol", () => []);
    for (let index = 0; index < 51; index += 1) {
      harness.fs.set(`${WORKSPACE}/src/f${index}.ts`, "x\n");
      await harness.service.query("documentSymbol", {
        operation: "documentSymbol",
        filePath: `${WORKSPACE}/src/f${index}.ts`,
      });
    }
    const closed = connection
      .methods("textDocument/didClose")
      .map((message) => (message.params as { textDocument: { uri: string } }).textDocument.uri);
    expect(closed).toEqual([fileUri(`${WORKSPACE}/src/f0.ts`)]);
  });

  it("re-opens a document from disk on the connection created after a restart", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    harness.port.connection.responses.set("textDocument/documentSymbol", () => []);
    await harness.service.query("documentSymbol", { operation: "documentSymbol", filePath: FILE });
    const restarted = harness.port.restart(harness.server);
    restarted.responses.set("textDocument/documentSymbol", () => []);
    await harness.service.query("documentSymbol", { operation: "documentSymbol", filePath: FILE });
    expect(methodNames(restarted.notifications)).toContain("textDocument/didOpen");
  });

  // Regression: the process-wide pool emits ready for every workspace; replaying onto another workspace's
  // server opened this session's file in the wrong root and marked it fresh from that server.
  it("does not replay a pending edit onto a server that is ready for another workspace", async () => {
    harness.port.state = "starting";
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    const foreign = new FakeConnection(harness.server, {
      identityKey: "ws-2",
      workspacePath: "/work/other",
    });
    harness.port.emit({
      type: "ready",
      serverId: harness.server.id,
      key: foreign.key,
      connection: foreign,
    });
    await flushMicrotasks();

    expect(methodNames(foreign.notifications)).not.toContain("textDocument/didOpen");
    const result = await harness.service.collectEditDiagnostics({ waitMs: 0 });
    expect(result.attachmentBody).toBe("Diagnostics pending for 1 files");
  });

  it("replays an edit made while the server was starting once it is ready", async () => {
    harness.port.state = "starting";
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    const connection = harness.port.restart(harness.server);
    connection.onNotify = (message) => {
      if (message.method === "textDocument/didOpen") {
        connection.publish(FILE_URI, [rawDiagnostic({ line: 0, message: "late" })], 1);
      }
    };
    await flushMicrotasks();
    const result = await harness.service.collectEditDiagnostics({ waitMs: 0 });
    expect(methodNames(connection.notifications)).toContain("textDocument/didOpen");
    expect(result.attachmentBody).toBe(
      "Found 1 new diagnostic issues in 1 files\nsrc/a.ts:1:1 error late",
    );
  });
});

describe("preferences (spec §3)", () => {
  it("does nothing when code intelligence is globally disabled", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    harness.prefs.current = makePreferences({ enabled: false });
    harness.service.onFileMutated(mutation({ kind: "changed", content: DOC }));
    await flushMicrotasks();
    expect(harness.port.connection.notifications).toEqual([]);
    expect(await harness.service.collectEditDiagnostics()).toEqual({});
    expect(await harness.service.isAvailable()).toBe(false);
    await harness.service.shutdownIfDisabled();
    expect(harness.port.stopAllCalls).toBe(1);
  });

  it("lets the per-server preference override the manifest default in both directions", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    harness.prefs.current = makePreferences({
      diagnosticsAfterEdit: { [harness.server.id]: false },
    });
    harness.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    expect(await harness.service.collectEditDiagnostics({ waitMs: 0 })).toEqual({});

    // Manifest says off, preference says on: the edit is tracked and reported as pending (no publish arrives).
    const other = setup({
      server: { diagnosticsAfterEdit: false },
      prefs: { diagnosticsAfterEdit: { "demo/ts": true } },
    });
    other.port.acquire(other.server, LSP_KEY);
    other.service.onFileMutated(
      mutation({ kind: "changed", content: DOC, changedRange: { startLine: 1, endLine: 1 } }),
    );
    await flushMicrotasks();
    expect((await other.service.collectEditDiagnostics({ waitMs: 0 })).attachmentBody).toBe(
      "Diagnostics pending for 1 files",
    );
    other.service.dispose();
  });

  it("reports availability only when a configured binary is installed", async () => {
    expect(await harness.service.isAvailable()).toBe(true);
    harness.port.installed = false;
    expect(await harness.service.isAvailable()).toBe(false);
  });
});

describe("waiting for fresh diagnostics (spec §6, fake timers)", () => {
  it("resolves early when the fresh result arrives before the bound", async () => {
    vi.useFakeTimers();
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    harness.service.onFileMutated(
      mutation({ kind: "created", content: DOC, changedRange: { startLine: 1, endLine: 3 } }),
    );
    await settleAsync();

    let resolved: string | undefined | "pending" = "pending";
    const waiting = harness.service.collectEditDiagnostics().then((result) => {
      resolved = result.attachmentBody;
    });
    await vi.advanceTimersByTimeAsync(LSP_EDIT_DIAGNOSTICS_WAIT_MS - 500);
    expect(resolved).toBe("pending");

    connection.publish(FILE_URI, [rawDiagnostic({ line: 0, message: "late but in time" })], 1);
    await vi.advanceTimersByTimeAsync(0);
    await waiting;
    expect(resolved).toBe(
      "Found 1 new diagnostic issues in 1 files\nsrc/a.ts:1:1 error late but in time",
    );
  });

  it("expires at the bound with a pending notice when nothing becomes fresh", async () => {
    vi.useFakeTimers();
    harness.port.acquire(harness.server, LSP_KEY);
    harness.service.onFileMutated(
      mutation({ kind: "created", content: DOC, changedRange: { startLine: 1, endLine: 3 } }),
    );
    await settleAsync();

    const waiting = harness.service.collectEditDiagnostics();
    await vi.advanceTimersByTimeAsync(LSP_EDIT_DIAGNOSTICS_WAIT_MS);
    expect((await waiting).attachmentBody).toBe("Diagnostics pending for 1 files");
  });

  it("stops waiting when the request signal aborts", async () => {
    vi.useFakeTimers();
    harness.port.acquire(harness.server, LSP_KEY);
    harness.service.onFileMutated(
      mutation({ kind: "created", content: DOC, changedRange: { startLine: 1, endLine: 3 } }),
    );
    await settleAsync();
    const controller = new AbortController();
    const waiting = harness.service.collectEditDiagnostics({ signal: controller.signal });
    controller.abort();
    expect((await waiting).attachmentBody).toBe("Diagnostics pending for 1 files");
  });

  it("returns pending for the diagnostics operation after the query wait, never ok without a fresh result", async () => {
    vi.useFakeTimers();
    harness.port.acquire(harness.server, LSP_KEY);
    const waiting = harness.service.diagnostics(FILE);
    await settleAsync();
    await vi.advanceTimersByTimeAsync(LSP_EDIT_DIAGNOSTICS_WAIT_MS);
    const output = await waiting;
    expect(output.status).toBe("pending");
    expect(output.diagnostics).toEqual([]);
  });
});
