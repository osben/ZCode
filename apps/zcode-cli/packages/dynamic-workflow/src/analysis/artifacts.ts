/**
 * Compile-time collection and diagnostics for artifacts.
 *
 * ⚠ Terminology: artifact in this module means a **user-facing artifact**—a file / markdown / prebuilt dashboard
 * published by the script through `artifact.*`. `artifact-types.ts` in the same directory refers to a **different** artifact:
 * a typed site output value (shown to the model). The two are unrelated.
 *
 * Two artifact outputs:
 *
 * 1. `declaredArtifacts` (a compile result, analogous to `commands` from `collectWorldRunCommands`): the script's
 *    artifact manifest `[{id, kind}]`, deduplicated and sorted by ID. The hub and inspector use it to describe **before execution**
 *    what the workflow will produce.
 * 2. Site diagnostics (same family as facade-misuse): IDs must be compile-time literals, labels must reference a declared dashboard,
 *    an ID cannot be reused across member kinds, and dashboard declarations must not appear inside loops / callbacks / conditional branches.
 *
 * Why IDs must be compile-time literals (same rule as `world.run` cmd and `phase` name): an ID formed only at runtime has no displayable
 * value—it cannot appear in the "will produce" manifest, and rules such as "same ID used for two kinds" could only be checked at runtime.
 * Teach the rewrite at the cheaper stage.
 *
 * Runtime division of responsibility: this pass handles only the half that can be determined from **literals**. The engine is the real guard—
 * `ArtifactKindMismatch` / `ArtifactRedeclared` / `ArtifactUndeclared` / `ArtifactCapExceeded` are enforced at runtime because static analysis
 * cannot know the **execution order** of declarations. This module therefore **may miss an issue but cannot report a false positive**,
 * except for the hoisting diagnostic (see {@link ARTIFACT_HOISTING_CODE}).
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "../facade/artifact-caps.js";
import { isArtifactPresetOp, type ArtifactOp } from "../facade/registry.js";
import { findWorkflowBody, type ArtifactSite, type SiteTable } from "./sites.js";

/**
 * Compile-time diagnostic codes for artifacts (9001 = facade-siting, 9002 = schema, 9003 = world-run, 9004 = phase,
 * 9005/9006 = actor name, continuing the sequence). Covers non-literal / empty / overlong / invalid-character IDs, reuse of one ID across kinds,
 * and three errors in `report` labels. These are all **statically certain** errors; none can reject a valid script.
 */
export const ARTIFACT_DECLARATION_CODE = 9007;

/**
 * A prebuilt declaration appears inside a loop / callback / conditional branch ("hoist declarations to the top level; declare once"). Give it a separate code
 * instead of reusing 9007 for the same reason 9005/9006 are separate: **the certainty differs**.
 *
 * Repeating the **same spec** declaration in a loop is an idempotent no-op at runtime, so this clause could theoretically report a false positive.
 * We accept it because the costs are asymmetric: fixing it is free (move the declaration to the top of the script), while without the diagnostic a dashboard
 * declaration could be hidden in a deeply nested callback and readers would have to run the script to find out whether it was declared.
 * Readers (fixture corpus, future permissive modes) therefore need to distinguish it from 9007; routing by error text is prohibited throughout this repository.
 */
export const ARTIFACT_HOISTING_CODE = 9008;

/**
 * Two **different** IDs both contain the literal `primary: true`.
 * Same certainty as 9008: separate mutually exclusive branches may each mark an artifact, and execution may work, but cards and sidebars can show only one
 * primary deliverable, so the script is ambiguous. Recognize only literal `true`; computed flags are handled by the engine's `ArtifactPrimaryConflict`.
 */
export const ARTIFACT_PRIMARY_CONFLICT_CODE = 9009;

/** One artifact declared by the script: its ID and member kind. */
export interface DeclaredArtifact {
  id: string;
/** Member kind (`file` / `markdown` / `chart` / `table` / `metrics` / `board`). */
  kind: ArtifactOp;
}

export interface ArtifactDeclarations {
/** Script-declared artifact manifest: deduplicated and sorted lexically by ID (parallel to `declaredCommands`). */
  declaredArtifacts: DeclaredArtifact[];
/** Site diagnostics; a non-empty result means the script cannot be submitted. */
  diagnostics: CompileDiagnostic[];
}

/** Lexical locations where a prebuilt declaration must not appear. */
type HoistingContext = "loop" | "callback" | "conditional";

