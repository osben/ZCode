/** Ignore a late failure from another path when the same login attempt has already succeeded or is completing its success callback. */
export function shouldApplyOAuthPollingFailure(
  loginSucceeded: boolean,
  loginSuccessInFlight = false,
): boolean {
  return !loginSucceeded && !loginSuccessInFlight;
}
