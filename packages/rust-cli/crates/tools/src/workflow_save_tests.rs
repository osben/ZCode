//! Ported from `saved-workflow-tools.test.ts` (the SaveWorkflow block). The Node cases run the whole executor with a
//! permission broker; these run the tool's `validate_input`, `check_permissions` and `call` directly, in the same order.
//! Cases that test the executor itself (the hook payload, the permission record's input) have no Rust counterpart.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::testing::OpsOverride;
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolUseContext, Validation};
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer, WorkflowDiagnostic,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

/// Test file IO through the fs crate's helpers (std::fs is disallowed in this crate); a missing parent is created on write.
mod fs {
    use std::io;
    use std::path::Path;

    pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
        rust_cli_fs::text_files::read_text(path.as_ref())
    }

    pub fn write(path: impl AsRef<Path>, text: &str) -> io::Result<()> {
        rust_cli_fs::text_files::write_text(path.as_ref(), text)
    }
}

/// The checker: a script containing `BROKEN` has one error on line 1 column 1; `FAIL` makes the check itself fail.
#[derive(Default)]
struct Checker {
    scripts: Mutex<Vec<String>>,
}

#[async_trait]
impl WorkflowAnalyzer for Checker {
    async fn analyze(&self, script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        self.scripts.lock().unwrap().push(script.to_owned());
        if script.contains("FAIL") {
            return Err(WorkflowAnalysisError {
                message: "the helper is not running".to_owned(),
            });
        }
        if script.contains("BROKEN") {
            return Ok(WorkflowAnalysis {
                ok: false,
                diagnostics: vec![WorkflowDiagnostic {
                    code: 2322,
                    line: 1,
                    column: 7,
                    message: "Type 'string' is not assignable to type 'number'.".to_owned(),
                }],
            });
        }
        Ok(WorkflowAnalysis {
            ok: true,
            diagnostics: Vec::new(),
        })
    }
}

/// A session whose history is fixed: the probe reads the Skill calls still visible to the model.
struct History(Vec<Message>);

#[async_trait]
impl OpsOverride for History {
    async fn conversation(&self) -> Option<Vec<Message>> {
        Some(self.0.clone())
    }
}

fn loaded_skill() -> Vec<Message> {
    vec![
        serde_json::from_value(json!({
            "type": "assistant",
            "id": "msg_skill",
            "content": [{"type": "tool_use", "id": "toolu_skill", "name": "Skill",
                         "input": {"skill": "dynamic-workflows"}}],
            "model": "test-model"
        }))
        .expect("assistant message"),
        serde_json::from_value(json!({
            "type": "user",
            "id": "msg_result",
            "content": [{"type": "tool_result", "tool_use_id": "toolu_skill",
                         "content": [{"type": "text", "text": "skill body"}]}],
            "origin": {"kind": "tool_result", "assistant": "msg_skill"}
        }))
        .expect("user message"),
    ]
}

struct Harness {
    dirs: Dirs,
    checker: Arc<Checker>,
    tool: SaveWorkflowTool,
}

struct Dirs {
    _guard: tempfile::TempDir,
    cwd: PathBuf,
    home: PathBuf,
}

impl Harness {
    fn new(_tag: &str) -> Self {
        let guard = tempfile::TempDir::new().expect("tempdir");
        let root = guard.path().to_path_buf();
        let cwd = root.join("project");
        let home = root.join("home");
        let checker = Arc::new(Checker::default());
        let tool = SaveWorkflowTool::new(checker.clone(), home.clone());
        Self {
            dirs: Dirs {
                _guard: guard,
                cwd,
                home,
            },
            checker,
            tool,
        }
    }

    fn context(&self, history: Vec<Message>) -> ToolUseContext {
        let mut ctx = Ctx::with_ops(Arc::new(History(history))).build();
        ctx.workspace.root =
            rust_cli_kernel_api::env::EnvPath::new(self.dirs.cwd.display().to_string());
        ctx
    }

    fn with_skill(&self) -> ToolUseContext {
        self.context(loaded_skill())
    }

