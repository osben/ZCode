import ts from "typescript";
import {
  collectDiagnostics,
  createWorkflowProgram,
  WORKFLOW_FUNCTION_NAME,
  type CompileDiagnostic,
  type WorkflowProgram,
} from "../compiler/compile.js";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import { isArtifactPresetOp, type ArtifactOp, type WorldReadOp } from "../facade/registry.js";
import { collectFacadeMisuse } from "../analysis/facade-misuse.js";
import {
  collectSites,
  isFacadeDeclared,
  resolveSymbol,
  type HoleSite,
  type SiteTable,
} from "../analysis/sites.js";
import { collectHoleDiagnostics } from "../analysis/hole-sites.js";
import { lowerHoleCall, printHoleBodies, TRANSPILE_OPTIONS } from "./lower-hole.js";

/**
 * Lowering (instrumentation emit step): convert a workflow script that passed typecheck and
 * analysis into sandbox-executable **JavaScript**. Two steps:
 *
 *   1. Strip types: the program has already passed typecheck, so this performs transpile-level type
 *      erasure on the same source.
 *   2. Instrument each facade call with the **static site ID** from the site table and rewrite it
 *      to Boundary A's `__host.*`:
 *        agent(name, persona)        -> __host.createActor("actor#2", name, persona)
 *        planner.ask<Plan>(text)     -> __host.ask("ask#3", planner, text)
 *        maybe?.ask<Plan>(text)      -> maybe === null || maybe === undefined
 *                                         ? undefined : __host.ask("ask#3", maybe, text)
 *                                       (preserve optional-chain short-circuiting: skip ask and
 *                                        do not evaluate arguments when receiver is nullish;
 *                                        evaluate non-identifier receivers once through a temp)
 *        files.glob(p) / files.read(p)
 *                                    -> __host.worldRead("world-read#1", "glob", [p])
 *                                       __host.worldRead("world-read#2", "read", [p])
 *        report(x)                   -> __host.report("report#1", x)
 *        report(x, "perf")           -> __host.report("report#1", x, "perf")
 *        artifact.file(id, p, o)     -> __host.publishArtifact("artifact#1", "file", [id, p, o])
 *        artifact.chart(id, spec)    -> __host.declareArtifact("artifact#2", "chart", [id, spec])
 *        log(msg)                    -> __host.log(msg)
 *        phase("gate")               -> __host.enterPhase("gate") (no site; the engine emits one event)
 *        model("GLM-5.3-Flash")      -> "GLM-5.3-Flash" (no site or host call: ModelRef is the name at runtime)
 *        channel<T>("facts")         -> __host.channel("facts") (no site; queue is constructed in the cell)
 *        future(async () => {...})   -> __host.future(async () => {...}) (no site; the cell calls it immediately)
 *        hole<T>(n, p?, body?)       -> __host.hole("hole#1", n, p ?? void 0, (__src) => eval(__src), body?)
 *                                       (lower-hole.ts; filled bodies are also emitted as text in holeBodies)
 *      Join (Promise.all) and fan-out are ordinary sandbox promise mechanisms, not host calls, so they are preserved.
 *
 * ————————————————————————————————————————————————————————————————
 * Output contract (harness contract; the sandbox wraps it):
 * ————————————————————————————————————————————————————————————————
 * {@link LoweredWorkflow.code} is the lowered script's **async function body**: top-level `await`
 * and a trailing `return <artifact>` are valid because the harness wraps it in an async function,
 * like this:
 *
 *     const __run = async (__host) => { <code> };
 *
 * Thus, the only free identifier in code is `__host` (see {@link HOST_BINDING}); facade names
 * `agent`/`log`/`files`/`phase` have all been rewritten, and the sandbox vm needs only ES intrinsics
 * plus `__host` in its globals.
 * Schemas never cross the sandbox boundary: the engine looks them up in the compilation artifact
 * by site ID, and code contains no schemas.
 *
 * {@link LoweredWorkflow.siteIds} lists all instrumented facade site IDs in source order (asks /
 * actors / world-reads / reports / artifacts; `log`/`phase` have no site IDs and are excluded).
 * The harness and tests use it to assert that every site ID appears exactly once.
 *
 * Determinism: printer + transpile are pure functions; the same input produces byte-identical output.
 */

