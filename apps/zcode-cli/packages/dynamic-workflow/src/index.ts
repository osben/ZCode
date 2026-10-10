export { FACADE_DTS, FACADE_FILE_NAME, SNIPPET_FACADE_DTS } from "./facade/dts.js";
export { WORLD_READ_CAPS } from "./facade/world-read-caps.js";
export { REPORT_CAPS } from "./facade/report-caps.js";
// User-facing artifacts: cap constants, registry vocabulary, compile-time manifest, and diagnostics.
export { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "./facade/artifact-caps.js";
export {
  ARTIFACT_REGISTRY,
  artifactFamilyOf,
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactOp,
  type ArtifactPresetOp,
  type ArtifactRow,
} from "./facade/registry.js";
export {
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  type ArtifactDeclarations,
  type DeclaredArtifact,
} from "./analysis/artifacts.js";
export {
  collectDiagnostics,
  compileWorkflowScript,
  createWorkflowProgram,
  SCRIPT_FILE_NAME,
  type CompileDiagnostic,
  type CompileResult,
  type CreateWorkflowProgramOptions,
  type ScriptLoc,
  type WorkflowProgram,
} from "./compiler/compile.js";
export { analyzeWorkflowScript, type AnalyzeResult } from "./analysis/analyze.js";
export { collectSites, type SiteTable } from "./analysis/sites.js";
export {
  collectWorldRunCommands,
  WORLD_RUN_LITERAL_CODE,
  type WorldRunCommands,
} from "./analysis/world-run.js";
export { collectPhaseMarkerDiagnostics, PHASE_MARKER_CODE } from "./analysis/phases.js";
export {
  toActorGraph,
  type ActorEdge,
  type ActorGraph,
  type ActorNode,
} from "./analysis/actor-graph.js";
export {
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type RegionKind,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
// Greedy irreducible transitive reduction. The display
// pruning layer reuses it for untyped reduction of one edge kind; when all forward edges have the
// same kind and back edges are carried, it reduces to ordinary irreducible reduction and remains
// reliable on cyclic input.
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  UNPHASED_ID,
  type JumpKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/causality-order.js";
// Control-flow projection: occurrence-level CFG and phase quotient.
export {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
// Canonical text form of the causality graph (snapshot surface).
export {
  serializeCausalityGraph,
  serializeControlFlow,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
// Handoff-graph projection: participant cards and handoff edges in the second board layer.
export {
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
// Unified analysis core and its canonical text form:
// site graph / causality graph / actor graph are all pure projections of it.
export {
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
// JSON encoding/decoding for core: the sample package freezes `AnalysisCore` into
// `core.json`, and downstream browser code recomputes projections from the frozen artifact; Maps
// are persisted as ordered `[key, value][]`.
export {
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
} from "./analysis/core-json.js";
export type {
  ActorSite,
  SiteEdge,
  SiteGraph,
  SiteKind,
  SiteLoc,
  SiteNode,
} from "./analysis/types.js";
export {
  buildAskSpecs,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
  type SchemaSynthesisResult,
} from "./schema/synthesize.js";
export { validate, formatViolation, formatViolations } from "./schema/validate.js";
// Submit profile for each actor site: compile-time decision for typed / generic / no submit_result tool on the subagent.
export {
  GENERIC_SUBMIT_PROFILE,
  deriveActorSubmitProfiles,
  deriveActorSubmitProfilesFor,
  type ActorSubmitProfile,
} from "./schema/actor-submit-profiles.js";
export { serializeSchema } from "./schema/serialize.js";
export {
  MAX_UNION_MEMBERS,
  SCHEMA_DIAGNOSTIC_CODE,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
  type Violation,
} from "./schema/types.js";
export {
  HOST_BINDING,
  lowerWorkflow,
  lowerWorkflowScript,
  type LoweredWorkflow,
  type LowerResult,
} from "./lowering/index.js";
export {
  WorkflowEngine,
  InMemoryJournalStore,
  WorkflowError,
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  NUDGE_ATTEMPTS,
  REPAIR_ATTEMPTS,
  canonicalJson,
  fnv1a,
  inputHash,
  refToString,
  type ActorId,
  type ActorRecord,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactRef,
  type ArtifactVersionRecord,
  type AskMessage,
  type AskLastTool,
  type AskProgress,
  type AskSpec,
  type AskStats,
  type Caps,
  type EngineConfig,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedInFlightAsk,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type NodeKind,
  type NodeOutcome,
  type NodeRecord,
  type NodeRecordStatus,
  type WorldReadInput,
  WORLD_READ_INPUT_MAX_BYTES,
  type PersonaSpec,
  type RunEvent,
  type RunRecord,
  type RunSettlement,
  type RunSettlementRecord,
  type RunStallInfo,
  type RunStatus,
  type RunStopReason,
  type SessionRef,
  type StoredEvent,
  type SubmitVerdict,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowErrorCode,
  type WorkflowErrorJson,
  type ProviderStopDetails,
  type WorkflowErrorMismatch,
  type WorkflowHostApi,
  type WorkflowReportSink,
  type WorldReadOp,
  type AskWaitInfo,
  type ConcurrencyChange,
  type ConcurrencyChangeReason,
} from "./engine/index.js";
export {
  ConcurrencyController,
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  CONCURRENCY_INCREASE_STEP,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "./engine/index.js";
