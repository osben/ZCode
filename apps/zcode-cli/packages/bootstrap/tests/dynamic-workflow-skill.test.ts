// ============================================================
// bundled-skills: builtin /workflow command + dynamic-workflows skill tripwire
// ============================================================
// Contract: docs/dynamic-workflow/authoring.md, "The `/workflow` command and the skill".
//
// These assertions guard one thing: **the skill body stays in sync with the facade, and the facade
// appears exactly once**. Since 2026-09-21 the facade's .d.ts is no longer re-sent with the
// CreateWorkflow description on every request (that was about 4.4k tokens); it is embedded verbatim
// in the marked block of SKILL.md §16.2, and the skill gate on resolveInput guarantees the model
// has read it before writing a script. Outside the marked block, the body must not copy any
// signature again — a second copy would inevitably drift. So this file (1) pins the marked block as
// verbatim-equal to FACADE_DTS and (2) derives the set of members the body may mention from
// FACADE_DTS — the moment the facade changes, this file goes red instead of the body silently
// rotting.
//
// There is also a negative assertion: another common Workflow tool API (pipeline/parallel/
// budget.total...) resembles this facade but is actually different. Once its vocabulary leaks into
// the body, the model writes scripts that do not compile, and the diagnostics point at "cannot find
// name" rather than "you used the wrong API" — extremely hard to self-diagnose. `phase` is the only
// entry removed from that list: dwf gained its own `phase("name")` stage annotation
// (docs/dynamic-workflow/presentation.md), which turned the blacklist into a false positive, so a
// positive "marker form" assertion took over.
//
// Since 2026-09-21 neither the command nor the skill ships with the zcode-guide plugin: the command
// is compiled into the CLI (builtin-workflow-command.ts) and the skill moved to
// packages/bundled-skills (bundled-skills.ts). This closes the incident pattern where uninstalling
// or disabling the plugin made the entry point vanish wholesale; this file also pins the new homes
// of both assets.

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import { analyzeWorkflowScript, compileWorkflowScript, FACADE_DTS } from "@zcode/dynamic-workflow";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  resolveBundledSkillRoots,
} from "../src/app/bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "../src/app/dynamic-workflow-gate.js";
import {
  resolveZCodeBuiltinPromptCommand,
  resolveZCodeBuiltinPromptCommandInvocation,
} from "../src/builtin-prompt-command.js";
import {
  BUILTIN_WORKFLOW_COMMAND,
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "../src/builtin-workflow-command.js";

const PACKAGES_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK_ROOT = join(PACKAGES_ROOT, "bundled-skills");
const SKILL_NAME = DYNAMIC_WORKFLOW_SKILL_NAME;
const SKILL_DIR = join(PACK_ROOT, "skills", SKILL_NAME);
/** zcode-guide remains an ordinary plugin skill root: it proves the gray gate does not take down skills outside the skill pack. */
const GUIDE_PLUGIN_SKILLS_ROOT = join(PACKAGES_ROOT, "zcode-guide-plugin", "skills");

/** The three skill body files: SKILL.md is always present; the model Reads the other two on demand. */
const SKILL_FILES = ["SKILL.md", "patterns.md", "examples.md"] as const;

/** adapters/src/skills/index.ts:20 — an over-long description drops the skill entirely; it is not a warning. */
const MAX_DESCRIPTION_LENGTH = 1024;
/** core/src/context/sections/skills.ts:10 — the session listing exposes only this many characters of each description. */
const LISTING_DESCRIPTION_CHARS = 250;
/**
 * WORKFLOW_SKILL_MAX_BYTES from core/src/tool/handlers/skill.ts — a cap specific to this skill
 * (other skills get 100 000). Exceeding it truncates, and what gets truncated is the §16 contract.
 */
const SKILL_TOOL_MAX_BYTES = 200_000;
/** The marked block in SKILL.md §16.2 that embeds FACADE_DTS verbatim. */
const FACADE_BLOCK_START = "<!-- facade-dts:start -->";
const FACADE_BLOCK_END = "<!-- facade-dts:end -->";
const FACADE_BLOCK_PATTERN = /<!-- facade-dts:start -->[\s\S]*?<!-- facade-dts:end -->/g;

/** The negative assertions (declare / phase form / foreign vocabulary) look at the body, not at that ambient-declaration block. */
function stripFacadeBlock(text: string): string {
  return text.replace(FACADE_BLOCK_PATTERN, "");
}

async function readSkillFile(name: string): Promise<string> {
  return readFile(join(SKILL_DIR, name), "utf8");
}

async function readAllContent(): Promise<{ name: string; text: string }[]> {
  const skills = await Promise.all(
    SKILL_FILES.map(async (name) => ({ name, text: stripFacadeBlock(await readSkillFile(name)) })),
  );
  return [...skills, { name: "builtin /workflow", text: BUILTIN_WORKFLOW_COMMAND.content }];
}

/** Extracts the flat frontmatter wrapped in `---`; parsing rules mirror adapters' parseFlatYaml (top-level scalars only). */
function parseFlatFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end === -1) return {};
  const entries: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    entries[key] = raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  }
  return entries;
}

