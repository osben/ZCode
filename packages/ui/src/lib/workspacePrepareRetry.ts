import { isNonRetryableWorkspacePrepareError, type ZCodeProvider } from "@zcode/shared";

export function shouldAutoRetryWorkspacePrepare(errorMessage: string) {
  // Bugfix: the remote ZCode Agent in Docker often fails on resource mismatches, missing optional
  // dependencies, or the process exiting right at startup. These errors previously missed the
  // "not auto-retryable" list, so draft warm-up kept returning to loading and users looked stuck
  // forever. Treat pre-init exit/timeout/missing dependencies uniformly as deterministic failure,
  // stop auto-retrying, and let the UI settle into failed quickly.
  // Bugfix: when the provider is not logged in, prepareWorkspace triggers OAuth; if the user never
  // completes login, auto-retry kept relaunching the same flow, causing repeated login prompts or
  // endless loading. Treat missing auth / login timeout as non-retryable too and leave the next
  // login attempt to a manual retry.
  // Bugfix: the non-retryable error patterns affect both UI auto-retry and the service's
  // MCP-fallback. Reuse the shared central definition so the two string lists cannot drift apart
  // again.
  return !isNonRetryableWorkspacePrepareError(errorMessage);
}

export function shouldRestartWorkspaceProcessBeforePrepareRetry(_params: {
  provider: ZCodeProvider;
  errorMessage: string;
}): boolean {
  // Only the glm provider remains: the restart-retry policy for third-party CLI crash copy is no
  // longer needed.
  return false;
}