/** Free identifier that the harness must bind for lowered code (Boundary A host handle). */
export const HOST_BINDING = "__host";

/**
 * Top-level facade functions with no site that are passed through by name to `__host.<name>(...)`:
 * `log` (progress narration), and `channel` / `future` (sandbox pipeline primitives;
 * docs/dynamic-workflow/authoring.md, “Streams”). They have no journal key and are omitted from the
 * site table; identity is still determined by the declaration resolved by the checker.
 */
const HOST_PASSTHROUGH_FUNCTIONS: ReadonlySet<string> = new Set(["log", "channel", "future"]);

/** Lowering output: JavaScript body passed to the sandbox + list of instrumented site IDs. */
export interface LoweredWorkflow {
  /** Lowered script's async function body (top-level await/trailing return are valid; only free identifier is `__host`). */
  code: string;
  /** Stubbed facade site IDs in source order (excluding `log`, which has no site ID; includes holes and sites in their bodies). */
  siteIds: string[];
  /**
   * Text for each **filled** hole body (`(async () => {\n…\n})`), keyed by site ID. Printed in the same
   * transform pass as the main body and with the same type-parameter erasure
   * (execution-engine.md, “The text that runs”). Open holes are not included.
   */
  holeBodies: Record<string, string>;
}

/** Result of {@link lowerWorkflowScript}, matching analyze: invalid scripts are not lowered, and `lowered` is present only when `ok`. */
export interface LowerResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  lowered?: LoweredWorkflow;
}

/** Which `__host.*` call rewrites each facade call registered in the site table (`phase` has no site ID and carries only its name). */
type SiteEmit =
  | { kind: "actor"; siteId: string }
  | { kind: "artifact"; siteId: string; op: ArtifactOp }
  | { kind: "ask"; siteId: string }
  /** Hole: rewriting needs its name, prompt, and body arguments, so retain the complete site (lower-hole.ts). */
  | { kind: "hole"; site: HoleSite }
  /** Phase marker: no site ID, only the trimmed name (a marker without a name falls back to `void 0`). */
  | { kind: "phase"; name: string | undefined }
  | { kind: "report"; siteId: string }
  | { kind: "world-read"; siteId: string; op: WorldReadOp };

/**
 * Convenience entry point: compile + facade-siting check + build the site table + lower, matching
 * `analyzeWorkflowScript`. Invalid scripts (typecheck or facade-siting errors) are not lowered;
 * lowering runs only on clean programs.
 */
export function lowerWorkflowScript(scriptText: string): LowerResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const table = collectSites(workflow);
  // Apply the hole rule (9012) alongside facade-siting: a hole without a resolved value or inside a
  // fan-out would become a runtime error if lowered, so enforce the same gate as analyzeWorkflowScript.
  const misuse = [
    ...collectFacadeMisuse(workflow, table),
    ...collectHoleDiagnostics(workflow, table),
  ];
  if (misuse.length > 0) return { diagnostics: misuse, ok: false };

  return { diagnostics, lowered: lowerWorkflow(workflow, table), ok: true };
}

/**
 * Core implementation: lower an analyzed, valid workflow to {@link LoweredWorkflow}.
 * Match site calls (ask/actor/world-read) only by **ts.Node identity** (the raw call reference held
 * by the site table), never by re-identifying names/shapes, which would create a second source of
 * truth. `log` is not in the site table; identify it through checker signature resolution (resolves
 * into facade .d.ts, same mechanism as sites.ts), which is identity-based rather than a name heuristic.
 */
