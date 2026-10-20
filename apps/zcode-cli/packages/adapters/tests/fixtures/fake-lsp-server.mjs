// Fake language server for adapters tests. Speaks LSP over stdio with Content-Length framing.
//
// Env knobs (all optional):
//   FAKE_LSP_STARTUP_DELAY_MS   delay before answering `initialize`, in ms.
//   FAKE_LSP_DIAGNOSTICS        publish mode, default "versioned":
//                                 versioned   publishDiagnostics with `version` after each open/change
//                                 versionless publishDiagnostics without `version` (TypeScript-like)
//                                 pull        advertises diagnosticProvider, answers textDocument/diagnostic, no push
//                                 multi       two partial publishes per change (empty, then full), both versioned
//                                 none        never publishes
//   FAKE_LSP_PUBLISH_DELAY_MS   delay before each publish, in ms.
//   FAKE_LSP_CRASH_ON           method name; the process exits with code 1 when it receives that method.
//   FAKE_LSP_IGNORE_SHUTDOWN=1  ignores `shutdown` and `exit`, so the pool must kill the process tree.
//   FAKE_LSP_CONFIG_REQUEST=1   after `initialized`, sends workspace/configuration (section "fake.mode")
//                               and forwards the answer as notification `fake/configuration` {result}.
//   FAKE_LSP_STDERR_TEXT        text written to stderr at startup (for start-failure tail tests).
//   FAKE_LSP_REQUIRE_FILE       absolute path; while it does not exist, `initialize` is answered with
//                               JSON-RPC -32603 the way typescript-language-server rejects a workspace
//                               without a usable TypeScript. Creating the file models `pnpm install`.
//
// Behaviour:
//   - Every line containing FAKE_ERROR gets one diagnostic: severity 1, message "fake error".
//   - definition / references / implementation: location of the first occurrence of the word under the cursor.
//   - hover: markdown "fake hover". documentSymbol: one Function symbol per line matching /function (\w+)/.
//   - workspace/symbol: symbols from open documents whose name contains params.query.
//   - `fake/sleep` {ms} answers null after ms, unless `$/cancelRequest` for it arrived first.
//   - `$/cancelRequest` emits notification `fake/cancelled` {id}.

import { existsSync } from "node:fs";

const MODE = process.env.FAKE_LSP_DIAGNOSTICS ?? "versioned";
const STARTUP_DELAY_MS = Number(process.env.FAKE_LSP_STARTUP_DELAY_MS ?? 0);
const PUBLISH_DELAY_MS = Number(process.env.FAKE_LSP_PUBLISH_DELAY_MS ?? 0);
const CRASH_ON = process.env.FAKE_LSP_CRASH_ON;
const IGNORE_SHUTDOWN = process.env.FAKE_LSP_IGNORE_SHUTDOWN === "1";
const CONFIG_REQUEST = process.env.FAKE_LSP_CONFIG_REQUEST === "1";
const CONFIG_REQUEST_ID = "fake-config";
const REQUIRE_FILE = process.env.FAKE_LSP_REQUIRE_FILE;
const ERROR_MARKER = "FAKE_ERROR";
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_REQUEST_CANCELLED = -32800;
const LSP_FUNCTION_KIND = 12;
const LSP_ERROR_SEVERITY = 1;

if (process.env.FAKE_LSP_STDERR_TEXT) {
  process.stderr.write(process.env.FAKE_LSP_STDERR_TEXT);
}

const docs = new Map(); // uri -> { text, version }
const cancelled = new Set();
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]),
  );
}

function respond(id, result) {
  send({ id, result: result ?? null });
}

function respondError(id, code, message) {
  send({ id, error: { code, message } });
}

function notify(method, params) {
  send({ method, params });
}

function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/iu.exec(header);
    if (!match) process.exit(2);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  if (CRASH_ON && message.method === CRASH_ON) process.exit(1);
  if (message.method === undefined) {
    if (message.id === CONFIG_REQUEST_ID) notify("fake/configuration", { result: message.result });
    return;
  }
  if (message.method === "$/cancelRequest") {
    cancelled.add(message.params.id);
    notify("fake/cancelled", { id: message.params.id });
    return;
  }
  if (message.id === undefined) {
    onNotification(message);
    return;
  }
  onRequest(message);
}

function onNotification(message) {
  switch (message.method) {
    case "initialized":
      if (CONFIG_REQUEST) {
        send({
          id: CONFIG_REQUEST_ID,
          method: "workspace/configuration",
          params: { items: [{ section: "fake.mode" }] },
        });
      }
      return;
    case "exit":
      if (!IGNORE_SHUTDOWN) process.exit(0);
      return;
    case "textDocument/didOpen": {
      const { uri, text, version } = message.params.textDocument;
      docs.set(uri, { text, version });
      publish(uri);
      return;
    }
    case "textDocument/didChange": {
      const { uri, version } = message.params.textDocument;
      const changes = message.params.contentChanges;
      docs.set(uri, { text: changes[changes.length - 1].text, version });
      publish(uri);
      return;
    }
    case "textDocument/didClose":
      docs.delete(message.params.textDocument.uri);
      return;
    default:
      return;
  }
}

