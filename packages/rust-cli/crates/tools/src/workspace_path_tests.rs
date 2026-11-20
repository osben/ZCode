use super::*;

fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::TempDir::new().expect("tempdir");
    let cwd = root.path().join("project");
    let outside = root.path().join("outside");
    rust_cli_fs::write_text(&cwd.join(".keep"), "").expect("workspace");
    rust_cli_fs::write_text(&outside.join("secret.ts"), "secret").expect("outside");
    (root, cwd, outside)
}

#[test]
fn a_plain_file_inside_the_workspace_is_contained_and_its_real_path_is_returned() {
    let (_root, cwd, _outside) = workspace();
    rust_cli_fs::write_text(&cwd.join("draft.ts"), "x").expect("draft");
    let contained = contain(&cwd, "draft.ts").expect("inside");
    assert_eq!(contained.named, normalize(&cwd.join("draft.ts")));
    assert_eq!(
        contained.real,
        canonicalize_path(&cwd.join("draft.ts")).expect("real")
    );
}

#[test]
fn a_lexical_escape_is_outside() {
    let (_root, cwd, _outside) = workspace();
    assert!(matches!(
        contain(&cwd, "../outside/secret.ts"),
        Err(Refusal::Outside)
    ));
    assert!(matches!(contain(&cwd, "/etc/hosts"), Err(Refusal::Outside)));
}

/// A link inside the workspace to a file outside it is refused once its real path is compared.
#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_workspace_is_outside() {
    let (_root, cwd, outside) = workspace();
    rust_cli_fs::symlink(&outside.join("secret.ts"), &cwd.join("link.ts")).expect("link");
    assert!(matches!(contain(&cwd, "link.ts"), Err(Refusal::Outside)));
}

/// A dangling link whose target is outside is refused as unresolved, never accepted by its lexical path: the old check
/// accepted it, and a read of it would follow the link once its target appears.
#[cfg(unix)]
#[test]
fn a_dangling_link_out_of_the_workspace_is_refused_not_accepted_lexically() {
    let (_root, cwd, outside) = workspace();
    rust_cli_fs::symlink(&outside.join("later.ts"), &cwd.join("dangling.ts")).expect("link");
    let refusal = contain(&cwd, "dangling.ts").expect_err("unresolved");
    assert!(matches!(refusal, Refusal::Unresolved(_)), "{refusal:?}");
}

/// A missing file is unresolved (the caller reports the read error), not a containment refusal.
#[test]
fn a_missing_file_is_unresolved() {
    let (_root, cwd, _outside) = workspace();
    assert!(matches!(
        contain(&cwd, "absent.ts"),
        Err(Refusal::Unresolved(_))
    ));
}
