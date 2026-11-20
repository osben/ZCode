use super::*;

#[test]
fn a_written_file_reads_back_and_creates_its_directories() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("a/b/c.txt");
    write_text(&path, "hello\n").expect("write");
    assert_eq!(read_text(&path).expect("read"), "hello\n");
    assert!(is_file(&path));
    assert!(!is_file(&dir.path().join("a")));
    assert_eq!(
        list_file_names(&dir.path().join("a/b")).expect("list"),
        ["c.txt"]
    );
}

#[test]
fn a_missing_directory_lists_as_not_found() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let error = list_file_names(&dir.path().join("absent")).expect_err("absent");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[test]
fn a_new_file_is_claimed_once_and_an_existing_one_is_never_overwritten() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    ensure_dir(dir.path()).expect("dir");
    let path = dir.path().join("draft.dwf.ts");
    create_new_text(&path, "first").expect("first claim");
    let error = create_new_text(&path, "second").expect_err("taken");
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(read_text(&path).expect("read"), "first");
}

/// Review: `ensure_dir` makes missing parents, and a new file never makes its parent (its claim needs one).
#[test]
fn ensure_dir_makes_missing_parents_and_a_new_file_does_not() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let nested = dir.path().join("a/b/c");
    ensure_dir(&nested).expect("the directories");
    assert!(nested.is_dir());
    let error = create_new_text(&dir.path().join("x/y/file.txt"), "text").expect_err("no parent");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}
