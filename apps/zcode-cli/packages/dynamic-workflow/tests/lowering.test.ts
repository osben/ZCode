import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_BINDING, lowerWorkflowScript } from "../src/lowering/index.js";

// Lowering snapshots + semantic assertions. The snapshots are the contract: human-readable lowered JS lands in expected/<base>.js.
// Semantic assertions go beyond the snapshots: site ids appear exactly once, types fully erased (proven by parsing the output as JS),
// no-facade scripts lower to plain JS, and determinism (two lowerings produce identical bytes).
const here = dirname(fileURLToPath(import.meta.url));
const loweringDir = join(here, "lowering");
const graphsDir = join(here, "graphs");

// AsyncFunction constructor: used to parse the lowered code as JS, proving no TS syntax remains
// (top-level await/return are both legal inside an async function body).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** The common invariants every lowered code must satisfy. */
function assertLowered(source: string): { code: string; siteIds: string[] } {
  const result = lowerWorkflowScript(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const lowered = result.lowered;
  if (lowered === undefined) throw new Error("expected lowered output for a clean script");
  return lowered;
}

/** Site id -> the __host.* call prefix it should be stubbed into (without quotes, agnostic to quote style). */
function hostCallFor(siteId: string): string {
  // Sites inside a hole body carry the `hole#N/` prefix (docs/analysis.md "Sites"): classify by the last segment.
  const kindStart = siteId.lastIndexOf("/") + 1;
  if (kindStart > 0) return hostCallFor(siteId.slice(kindStart));
  if (siteId.startsWith("ask#")) return "__host.ask(";
  if (siteId.startsWith("actor#")) return "__host.createActor(";
  if (siteId.startsWith("world-read#")) return "__host.worldRead(";
  if (siteId.startsWith("report#")) return "__host.report(";
  if (siteId.startsWith("hole#")) return "__host.hole(";
  throw new Error(`unexpected site id kind: ${siteId}`);
}

const SNAPSHOT_FIXTURES: { base: string; dir: string }[] = [
  { base: "log-only", dir: loweringDir },
  { base: "no-facade", dir: loweringDir },
  { base: "chained-inline-ask", dir: loweringDir },
  { base: "helper-asks", dir: loweringDir },
  { base: "files-read-glob", dir: loweringDir },
  { base: "git-and-grep", dir: loweringDir },
  { base: "report-and-log", dir: loweringDir },
  { base: "phase-markers", dir: loweringDir },
  { base: "channel-future", dir: loweringDir },
  { base: "holes", dir: loweringDir },
  // Reuse three graph fixtures: planner-reviewer covers log/ask/for loops/Promise.all,
  // glob-fanout covers files.glob + fan-out, and user-defined-ask is negative coverage — a user-defined
  // `.ask` method of the same name must be preserved verbatim; only the facade's agent().ask() is lowered.
  { base: "planner-reviewer", dir: graphsDir },
  { base: "glob-fanout", dir: graphsDir },
  { base: "user-defined-ask", dir: graphsDir },
];

describe("lowering snapshots", () => {
  for (const { base, dir } of SNAPSHOT_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(dir, `${base}.ts`), "utf8");
      const { code } = assertLowered(source);
      await expect(code).toMatchFileSnapshot(join(loweringDir, "expected", `${base}.js`));
    });
  }
});

// Breadth semantic assertions: run over all graph fixtures + lowering fixtures, proving each invariant one by one.
const semanticFixtures = [
  ...readdirSync(loweringDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: loweringDir, name: n })),
  ...readdirSync(graphsDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: graphsDir, name: n })),
].sort((a, b) => a.name.localeCompare(b.name));

