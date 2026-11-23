const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
const CONVERSATION_CONTENT_WIDTH_CLASS_NAME = "w-full max-w-6xl";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
}): string {
  // The status capsule takes no side space in the message column, so the old summary panel's layout offset is no longer kept.
  return params.centeredEmptyLayout
    ? CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WIDTH_CLASS_NAME;
}