const HOISTING_MESSAGE: Record<HoistingContext, string> = {
  callback:
    "a preset artifact declared inside a callback: hoist it to the top level and declare it once. " +
    "A preset is a declaration, not a step — it says how the items tagged with its id are drawn, " +
    "and the tagged report() calls are what fill it in. Declaring it where the callback runs " +
    'buries it: move artifact.<kind>("<id>", spec) to the head of the script and keep only ' +
    'report(item, "<id>") in the callback.',
  conditional:
    "a preset artifact declared inside a conditional branch: hoist it to the top level and declare " +
    "it once. The card should exist from the moment the run starts (it is legitimately empty until " +
    "the first tagged report arrives), and a declaration that may or may not have run is a card " +
    "that may or may not exist. Declare it unconditionally and let the branch decide what to report.",
  loop:
    "a preset artifact declared inside a loop: hoist it to the top level and declare it once. " +
    "A preset is declared once and fed many times — the loop body is where report(item, \"<id>\") " +
    "belongs, not the declaration. Re-declaring the same spec is a no-op, but re-declaring it with " +
    "a different spec fails the whole run, so the loop is the wrong place for it either way.",
};

const NON_LITERAL_ID_MESSAGE =
  "an artifact id must be a compile-time string literal (\"report\" or a no-substitution template): " +
  "the set of artifacts a run can publish is fixed when the script is submitted, so it can be listed " +
  "before anything runs. Write the id inline; put the runtime value in the title instead " +
  '(artifact.file("report", path, { title: `Report for ${name}` })).';

const EMPTY_ID_MESSAGE =
  "an artifact id must not be empty: it is the identity the card, the version history and the " +
  'report tag all key off. Give it a short stable name ("book", "perf", "coverage").';

/**
 * Collect the artifact manifest and diagnostics. Any diagnostics mean the script cannot be submitted (alongside the compile-time rules for
 * `analyzeWorkflowScript`, world.run / phase / actor names).
 */
export function collectArtifactDeclarations(
  workflow: WorkflowProgram,
  table: SiteTable,
): ArtifactDeclarations {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (code: number, loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code, column: loc.column, line: loc.line, message });
  };
  const locOf = (node: ts.Node): ScriptLoc =>
    workflow.toScriptLoc(node.getStart(workflow.scriptFile));

  const body = findWorkflowBody(workflow.scriptFile);
/** id → first site that used it (used to identify the earlier site on a kind conflict). */
  const claimed = new Map<string, ArtifactSite>();
/** First site with literal `primary: true`; a second occurrence with a different ID is diagnostic 9009. */
  let primaryClaim: { id: string; site: ArtifactSite } | undefined;
  const declared: DeclaredArtifact[] = [];

  for (const site of table.artifacts) {
    // Place ID diagnostics on the **offending expression** (fall back to the site when absent, as for world-run:
    // type checking catches arity errors first, but diagnostic collection should not depend on that inference).
    const idLoc = site.artifactIdExpr === undefined ? site.loc : locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(ARTIFACT_DECLARATION_CODE, idLoc, NON_LITERAL_ID_MESSAGE);
      continue;
    }
    const id = site.artifactId;
    if (id === "") {
      push(ARTIFACT_DECLARATION_CODE, idLoc, EMPTY_ID_MESSAGE);
      continue;
    }
    if (id.length > ARTIFACT_CAPS.maxIdLength) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" is ${id.length} characters; the limit is ${ARTIFACT_CAPS.maxIdLength}. ` +
          "The id is a key, not a description — put the prose in the title.",
      );
      continue;
    }
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" contains characters outside [A-Za-z0-9_.-]. The id is carried verbatim ` +
          "through the journal, the artifact store and the side pane, so it is restricted to " +
          'characters that need no escaping anywhere ("build-log", "perf.p95").',
      );
      continue;
    }

    // Reuse across member kinds (diagnostic 4): place the diagnostic on the **later occurrence**; the first kind encountered is the established fact.
    const first = claimed.get(id);
    if (first === undefined) {
      claimed.set(id, site);
      declared.push({ id, kind: site.op });
    } else if (first.op !== site.op) {
      push(
        ARTIFACT_DECLARATION_CODE,
        site.loc,
        `artifact id "${id}" is used with two different kinds: artifact.${first.op} on line ` +
          `${first.loc.line} and artifact.${site.op} here. Within one run an id belongs to exactly ` +
          "one kind — publishing it again is what mints the next VERSION, and a version cannot " +
          "change what the thing is. Give this one its own id.",
      );
    }

    // 交付物唯一（9009）：诊断落在**后一处**的 `primary` 属性上——先标的那个是既有事实。
    const primaryNode = primaryLiteralOf(site);
    if (primaryNode !== undefined) {
      if (primaryClaim === undefined) primaryClaim = { id, site };
      else if (primaryClaim.id !== id) {
        push(
          ARTIFACT_PRIMARY_CONFLICT_CODE,
          locOf(primaryNode),
          `artifact "${id}" is marked primary, but "${primaryClaim.id}" already is (artifact.` +
            `${primaryClaim.site.op} on line ${primaryClaim.site.loc.line}). A run has one ` +
            "deliverable — the card and the run pane lead with it. Drop primary from one of them, " +
            "or publish this content as a new version of the other id.",
        );
      }
    }

    // 提升诊断（预置族专属）：内容成员反而**常常**该出现在循环 / 条件里（每轮发布一版、
    // 失败时补一版），所以这条子句绝不能扩到那一族。
    if (isArtifactPresetOp(site.op)) {
      const context = hoistingContextOf(site.call, body);
      if (context !== undefined) {
        push(ARTIFACT_HOISTING_CODE, site.loc, HOISTING_MESSAGE[context]);
      }
    }
  }

  // 已声明的**预置** id（标签的合法目标集）与内容 id，两张表分开：标签指向内容 id 有专门
  // 的一条文案（它不是「没这个东西」，而是「这个东西没有数据面」）。
  const presetIds = declared.filter((entry) => isArtifactPresetOp(entry.kind)).map((e) => e.id);
  const contentIds = new Set(
    declared.filter((entry) => !isArtifactPresetOp(entry.kind)).map((e) => e.id),
  );

  for (const site of table.reports) {
    if (site.artifactIdExpr === undefined) continue; // 无标签的 report 照旧
    const tagLoc = locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        "report()'s artifact tag must be a compile-time string literal naming a preset artifact " +
          "declared in this script: the tag is how an item finds its dashboard, and a tag that only " +
          "exists at run time cannot be checked against the declarations. Write the id inline.",
      );
      continue;
    }
    const tag = site.artifactId;
    if (presetIds.includes(tag)) continue;
    if (contentIds.has(tag)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        `report()'s tag "${tag}" names a file/markdown artifact, which holds content rather than a ` +
          "stream of items — there is nothing for this item to become. Tag the item with a preset " +
          "artifact (chart / table / metrics / board), or drop the tag and let the item go to the " +
          "run's Results.",
      );
      continue;
    }
    push(
      ARTIFACT_DECLARATION_CODE,
      tagLoc,
      `report()'s tag "${tag}" names no preset artifact declared in this script${describePresets(presetIds)}. ` +
        'Declare it first — artifact.chart("' +
        tag +
        '", { x, y }) at the top of the script — or drop the tag.',
    );
  }

  return { declaredArtifacts: sortDeclared(declared), diagnostics };
}

