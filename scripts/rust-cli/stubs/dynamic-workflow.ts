// Generator-only re-export of the two dynamic-workflow symbols the driver helpers use (`refToString`,
// `WorkflowError`). The package index pulls in the compiler, whose generated libs are not in a checkout
// until the app build runs, so the generator points here instead. The files re-exported are Node's own.
export { refToString } from "../../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";
export { WorkflowError } from "../../../apps/zcode-cli/packages/dynamic-workflow/src/engine/errors.ts";
export type {
  ActorRef,
  AskStats,
  InstanceRef,
  PersonaSpec,
  Violation,
  WorkflowReportSink,
  RunEvent,
} from "../../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";
