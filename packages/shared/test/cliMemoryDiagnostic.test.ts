import { describe, expect, it } from "vitest";
import {
  CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS,
  CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN,
  CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS,
  CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES,
  CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES,
  sanitizeCliMemoryDiagnostic,
} from "../src/memoryDiagnostics.js";

const INSTANCE_ID = "0f1e2d3c-4b5a-4968-8777-665544332211";
const BUNDLE_SHA = "a".repeat(64);

function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "zcode-cli-memory-v1",
    timestamp: 1_700_000_000_000,
    instanceId: INSTANCE_ID,
    pid: 4242,
    version: "3.18.1-fork.1",
    commit: "abc123",
    node: "24.1.0",
    v8: "13.6.233.10-node.20",
    bundleSha256: BUNDLE_SHA,
    sampler: {
      state: "active",
      intervalBytes: 1024 * 1024,
      windowStartedAt: 1,
      profileCapturedAt: 2,
      durationMs: 3,
    },
    samples: [
      {
        at: 10,
        rss: 100,
        heapUsed: 50,
        heapTotal: 60,
        external: 5,
        arrayBuffers: 1,
        heapLimit: 4096,
        counters: { sessions: 2, eventRows: 9, "v4.publishers": 1, secretKey: 999 },
      },
    ],
    allocations: [
      {
        bytes: 512,
        stack: [{ name: "parseThing", line: 12, column: 4 }],
      },
    ],
    ...overrides,
  };
}

describe("sanitizeCliMemoryDiagnostic", () => {
  it("keeps a well-formed record and drops counters outside the fixed key list", () => {
    const record = sanitizeCliMemoryDiagnostic(baseRecord());
    expect(record).not.toBeNull();
    expect(record!.format).toBe("zcode-cli-memory-v1");
    expect(record!.instanceId).toBe(INSTANCE_ID);
    expect(record!.bundleSha256).toBe(BUNDLE_SHA);
    expect(record!.samples[0]!.counters).toEqual({
      sessions: 2,
      eventRows: 9,
      "v4.publishers": 1,
    });
    expect(record!.samples[0]).toMatchObject({ rss: 100, heapUsed: 50, heapLimit: 4096 });
    expect(record!.allocations[0]!.stack).toEqual([{ name: "parseThing", line: 12, column: 4 }]);
    expect(Object.keys(record!)).not.toContain("extra");
  });

  it("rejects anything that is not the zcode-cli-memory-v1 format", () => {
    expect(sanitizeCliMemoryDiagnostic(null)).toBeNull();
    expect(sanitizeCliMemoryDiagnostic([])).toBeNull();
    expect(sanitizeCliMemoryDiagnostic(baseRecord({ format: "other" }))).toBeNull();
    expect(sanitizeCliMemoryDiagnostic(baseRecord({ samples: "nope" }))).toBeNull();
  });

  it("rejects a sampler state outside the allowed set", () => {
    expect(
      sanitizeCliMemoryDiagnostic(baseRecord({ sampler: { state: "running", intervalBytes: 1 } })),
    ).toBeNull();
    expect(sanitizeCliMemoryDiagnostic(baseRecord({ sampler: undefined }))).toBeNull();
    for (const state of ["active", "unsupported", "budget-exceeded", "error"]) {
      expect(
        sanitizeCliMemoryDiagnostic(baseRecord({ sampler: { ...baseRecordSampler(), state } })),
      ).not.toBeNull();
    }
  });

  it("turns non-finite, negative, and non-number values into 0 without dropping the record", () => {
    const record = sanitizeCliMemoryDiagnostic(
      baseRecord({
        timestamp: Number.NaN,
        pid: -1,
        samples: [{ at: Infinity, rss: "100", heapUsed: -5, counters: { sessions: "3" } }],
      }),
    );
    expect(record).not.toBeNull();
    expect(record!.timestamp).toBe(0);
    expect(record!.pid).toBe(0);
    expect(record!.samples[0]).toMatchObject({ at: 0, rss: 0, heapUsed: 0, heapLimit: 0 });
    expect(record!.samples[0]!.counters).toEqual({});
  });

  it("blanks strings that do not match their token or identifier pattern", () => {
    const record = sanitizeCliMemoryDiagnostic(
      baseRecord({
        instanceId: "not-a-uuid",
        version: "has spaces",
        commit: "x".repeat(81),
        node: "24.1.0",
        bundleSha256: "b".repeat(63),
        allocations: [{ bytes: 1, stack: [{ name: "a path/with/slash", line: 1, column: 1 }] }],
      }),
    );
    expect(record).not.toBeNull();
    expect(record!.instanceId).toBe("");
    expect(record!.version).toBe("");
    expect(record!.commit).toBe("");
    expect(record!.node).toBe("24.1.0");
    expect(record!.bundleSha256).toBe("");
    expect(record!.allocations[0]!.stack[0]!.name).toBe("");
  });

  it("bounds samples, allocations, and stack frames", () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({ at: index }));
    const allocations = Array.from({ length: 40 }, (_, index) => ({
      bytes: index,
      stack: Array.from({ length: 12 }, (_frame, frame) => ({
        name: `f${frame}`,
        line: frame,
        column: 0,
      })),
    }));
    const record = sanitizeCliMemoryDiagnostic(baseRecord({ samples, allocations }));
    expect(record!.samples).toHaveLength(CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES);
    // The newest samples are kept (slice from the end), so the last sample has the highest `at`.
    expect(record!.samples.at(-1)!.at).toBe(19);
    expect(record!.allocations).toHaveLength(CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS);
    expect(record!.allocations[0]!.stack).toHaveLength(CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES);
    // Frames are the innermost (last) eight of a twelve-frame stack.
    expect(record!.allocations[0]!.stack[0]!.name).toBe("f4");
  });

  it("exposes the counter key list used by the writer and the archive", () => {
    expect(CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS).toContain("v4.binaryCacheBytes");
    expect(CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS).toHaveLength(12);
  });

  it("matches only the writer's filename shape", () => {
    expect(
      CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN.test(`memory-1700000000000-${INSTANCE_ID}.jsonl`),
    ).toBe(true);
    expect(CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN.test("memory-x-abc.jsonl")).toBe(false);
    expect(CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN.test(`.memory-1-${INSTANCE_ID}.jsonl.tmp`)).toBe(
      false,
    );
  });
});

function baseRecordSampler(): Record<string, number | string> {
  return { intervalBytes: 1, windowStartedAt: 0, profileCapturedAt: 0, durationMs: 0 };
}