describe("builtin /workflow command", () => {
  it("declares the skill it depends on and passes the user's request through", () => {
    // skills: makes contracts' formatCommandSkillInstructions emit a leading "call the Skill tool
    // first" instruction. A wrong name does not error — skill loading is silently lost — so
    // pinning it equal to the skill directory name matters.
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.name).toBe(BUILTIN_WORKFLOW_COMMAND_NAME);
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.skills).toEqual([SKILL_NAME]);
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.description).toBeTruthy();
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.argumentHint).toBeTruthy();

    // Without $ARGUMENTS, expandCustomCommandTemplate appends the arguments as an uncontrolled
    // "User arguments:" trailing block; the command body decides for itself where the user's
    // request lands.
    expect(BUILTIN_WORKFLOW_COMMAND.content).toContain("$ARGUMENTS");

    const prompt = expandBuiltinWorkflowCommandPrompt("ship the release");
    expect(prompt).toContain(`Required skills: \`${SKILL_NAME}\`.`);
    expect(prompt).toContain(`call the Skill tool for \`${SKILL_NAME}\``);
    expect(prompt).toContain("ship the release");
    expect(prompt).toContain("`CreateWorkflow`");
    expect(prompt).not.toContain("$ARGUMENTS");
  });

  it("expands through the builtin prompt resolver, and not while the gray gate is off", () => {
    // DWG-03: the directory side excludes it, but a user can still type the command name by hand;
    // both paths must reach the same conclusion.
    expect(resolveZCodeBuiltinPromptCommand("/workflow ship it")).toContain("ship it");
    expect(
      resolveZCodeBuiltinPromptCommand("/workflow ship it", { dynamicWorkflowEnabled: true }),
    ).toContain("ship it");
    expect(
      resolveZCodeBuiltinPromptCommand("/workflow ship it", { dynamicWorkflowEnabled: false }),
    ).toBe(undefined);
    // Expands even with no arguments: the model asks the user for a task per the skill, instead of
    // treating "/workflow" as plain text.
    expect(resolveZCodeBuiltinPromptCommand("/workflow")).toContain("Required skills");
    expect(resolveZCodeBuiltinPromptCommand("please /workflow now")).toBe(undefined);
  });

  // launch.md "On demand: activation": the wiring layer must know which command was expanded so it
  // can attach activation to `/workflow`.
  it("invocation 形态带命令名", () => {
    expect(resolveZCodeBuiltinPromptCommandInvocation("/workflow ship it")).toMatchObject({
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
    });
    expect(resolveZCodeBuiltinPromptCommandInvocation("/WORKFLOW ship it")?.name).toBe(
      BUILTIN_WORKFLOW_COMMAND_NAME,
    );
    expect(resolveZCodeBuiltinPromptCommandInvocation("/init")?.name).toBe("init");
    expect(
      resolveZCodeBuiltinPromptCommandInvocation("/workflow x", { dynamicWorkflowEnabled: false }),
    ).toBeUndefined();
    expect(resolveZCodeBuiltinPromptCommandInvocation("/unknown")).toBeUndefined();
  });
});

