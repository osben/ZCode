import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";
import {
  FORK_RUST_HELPER_METHODS,
  FORK_RUST_HELPER_PROTOCOL_VERSION,
  runForkRustHelper,
} from "../../src/fork-rust-helper/contract.js";

// specs/fork-rust-workflow-engine.md, section 4.1 (as built, W4): the stateless compile and format
// methods the Rust agent calls over the helper link. The helper never touches storage for them.

interface Frame {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startHelper() {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-workflow-compile-"));
  dirs.push(cwd);
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<string, (frame: Frame) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (frame.id !== undefined && pending.has(String(frame.id))) {
      pending.get(String(frame.id))!(frame);
      pending.delete(String(frame.id));
    }
  });
  const done = runForkRustHelper({ input, output, env: process.env, cwd });
  let next = 0;
  return {
    done,
    request(method: string, params: unknown): Promise<Frame> {
      next += 1;
      const id = `wf-${next}`;
      const reply = new Promise<Frame>((resolve) => pending.set(id, resolve));
      input.write(`${JSON.stringify({ id, method, params })}\n`);
      return reply;
    },
    close() {
      input.end();
    },
  };
}

const VALID_SCRIPT = [
  'const reviewer = agent("reviewer");',
  'const answer = await reviewer.ask("Say hello.");',
  "return answer;",
].join("\n");

const BROKEN_SCRIPT = 'const count: number = "not a number";\nreturn count;';

describe("fork: helper/workflow/compile and helper/workflow/format (W4)", () => {
  it("advertises both methods in helper/initialize", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/initialize", {
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.methods).toEqual([...FORK_RUST_HELPER_METHODS]);
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/compile");
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/format");
    helper.close();
    await helper.done;
  });

  it("compiles a valid script: scriptHash is the SHA-256 of the author's text and the entry is rendered", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: VALID_SCRIPT,
      runId: "run-w4-1",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      scriptHash: string;
      compiled: Record<string, unknown>;
      entrySource: string;
    };
    expect(result.ok).toBe(true);
    expect(result.scriptHash).toBe(createHash("sha256").update(VALID_SCRIPT, "utf8").digest("hex"));
    // The lowered body travels inside entrySource only; the compile result carries the rest.
    expect(result.compiled).not.toHaveProperty("lowered");
    expect(Object.keys(result.compiled)).toEqual(
      expect.arrayContaining(["askSpecs", "actorSubmitProfiles", "sitePhases", "phases", "holes", "holeBodies", "scriptHash"]),
    );
    expect(result.entrySource).toContain('"id":"run-w4-1"');
    expect(result.entrySource).toContain("export const payload");
    helper.close();
    await helper.done;
  });

  it("passes resumedFrom into the run identity of the rendered entry", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: VALID_SCRIPT,
      runId: "run-w4-2",
      resumedFrom: "run-w4-0",
    });
    const result = reply.result as { ok: boolean; entrySource: string };
    expect(result.ok).toBe(true);
    expect(result.entrySource).toContain('"resumedFrom":"run-w4-0"');
    helper.close();
    await helper.done;
  });

  it("answers a script with type errors as ok false with positioned diagnostics and no entry", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: BROKEN_SCRIPT,
      runId: "run-w4-3",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      diagnostics: { code: number; line: number; column: number; message: string }[];
      entrySource?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({ line: expect.any(Number), column: expect.any(Number), message: expect.any(String) }),
    );
    expect(result.entrySource).toBeUndefined();
    helper.close();
    await helper.done;
  });

  it("refuses a compile without a runId as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", { scriptText: VALID_SCRIPT });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });

  it("formats the analysis of a script as the JSON of analyzeWorkflowScript", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", { kind: "analysis", scriptText: VALID_SCRIPT });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      analysis: JSON.parse(JSON.stringify(analyzeWorkflowScript(VALID_SCRIPT))),
    });
    helper.close();
    await helper.done;
  });

  it("refuses a format kind it does not serve as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", { kind: "runText", scriptText: VALID_SCRIPT });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });
});
