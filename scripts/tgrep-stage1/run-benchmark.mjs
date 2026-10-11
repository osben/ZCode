#!/usr/bin/env node
// Stage-1 benchmark for pinned tgrep 1.1.0 (plan gate G5 evidence).
// Compares the shared-daemon attached query path against the repository-bundled rg 14.1.1 and
// ugrep 7.8.4 (with the agent's embedded grep default arguments), on a deterministic corpus.
// Also measures attach build time, storage size, per-edit refresh cost, and the
// "search after every edit" cycle against plain rg.
//
// Usage: node scripts/tgrep-stage1/run-benchmark.mjs --out <dir> [--files N] [--reps N] [--keep]

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { generateCorpus, CORPUS_DEFAULT_SEED } from "./lib/corpus.mjs";
import {
  attachView,
  daemonRssKb,
  dirSizeBytes,
  refreshView,
  run,
  startDaemon,
  statusJson,
  summary,
  waitUntil,
} from "./lib/proc.mjs";
import { resolveSpikeTools } from "./lib/tools.mjs";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const keep = args.includes("--keep");
const outDir = readFlag("--out", join("docs/runtime-tools/spikes/tgrep-v1.1.0-stage1/results"));
const corpusFiles = Number(readFlag("--files", 12000));
const reps = Number(readFlag("--reps", 7));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
  throw new Error(`repository root not found at ${repoRoot}`);
}

// Mirrors the Bash prelude's embedded grep defaults (apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts).
const UGREP_DEFAULT_ARGS = [
  "-G",
  "--ignore-files",
  "--hidden",
  "-I",
  "--exclude-dir=.git",
  "--exclude-dir=.svn",
  "--exclude-dir=.hg",
  "--exclude-dir=.bzr",
  "--exclude-dir=.jj",
  "--exclude-dir=.sl",
];

const PATTERNS = [
  { id: "rare_literal", flags: ["-F"], pattern: "spike_rare_token_42" },
  { id: "common_literal", flags: [], pattern: "function" },
  { id: "regex_alternation", flags: [], pattern: "err(or)?_[a-z]+" },
  { id: "case_insensitive", flags: ["-i"], pattern: "LOGGER" },
  { id: "filenames_only", flags: ["-l"], pattern: "function" },
  { id: "count", flags: ["-c"], pattern: "function" },
  { id: "glob_ts", flags: ["-g", "*.ts"], pattern: "spike_mid_token_7" },
  { id: "broad_count", flags: ["-c"], pattern: "[a-q]{3}" },
];

const WARMUP = 2;

function engineCommand(engine, binaries, spec) {
  const { flags, pattern } = spec;
  switch (engine) {
    case "tgrep":
      return { bin: binaries.tgrep, args: [...flags, "--", pattern, "."] };
    case "rg":
      return { bin: binaries.rg, args: [...flags, pattern, "."] };
    case "ugrep":
      // The agent's Bash grep function prepends the default args and relies on the user's own
      // recursion flags; the benchmark uses the canonical recursive repository search form.
      return { bin: binaries.ugrep, args: [...UGREP_DEFAULT_ARGS, "-r", ...flags, pattern, "."] };
    default:
      throw new Error(`unknown engine ${engine}`);
  }
}

function normalizeOutput(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .sort()
    .join("\n");
}

const results = {
  meta: {
    startedAt: new Date().toISOString(),
    corpusFiles,
    reps,
    seed: CORPUS_DEFAULT_SEED,
    host: { platform: process.platform, arch: process.arch, node: process.version },
  },
};

