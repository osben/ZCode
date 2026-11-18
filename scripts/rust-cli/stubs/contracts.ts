// Generator-only stub for `@zcode/contracts`: the driver helpers read two runtime values from it.
// Both copy the contracts source, checked on this branch:
// - createSessionId(id) returns `sess_${id}` (apps/zcode-cli/packages/contracts/src/interfaces/shared.ts:31);
// - CoreErrorType.TurnCancelled is "turn_cancelled" (apps/zcode-cli/packages/contracts/src/errors/index.ts:19).
// The crypto.randomUUID fallback is never reached by the helpers (they always pass an id).
export const createSessionId = (id?: string): string => `sess_${id ?? ""}`;
export const CoreErrorType = { TurnCancelled: "turn_cancelled" } as const;