    /// The executor's order: the permission decision first, then the call (a refused decision never reaches it).
    async fn call(&self, input: Value) -> Result<rust_cli_kernel_api::tool::ToolOutput, ToolError> {
        let ctx = self.with_skill();
        if let PermissionDecision::Deny { message } =
            self.tool.check_permissions(&input, &ctx).await
        {
            return Err(ToolError::Failed { message });
        }
        let (tx, _rx) = mpsc::channel(4);
        self.tool.call(input, ctx, tx).await
    }
}

fn source_input(name: &str, script: &str) -> Value {
    json!({"name": name, "description": "d", "script": script, "scope": "project"})
}

const CLEAN: &str =
    "interface R { done: boolean }\nconst r = await agent(\"a\").ask<R>(\"do\");\nreturn r.done;";

#[test]
fn the_tool_is_named_deferred_and_gated_by_an_ask_that_is_not_always_allowed() {
    let harness = Harness::new("shape");
    assert_eq!(harness.tool.name(), "SaveWorkflow");
    assert!(harness.tool.should_defer());
    assert!(!harness.tool.allow_session(), "Node allowAlways: false");
    assert!(!harness.tool.is_read_only(&json!({})));
    assert!(!harness.tool.is_concurrency_safe(&json!({})));
}

fn prompt() -> rust_cli_kernel_api::tool::PromptContext {
    rust_cli_kernel_api::tool::PromptContext {
        tool_names: Vec::new(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
    }
}

#[test]
fn the_description_is_the_node_contract_text() {
    let harness = Harness::new("description");
    assert!(
        harness
            .tool
            .description(&prompt())
            .contains("NEVER call this tool unsolicited")
    );
}

#[tokio::test]
async fn a_clean_script_asks_then_writes_with_the_metadata_block_ahead_of_it() {
    let harness = Harness::new("clean");
    let input = json!({
        "name": "pr-review",
        "description": "Review a pull request",
        "whenToUse": "When the user asks for a PR review",
        "args": {"pr": {"type": "string", "required": true, "description": "PR number"}},
        "script": CLEAN,
        "scope": "project"
    });
    let ctx = harness.with_skill();
    assert_eq!(
        harness.tool.validate_input(&input, &ctx).await,
        Validation::Ok
    );
    let decision = harness.tool.check_permissions(&input, &ctx).await;
    let PermissionDecision::Ask {
        message,
        independent: true,
        ..
    } = decision
    else {
        panic!("a compiling script asks, with no always-allow: {decision:?}");
    };
    assert!(message.contains("pr-review"), "{message}");

    let (tx, _rx) = mpsc::channel(4);
    let output = harness
        .tool
        .call(input, harness.with_skill(), tx)
        .await
        .expect("saved");
    let path = harness.dirs.cwd.join(".zcode/workflows/pr-review.dwf.ts");
    assert_eq!(
        fs::read_to_string(&path).expect("file"),
        format!(
            "/* zcode-workflow\n\
             description: Review a pull request\n\
             whenToUse: When the user asks for a PR review\n\
             args:\n\
             \x20 pr:\n\
             \x20   type: string\n\
             \x20   description: PR number\n\
             \x20   required: true\n\
             */\n{CLEAN}"
        )
    );
    assert_eq!(output.display["ok"], json!(true));
    assert_eq!(output.display["overwritten"], json!(false));
    assert_eq!(output.display["scope"], json!("project"));
    assert_eq!(output.display["path"], json!(path.display().to_string()));
    assert_eq!(
        output_text(&output),
        format!(
            "Saved the workflow 'pr-review' to {}. Run it with CreateWorkflow using `saved: {{ name: \"pr-review\" }}`.",
            path.display()
        )
    );
}

#[tokio::test]
async fn a_name_already_taken_is_replaced_and_the_report_says_so() {
    let harness = Harness::new("overwrite");
    Store::new(&harness.dirs.cwd, &harness.dirs.home)
        .save(
            "taken",
            &Meta {
                description: "old".to_owned(),
                when_to_use: None,
                args: None,
            },
            "return 1;",
            Scope::Project,
        )
        .expect("seed");
    let output = harness
        .call(source_input("taken", CLEAN))
        .await
        .expect("saved");
    assert_eq!(output.display["overwritten"], json!(true));
    assert!(output_text(&output).starts_with("Replaced the saved workflow 'taken' at "));
    let text = fs::read_to_string(harness.dirs.cwd.join(".zcode/workflows/taken.dwf.ts")).unwrap();
    assert!(text.contains("description: d"), "{text}");
}

#[tokio::test]
async fn a_broken_script_returns_its_diagnostics_without_asking_or_writing() {
    let harness = Harness::new("broken");
    let input = source_input("broken", "const x: number = BROKEN;");
    let ctx = harness.with_skill();
    assert_eq!(
        harness.tool.check_permissions(&input, &ctx).await,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
    let output = harness
        .call(input)
        .await
        .expect("diagnostics are a result, not a failure");
    assert_eq!(output.display["ok"], json!(false));
    assert!(output.display.get("overwritten").is_none());
    assert_eq!(
        output_text(&output),
        "The workflow script has errors:\nL1:C7 Type 'string' is not assignable to type 'number'.\n\nNOTE: Nothing was saved — fix the errors above and call the tool again."
    );
    assert!(!rust_cli_fs::text_files::is_file(
        &harness.dirs.cwd.join(".zcode/workflows/broken.dwf.ts")
    ));
}

#[tokio::test]
async fn a_checker_that_cannot_answer_denies_the_ask_and_the_call_fails() {
    let harness = Harness::new("checker-down");
    let input = source_input("down", "FAIL");
    let ctx = harness.with_skill();
    assert!(matches!(
        harness.tool.check_permissions(&input, &ctx).await,
        PermissionDecision::Deny { .. }
    ));
    let error = harness.call(input).await.expect_err("the call fails");
    assert!(matches!(error, ToolError::Failed { .. }), "{error:?}");
    assert!(!rust_cli_fs::text_files::is_file(
        &harness.dirs.cwd.join(".zcode/workflows/down.dwf.ts")
    ));
}

#[tokio::test]
async fn an_unusable_name_is_refused_before_the_skill_gate_and_before_the_disk_is_touched() {
    let harness = Harness::new("name");
    let ctx = harness.context(Vec::new());
    let validation = harness
        .tool
        .validate_input(&source_input("../evil", CLEAN), &ctx)
        .await;
    let Validation::Invalid {
        message,
        error_code,
    } = validation
    else {
        panic!("refused");
    };
    assert_eq!(error_code, Some(400));
    assert_eq!(
        message,
        "'../evil' is not a usable workflow name: names may only contain letters, digits, '.', '-' and '_', and must be 1-64 characters."
    );
    assert!(!rust_cli_fs::text_files::is_file(
        &harness.dirs.cwd.join(".zcode")
    ));
}

#[tokio::test]
async fn a_script_that_already_carries_a_metadata_block_is_refused() {
    let harness = Harness::new("sentinel");
    let script = format!("/* zcode-workflow\ndescription: smuggled\n*/\n{CLEAN}");
    let validation = harness
        .tool
        .validate_input(&source_input("double", &script), &harness.with_skill())
        .await;
    let Validation::Invalid {
        message,
        error_code,
    } = validation
    else {
        panic!("refused");
    };
    assert_eq!(error_code, Some(400));
    assert_eq!(
        message,
        "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you."
    );
}

#[tokio::test]
async fn exactly_one_source_is_required() {
    let harness = Harness::new("sources");
    let both = json!({"name": "x", "description": "d", "script": CLEAN, "script_path": "a.ts", "scope": "project"});
    let neither = json!({"name": "x", "description": "d", "scope": "project"});
    for input in [both, neither] {
        let Validation::Invalid {
            message,
            error_code,
        } = harness
            .tool
            .validate_input(&input, &harness.with_skill())
            .await
        else {
            panic!("refused");
        };
        assert_eq!(error_code, Some(400));
        assert_eq!(
            message,
            "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous."
        );
    }
}

#[tokio::test]
async fn a_missing_scope_fails_the_input_schema() {
    let harness = Harness::new("scope");
    let input = json!({"name": "no-scope", "description": "d", "script": CLEAN});
    let validation = harness
        .tool
        .validate_input(&input, &harness.with_skill())
        .await;
    assert!(
        matches!(validation, Validation::Invalid { .. }),
        "{validation:?}"
    );
}

#[tokio::test]
async fn without_the_dynamic_workflows_skill_in_view_the_call_is_refused_with_428() {
    let harness = Harness::new("skill");
    let validation = harness
        .tool
        .validate_input(
            &source_input("needs-skill", CLEAN),
            &harness.context(Vec::new()),
        )
        .await;
    let Validation::Invalid {
        message,
        error_code,
    } = validation
    else {
        panic!("refused");
    };
    assert_eq!(error_code, Some(428));
    assert!(message.starts_with("SaveWorkflow needs the `dynamic-workflows` skill loaded in this session before it accepts a script. Call the Skill tool with skill \"dynamic-workflows\" first"), "{message}");
    assert!(
        message.ends_with("then call SaveWorkflow again. Nothing was started."),
        "{message}"
    );
}

#[tokio::test]
async fn a_skill_call_that_failed_does_not_count_as_loaded() {
    let harness = Harness::new("skill-failed");
    let mut history = loaded_skill();
    history[1] = serde_json::from_value(json!({
        "type": "user",
        "id": "msg_result",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_skill", "is_error": true,
                     "content": [{"type": "text", "text": "not found"}]}],
        "origin": {"kind": "tool_result", "assistant": "msg_skill"}
    }))
    .expect("user message");
    let validation = harness
        .tool
        .validate_input(&source_input("x", CLEAN), &harness.context(history))
        .await;
    assert!(matches!(
        validation,
        Validation::Invalid {
            error_code: Some(428),
            ..
        }
    ));
}

