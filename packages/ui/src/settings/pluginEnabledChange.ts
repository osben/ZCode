interface SuccessfulPluginEnabledChangeOptions {
  submit: () => Promise<boolean>;
  isCurrent: () => boolean;
  onSuccess: () => void | Promise<void>;
}

/**
 * Continue to permission onboarding or runtime refresh only after the server confirms this Plugin enable/disable action succeeded.
 *
 * The old flow opened the permission dialog before the CUA enable RPC completed. If the RPC failed or its response arrived after a page switch,
 * users could still see an outdated dialog that let them grant permission, creating a split state of "Plugin not enabled but permission granted."
 */
export async function runAfterSuccessfulPluginEnabledChange({
  submit,
  isCurrent,
  onSuccess,
}: SuccessfulPluginEnabledChangeOptions): Promise<boolean> {
  const succeeded = await submit();
  if (!succeeded || !isCurrent()) {
    return false;
  }

  await onSuccess();
  return true;
}
