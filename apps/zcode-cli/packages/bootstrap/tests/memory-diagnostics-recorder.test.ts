import { describe, expect, it, vi } from "vitest";
import type { CliMemoryDiagnosticRecord } from "@zcode/shared";
import {
  createMemoryDiagnosticRecorder,
  projectAllocations,
  type CliMemoryProfilerPort,
  type HeapProfileNode,
} from "../src/memory-diagnostics/recorder.js";

const BUNDLE_PATH = "/app/zcode.cjs";
const META = {
  instanceId: "0f1e2d3c-4b5a-4968-8777-665544332211",
  pid: 7,
  version: "3.18.1",
  commit: "abc",
  node: "24.1.0",
  v8: "13.6",
  bundleSha256: "",
};

function node(
  url: string,
  functionName: string,
  selfSize: number,
  children: HeapProfileNode[] = [],
): HeapProfileNode {
  return {
    callFrame: { functionName, url, lineNumber: 3, columnNumber: 9 },
    selfSize,
    children,
  };
}

function harness(
  options: {
    head?: HeapProfileNode;
    startError?: Error;
    readError?: Error;
    heapUsed?: number;
    heapLimit?: number;
    onRead?: () => void;
  } = {},
) {
  const clock = { now: 1_000, measure: 0 };
  const writes: CliMemoryDiagnosticRecord[] = [];
  const profiler: CliMemoryProfilerPort & {
    start: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  } = {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
    }),
    read: vi.fn(async () => {
      options.onRead?.();
      if (options.readError) throw options.readError;
      return { head: options.head ?? node("", "(root)", 0) };
    }),
    reset: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const recorder = createMemoryDiagnosticRecorder({
    now: () => clock.now,
    measure: () => clock.measure,
    profiler,
    readMemory: () => ({
      rss: 100,
      heapUsed: options.heapUsed ?? 10,
      heapTotal: 20,
      external: 1,
      arrayBuffers: 1,
      heapLimit: options.heapLimit ?? 1_000,
    }),
    readCounters: () => ({ sessions: 1 }),
    metadata: () => META,
    bundlePath: BUNDLE_PATH,
    write: async (record) => {
      writes.push(record);
    },
  });
  return { clock, writes, profiler, recorder };
}

describe("projectAllocations", () => {
  it("keeps only frames from the running bundle and sorts the top sites by self bytes", () => {
    const head = node("", "(root)", 0, [
      node("file:///app/zcode.cjs", "bigAlloc", 900),
      node("file:///app/zcode.cjs", "smallAlloc", 100, [node("file:///other/lib.js", "leaf", 50)]),
      node("file:///other/lib.js", "outside", 5_000),
    ]);
    const projected = projectAllocations(head, BUNDLE_PATH);
    expect(projected).not.toBeNull();
    expect(projected!.map((entry) => entry.bytes)).toEqual([900, 100, 50]);
    expect(projected![0]!.stack).toEqual([{ name: "bigAlloc", line: 3, column: 9 }]);
    // A non-bundle leaf under a bundle frame is attributed to that frame, and the 5000-byte site outside the bundle is dropped.
    expect(projected!.some((entry) => entry.bytes === 5_000)).toBe(false);
  });

  it("returns null when the profile has more nodes than the budget", () => {
    const children = Array.from({ length: 5_000 }, (_, index) =>
      node("file:///app/zcode.cjs", `f${index}`, 1),
    );
    expect(projectAllocations(node("", "(root)", 0, children), BUNDLE_PATH)).toBeNull();
  });
});

describe("createMemoryDiagnosticRecorder", () => {
  it("starts in active state when the profiler starts within budget and writes an active record", async () => {
    const { recorder, profiler, writes } = harness({
      head: node("file:///app/zcode.cjs", "alloc", 100),
    });
    await recorder.start();
    await recorder.sample();
    expect(profiler.start).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sampler.state).toBe("active");
    expect(writes[0]!.allocations[0]!.bytes).toBe(100);
    expect(writes[0]!.samples[0]).toMatchObject({ rss: 100, heapUsed: 10, heapLimit: 1_000 });
    expect(writes[0]!.instanceId).toBe(META.instanceId);
  });

  it("marks budget-exceeded and disposes the profiler when startSampling takes longer than 25 ms", async () => {
    const { clock, recorder, profiler, writes } = harness();
    profiler.start.mockImplementationOnce(async () => {
      clock.measure += 30;
    });
    await recorder.start();
    await recorder.sample();
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
    expect(profiler.read).not.toHaveBeenCalled();
    expect(writes[0]!.sampler.state).toBe("budget-exceeded");
  });

  it("marks unsupported when startSampling throws, and keeps writing memory-only records", async () => {
    const { recorder, profiler, writes } = harness({ startError: new Error("no inspector") });
    await recorder.start();
    await recorder.sample();
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
    expect(profiler.read).not.toHaveBeenCalled();
    expect(writes[0]!.sampler.state).toBe("unsupported");
    expect(writes[0]!.allocations).toEqual([]);
  });

  it("stops profiling once heap usage reaches 80% of the heap limit", async () => {
    const { recorder, profiler, writes } = harness({ heapUsed: 800, heapLimit: 1_000 });
    await recorder.start();
    await recorder.sample();
    expect(profiler.read).not.toHaveBeenCalled();
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
    expect(writes[0]!.sampler.state).toBe("budget-exceeded");
  });

  it("marks budget-exceeded and keeps the previous allocations when the projection visits too many nodes", async () => {
    const children = Array.from({ length: 5_000 }, (_, index) =>
      node("file:///app/zcode.cjs", `f${index}`, 1),
    );
    const { recorder, writes } = harness({ head: node("", "(root)", 0, children) });
    await recorder.start();
    await recorder.sample();
    expect(writes[0]!.sampler.state).toBe("budget-exceeded");
    expect(writes[0]!.allocations).toEqual([]);
  });

  it("marks error when reading the profile throws", async () => {
    const { recorder, profiler, writes } = harness({ readError: new Error("boom") });
    await recorder.start();
    await recorder.sample();
    expect(writes[0]!.sampler.state).toBe("error");
    expect(profiler.dispose).toHaveBeenCalled();
  });

  it("resets the profile after a 60 s window and records the captured window start", async () => {
    const { clock, recorder, profiler, writes } = harness({
      head: node("file:///app/zcode.cjs", "alloc", 100),
    });
    await recorder.start();
    clock.now += 60_000;
    await recorder.sample();
    expect(profiler.reset).toHaveBeenCalledTimes(1);
    expect(writes[0]!.sampler.windowStartedAt).toBe(1_000);
    expect(writes[0]!.sampler.profileCapturedAt).toBe(61_000);
  });

  it("writes nothing and disposes once after stop", async () => {
    const { recorder, profiler, writes } = harness({
      head: node("file:///app/zcode.cjs", "alloc", 100),
    });
    await recorder.start();
    recorder.stop();
    await recorder.sample();
    expect(writes).toHaveLength(0);
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
  });

  it("marks budget-exceeded when a tick runs longer than 25 ms, and still writes that tick", async () => {
    const { clock, recorder, profiler, writes } = harness({
      head: node("file:///app/zcode.cjs", "alloc", 100),
    });
    profiler.read.mockImplementationOnce(async () => {
      clock.measure += 40;
      return { head: node("file:///app/zcode.cjs", "alloc", 100) };
    });
    await recorder.start();
    await recorder.sample();
    expect(writes[0]!.sampler.state).toBe("budget-exceeded");
    expect(profiler.dispose).toHaveBeenCalled();
  });
});
