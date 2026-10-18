import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  HookEventName,
  SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSubmitRequest,
  type ListSavedWorkflowsOutput,
  type PermissionBrokerPort,
  type PermissionRequestedPayload,
  type SaveWorkflowOutput,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { saveWorkflowToolEntry } from "../src/tool/handlers/save-workflow.js";
import { listSavedWorkflowsToolEntry } from "../src/tool/handlers/list-saved-workflows.js";
import { builtInTools } from "../src/tool/handlers/index.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunner } from "../src/hooks/index.js";

const cwds: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-tools-"));
  cwds.push(dir);
  return dir;
}

/** An isolated home directory for the global-archive cases to inject. */
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-tools-home-"));
  cwds.push(dir);
  return dir;
}

// The production global root comes from os.homedir() (which honors $HOME on POSIX). The handler takes no
// homeDir, so HOME is pointed at an empty temp directory, making the global archive's destination and the
// "nowhere at all" error text controllable and reproducible in tests.
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let testHome: string;
beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  testHome = makeHome();
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (cwds.length > 0) rmSync(cwds.pop()!, { force: true, recursive: true });
});

/** Global archive destination (HOME has been pointed at testHome by beforeEach). */
function globalSavedPath(name: string): string {
  return join(testHome, ".zcode/workflows", `${name}.dwf.ts`);
}

// The memory slot is single-slot and keyed by the script's verbatim text, so every case uses its own script;
// otherwise the analysis stored by the previous case would directly satisfy the next case's assertions.
function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

interface RunOptions {
  broker?: PermissionBrokerPort;
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  hookRunner?: HookRunner;
  input: Record<string, unknown>;
  name: string;
  toolName: string;
  workingDirectory: string;
}

interface RunOutcome {
  events: SessionEvent[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

function stubRunPort(runId: string): {
  port: DynamicWorkflowRunPort;
  submits: DynamicWorkflowRunSubmitRequest[];
} {
  const submits: DynamicWorkflowRunSubmitRequest[] = [];
  return {
    port: {
      async submit(request) {
        submits.push(request);
        // submit's result is a discriminated union (amend-resume's three gates can reject a submission); the stub always accepts.
        return { ok: true, runId };
      },
    } as unknown as DynamicWorkflowRunPort,
    submits,
  };
}

async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];

