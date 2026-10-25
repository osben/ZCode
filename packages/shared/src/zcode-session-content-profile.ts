// Trimming for session/read with contentProfile="index".
// Background: the task index performs an existing-only session read on every turn completion /
// title change / visibility change. The old implementation fetched the full history (a single
// line of a long session can reach ~15MB), saturating the host stdio pipe and JSON parsing, while
// the index only needs title / searchableText / hasUserVisibleContent / status / model.
// This strips only the large payload fields none of those projections read, keeping message /
// part counts, order, ids, types, and metadata unchanged, so visibility and projection policy
// decisions match the full snapshot exactly (spec: docs/task/task-sqlite-index.md, "Index read
// profile").
// messageLimit cannot be used instead: searchableText takes the first 200K characters and the
// title falls back to the first real user input — both depend on the start of the history.
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import type { ZCodeMessagePart, ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";

export type ZCodeSessionContentProfile = "full" | "index";

const ELIDED_DATA_URL = "data:,";

function elidePartForIndex(part: ZCodeMessagePart): ZCodeMessagePart {
  switch (part.type) {
    case "reasoning":
      return part.text ? { ...part, text: "" } : part;
    case "file":
      return part.url.startsWith("data:") && part.url !== ELIDED_DATA_URL
        ? { ...part, url: ELIDED_DATA_URL }
        : part;
    case "tool": {
      const state = part.state;
      switch (state.status) {
        case "pending":
          return { ...part, state: { ...state, input: {}, raw: "" } };
        case "running":
          return {
            ...part,
            state: { ...state, input: {}, ...(state.metadata ? { metadata: {} } : {}) },
          };
        case "completed":
          return { ...part, state: { ...state, input: {}, output: "", metadata: {} } };
        case "error":
          return {
            ...part,
            state: { ...state, input: {}, error: "", ...(state.metadata ? { metadata: {} } : {}) },
          };
        default:
          return part;
      }
    }
    default:
      return part;
  }
}

function elideMessageForIndex(message: ZCodeMessageWithParts): ZCodeMessageWithParts {
  let changed = false;
  const parts = message.parts.map((part) => {
    const next = elidePartForIndex(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

/** Produces the lightweight snapshot dedicated to the task index; does not mutate the input (CLI-side messages may come from a shared cache). */
export function elideSessionSnapshotForIndex<T extends ZCodeSessionStateSnapshot>(snapshot: T): T {
  return { ...snapshot, messages: snapshot.messages.map(elideMessageForIndex) };
}
