//! 后台子代理的无进展提醒（Node `subagent-stall-reminder.ts` 与 `background-stall.ts`；specs/fork-rust-agent-parity.md
//! 「Background subagent stall reminder」）。
//!
//! 进展是模型请求开始与完成、工具调用开始与结束、权限答复；流式增量与工具的进度心跳不算。每个在跑的后台子代理（顶层
//! 会话启动、没有 owner）一个钟：首次在最后一次进展之后 `first` 毫秒，之后每次间隔加倍，上限 `max_interval`。等权限
//! 答复时不提醒也不计时。提醒经 [`crate::signals::Hub`] 进顶层会话的通道：不 ack，不计入后台工作，全文不再包装。
//!
//! 时间只从 [`rust_cli_kernel_api::clock::Clock`] 来。[`StallClock`] 是纯函数式的状态机（时刻由调用方给），
//! [`spawn`] 的驱动在注册表或活动变化后、与到期时刻对齐的 tokio 定时器上调用它。

use std::sync::Weak;
use std::time::Duration;

use rust_cli_base::Spawner;
use rust_cli_base::js::date::iso_timestamp;
use rust_cli_base::js::string::is_space;
use rust_cli_kernel_api::agents::AgentStall;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use serde_json::Value;

use crate::Core;

/// Node `DEFAULT_BACKGROUND_SUBAGENT_STALL_FIRST_MS`：15 分钟。
pub(crate) const DEFAULT_FIRST_MS: u64 = 15 * 60_000;
/// Node `DEFAULT_BACKGROUND_SUBAGENT_STALL_MAX_INTERVAL_MS`：4 小时。
pub(crate) const DEFAULT_MAX_INTERVAL_MS: u64 = 4 * 60 * 60_000;
/// Node `TOOL_SUMMARY_MAX_CHARS` 与 `DESCRIPTION_MAX_CHARS`（UTF-16 码元）。
const TOOL_SUMMARY_MAX_UNITS: usize = 200;
const DESCRIPTION_MAX_UNITS: usize = 200;
/// Node `RUNNING_TOOLS_MAX`：提醒里列出的在途工具个数，其余只给个数。
const RUNNING_TOOLS_MAX: usize = 5;
/// Node `TASK_NOTIFICATION_MAX_CHARS`（UTF-16 码元）。
const NOTIFICATION_MAX_UNITS: usize = 120_000;

/// Node 的 `SYSTEM_NOTIFICATION_BANNER`。提醒正文以它开头：模型把它当系统的状态报告，不是用户的话。
const BANNER: [&str; 4] = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated status report about a background agent, NOT a message from the user.",
    "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
    "",
];

/// 两个阈值（毫秒）。`first` 是首次提醒的等待；`max_interval` 是间隔的上限，不小于 `first`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallConfig {
    pub first_ms: u64,
    pub max_interval_ms: u64,
}

impl StallConfig {
    /// Node `AgentRuntime` 的缺省：非正数或缺省时用默认值；上限不小于首次（`Math.max(firstAfterMs, …)`）。
    pub fn new(first_ms: Option<u64>, max_interval_ms: Option<u64>) -> Self {
        let first_ms = positive_or(first_ms, DEFAULT_FIRST_MS);
        let max_interval_ms = positive_or(max_interval_ms, DEFAULT_MAX_INTERVAL_MS).max(first_ms);
        Self {
            first_ms,
            max_interval_ms,
        }
    }
}

impl Default for StallConfig {
    fn default() -> Self {
        Self::new(None, None)
    }
}

fn positive_or(value: Option<u64>, fallback: u64) -> u64 {
    value.filter(|value| *value > 0).unwrap_or(fallback)
}

/// 一个在跑的子代理的当前活动（`live::Shown` 里记；结束运行时清掉工具）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    /// 最后一次进展的时刻；None 时按启动（或续跑）的时刻算。
    pub(crate) progress_ms: Option<u64>,
    /// 在跑的工具调用，按开始的先后。
    pub(crate) tools: Vec<RunningTool>,
}

/// 一个在跑的工具调用。`summary` 是输入里的一句话（Node `toolInputSummary`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningTool {
    pub(crate) tool_use: String,
    pub(crate) name: String,
    pub(crate) summary: Option<String>,
    pub(crate) started_ms: u64,
}

impl Activity {
    pub(crate) fn progress(&mut self, now: u64) {
        self.progress_ms = Some(now);
    }

