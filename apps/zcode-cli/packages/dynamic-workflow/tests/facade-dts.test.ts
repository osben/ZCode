import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  FACADE_DTS,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  WORLD_RUN_LITERAL_CODE,
} from "../src/index.js";

// Segment splitting (docs/dynamic-workflow/authoring.md "The facade") promises: FACADE_DTS is
// byte-for-byte determined by concatenating the segments. The hash is updated on every
// **intentional** facade text change (the update history is the facade's change ledger); any
// segment-level edit will trip this test — that is intentional: changing facade text must be an
// explicit decision, not silent drift while reshuffling segments.
//   - dfd383f3… (2026-08-26): segment splitting landed, byte-for-byte identical to before the split.
//   - fb2d9943… (2026-08-26): world.run segment added (docs/dynamic-workflow/authoring.md).
//   - 7f7d36ee… (2026-08-27): phase segment added (docs/dynamic-workflow/presentation.md).
//   - 198475cc… (2026-08-28): args segment added (docs/dynamic-workflow/launch.md).
//   - 807e4b79… (2026-08-29): merge recompute — the combined hash after feat/dynamic-workflow's
//     phase segment and dwf-reusable's args segment were reunited (neither side's own hash
//     matches the current text anymore).
//   - e7da7b7b… (2026-08-29): phase segment JSDoc rewritten — prompt-layer enforcement
//     (required + phase names human-readable and following the session language), see
//     docs/dynamic-workflow/authoring.md "Phases" and docs/dynamic-workflow/authoring.md
//     "The skill"; declaration set (declare lines) unchanged.
//   - 877a78c3… (2026-08-31): actor segment `agent()` JSDoc rewritten — "name is a display
//     label" changed to "a non-empty name must be unique within the run and is the identity key
//     for amend-resume (resume_from) cache matching", including the rewritten guidance for
//     static names in fan-out; the phase segment's "unlike actor names, those are just display
//     labels" was reworded in the same batch. See docs/execution-engine.md "Amend-resume".
//     Declaration set (declare lines) unchanged.
//   - 05c3401c… (2026-09-04): artifact segment added + report signature gains a second
//     argument (docs/dynamic-workflow/authoring.md). This one **changed the declaration set**:
//     added `declare const artifact` and seven spec interfaces; `report` became
//     `(item: unknown, artifactId?: string)`.
//   - 499c4179… (2026-09-04): `BoardSpec.title` renamed to `cardTitle`. The old name collided
//     on the same key with the `title` inherited from `ArtifactOptions` (the board's own card
//     title); both are string so TS accepted it — the cost was that a board could never say
//     "this board is called memory regression and every card uses the name field as its title".
//     The spec was renamed the same day (docs/dynamic-workflow/authoring.md "The facade").
//   - 540a2054… (2026-09-04): **prose only** — actor segment's artifact → result / output value,
//     ceding the word to artifact.*. The old wording (`Node<T>`'s "producing a typed artifact",
//     `Agent.ask`'s "T is the task's output artifact") referred to the engine-internal meaning,
//     while the artifact segment used the same word in the same .d.ts for the user-facing
//     artifact — the model saw both meanings at once. Also updated in the same batch:
//     CreateWorkflow's RULES and the dynamic-workflows skill body, see the "terminology" table in
//     docs/dynamic-workflow/authoring.md "The guidance" and
//     docs/dynamic-workflow/authoring.md "Artifacts: what the user keeps".
//     Declaration set (declare lines) unchanged.
//   - 0dd165d5… (2026-09-05): **prose only** — the phase segment adds the rule "every phase
//     contains at least one ask or one world.run" plus the reworded Idiom sentence
//     (docs/dynamic-workflow/presentation.md appended the same day: an empty phase flashes by
//     with no visible progress, so the model is taught not to write one).
//     Declaration set (declare lines) unchanged.
//   - 99abaa45… (2026-09-05): **prose only** — JSDoc for `ToolProfile` and `AgentPersona.tools` /
//     `model` rewritten: "'none' suits cheap judge/extract personas" changed to "use none only
//     when the ask text already contains everything needed; use readonly/default when files must
//     be checked, references followed, or things run — a tool-less subagent faced with that kind
//     of ask escalates instead of pretending". The trigger was a live GLM subagent with
//     `tools:"none"` that, when asked to verify on-disk content, emitted
//     `escalate("placeholder")`; see docs/execution-engine.md and
//     docs/dynamic-workflow/authoring.md "The skill". Declaration set (declare lines) unchanged.
//   - 23aef592… (2026-09-05): the previous two entries were re-pinned separately on the two
//     branches; after the merge (dwf-visual-redesign ⇄ feat/dynamic-workflow) both prose pieces
//     coexist, re-pinned per the merged result. Declaration set (declare lines) unchanged.
//   - b500809e… (2026-09-05): **prose only** — the `artifact` segment's overall note rewritten as
//     two habits: every run publishes its **deliverable** (if the user wants a web page/PDF, that
//     file goes through file(); if they want the conclusion, it is the long form of the report,
//     usually markdown(); except for a one-line answer); boards are for people watching the run
//     (declare one only when there is a mid-run state worth watching); plus two "is this worth a
//     card" checks (would the user open it on its own? does it duplicate another artifact?).
//     `markdown()`'s JSDoc changed from "not a copy of return" to "the common form of a
//     report-type deliverable". Same batch as SKILL.md §9 / examples.md.
//     Declaration set (declare lines) unchanged.
//   - f94af7c0… (2026-09-07): **prose only** — the phase segment's naming rule gains an echoing
//     sentence: "say it the way you would tell a colleague what you are doing now", with a pair
//     of Chinese good/bad examples ("确认测试仍然通过", not "执行测试验证任务"). Line widths in the
//     same segment were reflowed to keep max-lines 400 (lines inside the template literal count
//     as code lines, not comments). The teaching changed from "three banned words" to "one
//     principle + paired examples" (docs/dynamic-workflow/presentation.md ruling of 2026-09-07;
//     the full example table is in the SKILL.md "Write for the user" section).
//     Declaration set (declare lines) unchanged.
//   - 853ae664… (2026-09-11): **changed the declaration set** — `declare type ModelTier` and
//     `AgentPersona.model` retired (docs/dynamic-workflow/authoring.md): the host has no source
//     of lite models, the tier had long been an idling knob, yet it still occupied facade space.
//     Subagents always run the parent session's current model.
//   - fe83dea7… (2026-09-11): **changed the declaration set** — `ToolProfile` narrowed to
//     `"default" | "readonly"`, `"none"` retired (same decision record): all it bought over
//     readonly was "not reading files", which the ask text alone can achieve; it additionally
//     introduced the only family of degenerate escalations and three prompts that branch on the
//     tier. `ToolProfile` and `AgentPersona.tools` JSDoc rewritten in the same batch to the
//     two-tier wording.
//   - dee40f0b… (2026-09-12): **changed the declaration set** — `declare type ToolProfile` and
//     `AgentPersona.tools` retired entirely (same decision record, second round): all the tier
//     bought was "judges cannot modify files", and ordinary subagents do not rely on tiers to
//     guarantee that either — saying it clearly in the ask text suffices; `AgentPersona` is left
//     with only `system`, and the JSDoc notes that every actor has the full working tool set.
//   - c19c9310… (2026-09-14): only one JSDoc line changed — in createActor's name comment,
//     "CreateWorkflow with resume_from" became "AmendWorkflow" (the amend entry point split into
//     its own tool, docs/dynamic-workflow/launch.md).
//   - 21cb21e1… (2026-09-14): **changed the declaration set** — `ArtifactOptions.primary?: boolean`
//     (docs/dynamic-workflow/authoring.md "Ids, tags and versions"): the script marks the run's
//     deliverable, and the completion card and run side pane lead with it. `description` gained
//     JSDoc (it now shows next to the deliverable line); the `artifact` prose adds "when
//     publishing more than one, mark the deliverable primary".
//   - abeaec0a… (2026-09-15): merged dwf-better-artifacts — the previous two entries
//     (AmendWorkflow JSDoc and `ArtifactOptions.primary`) are both present; the hash is taken
//     over the union text.
//   - 7478845e… (2026-09-22): **changed the declaration set** — stream segment added
//     (docs/dynamic-workflow/authoring.md "Streams"): `Channel<T>`, `channel()`, `future()`,
//     included in both facades. The segment text lives in facade/dts-stream.ts (dts.ts was at
//     the line-count cap); dts.ts still does the concatenation.
//   - 7fd6b30e… (2026-09-26): **changed the declaration set** — subagent model returns to the
//     persona (docs/dynamic-workflow/authoring.md "Choosing a model per subagent"): `ModelRef`
//     (a class with a private constructor), `model()`, `AgentPersona.model?: ModelRef | string`.
//     Only in the actor segment; the snippet does not include it.
//   - 4f79960c… (2026-09-26): only one JSDoc line changed — `report()`'s entry cap raised from
//     256 to 65,536 (docs/execution-engine.md "Progressive results: `report`" and
//     "Reading the journal"). Declaration set (declare lines) unchanged.
//   - 7f7dc6df… (2026-09-26): only one JSDoc line changed — `report()`'s per-entry cap raised
//     from 32KB to 1 MiB, plus a run-level 1 GiB total byte cap
//     (docs/execution-engine.md "Progressive results: `report`").
//     Declaration set (declare lines) unchanged.
//   - a82956e9… (2026-09-26): merged dwf-report-limit — the previous three entries (the persona's
//     `ModelRef`/`model()` and `report()`'s two cap JSDoc lines) are all present; the hash is
//     taken over the union text.
//   - f1990146… (2026-09-28): **changed the declaration set** — hole segment added
//     (docs/dynamic-workflow/authoring.md "Holes: `hole<T>()`"): the three overloads
//     `hole<T>(name, prompt?)` / `hole<T>(name, body)` / `hole<T>(name, prompt, body)`.
//     The segment text lives in facade/dts-hole.ts, concatenated after the phase segment;
//     **only the full facade gets it**, the snippet does not (a snippet has no run, so there is
//     nothing for the main agent to come back and fill in).
//   - b47c6183… (2026-09-28): only one JSDoc line changed — the hole segment's no-go zone
//     narrowed to "fan-out callbacks of array methods" (for...of bodies are allowed: in a
//     sequential loop the first round stops at the hole, and once it is filled each round runs
//     the body), plus a new "the function body must be inline" sentence.
//     Declaration set (declare lines) unchanged.
//   - 278970c4… (2026-09-30): **prose only** — comments trimmed down to the reference layer
//     (docs/dynamic-workflow/authoring.md "The facade"): the judgment layer (how to name phases,
//     the two deliverable habits, gating idioms, how to write pipeline phases, etc.) was removed
//     and now lives only in the skill body; the remaining comments were rewritten for the script
//     author's reading (actor → subagent, journaled → recorded; the hole's reader is the main
//     agent, so it says "you"); facade 23,275 → 13,598 bytes.
//     Declaration set (declare lines) unchanged.
const PINNED_FACADE_SHA256 = "278970c47a2b3e5225d8e993320193221b42bd524121228e363f84ee4654609d";

