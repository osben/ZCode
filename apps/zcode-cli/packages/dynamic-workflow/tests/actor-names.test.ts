import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "../src/index.js";
import { DUPLICATE_ACTOR_NAME_CODE, FANOUT_ACTOR_NAME_CODE } from "../src/analysis/actor-names.js";

// Compile-time courtesy diagnostics for duplicate literal actor names (the "Naming uniqueness
// (engine)" row of docs/execution-engine.md). The rule's front gate is at runtime (the engine's
// createActor DuplicateActorName); this pass only looks at literals, so it may under-report but
// must never over-report — every "legal" case below is an assertion of the latter.

/** Takes only duplicate-name diagnostics (the script itself must typecheck cleanly, otherwise analyze never reaches this pass). */
function duplicates(scriptText: string) {
  const result = analyzeWorkflowScript(scriptText);
  const hits = result.diagnostics.filter((d) => d.code === DUPLICATE_ACTOR_NAME_CODE);
  return { hits, result };
}

/** Takes only fan-out static-name diagnostics (clause 2, a separate code — see the top of actor-names.ts). */
function fanOutNames(scriptText: string) {
  const result = analyzeWorkflowScript(scriptText);
  const hits = result.diagnostics.filter((d) => d.code === FANOUT_ACTOR_NAME_CODE);
  return { hits, result };
}

/** Assertion for clean scripts: no duplicate-name diagnostics and the whole analysis passes (the graph is still produced). */
function expectClean(scriptText: string): void {
  const { result } = duplicates(scriptText);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
}

