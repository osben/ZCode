#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the W6a driver-rules goldens (rust-cli crate `workflow`, specs/fork-rust-workflow-engine.md section 9.7).
 *
 * Calls Node's own pure driver functions and writes packages/rust-cli/crates/workflow/fixtures/driver-goldens.json:
 * - actor session ids and their question-id fragments (`mintActorSessionId`, `questionIdFragments`);
 * - the nudge prompt, the typed-tool epilogue, the schema epilogue (`JSON.stringify(schema, null, 2)`);
 * - the escalation budget constants and the escalation context and actor name normalisers;
 * - `rejectWith`, `subagentLabel`;
 * - the permission origin description and the recorded permission mode mapping
 *   (`workflow-actor-permission.ts`).
 *
 * The contracts package and the dynamic-workflow index are replaced by generator-only stubs through
 * a tsconfig `paths` map, because the real modules need a build step (generated libs). The stubs are
 * documented in `stubs/`. The run needs TSX_TSCONFIG_PATH, so run it as:
 *
 *   TSX_TSCONFIG_PATH=<repo root>/scripts/rust-cli/tsconfig.workflow-goldens.json \
 *     pnpm --dir <repo root> exec tsx <abs path to this file>
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  effectiveActorName,
  mintActorSessionId,
  normalizeEscalationContext,
  questionIdFragments,
  rejectWith,
  schemaEpilogue,
  subagentLabel,
} from "../../apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-helpers.ts";
import { qualityEpilogue } from "../../apps/zcode-cli/packages/bootstrap/src/app/workflow-ask-epilogue.ts";
import {
  parseWorkflowSubagentPermissionMode,
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
  workflowSubagentPermissionModeOf,
  type WorkflowSubagentPermissionMode,
} from "../../apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-permission.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  here,
  "..",
  "..",
  "packages",
  "rust-cli",
  "crates",
  "workflow",
  "fixtures",
  "driver-goldens.json",
);

type Ref = { siteId: string; ordinal: number };

const runIds = [
  "dwfrun-abc123",
  "dwfrun-abcdefghijklmnop",
  "dwfrun-short",
  "x",
  "",
  "dwfrun-a_b_c",
  "run#1",
  "dwfrun-é-ü",
  "dwfrun-😀x",
  "dwfrun-",
  "dwfrun-.-.-",
];

const actors: Ref[] = [
  { siteId: "plan#1", ordinal: 1 },
  { siteId: "a_b", ordinal: 2 },
  { siteId: "😀", ordinal: 3 },
  { siteId: "x.y-z", ordinal: 10 },
  { siteId: "site", ordinal: 1234567 },
];

const schemas: Array<{ name: string; schema: unknown }> = [
  { name: "absent", schema: undefined },
  { name: "null", schema: null },
  { name: "string", schema: "plain" },
  {
    name: "nested",
    schema: {
      type: "object",
      properties: {
        a: { type: "number", minimum: 0 },
        b: { type: "array", items: [] },
        c: {},
        d: 'é\n"q"',
        e: 1.5,
        f: true,
        g: null,
        h: {},
        i: 1e21,
        j: 123456789012345680000,
        k: 0.1,
      },
      required: [],
    },
  },
  { name: "array", schema: [1, [2, [3]], { z: 1, a: 2 }] },
];

const normalizeInputs: Array<string | undefined> = [
  undefined,
  "",
  "   ",
  " a ",
  " x ",
  "﻿x",
  "\u0085x\u0085",
  "line\n",
  " y ",
];

const personaNames: Array<string | undefined> = [undefined, "", "  ", "Ada", " Ada "];

const subagentLabelInputs: Array<{ actor: Ref; actorName?: string }> = [
  { actor: { siteId: "s", ordinal: 1 } },
  { actor: { siteId: "s", ordinal: 2 }, actorName: "Ada" },
  { actor: { siteId: "s", ordinal: 3 }, actorName: "" },
];

const modeInputs: unknown[] = [
  undefined,
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
  "unknown-mode",
  "BUILD",
  42,
  null,
];

const modeOfInputs: Array<string | undefined> = [
  undefined,
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
];

// The quality epilogue (`qualityEpilogue`) reads only the schema's top-level `properties`, so nested ones must not count.
const qualitySchemas: Array<{ name: string; schema: unknown }> = [
  { name: "absent", schema: undefined },
  { name: "plain object", schema: { type: "object" } },
  { name: "evidence", schema: { type: "object", properties: { evidence: {} } } },
  { name: "confidence", schema: { type: "object", properties: { confidence: {} } } },
  {
    name: "evidence and confidence",
    schema: { type: "object", properties: { evidence: {}, confidence: {}, other: {} } },
  },
  {
    name: "nested evidence is not top level",
    schema: { type: "object", properties: { x: { properties: { evidence: {} } } } },
  },
];

