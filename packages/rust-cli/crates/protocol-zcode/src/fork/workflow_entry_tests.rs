//! The sandbox entry file (specs/fork-rust-workflow-engine.md, 4.1 and 5.2), mirroring
//! `dynamic-workflow-runtime/src/child-entry-file.ts`.

use std::path::Path;

use tempfile::TempDir;

use super::*;

fn no_warning(_: &str) {
    panic!("no warning expected");
}

async fn text(path: &Path) -> String {
    let bytes = rust_cli_fs::read_optional(path)
        .await
        .unwrap()
        .expect("the file exists");
    String::from_utf8(bytes).unwrap()
}

async fn put(path: &Path, body: &str) {
    rust_cli_fs::atomic_write(path, body.as_bytes(), WRITE)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_entry_lands_in_the_project_with_a_gitignore_written_once() {
    let cwd = TempDir::new().unwrap();
    let fallback = TempDir::new().unwrap();
    let entry = write_entry(
        cwd.path(),
        "run-1",
        "export const x = 1;\n",
        fallback.path(),
        &mut no_warning,
    )
    .await
    .unwrap();
    assert_eq!(entry.location, EntryLocation::Project);
    assert_eq!(
        entry.path,
        cwd.path().join(".zcode/workflow-runs/run-1.mjs")
    );
    assert_eq!(text(&entry.path).await, "export const x = 1;\n");
    assert_eq!(
        text(&cwd.path().join(".zcode/workflow-runs/.gitignore")).await,
        "*\n"
    );
}

#[tokio::test]
async fn a_rewrite_of_the_same_run_replaces_the_file_and_keeps_the_users_gitignore() {
    let cwd = TempDir::new().unwrap();
    let fallback = TempDir::new().unwrap();
    write_entry(
        cwd.path(),
        "run-1",
        "first",
        fallback.path(),
        &mut no_warning,
    )
    .await
    .unwrap();
    put(
        &cwd.path().join(".zcode/workflow-runs/.gitignore"),
        "keep-me\n",
    )
    .await;
    let entry = write_entry(
        cwd.path(),
        "run-1",
        "second",
        fallback.path(),
        &mut no_warning,
    )
    .await
    .unwrap();
    assert_eq!(text(&entry.path).await, "second");
    assert_eq!(
        text(&cwd.path().join(".zcode/workflow-runs/.gitignore")).await,
        "keep-me\n"
    );
}

#[test]
fn the_file_name_keeps_only_the_safe_run_id_characters() {
    assert_eq!(entry_file_name("run-1.a_b"), "run-1.a_b.mjs");
    assert_eq!(entry_file_name("a/../b c"), "a_.._b_c.mjs");
}

#[tokio::test]
async fn an_unwritable_project_falls_back_to_the_tmp_directory_with_one_warning() {
    let cwd = TempDir::new().unwrap();
    let fallback = TempDir::new().unwrap();
    // `.zcode` as a plain file makes the project directory unwritable for this run.
    put(&cwd.path().join(".zcode"), "not a directory").await;
    let mut warnings = Vec::new();
    let entry = write_entry(
        cwd.path(),
        "run-2",
        "body",
        fallback.path(),
        &mut |warning: &str| warnings.push(warning.to_owned()),
    )
    .await
    .unwrap();
    assert_eq!(entry.location, EntryLocation::Fallback);
    assert_eq!(entry.path, fallback.path().join("run-2.mjs"));
    assert_eq!(text(&entry.path).await, "body");
    assert_eq!(warnings.len(), 1);
    assert!(
        warnings[0].contains(".zcode"),
        "the warning names the directory: {}",
        warnings[0]
    );
}

#[test]
fn the_project_directory_is_under_the_cwd() {
    assert_eq!(
        project_dir(Path::new("/work")),
        Path::new("/work/.zcode/workflow-runs")
    );
}