describe("facade dts segments", () => {
  it("FACADE_DTS is byte-identical to the pinned composition", () => {
    const hash = createHash("sha256").update(FACADE_DTS, "utf8").digest("hex");
    expect(hash).toBe(PINNED_FACADE_SHA256);
  });

  // Comments cover only the reference layer: what it does, what it returns, when it rejects or
  // fails the run, caps, compile-time rules for arguments
  // (docs/dynamic-workflow/authoring.md "The facade"). The judgment layer is stated once, in the
  // skill body; the facade enters context only via skill §16.2, so comments restating the body
  // would pay twice per writing session — and the comments would be the copy that drifts.
  // Before the 2026-09-30 dedup it was 23,275 bytes, about 20,000 of which were comments.
  it("stays a reference: FACADE_DTS is under 14 000 bytes", () => {
    expect(Buffer.byteLength(FACADE_DTS, "utf8")).toBeLessThan(14_000);
  });

  // args is present in **both** facades: the snippet's "verbatim portability" invariant requires
  // that a saved script referencing args can be dropped into EvalWorkflowSnippet and compile as
  // is (at runtime it is `{}`).
  it("SNIPPET_FACADE_DTS keeps world reads, world.run, log and args, drops actors/report/artifact/phase", () => {
    expect(SNIPPET_FACADE_DTS).toContain("declare const args");
    expect(FACADE_DTS).toContain("declare const args");
    expect(SNIPPET_FACADE_DTS).toContain("declare const files");
    expect(SNIPPET_FACADE_DTS).toContain("declare const git");
    expect(SNIPPET_FACADE_DTS).toContain("declare const world");
    expect(SNIPPET_FACADE_DTS).toContain("declare function log");
    // The stream segment is present in both facades: the pipeline's pure logic is exactly what a
    // snippet rehearses.
    expect(SNIPPET_FACADE_DTS).toContain("declare function channel");
    expect(SNIPPET_FACADE_DTS).toContain("declare function future");
    expect(SNIPPET_FACADE_DTS).toContain("declare interface Channel<T>");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function agent");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function report");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function phase");
    // Model declarations belong to the actor: a snippet has no subagents, hence no model choice.
    expect(FACADE_DTS).toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("ModelRef");
    // Artifacts are "what the run hands to the user", and a snippet has no run: the whole
    // segment is deliberately absent, not even the type remains.
    expect(FACADE_DTS).toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("ArtifactRef");
    // Holes exist only in the full facade (docs/dynamic-workflow/authoring.md "Holes"): a
    // snippet has no run.
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function hole");
  });

  it("rejects hole() in the snippet facade at compile time (TS2304)", () => {
    const workflow = createWorkflowProgram(`return await hole<string>("决定");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'hole'");
  });

  // docs/dynamic-workflow/authoring.md "What the facade does not have": the script facade has no
  // budget identifier.
  it("neither facade declares budget", () => {
    expect(FACADE_DTS).not.toContain("budget");
    expect(SNIPPET_FACADE_DTS).not.toContain("budget");
  });
});

describe("snippet compilation (scratch facade)", () => {
  const compileSnippet = (scriptText: string) =>
    createWorkflowProgram(scriptText, { facadeDts: SNIPPET_FACADE_DTS });

  it("compiles a world-read + pure-logic snippet cleanly", () => {
    const workflow = compileSnippet(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `log(\`found \${paths.length}\`);\n` +
        `return paths.filter((p) => p.endsWith(".test.ts"));`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
  });

  it("rejects agent() at compile time (TS2304, not a runtime surprise)", () => {
    const workflow = compileSnippet(`return await agent("a").ask("do it");`);
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("rejects report() and phase() the same way", () => {
    for (const source of [`report({ found: 1 });`, `phase("gate");`]) {
      const workflow = compileSnippet(source);
      expect(collectDiagnostics(workflow.program).length).toBeGreaterThan(0);
    }
  });

  // Facade identity is decided by the declaration file name (five places: registry / sites /
  // misuse / lowering); if the scratch facade used a different file name, site collection would
  // silently come up empty and files.glob would no longer lower to __host.worldRead — the
  // snippet would compile yet do nothing. This test pins the "same-name injection" invariant.
  it("lowers files.glob in a snippet to a world-read site (facade filename invariant)", () => {
    const workflow = compileSnippet(`return await files.glob("*.ts");`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "glob"`);
  });
});

// The artifact **type surface** (docs/dynamic-workflow/authoring.md "Two families"): the semantic
// asymmetry between the two families must hold at the type level — content members await to an
// ArtifactRef, preset members are void.
describe("artifact facade (type surface)", () => {
  const diagnosticsOf = (scriptText: string) =>
    collectDiagnostics(createWorkflowProgram(scriptText).program);

  it("types content members as Promise<ArtifactRef>", () => {
    expect(
      diagnosticsOf(
        `const ref = await artifact.file("book", "out/book.pdf", { title: "Book", contentType: "application/pdf" });\n` +
          `const md = await artifact.markdown("notes", "# hi", { description: "d" });\n` +
          `return ref.id + String(ref.version) + md.id;`,
      ),
    ).toEqual([]);
  });

  it("rejects using a content member's result as anything but an ArtifactRef", () => {
    const diagnostics = diagnosticsOf(`const n: number = await artifact.file("book", "b.pdf");`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("not assignable");
  });

  it("types preset members as void (a declaration has nothing to await)", () => {
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { type: "line", x: { field: "round" }, y: [{ field: "ms", label: "ms" }], scale: "log", baseline: { field: "budget" } });\n` +
          `artifact.table("rows", { columns: [{ field: "name" }], key: "name" });\n` +
          `artifact.metrics("m", { metrics: [{ field: "p95", unit: "ms" }] });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo", "done"], detail: [{ field: "owner" }] });`,
      ),
    ).toEqual([]);
    const diagnostics = diagnosticsOf(
      `const v: number = artifact.chart("perf", { x: { field: "r" }, y: { field: "m" } });`,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("lets a board name itself and its cards separately (the cardTitle rename)", () => {
    expect(
      diagnosticsOf(
        `artifact.board("b", { title: "内存回归", key: "id", status: "state", columns: ["todo"], cardTitle: "name" });`,
      ),
    ).toEqual([]);
    // The old name is nothing more than a BoardSpec field name now: writing title names the
    // board itself, not the cards' titles.
    expect(FACADE_DTS).toContain("cardTitle?: string");
  });

  it("accepts primary on every member and rejects a non-boolean one", () => {
    expect(
      diagnosticsOf(
        `await artifact.file("book", "b.pdf", { primary: true });\n` +
          `await artifact.markdown("notes", "# hi", { title: "Notes", primary: false });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo"], primary: true });`,
      ),
    ).toEqual([]);
    expect(
      diagnosticsOf(`await artifact.file("book", "b.pdf", { primary: "yes" });`).length,
    ).toBeGreaterThan(0);
    expect(FACADE_DTS).toContain("primary?: boolean");
  });

  it("rejects a malformed spec at compile time (missing y, wrong chart type)", () => {
    expect(diagnosticsOf(`artifact.chart("perf", { x: { field: "r" } });`).length).toBeGreaterThan(
      0,
    );
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { x: { field: "r" }, y: { field: "m" }, type: "pie" });`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("makes report's second argument an optional string", () => {
    expect(diagnosticsOf(`report({ a: 1 });\nreport({ a: 1 }, "perf");`)).toEqual([]);
    expect(diagnosticsOf(`report({ a: 1 }, 1);`).length).toBeGreaterThan(0);
  });

  it("leaves artifact out of the snippet facade (TS2304, not a runtime surprise)", () => {
    const workflow = createWorkflowProgram(`await artifact.file("book", "b.pdf");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'artifact'");
  });
});

describe("world.run (compile side)", () => {
  it("typechecks and lowers to the run op with positional args", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("lean", ["--make", "proof.lean"], { timeoutMs: 60000 });\n` +
        `return r.exitCode === 0;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "run"`);
  });

  it("collects the deduplicated, sorted command set from literals", () => {
    const workflow = createWorkflowProgram(
      `await world.run("node", ["-e", "0"]);\n` +
        `await world.run(\`lean\`, ["a.lean"]);\n` +
        `await world.run("node", ["-e", "1"]);`,
    );
    const table = collectSites(workflow);
    const { commands, diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(commands).toEqual(["lean", "node"]);
  });

  it("rejects a non-literal cmd with a positioned WORLD_RUN_LITERAL_CODE diagnostic", () => {
    const workflow = createWorkflowProgram(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("string literal");
    // analyzeWorkflowScript surfaces it alongside misuse (ok:false).
    const analyzed = analyzeWorkflowScript(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
  });

  it("rejects a substitution template cmd", () => {
    const workflow = createWorkflowProgram(
      `const suffix = "n";\nawait world.run(\`lea\${suffix}\`, []);`,
    );
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
  });

  it("keeps the world.run step label carrying the command (confirmation surface)", () => {
    const analyzed = analyzeWorkflowScript(`await world.run("lean", ["a.lean"]);`);
    expect(analyzed.ok).toBe(true);
    const step = analyzed.causality?.steps.find((s) => s.label.includes("lean"));
    expect(step).toBeDefined();
    expect(step?.label).toBe("run lean");
  });
});

// args lowering (docs/dynamic-workflow/launch.md "Running a saved workflow"):
// it is the only **value** in the facade rather than a callable, so it goes through
// identifier-level rewriting instead of sites.
describe("args lowering", () => {
  it("lowers a facade args read to __host.args, with no site of its own", () => {
    const workflow = createWorkflowProgram(`const target = String(args.target);\nreturn target;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.target");
    // Reading a value is not an await point: it takes no site id, so no causality graph node
    // grows from it.
    expect(lowered.siteIds).toEqual([]);
  });

  it("lowers args in the snippet facade too (verbatim portability)", () => {
    const workflow = createWorkflowProgram(`return String(args.x);`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.args.x");
  });

  // Detection follows the checker's resolution, not the name: an args declared by the script
  // itself resolves to the script file's symbol. A name heuristic would rewrite this into
  // `const __host.args = ...`, a runtime SyntaxError.
  it("leaves a script-declared local `args` alone", () => {
    const workflow = createWorkflowProgram(`const args = { local: 1 };\nreturn args.local;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
    expect(lowered.code).toContain("args.local");
  });

  it("leaves a parameter named args and an unrelated `.args` property alone", () => {
    const workflow = createWorkflowProgram(
      [
        "function pick(args: { a: number }): number { return args.a; }",
        "const holder = { args: 7 };",
        "return pick({ a: 1 }) + holder.args;",
      ].join("\n"),
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
  });

  // A script using both args and ask: the rewrite must not break sites, and sites must not
  // swallow args.
  it("coexists with ask sites", () => {
    const workflow = createWorkflowProgram(
      `const r = await agent("w").ask(String(args.topic));\nreturn r;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.topic");
    expect(lowered.code).toContain('__host.ask("ask#1"');
  });
});
