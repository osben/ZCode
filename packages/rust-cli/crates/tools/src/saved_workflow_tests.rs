//! Ported from `saved-workflows-store.test.ts` (the list, save, scope and shadowing cases) and the name rules of
//! `saved-workflow.ts`. The move, resolve and argument-validation cases belong to CreateWorkflow's `saved` source.

use std::path::{Path, PathBuf};

use super::*;

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

    pub fn create_dir_all(_path: impl AsRef<Path>) -> io::Result<()> {
        Ok(())
    }
}

/// A fresh cwd and home under the system temp dir, removed on drop.
struct Dirs {
    _guard: tempfile::TempDir,
    cwd: PathBuf,
    home: PathBuf,
}

impl Dirs {
    fn new(_tag: &str) -> Self {
        let guard = tempfile::TempDir::new().expect("tempdir");
        let root = guard.path().to_path_buf();
        let cwd = root.join("project");
        let home = root.join("home");
        fs::create_dir_all(&cwd).expect("cwd");
        fs::create_dir_all(&home).expect("home");
        Self {
            _guard: guard,
            cwd,
            home,
        }
    }

    fn store(&self) -> Store {
        Store::new(&self.cwd, &self.home)
    }

    fn write(&self, dir: &Path, file: &str, text: &str) {
        fs::create_dir_all(dir).expect("dir");
        fs::write(dir.join(file), text).expect("write");
    }
}

fn meta(description: &str) -> Meta {
    Meta {
        description: description.to_owned(),
        when_to_use: None,
        args: None,
    }
}

const BLOCK: &str = "/* zcode-workflow\ndescription: good\n*/\nreturn 1;";

#[test]
fn a_name_is_valid_only_within_the_file_safe_shape() {
    for ok in ["a", "pr-review", "a.b_c", "x", &"x".repeat(64), "a.."] {
        assert!(is_valid_name(ok), "{ok:?} is valid");
    }
    for bad in ["", ".", "..", "a/b", "../evil", "a b", "é", &"x".repeat(65)] {
        assert!(!is_valid_name(bad), "{bad:?} is not valid");
    }
}

#[test]
fn a_save_writes_under_the_project_root_and_reports_whether_it_overwrote() {
    let dirs = Dirs::new("save");
    let store = dirs.store();
    let first = store
        .save("pr-review", &meta("Review"), "return 1;", Scope::Project)
        .expect("save");
    assert_eq!(
        first.path,
        dirs.cwd.join(".zcode/workflows/pr-review.dwf.ts")
    );
    assert_eq!(first.scope, Scope::Project);
    assert!(!first.overwritten);
    let second = store
        .save("pr-review", &meta("Again"), "return 2;", Scope::Project)
        .expect("save");
    assert!(second.overwritten);
    let text = fs::read_to_string(&first.path).expect("read");
    assert!(text.contains("description: Again"), "{text}");
}

#[test]
fn a_global_save_lands_under_the_home_root() {
    let dirs = Dirs::new("global-save");
    let saved = dirs
        .store()
        .save(
            "research",
            &meta("Deep research"),
            "return 1;",
            Scope::Global,
        )
        .expect("save");
    assert_eq!(
        saved.path,
        dirs.home.join(".zcode/workflows/research.dwf.ts")
    );
    assert_eq!(saved.scope, Scope::Global);
}

#[test]
fn the_list_is_sorted_and_carries_metadata_but_no_script() {
    let dirs = Dirs::new("list");
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "b.dwf.ts", BLOCK);
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "a.dwf.ts", BLOCK);
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "notes.txt", "ignored");
    let listing = dirs.store().list();
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["a", "b"]);
    assert_eq!(listing.entries[0].description, "good");
    assert_eq!(listing.entries[0].scope, Scope::Project);
    assert!(listing.invalid.is_empty());
}

#[test]
fn a_malformed_file_is_reported_and_the_rest_still_list() {
    let dirs = Dirs::new("malformed");
    let root = dirs.cwd.join(".zcode/workflows");
    dirs.write(&root, "good.dwf.ts", BLOCK);
    dirs.write(
        &root,
        "broken.dwf.ts",
        "/* zcode-workflow\ndescription: x\n",
    );
    let listing = dirs.store().list();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.invalid.len(), 1);
    assert!(listing.invalid[0].path.ends_with("broken.dwf.ts"));
    assert!(
        listing.invalid[0]
            .reason
            .starts_with("unterminated_frontmatter: "),
        "{}",
        listing.invalid[0].reason
    );
}

#[test]
fn a_file_whose_name_is_not_usable_is_reported_as_invalid() {
    let dirs = Dirs::new("badname");
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "bad name.dwf.ts", BLOCK);
    let listing = dirs.store().list();
    assert!(listing.entries.is_empty());
    assert_eq!(listing.invalid.len(), 1);
    assert_eq!(
        listing.invalid[0].reason,
        "file name is not a usable workflow name"
    );
}

#[test]
fn a_project_copy_hides_the_global_copy_of_the_same_name_in_the_list() {
    let dirs = Dirs::new("shadow-list");
    dirs.write(&dirs.home.join(".zcode/workflows"), "shared.dwf.ts", BLOCK);
    dirs.write(
        &dirs.home.join(".zcode/workflows"),
        "only-global.dwf.ts",
        BLOCK,
    );
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "shared.dwf.ts", BLOCK);
    let listing = dirs.store().list();
    let shared: Vec<&SavedEntry> = listing
        .entries
        .iter()
        .filter(|entry| entry.name == "shared")
        .collect();
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0].scope, Scope::Project);
    let global = listing
        .entries
        .iter()
        .find(|entry| entry.name == "only-global")
        .expect("the global-only copy lists");
    assert_eq!(global.scope, Scope::Global);
}

#[test]
fn a_missing_root_is_an_empty_list_not_an_error() {
    let dirs = Dirs::new("empty");
    let listing = dirs.store().list();
    assert!(listing.entries.is_empty());
    assert!(listing.invalid.is_empty());
}

#[test]
fn a_save_flags_hides_global_when_a_global_copy_already_exists() {
    let dirs = Dirs::new("hides-global");
    dirs.write(&dirs.home.join(".zcode/workflows"), "dup.dwf.ts", BLOCK);
    assert_eq!(
        dirs.store().shadowing("dup", Scope::Project),
        Some(Shadowing::HidesGlobal)
    );
}

#[test]
fn a_global_save_flags_hidden_by_project_when_a_project_copy_exists() {
    let dirs = Dirs::new("hidden");
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "dup.dwf.ts", BLOCK);
    assert_eq!(
        dirs.store().shadowing("dup", Scope::Global),
        Some(Shadowing::HiddenByProject)
    );
}

#[test]
fn no_shadowing_fact_without_a_same_named_copy_in_the_other_scope() {
    let dirs = Dirs::new("no-shadow");
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "mine.dwf.ts", BLOCK);
    assert_eq!(dirs.store().shadowing("mine", Scope::Project), None);
    assert_eq!(dirs.store().shadowing("../evil", Scope::Project), None);
}

#[test]
fn exists_answers_per_scope() {
    let dirs = Dirs::new("exists");
    dirs.write(&dirs.cwd.join(".zcode/workflows"), "p.dwf.ts", BLOCK);
    let store = dirs.store();
    assert!(store.exists("p", Scope::Project));
    assert!(!store.exists("p", Scope::Global));
    assert!(!store.exists("../p", Scope::Project));
}
