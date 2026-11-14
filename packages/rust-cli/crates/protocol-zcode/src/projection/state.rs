//! 会话状态的 A 区字段（`snapshot.ts`）：control、availability、inputRouting、meta、config、usage、queue、
//! pendingInteractions。每个函数给出整段的值（`state.updated` 是字段级整体替换，不深合并）。

use rust_cli_kernel_api::message::Usage;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::{Value, json};

/// 会话的阶段（`sessionPhaseSchema`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Draft,
    Running,
    CompletedSuccess,
    CompletedInterrupted,
    Error,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Running => "running",
            Self::CompletedSuccess => "completedSuccess",
            Self::CompletedInterrupted => "completedInterrupted",
            Self::Error => "error",
        }
    }

    pub fn ended(self) -> bool {
        matches!(
            self,
            Self::CompletedSuccess | Self::CompletedInterrupted | Self::Error
        )
    }
}

/// 在跑的前台工作（`activeWorkSummarySchema`，P1 只有主回合）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveWork {
    pub execution: String,
    pub command: Option<String>,
    pub started_at: u64,
}

/// 回合失败的说明（`sessionErrorInfoSchema`）。
#[derive(Debug, Clone, PartialEq)]
pub struct LastError {
    pub message: String,
    /// Fork: the failure's Node error code (`TurnOutcome::Failed`), else `fault.turn.failed`.
    pub code: Option<String>,
    pub at: u64,
    /// Fork: `false` hides Resume (a blocked prompt, HK-UP-01); a failed turn is recoverable.
    pub recoverable: bool,
    /// Fork: the error's details (a blocked prompt's reason and diagnostic).
    pub detail: Option<String>,
    pub attribution: Option<ErrorAttribution>,
}

/// Fork: `sessionErrorInfoSchema.attribution`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorAttribution {
    /// `{source: "runtime", reason: "hook_blocked"}`.
    #[expect(dead_code, reason = "the HK-UP-01 fix sets it")]
    HookBlocked,
}

/// `verifier`: the start time of a running goal completion verification (Node `activeWorks` kind `goalVerifier`).
pub fn control(
    phase: Phase,
    active: Option<&ActiveWork>,
    error: Option<&LastError>,
    verifier: Option<u64>,
) -> Value {
    let running = phase == Phase::Running;
    let mut works: Vec<Value> = active
        .filter(|_| running)
        .map(|work| {
            let mut value = json!({
                "kind": "primaryTurn",
                "foregroundExecutionId": work.execution,
                "startedAt": work.started_at,
            });
            if let Some(command) = &work.command {
                value["sourceCommandId"] = json!(command);
            }
            value
        })
        .into_iter()
        .collect();
    let primary = !works.is_empty();
    if let Some(started_at) = verifier.filter(|_| running) {
        works.push(json!({"kind": "goalVerifier", "startedAt": started_at}));
    }
    let target = match (running, primary, verifier.is_some()) {
        (false, _, _) => "unknown",
        (true, true, true) => "mixed",
        (true, false, true) => "goalVerifier",
        (true, _, false) => "assistant",
    };
    json!({
        "phase": phase.name(),
        "sessionEnded": phase.ended(),
        "canStop": running,
        "stopState": if running { "stoppable" } else { "idle" },
        "stopTargetKind": target,
        "activeWorks": works,
        "lastError": error.map(|error| json!({
            "code": error.code.as_deref().unwrap_or("fault.turn.failed"),
            "message": error.message,
            "recoverable": true,
            "at": error.at,
            "source": "runtime",
        })),
        "apiRetry": null,
    })
}

fn allowed() -> Value {
    json!({"allowed": true})
}

fn denied(reason: &str) -> Value {
    json!({"allowed": false, "reasonCode": reason})
}

/// Fork: the session actions (Node `computeAvailability`, projection-state.ts): `goal` is the goal
/// status name (snapshot `goal.status`), None without a goal.
pub fn availability(phase: Phase, compacting: bool, goal: Option<&str>) -> Value {
    let running = phase == Phase::Running;
    let draft = phase == Phase::Draft;
    let lock = || denied("compactOperationLock");
    let fork = if compacting {
        lock()
    } else if draft {
        denied("forkTargetNotStable")
    } else {
        allowed()
    };
    let compact = if compacting {
        lock()
    } else if draft {
        denied("idleCannotCompact")
    } else {
        allowed()
    };
    let send_queued_now = if compacting {
        lock()
    } else if running {
        allowed()
    } else {
        denied("sendQueuedNowRequiresRunning")
    };
    let pause = match goal {
        Some("active" | "verifying" | "notSatisfied") => allowed(),
        Some(_) => denied("goalNotActive"),
        None => denied("noGoalToPause"),
    };
    let resume = match goal {
        Some("paused") => allowed(),
        Some(_) => denied("goalNotPaused"),
        None => denied("noGoalToResume"),
    };
    json!({
        "fork": fork,
        "compact": compact,
        "switchModelConfig": allowed(),
        "setFollowupMode": allowed(),
        "queueEdit": allowed(),
        "sendQueuedNow": send_queued_now,
        "pauseGoal": pause,
        "resumeGoal": resume,
    })
}

