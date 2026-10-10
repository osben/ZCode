import { collectDiagnostics, createWorkflowProgram } from "../compiler/compile.js";
import type { CompileDiagnostic } from "../compiler/compile.js";
import { collectSites } from "./sites.js";
import { collectFacadeMisuse } from "./facade-misuse.js";
import { collectWorldRunCommands } from "./world-run.js";
import { collectArtifactDeclarations, type DeclaredArtifact } from "./artifacts.js";
import { collectPhaseMarkerDiagnostics } from "./phases.js";
import { collectDuplicateActorNames, FANOUT_ACTOR_NAME_CODE } from "./actor-names.js";
import { interpret } from "./interpret.js";
import { projectSiteGraph } from "./graph.js";
import { projectCausalityGraph, type CausalityGraph } from "./causality-graph.js";
import { projectControlFlow, type ControlFlowGraph } from "./flow-graph.js";
import { projectHandoffGraph, type HandoffGraph } from "./handoff-graph.js";
import type { AnalysisCore } from "./core.js";
import type { SiteGraph } from "./types.js";

/**
 * Result of analyzing a workflow script: the same diagnostics `compileWorkflowScript`
 * produces, plus the analysis core and its two projected views.
 *
 * `ok` means "submittable": any diagnostic clears it. The core and the graphs are present
 * whenever the script was analyzable at all, which is *almost* the same thing — the one
 * diagnostic that leaves them in place is {@link FANOUT_ACTOR_NAME_CODE} (a static actor
 * name inside a fan-out). That clause describes a **run-time** failure, not something that
 * stops the analysis: the shape is perfectly analyzable, and withholding the graph would
 * hide the picture exactly when the author needs it to see which fan-out to fix. So:
 * graphs present ⟸ ok, but not the converse.
 */
export interface AnalyzeResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  /**
   * The all-in-one analysis artifact: taint
   * facts + temporal trace, position-free. `graph` and `causality` are pure projections
   * of it — deriving them again later needs the core only, never the script.
   */
  core?: AnalysisCore;
  graph?: SiteGraph;
  /** The presentation-level happens-before view. */
  causality?: CausalityGraph;
  /** Where execution can go next, per occurrence and per phase. */
  flow?: ControlFlowGraph;
  /** Who takes part in each phase and who hands off to whom. */
  handoff?: HandoffGraph;
  /**
   * **User-facing artifacts** declared by the script: `[{id, kind}]`, deduplicated and sorted by
   * ID. Like the world.run command set, this compile artifact can state what the workflow will
   * produce before execution. Unlike the graph, it is **still returned** when diagnostics are
   * present (it is read directly from the site table and does not depend on interpretation).
   */
  declaredArtifacts: DeclaredArtifact[];
}

/**
 * Typecheck a workflow script and, when clean, interpret it. The pipeline is
 * createWorkflowProgram -> collectSites (the site-table substrate) -> interpret (the
 * fused taint-fixpoint + temporal walk, minting the {@link AnalysisCore}) ->
 * projectSiteGraph / projectCausalityGraph (pure projections of the core).
 *
 * Between the site table and the interpretation runs the facade-siting check
 * ({@link collectFacadeMisuse}): a facade callable that escapes into value space has
 * no site, so the graph cannot represent it. Its diagnostics are surfaced exactly like
 * typechecker diagnostics — `ok: false`, graphs withheld.
 */
export function analyzeWorkflowScript(scriptText: string): AnalyzeResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  // If compilation fails or the facade is escaped, even the site table is untrustworthy, so the
  // artifact manifest must be empty (defaulted rather than absent: readers always receive an array
  // and need not distinguish “no artifacts” from “analysis failed” at every use site).
  if (diagnostics.length > 0) return { declaredArtifacts: [], diagnostics, ok: false };

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) return { declaredArtifacts: [], diagnostics: misuse, ok: false };

  // Validate world.run's literal cmd with misuse: a command formed only at runtime has no
  // authorization item to display (the confirmation dialog's command set is closed at compile
  // time), making it the same kind of compile-time correction as “facade calls must have a site.”
  // Phase markers follow the same rule: non-literal names or markers outside statement positions
  // do not point to a valid object.
  // Literal duplicate actor names are checked here too; the real gate is runtime
  // (DuplicateActorName in engine createActor), and this pass moves only statically visible cases
  // to the cheaper stage.
  // Report all three passes together so authors can see everything to fix at once.
  const worldRun = collectWorldRunCommands(workflow, table);
  // Artifact compile-time rules are included too: IDs must be compile-time literals, tags must
  // point to a declared preset, and one ID cannot span two member families. All three should teach
  // corrections now rather than fail at runtime.
  const artifacts = collectArtifactDeclarations(workflow, table);
  const authoring = [
    ...worldRun.diagnostics,
    ...artifacts.diagnostics,
    ...collectPhaseMarkerDiagnostics(workflow, table),
    ...collectDuplicateActorNames(workflow, table),
  ];
  // Static actor names in fan-out (9006) are the only diagnostics in this group that **do not
  // suppress the graph**: they mean the script will hit DuplicateActorName at runtime, not that the
  // code cannot be analyzed. The shape is fully analyzable; suppressing the graph would hide which
  // fan-out caused the issue exactly when the author needs it for diagnosis. It still clears `ok`
  // (submission remains blocked).
  // As a side effect, analysis fixtures can retain graph output for the “static name in fan-out”
  // shape; otherwise a blocking compile-time diagnostic would make the shape itself inexpressible
  // in the fixtures.
  const withholding = authoring.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
  if (withholding.length > 0) {
    return { declaredArtifacts: artifacts.declaredArtifacts, diagnostics: authoring, ok: false };
  }

  // One interpretation feeds everything: the core carries the taint facts AND the
  // temporal trace, and both graphs project off it without touching the AST again.
  const core = interpret(workflow, table);
  const graph = projectSiteGraph(core);
  const causality = projectCausalityGraph(core, graph);
  return {
    causality,
    core,
    declaredArtifacts: artifacts.declaredArtifacts,
    diagnostics: authoring,
    flow: projectControlFlow(core),
    graph,
    handoff: projectHandoffGraph(core, causality, graph),
    ok: authoring.length === 0,
  };
}
