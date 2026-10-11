#!/usr/bin/env node
/* eslint-disable max-lines -- One self-contained freshness suite per plan gate D09: the S1-S4/O1-O2 scenarios share a daemon lifecycle that splitting across files would hide. */
// Stage-1 freshness spike for pinned tgrep 1.1.0 (plan gate D09 / G1 evidence).
//
// What it proves or refutes, per test id:
//   O1  ordinary `serve` (default auto watch): immediate read-after-write miss rate + delay
//   O2  ordinary `serve --no-watch`: index goes permanently stale (control)
//   S1  shared daemon `--no-watch` + `shared refresh --changed`: acknowledged read-after-write
//       for new files, modified files, and deletions, plus stale-false-positive check
//   S1M multi-path `--changed` acknowledgement support probe
//   S2  same-size/restored-mtime edit: `--no-watch` keeps false-ready; only `refresh --full` recovers
//   S3  shared daemon with native watch: external writes close readiness; queries stay correct
//   S4  linked-worktree isolation: one daemon, two views, no cross-view leakage
//
// Usage: node scripts/tgrep-stage1/run-freshness.mjs --out <dir> [--files N] [--iterations N] [--keep]

import { execFileSync } from "node:child_process";
import { existsSync, statSync, utimesSync } from "node:fs";
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
const corpusFiles = Number(readFlag("--files", 6000));
const iterations = Number(readFlag("--iterations", 25));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
  throw new Error(`repository root not found at ${repoRoot}`);
}

async function search(tgrep, pattern, cwd, extraArgs = []) {
  return run(tgrep, [...extraArgs, "--", pattern, "."], { cwd, timeoutMs: 30_000 });
}

const results = {
  meta: {
    startedAt: new Date().toISOString(),
    corpusFiles,
    iterations,
    seed: CORPUS_DEFAULT_SEED,
    host: { platform: process.platform, arch: process.arch, node: process.version },
  },
  tests: [],
};

function recordTest(test) {
  results.tests.push(test);
  console.log(`[freshness] ${test.id} verdict=${test.verdict ?? "info"}`);
}