  const registry = createToolRegistry();
  registry.register(createWorkflowToolEntry);
  registry.register(saveWorkflowToolEntry);
  registry.register(listSavedWorkflowsToolEntry);

  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.dynamicWorkflowRunPort
      ? { dynamicWorkflowRunPort: options.dynamicWorkflowRunPort }
      : {}),
    ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
    mode: "build",
    permissionBroker: options.broker ?? {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: options.workingDirectory,
  });

  const result = await executor.execute(
    { id: createToolCallId(options.name), input: options.input, name: options.toolName },
    { traceContext },
  );

  return {
    events,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

const DENY: PermissionBrokerPort = {
  async requestPermission() {
    return { decision: "deny", reason: "User declined" };
  },
};

function savedPath(cwd: string, name: string): string {
  return join(cwd, ".zcode/workflows", `${name}.dwf.ts`);
}

describe("SaveWorkflow", () => {
  it("writes the file after the confirmation, with the metadata block ahead of the script", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-clean");

    const outcome = await run({
      input: {
        name: "pr-review",
        description: "Review a pull request",
        whenToUse: "When the user asks for a PR review",
        args: { pr: { type: "string", required: true, description: "PR number" } },
        script,
        scope: "project",
      },
      name: "save-clean",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(true);

    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.overwritten).toBe(false);
    expect(output.scope).toBe("project");
    expect(output.path).toBe(savedPath(cwd, "pr-review"));

    // Byte-for-byte: the script body is the basis of the run's script_hash; serialization must not normalize it in passing.
    expect(readFileSync(output.path, "utf8")).toBe(
      [
        "/* zcode-workflow",
        "description: Review a pull request",
        "whenToUse: When the user asks for a PR review",
        "args:",
        "  pr:",
        "    type: string",
        "    description: PR number",
        "    required: true",
        "*/",
        script,
      ].join("\n"),
    );
  });

  // Normalization (c): everything the confirmation window needs to show lives in the **input**; display adds
  // not a single field. The input channel is a schema-less passthrough for every client version, so old
  // desktops and legacy v3 also get the full content.
  it("asks with no display, carrying path/overwrite/scope and the full script in the input", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-preview");

    const outcome = await run({
      input: { name: "preview", description: "shows up in the window", script, scope: "project" },
      name: "save-preview",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    const payload = outcome.permissionRequested[0]!;
    expect(payload.display).toBeUndefined();
    // Persistent project rules cannot remember "this one decision"; they would only turn this confirmation off permanently.
    expect(payload.optionsPolicy).toBe("no-always-allow");
    expect(payload.input).toEqual({
      name: "preview",
      description: "shows up in the window",
      script,
      scope: "project",
      path: savedPath(cwd, "preview"),
      overwrite: false,
    });
  });

  // "Overwrite" and "create" must be two different statements in the window: approving an overwrite once is consenting to discard the copy on disk.
  it("flags an overwrite in the gate input when the name is already taken", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({ cwd, name: "taken", meta: { description: "old" }, script: "return 1;" });

    const outcome = await run({
      input: {
        name: "taken",
        description: "new",
        script: cleanScript("save-overwrite"),
        scope: "project",
      },
      name: "save-overwrite",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { overwrite: boolean }).overwrite).toBe(true);
    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.overwritten).toBe(true);
    expect(readFileSync(output.path, "utf8")).toContain("description: new");
  });

  // Asking the user to approve code that cannot compile would only interrupt the fix loop with a decision that has no effect.
  it("returns diagnostics for a broken script without asking and without writing", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "broken",
        description: "will not compile",
        script: 'const x: number = "s";',
        scope: "project",
      },
      name: "save-broken",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.overwritten).toBeUndefined();
    expect(existsSync(savedPath(cwd, "broken"))).toBe(false);
  });

  it("rejects an unusable name before the gate and without touching the disk", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "../evil",
        description: "traversal",
        script: cleanScript("save-traversal"),
        scope: "project",
      },
      name: "save-traversal",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("not a usable workflow name");
    expect(existsSync(join(cwd, ".zcode"))).toBe(false);
  });

  // encode's idempotency (the file never carries more than one frontmatter block) is guarded here: no clever
  // "replace when detected" merging, otherwise the model could not tell which of its own metadata versus the
  // file's takes effect.
  it("rejects a script that already carries a metadata block", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "double",
        description: "already has frontmatter",
        script: `/* zcode-workflow\ndescription: smuggled\n*/\n${cleanScript("save-sentinel")}`,
        scope: "project",
      },
      name: "save-sentinel",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toBe(SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR);
    expect(existsSync(savedPath(cwd, "double"))).toBe(false);
  });

  it("writes nothing when the confirmation is denied", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      broker: DENY,
      input: {
        name: "denied",
        description: "not this time",
        script: cleanScript("save-deny"),
        scope: "project",
      },
      name: "save-deny",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(existsSync(savedPath(cwd, "denied"))).toBe(false);
  });

  // The scope is model-required: no default; the schema rejects outright.
  it("fails schema validation when scope is omitted", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "no-scope",
        description: "missing scope",
        script: cleanScript("save-no-scope"),
      },
      name: "save-no-scope",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(existsSync(savedPath(cwd, "no-scope"))).toBe(false);
  });

  // Global archive: the destination is under the injected HOME; resolveInput picks the root by scope to compute it.
  it("backfills the global path and writes under the home dir for scope global", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-global");

    const outcome = await run({
      input: { name: "research", description: "deep research", script, scope: "global" },
      name: "save-global",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toEqual({
      name: "research",
      description: "deep research",
      script,
      scope: "global",
      path: globalSavedPath("research"),
      overwrite: false,
    });

    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.scope).toBe("global");
    expect(output.path).toBe(globalSavedPath("research"));
    expect(output.response).toContain("Saved global workflow 'research'");
    // Not a single byte of the project directory was created.
    expect(existsSync(join(cwd, ".zcode"))).toBe(false);
    expect(existsSync(globalSavedPath("research"))).toBe(true);
  });

  // shadowing backfill hides_global: saving a project archive while the global archive already has the same name.
  it("backfills shadowing=hides_global when a global copy already exists", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global one" },
      script: "return 1;",
      scope: "global",
    });

    const outcome = await run({
      input: {
        name: "dup",
        description: "project one",
        script: cleanScript("save-shadow-p"),
        scope: "project",
      },
      name: "save-shadow-project",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { shadowing?: string }).shadowing).toBe(
      "hides_global",
    );
  });

  // shadowing backfill hidden_by_project: saving a global archive while the project archive already has the same name.
  it("backfills shadowing=hidden_by_project when a project copy already exists", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project one" },
      script: "return 1;",
    });

    const outcome = await run({
      input: {
        name: "dup",
        description: "global one",
        script: cleanScript("save-shadow-g"),
        scope: "global",
      },
      name: "save-shadow-global",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { shadowing?: string }).shadowing).toBe(
      "hidden_by_project",
    );
  });

  // With no name collision the shadowing key is absent (no noise fields attached).
  it("omits the shadowing key when no other scope has the name", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "solo",
        description: "unique",
        script: cleanScript("save-solo"),
        scope: "project",
      },
      name: "save-solo",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect("shadowing" in (outcome.permissionRequested[0]!.input as object)).toBe(false);
  });
});