    pub(crate) fn tool_started(
        &mut self,
        tool_use: &str,
        name: &str,
        summary: Option<String>,
        now: u64,
    ) {
        self.tools.retain(|tool| tool.tool_use != tool_use);
        self.tools.push(RunningTool {
            tool_use: tool_use.to_owned(),
            name: name.to_owned(),
            summary,
            started_ms: now,
        });
        self.progress(now);
    }

    pub(crate) fn tool_finished(&mut self, tool_use: &str, now: u64) {
        self.tools.retain(|tool| tool.tool_use != tool_use);
        self.progress(now);
    }
}

/// 钟看的一个后台子代理（由 `Live::stall_candidates` 给出，按启动顺序）。
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) agent: AgentId,
    pub(crate) root: SessionId,
    pub(crate) description: String,
    pub(crate) started_ms: u64,
    pub(crate) activity: Activity,
    /// 在等权限答复（Node `waitingForPermission`）。
    pub(crate) waiting: bool,
}

impl Candidate {
    fn progress_time(&self) -> u64 {
        self.activity.progress_ms.unwrap_or(self.started_ms)
    }
}

/// 一次提醒的内容（Node `BackgroundSubagentStallReminder`，去掉与文字无关的字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reminder {
    pub(crate) agent: AgentId,
    pub(crate) root: SessionId,
    pub(crate) description: String,
    pub(crate) running_for_ms: u64,
    pub(crate) no_progress_for_ms: u64,
    pub(crate) last_progress_ms: u64,
    pub(crate) running_tools: Vec<ReminderTool>,
    pub(crate) next_report_in_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReminderTool {
    pub(crate) name: String,
    pub(crate) summary: Option<String>,
    pub(crate) running_for_ms: u64,
}

/// 钟的一条记录：提醒次数、上次提醒的时刻与看到的进展时刻。
#[derive(Debug, Clone)]
struct State {
    agent: AgentId,
    reminders: u32,
    last_reminder_ms: Option<u64>,
    progress_ms: u64,
}

/// 停滞钟（Node `BackgroundSubagentStallClock`）。`states` 按第一次出现的顺序排，同一时刻的提醒按它送出。
#[derive(Debug)]
pub(crate) struct StallClock {
    config: StallConfig,
    states: Vec<State>,
}

impl StallClock {
    pub(crate) fn new(config: StallConfig) -> Self {
        Self {
            config,
            states: Vec::new(),
        }
    }

    /// 第 `reminders` 次提醒之后的间隔：`min(first * 2^reminders, max_interval)`。
    fn interval_after(&self, reminders: u32) -> u64 {
        let factor = 1u64.checked_shl(reminders).unwrap_or(u64::MAX);
        self.config
            .first_ms
            .saturating_mul(factor)
            .min(self.config.max_interval_ms)
    }

    fn due_at(&self, state: &State) -> u64 {
        match state.last_reminder_ms {
            None => state.progress_ms.saturating_add(self.config.first_ms),
            Some(last) => last.saturating_add(self.interval_after(state.reminders)),
        }
    }

    /// 与注册表对齐：不再在跑的去掉；看到的进展比记下的新时，计数清零（Node `reconcile`）。
    fn reconcile(&mut self, candidates: &[Candidate]) {
        self.states.retain(|state| {
            candidates
                .iter()
                .any(|candidate| candidate.agent == state.agent)
        });
        for candidate in candidates {
            let progress_ms = candidate.progress_time();
            match self
                .states
                .iter_mut()
                .find(|state| state.agent == candidate.agent)
            {
                Some(state) if progress_ms > state.progress_ms => {
                    *state = State {
                        agent: candidate.agent.clone(),
                        reminders: 0,
                        last_reminder_ms: None,
                        progress_ms,
                    };
                }
                Some(_) => {}
                None => self.states.push(State {
                    agent: candidate.agent.clone(),
                    reminders: 0,
                    last_reminder_ms: None,
                    progress_ms,
                }),
            }
        }
    }

