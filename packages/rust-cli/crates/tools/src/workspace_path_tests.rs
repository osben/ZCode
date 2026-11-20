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

/// Review round 3: an absolute path that names a file inside the workspace is contained (not only relative ones).
#[test]
fn an_absolute_path_inside_the_workspace_is_contained() {
    let (_root, cwd, _outside) = workspace();
    rust_cli_fs::write_text(&cwd.join("draft.ts"), "x").expect("draft");
    let absolute = cwd.join("draft.ts");
    let contained = contain(&cwd, absolute.to_str().expect("utf-8")).expect("inside");
    assert_eq!(contained.named, normalize(&absolute));
    assert_eq!(contained.real, canonicalize_path(&absolute).expect("real"));
}

/// Review round 3: a relative path with a leading `..` is joined to the workspace first, so it is contained when it
/// lands back inside the workspace and refused when it lands outside.
#[test]
fn a_leading_parent_segment_is_resolved_against_the_workspace_before_the_check() {
    let (_root, cwd, _outside) = workspace();
    rust_cli_fs::write_text(&cwd.join("draft.ts"), "x").expect("draft");
    let contained = contain(&cwd, "../project/draft.ts").expect("back inside");
    assert_eq!(contained.named, normalize(&cwd.join("draft.ts")));
    assert!(matches!(
        contain(&cwd, "../../etc/hosts"),
        Err(Refusal::Outside)
    ));
}

/// Review round 3: the workspace root may itself be a symlink (the temp directory is one on macOS): both the root and
/// the file are compared by their real paths, so a file under the link is contained.
#[cfg(unix)]
#[test]
fn a_workspace_root_that_is_a_symlink_is_accepted() {
    let (root, cwd, _outside) = workspace();
    rust_cli_fs::write_text(&cwd.join("draft.ts"), "x").expect("draft");
    let link_root = root.path().join("linked-project");
    rust_cli_fs::symlink(&cwd, &link_root).expect("root link");
    let contained = contain(&link_root, "draft.ts").expect("inside through the root link");
    assert_eq!(
        contained.real,
        canonicalize_path(&cwd.join("draft.ts")).expect("real")
    );
}

/// Review round 3: a link inside the workspace to a file inside the workspace is contained, and the returned `real` is
/// the resolved target, not the link.
#[cfg(unix)]
#[test]
fn a_link_inside_the_workspace_to_a_file_inside_it_is_contained_at_its_target() {
    let (_root, cwd, _outside) = workspace();
    rust_cli_fs::write_text(&cwd.join("target.ts"), "x").expect("target");
    rust_cli_fs::symlink(&cwd.join("target.ts"), &cwd.join("alias.ts")).expect("link");
    let contained = contain(&cwd, "alias.ts").expect("inside");
    assert_eq!(contained.named, normalize(&cwd.join("alias.ts")));
    assert_eq!(
        contained.real,
        canonicalize_path(&cwd.join("target.ts")).expect("target real")
    );
}

/// Review round 3 (Windows, finding 5): the lexical prefix check ignores ASCII case when folding is on, so `c:\work` and
/// `C:\Work` name the same directory. Exercised here with folding forced on, since the platform check is cfg(windows).
#[test]
fn the_lexical_prefix_check_can_fold_ascii_case() {
    let root = Path::new("/tmp/Work/project");
    let inside = Path::new("/tmp/work/project/draft.ts");
    assert!(!lexically_within(inside, root, false));
    assert!(lexically_within(inside, root, true));
    assert!(!lexically_within(
        Path::new("/tmp/work/other/x.ts"),
        root,
        true
    ));
}