describe("ListSavedWorkflows", () => {
  it("lists definitions with their arguments and never the script body", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "triage",
      meta: {
        description: "Triage the inbox",
        whenToUse: "Every morning",
        args: { limit: { type: "number", default: 10 } },
      },
      script: cleanScript("list-triage"),
    });

    const outcome = await run({
      input: {},
      name: "list-saved",
      toolName: "ListSavedWorkflows",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    const output = outcome.result.output as ListSavedWorkflowsOutput;
    expect(output.workflows).toHaveLength(1);
    expect(output.workflows[0]!.name).toBe("triage");
    expect(output.invalid).toBeUndefined();

    const modelContent = String(outcome.result.modelContent ?? "");
    expect(modelContent).toContain('name="triage"');
    expect(modelContent).toContain("Triage the inbox");
    expect(modelContent).toContain("arg limit (number, default 10)");
    expect(modelContent).not.toContain("agent(");
  });

  it("says so in a sentence when the project has no saved workflows", async () => {
    const outcome = await run({
      input: {},
      name: "list-saved-empty",
      toolName: "ListSavedWorkflows",
      workingDirectory: makeCwd(),
    });

    expect((outcome.result.output as ListSavedWorkflowsOutput).workflows).toEqual([]);
    expect(String(outcome.result.modelContent ?? "")).toContain("No workflows are saved");
  });

  // The same convergence as ListWorkflowRuns: the tool always checks the session's working directory; the model has no authority to scan across projects.
  it("rejects a cwd input outright", async () => {
    const outcome = await run({
      input: { cwd: "/etc" },
      name: "list-saved-cwd",
      toolName: "ListSavedWorkflows",
      workingDirectory: makeCwd(),
    });

    expect(outcome.result.success).toBe(false);
  });
});

