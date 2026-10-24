# Mobile Remote Control Home Covered by the Occupation Onboarding

Status: needs-triage

## 2026-10-11 Baseline Re-check

On business baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, the full batch `r3-server-20261011105317614-4a6780` shows in `soakdual/mobile-initial.json` the real remote project, the original task ID and the first-round message, with `failures=[]` and no `onboarding-page`. The 146.2-second failure of that run was caused by the pairing helper still waiting for the retired copy "已连接到当前桌面窗口" (connected to the current desktop window), not by a recurrence of the old onboarding problem below.

The test now waits for the task/project node specified by the caller, and the original case then checks the Desktop's mobile connection state; an empty sidebar does not count as success. The draft-specific case uses the new-task entry with the original projectId and still requires zero model messages. A unit test reproduced the missing old hint and verified the new readiness criterion; the real-phone follow-up chain and the 10-minute soak still need to be re-run. The old baseline evidence below is kept; this round does not conclude from the old problem that mobile is still blocked by onboarding.

## Expected and Actual

The [mobile remote-control contract](../../web-remote-control/web-remote-control-architecture.md) requires that after scanning the code the phone enters the task home and browses the current desktop window's workspaces and tasks. On the branch at that time, the phone browser loaded the same-version Web assets and entered the home-only Root, but showed the three-step occupation onboarding, covering the task home and the pairing-state copy. This blocked `mobile` and `mobileperm` from verifying task switching, permissions and network-loss recovery; skipping onboarding or seeding mobile state must not be used to mark these paths as passing.

## Actual Evidence

- Business baseline: `54ece08f23f79ae54aea1f51e0d941497d627392`, no business code modified.
- Batch: `r3-server-20260924051309226-ac32d1`, server `/home/e2e/z-code-stability-20260924`.
- `mobile` and `mobileperm` each used an independent Desktop HOME, container and Playwright context, and both failed waiting for the home.
- Both `mobile-pairing-1.json` record `testIds: ["onboarding-page"]`, with the body "工作方向 / UI 模式 / 助手偏好" (work direction / UI mode / assistant preference), and an empty resource-loading error array.
- The independent batch `r3-server-20260924054830817-45203b` `soakdual` also showed the same page and failed after 199 seconds; it had not entered the 10-minute observation, so stability cannot be claimed verified.
- The branch's Web build was hosted by the test host loopback, HTML and JavaScript really returned 200; the real test relay and the product pairing flow stayed unchanged.
- Local evidence: mobile (`packages/desktop/.e2e-artifacts/remote-stability-20260924/mobile-pairing-recheck07.json`), mobileperm (`packages/desktop/.e2e-artifacts/remote-stability-20260924/mobileperm-pairing-recheck07.json`). Full artifacts are kept on the server under `.e2e-artifacts/<batch>-<case>/` and contain no public pairing credential.

## Code Location

1. `renderExternalRelayHomeOnlyRoot` in `packages/web/src/main.tsx` uses `createHomeOnlyWebRemoteControlServices()`; its settings have only recentProjects/locale and provide no onboardingRecordService.
2. `packages/ui/src/Root.tsx` wraps the workspace/home content in `OccupationOnboarding` on both desktop and mobile paths.
3. `packages/ui/src/onboarding/useOnboardingTrigger.ts` falls back to `!hasStoredOccupation` when the record service is absent, so the home-only services trigger onboarding.

This is a call-chain location consistent with the real-device result; no implementation was modified, and it is not attributed to a relay or SSH failure.

## Reproduction and Acceptance

In a prepared remote harness run `node harness/remote/run-queue.mjs mobile mobileperm`. A fix must keep the read-only empty-service boundary of the mobile home, and must not create an independent Host/Agent or force a workspace connection just to initialize the home. Then verify that a fresh context, re-pairing and a disconnected-workspace home all reach the task list and still complete the original mobile/mobileperm/soakdual assertions.

A separate environment problem is the script 404 of the published test site `/remote/v4?app_version=3.12.2`, see the harness notes (`harness/remote/README.md`). That 404 must not be conflated with the same-version resource onboarding cover of this Issue.
