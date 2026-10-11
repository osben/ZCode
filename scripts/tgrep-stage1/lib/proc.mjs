// Shared process helpers for the tgrep stage-1 spike runners.

import { execFileSync, spawn } from "node:child_process";
import { appendFile, rm } from "node:fs/promises";

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summary(values) {
  if (values.length === 0) return { count: 0 };
  return {
    count: values.length,
    min: Math.round(Math.min(...values)),
    median: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(Math.max(...values)),
  };
}

export function run(bin, binArgs, { cwd, timeoutMs = 20_000 } = {}) {
  const start = performance.now();
  return new Promise((resolveRun) => {
    const child = spawn(bin, binArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({
        code: -1,
        stdout,
        stderr: `${stderr}${error.message}`,
        ms: Math.round(performance.now() - start),
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        code: code ?? -1,
        stdout,
        stderr,
        ms: Math.round(performance.now() - start),
        timedOut,
      });
    });
  });
}

// Shared daemons print "listening on 127.0.0.1:<port>"; ordinary servers print
// "serve ready ... TCP on port <port>". Both announce the loopback endpoint.
const READY_LINE_PATTERN = /listening on 127\.0\.0\.1:\d+|TCP on port \d+/;

export async function startDaemon(tgrep, daemonArgs, logPath) {
  await rm(logPath, { force: true });
  const child = spawn(tgrep, daemonArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (READY_LINE_PATTERN.test(log)) break;
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early (${child.exitCode}): ${log}`);
    }
    await sleep(50);
  }
  if (!READY_LINE_PATTERN.test(log)) {
    child.kill("SIGKILL");
    throw new Error(`daemon did not announce listening: ${log}`);
  }
  return {
    child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveStop) => child.on("close", resolveStop)),
        sleep(5000).then(() => child.kill("SIGKILL")),
      ]);
    },
    async flushLog() {
      await appendFile(logPath, log);
      return log;
    },
  };
}

export async function statusJson(tgrep, root) {
  const result = await run(tgrep, ["status", "--json", root], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`status failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function waitUntil(predicate, timeoutMs, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return false;
}

export async function attachView(tgrep, root, revision, lease) {
  const result = await run(
    tgrep,
    ["shared", "attach", root, "--revision", revision, "--lease", lease],
    {
      timeoutMs: 120_000,
    },
  );
  if (result.code !== 0) throw new Error(`attach failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function refreshView(tgrep, root, lease, changed) {
  const cliArgs = ["shared", "refresh", root, "--lease", lease];
  for (const path of changed) cliArgs.push("--changed", path);
  const result = await run(tgrep, cliArgs, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    return { ok: false, stderr: result.stderr, ms: result.ms };
  }
  return { ok: true, payload: JSON.parse(result.stdout), ms: result.ms };
}

export function daemonRssKb(pid) {
  try {
    return Number(
      execFileSync("ps", ["-p", String(pid), "-o", "rss="])
        .toString()
        .trim(),
    );
  } catch {
    return null;
  }
}

export function dirSizeBytes(path) {
  try {
    return Number(execFileSync("du", ["-sk", path]).toString().split(/\s+/)[0]) * 1024;
  } catch {
    return null;
  }
}
