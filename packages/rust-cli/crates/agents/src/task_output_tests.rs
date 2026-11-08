//! TaskOutput 的结果与查找（Node 的 `task-output.ts` + `task-output-bash.ts`）：运行中读文件头
//! 且重复读取稳定，完成后读文件尾并按 Node 的字数截断；阻塞等到终态或超时；不认识的任务报
//! Node 的错误文字。环境忘记的任务按留下的输出文件兜底。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{
    EnvError, EnvPath, FileContent, FileVersion, OperationContext, ReadFile, WriteFile,
    WriteReceipt, WorkspaceRef,
};
use rust_cli_kernel_api::env_files::{FileKind, FileStat, StatFile};
use rust_cli_kernel_api::env_shell::{
    BackgroundInfo, BackgroundStatus, BackgroundTask, ShellState,
};
use rust_cli_kernel_api::ids::{SessionId, ShellTaskId};
use rust_cli_kernel_api::machine::{Background, Files, MachineEnv, Shell};
use rust_cli_kernel_api::testing::unsupported_machine;
use serde_json::json;

use crate::task_output::{model_text, truncate, TaskView};
use crate::test_support::{desktop_harness, text};

/// TaskOutput 看到的执行环境替身：后台账本（可变状态，供阻塞等待的测试翻转）、会话的输出
/// 目录、按路径的文件内容（stat 的字节数与 read 的内容可以不一致，正好覆盖尾读的省略前缀）。
#[derive(Default)]
struct Tasks {
    commands: Mutex<HashMap<(String, String), BackgroundStatus>>,
    outputs: Mutex<HashMap<String, String>>,
    files: Mutex<HashMap<String, (u64, Vec<u8>)>>,
}

impl Tasks {
    fn running(task: &str) -> Arc<Self> {
        let tasks = Self::default();
        tasks.commands.lock_unpoisoned().insert(
            ("sess_1".to_owned(), task.to_owned()),
            BackgroundStatus::Running,
        );
        Arc::new(tasks)
    }

    fn machine(self: &Arc<Self>) -> MachineEnv {
        unsupported_machine()
            .with_shell(self.clone())
            .with_background(self.clone())
            .with_files(self.clone())
    }

    fn finish(self: &Arc<Self>, task: &str) {
        self.commands.lock_unpoisoned().insert(
            ("sess_1".to_owned(), task.to_owned()),
            BackgroundStatus::Completed,
        );
    }
}

#[async_trait]
impl Shell for Tasks {
    async fn shell_state(
        &self,
        _workspace: &WorkspaceRef,
        session: &SessionId,
    ) -> Result<ShellState, EnvError> {
        Ok(ShellState {
            cwd: EnvPath::new("/"),
            outputs: self.outputs.lock_unpoisoned().get(session.as_str())
                .map(|dir| EnvPath::new(dir)),
            background: self
                .commands
                .lock_unpoisoned()
                .keys()
                .filter(|(owner, _)| owner == session.as_str())
                .map(|(_, task)| ShellTaskId::new(task))
                .collect(),
        })
    }
}

#[async_trait]
impl Background for Tasks {
    async fn background_command(
        &self,
        request: BackgroundTask,
    ) -> Result<Option<BackgroundInfo>, EnvError> {
        Ok(self
            .commands
            .lock_unpoisoned()
            .get(&(request.session.to_string(), request.task.to_string()))
            .map(|status| BackgroundInfo {
                command: "long job".to_owned(),
                status: *status,
                ..BackgroundInfo::default()
            }))
    }
}

#[async_trait]
impl Files for Tasks {
    async fn read_file(
        &self,
        _workspace: &WorkspaceRef,
        request: ReadFile,
    ) -> Result<FileContent, EnvError> {
        self.files.lock_unpoisoned().get(request.path.as_str())
            .map(|(_, bytes)| FileContent {
                bytes: bytes.clone(),
                version: FileVersion::new("v1"),
            })
            .ok_or_else(|| EnvError::NotFound {
                path: request.path.as_str().to_owned(),
            })
    }

    async fn write_file(
        &self,
        _workspace: &WorkspaceRef,
        _context: OperationContext,
        _request: WriteFile,
    ) -> Result<WriteReceipt, EnvError> {
        Err(EnvError::Unsupported {
            what: "write_file".to_owned(),
        })
    }

    async fn stat(
        &self,
        _workspace: &WorkspaceRef,
        request: StatFile,
    ) -> Result<Option<FileStat>, EnvError> {
        Ok(self.files.lock_unpoisoned().get(request.path.as_str()).map(|(size, _)| FileStat {
            kind: FileKind::File,
            size: *size,
            mtime_ms: 0,
            version: FileVersion::new("v1"),
        }))
    }
}