describe("CreateWorkflow saved source", () => {
  it("normalizes the gate input to the resolved script, the saved name and the checked args", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-happy");
    saveSavedWorkflow({
      cwd,
      name: "nightly",
      meta: { description: "nightly triage", args: { depth: { type: "number", default: 3 } } },
      script,
    });
    const { port, submits } = stubRunPort("dwfrun-saved");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "nightly" } },
      name: "create-saved-happy",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    // The heart of normalization (b): old desktops' readWorkflowScript(raw.script) / readWorkflowName(raw.name)
    // read exactly these two keys — their hits hold **by construction**, not as a compatibility shim.
    expect(outcome.permissionRequested[0]!.input).toEqual({
      name: "nightly",
      script,
      saved: {
        name: "nightly",
        args: { depth: 3 },
        path: savedPath(cwd, "nightly"),
        scope: "project",
        // The working copy is written during resolveInput along with this read (docs/dynamic-workflow/launch.md
        // "Script files"): what the model edits is this copy; the saved definition is not touched by a single character.
        draft: join(cwd, WORKFLOW_DRAFTS_DIR, "nightly.dwf.ts"),
      },
      // The copy carries the metadata block, so diagnostics' file lines must skip the block's lines.
      script_line_offset: expect.any(Number),
      // Settings adjustable in the confirmation window (docs/dynamic-workflow/launch.md "Adjusting the settings
      // in the window"): the stub run port has no model catalog and reports no ceiling, so only the lower
      // bound is adjustable, with no upper limit.
      adjustable_settings: { subagent_model: false },
    });
    

    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.scriptText).toBe(script);
    expect(submits[0]!.name).toBe("nightly");
    // The args take the same metadata path as name / scriptText, land in dwf_run.args_json, and are injected into the sandbox.
    expect(submits[0]!.args).toEqual({ depth: 3 });
  });

  // The pin of invariant 8: the display produced via saved and via inline must be byte-identical; this feature adds not a single field.
  it("produces a display byte-identical to the same script run inline", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-parity");
    saveSavedWorkflow({ cwd, name: "parity", meta: { description: "parity" }, script });
    const { port } = stubRunPort("dwfrun-parity");

    const viaSaved = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "parity" } },
      name: "create-parity-saved",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    const viaInline = await run({
      dynamicWorkflowRunPort: port,
      input: { script },
      name: "create-parity-inline",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const savedDisplay = viaSaved.permissionRequested[0]!.display;
    expect(savedDisplay).toEqual(viaInline.permissionRequested[0]!.display);
    expect(Object.keys(savedDisplay as object).sort()).toEqual([
      "causalityGraph",
      "diagnostics",
      "errorCount",
      "kind",
      "ok",
    ]);
  });

  // Normalization (e): policy is not bypassed by saving. A PreToolUse hook scanning the script must see the
  // real script on a saved run — otherwise saving becomes a policy blind spot.
  it("gives PreToolUse hooks the resolved script, not just the saved name", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-hook");
    saveSavedWorkflow({ cwd, name: "policed", meta: { description: "policed" }, script });
    const seen: unknown[] = [];
    const hookRunner: HookRunner = {
      async run(input) {
        if (input.hookEventName === HookEventName.PreToolUse) {
          seen.push((input as unknown as { toolInput?: unknown }).toolInput);
        }
        return { additionalContexts: [] };
      },
    };

    await run({
      dynamicWorkflowRunPort: stubRunPort("dwfrun-hook").port,
      hookRunner,
      input: { saved: { name: "policed" } },
      name: "create-saved-hook",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { script?: string }).script).toBe(script);
  });

  // Invariant 5: confirmation and execution use the same bytes. Parsing happens once; after approval there is no further disk read.
  it("runs the bytes shown at the gate even if the file changes after resolution", async () => {
    const cwd = makeCwd();
    const approved = cleanScript("saved-toctou");
    saveSavedWorkflow({ cwd, name: "swapped", meta: { description: "swapped" }, script: approved });
    const { port, submits } = stubRunPort("dwfrun-toctou");

    const outcome = await run({
      broker: {
        async requestPermission() {
          // While the user was thinking, the file on disk got swapped out.
          saveSavedWorkflow({
            cwd,
            name: "swapped",
            meta: { description: "swapped" },
            script: cleanScript("saved-toctou-evil"),
          });
          return { decision: "allow" };
        },
      },
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "swapped" } },
      name: "create-saved-toctou",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.result.success).toBe(true);
    expect(submits[0]!.scriptText).toBe(approved);
    expect(submits[0]!.scriptText).not.toContain("saved-toctou-evil");
  });

  it("lets an explicit name override the saved name as the run label", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "generic",
      meta: { description: "generic" },
      script: cleanScript("saved-label"),
    });
    const { port, submits } = stubRunPort("dwfrun-label");

    await run({
      dynamicWorkflowRunPort: port,
      input: { name: "tuesday run", saved: { name: "generic" } },
      name: "create-saved-label",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(submits[0]!.name).toBe("tuesday run");
  });

  // Bad arguments contain nothing worth a user ruling: popping a window destined to fail only interrupts the model's fix loop.
  it("rejects bad arguments before the gate, naming the declaration", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "strict-args",
      meta: {
        description: "takes args",
        args: { pr: { type: "string", required: true, description: "PR number" } },
      },
      script: cleanScript("saved-bad-args"),
    });
    const { port, submits } = stubRunPort("dwfrun-bad-args");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "strict-args", args: { pull: "42" } } },
      name: "create-saved-bad-args",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("unknown argument 'pull'");
    expect(message).toContain("missing required argument 'pr'");
    // Restating the declaration lets the model fix it in one pass instead of guessing another round.
    expect(message).toContain("PR number");
  });

  // After a mistyped name, the most useful next-step information is the correct list of names.
  it("names the available workflows when the requested one does not exist", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "actual",
      meta: { description: "the real one" },
      script: cleanScript("saved-missing"),
    });
    const { port, submits } = stubRunPort("dwfrun-missing");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "typo" } },
      name: "create-saved-missing",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("No saved workflow named 'typo'");
    expect(message).toContain("Available saved workflows: actual");
  });

  it("points at SaveWorkflow when the project has no saved workflows at all", async () => {
    const outcome = await run({
      input: { saved: { name: "anything" } },
      name: "create-saved-none",
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });

    expect(outcome.result.error?.message ?? "").toContain("no saved workflows yet");
  });

  // saved.scope direction: with the same name in both archives, specifying global skips the shadow and runs the global copy.
  it("takes the global copy when saved.scope is global despite a project shadow", async () => {
    const cwd = makeCwd();
    const projectScript = cleanScript("saved-scope-project");
    const globalScript = cleanScript("saved-scope-global");
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project" },
      script: projectScript,
    });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: globalScript,
      scope: "global",
    });
    const { port, submits } = stubRunPort("dwfrun-scope-global");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "dup", scope: "global" } },
      name: "create-saved-scope-global",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const gateSaved = (
      outcome.permissionRequested[0]!.input as { saved: { scope: string; path: string } }
    ).saved;
    expect(gateSaved.scope).toBe("global");
    expect(gateSaved.path).toBe(globalSavedPath("dup"));
    expect(submits[0]!.scriptText).toBe(globalScript);
  });

  // The default is first-wins: with the same name in both archives, the project archive shadows the global one and the project copy runs.
  it("takes the project copy by default when both scopes carry the name", async () => {
    const cwd = makeCwd();
    const projectScript = cleanScript("saved-default-project");
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project" },
      script: projectScript,
    });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: cleanScript("saved-default-global"),
      scope: "global",
    });
    const { port, submits } = stubRunPort("dwfrun-scope-default");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "dup" } },
      name: "create-saved-scope-default",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const gateSaved = (outcome.permissionRequested[0]!.input as { saved: { scope: string } }).saved;
    expect(gateSaved.scope).toBe("project");
    expect(submits[0]!.scriptText).toBe(projectScript);
  });

  // A directed miss: the message says "not in this scope" and lists the available names of both archives (with labels).
  it("names the scope and lists both archives when a directed lookup misses", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "in-project",
      meta: { description: "p" },
      script: cleanScript("saved-directed-p"),
    });
    saveSavedWorkflow({
      cwd,
      name: "in-global",
      meta: { description: "g" },
      script: cleanScript("saved-directed-g"),
      scope: "global",
    });

    const outcome = await run({
      input: { saved: { name: "ghost", scope: "global" } },
      name: "create-saved-directed-miss",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("No global workflow named 'ghost'");
    expect(message).toContain("in-project (project)");
    expect(message).toContain("in-global (global)");
  });

  it("surfaces a hand-broken metadata block as a fixable file, not a missing workflow", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "mangled",
      meta: { description: "fine" },
      script: cleanScript("saved-mangled"),
    });
    writeFileSync(savedPath(cwd, "mangled"), "return 1;\n", "utf8");

    const outcome = await run({
      input: { saved: { name: "mangled" } },
      name: "create-saved-mangled",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("could not be read");
    expect(message).toContain("hand-edited");
  });

  // A saved definition failing to compile is **its** problem; without naming the file the model would think it wrote the script wrong and retry it unchanged.
  it("blames the saved file when the stored script no longer compiles", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "rotten",
      meta: { description: "was fine once" },
      script: 'const rotten: number = "not a number";',
    });
    const { port, submits } = stubRunPort("dwfrun-rotten");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "rotten" } },
      name: "create-saved-rotten",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.response).toContain("The saved workflow 'rotten'");
    expect(output.response).toContain(savedPath(cwd, "rotten"));
    // After this change the path also has a file to edit: the copy's destination is named, diagnostics are
    // reported against the **copy's file lines**, while editing the definition itself still goes through
    // SaveWorkflow (docs/dynamic-workflow/launch.md "Script files").
    const draft = join(WORKFLOW_DRAFTS_DIR, "rotten.dwf.ts");
    expect(output.response).toContain(`A working copy of the saved workflow 'rotten'`);
    expect(output.response).toContain(`was written to ${draft}`);
    expect(output.response).toContain("use SaveWorkflow");
    // The body's line 1 diagnostic = file line 4 (opening marker + description + closing line).
    expect(output.diagnostics[0]!.line).toBe(1);
    expect(output.response).toContain(`${draft}:L4:C7`);
  });

  // Zero regression on the inline path: the model-written fields stay byte-for-byte unchanged (resolveInput only adds the adjustable-settings resolution fact), and no disk operation is performed.
  it("leaves the inline path byte-for-byte untouched", async () => {
    const cwd = makeCwd();
    const script = cleanScript("inline-regression");
    const { port, submits } = stubRunPort("dwfrun-inline");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { script },
      name: "create-inline",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested[0]!.input).toEqual({
      script,
      adjustable_settings: { subagent_model: false },
    });
    expect(submits[0]!.scriptText).toBe(script);
    expect("name" in submits[0]!).toBe(false);
    expect("args" in submits[0]!).toBe(false);
    // Normalization is still the identity function — the input the confirmation window sees is byte-for-byte
    // the one the model sent (the assertion above).
    // The only new thing on disk is the draft the handler writes: the script's home, which the model uses as
    // `path` next time (docs/dynamic-workflow/launch.md "Script files").
    const draft = join(cwd, WORKFLOW_DRAFTS_DIR, "workflow.dwf.ts");
    expect(readFileSync(draft, "utf8")).toBe(script);
    expect(submits[0]!.scriptPath).toBe(draft);
    expect(existsSync(join(cwd, ".zcode", "workflows"))).toBe(false);
  });

  it.each([
    ["neither", {}],
    ["both", { script: "return 1;", saved: { name: "x" } }],
  ])("ends a %s-source call before the gate with one actionable message", async (label, input) => {
    const outcome = await run({
      input,
      name: `create-source-${label}`,
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain(CREATE_WORKFLOW_SOURCE_ERROR);
  });
});

