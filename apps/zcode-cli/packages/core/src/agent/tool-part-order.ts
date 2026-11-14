import { sortByCompleteIndex, type ToolPart } from "@zcode/contracts";

export function selectToolPartsForHistory(allParts: ToolPart[]): ToolPart[] {
  // ACP tool rows of an external agent turn are record-only (external-agent-tool-rows.ts): their
  // names are not tools the provider declares, so a later regular model never sees them.
  const parts = allParts.filter((part) => part.metadata?.externalAgent !== true);
  // Early execution failures or stream recovery create another part; restore only the latest record for a declaration so late updates to old parts do not affect selection.
  // Preserve the physical order of selected records; original parts remain available for UI and file read-state recovery.
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  // 只读工具可能先落盘；provider calls/results 共用同一份排序，不改 UI 的原始 parts。
  // 依次按 blockIndex（新记录）、declarationIndex（旧记录）排序；整组缺序号时保留原序。
  // 序号是否合法和库、请求投影一样用 isBlockIndex 判定：null、负数、小数按缺失处理，不参与排序。
  return (
    sortByCompleteIndex(latestParts, (part) => part.blockIndex) ??
    sortByCompleteIndex(latestParts, (part) => part.declarationIndex) ??
    latestParts
  );
}