#[tokio::test]
async fn script_path_reads_the_draft_and_drops_its_metadata_block() {
    let harness = Harness::new("draft");
    let draft = harness.dirs.cwd.join(".zcode/workflow-drafts/draft.ts");
    fs::write(
        &draft,
        &format!("/* zcode-workflow\ndescription: old\n*/\n{CLEAN}"),
    )
    .unwrap();
    let output = harness
        .call(json!({"name": "from-draft", "description": "new", "script_path": ".zcode/workflow-drafts/draft.ts", "scope": "project"}))
        .await
        .expect("saved");
    assert_eq!(output.display["ok"], json!(true));
    let text =
        fs::read_to_string(harness.dirs.cwd.join(".zcode/workflows/from-draft.dwf.ts")).unwrap();
    assert!(text.contains("description: new\n*/\n"), "{text}");
    assert!(text.ends_with(CLEAN), "{text}");
    assert!(!text.contains("description: old"), "{text}");
}

#[tokio::test]
async fn a_draft_that_cannot_be_read_is_refused_at_the_permission_decision_not_in_validation() {
    let harness = Harness::new("missing-draft");
    let input =
        json!({"name": "x", "description": "d", "script_path": "nope.ts", "scope": "project"});
    // Validation only checks the input's own shape; it does not read the disk.
    assert_eq!(
        harness
            .tool
            .validate_input(&input, &harness.with_skill())
            .await,
        Validation::Ok
    );
    let PermissionDecision::Deny { message } = harness
        .tool
        .check_permissions(&input, &harness.with_skill())
        .await
    else {
        panic!("the unreadable draft is refused");
    };
    assert!(
        message.starts_with("The workflow script file nope.ts could not be read: "),
        "{message}"
    );
    assert!(
        message
            .ends_with("Pass `script_path` for a file that exists, or submit the script inline."),
        "{message}"
    );
}

