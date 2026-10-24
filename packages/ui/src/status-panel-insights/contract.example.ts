// Example wiring (documentation only, not compiled into the app).
// SessionPane derives both models from its snapshot; the status panel renders them inside its own section shell.
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  buildContextSectionModel,
  useLastTurnSectionModel,
  type ContextSectionModel,
  type LastTurnSectionModel,
} from "@/status-panel-insights/index.js";

export function useExampleStatusPanelInsights(snapshot: ConversationSnapshot | null): {
  context: ContextSectionModel | null;
  lastTurn: LastTurnSectionModel | null;
} {
  const lastTurn = useLastTurnSectionModel(snapshot?.rows.window);
  return { context: buildContextSectionModel(snapshot?.usage), lastTurn };
}
