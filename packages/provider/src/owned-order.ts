/**
 * Normalize sortable members owned jointly by Built-in and Personal.
 *
 * Unordered Built-in members must stay before user-ordered items, and unordered Personal members must stay after them; otherwise, when a remote Built-in member is added,
 * the next Personal write would incorrectly move it to the end of the entire list.
 */
export function resolveOwnedOrder<T extends string>(
  builtinIds: readonly T[],
  personalIds: readonly T[],
  requestedOrder: readonly T[],
): readonly T[] {
  const builtin = uniqueInOrder(builtinIds);
  const builtinSet = new Set(builtin);
  const personal = uniqueInOrder(personalIds).filter((id) => !builtinSet.has(id));
  const members = new Set([...builtin, ...personal]);
  const ordered = uniqueInOrder(requestedOrder).filter((id) => members.has(id));
  const orderedSet = new Set(ordered);
  return [
    ...builtin.filter((id) => !orderedSet.has(id)),
    ...ordered,
    ...personal.filter((id) => !orderedSet.has(id)),
  ];
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