#[tokio::test]
async fn a_global_save_writes_under_the_home_directory() {
    let harness = Harness::new("global");
    let output = harness
        .call(json!({"name": "research", "description": "deep research", "script": CLEAN, "scope": "global"}))
        .await
        .expect("saved");
    let path = harness.dirs.home.join(".zcode/workflows/research.dwf.ts");
    assert!(rust_cli_fs::text_files::is_file(&path));
    assert_eq!(output.display["scope"], json!("global"));
    assert_eq!(
        output_text(&output),
        format!(
            "Saved global workflow 'research' to {}. Run it with CreateWorkflow using `saved: {{ name: \"research\" }}`.",
            path.display()
        )
    );
}

#[tokio::test]
async fn the_confirmation_names_an_overwrite_and_a_shadowed_copy() {
    let harness = Harness::new("message");
    let store = Store::new(&harness.dirs.cwd, &harness.dirs.home);
    store
        .save(
            "dup",
            &Meta {
                description: "g".to_owned(),
                when_to_use: None,
                args: None,
            },
            "return 1;",
            Scope::Global,
        )
        .expect("seed global");
    let input = json!({"name": "dup", "description": "p", "script": CLEAN, "scope": "project"});
    let PermissionDecision::Ask { message, .. } = harness
        .tool
        .check_permissions(&input, &harness.with_skill())
        .await
    else {
        panic!("asks");
    };
    assert!(
        message.contains("(hides a global workflow of the same name)"),
        "{message}"
    );
    assert!(!message.contains("replaces"), "{message}");
}

