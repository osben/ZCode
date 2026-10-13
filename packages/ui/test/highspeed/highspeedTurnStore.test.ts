import { describe, expect, it } from "vitest";
import {
  aggregateHighspeedCardMetrics,
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedTurnByCommandId,
  getHighspeedTurnVersion,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  markHighspeedTurnMetricsPersisted,
  markHighspeedCardAutoShared,
  recordHighspeedTurn,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
} from "@/highspeed/highspeedTurnStore.js";
import { claimHighspeedFallbackToast } from "@/highspeed/highspeedToastClaims.js";

const card = {
  cardId: "hsc-aggregate-test",
  taskId: "task-aggregate-test",
  provider: "zai",
  model: "glm-highspeed",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  regularTps: 75,
};

describe("highspeed turn store", () => {
  it("claims a fallback toast once across SessionPane remounts", () => {
    const sourceCommandId = "command-fallback-toast-once";

    expect(claimHighspeedFallbackToast(sourceCommandId)).toBe(true);
    // A second pane or a component remount must not toast again for the same fallback event.
    expect(claimHighspeedFallbackToast(sourceCommandId)).toBe(false);
  });

  it("limits healthy sampling to one expiry attempt and one final-turn补查 per card", () => {
    const cardId = "hsc-healthy-attempt-guard";

    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(true);
    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(false);
    // After SessionPane remounts, the card-level dedupe state in the store is still reused.
    expect(claimHighspeedHealthyAttempt(cardId, false)).toBe(false);
    expect(claimHighspeedHealthyAttempt(cardId, true)).toBe(true);
    expect(claimHighspeedHealthyAttempt(cardId, true)).toBe(false);
  });

  it("hydrates persisted transcript rows after a renderer cold start", () => {
    const sourceCommandId = "command-cold-recovery";
    const cardId = "hsc-cold-recovery";
    const expiresAt = Date.now() - 1;

    expect(
      hydrateHighspeedTurnsFromTranscript("session-cold-recovery", [
        {
          sourceCommandId,
          createdAt: 10,
          highspeed: {
            cardId,
            taskId: "task-cold-recovery",
            provider: "zai",
            model: "glm-highspeed",
            issuedAt: 1,
            expiresAt,
            regularTps: 80,
            outputTokens: 120,
            durationMs: 1_000,
            highspeedTps: 120,
            savedDurationMs: 500,
          },
        },
      ]),
    ).toBe(1);

    const record = getHighspeedTurnByCommandId(sourceCommandId);
    expect(record?.metrics).toMatchObject({
      outputTokens: 120,
      durationMs: 1_000,
      highspeedTps: 120,
      savedDurationMs: 500,
    });
    expect(record?.metricsPersistedAt).toBeDefined();
    expect(listExpiredHighspeedCardsAwaitingTps("session-cold-recovery", Date.now())).toEqual([]);
  });

  it("merges late authoritative metadata into an already registered turn", () => {
    // CR-04 regression: the remote-control Renderer registers the record from the running user row first;
    // the desktop then finishes persisting the CLI statistics and projects them into the transcript. The old
    // implementation skipped when the same sourceCommandId already existed, so the remote never got the
    // completed state and card-level TPS, saved time, and auto-share candidates could never settle.
    // Hydration must merge authoritative fields idempotently by sourceCommandId.
    const sessionId = "session-late-merge";
    const sourceCommandId = "command-late-merge";
    const cardId = "hsc-late-merge";
    const runningRow = {
      sourceCommandId,
      createdAt: 10,
      highspeed: {
        cardId,
        taskId: sessionId,
        provider: "zai",
        model: "glm-highspeed",
        issuedAt: 1,
        expiresAt: 50,
        regularTps: 80,
      },
    };
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [runningRow])).toBe(1);
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metrics).toBeUndefined();
    expect(listHighspeedCardAutoShareCandidates(sessionId)).toEqual([]);

    const versionBefore = getHighspeedTurnVersion();
    const completedRow = {
      ...runningRow,
      highspeed: {
        ...runningRow.highspeed,
        outputTokens: 120,
        durationMs: 1_000,
        modelDurationMs: 800,
        toolDurationMs: 100,
        otherDurationMs: 100,
        highspeedTps: 120,
        savedDurationMs: 500,
      },
    };
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [completedRow])).toBe(1);
    // The late complete metadata produces exactly one store notification.
    expect(getHighspeedTurnVersion()).toBe(versionBefore + 1);
    expect(getHighspeedTurnByCommandId(sourceCommandId)).toMatchObject({
      metrics: {
        outputTokens: 120,
        durationMs: 1_000,
        modelDurationMs: 800,
        toolDurationMs: 100,
        otherDurationMs: 100,
        regularTps: 80,
        highspeedTps: 120,
        savedDurationMs: 500,
      },
    });
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metricsPersistedAt).toBeDefined();
    expect(listHighspeedCardAutoShareCandidates(sessionId)).toHaveLength(1);
    expect(listHighspeedCardAutoShareCandidates(sessionId)[0]?.metrics).toMatchObject({
      outputTokens: 120,
      highspeedTps: 120,
      savedDurationMs: 500,
    });

    // An identical re-hydration is an idempotent no-op: no record change, no notification.
    const versionAfter = getHighspeedTurnVersion();
    expect(hydrateHighspeedTurnsFromTranscript(sessionId, [completedRow])).toBe(0);
    expect(getHighspeedTurnVersion()).toBe(versionAfter);
  });

  it("never clears a live completion when the transcript row is still running", () => {
    const sessionId = "session-keep-live-completion";
    const sourceCommandId = "command-keep-live-completion";
    const liveCard = { ...card, cardId: "hsc-keep-live-completion", taskId: sessionId };
    recordHighspeedTurn({ sessionId, sourceCommandId, card: liveCard, createdAt: 1 });
    completeHighspeedTurn({ sourceCommandId, outputTokens: 90, durationMs: 700 });

    const versionBefore = getHighspeedTurnVersion();
    // The transcript is still running (no completion fields): running-state fields must not overwrite
    // completed fields, and no notification should be produced.
    expect(
      hydrateHighspeedTurnsFromTranscript(sessionId, [
        {
          sourceCommandId,
          createdAt: 1,
          highspeed: {
            cardId: liveCard.cardId,
            taskId: sessionId,
            provider: liveCard.provider,
            model: liveCard.model,
            issuedAt: liveCard.issuedAt,
            expiresAt: liveCard.expiresAt,
            regularTps: liveCard.regularTps,
          },
        },
      ]),
    ).toBe(0);
    expect(getHighspeedTurnByCommandId(sourceCommandId)?.metrics).toMatchObject({
      outputTokens: 90,
      durationMs: 700,
    });
    expect(getHighspeedTurnVersion()).toBe(versionBefore);
  });

  it("discards a queued Highspeed record when promotion falls back to the session model", () => {
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-queued-expired",
      card,
      createdAt: 0,
    });

    expect(discardHighspeedTurn("command-queued-expired")).toBe(true);
    expect(getHighspeedTurnByCommandId("command-queued-expired")).toBeNull();
  });

  it("aggregates output tokens and duration for all completed turns on the same card", () => {
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-aggregate-1",
      card,
      createdAt: 1,
    });
    recordHighspeedTurn({
      sessionId: card.taskId,
      sourceCommandId: "command-aggregate-2",
      card,
      createdAt: 2,
    });

    completeHighspeedTurn({
      sourceCommandId: "command-aggregate-1",
      outputTokens: 120,
      durationMs: 1_500,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-aggregate-2",
      outputTokens: 80,
      durationMs: 2_500,
    });
    setHighspeedCardTps(card.cardId, 100);

    expect(aggregateHighspeedCardMetrics(card.cardId)).toEqual({
      outputTokens: 200,
      durationMs: 4_000,
      regularTps: 75,
      highspeedTps: 100,
      savedDurationMs: 1_000,
    });
  });

  it("waits for card expiry and every started turn before claiming one aggregated share", () => {
    const expiringCard = {
      ...card,
      cardId: "hsc-auto-share-after-expiry",
      taskId: "task-auto-share-after-expiry",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: expiringCard.taskId,
      sourceCommandId: "command-auto-share-1",
      card: expiringCard,
      createdAt: 3,
    });
    recordHighspeedTurn({
      sessionId: expiringCard.taskId,
      sourceCommandId: "command-auto-share-2",
      card: expiringCard,
      createdAt: 4,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-auto-share-1",
      outputTokens: 100,
      durationMs: 1_000,
    });

    expect(listHighspeedCardAutoShareCandidates(expiringCard.taskId)).toEqual([]);
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 100)).toBeNull();

    completeHighspeedTurn({
      sourceCommandId: "command-auto-share-2",
      outputTokens: 50,
      durationMs: 500,
    });
    expect(listExpiredHighspeedCardsAwaitingTps(expiringCard.taskId, 100)).toEqual([
      { cardId: expiringCard.cardId, allTurnsCompleted: true },
    ]);
    setHighspeedCardTps(expiringCard.cardId, 100);
    // Two turns each save 400ms, 800ms total / 1500ms total duration → about 1.53x, above the 1.2x
    // release bar, ensuring this case verifies the "expired + all completed + claim once" mechanism
    // rather than being blocked by the eligibility gate.
    markHighspeedTurnMetricsPersisted("command-auto-share-1", 400);
    markHighspeedTurnMetricsPersisted("command-auto-share-2", 400);

    expect(resolveNextHighspeedAutoShareAt(expiringCard.taskId)).toBe(100);
    expect(listHighspeedCardAutoShareCandidates(expiringCard.taskId)).toEqual([
      {
        cardId: expiringCard.cardId,
        expiresAt: 100,
        metrics: {
          outputTokens: 150,
          durationMs: 1_500,
          regularTps: 75,
          highspeedTps: 100,
          savedDurationMs: 800,
        },
      },
    ]);
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 99)).toBeNull();
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 100)).not.toBeNull();
    expect(claimHighspeedCardAutoShare(expiringCard.cardId, 101)).toBeNull();
    expect(getHighspeedTurnByCommandId("command-auto-share-1")).toMatchObject({
      autoShareAttemptedAt: 100,
    });
    expect(getHighspeedTurnByCommandId("command-auto-share-2")).toMatchObject({
      autoShareAttemptedAt: 100,
    });

    markHighspeedCardAutoShared(expiringCard.cardId, 110);
    expect(getHighspeedTurnByCommandId("command-auto-share-1")).toMatchObject({
      autoSharedAt: 110,
    });
    expect(getHighspeedTurnByCommandId("command-auto-share-2")).toMatchObject({
      autoSharedAt: 110,
    });
  });

  it("does not create an auto-share candidate when the overall speedup stays at or below 1.2x", () => {
    const lowCard = {
      ...card,
      cardId: "hsc-below-speedup-auto-share",
      taskId: "task-below-speedup-auto-share",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: lowCard.taskId,
      sourceCommandId: "command-below-speedup",
      card: lowCard,
      createdAt: 1,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-below-speedup",
      outputTokens: 120,
      durationMs: 1_000,
    });
    setHighspeedCardTps(lowCard.cardId, 100);
    // 100ms saved / 1000ms → about 1.1x, below the 1.2x release bar: the card has output, TPS, and is
    // persisted, so the only reason it is held back is the eligibility gate — verifying "below the bar
    // does not pop the bottom-left card" (spec §9).
    markHighspeedTurnMetricsPersisted("command-below-speedup", 100);

    expect(listHighspeedCardAutoShareCandidates(lowCard.taskId)).toEqual([]);
  });

  it("does not create an auto-share candidate when the entire card produced zero output", () => {
    const emptyCard = {
      ...card,
      cardId: "hsc-empty-auto-share",
      taskId: "task-empty-auto-share",
      expiresAt: 100,
    };
    recordHighspeedTurn({
      sessionId: emptyCard.taskId,
      sourceCommandId: "command-empty-auto-share",
      card: emptyCard,
      createdAt: 1,
    });
    completeHighspeedTurn({
      sourceCommandId: "command-empty-auto-share",
      outputTokens: 0,
      durationMs: 100,
    });
    setHighspeedCardTps(emptyCard.cardId, 100);
    markHighspeedTurnMetricsPersisted("command-empty-auto-share", 0);

    expect(listHighspeedCardAutoShareCandidates(emptyCard.taskId)).toEqual([]);
    expect(claimHighspeedCardAutoShare(emptyCard.cardId, 100)).toBeNull();
  });
});