/// 跟进的方式（`followupMode`）：运行中输入入队还是插话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Followup {
    Queue,
    Guide,
}

impl Followup {
    pub fn name(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Guide => "guide",
        }
    }
}

/// `held`: a paused queue still holds items (Node's `computeInputRouting`: after a finished turn new input needs the
/// client's clear/keep choice, `heldQueueInputRequiresChoice`).
/// `verifying`: a goal completion verification runs (Node `goalVerifierAcceptsFutureInput`: it is not a steerable
/// turn, so input queues in guide mode too).
pub fn input_routing(phase: Phase, followup: Followup, held: bool, verifying: bool) -> Value {
    if verifying {
        return json!({"mode": "enqueue", "reasonCode": "goalVerifierAcceptsFutureInput"});
    }
    if held && matches!(phase, Phase::CompletedSuccess | Phase::CompletedInterrupted) {
        return json!({"mode": "choice", "reasonCode": "heldQueueInputRequiresChoice"});
    }
    match (phase, followup) {
        (Phase::Running, Followup::Queue) => json!({"mode": "enqueue"}),
        (Phase::Running, Followup::Guide) => json!({"mode": "guide"}),
        (
            Phase::Draft | Phase::CompletedSuccess | Phase::CompletedInterrupted | Phase::Error,
            Followup::Queue | Followup::Guide,
        ) => json!({"mode": "startNow"}),
    }
}

pub fn meta(title: &str, source: rust_cli_kernel_api::title::Source) -> Value {
    json!({
        "title": title,
        "titleSource": source.shown(),
    })
}

/// App 的模型选择（`modelSelectionSchema`）。
pub fn selection(selection: &ModelSelection) -> Value {
    let mut value = json!({"providerId": selection.provider, "modelId": selection.model});
    if let Some(level) = &selection.reasoning {
        value["options"] = json!({"reasoningLevel": level});
    }
    value
}

/// App 的模式名（Node 的写法：default → build 等，README §5）。
pub fn mode_name(mode: PermissionMode) -> &'static str {
    mode.node_name()
}

/// 会话配置（`sessionConfigStateSchema`）。
pub fn config(
    current: &ModelSelection,
    mode: PermissionMode,
    plan: bool,
    followup: Followup,
    levels: &[String],
) -> Value {
    json!({
        "modelSelection": selection(current),
        "provider": current.provider,
        "model": current.model,
        "thought": current.reasoning.clone().unwrap_or_default(),
        "thoughtLevels": levels,
        "followupMode": followup.name(),
        "mode": mode_name(mode),
        "planEnabled": plan,
    })
}

/// `autoCompactThresholdTokens` 是内核生效的自动压缩阈值（compact.md §2.3）；不会主动压缩时为 null。
pub fn usage(
    context: Option<rust_cli_kernel_api::compaction::ContextOccupancy>,
    total: &Usage,
) -> Value {
    json!({
        // Fork: Node publishes the model window (not the window minus the summary reserve) and no
        // context window at all for an unknown model.
        "contextWindow": context.and_then(|context| context.window_tokens.map(|window| json!({
            "usedTokens": context.used_tokens,
            "maxTokens": window,
            "autoCompactThresholdTokens": context.compact_at,
        }))),
        "cumulative": {
            "inputTokens": total.input_tokens,
            "outputTokens": total.output_tokens,
            "cacheReadTokens": total.cache_read_input_tokens,
            "cacheWriteTokens": total.cache_creation_input_tokens,
        },
    })
}

/// 权限询问的选项（与 Node 的 V4 投影同一组）：允许一次、本项目一直允许、拒绝。
pub fn permission_options() -> Value {
    json!([
        {"optionId": "allowOnce", "label": "Allow once", "kind": "allowOnce",
            "response": {"decision": "allow", "reason": "Approved once"}},
        {"optionId": "allowAlways", "label": "Always allow in this project", "kind": "allowAlways",
            "response": {"decision": "allow", "reason": "Approved for this project"}},
        {"optionId": "deny", "label": "Deny", "kind": "deny",
            "response": {"decision": "deny", "reason": "The user doesn't want to proceed with this tool use."}},
    ])
}

/// Fork: the single-use ask (Node `approvalMode: "user-once"` keeps only allow once and deny).
pub fn single_use_permission_options() -> Value {
    let options = permission_options();
    Value::Array(
        options
            .as_array()
            .into_iter()
            .flatten()
            .filter(|option| option["kind"] != "allowAlways")
            .cloned()
            .collect(),
    )
}

/// “完全访问”选项（与 Node 的 V4 投影相同）：选它时会话切到 yolo（bypassPermissions）并放行这一次。
pub fn full_access_option() -> Value {
    json!({"optionId": "fullAccess", "label": "Full access", "kind": "custom",
        "response": {"decision": "deny", "reason": "Full access requires V4 approval"}})
}
