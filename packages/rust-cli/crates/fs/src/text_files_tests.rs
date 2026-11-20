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