#[tokio::test]
async fn an_invalid_check_is_not_asked_even_when_a_copy_exists() {
    let harness = Harness::new("nothing-asked");
    let input = source_input("x", "BROKEN");
    assert!(matches!(
        harness
            .tool
            .check_permissions(&input, &harness.with_skill())
            .await,
        PermissionDecision::Allow { .. }
    ));
    assert_eq!(harness.checker.scripts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_schema_declared_keys_are_accepted_including_run_id() {
    let harness = Harness::new("schema-keys");
    let input = json!({
        "name": "provenance",
        "description": "d",
        "script": CLEAN,
        "scope": "project",
        "run_id": "run_123",
        "path": "/ignored/by/the/tool.dwf.ts",
        "overwrite": false,
        "shadowing": "hides_global"
    });
    assert_eq!(
        harness
            .tool
            .validate_input(&input, &harness.with_skill())
            .await,
        Validation::Ok
    );
}

#[tokio::test]
async fn a_script_path_outside_the_workspace_is_refused() {
    let harness = Harness::new("escape");
    for path in ["../outside.ts", "/etc/hosts", ".zcode/../../outside.ts"] {
        let input =
            json!({"name": "x", "description": "d", "script_path": path, "scope": "project"});
        let PermissionDecision::Deny { message } = harness
            .tool
            .check_permissions(&input, &harness.with_skill())
            .await
        else {
            panic!("{path} is refused");
        };
        assert!(
            message.contains("outside the workspace"),
            "{path}: {message}"
        );
    }
}

#[tokio::test]
async fn the_bytes_the_user_approved_are_the_bytes_written_even_if_the_draft_changes() {
    let harness = Harness::new("approved-bytes");
    let draft = harness.dirs.cwd.join("draft.ts");
    rust_cli_fs::text_files::write_text(&draft, CLEAN).expect("draft");
    let input = json!({"name": "approved", "description": "d", "script_path": "draft.ts", "scope": "project"});
    let ctx = harness.with_skill();
    assert!(matches!(
        harness.tool.check_permissions(&input, &ctx).await,
        PermissionDecision::Ask { .. }
    ));
    rust_cli_fs::text_files::write_text(&draft, "return 2;").expect("edit");
    let (tx, _rx) = mpsc::channel(4);
    harness.tool.call(input, ctx, tx).await.expect("saved");
    let text =
        fs::read_to_string(harness.dirs.cwd.join(".zcode/workflows/approved.dwf.ts")).unwrap();
    assert!(text.ends_with(CLEAN), "{text}");
}

#[tokio::test]
async fn a_compiling_script_is_never_written_without_its_confirmation() {
    let harness = Harness::new("no-approval");
    let (tx, _rx) = mpsc::channel(4);
    let error = harness
        .tool
        .call(source_input("unasked", CLEAN), harness.with_skill(), tx)
        .await
        .expect_err("no confirmation, no write");
    assert!(matches!(error, ToolError::Failed { .. }), "{error:?}");
    assert!(!rust_cli_fs::text_files::is_file(
        &harness.dirs.cwd.join(".zcode/workflows/unasked.dwf.ts")
    ));
}