/**
 * Property in site opts / spec arguments written literally as `primary: true`. Missing, non-object literal, or non-literal `true`
 * (computed or spread in) all count as absent; the engine handles those cases.
 */
function primaryLiteralOf(site: ArtifactSite): ts.Node | undefined {
  const arg = site.call.arguments[isArtifactPresetOp(site.op) ? 1 : 2];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const property of arg.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (key !== "primary") continue;
    return property.initializer.kind === ts.SyntaxKind.TrueKeyword ? property : undefined;
  }
  return undefined;
}

/** Suffix for "declared dashboards: …"; more direct wording is used when none exist. */
function describePresets(presetIds: readonly string[]): string {
  if (presetIds.length === 0) return " (this script declares no preset artifacts at all)";
  return ` (declared presets: ${[...presetIds].sort().map((id) => `"${id}"`).join(", ")})`;
}

/** Deduplicate (keep one entry per ID and kind) and sort lexically by ID. */
function sortDeclared(declared: readonly DeclaredArtifact[]): DeclaredArtifact[] {
  const seen = new Set<string>();
  const unique: DeclaredArtifact[] = [];
  for (const entry of declared) {
    const key = `${entry.id} ${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => (a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1));
}

/**
 * 该调用**词法上**待在哪种不该待的位置里，从调用向外走到脚本体为止；都不是则 undefined。
 * 报最内层的那一个：它离作者要改的那一行最近，文案也最具体。
 *
 * 刻意**不**把普通函数声明算作回调：`function setup() { artifact.chart(...) }` 后跟一次
 * `setup()` 是一份合法的顶层声明，只是换了个写法。箭头函数与函数表达式则几乎总是回调
 * （`.map(...)`、`.then(...)`），所以它们算。代价是「在具名 helper 里声明、而 helper 被
 * 循环调用」这一形状漏报——那是漏报方向，与本模块的保守取向一致（引擎的
 * `ArtifactRedeclared` 仍然兜底）。
 */
function hoistingContextOf(call: ts.CallExpression, body: ts.Block): HoistingContext | undefined {
  let child: ts.Node = call;
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (node === body) return undefined;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      return "callback";
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      return "loop";
    }
    // if / ternary：只有**分支**算条件位置，条件表达式本身不算——`if (artifact.chart(...))`
    // 无条件求值，它的问题是别的（一个 void 当条件用），不该借这条文案说。
    if (ts.isIfStatement(node) && (node.thenStatement === child || node.elseStatement === child)) {
      return "conditional";
    }
    if (ts.isConditionalExpression(node) && (node.whenTrue === child || node.whenFalse === child)) {
      return "conditional";
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return "conditional";
    child = node;
  }
  return undefined;
}
