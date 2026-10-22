import type { ToolPart } from "@zcode/contracts";

export function selectToolPartsForHistory(allParts: ToolPart[]): ToolPart[] {
  // ACP tool rows of an external agent turn are record-only (external-agent-tool-rows.ts): their
  // names are not tools the provider declares, so a later regular model never sees them.
  const parts = allParts.filter((part) => part.metadata?.externalAgent !== true);
  // Early execution failures or stream recovery create another part; restore only the latest record for a declaration so late updates to old parts do not affect selection.
  // Preserve the physical order of selected records; original parts remain available for UI and file read-state recovery.
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  if (latestParts.some((part) => part.declarationIndex === undefined)) {
    // Old records or mixed versions may lack declaration sequence numbers; preserve the original order of the entire group.
    return latestParts;
  }
  // Read-only tools may be persisted first; provider calls/results should share declaration order without changing the UI's original parts.
  return latestParts.sort((left, right) => left.declarationIndex! - right.declarationIndex!);
}