async function main() {
  const tools = await resolveSpikeTools({ repoRoot });
  const tgrep = tools.binaries.tgrep;
  results.meta.tools = tools.evidence;
  const workRoot = await mkdtemp(join(tmpdir(), "zcode-tgrep-freshness-"));
  console.log(`[freshness] workdir ${workRoot}`);

  try {
    const sharedCorpus = await generateCorpus({
      root: join(workRoot, "corpus-shared"),
      files: corpusFiles,
    });
    const ordinaryCorpus = await generateCorpus({
      root: join(workRoot, "corpus-ordinary"),
      files: corpusFiles,
    });
    results.meta.corpus = { files: sharedCorpus.files, bytes: sharedCorpus.bytes };

    // --- Shared daemon, watch disabled: S1, S1M, S2, S4 ---
    const storage = join(workRoot, "shared-storage");
    await mkdir(storage, { recursive: true });
    const sharedDaemon = await startDaemon(
      tgrep,
      ["serve", "--shared", sharedCorpus.root, "--shared-storage", storage, "--no-watch"],
      join(workRoot, "daemon-shared.log"),
    );
    try {
      const attachStarted = performance.now();
      await attachView(tgrep, sharedCorpus.root, sharedCorpus.revision, "spike-s1");
      const initialReady = await waitUntil(
        async () => (await statusJson(tgrep, sharedCorpus.root)).ready === true,
        180_000,
      );
      if (!initialReady) throw new Error("shared view never became ready");
      const attachToReadyMs = Math.round(performance.now() - attachStarted);

      // S1: new uncommitted file, acknowledged refresh, immediate visibility.
      const s1 = {
        id: "S1_shared_no_watch_acknowledged_read_after_write",
        iterations: [],
        failures: 0,
      };
      for (let i = 0; i < iterations; i += 1) {
        const marker = `s1marker_${Date.now()}_${i}_xzq`;
        const relative = `zz-s1-${i}.txt`;
        await writeFile(join(sharedCorpus.root, relative), `${marker}\n`);
        const immediate = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
        const refresh = await refreshView(tgrep, sharedCorpus.root, "spike-s1", [relative]);
        const afterRefresh = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
        const ackEpoch = refresh.ok ? refresh.payload.processed_epoch : null;
        const ok =
          immediate.code === 1 &&
          refresh.ok &&
          typeof ackEpoch === "number" &&
          refresh.payload.ready === true &&
          afterRefresh.code === 0 &&
          afterRefresh.stdout.includes(relative);
        if (!ok) s1.failures += 1;
        s1.iterations.push({
          i,
          immediateHit: immediate.code === 0,
          refreshOk: refresh.ok,
          refreshMs: refresh.ms,
          processedEpoch: ackEpoch,
          ready: refresh.ok ? refresh.payload.ready : null,
          visibleAfterAck: afterRefresh.code === 0,
          ok,
        });
      }
      s1.verdict = s1.failures === 0 ? "pass" : "fail";
      s1.summary = {
        failures: s1.failures,
        immediateMissesWithoutRefresh: s1.iterations.filter((row) => !row.immediateHit).length,
        refreshMs: summary(s1.iterations.map((row) => row.refreshMs)),
      };

      // S1b: modify a committed file; acknowledged adds must appear and acknowledged removals
      // must disappear (no stale false positives from the pre-refresh generation).
      const s1b = { id: "S1b_shared_modify_semantics", steps: [], failures: 0 };
      const targetRelative = "anchors/edit-target.ts";
      const targetAbs = join(sharedCorpus.root, targetRelative);
      const original = await readFile(targetAbs, "utf8");
      try {
        for (let i = 0; i < iterations; i += 1) {
          const marker = `s1bmarker_${Date.now()}_${i}_kq7`;
          await writeFile(targetAbs, `${original}${marker}\n`);
          const refreshAdd = await refreshView(tgrep, sharedCorpus.root, "spike-s1", [
            targetRelative,
          ]);
          const found = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
          const stripped = original
            .split("\n")
            .filter((line) => !line.includes("spike_") && !line.includes("function path helper"))
            .join("\n");
          await writeFile(targetAbs, stripped);
          const refreshStrip = await refreshView(tgrep, sharedCorpus.root, "spike-s1", [
            targetRelative,
          ]);
          const staleFunction = await search(tgrep, "function path helper", sharedCorpus.root, [
            "-F",
          ]);
          const stillListed = staleFunction.stdout.includes(targetRelative);
          const ok =
            refreshAdd.ok &&
            found.code === 0 &&
            found.stdout.includes(targetRelative) &&
            refreshStrip.ok &&
            !stillListed;
          if (!ok) s1b.failures += 1;
          s1b.steps.push({
            i,
            addAcked: refreshAdd.ok,
            foundAfterAck: found.code === 0,
            staleFalsePositive: stillListed,
            ok,
          });
        }
      } finally {
        await writeFile(targetAbs, original);
        await refreshView(tgrep, sharedCorpus.root, "spike-s1", [targetRelative]);
      }
      s1b.verdict = s1b.failures === 0 ? "pass" : "fail";
      s1b.summary = { failures: s1b.failures };

      // S1c: delete an acknowledged uncommitted file.
      const s1c = { id: "S1c_shared_delete_acknowledged", failures: 0, steps: [] };
      for (let i = 0; i < Math.min(5, iterations); i += 1) {
        const marker = `s1cmarker_${Date.now()}_${i}_vw9`;
        const relative = `zz-s1c-${i}.txt`;
        await writeFile(join(sharedCorpus.root, relative), `${marker}\n`);
        await refreshView(tgrep, sharedCorpus.root, "spike-s1", [relative]);
        await rm(join(sharedCorpus.root, relative));
        const refresh = await refreshView(tgrep, sharedCorpus.root, "spike-s1", [relative]);
        const afterDelete = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
        const ok = refresh.ok && refresh.payload.ready === true && afterDelete.code === 1;
        if (!ok) s1c.failures += 1;
        s1c.steps.push({ i, refreshOk: refresh.ok, missAfterDelete: afterDelete.code === 1, ok });
      }
      s1c.verdict = s1c.failures === 0 ? "pass" : "fail";
      s1c.summary = { failures: s1c.failures };

      // S1M: multi-path --changed support probe.
      const s1m = { id: "S1M_shared_multi_changed_probe" };
      const relA = "zz-s1m-a.txt";
      const relB = "zz-s1m-b.txt";
      await writeFile(join(sharedCorpus.root, relA), "s1mmarker_a_qq1\n");
      await writeFile(join(sharedCorpus.root, relB), "s1mmarker_b_qq2\n");
      const multi = await refreshView(tgrep, sharedCorpus.root, "spike-s1", [relA, relB]);
      const foundA = await search(tgrep, "s1mmarker_a_qq1", sharedCorpus.root, ["-F"]);
      const foundB = await search(tgrep, "s1mmarker_b_qq2", sharedCorpus.root, ["-F"]);
      s1m.supported = multi.ok;
      s1m.bothVisible = foundA.code === 0 && foundB.code === 0;
      if (!multi.ok) s1m.stderr = multi.stderr.slice(0, 400);
      s1m.verdict = s1m.supported && s1m.bothVisible ? "pass" : "unsupported";

      // S2: same-size edit with restored mtime stays invisible until refresh --full.
      const s2 = { id: "S2_shared_sneaky_edit_requires_full_refresh", steps: [], failures: 0 };
      const sneakyRelative = "anchors/sneaky-target.ts";
      const sneakyAbs = join(sharedCorpus.root, sneakyRelative);
      const sneakyOriginal = await readFile(sneakyAbs, "utf8");
      try {
        for (let i = 0; i < 3; i += 1) {
          const stats = statSync(sneakyAbs);
          const replaced = sneakyOriginal.replace("value_", "valux_");
          await writeFile(sneakyAbs, Buffer.from(replaced, "utf8"));
          utimesSync(sneakyAbs, stats.atime, stats.mtime);
          const statusBefore = await statusJson(tgrep, sharedCorpus.root);
          const staleQuery = await search(tgrep, "valux_", sharedCorpus.root, ["-F"]);
          const fullStarted = performance.now();
          const full = await run(
            tgrep,
            ["shared", "refresh", sharedCorpus.root, "--lease", "spike-s1", "--full"],
            { timeoutMs: 180_000 },
          );
          const fullMs = Math.round(performance.now() - fullStarted);
          const afterFull = await search(tgrep, "valux_", sharedCorpus.root, ["-F"]);
          const ok =
            statusBefore.ready === true &&
            staleQuery.code === 1 &&
            !staleQuery.stdout.includes(sneakyRelative) &&
            full.code === 0 &&
            afterFull.stdout.includes(sneakyRelative);
          if (!ok) s2.failures += 1;
          s2.steps.push({
            i,
            readyStayedTrue: statusBefore.ready === true,
            staleExit: staleQuery.code,
            staleBeforeFull: !staleQuery.stdout.includes(sneakyRelative),
            fullMs,
            visibleAfterFull: afterFull.stdout.includes(sneakyRelative),
            ok,
          });
          await writeFile(sneakyAbs, sneakyOriginal);
          await refreshView(tgrep, sharedCorpus.root, "spike-s1", [sneakyRelative]);
        }
      } finally {
        await writeFile(sneakyAbs, sneakyOriginal);
        await refreshView(tgrep, sharedCorpus.root, "spike-s1", [sneakyRelative]);
      }
      s2.verdict = s2.failures === 0 ? "pass" : "fail";
      s2.summary = {
        failures: s2.failures,
        fullRefreshMs: summary(s2.steps.map((step) => step.fullMs)),
      };

      // S4: linked worktree isolation on the same daemon.
      const s4 = { id: "S4_shared_worktree_isolation" };
      const wtB = join(workRoot, "corpus-shared-wt-b");
      execFileSync("git", ["worktree", "add", "--quiet", wtB], { cwd: sharedCorpus.root });
      try {
        await attachView(tgrep, wtB, sharedCorpus.revision, "spike-s4-b");
        await waitUntil(async () => (await statusJson(tgrep, wtB)).ready === true, 180_000);
        const marker = `s4marker_${Date.now()}_mk3`;
        const relative = "zz-s4.txt";
        await writeFile(join(sharedCorpus.root, relative), `${marker}\n`);
        await refreshView(tgrep, sharedCorpus.root, "spike-s1", [relative]);
        const inA = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
        const leaked = await search(tgrep, marker, wtB, ["-F"]);
        await run(tgrep, ["shared", "refresh", wtB, "--lease", "spike-s4-b", "--full"], {
          timeoutMs: 180_000,
        });
        const leakedAfterFull = await search(tgrep, marker, wtB, ["-F"]);
        s4.visibleInA = inA.code === 0;
        s4.leakedIntoB = leaked.code === 0 || leakedAfterFull.code === 0;
        s4.verdict = s4.visibleInA && !s4.leakedIntoB ? "pass" : "fail";
      } finally {
        await run(tgrep, ["shared", "detach", wtB, "--lease", "spike-s4-b"]);
        execFileSync("git", ["worktree", "remove", "--force", wtB], { cwd: sharedCorpus.root });
      }

      recordTest({
        id: "S0_shared_attach_build",
        attachToReadyMs,
        storageBytes: dirSizeBytes(storage),
        daemonRssKb: daemonRssKb(sharedDaemon.child.pid),
      });
      for (const test of [s1, s1b, s1c, s1m, s2, s4]) recordTest(test);
      await sharedDaemon.flushLog();
    } finally {
      await run(tgrep, ["shared", "detach", sharedCorpus.root, "--lease", "spike-s1"]);
      await sharedDaemon.stop();
    }

    // --- S3: shared daemon with native watch; external writes close readiness ---
    const storageWatch = join(workRoot, "shared-storage-watch");
    await mkdir(storageWatch, { recursive: true });
    const watchDaemon = await startDaemon(
      tgrep,
      ["serve", "--shared", sharedCorpus.root, "--shared-storage", storageWatch],
      join(workRoot, "daemon-watch.log"),
    );
    try {
      await attachView(tgrep, sharedCorpus.root, sharedCorpus.revision, "spike-s3");
      await waitUntil(
        async () => (await statusJson(tgrep, sharedCorpus.root)).ready === true,
        180_000,
      );
      const s3 = { id: "S3_shared_native_watch_external_write" };
      const marker = `s3marker_${Date.now()}_nw8`;
      const externalStarted = Date.now();
      await writeFile(join(sharedCorpus.root, "zz-s3-external.txt"), `${marker}\n`);
      let readinessClosedMs = null;
      const closed = await waitUntil(
        async () => (await statusJson(tgrep, sharedCorpus.root)).ready === false,
        10_000,
      );
      if (closed) readinessClosedMs = Date.now() - externalStarted;
      const queryWhileNotReady = closed
        ? await search(tgrep, marker, sharedCorpus.root, ["-F"])
        : { code: -1, stdout: "", stderr: "readiness never closed", ms: -1 };
      let reopenedMs = null;
      const reopened = await waitUntil(
        async () => (await statusJson(tgrep, sharedCorpus.root)).ready === true,
        120_000,
      );
      if (reopened) reopenedMs = Date.now() - externalStarted;
      const afterReopen = await search(tgrep, marker, sharedCorpus.root, ["-F"]);
      s3.readinessClosedMs = readinessClosedMs;
      s3.queryWhileNotReadyExit = queryWhileNotReady.code;
      s3.foundWhileNotReady = queryWhileNotReady.code === 0;
      s3.readinessReopenedMs = reopenedMs;
      s3.visibleAfterReopen = afterReopen.code === 0;
      // The README claims queries stay correct while readiness is closed, so the scan
      // fallback finding the marker is part of the machine-checked verdict.
      s3.verdict =
        readinessClosedMs !== null &&
        reopenedMs !== null &&
        queryWhileNotReady.code === 0 &&
        afterReopen.code === 0
          ? "pass"
          : "fail";
      recordTest(s3);
      await run(tgrep, ["shared", "detach", sharedCorpus.root, "--lease", "spike-s3"]);
    } finally {
      await watchDaemon.stop();
    }

    // --- O1/O2: ordinary server on a separate corpus ---
    const ordinaryDaemon = await startDaemon(
      tgrep,
      ["serve", ordinaryCorpus.root],
      join(workRoot, "daemon-ordinary.log"),
    );
    try {
      const indexed = await waitUntil(async () => {
        const probe = await search(tgrep, "spike_rare_token_42", ordinaryCorpus.root, ["-F"]);
        return probe.code === 0;
      }, 240_000);
      if (!indexed) throw new Error("ordinary server never served the rare base token");

      const o1 = { id: "O1_ordinary_auto_watch_read_after_write", iterations: [] };
      for (let i = 0; i < iterations; i += 1) {
        const marker = `o1marker_${Date.now()}_${i}_pl4`;
        const writeStarted = Date.now();
        await writeFile(join(ordinaryCorpus.root, `zz-o1-${i}.txt`), `${marker}\n`);
        const immediate = await search(tgrep, marker, ordinaryCorpus.root, ["-F"]);
        let visibleDelayMs = immediate.code === 0 ? 0 : null;
        if (immediate.code !== 0) {
          const visible = await waitUntil(
            async () => (await search(tgrep, marker, ordinaryCorpus.root, ["-F"])).code === 0,
            5_000,
            10,
          );
          if (visible) visibleDelayMs = Date.now() - writeStarted;
        }
        o1.iterations.push({ i, immediateHit: immediate.code === 0, visibleDelayMs });
      }
      const delays = o1.iterations
        .filter((row) => row.visibleDelayMs !== null)
        .map((row) => row.visibleDelayMs);
      o1.summary = {
        iterations: o1.iterations.length,
        immediateMisses: o1.iterations.filter((row) => !row.immediateHit).length,
        visibleDelayMs: summary(delays),
        neverVisible: o1.iterations.filter(
          (row) => !row.immediateHit && row.visibleDelayMs === null,
        ).length,
      };
      recordTest(o1);
    } finally {
      await ordinaryDaemon.stop();
    }

    const noWatchDaemon = await startDaemon(
      tgrep,
      ["serve", ordinaryCorpus.root, "--no-watch"],
      join(workRoot, "daemon-ordinary-nowatch.log"),
    );
    try {
      await waitUntil(async () => {
        const probe = await search(tgrep, "spike_rare_token_42", ordinaryCorpus.root, ["-F"]);
        return probe.code === 0;
      }, 240_000);
      const o2 = { id: "O2_ordinary_no_watch_stays_stale", probes: [] };
      for (let i = 0; i < 3; i += 1) {
        const marker = `o2marker_${Date.now()}_${i}_rf6`;
        await writeFile(join(ordinaryCorpus.root, `zz-o2-${i}.txt`), `${marker}\n`);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
        const query = await search(tgrep, marker, ordinaryCorpus.root, ["-F"]);
        o2.probes.push({ i, missAfter500ms: query.code === 1 });
      }
      o2.staysStale = o2.probes.every((probe) => probe.missAfter500ms);
      o2.verdict = o2.staysStale ? "confirmed-stale" : "unexpected-fresh";
      recordTest(o2);
    } finally {
      await noWatchDaemon.stop();
    }

    const sharedAckIds = [
      "S1_shared_no_watch_acknowledged_read_after_write",
      "S1b_shared_modify_semantics",
      "S1c_shared_delete_acknowledged",
    ];
    results.gates = {
      D09_shared_acknowledged_freshness: sharedAckIds.every(
        (id) => results.tests.find((test) => test.id === id)?.verdict === "pass",
      )
        ? "proven-on-pinned-build"
        : "failed",
      D09_ordinary_server_deterministic_freshness:
        "unavailable: ordinary serve exposes no explicit refresh acknowledgement command",
    };
  } finally {
    if (!keep) await rm(workRoot, { recursive: true, force: true });
  }

  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `freshness-${process.platform}-${process.arch}.json`);
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[freshness] wrote ${outFile}`);
  const failing = results.tests.filter((test) => test.verdict === "fail");
  if (failing.length > 0) {
    console.log(`[freshness] FAILING: ${failing.map((test) => test.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[freshness] fatal: ${error.stack}`);
  process.exitCode = 1;
});
