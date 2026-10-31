import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import type { BotTopicPreparation } from "@zcode/shared";
import type { ReactNode } from "react";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import type { HighspeedOutputFooterMark } from "@/highspeed/highspeedOutputFooter.js";

export interface ConversationTurnRenderUnit extends HighspeedOutputFooterMark {
  /** Display projection of unaccepted bot messages; not written to CLI rows or the navigation/share index. */
  topicPreparations?: readonly BotTopicPreparation[];
  /**
   * Session-level context row (worktree setup/created) rendered right after this unit's user
   * inputs — the second timeline item, below the first user message (specs/composer-worktree-setup-steps.md).
   * Attached only to the first unit; timeline-only fallback units render it above their content.
   */
  afterFirstUserInputSlot?: ReactNode;
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * Aggregated history rows across all visual work segments, kept for copy, preview, and
   * legacy-call compatibility. Actual collapse boundaries read workSegments, and each
   * segment must preserve the CLI row total order internally.
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** Rows after the action body anchor and before the real turn-end marker; rendered in place, preserving CLI total order. */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** Browser auto turn-end screenshots: rendered after the file diff summary and before the message actions bar in the completed state. */
  browserTurnEndRows: AssistantWorkRow[];
  /** Turn-local hook product rows; excluded from assistant work/collapse, used only by the turn-end details action. */
  hookInvocations: HookInvocationRow[];
  /** S2: all assistant text segments in the turn, used for copy/preview aggregation; not a render position. */
  assistantTextRows: AssistantTextRow[];
  /** Lightweight boundary (modelChange, S13): turn-top divider rendered before user input. */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** Final completed-state body at the turn tail; fork/retry/action/preview attach only to this segment. */
  latestAssistantTextRow?: AssistantTextRow;
  /** Visible interleaving order of user/assistant within one product turn; adjacent work rows stay grouped. */
  flowItems: ConversationTurnFlowItem[];
  /** One segment per raw input; guides taken at the same drain boundary share the segment opened by the first one, whose header comes from header.workSegments. */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** Turn-level aggregated work status, kept for legacy-call compatibility; new components consume workSegments[].workStatus. */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** Launch metadata for turns started directly from the hub (rules in `workflowLaunchTurn.ts`); when present the turn renders as a run card with no user bubble. */
  workflowLaunch?: WorkflowLaunchMeta;
}

export interface BuildConversationTurnRenderUnitsOptions {
  nowMs?: number;
  sessionPhase?: SessionPhase;
  /** Plugin card collapse adjudication (the timeline is assembled from derived results + manual state). */
  pluginUiPinResolver?: PluginUiRowPinResolver;
  /**
   * Per-timeline memo. When supplied, a non-running turn whose inputs are unchanged keeps the same unit object
   * across calls (docs/ui/v4-chat-turn-render-units.md, rendering performance rules). Owned by one timeline instance.
   */
  cache?: ConversationTurnRenderUnitCache;
}

export interface ConversationTurnRenderUnitCache {
  entries: Map<string, ConversationTurnRenderUnitCacheEntry>;
}

/** Inputs that decide a turn's materialized unit, plus the derived unit objects reused while those inputs hold. */
export interface ConversationTurnRenderUnitCacheEntry {
  header: TurnHeaderRow | undefined;
  orderedRows: readonly ConversationRow[];
  sessionPhase: SessionPhase | undefined;
  isLastDraft: boolean;
  pinSignature: string;
  materialized: ConversationTurnRenderUnit;
  normalized?: {
    source: ConversationTurnRenderUnit;
    isLast: boolean;
    unit: ConversationTurnRenderUnit;
  };
  footer?: {
    base: ConversationTurnRenderUnit;
    unit: ConversationTurnRenderUnit;
  };
}
