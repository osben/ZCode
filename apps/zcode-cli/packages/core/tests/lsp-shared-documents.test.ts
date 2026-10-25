import { describe, expect, it } from "vitest";
import { createLspDocumentSync, createLspService } from "../src/lsp/index.js";
import {
  FakeLanguageServerPort,
  LSP_KEY,
  MemoryFileSystem,
  WORKSPACE,
  fileUri,
  makePreferences,
  makeServer,
  rawDiagnostic,
} from "./lsp-fakes.js";

const FILE = `${WORKSPACE}/src/shared.ts`;
const FILE_URI = fileUri(FILE);
const DOC = "export const a = 1;\n";

function versionOf(params: unknown): number {
  return (params as { textDocument: { version: number } }).textDocument.version;
}

// Spec 19-lsp.md §4: sessions of one workspace share the process-wide document owner, so they
// never open the same URI twice, never fork version counters and never close each other's documents.
describe("process-wide LSP document owner", () => {
  function setup() {
    const port = new FakeLanguageServerPort();
    const fs = new MemoryFileSystem();
    fs.set(FILE, DOC);
    const server = makeServer();
    const documents = createLspDocumentSync({ fileSystem: fs.asPort() });
    const prefs = makePreferences();
    const create = () =>
      createLspService({
        port,
        documents,
        servers: [server],
        key: LSP_KEY,
        fileSystem: fs.asPort(),
        getPreferences: () => prefs,
      });
    port.acquire(server, LSP_KEY);
    return { port, documents, first: create(), second: create(), connection: port.connection };
  }

  it("keeps one open document with one version sequence across sessions", async () => {
    const { first, second, connection } = setup();
    connection.onNotify = (message) => {
      if (
        message.method === "textDocument/didOpen" ||
        message.method === "textDocument/didChange"
      ) {
        const version = message.method === "textDocument/didOpen" ? 1 : versionOf(message.params);
        connection.publish(FILE_URI, [], version);
      }
    };

    await first.diagnostics(FILE);
    const editA = "export const a = 2;\n";
    first.onFileMutated({ path: FILE, kind: "changed", content: editA });
    await first.collectEditDiagnostics();

    const editB = "export const a = 3;\n";
    second.onFileMutated({ path: FILE, kind: "changed", content: editB });
    await second.collectEditDiagnostics();

    expect(connection.methods("textDocument/didOpen")).toHaveLength(1);
    expect(connection.methods("textDocument/didClose")).toHaveLength(0);
    expect(connection.methods("textDocument/didChange").map((m) => versionOf(m.params))).toEqual([
      2, 3,
    ]);
    first.dispose();
    second.dispose();
  });

  it("delivers fresh diagnostics to the editing session after another session is disposed", async () => {
    const { first, second, connection } = setup();
    connection.onNotify = (message) => {
      if (message.method === "textDocument/didOpen") connection.publish(FILE_URI, [], 1);
      if (message.method === "textDocument/didChange") {
        connection.publish(
          FILE_URI,
          [rawDiagnostic({ line: 0, message: "new error" })],
          versionOf(message.params),
        );
      }
    };
    await first.diagnostics(FILE);
    first.dispose();

    second.onFileMutated({
      path: FILE,
      kind: "changed",
      content: "export const a: string = 1;\n",
      changedRange: { startLine: 1, endLine: 1 },
    });
    const result = await second.collectEditDiagnostics();

    expect(result.attachmentBody).toContain("new error");
    // Disposing a session must not close the shared document.
    expect(connection.methods("textDocument/didClose")).toHaveLength(0);
    second.dispose();
  });
});