describe("bundled dynamic-workflows skill", () => {
  it("loads: name matches the directory, description fits the loader's cap", async () => {
    const frontmatter = parseFlatFrontmatter(await readSkillFile("SKILL.md"));

    expect(frontmatter.name).toBe(SKILL_NAME);
    expect(frontmatter.description).toBeTruthy();
    expect(frontmatter.description.length).toBeLessThan(MAX_DESCRIPTION_LENGTH);

    // Automatic triggering only sees the first 250 characters, so the trigger word must come
    // first — and it must be the specific name CreateWorkflow, not a generic "multi-agent": the
    // latter would pull the model toward workflow even when the Agent tool is the right answer.
    expect(frontmatter.description.slice(0, LISTING_DESCRIPTION_CHARS)).toContain("CreateWorkflow");
  });

  it("ships every file the pack contract pins, and the pack pins every file shipped", async () => {
    const contents = await Promise.all(SKILL_FILES.map((name) => readSkillFile(name)));
    for (const text of contents) expect(text.length).toBeGreaterThan(0);

    // Two-way alignment: every file in the skill directory is a required asset (bundled-skills.ts
    // rejects the whole pack if one is missing), and the contract must not retain files that no
    // longer exist (otherwise the stage/SEA build fails forever).
    const pinned = new Set(BUNDLED_SKILL_PACK_REQUIRED_PATHS);
    for (const name of SKILL_FILES) expect(pinned).toContain(`skills/${SKILL_NAME}/${name}`);
    expect(pinned.size).toBe(SKILL_FILES.length);
  });

  it("embeds the facade verbatim, once, and stays under the Skill tool's byte cap", async () => {
    const skill = await readSkillFile("SKILL.md");
    // docs/dynamic-workflow/authoring.md "The authoring surface": the marked block holds the same
    // constant the compiler consumes, verbatim-equal — the contract the model reads cannot drift
    // from the thing that compiles.
    const block = `${FACADE_BLOCK_START}\n\`\`\`ts\n${FACADE_DTS.trim()}\n\`\`\`\n${FACADE_BLOCK_END}`;
    expect(skill.split(block)).toHaveLength(2);
    expect(skill.match(FACADE_BLOCK_PATTERN)).toHaveLength(1);
    // The skill body is returned in one shot by the Skill tool; anything past the cap is truncated
    // from the tail, and §16 lives at the tail.
    expect(Buffer.byteLength(skill, "utf8")).toBeLessThan(SKILL_TOOL_MAX_BYTES);
  });

  it("carries the contract the tool descriptions used to carry", async () => {
    // After the description was shortened, these sentences live only here
    // (core/tests/workflow-routing-hints.test.ts pins the description side).
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("## 16. Tool reference");
    expect(skill).toContain("refuses\nto run until this skill has been loaded");
    expect(skill).toContain("**Three sources; pass exactly one.**");
    expect(skill).toContain("Running a saved workflow\n  is the one call that does not need this skill loaded");
    expect(skill).toContain("`max_concurrency`");
    expect(skill).toContain("`subagent_model`");
    expect(skill).toContain("do not imitate it");
    expect(skill).toContain("Never use the `declare` modifier");
    expect(skill).toContain("`noUncheckedIndexedAccess` off");
    expect(skill).toContain("needs no guard");
    expect(skill).toContain("No `export` statements");
    expect(skill).toContain("No `import` statements");
    expect(skill).toContain("compile-time string\n  literal");
    expect(skill).toContain("standalone\n  statement");
    expect(skill).toContain("Two markers\n  with the same name are one phase");
    expect(skill).toContain("unique within the\n  run");
    expect(skill).toContain("Model-side errors never reach the script");
    expect(skill).toContain("`ContextLimit`");
    expect(skill).toContain("Never put the same content in both");
    expect(skill).toContain("never\n  paste the script a second time");
    expect(skill).toContain("### 16.4 `AmendWorkflow`");
    expect(skill).toContain("`script_unchanged`");
    // The carry-over rules come in a fixed order: script first (omit both source fields), then
    // concurrency, then subagent model; the in-place-retune sentence sits right next to the
    // concurrency field (docs/dynamic-workflow/launch.md "What the model is told", carried by the
    // skill since 2026-09-21).
    const amend = skill.slice(skill.indexOf("### 16.4 `AmendWorkflow`"), skill.indexOf("### 16.5"));
    const keptScript = amend.indexOf("Omit both to keep the predecessor's script");
    const limit = amend.indexOf("- `max_concurrency`: omit to keep the predecessor's limit");
    const inPlace = amend.indexOf("retunes that run in place");
    const model = amend.indexOf("- `subagent_model`: omit to keep the predecessor's choice");
    expect(keptScript).toBeGreaterThan(-1);
    expect(keptScript).toBeLessThan(limit);
    expect(limit).toBeLessThan(inPlace);
    expect(inPlace).toBeLessThan(model);
    expect(amend).toContain("`path` or `script`, never both. `path` is the usual form");
    expect(skill).toContain("picks that\nask up where it left off");
    // The exact cache rule (docs/dynamic-workflow/launch.md "What the model is told"): after the
    // first write to the workspace, only asks to subagents that were Read or run switch to live
    // runs; asks that were only answered keep hitting the cache. §13 used to say "everything runs
    // live after that", contradicting the description; with the description shortened, the skill is
    // the single source of truth and both places must say the same thing.
    expect(skill).toContain("**How the cache works.**");
    expect(skill).toContain("Asks that only\nanswered keep settling from the cache");
    expect(skill).not.toContain("every ask to any subagent runs live even if its text is unchanged");
    expect(skill).toContain("### 16.5 `SaveWorkflow`");
    expect(skill).toContain("Never unsolicited");
    expect(skill).toContain("`script_path`");
    expect(skill).toContain("### 16.6 `EvalWorkflowSnippet`");
    expect(skill).toContain("do not exist here and\n  fail typechecking");
  });

  it("never restates the facade outside its marked block", async () => {
    for (const { name, text } of await readAllContent()) {
      // The marked block (§16.2) is the only source of ambient declarations. A `declare ` in the
      // body means a signature was copied in, meaning the model sees two copies and one of them
      // will drift.
      expect(text, name).not.toMatch(/\bdeclare\s/);
      // RULES already bans these three; showing them in an example is demonstrating a violation.
      expect(text, name).not.toMatch(/^\s*import\s/m);
      expect(text, name).not.toMatch(/^\s*export\s/m);
    }
  });

  it("mentions only facade members that actually exist", async () => {
    for (const { name, text } of await readAllContent()) {
      for (const [, container, member] of text.matchAll(
        // artifact joins the scan surface: four of the artifact member names
        // (file/markdown/chart/table/metrics/board) are ordinary English words, so a one-letter
        // typo in the body is not as conspicuous as with `glob`. Prose like `artifact.*` does not
        // match (`*` is not a valid identifier start), so only real calls get checked.
        /\b(artifact|files|git|world)\.([A-Za-z_$][\w$]*)/g,
      )) {
        expect(FACADE_DTS, `${name}: ${container}.${member}`).toContain(`${member}(`);
      }
    }
  });

  it("teaches world.run and the EvalWorkflowSnippet pre-flight (amendment 1)", async () => {
    // docs/dynamic-workflow/authoring.md "The skill": deterministic gating belongs to world.run,
    // snippet pre-flight to EvalWorkflowSnippet. If the body loses either one, the guidance
    // silently collapses back to "outsource every effect to an actor".
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("world.run");
    expect(skill).toContain("EvalWorkflowSnippet");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("world.run");
  });

  // docs/dynamic-workflow/authoring.md "The guidance". Artifacts are the only channel through
  // which a run hands anything to the user, and the facade only provides signatures: without §9,
  // the model keeps leaving subagent-produced pdfs in the workspace, or stuffs the same markdown
  // into both the return value and an artifact. The three positive assertions pin the rationale
  // for each of the three member kinds.
  it("teaches artifact delivery: file, markdown and the report-fed dashboard (amendment 6)", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Deliver artifacts.**");
    expect(skill).toContain('report(item, "perf")');
    expect(skill).toContain("compile-time string literals");
    // Rejection is catchable, and the moment of rejection is exactly when the gap is handed back
    // to the subagent — the only control-flow teaching point in the artifact family.
    expect(skill).toContain("reject catchably");
  });

  it("teaches no persona knob: neither a tool profile nor a model tier (amendments 7–8)", async () => {
    // docs/dynamic-workflow/authoring.md: `tools` and model tiers are both retired. If either
    // appears in the skill body again, it teaches a member that does not compile; the "read-only"
    // wording is banned too — every subagent has the full work toolset, and "won't touch files" is
    // something the ask says, not something a tier guarantees. Since 2026-09-26 a persona may name
    // a **specific** model ("Choosing a model per subagent"), so `model:` itself is legal; only
    // the tier words are banned.
    for (const { name, text } of await readAllContent()) {
      expect(text, `${name}: persona tools`).not.toMatch(/\btools:\s*"/);
      expect(text, `${name}: persona model tier`).not.toMatch(
        /\bmodel:\s*"(lite|main|fast|strong)"/,
      );
      // "none" is not in the table: ordinary strings like `let feedback = "none"` are legitimate
      // examples.
      expect(text, `${name}: tool profile vocabulary`).not.toMatch(
        /ToolProfile|"readonly"|read-only subagent/,
      );
    }
  });

  // docs/dynamic-workflow/authoring.md "The skill": pipelining is the default stance — each item
  // moves to the next stage as soon as it is done, and you only wait for the full set where the
  // next step needs every item. Before 2026-09-30, §7 framed itself as "join only where the data
  // needs everyone", which reads like "use fewer barriers" rather than "pipeline by default";
  // models then wrote scripts with one barrier per stage.
  it("teaches pipelining as the default and a join as the exception", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain(
      "## 7. Pipeline by default; join only where the next step needs every item",
    );
    expect(skill).toContain("each item moves on the moment it is ready");
    expect(skill).toContain("**Decide, at every hand-off, how an item leaves its stage:**");
    expect(skill).toContain("a join, with a comment saying what needs every item");
    // §2 lists it among the topology decisions, §3 puts it on the pre-handover checklist.
    expect(skill).toContain("**Where each item goes next.**");
    expect(skill).toContain("at every `Promise.all`\nask whether the next step needs every item");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("**Start with the pipeline shapes.**");
    expect(patterns).toContain("## 6. Staged handoff with typed results");
    // The routing pattern (#13) used to be two barriers: triage everything, then answer
    // everything. Triage and answer map one to one, so they are chained per item.
    expect(patterns).not.toContain('phase("Decide which model each question needs")');
    expect(patterns).toContain(
      'phase("Route each question to the model it needs and answer it there")',
    );
  });

  // docs/dynamic-workflow/authoring.md "Choosing a model per subagent": two spellings and one
  // routing pattern, pinned once in the skill body and once in patterns.md; the routing script
  // itself carries `<!-- compile -->` and is verified by the compile guard below.
  it("teaches the per-subagent model: a literal, a model() table, and routing by a typed key", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Per-subagent model**");
    expect(skill).toContain('agent("judge", { model: "GLM-5.3-Flash" })');
    expect(skill).toContain("`ListModels`");
    expect(skill).toContain("(`patterns.md` #13)");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("## 13. Model routing");
    expect(patterns).toContain("model: MODELS[route.tier]");
  });

  it("does not leak the other Workflow API's vocabulary", async () => {
    // These identifiers belong to another Workflow tool API, not to this facade. If they leak in,
    // the script fails to compile, and the diagnostic only says "cannot find pipeline", which reads
    // like the facade is missing a feature rather than "you remembered the wrong API".
    const foreign = [
      /\bpipeline\(/,
      /\bparallel\(/,
      // docs/dynamic-workflow/authoring.md: dwf's own facade no longer has budget either; the
      // whole word must not appear.
      /\bbudget\b/i,
      /\bagentType\b/,
      /\bisolation:/,
      /\beffort:/,
      /\bschema:/,
    ];
    for (const { name, text } of await readAllContent()) {
      for (const pattern of foreign) {
        expect(text, `${name}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("uses phase() in the dwf marker form, never the other Workflow API's", async () => {
    // `phase(` used to be in the foreign list above (both APIs have phase); after dwf added stage
    // annotation it became a real facade member, the blacklist turned into a false positive, and it
    // locked out the only grouping teaching surface. Replaced with a positive assertion: any
    // occurrence must be the marker form `phase("literal")`. The call shapes of the two APIs are
    // nearly identical, so the real discriminating power lives elsewhere — the sibling foreign
    // entries (pipeline/parallel/schema:...) remain, and the compile guard below makes any non-dwf
    // phase usage explode on a real compiler.
    for (const { name, text } of await readAllContent()) {
      for (const [call] of text.matchAll(/\bphase\([^)]*\)/g)) {
        expect(call, `${name}: ${call}`).toMatch(/^phase\("[^"]+"\)$/);
      }
    }
  });

  // docs/dynamic-workflow/authoring.md "The skill": the gate must match the task's acceptance
  // criteria in scale — survey the repository's check surface first, let the fastest tier drive
  // the loop, and let the strongest tier decide the exit; the examples themselves must not be weak
  // gates (§8 gating only cargo test, examples #4 treating `lake env lean` as a real checker).
  it("teaches gate adequacy: survey the repository's checks, strongest tier decides the exit", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Choose the gate before you write it.**");
    expect(skill).toContain("**Gate at the task's scale.**");
    expect(skill).toContain("Run the end-to-end suite once before handing over");
    // §8's optimization loop: unit tests drive the rounds and the bench decides the winner,
    // instead of measuring a baseline once and never testing again.
    expect(skill).toContain('phase("Measure whether it is actually faster")');
    expect(skill).not.toContain('phase("Verify it actually works")');

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain('!check.stderr.includes("sorry")');
    expect(patterns).toContain("Build the whole project once before handing over");

    const examples = await readSkillFile("examples.md");
    expect(examples).toContain("Run the whole test suite once over the migrated tree");
    expect(examples).toContain("Build the whole project with the new proof");
    expect(examples).toContain("Run the property tests for real");
  });

  // docs/dynamic-workflow/authoring.md "The skill": an explicit workflow request defaults to
  // depth, findings must go through independent confirmation with unconfirmed ones keeping their
  // label, and the final return value takes the report shape. All three are textual guards that
  // keep the next polish from rubbing the rebalance away.
  it("teaches verify-before-report, the unconfirmed label, and the report shape", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("## The bar: first-class, expert-level work");
    expect(skill).toContain("## 3. Fresh eyes");
    expect(skill).toContain("Ask for failures, not approval.");
    expect(skill).toContain("An explicit workflow request is a request for depth");
    expect(skill).toContain(
      "**Verify before you report, in proportion to what a wrong claim costs.**",
    );
    expect(skill).toContain("`unconfirmed`");
    expect(skill).toContain("interface WorkflowReport");
    expect(skill).toContain("notCovered");
    expect(skill).not.toContain("not to your ambition");

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("confirmer-");
    const examples = await readSkillFile("examples.md");
    expect(examples).toContain("conclusion:");
    expect(examples).toContain("notCovered:");
  });

  // docs/dynamic-workflow/authoring.md "The skill": verification proportional to cost, per-item
  // streaming between stages instead of uniform Promise.all barriers, and stopping to repair
  // mid-run when the script turns out to be wrong. All three used to be behaviors the skill itself
  // taught against (72 local runs: 0 scripts streamed per item, 37 set a full barrier before the
  // verification stage, 0 repairs of a cancelled predecessor), so this pins both the new wording
  // and the old example (review every file first, then confirm every finding) staying gone.
  it("teaches proportional verification, per-item streaming, and mid-run repair (amendment 10)", async () => {
    const skill = await readSkillFile("SKILL.md");
    // Since 2026-09-30 §7 is framed as "pipeline by default" (see the previous case); the per-item
    // chaining rule lives in the **Chaining.** paragraph.
    expect(skill).toContain(
      "## 7. Pipeline by default; join only where the next step needs every item",
    );
    expect(skill).toContain("**Chaining.** When two stages map one to one");
    expect(skill).toContain("**Not inside a concurrent fan-out callback.**");
    expect(skill).toContain("Three things that look like verification and are waste.");
    expect(skill).toContain("**Repair a run while it is still going.**");
    expect(skill).toContain("`Promise.allSettled`");
    // The complete example (in examples.md §5 since 2026-09-21) streams per item: confirmers
    // chain after the review of their own file, with path and index in the name; the old
    // barrier-style stage name is gone. SKILL.md §11 only points there.
    expect(skill).toContain("## 11. A complete example");
    expect(skill).toContain("`${ZCODE_SKILL_DIR}/examples.md` §5");
    const movedExample = await readSkillFile("examples.md");
    expect(movedExample).toContain("## 5. Changed-file review with confirmation as reviews land");
    expect(movedExample).toContain("confirmer-${p}-${index}");
    expect(movedExample).not.toContain('phase("Confirm each kept finding independently and report it")');
    // The outdated cache-gating wording (the tool tier retired on 2026-09-12) must not come back.
    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/first subagent with tools/i);
    }

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("## 10. Per-item pipeline");
    expect(patterns).toContain("A queue is not a barrier");
    const examples = await readSkillFile("examples.md");
    expect(examples).toContain(
      'phase("Judge each candidate and confirm the real ones as they are judged")',
    );
    expect(examples).not.toContain('phase("Confirm each survivor by reproducing it")');
  });

  // Script files (docs/dynamic-workflow/launch.md "Script files"): every submitted script has a
  // file on disk — the tool writes inline scripts to `.zcode/workflow-drafts/<slug>.dwf.ts`,
  // diagnostics come back as file line numbers, and every later revision is "edit that file +
  // resubmit with `path`". These three sentences are load-bearing and must be in the skill
  // verbatim: the moment the model goes back to repasting the whole script, it hits two measured
  // costs at once — re-streaming a script of roughly twenty thousand tokens gets stuck on some
  // providers, and when a run actually fails the script body has often already been dropped from
  // context by compaction, leaving only the file.
  it("teaches the script-file loop: edit the file, resubmit by path", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain(".zcode/workflow-drafts/");
    expect(skill).toContain("{path}:L{line}:C{column} {message}");
    expect(skill).toContain(
      "**Edit that file and resubmit with `path`. Do not paste the script inline again**",
    );
    // A failed run is revised through the file the same way: the notification and GetWorkflowRun
    // give the scriptPath, and AmendWorkflow takes path.
    expect(skill).toContain("edit the run's script file, which the notification names,");
    expect(skill).toContain("**Every run remembers its script file, so a revision is an `Edit`.**");
    expect(skill).toContain("`scriptPath`");
    expect(skill).toContain("`script_unchanged`");
    // The drafts directory is approval-free; otherwise the model assumes editing the file also
    // waits for the user to confirm, and goes back to pasting the script.
    expect(skill).toContain("**Editing a draft asks nothing.**");
    // The second source for EvalWorkflowSnippet.
    expect(skill).toContain("or as `path` to a file holding it");
    // The old "start over with the whole script" wording must not flow back.
    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/call\s+`CreateWorkflow` again/);
      expect(text, name).not.toMatch(/resubmit with `AmendWorkflow`\./);
    }
  });

  // 2026-09-07 user ruling (docs/dynamic-workflow/authoring.md "The skill"): user-visible text is
  // taught as the single principle "say it like you would tell a colleague" plus paired English/
  // Chinese examples, without a banned-word list. Also pins one correction: the analyzer has no
  // "out-of-order asks on the same subagent" warning (diagnostics 9001/9003/9004/9005/9006), so the
  // skill must no longer claim the compiler warns. 2026-09-08 user testing: the model translated
  // the skill's "cold read" / "fresh eyes" literally into Chinese and put them into stage names and
  // subagent names. The body now says independent read, the §9 table gained paired examples, and
  // the example subagent is no longer named cold-reviewer.
  it("teaches writing for the user, and does not claim an analyzer warning", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toMatch(/^## \d+\. Write for the user$/m);
    expect(skill).toContain("文件评审阶段");
    expect(skill).toContain("The language travels through your asks");
    expect(skill).toContain("独立评审员");
    expect(skill).toContain("冷读方案");

    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/compiler warns/i);
      // The table's Not column deliberately keeps these two words as counterexamples; only the
      // body outside the table is checked.
      expect(text.replace(/^\| .*$/gm, ""), name).not.toMatch(/cold[- ]read|cold-reviewer/i);
    }
  });

  it("names CreateWorkflow explicitly wherever it routes", async () => {
    // The legacy script/expert `Workflow` tool still exists (core/src/tool/handlers/workflow.ts)
    // and shares the word "workflow" with dwf. So the body must name CreateWorkflow and must not
    // say "the workflow tool".
    for (const { name, text } of await readAllContent()) {
      expect(text, name).toContain("CreateWorkflow");
      expect(text, name).not.toMatch(/\bthe workflow tool\b/i);
    }
  });

  // The strongest guard: example scripts go through the real compiler. Identifier matching only
  // proves "the name exists"; compiling proves "this script actually runs". Only blocks explicitly
  // marked `<!-- compile -->` are checked — the patterns.md snippets deliberately omit interface
  // declarations and are not complete scripts; a heuristic ("has return, so compile it") to tell
  // them apart would sooner or later wave a real error through as a snippet.
  it("compiles every script block marked as complete", async () => {
    const marked: { file: string; index: number; source: string }[] = [];
    for (const { name, text } of await readAllContent()) {
      const blocks = [...text.matchAll(/<!-- compile -->\n```ts\n([\s\S]*?)```/g)];
      blocks.forEach((match, index) => {
        marked.push({ file: name, index, source: match[1] });
      });
    }

    // SKILL.md's complete example + §9's report shape + §9's artifact publishing example +
    // examples.md's four scripts. Dropping below 6 means a marker was deleted by mistake — that
    // would let this guard silently degrade into an empty assertion. History of the floor:
    // 4 (initial) → 5 (Amendment 1's world.run example) → 6 (Amendment 6's artifact example).
    expect(marked.length).toBeGreaterThanOrEqual(6);

    for (const { file, index, source } of marked) {
      const result = compileWorkflowScript(source);
      expect(result.diagnostics, `${file} block #${index}`).toEqual([]);
      expect(result.ok, `${file} block #${index}`).toBe(true);
      // Compiling only runs typecheck; it cannot see the authoring diagnostics (world.run
      // literals, phase marker form, duplicate actor names / static fan-out names). The
      // CreateWorkflow / SaveWorkflow handlers run analyzeScript first and reject submission on
      // `!ok` — so "the example compiles" did not imply "the model can submit what it copies".
      // After 2026-08-31 amend-resume made the actor name the unique identity key, this seam
      // really did leak: every fan-out in the skill wrote `agent("reviewer")`, all hitting 9006.
      // Only with this extra pass does the guard line up with the real submission gate.
      const analyzed = analyzeWorkflowScript(source);
      expect(analyzed.diagnostics, `${file} block #${index} (analyze)`).toEqual([]);
      expect(analyzed.ok, `${file} block #${index} (analyze)`).toBe(true);
    }
  });
});

/**
 * The gray gate (docs/dynamic-workflow/launch.md "Gray release") locates skill assets by
 * **directory name**, and renaming inside the skill pack produces no type error, so the gate would
 * silently stop working. This pins the names to the real files.
 */
describe("gray release gate names stay pinned to the real bundled assets", () => {
  function bundledRoots(): SkillRoot[] {
    return resolveBundledSkillRoots({ cliStorageRoot: join(tmpdir(), "zcode-unused-cli-storage") });
  }

  it("内置技能包解析到真实的 skills 目录，且剔除路径正好落在 dynamic-workflows SKILL.md 上", () => {
    const roots = bundledRoots();
    expect(roots).toEqual([
      {
        path: join(PACK_ROOT, "skills"),
        priority: expect.any(Number),
        scope: "system",
        source: "bundled",
      },
    ]);
    expect(collectDynamicWorkflowDisabledSkillPaths(roots)).toEqual([join(SKILL_DIR, "SKILL.md")]);
  });

  /**
   * Runs the real NodeSkillAdapter end to end, reproducing create-app's wiring: the bundled skill
   * root and the plugin skill root side by side, with the adapter comparing disabledPaths against
   * SKILL.md absolute paths during discovery. If any assumption fails, this case goes red
   * immediately instead of the gray gate silently breaking.
   */
  describe("real NodeSkillAdapter discovery", () => {
    const guidePluginRoot: SkillRoot = {
      path: GUIDE_PLUGIN_SKILLS_ROOT,
      priority: 0,
      scope: "system",
      source: "plugin",
    };

    async function discoveredSkills(
      disabledPaths: string[],
    ): Promise<Array<{ name: string; source: string }>> {
      const adapter = createNodeSkillAdapter({ disabledPaths });
      const outcome = await adapter.discoverSkills({
        workingDirectory: PACK_ROOT,
        roots: [guidePluginRoot, ...bundledRoots()],
      });
      return outcome.skills.map((skill) => ({ name: skill.name, source: skill.source }));
    }

    it("灰度开启（无门禁路径）时目录里有 dynamic-workflows，且来源是 bundled", async () => {
      await expect(discoveredSkills([])).resolves.toContainEqual({
        name: SKILL_NAME,
        source: "bundled",
      });
    });

    it("灰度关闭时 dynamic-workflows 消失，插件技能仍在", async () => {
      const skills = await discoveredSkills(
        collectDynamicWorkflowDisabledSkillPaths(bundledRoots()),
      );
      const names = skills.map((skill) => skill.name);
      expect(names).not.toContain(SKILL_NAME);
      // Converse assertion: the gate removes exactly one SKILL.md; the other roots are not taken
      // down with it.
      expect(names).toContain("zcode-configuration-guide");
      expect(names.length).toBeGreaterThan(1);
    });
  });
});
