// Session stop command group: stop and the goal-pause barrier (pauseActiveGoal), split out of session-flow.ts
// to keep that file under the commit size guard. Behavior is unchanged. holdFollowingQueue is called only here.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  holdFollowingQueue,
  isStopCancelInFlight,
  releaseFollowingQueue,
} from "../input-admission.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { V4CommandNoopError } from "../../v4-gateway.js";


/** stop：精确取消投影中看到的 runtime 前台执行，并把 active goal 收口为 paused。 */
export async function stop(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["stop"];
  const hadActivePrompt = Boolean(record.activeAbortController);
  const activeExecutionId = record.app.runtime?.getActiveForegroundExecutionId?.();
  // Only a stop that will really cancel holds the queue before aborting (ISSUE-010, holdFollowingQueue).
  const willCancel =
    activeExecutionId !== undefined
      ? payload.expectedForegroundExecutionId === undefined ||
        payload.expectedForegroundExecutionId === activeExecutionId
      : hadActivePrompt && payload.expectedForegroundExecutionId === undefined;
  const legacyController = record.activeAbortController;
  // A controller already aborted before this stop means a cancel (e.g. a Steer) is in flight, not yet torn down.
  const legacyAbortedBefore = legacyController?.signal.aborted === true;
  const held = await holdFollowingQueue(host, record, willCancel);
  // The hold write yields, so the target seen above may have ended or been replaced meanwhile. A compat
  // target is its controller: replaced means a new turn, cleared means the turn ended on its own.
  const compatTarget = held && activeExecutionId === undefined;
  const compatReplaced =
    compatTarget &&
    record.activeAbortController !== undefined &&
    record.activeAbortController !== legacyController;
  const compatEnded = compatTarget && record.activeAbortController === undefined;
  // After a hold write, pin the runtime stop to the execution observed before it.
  const stopTargetId =
    payload.expectedForegroundExecutionId ?? (held ? activeExecutionId : undefined);
  const runtimeStop =
    compatReplaced || compatEnded
      ? undefined
      : record.app.runtime?.stopActiveForegroundExecution?.({
          expectedForegroundExecutionId: stopTargetId,
          reason: "v4 session stopped",
        });
  host.logger?.info?.("v4 stop foreground execution inspected", {
    activeForegroundExecutionId:
      runtimeStop?.kind === "mismatch"
        ? runtimeStop.activeForegroundExecutionId
        : runtimeStop?.kind === "stopped"
          ? runtimeStop.foregroundExecutionId
          : undefined,
    event: "v4.stop.foreground_execution_inspected",
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    module: "bootstrap.zcode_protocol_v4.commands",
    runtimeStopKind: runtimeStop?.kind ?? "unsupported",
    sessionId: record.app.sessionId,
  });
  const cancelInFlight = isStopCancelInFlight({
    held,
    runtimeIdle: runtimeStop?.kind === "idle",
    runtimeIdRegistered: record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined,
    compatAbortedBefore: activeExecutionId === undefined && legacyAbortedBefore && !compatReplaced && !compatEnded,
  });
  // A stop that cancels nothing undoes its own hold: the turn-end drain check already saw autoDrain=false.
  const cancelledNothing =
    compatReplaced ||
    compatEnded ||
    (!cancelInFlight && (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch"));
  if (held && cancelledNothing) await releaseFollowingQueue(host, record);
  if (
    compatReplaced ||
    (stopTargetId !== undefined &&
      !cancelInFlight &&
      (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch"))
  ) {
    // Stop 从 renderer 到 host 有异步窗口；若 verifier 已结束且下一轮已启动，
    // 继续 abort 外层 controller 会误杀用户没看到的新执行。execution id 不匹配只能 noop。
    throw new V4CommandNoopError("guard.stopTargetChanged");
  }
  if (runtimeStop?.kind === "stopped") {
    // 先打断 runtime-owned verifier/continuation，再等待 goal pause；否则 verifier 可能在
    // pause RPC 完成前通过并接入下一次 continuation。
    record.activeAbortController?.abort(new Error("v4 session stopped"));
    const pausedGoal = await pauseActiveGoal(host, record);
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
    }
    return undefined;
  }

  // 兼容 compact 与旧客户端：它们没有 runtime foreground execution token，仍由
  // bootstrap 外层 controller 提供取消窗口。
  let pausedGoal = false;
  if (hadActivePrompt) {
    pausedGoal = await pauseActiveGoal(host, record);
  }
  record.activeAbortController?.abort(new Error("v4 session stopped"));
  if (pausedGoal) {
    await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
  }
  return undefined;
}

/** goal-pause barrier 共用件：stop 与 sendQueuedNow（抢占重发）复用，不复制。 */
export async function pauseActiveGoal(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
): Promise<boolean> {
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return false;
  }
  try {
    const paused = await record.app.updateTargetStatus("paused");
    return Boolean(paused);
  } catch (error) {
    host.logger?.warn?.("v4 stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
    return false;
  }
}