function onRequest(message) {
  const { id, params } = message;
  switch (message.method) {
    case "initialize":
      if (REQUIRE_FILE && !existsSync(REQUIRE_FILE)) {
        respondError(id, JSON_RPC_INTERNAL_ERROR, "fake: required workspace dependency is missing");
        return;
      }
      setTimeout(() => {
        const capabilities = {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
        };
        if (MODE === "pull") {
          capabilities.diagnosticProvider = {
            interFileDependencies: false,
            workspaceDiagnostics: false,
          };
        }
        respond(id, { capabilities, serverInfo: { name: "fake-lsp-server" } });
      }, STARTUP_DELAY_MS);
      return;
    case "shutdown":
      if (!IGNORE_SHUTDOWN) respond(id, null);
      return;
    case "fake/sleep":
      setTimeout(
        () => {
          if (!cancelled.has(id)) respond(id, null);
        },
        Number(params?.ms ?? 0),
      );
      return;
    case "textDocument/hover":
      respond(id, { contents: { kind: "markdown", value: "fake hover" } });
      return;
    case "textDocument/definition":
    case "textDocument/references":
    case "textDocument/implementation":
      respond(id, locationForWord(params));
      return;
    case "textDocument/documentSymbol": {
      const doc = docs.get(params.textDocument.uri);
      respond(id, doc ? functionSymbols(doc.text, params.textDocument.uri) : []);
      return;
    }
    case "workspace/symbol":
      respond(id, workspaceSymbols(params?.query ?? ""));
      return;
    case "textDocument/diagnostic":
      if (MODE !== "pull") {
        respondError(id, JSON_RPC_METHOD_NOT_FOUND, "textDocument/diagnostic is not supported");
        return;
      }
      respond(id, {
        kind: "full",
        items: diagnosticsFor(docs.get(params.textDocument.uri)?.text ?? ""),
      });
      return;
    default:
      if (cancelled.has(id)) {
        respondError(id, JSON_RPC_REQUEST_CANCELLED, "cancelled");
        return;
      }
      respondError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${message.method}`);
  }
}

function publish(uri) {
  const doc = docs.get(uri);
  if (!doc || MODE === "pull" || MODE === "none") return;
  const diagnostics = diagnosticsFor(doc.text);
  const version = doc.version;
  const emit = () => {
    if (MODE === "versionless") {
      notify("textDocument/publishDiagnostics", { uri, diagnostics });
    } else if (MODE === "multi") {
      notify("textDocument/publishDiagnostics", { uri, version, diagnostics: [] });
      notify("textDocument/publishDiagnostics", { uri, version, diagnostics });
    } else {
      notify("textDocument/publishDiagnostics", { uri, version, diagnostics });
    }
  };
  if (PUBLISH_DELAY_MS > 0) setTimeout(emit, PUBLISH_DELAY_MS);
  else emit();
}

function diagnosticsFor(text) {
  const diagnostics = [];
  text.split("\n").forEach((line, lineIndex) => {
    const character = line.indexOf(ERROR_MARKER);
    if (character < 0) return;
    diagnostics.push({
      range: range(lineIndex, character, character + ERROR_MARKER.length),
      severity: LSP_ERROR_SEVERITY,
      message: "fake error",
      source: "fake",
    });
  });
  return diagnostics;
}

function range(line, startCharacter, endCharacter) {
  return {
    start: { line, character: startCharacter },
    end: { line, character: endCharacter },
  };
}

function functionSymbols(text, uri) {
  const symbols = [];
  text.split("\n").forEach((line, lineIndex) => {
    const match = /function (\w+)/u.exec(line);
    if (!match) return;
    const nameStart = match.index + "function ".length;
    symbols.push({
      name: match[1],
      kind: LSP_FUNCTION_KIND,
      range: range(lineIndex, 0, line.length),
      selectionRange: range(lineIndex, nameStart, nameStart + match[1].length),
      location: { uri, range: range(lineIndex, nameStart, nameStart + match[1].length) },
    });
  });
  return symbols;
}

function workspaceSymbols(query) {
  const results = [];
  for (const [uri, doc] of docs) {
    for (const symbol of functionSymbols(doc.text, uri)) {
      if (symbol.name.includes(query)) {
        results.push({ name: symbol.name, kind: symbol.kind, location: symbol.location });
      }
    }
  }
  return results;
}

function locationForWord(params) {
  const doc = docs.get(params.textDocument.uri);
  if (!doc) return null;
  const lines = doc.text.split("\n");
  const line = lines[params.position.line] ?? "";
  let start = params.position.character;
  let end = start;
  while (start > 0 && /\w/u.test(line[start - 1])) start -= 1;
  while (end < line.length && /\w/u.test(line[end])) end += 1;
  const word = line.slice(start, end);
  if (word.length === 0) return null;
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = pattern.exec(lines[lineIndex]);
    if (match) {
      return {
        uri: params.textDocument.uri,
        range: range(lineIndex, match.index, match.index + word.length),
      };
    }
  }
  return null;
}
