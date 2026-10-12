import { describe, expect, it } from "vitest";
import type { CodingPlanResetStatusSnapshot, UsageQuotaLimit } from "@zcode/shared";
import {
  CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
  CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
  advanceCodingPlanQuotaResetCelebration,
  applyCodingPlanQuotaResetStatus,
  completeCodingPlanQuotaResetEntitlementRefresh,
  failCodingPlanQuotaResetManualUse,
  hasUsableCodingPlanQuotaResetOpportunity,
  startCodingPlanQuotaResetManualUse,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetAutomaticPhase,
  resolveCodingPlanQuotaResetLimit,
  resolveCodingPlanQuotaResetRemainingPercentage,
  resolveCodingPlanQuotaResetStatusVisible,
  mergeCodingPlanQuotaResetOpportunityBadges,
} from "@/lib/codingPlanQuotaResetUi.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function buildLimit(overrides: Partial<UsageQuotaLimit> = {}): UsageQuotaLimit {
  return {
    type: "TOKENS_LIMIT",
    percentage: 42,
    nextResetTime: Date.UTC(2026, 7, 7, 15, 0, 0),
    usageDetails: [],
    ...overrides,
  };
}

describe("coding plan quota reset ui state", () => {
  it("触发器撒花只认自动完成的新 used_at，手动完成不播放", () => {
    // Manual redemption (not the automatic completion window): the trigger never celebrates,
    // regardless of whether processing was passed through.
    const manualDone = advanceCodingPlanQuotaResetCelebration(null, {
      sourceKey: "builtin:personal",
      completedAt: 1_000,
      automaticCompletion: false,
    });
    expect(manualDone.shouldCelebrate).toBe(false);

    // Automatic completion: a new used_at for the same source plays once; repeated
    // renders/polling do not replay.
    const automaticDone = advanceCodingPlanQuotaResetCelebration(manualDone.state, {
      sourceKey: "builtin:personal",
      completedAt: 2_000,
      automaticCompletion: true,
    });
    expect(automaticDone.shouldCelebrate).toBe(true);
    expect(
      advanceCodingPlanQuotaResetCelebration(automaticDone.state, {
        sourceKey: "builtin:personal",
        completedAt: 2_000,
        automaticCompletion: true,
      }).shouldCelebrate,
    ).toBe(false);

    // A new automatic reset for the same source afterwards (new used_at) should play once more.
    const nextAutomatic = advanceCodingPlanQuotaResetCelebration(automaticDone.state, {
      sourceKey: "builtin:personal",
      completedAt: 3_000,
      automaticCompletion: true,
    });
    expect(nextAutomatic.shouldCelebrate).toBe(true);

    // Switching source clears the trail: the same used_at for a new source is judged
    // independently, not inheriting the old source's record.
    const switched = advanceCodingPlanQuotaResetCelebration(nextAutomatic.state, {
      sourceKey: "team-plan:builtin:team-a",
      completedAt: 3_000,
      automaticCompletion: true,
    });
    expect(switched.shouldCelebrate).toBe(true);
    expect(switched.state).toEqual({
      sourceKey: "team-plan:builtin:team-a",
      celebratedCompletedAt: 3_000,
    });

    // Without completedAt (available/processing), never celebrate.
    expect(
      advanceCodingPlanQuotaResetCelebration(switched.state, {
        sourceKey: "team-plan:builtin:team-a",
        completedAt: null,
        automaticCompletion: true,
      }).shouldCelebrate,
    ).toBe(false);
  });

  it("只根据服务端有效机会创建 AVAILABLE，取最早过期时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const status: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [
        { expireAt: now + 60_000 },
        { expireAt: now + 30_000 },
        { expireAt: now - 1 },
      ],
      availableWeekResets: [],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };

    expect(applyCodingPlanQuotaResetStatus(null, status, now)).toEqual({
      status: "available",
      opportunityCount: 2,
      opportunityExpiresAt: now + 30_000,
      startedAt: null,
      completedAt: null,
      observedAt: null,
      quotaOverridePending: false,
      nextResetAt: null,
      idempotencyKey: null,
      error: null,
    });
  });

  it("旧历史未标记 unread 时不在首次挂载伪造完成态", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    expect(
      applyCodingPlanQuotaResetStatus(
        null,
        {
          availableFiveHourResets: [],
          availableWeekResets: [],
          latestFiveHourResetHistory: { usedAt: now - FIVE_HOURS_MS },
          latestWeekResetHistory: null,
          hasUnreadHistory: false,
        },
        now,
      ),
    ).toBeNull();
  });

  it("自动 unread 历史或手动 processing 对账后使用服务端 usedAt 完成", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const status: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };

    const automatic = applyCodingPlanQuotaResetStatus(null, status, now);
    expect(automatic?.status).toBe("completed");
    expect(automatic?.completedAt).toBe(usedAt);
    expect(automatic?.observedAt).toBe(now);
    expect(automatic?.quotaOverridePending).toBe(true);

    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...status,
        latestFiveHourResetHistory: null,
        hasUnreadHistory: false,
        availableFiveHourResets: [{ expireAt: now + 30_000 }],
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "retry-same-key", now);
    // The manual reconciliation's manualStartedAt is provided by the hook's shared trail:
    // used_at already differs from the pre-click baseline.
    const manual = applyCodingPlanQuotaResetStatus(
      processing,
      { ...status, hasUnreadHistory: false },
      now + 1_000,
      now,
    );
    expect(manual?.status).toBe("completed");
    expect(manual?.completedAt).toBe(usedAt);
    expect(manual?.idempotencyKey).toBeNull();
  });

  it("跨入口观察手动完成历史时使用共享 startedAt，重复轮询不退化为自动完成", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now + 1_000;
    const manualStartedAt = now - 500;
    const snapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      // Before other entries read, the originating entry may already have marked the unread
      // history as read.
      hasUnreadHistory: false,
    };

    const completed = applyCodingPlanQuotaResetStatus(null, snapshot, now, manualStartedAt);
    expect(completed?.startedAt).toBe(manualStartedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(false);

    const repeated = applyCodingPlanQuotaResetStatus(completed, snapshot, now + 30_000);
    expect(repeated?.startedAt).toBe(manualStartedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(repeated, now + 30_000)).toBe(false);
  });

  it("自动重置短提示从首次观察时间开始，重复轮询同一 usedAt 不续期", () => {
    const usedAt = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstObservedAt = usedAt + 30_000;
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };

    const first = applyCodingPlanQuotaResetStatus(null, snapshot, firstObservedAt);
    expect(first?.completedAt).toBe(usedAt);
    expect(first?.observedAt).toBe(firstObservedAt);
    expect(resolveCodingPlanQuotaResetStatusVisible(first, firstObservedAt)).toBe(true);

    const repeated = applyCodingPlanQuotaResetStatus(
      first,
      { ...snapshot, hasUnreadHistory: false },
      firstObservedAt + 2_000,
    );
    expect(repeated?.observedAt).toBe(firstObservedAt);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        repeated,
        firstObservedAt + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
      ),
    ).toBe(false);
  });

  it("手动失败恢复 AVAILABLE 并保留原幂等键供重试", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 30_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "same-key", now);
    const failed = failCodingPlanQuotaResetManualUse(processing, "code=2007");

    expect(failed).toMatchObject({
      status: "available",
      idempotencyKey: "same-key",
      error: "code=2007",
    });
    expect(
      startCodingPlanQuotaResetManualUse(failed, "must-not-replace", now + 1_000)?.idempotencyKey,
    ).toBe("same-key");
  });

  it("已完成时对 5 小时额度覆盖为 100% 剩余并改写下次重置时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: true,
      },
      now,
    );

    const overridden = resolveCodingPlanQuotaResetLimit(buildLimit(), completed);
    expect(overridden?.percentage).toBe(0);
    expect(overridden?.nextResetTime).toBe(now + FIVE_HOURS_MS);

    const refreshed = completeCodingPlanQuotaResetEntitlementRefresh(completed, now);
    expect(refreshed?.quotaOverridePending).toBe(false);
    expect(resolveCodingPlanQuotaResetLimit(buildLimit(), refreshed)).toEqual(buildLimit());
    // Bugfix: after a reset, when the quota pool has no active window, the refreshed real quota
    // lacks nextResetTime; during the completed state keep falling back to completedAt + period,
    // so the reset time does not flash and vanish.
    expect(
      resolveCodingPlanQuotaResetLimit(buildLimit({ nextResetTime: undefined }), refreshed),
    ).toMatchObject({ percentage: 42, nextResetTime: now + FIVE_HOURS_MS });
    const repeated = applyCodingPlanQuotaResetStatus(
      refreshed,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now + 30_000,
    );
    expect(repeated?.quotaOverridePending).toBe(false);

    // Keep the server's real quota when not completed (available / processing).
    expect(
      resolveCodingPlanQuotaResetLimit(
        buildLimit(),
        applyCodingPlanQuotaResetStatus(
          null,
          {
            availableFiveHourResets: [{ expireAt: now + 60_000 }],
            availableWeekResets: [],
            latestFiveHourResetHistory: null,
            latestWeekResetHistory: null,
            hasUnreadHistory: false,
          },
          now,
        ),
      ),
    ).toEqual(buildLimit());
    expect(
      resolveCodingPlanQuotaResetLimit(
        buildLimit(),
        startCodingPlanQuotaResetManualUse(
          applyCodingPlanQuotaResetStatus(
            null,
            {
              availableFiveHourResets: [{ expireAt: now + 60_000 }],
              availableWeekResets: [],
              latestFiveHourResetHistory: null,
              latestWeekResetHistory: null,
              hasUnreadHistory: false,
            },
            now,
          ),
          "key",
          now,
        ),
      ),
    ).toEqual(buildLimit());
  });

  it("未完成时保留服务端返回的真实剩余百分比", () => {
    expect(
      resolveCodingPlanQuotaResetRemainingPercentage(
        37,
        applyCodingPlanQuotaResetStatus(
          null,
          {
            availableFiveHourResets: [{ expireAt: Date.UTC(2026, 7, 7) + 60_000 }],
            availableWeekResets: [],
            latestFiveHourResetHistory: null,
            latestWeekResetHistory: null,
            hasUnreadHistory: false,
          },
          Date.UTC(2026, 7, 7),
        ),
      ),
    ).toBe(37);
  });

  it("手动重置只播放按钮烟花，不显示 processing 或 completed Tooltip", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 60_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(resolveCodingPlanQuotaResetStatusVisible(available, now)).toBe(false);

    const processing = startCodingPlanQuotaResetManualUse(available, "key", now);
    expect(resolveCodingPlanQuotaResetStatusVisible(processing, now + 999_999)).toBe(false);

    const completed = applyCodingPlanQuotaResetStatus(
      processing,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now },
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(false);
  });

  it("自动或运营重置的 completed Tooltip 在展示窗口结束后收起", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: { usedAt: now - 30_000 },
        latestWeekResetHistory: null,
        hasUnreadHistory: true,
      },
      now,
    );

    expect(resolveCodingPlanQuotaResetStatusVisible(completed, now)).toBe(true);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        completed,
        now + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS - 1,
      ),
    ).toBe(true);
    expect(
      resolveCodingPlanQuotaResetStatusVisible(
        completed,
        now + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
      ),
    ).toBe(false);
    expect(resolveCodingPlanQuotaResetStatusVisible(null, now)).toBe(false);
  });

  it("Composer 自动重置合成阶段：先正在重置再常驻已重置，hover 收起且手动/未完成不进入", () => {
    const usedAt = Date.UTC(2026, 7, 7, 10, 0, 0);
    const observedAt = usedAt + 30_000;
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const automatic = applyCodingPlanQuotaResetStatus(null, snapshot, observedAt);
    expect(automatic?.startedAt).toBeNull();
    expect(automatic?.observedAt).toBe(observedAt);

    // Shows "resetting" for about 1 second from the first observation.
    expect(resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt, false)).toBe(
      "processing",
    );
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(
        automatic,
        observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS - 1,
        false,
      ),
    ).toBe("processing");

    // After the window expires it switches to "reset", with no upper bound — it stays forever.
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(
        automatic,
        observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
        false,
      ),
    ).toBe("completed");
    expect(
      resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt + 3_600_000, false),
    ).toBe("completed");

    // Returns null once collapsed by hover.
    expect(resolveCodingPlanQuotaResetAutomaticPhase(automatic, observedAt, true)).toBeNull();

    // Manual completions (startedAt not null) do not enter the trigger synthesis phase.
    const manual = applyCodingPlanQuotaResetStatus(null, snapshot, observedAt, usedAt - 500);
    expect(manual?.startedAt).toBe(usedAt - 500);
    expect(resolveCodingPlanQuotaResetAutomaticPhase(manual, observedAt, false)).toBeNull();

    // available / null do not enter.
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: observedAt + 60_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      observedAt,
    );
    expect(resolveCodingPlanQuotaResetAutomaticPhase(available, observedAt, false)).toBeNull();
    expect(resolveCodingPlanQuotaResetAutomaticPhase(null, observedAt, false)).toBeNull();
  });

  it("按 resetType 读取周额度机会创建 AVAILABLE", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const status: CodingPlanResetStatusSnapshot = {
      // Five hours has no opportunity, the weekly quota does: resetType=WEEK should read only the
      // week fields.
      availableFiveHourResets: [],
      availableWeekResets: [{ expireAt: now + 90_000 }, { expireAt: now + 45_000 }],
      latestFiveHourResetHistory: null,
      latestWeekResetHistory: null,
      hasUnreadHistory: false,
    };

    expect(applyCodingPlanQuotaResetStatus(null, status, now, null, "WEEK")).toMatchObject({
      status: "available",
      opportunityCount: 2,
      opportunityExpiresAt: now + 45_000,
    });
    // Within the same status, FIVE_HOUR has no opportunity and must not be pulled into available
    // by the weekly opportunities.
    expect(applyCodingPlanQuotaResetStatus(null, status, now)).toBeNull();
  });

  it("周额度未读历史完成时按 7 天乐观改写下次重置时间", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: { usedAt },
        hasUnreadHistory: true,
      },
      now,
      null,
      "WEEK",
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBe(usedAt);
    expect(completed?.nextResetAt).toBe(usedAt + WEEK_MS);

    const overridden = resolveCodingPlanQuotaResetLimit(buildLimit(), completed);
    expect(overridden?.percentage).toBe(0);
    expect(overridden?.nextResetTime).toBe(usedAt + WEEK_MS);
  });

  it("同一 used_at 周期内新发放的机会打破粘滞完成态,回到 AVAILABLE", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const usedAt = now - 1_000;
    const completedSnapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(null, completedSnapshot, now);
    expect(completed?.status).toBe("completed");

    // The backend re-grants an opportunity within the same cycle (used_at unchanged): the
    // completed state must yield, otherwise the UI swallows the new opportunity forever and the
    // user has to sign in again to clear the window's in-memory state before seeing the reset
    // entry.
    const regrantSnapshot: CodingPlanResetStatusSnapshot = {
      ...completedSnapshot,
      availableFiveHourResets: [{ expireAt: now + 120_000 }],
      hasUnreadHistory: false,
    };
    const revived = applyCodingPlanQuotaResetStatus(completed, regrantSnapshot, now + 60_000);
    expect(revived?.status).toBe("available");
    expect(revived?.opportunityCount).toBe(1);

    // Shared manual-trail attribution follows the same rule: with a new opportunity, used_at is
    // no longer attributed to the old manual completion.
    expect(
      applyCodingPlanQuotaResetStatus(null, regrantSnapshot, now + 60_000, usedAt - 500)?.status,
    ).toBe("available");

    // Sticky retention without new opportunities: repeated polling must not clear the completed
    // state.
    const sticky = applyCodingPlanQuotaResetStatus(
      completed,
      { ...completedSnapshot, hasUnreadHistory: false },
      now + 60_000,
    );
    expect(sticky?.status).toBe("completed");

    // A just-discovered unread completion takes priority over new opportunities: the completion
    // notice and quota correction play first, yielding on the next round.
    const unreadWithOpportunity = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...regrantSnapshot,
        hasUnreadHistory: true,
      },
      now,
    );
    expect(unreadWithOpportunity?.status).toBe("completed");

    // processing reconciliation is unaffected: with an opportunity balance > 0, the manual /use
    // confirmation loop can still see completed.
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        ...completedSnapshot,
        latestFiveHourResetHistory: null,
        hasUnreadHistory: false,
        availableFiveHourResets: [{ expireAt: now + 60_000 }],
      },
      now,
    );
    const processing = startCodingPlanQuotaResetManualUse(available, "key", now);
    const confirmed = applyCodingPlanQuotaResetStatus(
      processing,
      regrantSnapshot,
      now + 1_000,
      now,
    );
    expect(confirmed?.status).toBe("completed");
  });

  it("同类型多张机会：完成态携带余下机会，可直接再次核销，耗尽后不可核销", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstUsedAt = now + 1_000;
    const available = applyCodingPlanQuotaResetStatus(
      null,
      {
        availableFiveHourResets: [{ expireAt: now + 60_000 }, { expireAt: now + 120_000 }],
        availableWeekResets: [],
        latestFiveHourResetHistory: null,
        latestWeekResetHistory: null,
        hasUnreadHistory: false,
      },
      now,
    );
    expect(hasUsableCodingPlanQuotaResetOpportunity(available, now)).toBe(true);
    const processing = startCodingPlanQuotaResetManualUse(available, "first-key", now);
    // No second redemption during processing, preventing the same ticket from being /use'd twice.
    expect(hasUsableCodingPlanQuotaResetOpportunity(processing, now)).toBe(false);

    // Redeem the earliest-expiring ticket: the same status snapshot yields both used_at and the
    // remaining 1 opportunity.
    const afterFirstUse: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [{ expireAt: now + 120_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: firstUsedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(processing, afterFirstUse, now + 2_000, now);
    expect(completed).toMatchObject({
      status: "completed",
      completedAt: firstUsedAt,
      // The completed state no longer zeroes out remaining opportunities; otherwise the dialog
      // would render the empty expiry as "0m 0s".
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: null,
    });
    expect(hasUsableCodingPlanQuotaResetOpportunity(completed, now + 2_000)).toBe(true);

    // Direct re-redemption in the completed state: enter processing with a new idempotency key,
    // keeping the opportunity snapshot for failure recovery.
    const secondProcessing = startCodingPlanQuotaResetManualUse(
      completed,
      "second-key",
      now + 3_000,
    );
    expect(secondProcessing).toMatchObject({
      status: "processing",
      startedAt: now + 3_000,
      completedAt: null,
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: "second-key",
    });
    expect(failCodingPlanQuotaResetManualUse(secondProcessing, "code=2007")).toMatchObject({
      status: "available",
      opportunityCount: 1,
      opportunityExpiresAt: now + 120_000,
      idempotencyKey: "second-key",
    });

    // After the last ticket is redeemed, opportunities are exhausted: the completed state has
    // count 0 and empty expiry, and no further redemption is possible.
    const exhausted = applyCodingPlanQuotaResetStatus(
      secondProcessing,
      {
        ...afterFirstUse,
        availableFiveHourResets: [],
        latestFiveHourResetHistory: { usedAt: now + 4_000 },
      },
      now + 5_000,
      now + 3_000,
    );
    expect(exhausted).toMatchObject({
      status: "completed",
      completedAt: now + 4_000,
      opportunityCount: 0,
      opportunityExpiresAt: null,
    });
    expect(hasUsableCodingPlanQuotaResetOpportunity(exhausted, now + 5_000)).toBe(false);
    expect(startCodingPlanQuotaResetManualUse(exhausted, "noop-key", now + 5_000)).toBe(exhausted);

    // Remaining opportunities expired: likewise not redeemable; start keeps the original state.
    expect(hasUsableCodingPlanQuotaResetOpportunity(completed, now + 120_000)).toBe(false);
    expect(startCodingPlanQuotaResetManualUse(completed, "expired-key", now + 120_000)).toBe(
      completed,
    );
    expect(hasUsableCodingPlanQuotaResetOpportunity(null, now)).toBe(false);

    // Action next to the quota title: while a redeemable opportunity exists, no "reset done"
    // anchor is shown and the "Reset" entry stays; it only appears after exhaustion.
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: completed, opportunityVisible: true }),
    ).toBeNull();
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: exhausted, opportunityVisible: false }),
    ).toBe(now + 4_000);
    expect(
      resolveCodingPlanQuotaResetActionCompletedAt({ entry: null, opportunityVisible: false }),
    ).toBeNull();
  });

  it("processing 只认不同于点击前基线的新 used_at：滞后快照（含 unread 未清）保持处理中", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const firstUsedAt = now - 2_000;
    // The first ticket was just redeemed: the completed state carries the remaining 1, and the
    // previous ticket's history/read may not have taken effect yet.
    const afterFirstUse: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [{ expireAt: now + 60_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: firstUsedAt },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    };
    const completed = applyCodingPlanQuotaResetStatus(
      null,
      afterFirstUse,
      now - 1_000,
      now - 3_000,
    );
    expect(completed).toMatchObject({ status: "completed", opportunityCount: 1 });

    const processing = startCodingPlanQuotaResetManualUse(completed, "second-key", now);
    // After /use, status is still the pre-consumption snapshot: after comparing the shared-trail
    // baseline, no manualStartedAt is given.
    // Regardless of whether unread has been cleared, the previous ticket's used_at must not be
    // treated as this completion.
    for (const hasUnreadHistory of [true, false]) {
      expect(
        applyCodingPlanQuotaResetStatus(
          processing,
          { ...afterFirstUse, hasUnreadHistory },
          now + 100,
        ),
      ).toBe(processing);
    }

    // Only after reading a new used_at does the trail bind and manualStartedAt get supplied,
    // entering completion and showing the remaining count from the new snapshot.
    const confirmed = applyCodingPlanQuotaResetStatus(
      processing,
      {
        ...afterFirstUse,
        availableFiveHourResets: [],
        latestFiveHourResetHistory: { usedAt: now + 500 },
      },
      now + 800,
      now,
    );
    expect(confirmed).toMatchObject({
      status: "completed",
      completedAt: now + 500,
      startedAt: now,
      opportunityCount: 0,
    });
  });

  it("五小时与周机会徽标合并:次数累加,倒计时取最早到期,单侧可见时只计该侧", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    // Both sides visible: counts add up and the countdown takes the earlier weekly expiry.
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 2, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: now + 30_000, visible: true },
      ]),
    ).toEqual({ count: 3, expiresAt: now + 30_000, visible: true });

    // One side hidden (quota full / no opportunity): only the visible side counts; the hidden
    // side's count is not included.
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 2, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: now + 30_000, visible: false },
      ]),
    ).toEqual({ count: 2, expiresAt: now + 60_000, visible: true });

    // All hidden or count 0: badge not visible.
    expect(
      mergeCodingPlanQuotaResetOpportunityBadges([
        { count: 0, expiresAt: now + 60_000, visible: true },
        { count: 1, expiresAt: null, visible: false },
      ]),
    ).toEqual({ count: 0, expiresAt: null, visible: false });
  });

  it("共享 has_unread_history 只归属 used_at 最新的一类，避免错误完成另一类", () => {
    const now = Date.UTC(2026, 7, 7, 10, 0, 0);
    const staleFiveHourUsedAt = now - FIVE_HOURS_MS;
    const freshWeekUsedAt = now - 1_000;
    // A single unread cursor + two history kinds: only the weekly quota with the newest used_at
    // should enter the completed state.
    const snapshot: CodingPlanResetStatusSnapshot = {
      availableFiveHourResets: [],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: staleFiveHourUsedAt },
      latestWeekResetHistory: { usedAt: freshWeekUsedAt },
      hasUnreadHistory: true,
    };

    // The expired five-hour history does not own the unread mark; first mount must not fabricate
    // a completion.
    expect(applyCodingPlanQuotaResetStatus(null, snapshot, now, null, "FIVE_HOUR")).toBeNull();

    // The newer weekly history owns the unread mark and completes normally.
    const week = applyCodingPlanQuotaResetStatus(null, snapshot, now, null, "WEEK");
    expect(week?.status).toBe("completed");
    expect(week?.completedAt).toBe(freshWeekUsedAt);

    // With equal used_at, attribution follows the current type: both kinds can complete on their
    // own without stealing from each other.
    const tie: CodingPlanResetStatusSnapshot = {
      ...snapshot,
      latestFiveHourResetHistory: { usedAt: freshWeekUsedAt },
    };
    expect(applyCodingPlanQuotaResetStatus(null, tie, now, null, "FIVE_HOUR")?.status).toBe(
      "completed",
    );
    expect(applyCodingPlanQuotaResetStatus(null, tie, now, null, "WEEK")?.status).toBe("completed");
  });
});