describe("lowering semantics", () => {
  it("finds fixtures", () => {
    expect(semanticFixtures.length).toBeGreaterThan(0);
  });

  for (const { dir, name } of semanticFixtures) {
    it(`${name}: every site id appears exactly once in the right __host.* call`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code, siteIds } = assertLowered(source);
      // After dedup, siteIds == the original list (each site is unique).
      expect(new Set(siteIds).size).toBe(siteIds.length);
      for (const id of siteIds) {
        const quoted = new RegExp(`["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g");
        const hits = code.match(quoted) ?? [];
        expect(hits.length, `site id ${id} must appear exactly once`).toBe(1);
        expect(code, `site id ${id} must sit in ${hostCallFor(id)}`).toContain(
          `${hostCallFor(id)}"${id}"`,
        );
      }
    });

    it(`${name}: lowers to type-stripped JS (parses as JS, no facade globals)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code } = assertLowered(source);
      // Parse the output as JS: TS syntax (interfaces / type annotations / <T> type arguments) would make AsyncFunction throw.
      expect(() => new AsyncFunction(HOST_BINDING, code)).not.toThrow();
      expect(code).not.toContain("interface ");
      expect(code).not.toContain("__host.ask<");
      // Facade global names must not survive as free identifiers — all rewritten to __host.* (phase rewritten to enterPhase).
      expect(code).not.toMatch(/(^|[^.\w])files\.(glob|read|grep)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])git\.(changedFiles|diff|status|log)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
      // channel / future are likewise rewritten to __host.* (docs/dynamic-workflow/authoring.md "Streams").
      expect(code).not.toMatch(/(^|[^.\w])(channel|future)\s*\(/);
      // Holes are rewritten to __host.hole (docs/dynamic-workflow/authoring.md "Holes").
      expect(code).not.toMatch(/(^|[^.\w])hole\s*[(<]/);
    });

    it(`${name}: is deterministic (lowering twice yields identical bytes)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const a = assertLowered(source);
      const b = assertLowered(source);
      expect(a.code).toBe(b.code);
      expect(a.siteIds).toEqual(b.siteIds);
    });
  }
});

describe("lowering edge cases", () => {
  it("packs world-read arguments positionally into an array literal", () => {
    // Boundary A's `worldRead(siteId, op, args)`: arguments go into an **array literal**, positional, without
    // interpretation (the spec's "lowering never switches on op"). This is the contract of "adding a world-read
    // primitive requires zero changes in lowering" — multi-arg ops (files.grep / git.diff) take exactly this path.
    const source = readFileSync(join(loweringDir, "files-read-glob.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["src/**/*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "read", [first])`);
  });

  it("packs multi-argument and optional world-read arguments positionally", () => {
    // A missing optional argument is simply a **shorter array**, not an undefined hole: `inputHash({op, args})` is
    // the journal key, and `["TODO"]` vs `["TODO", undefined]` must be two distinct keys, otherwise a
    // "grep with a glob added" would hit the record of an earlier "grep without the glob".
    const source = readFileSync(join(loweringDir, "git-and-grep.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "grep", ["TODO"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "grep", ["TODO", "*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#3", "git-changed-files", [])`);
    expect(code).toContain(`__host.worldRead("world-read#4", "git-changed-files", ["main"])`);
    expect(code).toContain(`__host.worldRead("world-read#5", "git-diff", [])`);
    expect(code).toContain(`__host.worldRead("world-read#6", "git-diff", ["main", "src/a.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#7", "git-status", [])`);
    expect(code).toContain(`__host.worldRead("world-read#8", "git-log", [])`);
    expect(code).toContain(`__host.worldRead("world-read#9", "git-log", [5])`);
  });

  it("lowers report(item) to __host.report(siteId, item) and log to __host.log", () => {
    // The report/log split is the easiest to get wrong in this pass: both are **top-level container-less** facade
    // functions, but report has sites (resolved via siteMap by ts.Node identity) while log does not (recognized by checker name).
    const { code, siteIds } = assertLowered(
      `log("start");\nreport({ a: 1 });\nreport("plain");\nlog("done");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual(["report#1", "report#2"]);
    expect(code).toContain(`__host.report("report#1", { a: 1 })`);
    expect(code).toContain(`__host.report("report#2", "plain")`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // Reverse: log must never be minted into a report site.
    expect(code).not.toContain(`"report#3"`);
  });

  it("interleaves report site ids into the global discovery order", () => {
    // siteIds sort by the global `order` (the serialization merge key), while per-kind counters are independent —
    // so inserting a report shifts the **order** of siteIds but never the **names** of any ask#N / actor#N.
    const { siteIds } = assertLowered(
      `const a = agent("a");\nreport("before");\nconst x = await a.ask<string>("1");\nreport(x);\nconst y = await a.ask<string>("2");\nreturn x + y;\n`,
    );
    expect(siteIds).toEqual(["actor#1", "report#1", "ask#1", "report#2", "ask#2"]);
  });

  it("routes git.log to a world read and the top-level log to __host.log", () => {
    // The name collision resolves cleanly on both sides within one lowered artifact. This is the executable proof
    // that the registry keys by **declaring container**: a bare-name scheme would either mint a world-read site
    // for every log call or drop git.log's site entirely.
    const { code, siteIds } = assertLowered(
      `log("start");\nconst c = await git.log(3);\nlog("done");\nreturn c.length;\n`,
    );
    expect(siteIds).toEqual(["world-read#1"]);
    expect(code).toContain(`__host.worldRead("world-read#1", "git-log", [3])`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // Reverse: no second world-read site exists; neither log call was mistakenly minted into a site.
    expect(code).not.toContain(`"world-read#2"`);
  });

  it("keeps a multi-argument facade call's arguments in source order", () => {
    // Combine ask's receiver + argument into a lowering with "multiple visited expressions": what is pinned here is
    // that visitExpr's traversal of the argument list preserves order, and world-read's array packing shares the same code.
    const { code } = assertLowered(
      `const p = agent("p");\nconst paths = await files.glob("a");\n` +
        `const out = await p.ask<string>(paths.join(","));\nreturn out;\n`,
    );
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["a"])`);
    expect(code).toContain(`__host.ask("ask#1", p, paths.join(","))`);
  });

  it("preserves the optional-chain short-circuit on ?.ask (identifier receiver)", () => {
    // Bug regression: `p?.ask(x)` was previously lowered unconditionally to __host.ask(siteId, p, x), dropping `?.`'s short-circuit.
    // When p is undefined, the engine judges an undefined receiver as UnknownActor and fails the whole run, while the
    // author's semantics are "skip this ask, result is undefined".
    const { code } = assertLowered(
      `const flag = "x".length > 1;\nconst p = flag ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(
      `p === null || p === undefined ? undefined : __host.ask("ask#1", p, "q")`,
    );
  });

  it("evaluates a non-identifier optional receiver exactly once via a hoisted temp", () => {
    const { code } = assertLowered(
      `const box = { p: "x".length > 1 ? agent("a") : undefined };\n` +
        `const r = await box.p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(`var _a`);
    expect(code).toContain(
      `(_a = box.p) === null || _a === undefined ? undefined : __host.ask("ask#1", _a, "q")`,
    );
  });

  it("optional-chain ask runtime semantics: nullish receiver skips the host call, args unevaluated", async () => {
    // Execute the lowered artifact itself (AsyncFunction + stub host) to pin the runtime semantics: with a nullish
    // receiver __host.ask is not called, argument expressions are not evaluated, and the script falls into the `?? "skipped"` branch.
    const { code } = assertLowered(
      `let argEvaluated = false;\nfunction instr(): string { argEvaluated = true; return "q"; }\n` +
        `const p = "x".length > 1 ? agent("a") : undefined;\n` +
        `const wrap: { p?: Agent } = {};\n` +
        `const r1 = await p?.ask<string>(instr());\n` +
        `const r2 = await wrap.p?.ask<string>(instr());\n` +
        `return { argEvaluated, r1: r1 ?? "skipped", r2: r2 ?? "skipped" };\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    // "x".length > 1 is false: p is undefined and wrap.p is undefined too — both asks must short-circuit.
    await expect(run(host)).resolves.toEqual({ argEvaluated: false, r1: "skipped", r2: "skipped" });
    expect(askCalls).toEqual([]);
  });

  it("optional-chain ask runtime semantics: a present receiver still reaches __host.ask", async () => {
    const { code } = assertLowered(
      `const p = "xy".length > 1 ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    await expect(run(host)).resolves.toBe("answered");
    expect(askCalls).toEqual([["ask#1", "actor-handle", "q"]]);
  });

  it("a script with no facade calls lowers to plain stripped JS (no __host)", () => {
    const source = readFileSync(join(loweringDir, "no-facade.ts"), "utf8");
    const { code, siteIds } = assertLowered(source);
    expect(siteIds).toEqual([]);
    expect(code).not.toContain(HOST_BINDING);
  });

  it("lowers phase() markers to __host.enterPhase(name) and keeps them out of siteIds", async () => {
    // Markers have no site and no journal line, but the engine must see that control flow passed through them (
    // docs/execution-engine.md "From script to sandbox input: lowering"): rewrite to __host.enterPhase(name) with the name
    // trimmed of surrounding whitespace (the same key used by the analyzer when minting phase ids). No free `phase` identifier may remain in the sandbox.
    const { code, siteIds } = assertLowered(
      `phase("start");\nlog("hi");\nphase("  end  ");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual([]);
    expect(code).not.toContain("void 0;");
    expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
    const logged: string[] = [];
    const entered: string[] = [];
    const run = new AsyncFunction(HOST_BINDING, code) as (host: unknown) => Promise<unknown>;
    await expect(
      run({ log: (m: string) => logged.push(m), enterPhase: (n: string) => entered.push(n) }),
    ).resolves.toBe(1);
    expect(logged).toEqual(["hi"]);
    expect(entered).toEqual(["start", "end"]);
  });

  it("leaves siteIds byte-identical with and without markers (site-id stability)", () => {
    // site-id stability (docs/analysis.md "Sites") made executable: markers occupy no counters, so after scattering
    // phase() calls all over a script, the list of site ids lowering stubs must stay byte-identical — the journal keys
    // are exactly this list, and moving one name is making a resume pick up the wrong record.
    const sites =
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `return paths.length;\n`;
    const marked =
      `phase("preflight");\n` +
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `phase("work");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `phase("wrap-up");\n` +
      `return paths.length;\n`;
    const bare = assertLowered(sites);
    expect(bare.siteIds).toEqual(["actor#1", "world-read#1", "ask#1", "report#1"]);
    expect(assertLowered(marked).siteIds).toEqual(bare.siteIds);
  });

  it("does not lower a dirty script (typecheck error) — no output", () => {
    // `agent` expects a string name; passing a number triggers a type error; lowering only runs on clean programs.
    const result = lowerWorkflowScript(`const a = agent(123);\nawait a.ask("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not lower a facade-siting violation — no output", () => {
    // Taking a reference to ask (method extraction) breaks site identity; facade-siting rejects it.
    const result = lowerWorkflowScript(`const p = agent("p");\nconst f = p.ask;\nawait f("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
  });
});
