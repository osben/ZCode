interface ManualClaimReleaseRepo {
  get(automationId: string): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

async function releaseManualClaimForSettledRun(params: ManualClaimReleaseParams): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // Main may report a late result after a scheduler restart or loss of inFlight state. Recover workspaceKey
  // for the manual single-flight lock from the run ledger or automation; otherwise it remains stuck until
  // stale-claim cleanup.
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // A host result of ok means only that the prompt was accepted/queued. The host subscription reports
  // the actual terminal state; the scheduler releases the manual claim only if dispatch fails and there
  // is no turn to await.
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
