import { describe, expect, it, vi } from "vitest";
import { createNodeSelfResourceSampler } from "../src/node/nodeSelfResourceTelemetry.js";

const spawnMock = vi.fn();
const execFileMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const usage = (rssMb: number, heapUsedMb: number): NodeJS.MemoryUsage => ({
  rss: rssMb * 1024 * 1024,
  heapTotal: 100 * 1024 * 1024,
  heapUsed: heapUsedMb * 1024 * 1024,
  external: 10 * 1024 * 1024,
  arrayBuffers: 1024 * 1024,
});

/** Stub that returns the given readings in order, then keeps returning the last value. */
function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] as T;
}

describe("createNodeSelfResourceSampler", () => {
  it("构造即建立 CPU 基线，第一次采样就产出整机归一化 CPU 与 KB 口径内存", () => {
    const sampler = createNodeSelfResourceSampler({
      logicalCpuCount: 8,
      // 4.8s of CPU within a 60s wall clock → 0.08 cores → 1% on an 8-core machine.
      readCpuUsage: sequence([
        { user: 0, system: 0 },
        { user: 3_600_000, system: 1_200_000 },
      ]),
      readMonotonicTimeNs: sequence([0n, 60_000_000_000n]),
    });

    expect(sampler.sample(usage(200, 50))).toEqual({
      cpuPercent: 1,
      rssKb: 204_800,
      heapUsedKb: 51_200,
    });
  });

  it("时钟未前进或 CPU 计数回退时丢当前样本，并把基线挪到本次读数", () => {
    const sampler = createNodeSelfResourceSampler({
      logicalCpuCount: 4,
      readCpuUsage: sequence([
        { user: 1_000_000, system: 0 },
        // CPU counters went backwards (should not happen, but anomalous readings must not produce negative values).
        { user: 0, system: 0 },
        { user: 800_000, system: 0 },
      ]),
      readMonotonicTimeNs: sequence([0n, 60_000_000_000n, 120_000_000_000n]),
    });

    expect(sampler.sample(usage(100, 20))).toBeNull();
    // Baseline moved to the previous reading: 0.8s CPU / 60s / 4 cores = 0.3333%.
    expect(sampler.sample(usage(100, 20))).toEqual({
      cpuPercent: 0.3333,
      rssKb: 102_400,
      heapUsedKb: 20_480,
    });
  });

  it("进程指标 API 抛错时只丢当前样本，不抛出", () => {
    const sampler = createNodeSelfResourceSampler({
      logicalCpuCount: 8,
      readCpuUsage: () => {
        throw new Error("cpuUsage unavailable");
      },
      readMonotonicTimeNs: () => 0n,
    });

    expect(() => sampler.sample(usage(100, 20))).not.toThrow();
    expect(sampler.sample(usage(100, 20))).toBeNull();
  });

  it("不启动任何外部进程（性能红线 1：全链路禁止外部探针）", () => {
    const sampler = createNodeSelfResourceSampler({ logicalCpuCount: 8 });

    sampler.sample(usage(100, 20));
    sampler.sample(usage(100, 20));

    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