describe("CreateWorkflow input schema", () => {
  // The XOR is deliberately **not** in the schema: a normalized input carrying both script and saved is a
  // legitimate execution state. A superRefine would blow up the handler's parse and the post-hook-rewrite
  // re-validation.
  it("accepts the normalized shape carrying both script and saved", () => {
    const parsed = CreateWorkflowInputSchema.safeParse({
      name: "nightly",
      script: "return 1;",
      saved: {
        name: "nightly",
        args: { a: 1 },
        path: "/p/.zcode/workflows/nightly.dwf.ts",
        scope: "project",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects unknown top-level keys", () => {
    expect(CreateWorkflowInputSchema.safeParse({ script: "return 1;", cwd: "/tmp" }).success).toBe(
      false,
    );
  });
});

describe("built-in tool registry", () => {
  it("registers the two new saved-workflow tools", () => {
    const names = builtInTools.map((entry) => entry.metadata.name);
    expect(names).toContain("SaveWorkflow");
    expect(names).toContain("ListSavedWorkflows");
  });

  // SaveWorkflow writes the user's repository: same tier as CreateWorkflow; it must ask first in every permission mode.
  it("gates SaveWorkflow in every permission mode, without an always-allow option", () => {
    expect(saveWorkflowToolEntry.permission?.alwaysAsk).toBe(true);
    expect(saveWorkflowToolEntry.permission?.askOptions?.allowAlways).toBe(false);
    // CreateWorkflow's old "none" was a placeholder-era leftover and should not be copied: this tool really writes files into the workspace.
    expect(saveWorkflowToolEntry.metadata.sideEffectScope).toBe("workspace");
    expect(saveWorkflowToolEntry.permission?.sideEffectScope).toBe("workspace");
  });

  // Listing reads without writing or running: neither of the two gates' justifications (writing the repository / executing code) applies.
  it("leaves ListSavedWorkflows ungated and read-only", () => {
    expect(listSavedWorkflowsToolEntry.metadata.readOnly).toBe(true);
    expect(listSavedWorkflowsToolEntry.metadata.needsApproval).toBe(false);
    expect(listSavedWorkflowsToolEntry.permission?.alwaysAsk).toBeUndefined();
  });

  // Existence of the guidance text (pinning keywords, not verbatim wording).
  it("tells the model to ask before saving, and to consider saved workflows first", () => {
    expect(saveWorkflowToolEntry.metadata.description).toContain(
      "NEVER call this tool unsolicited",
    );
    expect(saveWorkflowToolEntry.metadata.description).toContain(
      "suggest saving it in one sentence and wait",
    );
    expect(createWorkflowToolEntry.metadata.description).toContain("ListSavedWorkflows");
    expect(createWorkflowToolEntry.metadata.description).toContain("exactly one source");
  });
});
