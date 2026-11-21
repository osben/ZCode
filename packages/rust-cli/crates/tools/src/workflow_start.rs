//! Fork: the hub's direct start of a saved workflow, resolved the way CreateWorkflow's `saved` source resolves it (9.53,
//! W9a; Node `startSavedWorkflowRun` steps 1 and 2 in `dynamic-workflow-run-start.ts`). The name rules, the file reads
//! and the argument checks are the saved-workflow store's and CreateWorkflow's, so the two callers agree.
//!
//! This module answers the resolution and the argument check, and writes the best-effort draft copy of the file it
//! resolved (Node `writeWorkflowDraft`, step 3b). The compile, the activation, the submit and the launch turn belong to
//! the run service (the runtime), which calls the resolution first and has no side effect before it.

use std::path::{Path, PathBuf};

use rust_cli_kernel_api::workflow_run::StartRefusal;
use serde_json::{Map, Value};

pub use crate::saved_workflow::Scope;
use crate::saved_workflow::{ResolveRefusal, Store};
use crate::workflow_create::{DRAFTS_DIR, validate_args, write_draft_file};

/// A saved definition resolved for a hub start: what the run is launched with.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedStart {
    /// The saved name as the file has it (Node `found.name`).
    pub name: String,
    /// `project` or `global` (Node `found.scope`).
    pub scope: Scope,
    /// The script body that runs (the file after its metadata block).
    pub script: String,
    /// The file as written, for the draft copy.
    pub source: String,
    /// The validated arguments: the declared ones, with defaults filled in. Empty when the workflow declares none.
    pub args: Map<String, Value>,
}

/// Node `resolveSavedWorkflow` and `validateWorkflowArgs` for a hub start. `scope` is `project` or `global` when the
/// caller named one; `args` are the caller's (the GUI's dialog). Every refusal is Node's reason code with Node's text.
pub fn resolve_saved_start(
    home: &Path,
    cwd: &Path,
    name: &str,
    scope: Option<&str>,
    args: Option<&Map<String, Value>>,
) -> Result<ResolvedStart, StartRefusal> {
    let store = Store::new(cwd, home);
    // The protocol refuses a scope that is not `project` or `global` before this call (as Node's schema does). The check
    // here keeps the resolution honest for any other caller: the answer is the enum message, not a missing workflow.
    let scope_filter = match scope {
        None => None,
        Some(text) => Some(Scope::parse(text).ok_or_else(|| StartRefusal::InvalidArgs {
            message: "saved.scope: Invalid enum value. Expected 'project' | 'global'".to_owned(),
        })?),
    };
    let found = store
        .resolve(name, scope_filter)
        .map_err(|refusal| match refusal {
            ResolveRefusal::InvalidName => StartRefusal::InvalidName {
                message: format!(
                    "'{name}' is not a usable workflow name: workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-64 characters"
                ),
            },
            ResolveRefusal::NotFound => StartRefusal::NotFound {
                message: match scope_filter {
                    None => format!("No saved workflow named '{name}' in this project or globally."),
                    Some(scope) => format!("No {} workflow named '{name}'.", scope.as_str()),
                },
            },
            ResolveRefusal::Parse { path, detail } | ResolveRefusal::Read { path, detail } => {
                StartRefusal::NotFound {
                    message: format!(
                        "The saved workflow '{name}' at {} could not be read: {detail}",
                        path.display()
                    ),
                }
            }
        })?;
    let empty = Map::new();
    let provided = args.unwrap_or(&empty);
    let declared = found.meta.args.as_deref().unwrap_or(&[]);
    let args = validate_args(declared, provided).map_err(|errors| {
        let mut lines = vec![format!(
            "The arguments for saved workflow '{}' are not valid:",
            found.name
        )];
        lines.extend(errors.iter().map(|error| format!("- {error}")));
        StartRefusal::InvalidArgs {
            message: lines.join("\n"),
        }
    })?;
    Ok(ResolvedStart {
        name: found.name,
        scope: found.scope,
        script: found.script,
        source: found.source,
        args,
    })
}

