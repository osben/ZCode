import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";

export const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
export const CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
export const CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";

export const CONVERSATION_STATUS_PANEL_INLINE_OFFSET_CLASS_NAME = "-translate-x-42";
export const CONVERSATION_STATUS_PANEL_INLINE_OFFSET_PX = 168;
export const CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME =
  "@min-[1280px]/conversation:-translate-x-42";

// The status pill floats over the conversation's top-right corner (ConversationStatusPanel: top-0 + pt-4 +
// pill max-h-8.5, bottom edge at 50px); content at the very top of the conversation must yield this height,
// or it is covered by the pill and clicks land on the pill.
// Bug root cause: this clearance used to be a side effect of the pt-14 above the first turn's user bubble;
// turns started directly by the hub have no bubble and zero top padding, so the run card's header
// config / stop / details buttons ended up under the pill and unclickable.
// The timeline now explicitly reserves this inset for the session's first turn, and the first turn itself
// no longer adds top padding (see presentation.md "The run card").
export const CONVERSATION_STATUS_PANEL_TOP_CLEARANCE_CLASS_NAME = "pt-14";

export type ConversationStatusPanelResolvedVariant = ChatViewSummaryPanelVariant | "auto";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
  statusPanelLayout: "none" | "auto" | "inline";
}): string {
  if (params.centeredEmptyLayout) return CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME;

  // Use 1280px for wide layouts to prevent content columns from jumping across breakpoints when panel state changes.
  return params.statusPanelLayout === "none"
    ? CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME;
}

export function resolveConversationStatusPanelVariant(params: {
  variantOverride: ConversationStatusPanelResolvedVariant | null;
}): ConversationStatusPanelResolvedVariant {
  // Preserve automatic mode through to the DOM so the conversation container query determines the actual layout;
  // React no longer translates container width into business state through ResizeObserver.
  return params.variantOverride ?? "auto";
}

export function shouldUseConversationStatusPanelInlineLayout(params: {
  hasContent: boolean;
  variant: ConversationStatusPanelResolvedVariant;
}): boolean {
  return params.hasContent && params.variant !== "mini";
}

export function getConversationStatusPanelOffsetClassName(
  layout: "none" | "auto" | "inline",
): string | undefined {
  // Enable the status panel and wide conversation layout at the same 1280px breakpoint so panel state changes do not shift the responsive threshold.
  return layout === "none" ? undefined : CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME;
}