async function main() {
  const tools = await resolveSpikeTools({ repoRoot });
  results.meta.tools = tools.evidence;
  const binaries = tools.binaries;
  const workRoot = await mkdtemp(join(tmpdir(), "zcode-tgrep-benchmark-"));
  console.log(`[benchmark] workdir ${workRoot}`);

  try {
    const corpus = await generateCorpus({ root: join(workRoot, "corpus"), files: corpusFiles });
    results.meta.corpus = { files: corpus.files, bytes: corpus.bytes };

    // Spawn overhead reference: client connection roundtrip vs bare process spawn.
    const statusTimes = [];
    for (let i = 0; i < 20; i += 1) {
      statusTimes.push((await run(binaries.tgrep, ["--version"])).ms);
    }
    const rgVersionTimes = [];
    for (let i = 0; i < 20; i += 1) {
      rgVersionTimes.push((await run(binaries.rg, ["--version"])).ms);
    }
    results.spawnOverhead = {
      tgrepVersionMs: summary(statusTimes),
      rgVersionMs: summary(rgVersionTimes),
    };

    const storage = join(workRoot, "shared-storage");
    await mkdir(storage, { recursive: true });
    const daemon = await startDaemon(
      binaries.tgrep,
      ["serve", "--shared", corpus.root, "--shared-storage", storage, "--no-watch"],
      join(workRoot, "daemon.log"),
    );
    try {
      const attachStarted = performance.now();
      await attachView(binaries.tgrep, corpus.root, corpus.revision, "spike-bench");
      await waitUntil(
        async () => (await statusJson(binaries.tgrep, corpus.root)).ready === true,
        240_000,
      );
      results.attach = {
        attachToReadyMs: Math.round(performance.now() - attachStarted),
        storageBytes: dirSizeBytes(storage),
        daemonRssKb: daemonRssKb(daemon.child.pid),
      };

      // Static-corpus measurements: warm query latency per engine and pattern.
      results.queries = [];
      for (const spec of PATTERNS) {
        const row = { id: spec.id, pattern: spec.pattern, flags: spec.flags, engines: {} };
        for (const engine of ["tgrep", "rg", "ugrep"]) {
          const { bin, args } = engineCommand(engine, binaries, spec);
          for (let i = 0; i < WARMUP; i += 1) {
            await run(bin, args, { cwd: corpus.root, timeoutMs: 60_000 });
          }
          const times = [];
          let last = null;
          for (let i = 0; i < reps; i += 1) {
            last = await run(bin, args, { cwd: corpus.root, timeoutMs: 60_000 });
            times.push(last.ms);
          }
          row.engines[engine] = {
            ms: summary(times),
            exit: last.code,
            outputLines: last.stdout.split("\n").filter((line) => line.length > 0).length,
          };
        }
        // Parity preview (gate G3): tgrep must agree with rg on sorted output and exit code.
        const tgrepOut = await run(binaries.tgrep, [...spec.flags, "--", spec.pattern, "."], {
          cwd: corpus.root,
          timeoutMs: 60_000,
        });
        const rgOut = await run(binaries.rg, [...spec.flags, spec.pattern, "."], {
          cwd: corpus.root,
          timeoutMs: 60_000,
        });
        row.parity = {
          tgrepVsRgOutputEqual: normalizeOutput(tgrepOut.stdout) === normalizeOutput(rgOut.stdout),
          tgrepVsRgExitEqual: tgrepOut.code === rgOut.code,
          tgrepExit: tgrepOut.code,
          rgExit: rgOut.code,
        };
        results.queries.push(row);
        console.log(
          `[benchmark] ${spec.id}: tgrep=${row.engines.tgrep.ms.median}ms rg=${row.engines.rg.ms.median}ms ugrep=${row.engines.ugrep.ms.median}ms parity=${row.parity.tgrepVsRgOutputEqual && row.parity.tgrepVsRgExitEqual}`,
        );
      }

      // Edit-cycle scenario: search after every edit, the agent's dominant loop.
      const cycles = 15;
      const editTargetRelative = "anchors/edit-target.ts";
      const editTarget = join(corpus.root, editTargetRelative);
      const original = await readFile(editTarget, "utf8");
      const cycleResults = { tgrep: [], rg: [] };
      try {
        for (let i = 0; i < cycles; i += 1) {
          const marker = `cyclemarker_${Date.now()}_${i}_cy`;
          await writeFile(editTarget, `${original}${marker}\n`);
          let t0 = performance.now();
          const refresh = await refreshView(binaries.tgrep, corpus.root, "spike-bench", [
            editTargetRelative,
          ]);
          const found = await run(binaries.tgrep, ["-F", "--", marker, "."], {
            cwd: corpus.root,
            timeoutMs: 60_000,
          });
          const tgrepCycleMs = Math.round(performance.now() - t0);
          t0 = performance.now();
          const rgFound = await run(binaries.rg, ["-F", marker, "."], {
            cwd: corpus.root,
            timeoutMs: 60_000,
          });
          const rgCycleMs = Math.round(performance.now() - t0);
          if (!refresh.ok || found.code !== 0 || rgFound.code !== 0) {
            throw new Error(
              `edit-cycle ${i} lost the marker (refresh=${refresh.ok} tgrep=${found.code} rg=${rgFound.code})`,
            );
          }
          cycleResults.tgrep.push(tgrepCycleMs);
          cycleResults.rg.push(rgCycleMs);
        }
      } finally {
        await writeFile(editTarget, original);
        await refreshView(binaries.tgrep, corpus.root, "spike-bench", [editTargetRelative]);
      }
      results.editCycle = {
        cycles,
        tgrepRefreshPlusQueryMs: summary(cycleResults.tgrep),
        rgQueryMs: summary(cycleResults.rg),
      };
      await daemon.flushLog();
    } finally {
      await run(binaries.tgrep, ["shared", "detach", corpus.root, "--lease", "spike-bench"]);
      await daemon.stop();
    }
  } finally {
    if (!keep) await rm(workRoot, { recursive: true, force: true });
  }

  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `benchmark-${process.platform}-${process.arch}.json`);
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[benchmark] wrote ${outFile}`);
  const parityFailures = results.queries.filter(
    (row) => !row.parity.tgrepVsRgOutputEqual || !row.parity.tgrepVsRgExitEqual,
  );
  if (parityFailures.length > 0) {
    console.log(`[benchmark] PARITY MISMATCH: ${parityFailures.map((row) => row.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[benchmark] fatal: ${error.stack}`);
  process.exitCode = 1;
});