/// 一份 40000 字节的输出：头部有标记，尾部 30000 之后有另一个标记。
fn large_output() -> (u64, Vec<u8>) {
    let mut bytes = String::from("BDO_QUERY_HEAD\n");
    while bytes.len() < 30_000 {
        bytes.push_str("filler line for the head read\n");
    }
    while bytes.len() < 40_000 {
        bytes.push_str("tail filler\n");
    }
    bytes.push_str("BDO_TAIL_END\n");
    (bytes.len() as u64, bytes.into_bytes())
}

/// 运行中的任务：`block: false` 读文件头（30000 字节封顶），重复读取内容一致。
#[tokio::test]
async fn a_running_task_reads_a_stable_head_without_blocking() {
    let tasks = Tasks::running("b1");
    let (size, bytes) = large_output();
    tasks.outputs.lock_unpoisoned().insert(
        "sess_1".to_owned(),
        "/tmp/outputs".to_owned(),
    );
    tasks.files.lock_unpoisoned().insert("/tmp/outputs/b1.output".to_owned(), (size, bytes));
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let first = harness
        .call(
            "sess_1",
            "TaskOutput",
            json!({"task_id": "b1", "block": false}),
        )
        .await;
    assert!(!first.is_error, "{}", text(&first));
    let first = text(&first);
    assert!(first.contains("<retrieval_status>not_ready</retrieval_status>"));
    assert!(first.contains("<task_id>b1</task_id>"));
    assert!(first.contains("<task_type>local_bash</task_type>"));
    assert!(first.contains("<status>running</status>"));
    let output = first
        .split("<output>\n")
        .nth(1)
        .and_then(|rest| rest.split("\n</output>").next())
        .expect("an <output> block");
    assert!(output.starts_with("BDO_QUERY_HEAD"), "{output}");
    assert_eq!(output.chars().count(), 30_000, "the head is capped");
    // 重复读取看到同一份头（文件在长，头不动）。
    let second = harness
        .call(
            "sess_1",
            "TaskOutput",
            json!({"task_id": "b1", "block": false}),
        )
        .await;
    assert!(text(&second).contains(output));
}

/// 完成的任务读文件尾：超过模型字数时按 Node 的写法截断，尾部标记在、头部标记不在。
#[tokio::test]
async fn a_completed_task_reads_the_tail_with_nodes_truncation() {
    let tasks = Arc::new(Tasks::default());
    tasks.commands.lock_unpoisoned().insert(
        ("sess_1".to_owned(), "b1".to_owned()),
        BackgroundStatus::Completed,
    );
    tasks.outputs.lock_unpoisoned().insert("sess_1".to_owned(), "/tmp/outputs".to_owned());
    let (size, bytes) = large_output();
    tasks.files.lock_unpoisoned().insert("/tmp/outputs/b1.output".to_owned(), (size, bytes));
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let output = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "b1"}))
        .await;
    assert!(!output.is_error, "{}", text(&output));
    let body = text(&output);
    assert!(body.contains("<retrieval_status>success</retrieval_status>"));
    assert!(body.contains("<status>completed</status>"));
    assert!(
        body.contains("[Truncated. Full output: /tmp/outputs/b1.output]\n\n"),
        "{body}"
    );
    assert!(body.contains("BDO_TAIL_END"));
    assert!(!body.contains("BDO_QUERY_HEAD"));
}

/// stat 的字节数超过读回的内容时（Node 的按区间读在文件端口上没有对应），省略前缀按 Node
/// 的四舍五入写整 KB。
#[tokio::test]
async fn an_omitted_prefix_names_the_rounded_kilobytes() {
    let tasks = Arc::new(Tasks::default());
    tasks.commands.lock_unpoisoned().insert(
        ("sess_1".to_owned(), "b1".to_owned()),
        BackgroundStatus::Completed,
    );
    tasks.outputs.lock_unpoisoned().insert("sess_1".to_owned(), "/tmp/outputs".to_owned());
    // stat 比 read 多 2000 字节：round(2000 / 1024) = 2，不是 1。
    let mut readable = String::from("readable tail\n");
    readable.push_str(&"x".repeat(3_000 - readable.len()));
    tasks.files.lock_unpoisoned().insert(
        "/tmp/outputs/b1.output".to_owned(),
        (5_000, readable.into_bytes()),
    );
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let output = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "b1", "block": false}))
        .await;
    assert!(
        text(&output).contains("[2KB of earlier output omitted]\nreadable tail"),
        "{}",
        text(&output)
    );
}

