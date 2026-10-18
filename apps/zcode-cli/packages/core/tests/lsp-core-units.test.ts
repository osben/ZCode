import { describe, expect, it } from "vitest";
import { LspError, type LspDiagnostic } from "@zcode/contracts";
import { LspServerRegistry } from "../src/lsp/registry.js";
import {
  codePointColumnToUtf16,
  findSymbolColumn,
  resolveModelPosition,
  splitLines,
  toModelPosition,
  utf16ToCodePointColumn,
} from "../src/lsp/position.js";
import {
  diagnosticsNotInBaseline,
  normalizeRawDiagnostics,
  overlapsChangedRange,
} from "../src/lsp/diagnostics.js";
import {
  changedRangeBetweenLines,
  changedRangeFromHunks,
  normalizeHover,
  normalizeLocations,
  normalizeSymbols,
} from "../src/lsp/results.js";
import { fromFileUri, normalizeFileUri, toFileUri } from "../src/lsp/uri.js";
import { makeServer } from "./lsp-fakes.js";

const DOC_PATH = "/work/repo/src/a.ts";

function diagnostic(
  partial: Partial<LspDiagnostic> & Pick<LspDiagnostic, "message">,
): LspDiagnostic {
  return {
    path: DOC_PATH,
    line: 1,
    character: 1,
    endLine: 1,
    endCharacter: 2,
    severity: "error",
    ...partial,
  };
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof LspError ? error.code : undefined;
  }
  return undefined;
}

describe("LspServerRegistry", () => {
  it("matches the exact extension first, then a case-insensitive one", () => {
    const upper = makeServer({
      id: "a/upper",
      priority: 0,
      extensionToLanguage: { ".TS": "typescript" },
    });
    const lower = makeServer({
      id: "b/lower",
      priority: 0,
      extensionToLanguage: { ".ts": "typescript" },
    });
    const registry = new LspServerRegistry([upper, lower]);

    expect(registry.forFile("/w/x.ts")?.server.id).toBe("b/lower");
    expect(registry.forFile("/w/x.TS")?.server.id).toBe("a/upper");
    // Case-insensitive fallback follows registry order (priority, then id), so the first server wins.
    expect(registry.forFile("/w/x.Ts")?.server.id).toBe("a/upper");
    expect(registry.forFile("/w/Makefile")).toBeUndefined();
  });

  it("lets the higher priority server win when two entries claim one extension", () => {
    const low = makeServer({
      id: "low",
      priority: 1,
      extensionToLanguage: { ".ts": "typescript" },
    });
    const high = makeServer({
      id: "high",
      priority: 5,
      extensionToLanguage: { ".ts": "typescript" },
    });
    const registry = new LspServerRegistry([low, high]);
    expect(registry.forFile("/w/a.ts")?.server.id).toBe("high");
    expect(registry.servers().map((server) => server.id)).toEqual(["high", "low"]);
  });
});