describe("duplicate actor names (compile-time courtesy)", () => {
  it("flags two literal name arguments that are the same string, on the later site", () => {
    const { hits, result } = duplicates(
      `const a = agent("planner");\nconst b = agent("planner");\nreturn 1;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.message).toContain('"planner"');
    // The diagnostic shares the blocking tier with world.run / phase: the script cannot be submitted and no graph is produced.
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
  });

  it("reads through an object-literal persona to the name argument", () => {
    // Today `AgentPersona` does **not** declare name (facade dts), so any persona a script can
    // write carries no name and the effective name always comes from the name argument. The
    // collector still processes personas by normalizePersona's rules (see the two skip cases
    // below) — that keeps it in sync with the runtime's effective-name definition, not because
    // it can trigger today.
    const { hits } = duplicates(
      `const a = agent("planner", { system: "You plan first." });\n` +
        `const b = agent("planner", { system: "You plan." });\n` +
        `return 1;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it("takes a string persona as a system prompt, not a name", () => {
    // The effective name of agent(name, "You plan.") is still the name argument — identical names in two places are still duplicates.
    const { hits } = duplicates(
      `const a = agent("planner", "You plan.");\n` +
        `const b = agent("planner", "You also plan.");\n` +
        `return 1;`,
    );
    expect(hits).toHaveLength(1);
  });

  it("reports each later repetition of a name", () => {
    const { hits } = duplicates(
      `const a = agent("w");\nconst b = agent("w");\nconst c = agent("w");\nreturn 1;`,
    );
    expect(hits.map((d) => d.line)).toEqual([2, 3]);
  });

  it("leaves anonymous actors alone, however many", () => {
    // Anonymous is legal (the runtime does not check it either). Note the site table records the
    // binding name into site.name as a **display label**, so this case also pins "the diagnostic
    // reads the argument, not that label" — otherwise the two anonymous actors named "a"/"b"
    // below would be falsely flagged.
    expectClean(`const a = agent();\nconst b = agent();\nreturn 1;`);
  });

  it("leaves empty names alone (empty is anonymous, matching the engine)", () => {
    expectClean(`const a = agent("");\nconst b = agent("");\nreturn 1;`);
  });

  it("leaves distinct names alone", () => {
    expectClean(`const a = agent("planner");\nconst b = agent("reviewer");\nreturn 1;`);
  });

  it("skips dynamic names — the runtime check is the real gate", () => {
    // Template holes, identifiers, the same site inside loops: statically undecidable, so let them all through and let the engine's runtime check backstop.
    expectClean(
      `const workers = [1, 2, 3].map((i) => agent(\`worker-\${i}\`));\n` +
        `const n = "planner";\nconst p = agent(n);\nconst q = agent(n);\n` +
        `return workers.length;`,
    );
  });

  it("skips a persona with a computed key (the key itself could be `name`)", () => {
    // A computed key must make the whole site give up, not "skip this one property and fall back
    // to the name argument" — the latter is a guess, and the direction it guesses wrong in is
    // exactly a false positive.
    expectClean(
      `const a = agent("w", { ["system"]: "You work." });\n` +
        `const b = agent("w", { ["system"]: "You work." });\n` +
        `return 1;`,
    );
  });

  it("skips a template-with-holes persona (it is a runtime string, not a literal)", () => {
    expectClean(
      `const role = "planner";\n` +
        `const a = agent("w", \`You are the \${role}.\`);\n` +
        `const b = agent("w", \`You are the \${role}.\`);\n` +
        `return 1;`,
    );
  });

  it("skips dynamic names inside a fan-out too (per-element names are the fix, not a violation)", () => {
    expectClean(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const notes = await Promise.all(paths.map((p) => agent(\`reviewer-\${p}\`).ask<string>(\`Review \${p}\`)));\n` +
        `return notes.length;`,
    );
  });

  it("skips a spread persona and a non-literal persona (either could carry a name)", () => {
    // Conservative, not clever: `AgentPersona` has no name today, but the collector does not take
    // the facade's current shape as a premise — once it grows a name, "judge by the name argument"
    // would become a **false positive** for a renamed actor, and false positives block legal
    // scripts. Under-reporting is free (the engine's runtime check backstops), so anything
    // unreadable is let through.
    expectClean(
      `const base = { system: "You work." };\n` +
        `const a = agent("w", { ...base });\nconst b = agent("w", base);\nreturn 1;`,
    );
  });
});

// The second clause: static names inside a fan-out body. One site, N actors, the same name — a
// runtime DuplicateActorName is guaranteed. This clause **deliberately** may over-report (the
// `.map` collection may hold a single element); see the top of src/analysis/actor-names.ts for
// why: the fix is free, while staying silent costs a whole run.
describe("static actor names inside a fan-out (compile-time)", () => {
  it("flags a literal name inside an array-method fan-out, without withholding the graph", () => {
    const { hits, result } = fanOutNames(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
        `return verdicts.length;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.message).toContain("fan-out");
    expect(hits[0]?.message).toContain('"reviewer"');
    // Submission is blocked (ok:false) but the graph is still produced — this clause says the
    // script would **fail when run**, not "this code cannot be analyzed", and the author needs the
    // graph to see which fan-out it is (see analyze.ts).
    expect(result.ok).toBe(false);
    expect(result.graph).toBeDefined();
    expect(result.causality).toBeDefined();
  });

  it("flags a literal name inside a for...of body", () => {
    const { hits } = fanOutNames(
      `const items = ["a", "b"];\nconst out: string[] = [];\n` +
        `for (const item of items) {\n  const w = agent("worker");\n  out.push(await w.ask<string>(\`Do \${item}\`));\n}\n` +
        `return out;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(4);
  });

  it("still withholds the graph when a blocking clause fires alongside it", () => {
    // 9005 and 9006 present together: 9005 is the graph-withholding tier, so the whole analysis still produces no graph.
    const { result } = fanOutNames(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
        `const a = agent("dup");\nconst b = agent("dup");\n` +
        `return [verdicts.length, await a.ask<string>("x"), await b.ask<string>("y")];`,
    );
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
  });

  it("leaves an anonymous actor inside a fan-out alone", () => {
    expectClean(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent().ask<string>(\`Review \${p}\`)));\n` +
        `return verdicts.length;`,
    );
  });

  it("leaves a literal name outside any fan-out alone (single site = runtime's business)", () => {
    expectClean(
      `const reviewer = agent("reviewer");\nreturn await reviewer.ask<string>("Review.");`,
    );
  });

  it("reports one diagnostic per site, preferring the fan-out clause over the duplicate one", () => {
    // The same name appears inside a fan-out and duplicated outside: the fan-out site reports 9006
    // and the outside one reports 9005 as usual — one diagnostic per site, never stacked.
    const script =
      `const paths = await files.glob("src/**/*.ts");\n` +
      `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
      `const late = agent("reviewer");\n` +
      `return [verdicts.length, await late.ask<string>("Again?")];`;
    expect(fanOutNames(script).hits.map((d) => d.line)).toEqual([2]);
    expect(duplicates(script).hits.map((d) => d.line)).toEqual([3]);
  });
});
