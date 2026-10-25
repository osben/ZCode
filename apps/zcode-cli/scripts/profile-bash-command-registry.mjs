// Build dependencies first: pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter=@zcode/cli...
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { build } from "esbuild";
import {
  createZodDedupePlugin,
  readZodBuildVersion,
  resolveBuildAliases,
  resolveBuildExternal,
} from "../packages/cli/scripts/build.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string", default: "origin/integration" },
    samples: { type: "string", default: "40" },
    output: { type: "string" },
    minify: { type: "boolean", default: false },
    "controlled-shell": { type: "boolean", default: false },
  },
});
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 20) throw new Error("Use at least 20 samples.");
if (values["controlled-shell"] && process.platform === "win32") {
  throw new Error("The controlled Bash wrapper requires a POSIX host.");
}
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const directory = values.output
  ? resolve(values.output)
  : await mkdtemp(join(tmpdir(), "zcode-registry-profile-"));
await mkdir(directory, { recursive: true });
const execute = promisify(execFile);
const registryPath =
  "apps/zcode-cli/packages/core/src/tool/handlers/generated/bash-command-registry.ts";
const { stdout: baseline } = await execute("git", ["show", `${values.baseline}:${registryPath}`], {
  cwd: repoRoot,
  maxBuffer: 4 * 1024 * 1024,
});
const candidate = await readFile(join(repoRoot, registryPath), "utf8");
const { stdout: baselineSha } = await execute("git", ["rev-parse", values.baseline], {
  cwd: repoRoot,
});
const controlledShell = join(directory, "bash");
if (values["controlled-shell"]) {
  await writeFile(controlledShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {
    mode: 0o755,
  });
}
const shellSelection = values["controlled-shell"]
  ? { path: controlledShell, dialect: "posix", source: "auto-detected", display: { name: "bash" } }
  : undefined;
const harness = `
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionAdapter } from ${JSON.stringify(join(appRoot, "packages/adapters/dist/exec/index.js"))};
import { bashHandler } from ${JSON.stringify(join(appRoot, "packages/core/dist/tool/handlers/bash.js"))};
import { createBashPermissionRulePolicy } from ${JSON.stringify(join(appRoot, "packages/core/dist/tool/handlers/bash-command-permission-policy.js"))};
async function main() {
  const readyHeapBytes = process.memoryUsage().heapUsed;
  const cwd = await mkdtemp(join(tmpdir(), 'zcode-bash-profile-'));
  const adapter = new NodeExecutionAdapter({ outputRootDir: cwd });
  const context = { toolCallId: 'bench', traceId: 'bench', spanId: 'bench',
    abortSignal: new AbortController().signal, executionPort: adapter,
    workingDirectory: cwd, workspaceRoot: cwd, runtimeScope: 'main',
    sessionId: 'bench', turnId: 'bench', bashShellSelection: ${JSON.stringify(shellSelection)} };
  try {
    const command = 'git --version';
    const start = performance.now();
    const policy = createBashPermissionRulePolicy(command);
    if (!policy.suggestedPermissionUpdates.length) throw new Error('Missing permission policy');
    const policyMs = performance.now() - start;
    const output = await bashHandler({ command }, context);
    if (output.exitCode !== 0 || !output.stdout.startsWith('git version ')) throw new Error('Bash failed');
    const firstBashMs = performance.now() - start;
    console.log(JSON.stringify({ policyMs, firstBashMs, readyHeapBytes, heapUsedBytes: process.memoryUsage().heapUsed }));
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
const expectedV4Version = await readZodBuildVersion();
for (const [variant, contents] of [
  ["baseline", baseline],
  ["candidate", candidate],
]) {
  for (const mode of ["cli", "bash"]) {
    const options = {
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      minify: values.minify,
      keepNames: values.minify,
      sourcemap: false,
      legalComments: "none",
      external: resolveBuildExternal(),
      alias: resolveBuildAliases(),
      plugins: [
        createZodDedupePlugin({ expectedV4Version }),
        {
          name: "registry-profile-variant",
          setup(builder) {
            builder.onLoad({ filter: /generated[/\\]bash-command-registry\.[jt]s$/ }, () => ({
              contents,
              loader: "ts",
            }));
          },
        },
      ],
      logLevel: "silent",
      metafile: true,
      absWorkingDir: repoRoot,
      outfile: join(directory, `${mode}-${variant}.cjs`),
    };
    if (mode === "cli") {
      await build({
        ...options,
        entryPoints: [join(appRoot, "packages/cli/src/main.ts")],
        define: { __CLI_VERSION__: '"registry-profile"' },
      });
    } else {
      await build({
        ...options,
        stdin: { contents: harness, resolveDir: repoRoot, sourcefile: "registry-profile.ts" },
      });
    }
  }
}
const measurements = {
  cli: { baseline: [], candidate: [] },
  bash: { baseline: [], candidate: [] },
};
for (let index = -3; index < samples; index++) {
  const variants = index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
  for (const variant of variants) {
    for (const mode of ["cli", "bash"]) {
      const start = performance.now();
      const child = spawnSync(
        process.execPath,
        [join(directory, `${mode}-${variant}.cjs`), ...(mode === "cli" ? ["--version"] : [])],
        {
          encoding: "utf8",
          timeout: 30_000,
          cwd: repoRoot,
          env: { ...process.env, ZCODE_DATA_BASE_DIR: directory },
        },
      );
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(child.stderr + child.stdout);
      const row = {
        wallMs: performance.now() - start,
        ...(mode === "bash" ? JSON.parse(child.stdout.trim()) : {}),
      };
      if (index >= 0) measurements[mode][variant].push(row);
    }
  }
  if ((index + 1) % 10 === 0) console.error(`Measured ${index + 1}/${samples} pairs`);
}
function summarize(rows) {
  return Object.fromEntries(
    Object.keys(rows[0]).map((key) => {
      const sorted = rows.map((row) => row[key]).sort((left, right) => left - right);
      return [
        key,
        {
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    }),
  );
}
const summary = Object.fromEntries(
  Object.entries(measurements).map(([mode, variants]) => [
    mode,
    Object.fromEntries(
      Object.entries(variants).map(([variant, rows]) => [variant, summarize(rows)]),
    ),
  ]),
);
const before = summary.cli.baseline.wallMs.median;
const after = summary.cli.candidate.wallMs.median;
const gate = {
  startupSavedMs: before - after,
  startupSavedPercent: ((before - after) / before) * 100,
  firstBashP95IncreaseMs:
    summary.bash.candidate.firstBashMs.p95 - summary.bash.baseline.firstBashMs.p95,
};
gate.passed =
  gate.startupSavedMs >= 10 && gate.startupSavedPercent >= 5 && gate.firstBashP95IncreaseMs <= 20;
const result = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  baseline: baselineSha.trim(),
  samples,
  minify: values.minify,
  controlledShell: values["controlled-shell"],
  summary,
  gate,
  measurements,
};
await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, measurements: undefined, directory }, null, 2));
