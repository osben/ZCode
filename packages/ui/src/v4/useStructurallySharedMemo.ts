import { useMemo, useRef } from "react";
import { shareStructure } from "@/v4/conversationRowSharing.js";

/**
 * Memoizes `build(input)` and keeps the previous result's identity while it stays deeply equal.
 * Join tables rebuilt from the row window get a new Map on every streaming delta; without this,
 * every context holding them changes and memo on all mounted rows is defeated.
 */
export function useStructurallySharedMemo<I, T>(build: (input: I) => T, input: I): T {
  const built = useMemo(() => build(input), [build, input]);
  const heldRef = useRef<T | undefined>(undefined);
  const shared = shareStructure(heldRef.current, built);
  heldRef.current = shared;
  return shared;
}