    /// 对齐，再送出 `now` 已到期的提醒（Node `fire`）。等权限答复的不送。
    pub(crate) fn tick(&mut self, now: u64, candidates: &[Candidate]) -> Vec<Reminder> {
        self.reconcile(candidates);
        let mut due = Vec::new();
        for index in 0..self.states.len() {
            let agent = self.states[index].agent.clone();
            let due_at = self.due_at(&self.states[index]);
            let Some(candidate) = candidates.iter().find(|candidate| candidate.agent == agent)
            else {
                continue;
            };
            if candidate.waiting || due_at > now {
                continue;
            }
            let state = &mut self.states[index];
            state.reminders += 1;
            state.last_reminder_ms = Some(now);
            let reminders = state.reminders;
            due.push(self.reminder(candidate, now, reminders));
        }
        due
    }

    fn reminder(&self, candidate: &Candidate, now: u64, reminders: u32) -> Reminder {
        let last_progress_ms = candidate.progress_time();
        Reminder {
            agent: candidate.agent.clone(),
            root: candidate.root.clone(),
            description: candidate.description.clone(),
            running_for_ms: now.saturating_sub(candidate.started_ms),
            no_progress_for_ms: now.saturating_sub(last_progress_ms),
            last_progress_ms,
            running_tools: candidate
                .activity
                .tools
                .iter()
                .map(|tool| ReminderTool {
                    name: tool.name.clone(),
                    summary: tool.summary.clone(),
                    running_for_ms: now.saturating_sub(tool.started_ms),
                })
                .collect(),
            next_report_in_ms: self.interval_after(reminders),
        }
    }

    /// 下一次到期的时刻（等权限答复的不算）。没有要等的时为 None。
    pub(crate) fn next_due(&self, candidates: &[Candidate]) -> Option<u64> {
        self.states
            .iter()
            .filter(|state| {
                candidates
                    .iter()
                    .find(|candidate| candidate.agent == state.agent)
                    .is_none_or(|candidate| !candidate.waiting)
            })
            .map(|state| self.due_at(state))
            .min()
    }
}

/// Node `formatBackgroundSubagentStallNotification`：给模型的提醒正文，逐字节与 Node 一致（golden 测试）。
pub(crate) fn format(reminder: &Reminder) -> String {
    let description = escape_xml(&description_line(&reminder.description));
    let agent = escape_xml(reminder.agent.as_str());
    let mut tools = reminder.running_tools.clone();
    // Node sorts by running time, longest first; the sort is stable, so ties keep their start order.
    tools.sort_by_key(|tool| std::cmp::Reverse(tool.running_for_ms));
    let listed = tools.len().min(RUNNING_TOOLS_MAX);

    let mut lines: Vec<String> = BANNER.iter().map(|line| (*line).to_owned()).collect();
    lines.push("<background-agent-stall>".to_owned());
    lines.push(format!("  <task-id>{agent}</task-id>"));
    lines.push(format!("  <description>{description}</description>"));
    lines.push(format!(
        "  <running-for-ms>{}</running-for-ms>",
        reminder.running_for_ms
    ));
    lines.push(format!(
        "  <no-progress-for-ms>{}</no-progress-for-ms>",
        reminder.no_progress_for_ms
    ));
    lines.push(format!(
        "  <last-progress-at>{}</last-progress-at>",
        iso_timestamp(reminder.last_progress_ms)
    ));
    for tool in &tools[..listed] {
        lines.push(format!(
            "  <running-tool name=\"{}\" running-for-ms=\"{}\">{}</running-tool>",
            escape_xml(&tool.name),
            tool.running_for_ms,
            escape_xml(tool.summary.as_deref().unwrap_or("")),
        ));
    }
    if tools.len() > listed {
        lines.push(format!(
            "  <more-running-tools>{}</more-running-tools>",
            tools.len() - listed
        ));
    }
    lines.push(format!(
        "  <next-report-in-ms>{}</next-report-in-ms>",
        reminder.next_report_in_ms
    ));
    lines.push("</background-agent-stall>".to_owned());
    lines.push(String::new());
    lines.push(format!(
        "Background agent \"{description}\" ({agent}) has been running for {} and has made no progress for {}: no new model request and no tool call has finished.",
        minutes(reminder.running_for_ms),
        minutes(reminder.no_progress_for_ms),
    ));
    if let Some(longest) = tools.first() {
        let summary = longest
            .summary
            .as_deref()
            .filter(|summary| !summary.is_empty())
            .map(|summary| format!(": {}", escape_xml(summary)))
            .unwrap_or_default();
        lines.push(format!(
            "It is inside {}, which has been running for {}{summary}.",
            escape_xml(&longest.name),
            minutes(longest.running_for_ms),
        ));
    }
    lines.push("This is a status report, not a failure. Test suites, builds, simulations and polling loops with sleep often run this long or longer.".to_owned());
    lines.push(format!(
        "If that fits what the agent is doing, do nothing and end your turn; if it is still quiet, the next report comes in about {}.",
        minutes(reminder.next_report_in_ms),
    ));
    lines.push("Stop it with TaskStop only if you have a concrete reason to think it is stuck (for example, it waits for input that will never arrive). TaskOutput with block=false shows its current activity. Tell the user if they are waiting on it.".to_owned());
    truncate_notification(&lines.join("\n"))
}

