import { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_MEMORY_DIAGNOSTIC_FORMAT, type CliMemoryDiagnosticRecord } from "@zcode/shared";
import {
  CLI_MEMORY_DIAGNOSTIC_RETENTION_MS,
  writeMemoryDiagnostic,
} from "../src/memory-diagnostics/writer.js";

const INSTANCE_A = "0f1e2d3c-4b5a-4968-8777-665544332211";
const INSTANCE_B = "11111111-2222-4333-8444-555555555555";

function record(instanceId: string): CliMemoryDiagnosticRecord {
  return {
    format: CLI_MEMORY_DIAGNOSTIC_FORMAT,
    timestamp: Date.now(),
    instanceId,
    pid: 1,
    version: "3.18.1",
    commit: "abc",
    node: "24.1.0",
    v8: "13.6",
    bundleSha256: "",
    sampler: {
      state: "active",
      intervalBytes: 1,
      windowStartedAt: 0,
      profileCapturedAt: 0,
      durationMs: 0,
    },
    samples: [],
    allocations: [],
  };
}

async function seed(directory: string, name: string, mtimeMs: number, content = "{}\n") {
  const path = join(directory, name);
  await writeFile(path, content);
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
}

describe("writeMemoryDiagnostic", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-memdiag-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes one private sanitized record and creates the directory with 0700", async () => {
    await writeMemoryDiagnostic(join(directory, "nested"), record(INSTANCE_A));
    const names = await readdir(join(directory, "nested"));
    const written = names.filter((name) => name.endsWith(".jsonl"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(new RegExp(`^memory-\\d+-${INSTANCE_A}\\.jsonl$`));
    const mode = (await stat(join(directory, "nested", written[0]!))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  });

  it("keeps only one older file from the writing instance", async () => {
    const now = Date.now();
    await seed(directory, `memory-${now - 3_000}-${INSTANCE_A}.jsonl`, now - 3_000);
    await seed(directory, `memory-${now - 2_000}-${INSTANCE_A}.jsonl`, now - 2_000);
    await seed(directory, `memory-${now - 1_000}-${INSTANCE_A}.jsonl`, now - 1_000);
    await writeMemoryDiagnostic(directory, record(INSTANCE_A));
    const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    expect(names).toHaveLength(2);
  });

  it("removes stale temporary files, files over 7 days, and oversized files", async () => {
    const now = Date.now();
    await seed(directory, `.memory-1-${INSTANCE_B}.jsonl.1.2.tmp`, now);
    // Retention is judged by mtime, so the stale file gets an old mtime.
    const stale = now - CLI_MEMORY_DIAGNOSTIC_RETENTION_MS - 60_000;
    await seed(directory, `memory-${stale}-${INSTANCE_B}.jsonl`, stale);
    await seed(directory, `memory-${now - 1}-${INSTANCE_B}.jsonl`, now - 1, "x".repeat(70_000));
    await writeMemoryDiagnostic(directory, record(INSTANCE_A));
    const names = await readdir(directory);
    expect(names.some((name) => name.startsWith(".memory-"))).toBe(false);
    expect(names.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("keeps at most 15 files from other instances plus the new one", async () => {
    const now = Date.now();
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      await seed(
        directory,
        `memory-${now - index * 1000 - 5_000}-${INSTANCE_B}.jsonl`,
        now - index * 1000 - 5_000,
      );
    }
    await writeMemoryDiagnostic(directory, record(INSTANCE_A));
    const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    expect(names).toHaveLength(16);
  });

  it("drops a record that fails sanitizing (no instanceId) without touching the directory", async () => {
    await writeMemoryDiagnostic(directory, { ...record(INSTANCE_A), instanceId: "bad" });
    expect(await readdir(directory)).toEqual([]);
  });
});
