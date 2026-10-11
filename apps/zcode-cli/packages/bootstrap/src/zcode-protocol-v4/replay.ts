// Replay export barrel.
//
// The downstream replay page uses the CLI's three-stage reducer in the browser to rebuild a
// ConversationSnapshot from persisted MessageWithParts: synthesizeEventsFromMessages ->
// mergeColdConversationEvents -> ProductProjection (hydration replay). All three are pure
// functions/classes with no Node dependencies. The replay package's `vite build` checks this
// mechanically: importing a Node built-in through this barrel makes the browser build fail.
//
// Re-export only; define nothing here.
export { ProductProjection } from "./product-projection.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration.js";
export { mergeColdConversationEvents, type ColdEventMergeResult } from "./cold-event-merge.js";
export { HYDRATION_TRACE_ID } from "./projection-state.js";