/// Node `backgroundSubagentStallDescription`：单行、有上限；空的按 "Subagent"。
pub(crate) fn description_line(description: &str) -> String {
    let line = single_line(description, DESCRIPTION_MAX_UNITS);
    if line.is_empty() {
        "Subagent".to_owned()
    } else {
        line
    }
}

/// Node `toolInputSummary`：输入里第一个非空的字符串字段，单行、有上限。
pub(crate) fn input_summary(input: &Value) -> Option<String> {
    let record = input.as_object()?;
    const KEYS: [&str; 7] = [
        "command",
        "description",
        "file_path",
        "path",
        "pattern",
        "url",
        "prompt",
    ];
    let value = KEYS
        .iter()
        .filter_map(|key| record.get(*key)?.as_str())
        .find(|value| !value.trim_matches(is_space).is_empty())?;
    Some(single_line(value, TOOL_SUMMARY_MAX_UNITS))
}

/// Node `minutes`：至少 1 分钟（四舍五入到分钟）；两小时以上写成小时（一位小数，JS 的数字写法）。
pub(crate) fn minutes(ms: u64) -> String {
    let value = ((ms + 30_000) / 60_000).max(1);
    if value < 120 {
        return format!("{value} minute{}", if value == 1 { "" } else { "s" });
    }
    let hours = ((value as f64 / 60.0) * 10.0 + 0.5).floor() / 10.0;
    format!("{hours} hours")
}

/// Node `singleLine`：`replace(/\s+/g, " ").trim()`，超过 `max_units` 个 UTF-16 码元时截到 `max_units - 1` 加 `…`。
fn single_line(value: &str, max_units: usize) -> String {
    let collapsed = value
        .split(is_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units: Vec<u16> = collapsed.encode_utf16().collect();
    if units.len() <= max_units {
        return collapsed;
    }
    let mut line = String::from_utf16_lossy(&units[..max_units - 1]);
    line.push('…');
    line
}

/// Node `truncateTaskNotification`。
fn truncate_notification(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= NOTIFICATION_MAX_UNITS {
        return value.to_owned();
    }
    format!(
        "{}\n[truncated]",
        String::from_utf16_lossy(&units[..NOTIFICATION_MAX_UNITS])
    )
}

/// Node `escapeXml`：五个字符全部转义。
fn escape_xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

/// 提醒送进顶层会话的通道（不 ack，不计入后台工作）。
pub(crate) fn notice(reminder: &Reminder) -> AgentStall {
    AgentStall {
        agent: reminder.agent.clone(),
        text: format(reminder),
    }
}

/// 启动钟的驱动（Node `createSubagentStallReminder`）：每次注册表或活动变化后对齐，到期时送出提醒。持有的是弱引用，
/// 注册表释放后驱动结束。
pub(crate) fn spawn(core: Weak<Core>, config: StallConfig, spawner: &Spawner) {
    drop(spawner.spawn("subagent-stall", run(core, config)));
}

async fn run(core: Weak<Core>, config: StallConfig) {
    let mut clock = StallClock::new(config);
    let mut wake = match core.upgrade() {
        Some(core) => core.live.subscribe_wake(),
        None => return,
    };
    loop {
        let Some(core) = core.upgrade() else {
            return;
        };
        let now = core.ports.clock.now_ms();
        let candidates = core.live.stall_candidates();
        for reminder in clock.tick(now, &candidates) {
            core.hub.stall(&reminder.root, notice(&reminder));
        }
        let next = clock.next_due(&candidates);
        drop(core);
        match next {
            Some(due) => {
                let wait = Duration::from_millis(due.saturating_sub(now));
                tokio::select! {
                    changed = wake.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                    () = tokio::time::sleep(wait) => {}
                }
            }
            None => {
                if wake.changed().await.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "stall_tests.rs"]
mod tests;
