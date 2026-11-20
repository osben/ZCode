//! Ported from `saved-workflow-tools.test.ts` (the ListSavedWorkflows block) and the model text of
//! `list-saved-workflows.ts`.

use std::path::PathBuf;

use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{Tool, ToolUseContext, Validation};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::test_more::{Ctx, output_text};

/// Test file IO through the fs crate's helpers (std::fs is disallowed in this crate); a missing parent is created on write.
mod fs {
    use std::io;
    use std::path::Path;

    pub fn write(path: impl AsRef<Path>, text: &str) -> io::Result<()> {
        rust_cli_fs::text_files::write_text(path.as_ref(), text)
    }

    pub fn create_dir_all(_path: impl AsRef<Path>) -> io::Result<()> {
        Ok(())
    }
}

struct Harness {
    _guard: tempfile::TempDir,
    cwd: PathBuf,
    home: PathBuf,
    tool: ListSavedWorkflowsTool,
}

impl Harness {
    fn new(_tag: &str) -> Self {
        let guard = tempfile::TempDir::new().expect("tempdir");
        let root = guard.path().to_path_buf();
        let cwd = root.join("project");
        let home = root.join("home");
        fs::create_dir_all(&cwd).expect("cwd");
        fs::create_dir_all(&home).expect("home");
        let tool = ListSavedWorkflowsTool::new(home.clone());
        Self {
            _guard: guard,
            cwd,
            home,
            tool,
        }
    }

    fn context(&self) -> ToolUseContext {
        let mut ctx = Ctx::new(std::sync::Arc::new(
            rust_cli_kernel_api::testing::NoOneToAsk,
        ))
        .build();
        ctx.workspace.root = rust_cli_kernel_api::env::EnvPath::new(self.cwd.display().to_string());
        ctx
    }

    fn save(&self, name: &str, text: &str) {
        let dir = self.cwd.join(".zcode/workflows");
        fs::create_dir_all(&dir).expect("dir");
        fs::write(dir.join(format!("{name}.dwf.ts")), text).expect("write");
    }

    async fn list(&self) -> rust_cli_kernel_api::tool::ToolOutput {
        let (tx, _rx) = mpsc::channel(4);
        self.tool
            .call(json!({}), self.context(), tx)
            .await
            .expect("the list answers")
    }
}

const TRIAGE: &str = "/* zcode-workflow\ndescription: Triage the inbox\nwhenToUse: Every morning\nargs:\n  limit:\n    type: number\n    default: 10\n*/\nagent(\"x\");";

#[test]
fn the_tool_is_read_only_concurrency_safe_and_ungated() {
    let harness = Harness::new("shape");
    assert_eq!(harness.tool.name(), "ListSavedWorkflows");
    assert!(harness.tool.should_defer());
    assert!(harness.tool.is_read_only(&json!({})));
    assert!(harness.tool.is_concurrency_safe(&json!({})));
}

#[tokio::test]
async fn it_asks_for_no_permission() {
    let harness = Harness::new("permission");
    let decision = harness
        .tool
        .check_permissions(&json!({}), &harness.context())
        .await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "{decision:?}"
    );
}

#[tokio::test]
async fn it_lists_definitions_with_their_arguments_and_never_the_script_body() {
    let harness = Harness::new("list");
    harness.save("triage", TRIAGE);
    let output = harness.list().await;

    let workflows = output.display["workflows"].as_array().expect("workflows");
    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0]["name"], json!("triage"));
    assert_eq!(workflows[0]["scope"], json!("project"));
    assert!(output.display.get("invalid").is_none());
    assert!(workflows[0].get("script").is_none());

    let text = output_text(&output);
    assert!(text.contains("name=\"triage\""), "{text}");
    assert!(text.contains("Triage the inbox"), "{text}");
    assert!(text.contains("arg limit (number, default 10)"), "{text}");
    assert!(!text.contains("agent("), "{text}");
}

#[tokio::test]
async fn it_says_so_in_a_sentence_when_the_project_has_none() {
    let harness = Harness::new("empty");
    let output = harness.list().await;
    assert_eq!(output.display["workflows"], json!([]));
    assert_eq!(
        output_text(&output),
        "<saved_workflows count=\"0\">\nNo workflows are saved in this project yet. Saved definitions live in .zcode/workflows/.\n</saved_workflows>"
    );
}

#[tokio::test]
async fn a_project_copy_shadows_the_global_one_of_the_same_name_in_the_list() {
    let harness = Harness::new("global");
    fs::create_dir_all(harness.home.join(".zcode/workflows")).unwrap();
    fs::write(harness.home.join(".zcode/workflows/shared.dwf.ts"), TRIAGE).unwrap();
    harness.save("shared", TRIAGE);
    let output = harness.list().await;
    let workflows = output.display["workflows"].as_array().unwrap();
    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0]["scope"], json!("project"));
}

#[tokio::test]
async fn a_broken_file_is_named_as_invalid_and_the_rest_still_list() {
    let harness = Harness::new("invalid");
    harness.save("triage", TRIAGE);
    harness.save("broken", "/* zcode-workflow\ndescription: x\n");
    let output = harness.list().await;
    assert_eq!(output.display["workflows"].as_array().unwrap().len(), 1);
    let invalid = output.display["invalid"].as_array().expect("invalid rows");
    assert_eq!(invalid.len(), 1);
    let text = output_text(&output);
    assert!(text.contains("<invalid path=\""), "{text}");
    assert!(
        text.contains("broken.dwf.ts\">unterminated_frontmatter: "),
        "{text}"
    );
}

#[test]
fn the_model_text_escapes_quotes_in_names_and_paths() {
    let text = format_model_text(&json!({
        "workflows": [],
        "invalid": [{"path": "a\"b&c<d", "reason": "missing_frontmatter: x"}]
    }));
    assert!(
        text.contains("<invalid path=\"a&quot;b&amp;c&lt;d\">missing_frontmatter: x</invalid>"),
        "{text}"
    );
}

#[tokio::test]
async fn a_cwd_input_is_refused_outright() {
    let harness = Harness::new("cwd");
    let validation = harness
        .tool
        .validate_input(&json!({"cwd": "/etc"}), &harness.context())
        .await;
    assert!(
        matches!(validation, Validation::Invalid { .. }),
        "{validation:?}"
    );
    let (tx, _rx) = mpsc::channel(4);
    let result = harness
        .tool
        .call(json!({"cwd": "/etc"}), harness.context(), tx)
        .await;
    assert!(result.is_err());
}

#[test]
fn an_input_schema_takes_no_fields() {
    let tool = ListSavedWorkflowsTool::new(PathBuf::from("/unused"));
    let schema: Value = tool.input_schema();
    assert_eq!(schema["type"], json!("object"));
    assert_eq!(schema["additionalProperties"], json!(false));
}
