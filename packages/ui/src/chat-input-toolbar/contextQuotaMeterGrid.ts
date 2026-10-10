export function getContextQuotaMeterGridClass(count: number): string {
  // Start/Coding quotas come from a server snapshot and may have 1/2/3 entries; the official MCP
  // is now a full-width row below the grid, so even an accidentally larger count must not compress the 320px overlay into four columns.
  // A fixed three-column layout leaves gaps with two quotas and needlessly narrows a single quota.
  if (count <= 1) {
    return "grid-cols-1";
  }
  if (count === 2) {
    return "grid-cols-2";
  }
  if (count === 3) {
    return "grid-cols-3";
  }
  return "grid-cols-3";
}
