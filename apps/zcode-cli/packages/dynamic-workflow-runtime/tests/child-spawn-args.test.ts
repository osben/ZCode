/**
 * The **spawn strategy** contract for the sandbox child process (`RunWorkflowOptions.childSpawn`).
 *
 * After the 2026-09-09 addendum (docs/dynamic-workflow/launch.md), the payload no longer goes through the command line: the harness first
 * writes the entry file to `<cwd>/.zcode/workflow-runs/<runId>.mjs`, and argv is left with only the path.
 *   - Default strategy: `node --max-old-space-size=… <entry>` (no `--input-type` / `--eval`);
 *   - SEA (bug root cause in the same spec's "SEA subcommand"): a SEA single-file binary **does not interpret Node CLI flags**,
 *     so the harness allows the caller (bootstrap, only under SEA) to switch to `childSpawn.argsPrefix`:
 *     `execPath [...argsPrefix, <entry>]`, zero flags.
 *
 * Both assertion directions are indispensable:
 *   - The default branch's argv shape (flags, entry path, `ELECTRON_RUN_AS_NODE`) must be pinned, otherwise the SEA fix would
 *     casually regress the existing fix for the desktop Electron helper;
 *   - The argsPrefix branch must **really complete a run**; asserting only the argv shape proves we concatenated the string correctly
 *     but cannot prove the child-side shape of "import the entry file, call start" also holds. This uses a stand-in script for a SEA CLI
 *     (exactly what dwf-child-command.ts does) to run the real chain.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor } from "./helpers.js";

// Wrap the real spawn: only intercept args/options; the child starts as usual — bridging and settlement both take the real path.
const spawnCalls: Array<{ args: readonly string[]; options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({
      args: (args[1] ?? []) as readonly string[],
      options: (args[2] ?? {}) as Record<string, unknown>,
    });
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

const roots: string[] = [];

afterEach(async () => {
  spawnCalls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Run a real run (one ask, AutoDriver replies "hi"), returning the settlement and the run cwd. */
async function runOnce(extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {}) {
  const cwd = await tempRoot("dwf-spawn-args-cwd-");
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });
  const settlement = await runWorkflowScript({
    scriptText: SCRIPT,
    runId: "run",
    cwd,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(SCRIPT),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
    ...extra,
  });
  return { settlement, cwd };
}

/** Extract the embedded payload from the entry file's text (do not import it: importing would run its top-level logic in the test process). */
async function readEntryPayload(entryPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(entryPath, "utf8");
  const match = /^export const payload = (.*);$/m.exec(text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

/**
 * Write a stand-in for a SEA CLI: it is the minimal form of `dwf-child-command.ts` — import the entry file and
 * call `start` with real deps injected. Crucially it **accepts no Node flags at all**, recognizing only the path at the end of argv — exactly a SEA binary's behavior.
 */
async function writeSeaCliStandIn(): Promise<string> {
  const root = await tempRoot("dwf-sea-standin-");
  const scriptPath = join(root, "sea-cli-stand-in.mjs");
  await writeFile(
    scriptPath,
    `import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";

// Strictly simulate a SEA main program: other than the entry path at the end of argv, any extra token is an error.
if (process.argv.length !== 3) {
  process.stderr.write("sea-cli-stand-in: unexpected argv " + JSON.stringify(process.argv.slice(2)) + "\\n");
  process.exit(1);
}

const entry = await import(pathToFileURL(process.argv[2]).href);
await entry.start({
  vm: { createContext, runInContext },
  createInterface,
  stdin: process.stdin,
  stdout: process.stdout,
});
`,
    "utf8",
  );
  return scriptPath;
}

describe("sandbox child spawn strategy", () => {
  it("spawns only the heap flag and the entry path when childSpawn is absent", async () => {
    const { settlement, cwd } = await runOnce();

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;

    // Only the flag and the path are on the command line — neither the payload nor the child source lives here (Windows 32,767-character limit).
    expect(args).toEqual(["--max-old-space-size=256", join(cwd, ".zcode", "workflow-runs", "run.mjs")]);
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({ lowered: expect.any(String) });
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spawnCalls[0]!.options.cwd).toBe(cwd);
  });

  it("keeps host-only run metadata out of the child payload (launch stays host-side)", async () => {
    // Only `args` crosses the boundary — the sandbox script reads it. All other run metadata (lineage pointer, tool call id, parent session,
    // display name, and the whole launch block: the initiating anchor and the subagent model) are host-side facts. Writing them into the entry
    // file would only give one run-level fact an extra copy that is never read, and that copy would also stay behind in the project's
    // .zcode directory along with the entry file. The `subagentModel` in launch especially: the model surface lives entirely host-side (the child
    // only relays asks back over the bridge); the child knowing which model it runs on is both useless and read by no code path.
    //
    // All five are genuinely passed in; otherwise "not in the payload" would be an empty claim.
    const { settlement, cwd } = await runOnce({
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
      resumedFrom: "run-predecessor",
      toolCallId: "call-origin",
      parentSessionId: "sess_parent",
      name: "nightly triage",
      args: { topic: "release" },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const payload = await readEntryPayload(join(cwd, ".zcode", "workflow-runs", "run.mjs"));
    // The one that does cross the boundary is still there: this assertion keeps "none of them crossed" from being faked with an empty payload.
    expect(payload.args).toEqual({ topic: "release" });
    for (const field of ["launch", "resumedFrom", "toolCallId", "parentSessionId", "name"]) {
      expect(field in payload).toBe(false);
    }
  });

  it("maps maxOldSpaceSizeMb onto the node flag on the default path", async () => {
    await runOnce({ maxOldSpaceSizeMb: 512 });

    expect(spawnCalls[0]!.args[0]).toBe("--max-old-space-size=512");
  });

  it("spawns argsPrefix + entry path with zero node flags, and the run still settles", async () => {
    const standIn = await writeSeaCliStandIn();

    const { settlement, cwd } = await runOnce({ childSpawn: { argsPrefix: [standIn] } });

    // Completing the real chain is this branch's claim: argv is assembled correctly and the child-side shape of "import the entry, call start" also holds.
    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toEqual([standIn, join(cwd, ".zcode", "workflow-runs", "run.mjs")]);
    // Not a single flag may leak out — a SEA main program would treat them as unknown arguments and exit with an error.
    expect(args.some((arg) => arg.startsWith("--"))).toBe(false);
    // The heap cap can only travel with the payload (the argsPrefix path has no flags to pass) and is applied best-effort by the entry file.
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({ maxOldSpaceSizeMb: 256 });
    // The Electron helper's existing fix holds on both branches.
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("forwards every argsPrefix token in order, entry path last", async () => {
    const standIn = await writeSeaCliStandIn();

    // The stand-in script only accepts argv.length === 3, so one extra token necessarily makes it report its own failure — which proves
    // "the prefix is forwarded verbatim, the entry path last" does not hold by coincidence.
    const { settlement } = await runOnce({
      childSpawn: { argsPrefix: [standIn, "__zcode-dwf-child"] },
      timeoutMs: 20000,
    });

    // The child exits non-zero with no complete: a host-side fault, stopped(interrupted).
    expect(settlement).toMatchObject({ status: "stopped", reason: "interrupted" });
    expect(spawnCalls[0]!.args).toEqual([
      standIn,
      "__zcode-dwf-child",
      expect.stringMatching(/run\.mjs$/),
    ]);
  });
});
