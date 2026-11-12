import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFeedbackDiagnosticArchive } from "../src/feedback/feedbackLogArchive.js";

const SAMPLE_RECORD = {
  format: "zcode-cli-memory-v1",
  timestamp: 1_700_000_000_000,
  instanceId: "0f1e2d3c-4b5a-4968-8777-665544332211",
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
  // Unknown fields must not survive the projection.
  apiKey: "secret-should-not-appear",
};

function readZipEntries(zipPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const entries = new Map<string, string>();
      zip.on("entry", (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (openError, stream) => {
          if (openError || !stream) {
            reject(openError);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("feedback archive cli-memory source", () => {
  let root: string;
  let memoryDirectory: string;
  let outputRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-memarchive-test-"));
    memoryDirectory = join(root, "memory-diagnostics");
    outputRoot = join(root, "out");
    await mkdir(memoryDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts at most 16 valid records, rejects invalid and oversized files, and ignores other names and nested directories", async () => {
    // Sorted by name: the invalid and oversized files come first so their skip reasons are reached before the cap.
    await writeFile(join(memoryDirectory, `memory-1000-${randomUUID()}.jsonl`), "{not json\n");
    await writeFile(
      join(memoryDirectory, `memory-1001-${randomUUID()}.jsonl`),
      `${JSON.stringify({ ...SAMPLE_RECORD, padding: "x".repeat(70_000) })}\n`,
    );
    for (let index = 0; index < 17; index += 1) {
      const name = `memory-17000000000${String(index).padStart(2, "0")}-${randomUUID()}.jsonl`;
      await writeFile(join(memoryDirectory, name), `${JSON.stringify(SAMPLE_RECORD)}\n`);
    }
    await writeFile(join(memoryDirectory, "notes.jsonl"), "{}\n");
    await mkdir(join(memoryDirectory, "sub"));
    await writeFile(join(memoryDirectory, "sub", `memory-1-${randomUUID()}.jsonl`), "{}\n");

    const archive = await createFeedbackDiagnosticArchive({
      sources: [
        {
          directory: memoryDirectory,
          archivePrefix: ".zcode/cli/memory-diagnostics",
          contentPolicy: "cli-memory",
          onlyCurrentDay: false,
        },
      ],
      outputRootDir: outputRoot,
    });
    const entries = await readZipEntries(archive.path);

    const memoryEntries = [...entries.keys()].filter((name) =>
      name.startsWith(".zcode/cli/memory-diagnostics/"),
    );
    expect(memoryEntries).toHaveLength(16);
    for (const name of memoryEntries) {
      expect(name).toMatch(/^\.zcode\/cli\/memory-diagnostics\/memory-\d+-[a-f0-9-]{36}\.jsonl$/);
    }
    expect(entries.has(".zcode/cli/memory-diagnostics/notes.jsonl")).toBe(false);
    expect([...entries.keys()].some((name) => name.includes("/sub/"))).toBe(false);

    const sampleText = entries.get(memoryEntries[0]!)!;
    expect(sampleText.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(sampleText) as Record<string, unknown>;
    expect(parsed.apiKey).toBeUndefined();
    expect(parsed.format).toBe("zcode-cli-memory-v1");
    expect(sampleText).not.toContain("secret-should-not-appear");

    const about = entries.get("about.txt")!;
    expect(about).toContain("includedLogFiles: 16");
    expect(about).toContain('"invalid-memory-diagnostic":1');
    expect(about).toContain('"metadata-policy":1');
    expect(about).toContain("bounded CLI memory evidence");
  });

  it("collects records whose modification time is not today when onlyCurrentDay is false", async () => {
    const name = `memory-1700000000000-${randomUUID()}.jsonl`;
    await writeFile(join(memoryDirectory, name), `${JSON.stringify(SAMPLE_RECORD)}\n`);
    const { utimes } = await import("node:fs/promises");
    const old = new Date("2001-01-01T00:00:00Z");
    await utimes(join(memoryDirectory, name), old, old);
    const archive = await createFeedbackDiagnosticArchive({
      sources: [
        {
          directory: memoryDirectory,
          archivePrefix: ".zcode/cli/memory-diagnostics",
          contentPolicy: "cli-memory",
          onlyCurrentDay: false,
        },
      ],
      outputRootDir: outputRoot,
    });
    const entries = await readZipEntries(archive.path);
    expect(entries.has(`.zcode/cli/memory-diagnostics/${name}`)).toBe(true);
  });
});