/// 超过尾读上限的完成文件不整份加载：给一句诚实的说明（与 Node 的差异记录在模块注释）。
#[tokio::test]
async fn a_huge_completed_file_is_not_loaded_whole() {
    let tasks = Arc::new(Tasks::default());
    tasks.commands.lock_unpoisoned().insert(
        ("sess_1".to_owned(), "b1".to_owned()),
        BackgroundStatus::Completed,
    );
    tasks.outputs.lock_unpoisoned().insert("sess_1".to_owned(), "/tmp/outputs".to_owned());
    tasks.files.lock_unpoisoned().insert(
        "/tmp/outputs/b1.output".to_owned(),
        (9 * 1024 * 1024, Vec::new()),
    );
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let output = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "b1", "block": false}))
        .await;
    assert!(
        text(&output).contains("use Read on the output file for the tail"),
        "{}",
        text(&output)
    );
}

/// `block: true` 等到终态再回；`timeout: 0` 的等待立刻按超时回。
#[tokio::test]
async fn blocking_waits_for_the_task_to_finish() {
    let tasks = Tasks::running("b1");
    tasks.outputs.lock_unpoisoned().insert("sess_1".to_owned(), "/tmp/outputs".to_owned());
    tasks.files.lock_unpoisoned().insert(
        "/tmp/outputs/b1.output".to_owned(),
        (6, b"done!\n".to_vec()),
    );
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let flipping = tasks.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        flipping.finish("b1");
    });
    let waited = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "b1", "timeout": 5000}))
        .await;
    assert!(text(&waited).contains("<retrieval_status>success</retrieval_status>"));

    // 另一个还在跑的任务：`timeout: 0` 的等待立刻按超时回。
    tasks.commands.lock_unpoisoned().insert(
        ("sess_1".to_owned(), "b2".to_owned()),
        BackgroundStatus::Running,
    );
    let timed_out = harness
        .call(
            "sess_1",
            "TaskOutput",
            json!({"task_id": "b2", "timeout": 0}),
        )
        .await;
    assert!(text(&timed_out).contains("<retrieval_status>timeout</retrieval_status>"));
}

/// 不认识的任务（账本里没有、也没有留下的文件）按 Node 的文字拒绝。
#[tokio::test]
async fn an_unknown_task_is_rejected() {
    let harness = desktop_harness();
    let output = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "nope"}))
        .await;
    assert!(output.is_error);
    assert!(text(&output).contains("No task found with ID: nope"));
}

/// 账本已忘记（通知已 ack）但文件还留着：按完成读它的尾。
#[tokio::test]
async fn a_forgotten_task_with_a_kept_file_reports_the_completed_tail() {
    let tasks = Arc::new(Tasks::default());
    tasks.outputs.lock_unpoisoned().insert("sess_1".to_owned(), "/tmp/outputs".to_owned());
    tasks.files.lock_unpoisoned().insert(
        "/tmp/outputs/b1.output".to_owned(),
        (6, b"kept\n".to_vec()),
    );
    let mut harness = desktop_harness();
    harness.set_machine(tasks.machine());
    let output = harness
        .call("sess_1", "TaskOutput", json!({"task_id": "b1", "block": false}))
        .await;
    assert!(!output.is_error, "{}", text(&output));
    assert!(text(&output).contains("<retrieval_status>success</retrieval_status>"));
    assert!(text(&output).contains("kept"));
}

/// Node 的截断：前缀带完整输出的路径，总长正好是上限。
#[test]
fn truncation_keeps_the_tail_and_names_the_full_output() {
    let output = "x".repeat(40_000);
    let truncated = truncate(&output, Some("/tmp/outputs/b1.output"));
    assert!(
        truncated.starts_with("[Truncated. Full output: /tmp/outputs/b1.output]\n\n"),
        "{truncated}"
    );
    assert_eq!(truncated.chars().count(), 32_000);
    assert_eq!(truncate("short", Some("/tmp/x")), "short");
}

/// Node 的模型文字：块的顺序、空输出不落 `<output>` 块。
#[test]
fn the_model_text_orders_the_blocks_like_node() {
    let task = TaskView {
        id: "b1",
        status: "running",
        output: "  \ninterim\n\n".to_owned(),
        output_file: Some("/tmp/outputs/b1.output".to_owned()),
    };
    assert_eq!(
        model_text("not_ready", &task),
        "<retrieval_status>not_ready</retrieval_status>\n\n<task_id>b1</task_id>\n\n\
         <task_type>local_bash</task_type>\n\n<status>running</status>\n\n\
         <output>\n  \ninterim\n</output>"
    );
    let blank = TaskView {
        id: "b2",
        status: "completed",
        output: "  \n".to_owned(),
        output_file: None,
    };
    assert_eq!(
        model_text("success", &blank),
        "<retrieval_status>success</retrieval_status>\n\n<task_id>b2</task_id>\n\n\
         <task_type>local_bash</task_type>\n\n<status>completed</status>"
    );
}
