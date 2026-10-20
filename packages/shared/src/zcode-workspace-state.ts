// Workspace-level state snapshot for the UI (upstream 3.16.1 name). Derived from the session snapshot schema so the
// protocol stays the single source of the field shapes; this module adds no schema and no transport.
import type {
  ZCodeSessionSettingsState,
  ZCodeSessionStateSnapshot,
} from "./zcode-protocol/index.js";

export interface ZCodeWorkspaceStateSnapshot {
  workspace: ZCodeSessionStateSnapshot["session"]["workspace"];
  settings: ZCodeSessionSettingsState;
  slashCommands?: ZCodeSessionStateSnapshot["slashCommands"];
}