/// Node `writeWorkflowDraft` for a hub start: a new draft file under the working directory, best effort. A write that
/// fails leaves no draft, so the run starts without a script path (as CreateWorkflow's does).
pub async fn write_start_draft(cwd: &Path, resolved: &ResolvedStart) -> Option<PathBuf> {
    let dir = cwd.join(DRAFTS_DIR);
    let name = resolved.name.clone();
    let text = resolved.source.clone();
    tokio::task::spawn_blocking(move || write_draft_file(&dir, &name, &text))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Writes a saved definition (a metadata block with a description, then the script) where the store reads it.
    fn save(cwd: &Path, home: &Path, scope: Scope, name: &str, text: &str) {
        let path = Store::new(cwd, home).path(scope, name);
        rust_cli_fs::ensure_dir(path.parent().expect("a scope directory"))
            .expect("the scope directory");
        rust_cli_fs::write_text(
            &path,
            &format!("/* zcode-workflow\ndescription: test\n*/\n{text}"),
        )
        .expect("the saved file");
    }

    #[test]
    fn a_name_with_no_saved_file_is_not_found_with_nodes_text() {
        let dir = tempfile::tempdir().expect("temp dir");
        let refusal = resolve_saved_start(dir.path(), dir.path(), "missing", None, None)
            .expect_err("no file");
        assert_eq!(
            refusal,
            StartRefusal::NotFound {
                message: "No saved workflow named 'missing' in this project or globally."
                    .to_owned()
            }
        );
        let scoped = resolve_saved_start(dir.path(), dir.path(), "missing", Some("global"), None)
            .expect_err("no global file");
        assert_eq!(
            scoped,
            StartRefusal::NotFound {
                message: "No global workflow named 'missing'.".to_owned()
            }
        );
    }

    #[test]
    fn a_saved_workflow_resolves_in_its_scope_with_the_script_and_no_arguments() {
        let cwd = tempfile::tempdir().expect("cwd");
        let home = tempfile::tempdir().expect("home");
        save(
            cwd.path(),
            home.path(),
            Scope::Global,
            "digest",
            "return 2\n",
        );
        let resolved = resolve_saved_start(home.path(), cwd.path(), "digest", None, None)
            .expect("the global file resolves");
        assert_eq!(resolved.name, "digest");
        assert_eq!(resolved.scope, Scope::Global);
        assert_eq!(resolved.script.trim(), "return 2");
        assert!(resolved.args.is_empty());
    }

    #[test]
    fn an_argument_the_workflow_does_not_declare_is_refused_as_invalid_args() {
        let cwd = tempfile::tempdir().expect("cwd");
        let home = tempfile::tempdir().expect("home");
        save(
            cwd.path(),
            home.path(),
            Scope::Project,
            "plain",
            "return 1\n",
        );
        let mut args = Map::new();
        args.insert("topic".to_owned(), json!("x"));
        let refusal = resolve_saved_start(
            home.path(),
            cwd.path(),
            "plain",
            Some("project"),
            Some(&args),
        )
        .expect_err("an undeclared argument");
        match refusal {
            StartRefusal::InvalidArgs { message } => assert!(
                message.starts_with(
                    "The arguments for saved workflow 'plain' are not valid:\n- unknown argument 'topic'"
                ),
                "{message}"
            ),
            other => panic!("expected invalid_args, got {other:?}"),
        }
    }

    #[test]
    fn an_invalid_name_is_refused_as_invalid_name() {
        let dir = tempfile::tempdir().expect("temp dir");
        let refusal = resolve_saved_start(dir.path(), dir.path(), "../escape", None, None)
            .expect_err("a name with a slash");
        assert!(
            matches!(refusal, StartRefusal::InvalidName { .. }),
            "{refusal:?}"
        );
    }
    #[test]
    fn a_scope_that_is_not_project_or_global_is_an_enum_refusal_not_a_missing_workflow() {
        let dir = tempfile::tempdir().expect("temp dir");
        let refusal = resolve_saved_start(dir.path(), dir.path(), "x", Some("Project"), None)
            .expect_err("a scope outside the two values");
        assert_eq!(
            refusal,
            StartRefusal::InvalidArgs {
                message: "saved.scope: Invalid enum value. Expected 'project' | 'global'"
                    .to_owned()
            }
        );
    }

    #[test]
    fn a_file_whose_metadata_block_does_not_parse_is_not_found_with_its_read_error() {
        let cwd = tempfile::tempdir().expect("cwd");
        let home = tempfile::tempdir().expect("home");
        let path = Store::new(cwd.path(), home.path()).path(Scope::Project, "broken");
        rust_cli_fs::ensure_dir(path.parent().expect("a scope directory"))
            .expect("the scope directory");
        // An opened block that is never closed: the store refuses it as a parse error.
        rust_cli_fs::write_text(&path, "/* zcode-workflow\ndescription: never closed\n")
            .expect("the file");
        let refusal = resolve_saved_start(home.path(), cwd.path(), "broken", Some("project"), None)
            .expect_err("a malformed block");
        match refusal {
            StartRefusal::NotFound { message } => assert!(
                message.starts_with("The saved workflow 'broken' at ")
                    && message.contains("could not be read"),
                "{message}"
            ),
            other => panic!("expected not_found with the read error, got {other:?}"),
        }
    }
}