describe("position conversion", () => {
  it("counts code points for the model and UTF-16 units for LSP (surrogate pairs)", () => {
    const line = "a😀b = 1";
    // 'b' is the third code point, after a and the emoji (two UTF-16 units).
    expect(codePointColumnToUtf16(line, 3)).toBe(3);
    expect(utf16ToCodePointColumn(line, 3)).toBe(3);
    expect(toModelPosition([line], { line: 0, character: 3 })).toEqual({ line: 1, character: 3 });
  });

  it("handles Cyrillic text as one code unit per letter", () => {
    const line = "переменная = значение";
    expect(codePointColumnToUtf16(line, 1)).toBe(0);
    expect(codePointColumnToUtf16(line, 12)).toBe(11);
    expect(utf16ToCodePointColumn(line, 11)).toBe(12);
  });

  it("accepts the end-of-line column and rejects anything past it", () => {
    expect(codePointColumnToUtf16("ab", 3)).toBe(2);
    expect(() => codePointColumnToUtf16("ab", 4)).toThrow(LspError);
    expect(() => codePointColumnToUtf16("ab", 0)).toThrow(LspError);
  });

  it("treats CRLF lines the same as LF lines", () => {
    const lines = splitLines("const a = 1;\r\nconst b = 2;\r\n");
    expect(lines).toEqual(["const a = 1;", "const b = 2;", ""]);
    expect(resolveModelPosition(lines, { line: 2, symbol: "b" })).toEqual({
      line: 1,
      character: 6,
    });
    expect(() => resolveModelPosition(lines, { line: 1, character: 14 })).toThrow(LspError);
  });

  it("finds the first whole-word occurrence of a symbol", () => {
    expect(findSymbolColumn("user = users.user", "user")).toBe(1);
    expect(findSymbolColumn("users.user", "user")).toBe(7);
    expect(findSymbolColumn("prefix_user", "user")).toBeUndefined();
    expect(findSymbolColumn("const ü = 1; ü", "ü")).toBe(7);
  });

  it("reports a missing symbol with the dedicated error code", () => {
    try {
      resolveModelPosition(["const a = 1;"], { line: 1, symbol: "missing" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LspError);
      expect((error as LspError).code).toBe("lsp_symbol_not_found_on_line");
    }
  });

  it("rejects a line outside the file", () => {
    expect(codeOf(() => resolveModelPosition(["x"], { line: 2, character: 1 }))).toBe(
      "lsp_invalid_position",
    );
  });
});

describe("diagnostics normalization and baseline matching", () => {
  it("converts LSP positions to 1-based code point columns and maps severity", () => {
    // The emoji occupies UTF-16 units 11 and 12; the closing quote is UTF-16 index 13 = code point column 13.
    const lines = ["const s = '😀';", "x"];
    const [item] = normalizeRawDiagnostics(DOC_PATH, lines, [
      {
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } },
        severity: 2,
        code: 2322,
        source: "ts",
        message: "bad",
      },
    ]);
    expect(item).toMatchObject({
      line: 1,
      character: 13,
      severity: "warning",
      code: "2322",
      source: "ts",
    });
  });

  it("ignores positions when matching a baseline, so a shifted old error is not new", () => {
    const baseline = [diagnostic({ message: "old", line: 5, endLine: 5 })];
    const current = [
      diagnostic({ message: "old", line: 9, endLine: 9 }),
      diagnostic({ message: "old", line: 12, endLine: 12 }),
      diagnostic({ message: "fresh" }),
    ];
    expect(diagnosticsNotInBaseline(current, baseline).map((item) => item.message)).toEqual([
      "old",
      "fresh",
    ]);
  });

  it("uses the changed range only when there is no baseline", () => {
    const item = diagnostic({ message: "x", line: 4, endLine: 6 });
    expect(overlapsChangedRange(item, { startLine: 6, endLine: 9 })).toBe(true);
    expect(overlapsChangedRange(item, { startLine: 7, endLine: 9 })).toBe(false);
  });
});

describe("results normalization", () => {
  it("normalizes Location, LocationLink, and null results", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations({ uri: "file:///a.ts", range })).toEqual([
      { uri: "file:///a.ts", range },
    ]);
    expect(
      normalizeLocations([
        { targetUri: "file:///b.ts", targetRange: range, targetSelectionRange: range },
      ]),
    ).toEqual([{ uri: "file:///b.ts", range }]);
  });

  it("truncates long hover text and joins marked strings", () => {
    const long = "x".repeat(3000);
    const hover = normalizeHover({
      contents: [
        { language: "ts", value: "const a: number" },
        { kind: "markdown", value: long },
      ],
    });
    expect(hover?.startsWith("const a: number\n\n")).toBe(true);
    expect(hover?.endsWith("...(truncated)")).toBe(true);
    expect(normalizeHover({ contents: "" })).toBeUndefined();
  });

  it("flattens a DocumentSymbol tree with container names and readable kinds", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } };
    const symbols = normalizeSymbols(
      [
        {
          name: "Service",
          kind: 5,
          range,
          selectionRange: range,
          children: [{ name: "run", kind: 6, range, selectionRange: range }],
        },
      ],
      "file:///a.ts",
    );
    expect(symbols).toEqual([
      { name: "Service", kind: "class", uri: "file:///a.ts", range },
      { name: "run", kind: "method", uri: "file:///a.ts", range, containerName: "Service" },
    ]);
  });

  it("computes changed ranges from a write and from patch hunks", () => {
    expect(changedRangeBetweenLines(["a", "b", "c"], ["a", "B", "c"])).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(changedRangeBetweenLines(["a", "b", "c"], ["a", "c"])).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(
      changedRangeFromHunks([
        { newStart: 4, newLines: 2 },
        { newStart: 10, newLines: 0 },
      ]),
    ).toEqual({
      startLine: 4,
      endLine: 10,
    });
    expect(changedRangeFromHunks([])).toBeUndefined();
  });
});

describe("file URIs", () => {
  it("round-trips absolute paths and normalizes the Windows drive letter", () => {
    const uri = toFileUri("/work/repo/src/a b.ts");
    expect(fromFileUri(uri)).toBe("/work/repo/src/a b.ts");
    expect(normalizeFileUri("file:///C:/x.ts")).toBe("file:///c:/x.ts");
  });
});