export function lowerWorkflow(workflow: WorkflowProgram, table: SiteTable): LoweredWorkflow {
  const checker = workflow.program.getTypeChecker();
  const siteMap = buildSiteMap(table);
  // Filled hole bodies (rewritten nodes) are printed into holeBodies after the transform completes.
  const holeBodyNodes = new Map<string, ts.Expression>();

  // Pass one: instrumentation. Transform the same scriptFile whose nodes are referenced by the site
  // table so lookups can match node identity; types have not yet been erased.
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const hostMember = (name: string): ts.Expression =>
      factory.createPropertyAccessExpression(factory.createIdentifier(HOST_BINDING), name);
    const siteArg = (id: string): ts.Expression => factory.createStringLiteral(id);

    const visit: ts.Visitor = (node) => {
      // `args` is the facade's only **value** rather than callable, so it is the only symbol
      // rewritten at identifier level. Reading it is not a wait point, has no site, and does not
      // enter the causal graph. Check the symbol resolved by the checker (same identity mechanism
      // as site lookup), so a script's local `args` resolves to the script symbol and remains unchanged.
      //
      // Deliberately **do not** inject `const args = ...` into the wrapper body: if the user script
      // also declares `args`, this becomes a duplicate-declaration runtime SyntaxError that compile-time checks cannot detect.
      if (ts.isIdentifier(node) && node.text === "args" && isFacadeArgsRead(node, checker)) {
        return hostMember("args");
      }
      if (ts.isCallExpression(node)) {
        const emit = siteMap.get(node);
        if (emit !== undefined) return lowerSited(node, emit);
        // Non-site facade calls: log, channel, and future (agent/ask/glob/read always produce sites and
        // are already in siteMap). Handle all three alike: identify them by the facade declaration the
        // checker resolves, rewrite to the corresponding `__host.*`, discard type arguments
        // (`channel<Fact>(...)`), and pass through value arguments. channel / future are pure sandbox
        // promise mechanisms (docs/dynamic-workflow/authoring.md, “Streams”); they do not cross the
        // host boundary or create journal rows, so they need no site IDs.
        const name = facadeCalleeName(node, checker);
        // model("x") -> "x": `ModelRef` exists only in the type system and is the name string at
        // runtime (docs/dynamic-workflow/authoring.md, “Choosing a model per subagent”). The host uses
        // this string to look up the binding resolved at launch. No site or host call is involved; if
        // the argument is absent (already rejected by 9010), fall back to `void 0`.
        if (name === "model") {
          const arg = node.arguments[0];
          return arg === undefined ? factory.createVoidZero() : visitExpr(arg);
        }
        if (name !== undefined && HOST_PASSTHROUGH_FUNCTIONS.has(name)) {
          return factory.createCallExpression(
            hostMember(name),
            undefined,
            node.arguments.map(visitExpr),
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };

    const visitExpr = (expr: ts.Expression): ts.Expression =>
      ts.visitNode(expr, visit) as ts.Expression;

    const lowerSited = (call: ts.CallExpression, emit: SiteEmit): ts.Expression => {
      if (emit.kind === "phase") {
        // phase("gate") -> __host.enterPhase("gate"). The marker still has **no site and no journal
        // row**—it is not a work step. The engine must still observe the control flow through it
        // (a `phase-entered` event), or a phase with no nodes remains an empty circle on the
        // timeline. Trim the name, matching the analyzer's phase-ID key. If the name is absent
        // (non-literal; diagnostic 9004 should have rejected it first), fall back to `void 0`; the
        // sandbox must never retain a free identifier `phase`.
        const name = emit.name?.trim();
        if (name === undefined || name.length === 0) return factory.createVoidZero();
        return factory.createCallExpression(hostMember("enterPhase"), undefined, [
          factory.createStringLiteral(name),
        ]);
      }
      if (emit.kind === "hole") {
        return lowerHoleCall(
          call,
          emit.site,
          factory,
          hostMember,
          siteArg,
          visitExpr,
          holeBodyNodes,
        );
      }
      if (emit.kind === "actor") {
        // agent(name?, persona?) -> __host.createActor(siteId, name?, persona?)
        return factory.createCallExpression(hostMember("createActor"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      if (emit.kind === "ask") {
        // receiver.ask<T>(instr) -> __host.ask(siteId, receiver, instr) (drop type argument <T>).
        // facade-siting guarantees ask is a direct `receiver.ask(...)` call, so callee is a property access.
        const access = call.expression as ts.PropertyAccessExpression;
        const receiver = visitExpr(access.expression);
        const loweredAsk = (recv: ts.Expression): ts.Expression =>
          factory.createCallExpression(hostMember("ask"), undefined, [
            siteArg(emit.siteId),
            recv,
            ...call.arguments.map(visitExpr),
          ]);
        if (!ts.isOptionalChain(call)) return loweredAsk(receiver);
        // Optional-chain asks (`p?.ask(x)`, `wrap?.p.ask(x)`) cannot be unconditionally rewritten
        // as `__host.ask(siteId, <receiver>, x)` because that drops `?.` short-circuiting. When the
        // receiver is nullish, the author's program skips the ask and the whole chain evaluates to
        // undefined. The lowered output would pass undefined to the engine, causing UnknownActor to
        // **fail the entire run**, and only when the optional branch is actually empty—possibly
        // after a long run. Rewrite with a nullish-guard conditional: arguments are not evaluated
        // when the guard matches, preserving optional-chain semantics. Repeat identifier receivers
        // directly (no side effects); evaluate other expressions exactly once through a hoisted
        // temporary, following the same pattern as tsc's optional-chain lowering.
        const once = ts.isIdentifier(receiver)
          ? receiver
          : factory.createTempVariable(context.hoistVariableDeclaration);
        const evaluated = once === receiver ? receiver : factory.createAssignment(once, receiver);
        const isNullish = factory.createBinaryExpression(
          factory.createBinaryExpression(
            evaluated,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createNull(),
          ),
          factory.createToken(ts.SyntaxKind.BarBarToken),
          factory.createBinaryExpression(
            once,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createIdentifier("undefined"),
          ),
        );
        return factory.createConditionalExpression(
          isNullish,
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createIdentifier("undefined"),
          factory.createToken(ts.SyntaxKind.ColonToken),
          loweredAsk(once),
        );
      }
      if (emit.kind === "artifact") {
        // artifact.file(id, path, opts)  -> __host.publishArtifact(siteId, "file", [id, path, opts])
        // artifact.chart(id, spec)       -> __host.declareArtifact(siteId, "chart", [id, spec])
        // The two families have the **same shape but different names** because they return
        // different types (promise vs void), and the engine dispatches by method name, not op. A
        // script that awaits a declaration as an effect should be rejected by types, not receive
        // undefined at runtime. Arguments follow world-read behavior: pack unchanged by position;
        // lowering does not inspect op or validate arity (the engine and driver do that).
        const member = isArtifactPresetOp(emit.op) ? "declareArtifact" : "publishArtifact";
        return factory.createCallExpression(hostMember(member), undefined, [
          siteArg(emit.siteId),
          factory.createStringLiteral(emit.op),
          factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
        ]);
      }
      if (emit.kind === "report") {
        // report(item, artifactId?) -> __host.report(siteId, item, artifactId?)
        // report uses the **site map**, not the checker-name path below used for log: it has a site
        // (journal replay deduplicates by site × ordinal), and site identity exists only in the site table.
        return factory.createCallExpression(hostMember("report"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      // files.glob(arg)/files.read(arg) -> __host.worldRead(siteId, op, [arg])
      // Pack arguments **unchanged and by position** into an array literal: lowering does not
      // inspect op or arity or perform validation. The driver validates argument count and values
      // per op, so adding a world-read primitive requires no changes in this pass.
      return factory.createCallExpression(hostMember("worldRead"), undefined, [
        siteArg(emit.siteId),
        factory.createStringLiteral(emit.op),
        factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
      ]);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const result = ts.transform(workflow.scriptFile, [transformer]);
  const transformed = result.transformed[0];
  if (transformed === undefined) throw new Error("lowering: transform produced no source file");

  // Keep only the __workflowScript__ function-body statements (wrapper/facade/exports are excluded from lowered code).
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const instrumented = workflowBody(transformed)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
    .join("\n");
  const holeBodies = printHoleBodies(holeBodyNodes, printer, transformed);
  result.dispose();

  // Pass two: type erasure. Instrumentation is complete and node identity is no longer needed, so transpile-level text erasure is sufficient.
  const code = ts.transpileModule(instrumented, {
    compilerOptions: TRANSPILE_OPTIONS,
    reportDiagnostics: false,
  }).outputText;

  return { code, holeBodies, siteIds: sourceOrderSiteIds(table) };
}

/**
 * Build a `ts.CallExpression -> SiteEmit` map for the four site-call categories in the site table
 * plus phase markers (matched by node identity). Phase uses this map to obtain node identity and
 * name; it has no site ID and is therefore excluded from {@link sourceOrderSiteIds}.
 */
function buildSiteMap(table: SiteTable): Map<ts.CallExpression, SiteEmit> {
  const map = new Map<ts.CallExpression, SiteEmit>();
  for (const site of table.actors) map.set(site.call, { kind: "actor", siteId: site.id });
  for (const site of table.artifacts) {
    map.set(site.call, { kind: "artifact", op: site.op, siteId: site.id });
  }
  for (const site of table.asks) map.set(site.call, { kind: "ask", siteId: site.id });
  for (const site of table.holes) map.set(site.call, { kind: "hole", site });
  for (const marker of table.phases) map.set(marker.call, { kind: "phase", name: marker.name });
  for (const site of table.reports) map.set(site.call, { kind: "report", siteId: site.id });
  for (const site of table.worldReads) {
    map.set(site.call, { kind: "world-read", op: site.op, siteId: site.id });
  }
  return map;
}

/** Instrumented site IDs in source order (the site table's global `order` discovery sequence). */
function sourceOrderSiteIds(table: SiteTable): string[] {
  const sited = [
    ...table.actors,
    ...table.artifacts,
    ...table.asks,
    ...table.holes,
    ...table.reports,
    ...table.worldReads,
  ];
  return sited.sort((a, b) => a.order - b.order).map((site) => site.id);
}

/** Locate the transformed __workflowScript__ function-body statements (same shape as findWorkflowBody in sites.ts). */
function workflowBody(sourceFile: ts.SourceFile): ts.NodeArray<ts.Statement> {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body.statements;
    }
  }
  throw new Error(`lowering: ${WORKFLOW_FUNCTION_NAME} not found in transformed source`);
}

/**
 * Return the resolved facade callable name (from the resolved signature's declaration in facade
 * .d.ts), or undefined. Same approach as the private facadeCalleeName in sites.ts: determine
 * identity from the signature declaration, not the callee expression spelling, so computed member
 * access (`files["read"](x)`) also resolves to the facade method. This module uses it only for log;
 * site-producing facade calls already match siteMap and return before reaching this point.
 */

/**
 * True iff this `args` identifier is a READ of the facade global (not a shadowing local,
 * not a property name, not a declaration site).
 *
 * Identity comes from the checker, exactly as facade call sites do: a script that writes
 * its own `const args = ...` resolves to a symbol declared in the script file, so it is
 * left alone and keeps shadowing benignly. The syntactic guards below are for positions
 * where an identifier is not a value read at all — `x.args`, `{ args: 1 }`, and the name
 * in `const args = ...` — where rewriting would produce nonsense like `{ __host.args: 1 }`.
 */
function isFacadeArgsRead(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent !== undefined) {
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    // Declaration position (`const args = ...`, parameter name, import name): this **creates** a binding rather than reading the facade.
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
  }
  return isFacadeDeclared(resolveSymbol(node, checker));
}

function facadeCalleeName(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.getSourceFile().fileName !== FACADE_FILE_NAME) {
    return undefined;
  }
  const name = (declaration as ts.FunctionDeclaration | ts.MethodSignature).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
