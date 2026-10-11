let fallbackSequence = 0;

/** Renderer-local ID: main partitions again by webContents, so cancellation does not affect participants in other windows. */
export function createCuaPermissionOnboardingOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `cua-onboarding-${randomId}`;
  }
  fallbackSequence += 1;
  return `cua-onboarding-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