// An ask's input (`workflow-driver.ts`): instructions, then the quality epilogue, then for a typed ask the tool epilogue of a
// mono session or the schema epilogue. `boundary` is `instructions.length`, in UTF-16 code units.
const askInputCases: Array<{
  name: string;
  instructions: string;
  typed: boolean;
  schema: unknown;
  mono: boolean;
}> = [
  { name: "untyped", instructions: "do it", typed: false, schema: undefined, mono: false },
  { name: "typed generic", instructions: "do it", typed: true, schema: { type: "object" }, mono: false },
  { name: "typed mono", instructions: "do it", typed: true, schema: { type: "object" }, mono: true },
  { name: "non-ASCII boundary", instructions: "é🙂 go", typed: false, schema: undefined, mono: false },
];

function askInputOf(c: (typeof askInputCases)[number]): string {
  return c.typed
    ? `${c.instructions}${qualityEpilogue(c.schema)}${
        c.mono ? TYPED_TOOL_EPILOGUE : schemaEpilogue(c.schema)
      }`
    : `${c.instructions}${qualityEpilogue(undefined)}`;
}

const cases = {
  mintActorSessionId: actors.flatMap((actor) =>
    runIds.map((runId) => ({ runId, actor, id: mintActorSessionId(runId, actor) })),
  ),
  questionIdFragments: runIds.map((runId) => ({ runId, fragments: questionIdFragments(runId) })),
  constants: {
    nudgePrompt: NUDGE_PROMPT,
    typedToolEpilogue: TYPED_TOOL_EPILOGUE,
    escalationBudgetExhausted: ESCALATION_BUDGET_EXHAUSTED,
    maxEscalationsPerAsk: MAX_ESCALATIONS_PER_ASK,
  },
  schemaEpilogue: schemas.map(({ name, schema }) => ({
    name,
    absent: schema === undefined,
    schema: schema ?? null,
    text: schemaEpilogue(schema),
  })),
  qualityEpilogue: qualitySchemas.map(({ name, schema }) => ({
    name,
    absent: schema === undefined,
    schema: schema ?? null,
    text: qualityEpilogue(schema),
  })),
  askInput: askInputCases.map((c) => ({
    name: c.name,
    instructions: c.instructions,
    typed: c.typed,
    mono: c.mono,
    absent: c.schema === undefined,
    schema: c.schema ?? null,
    input: askInputOf(c),
    boundary: c.instructions.length,
  })),
  normalizeEscalationContext: normalizeInputs.map((input) => ({
    input: input ?? null,
    output: normalizeEscalationContext(input) ?? null,
  })),
  effectiveActorName: personaNames.map((name) => ({
    name: name ?? null,
    output: effectiveActorName(name === undefined ? {} : { name }) ?? null,
  })),
  subagentLabel: subagentLabelInputs.map((input) => ({
    actor: input.actor,
    actorName: input.actorName ?? null,
    output: subagentLabel(input),
  })),
  rejectWith: [
    "this ask does not accept submit_result; provide your answer as your final message",
    "",
  ].map((message) => ({ message, verdict: rejectWith(message) })),
  permissionMode: {
    subagentPermissionModeOf: modeOfInputs.map((mode) => ({
      input: mode ?? null,
      output: workflowSubagentPermissionModeOf(mode as never) ?? null,
    })),
    parse: modeInputs.map((raw) => ({
      input: raw === undefined ? null : raw,
      output: parseWorkflowSubagentPermissionMode(raw) ?? null,
    })),
    policy: [undefined, "build", "edit", "yolo", "guarded", "auto"].map((mode) => ({
      input: mode ?? null,
      output: workflowActorPermissionPolicy(mode as WorkflowSubagentPermissionMode | undefined)
        .mode,
    })),
    interactionDescription: [
      { actor: { siteId: "plan#1", ordinal: 2 }, name: undefined },
      { actor: { siteId: "plan#1", ordinal: 2 }, name: "" },
      { actor: { siteId: "plan#1", ordinal: 2 }, name: "  " },
      { actor: { siteId: "a_b", ordinal: 1 }, name: "Ada" },
    ].map(({ actor, name }) => ({
      actor,
      name: name ?? null,
      output: workflowActorInteractionDescription({
        actor,
        persona: name === undefined ? {} : { name },
      }),
    })),
  },
};

writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${outPath}`);
